import type { Point, Rect } from "./viewport.js";
import type { CanvasObject, GroupObject } from "../types/object.js";

/**
 * Pure workspace geometry for Phase 3 features: connections (edge-to-edge
 * anchoring) and groups (derived bounding boxes). These are framework-free so
 * they compile for both the renderer and the test runner.
 */

/** World-space AABB of a plain rectangular object. */
export function objectRect(o: { x: number; y: number; width: number; height: number }): Rect {
  return { x: o.x, y: o.y, width: o.width, height: o.height };
}

/** Center of a rectangle. */
export function rectCenter(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** Axis-aligned union of several rectangles, or null when empty. */
export function unionRect(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Compute the world-space attachment point on the edge of a rectangle that
 * faces toward a target point. "auto" picks the edge whose outward normal is
 * most aligned with the direction to the target; the returned point lies on
 * that rect edge (the connection stops at the object edge, not its center).
 */
export function edgeAnchor(source: Rect, target: Point): Point {
  const center = rectCenter(source);
  const dx = target.x - center.x;
  const dy = target.y - center.y;
  const hw = source.width / 2;
  const hh = source.height / 2;
  const sx = hw > 0 ? dx / hw : 0;
  const sy = hh > 0 ? dy / hh : 0;
  if (Math.abs(sx) >= Math.abs(sy)) {
    // Anchor on the left/right edge.
    const x = center.x + (sx >= 0 ? hw : -hw);
    // Clamp within the vertical span of that edge.
    const y = clampRange(center.y + dy * (hw / Math.max(Math.abs(dx), 1)), center.y - hh, center.y + hh);
    return { x, y };
  }
  // Anchor on the top/bottom edge.
  const y = center.y + (sy >= 0 ? hh : -hh);
  const x = clampRange(center.x + dx * (hh / Math.max(Math.abs(dy), 1)), center.x - hw, center.x + hw);
  return { x, y };
}

function clampRange(v: number, min: number, max: number): number {
  return Math.max(Math.min(v, max), min);
}

/**
 * Resolve the two world-space endpoints of a connection given the source and
 * target objects (already resolved). Each endpoint sits on the facing edge of
 * its object. If an endpoint object is missing, the connection uses the stored
 * (x,y) as a fallback point.
 */
export function connectionEndpoints(
  conn: { from: string; to: string; x: number; y: number; endX?: number; endY?: number },
  fromObj: { x: number; y: number; width: number; height: number } | undefined,
  toObj: { x: number; y: number; width: number; height: number } | undefined
): { start: Point; end: Point } {
  if (fromObj && toObj) {
    const a = objectRect(fromObj);
    const b = objectRect(toObj);
    const bc = rectCenter(b);
    const ac = rectCenter(a);
    const start = edgeAnchor(a, bc);
    const end = edgeAnchor(b, ac);
    return { start, end };
  }
  // A free-endpoint connection (to === "") or a deleted target: anchor the
  // source edge toward the stored world position and end exactly there.
  if (fromObj) {
    const end: Point = {
      x: typeof conn.endX === "number" ? conn.endX : conn.x,
      y: typeof conn.endY === "number" ? conn.endY : conn.y,
    };
    const start = edgeAnchor(objectRect(fromObj), end);
    return { start, end };
  }
  // Fallback (source missing): draw from the stored anchor to a fixed offset so
  // the connection remains visible/selectable.
  return {
    start: { x: conn.x, y: conn.y },
    end: { x: conn.x + 80, y: conn.y + 80 },
  };
}

/** Closest distance from a point to a line segment (world space). */
export function pointToSegment(p: Point, a: Point, b: Point): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * abx;
  const cy = a.y + t * aby;
  return Math.hypot(p.x - cx, p.y - cy);
}

/** Whether a connection is selectable at the given clarity radius (world units). */
export function connectionHit(p: Point, start: Point, end: Point, radius: number): boolean {
  return pointToSegment(p, start, end) <= radius;
}

/**
 * Expand a set of selected ids to include all members of any selected group.
 * Group members are returned so moving/deleting/duplicating the group also
 * affects its contents. Non-selected groups leave their members untouched.
 */
export function expandMembers(
  ids: readonly string[],
  objects: readonly CanvasObject[],
  isGroup: (o: CanvasObject) => boolean
): Set<string> {
  const out = new Set<string>(ids);
  for (const id of ids) {
    const o = objects.find((x) => x.id === id);
    if (o && isGroup(o)) {
      for (const m of (o as GroupObject).memberIds) out.add(m);
    }
  }
  return out;
}

/**
 * Compute the derived bounding box for a group from its live members. The group
 * wrapper always exposes a rectangle so selection bounds / marquee work, but its
 * real extent comes from the members.
 */
/**
 * A snap/alignment guide to render as an overlay. `value` is a world-space
 * coordinate on the given axis; the engine draws a full-canvas guide there.
 */
export interface SnapGuide {
  axis: "x" | "y";
  value: number;
}

export interface SnapResult {
  /** Suggested world-space translation to apply to the whole target rect. */
  dx: number;
  dy: number;
  /** Guides to draw for the chosen snaps (may be empty when nothing snapped). */
  guides: SnapGuide[];
}

/** The 3 scalar anchors (start, center, end) along one axis of a rect. */
function anchors(min: number, size: number): [number, number, number] {
  return [min, min + size / 2, min + size];
}

/**
 * Find the smallest-magnitude snap delta for a single moving target anchor
 * against the union of candidate anchors, within `tolerance`. Returns `null`
 * when nothing is close enough.
 */
function snapOne(target: number, candidates: number[], tolerance: number): number | null {
  if (!Number.isFinite(target)) return null;
  let best: number | null = null;
  let bestDelta = Infinity;
  for (const c of candidates) {
    const delta = c - target;
    const abs = Math.abs(delta);
    if (abs <= tolerance && abs < bestDelta) {
      best = c;
      bestDelta = abs;
    }
  }
  return best === null ? null : best - target;
}

/** Candidate edge/center anchors of a rect. */
export function rectAnchors(r: Rect): number[] {
  return [r.x, r.x + r.width / 2, r.x + r.width, r.y, r.y + r.height / 2, r.y + r.height];
}

/**
 * Snap a moving selection AABB to the edges/centers of other objects. Picks the
 * single smallest snap per axis so the whole rect translates consistently.
 */
export function snapMove(rect: Rect, others: readonly Rect[], tolerance: number): SnapResult {
  const candXs: number[] = [];
  const candYs: number[] = [];
  for (const o of others) {
    candXs.push(o.x, o.x + o.width / 2, o.x + o.width);
    candYs.push(o.y, o.y + o.height / 2, o.y + o.height);
  }
  const tXs = anchors(rect.x, rect.width);
  const tYs = anchors(rect.y, rect.height);

  const bestX = { delta: Infinity, cand: -Infinity };
  for (const t of tXs) {
    const d = snapOne(t, candXs, tolerance);
    if (d !== null && Math.abs(d) < Math.abs(bestX.delta)) {
      bestX.delta = d;
      bestX.cand = t + d;
    }
  }
  const bestY = { delta: Infinity, cand: -Infinity };
  for (const t of tYs) {
    const d = snapOne(t, candYs, tolerance);
    if (d !== null && Math.abs(d) < Math.abs(bestY.delta)) {
      bestY.delta = d;
      bestY.cand = t + d;
    }
  }

  const dx = Number.isFinite(bestX.delta) ? bestX.delta : 0;
  const dy = Number.isFinite(bestY.delta) ? bestY.delta : 0;
  const guides: SnapGuide[] = [];
  if (dx !== 0) guides.push({ axis: "x", value: bestX.cand });
  if (dy !== 0) guides.push({ axis: "y", value: bestY.cand });
  return { dx, dy, guides };
}

/**
 * Snap a resized AABB to other objects' edges/centers. Only the edges pulled by
 * `handle` are allowed to move; the returned delta maps onto those edges and is
 * intended to be applied to the resized bounds before the per-object scale.
 */
export function snapResize(bounds: Rect, handle: string, others: readonly Rect[], tolerance: number): SnapResult {
  const candXs: number[] = [];
  const candYs: number[] = [];
  for (const o of others) {
    candXs.push(o.x, o.x + o.width / 2, o.x + o.width);
    candYs.push(o.y, o.y + o.height / 2, o.y + o.height);
  }
  const movesX = handle.includes("e") || handle.includes("w");
  const movesY = handle.includes("n") || handle.includes("s");
  let dx = 0;
  let dy = 0;
  const guides: SnapGuide[] = [];

  if (movesX) {
    if (handle.includes("e")) {
      const d = snapOne(bounds.x + bounds.width, candXs, tolerance);
      if (d !== null) {
        dx = d;
        guides.push({ axis: "x", value: bounds.x + bounds.width + d });
      }
    } else if (handle.includes("w")) {
      const d = snapOne(bounds.x, candXs, tolerance);
      if (d !== null) {
        dx = d;
        guides.push({ axis: "x", value: bounds.x + d });
      }
    }
  }
  if (movesY) {
    if (handle.includes("s")) {
      const d = snapOne(bounds.y + bounds.height, candYs, tolerance);
      if (d !== null) {
        dy = d;
        guides.push({ axis: "y", value: bounds.y + bounds.height + d });
      }
    } else if (handle.includes("n")) {
      const d = snapOne(bounds.y, candYs, tolerance);
      if (d !== null) {
        dy = d;
        guides.push({ axis: "y", value: bounds.y + d });
      }
    }
  }
  return { dx, dy, guides };
}

export function groupBounds(group: GroupObject, objects: readonly CanvasObject[]): Rect {
  const rects: Rect[] = [];
  for (const m of group.memberIds) {
    const o = objects.find((x) => x.id === m);
    if (o) rects.push(objectRect(o));
  }
  const u = unionRect(rects);
  if (u) return u;
  return { x: group.x, y: group.y, width: group.width <= 0 ? 120 : group.width, height: group.height <= 0 ? 90 : group.height };
}

// ---------------------------------------------------------------------------
// Connection graph helpers (branching links)

/** True when a connection references any id in `ids` (from or object target). */
export function connectionTouches(
  conn: { from: string; to: string },
  ids: ReadonlySet<string>
): boolean {
  return ids.has(conn.from) || (conn.to !== "" && ids.has(conn.to));
}

/**
 * Ids of every connection whose endpoint touches one of `ids`. Used so that
 * deleting a frame also removes the links attached to it (no dangling edges),
 * and duplicating a set can carry its internal edges along.
 */
export function connectionsTouching(
  objects: readonly CanvasObject[],
  ids: ReadonlySet<string>
): string[] {
  const out: string[] = [];
  for (const o of objects) {
    if (o.type === "connection" && connectionTouches(o, ids)) out.push(o.id);
  }
  return out;
}

/**
 * Parse a connection's edge choice. `auto` snaps to the facing edge; `none`
 * (free endpoint) is only valid when the matching endpoint object is absent.
 * Exposed so the UI/commands can validate before creating an edge.
 */
export function isConnectableEndpoint(o: CanvasObject | undefined): boolean {
  return o !== undefined && o.type !== "connection";
}

/** True when a directed edge from `from` to `to` already exists. */
export function connectionBetween(
  objects: readonly CanvasObject[],
  from: string,
  to: string
): string | undefined {
  for (const o of objects) {
    if (o.type === "connection" && o.from === from && o.to === to) return o.id;
  }
  return undefined;
}

/**
 * Remap a connection's endpoints through an old-id -> new-id map, preserving
 * any endpoint that is not part of the map (e.g. a free endpoint or a link that
 * points outside the duplicated selection). This is what lets a duplicated
 * cluster keep its internal branching graph instead of re-pointing at the
 * originals.
 */
export function remapConnection<T extends { from: string; to: string }>(
  conn: T,
  idMap: ReadonlyMap<string, string>
): T {
  const from = idMap.get(conn.from) ?? conn.from;
  const to = conn.to === "" ? "" : idMap.get(conn.to) ?? conn.to;
  if (from === conn.from && to === conn.to) return conn;
  return { ...conn, from, to };
}