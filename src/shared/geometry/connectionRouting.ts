import type { Point, Rect } from "./viewport.js";

/**
 * Pure connection routing: resolves the two attachment sides of a link and the
 * geometric path between them. Framework-free so it compiles for the renderer,
 * the test runner and the web build, and so the same route can be used for
 * drawing, hit-testing and future editing without drift.
 *
 * Three deliberate styles:
 *  - "curved"  — a smooth cubic facing the attachment normals (natural/organic).
 *  - "elbow"   — a right-angled orthogonal route with small rounded corners.
 *  - "bracket" — a wide rail that spans the frames with perpendicular legs.
 */

export type Side = "top" | "right" | "bottom" | "left";
export type RouteStyle = "curved" | "elbow" | "bracket";

export const DEFAULT_ROUTE_STYLE: RouteStyle = "curved";
export const ROUTE_STYLES: readonly RouteStyle[] = ["curved", "elbow", "bracket"];

export function isRouteStyle(value: unknown): value is RouteStyle {
  return value === "curved" || value === "elbow" || value === "bracket";
}

/** Read the route style off a connection's metadata, falling back to default. */
export function connRouteStyle(conn: { metadata?: Record<string, unknown> | undefined }): RouteStyle {
  const v = conn.metadata?.route;
  return isRouteStyle(v) ? v : DEFAULT_ROUTE_STYLE;
}

const DEFAULT_KEY = "spatia.connection.route";

/** Minimal structural view of localStorage so this compiles without DOM libs. */
interface RouteStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function routeStorage(): RouteStorage | undefined {
  return (globalThis as { localStorage?: RouteStorage }).localStorage;
}

/** Persisted default applied to newly created connections (best-effort). */
export function loadDefaultRouteStyle(): RouteStyle {
  try {
    const v = routeStorage()?.getItem(DEFAULT_KEY);
    return isRouteStyle(v) ? v : DEFAULT_ROUTE_STYLE;
  } catch {
    return DEFAULT_ROUTE_STYLE;
  }
}

export function saveDefaultRouteStyle(style: RouteStyle): void {
  try {
    routeStorage()?.setItem(DEFAULT_KEY, style);
  } catch {
    /* storage unavailable — the in-memory default still applies for the session */
  }
}

/** A resolved route: cubic (curved) or polyline (elbow/bracket). */
export interface ConnRoute {
  style: RouteStyle;
  kind: "poly" | "cubic";
  start: Point;
  end: Point;
  startSide: Side;
  endSide: Side;
  /**
   * poly: the ordered vertices of the route.
   * cubic: exactly [start, control1, control2, end].
   */
  points: Point[];
}

// --- Small vector helpers ---------------------------------------------------

function vadd(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y };
}

function vmul(a: Point, s: number): Point {
  return { x: a.x * s, y: a.y * s };
}

function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(Math.min(v, hi), lo);
}

function rectCenter(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** Outward unit normal of a rect side. */
export function sideNormal(side: Side): Point {
  switch (side) {
    case "top":
      return { x: 0, y: -1 };
    case "bottom":
      return { x: 0, y: 1 };
    case "left":
      return { x: -1, y: 0 };
    case "right":
      return { x: 1, y: 0 };
  }
}

function sideIsHorizontal(side: Side): boolean {
  return side === "left" || side === "right";
}

/**
 * Choose sensible attachment sides for a link between two rects: the pair whose
 * outward normals face each other along the dominant separation axis. This is
 * what makes routes leave the nearest facing edge instead of crossing a frame.
 */
export function chooseSides(from: Rect, to: Rect): { from: Side; to: Side } {
  const a = rectCenter(from);
  const b = rectCenter(to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { from: "right", to: "left" } : { from: "left", to: "right" };
  }
  return dy >= 0 ? { from: "bottom", to: "top" } : { from: "top", to: "bottom" };
}

/**
 * Where a connection meets a side. The point slides along the side toward the
 * other endpoint so edges to different targets stay visually distinct, clamped
 * inside the side's span so it never sits on a corner.
 */
export function anchorOnSide(rect: Rect, side: Side, toward: Point): Point {
  const pad = Math.min(14, Math.max(6, (sideIsHorizontal(side) ? rect.height : rect.width) * 0.16));
  if (sideIsHorizontal(side)) {
    const y = clamp(toward.y, rect.y + pad, rect.y + rect.height - pad);
    return { x: side === "right" ? rect.x + rect.width : rect.x, y };
  }
  const x = clamp(toward.x, rect.x + pad, rect.x + rect.width - pad);
  return { x, y: side === "bottom" ? rect.y + rect.height : rect.y };
}

// --- Route builders ---------------------------------------------------------

const STUB = 20; // world units a route travels perpendicular before turning
const RAIL_GAP = 26; // world units a bracket rail keeps clear of the frames
const CURVE_MIN = 34;
const CURVE_MAX = 240;

function dedupe(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
    out.push(p);
  }
  return out;
}

function curveRoute(start: Point, startSide: Side, end: Point, endSide: Side): ConnRoute {
  const k = clamp(dist(start, end) * 0.42, CURVE_MIN, CURVE_MAX);
  const c1 = vadd(start, vmul(sideNormal(startSide), k));
  const c2 = vadd(end, vmul(sideNormal(endSide), k));
  return { style: "curved", kind: "cubic", start, end, startSide, endSide, points: [start, c1, c2, end] };
}

function elbowRoute(start: Point, startSide: Side, end: Point, endSide: Side): ConnRoute {
  const ns = sideNormal(startSide);
  const nt = sideNormal(endSide);
  const s1 = vadd(start, vmul(ns, STUB));
  const e1 = vadd(end, vmul(nt, STUB));
  const startH = sideIsHorizontal(startSide);
  const endH = sideIsHorizontal(endSide);
  const mid: Point[] = [];
  if (!startH && !endH) {
    // Two vertical stubs -> a horizontal run joins them (or a single step).
    let midY: number;
    if ((ns.y > 0 && e1.y < s1.y) || (ns.y < 0 && e1.y > s1.y)) midY = s1.y + ns.y * STUB;
    else midY = (s1.y + e1.y) / 2;
    mid.push({ x: s1.x, y: midY }, { x: e1.x, y: midY });
  } else if (startH && endH) {
    let midX: number;
    if ((ns.x > 0 && e1.x < s1.x) || (ns.x < 0 && e1.x > s1.x)) midX = s1.x + ns.x * STUB;
    else midX = (s1.x + e1.x) / 2;
    mid.push({ x: midX, y: s1.y }, { x: midX, y: e1.y });
  } else if (startH) {
    mid.push({ x: e1.x, y: s1.y });
  } else {
    mid.push({ x: s1.x, y: e1.y });
  }
  return { style: "elbow", kind: "poly", start, end, startSide, endSide, points: dedupe([start, s1, ...mid, e1, end]) };
}

function bracketRoute(from: Rect, to: Rect): ConnRoute {
  const a = rectCenter(from);
  const b = rectCenter(to);
  const horizontal = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
  let side: Side;
  let rail: number;
  if (horizontal) {
    // Rail runs horizontally; both legs drop from the same side (top/bottom).
    side = b.y >= a.y ? "bottom" : "top";
    rail = side === "bottom"
      ? Math.max(from.y + from.height, to.y + to.height) + RAIL_GAP
      : Math.min(from.y, to.y) - RAIL_GAP;
    const s = anchorOnSide(from, side, b);
    const e = anchorOnSide(to, side, a);
    const points = dedupe([
      s,
      { x: s.x, y: rail },
      { x: e.x, y: rail },
      e,
    ]);
    return { style: "bracket", kind: "poly", start: s, end: e, startSide: side, endSide: side, points };
  }
  // Rail runs vertically; both legs extend from the same side (left/right).
  side = b.x >= a.x ? "right" : "left";
  rail = side === "right"
    ? Math.max(from.x + from.width, to.x + to.width) + RAIL_GAP
    : Math.min(from.x, to.x) - RAIL_GAP;
  const s = anchorOnSide(from, side, b);
  const e = anchorOnSide(to, side, a);
  const points = dedupe([
    s,
    { x: rail, y: s.y },
    { x: rail, y: e.y },
    e,
  ]);
  return { style: "bracket", kind: "poly", start: s, end: e, startSide: side, endSide: side, points };
}

/**
 * Compute the route for a connection between two rects using the given style.
 * Automatic side selection is shared by the elbow/curved styles; bracket uses a
 * common facing side so its rail spans the frames.
 */
export function routeBetween(from: Rect, to: Rect, style: RouteStyle): ConnRoute {
  if (style === "bracket") return bracketRoute(from, to);
  const sides = chooseSides(from, to);
  const ac = rectCenter(from);
  const bc = rectCenter(to);
  const start = anchorOnSide(from, sides.from, bc);
  const end = anchorOnSide(to, sides.to, ac);
  return style === "elbow"
    ? elbowRoute(start, sides.from, end, sides.to)
    : curveRoute(start, sides.from, end, sides.to);
}

// --- Caching ----------------------------------------------------------------

const cache = new Map<string, ConnRoute>();
const CACHE_MAX = 600;

function keyOf(from: Rect, to: Rect, style: RouteStyle): string {
  return `${style}|${from.x},${from.y},${from.width},${from.height}|${to.x},${to.y},${to.width},${to.height}`;
}

/**
 * Cached variant of {@link routeBetween}. Routing is cheap but runs for every
 * connection on every static-layer rebuild; memoizing by the endpoint rects
 * keeps a drag/resize from recomputing unchanged links each frame.
 */
export function routeBetweenCached(from: Rect, to: Rect, style: RouteStyle): ConnRoute {
  const key = keyOf(from, to, style);
  const hit = cache.get(key);
  if (hit) return hit;
  const route = routeBetween(from, to, style);
  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next();
    if (!first.done) cache.delete(first.value);
  }
  cache.set(key, route);
  return route;
}

/** Sample a route into a world-space polyline (for hit-testing / bounds). */
export function routePolyline(route: ConnRoute, samples = 24): Point[] {
  if (route.kind === "poly") return route.points;
  const [p0, c1, c2, p3] = route.points as [Point, Point, Point, Point];
  const out: Point[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const mt = 1 - t;
    const x = mt * mt * mt * p0.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * p3.x;
    const y = mt * mt * mt * p0.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * p3.y;
    out.push({ x, y });
  }
  return out;
}

/** Direction (radians) the route points as it reaches its end. */
export function routeEndAngle(route: ConnRoute): number {
  const pts = route.points;
  if (route.kind === "cubic") {
    const c2 = pts[2];
    const end = pts[3];
    return Math.atan2(end.y - c2.y, end.x - c2.x);
  }
  // poly: use the last two distinct vertices.
  for (let i = pts.length - 1; i > 0; i--) {
    const a = pts[i - 1];
    const b = pts[i];
    if (Math.abs(a.x - b.x) > 0.01 || Math.abs(a.y - b.y) > 0.01) {
      return Math.atan2(b.y - a.y, b.x - a.x);
    }
  }
  return 0;
}
