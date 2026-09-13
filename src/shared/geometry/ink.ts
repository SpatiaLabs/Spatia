/**
 * Pure ink geometry — freehand stroke processing that is shared by the renderer
 * (draft preview + committed strokes), tests and (possibly) the main process.
 *
 * This module MUST stay framework-free: no DOM, no Node imports. Strokes are
 * arrays of `WorldPoint` (x/y in world space with an optional per-vertex
 * width), exactly as stored on `PenObject.points`.
 */
import type { Point, Rect } from "./viewport.js";
import type { WorldPoint } from "../types/object.js";

/** RTL detection: Hebrew, Arabic, Syriac, Thaana, Arabic presentation forms. */
export const RTL_RE = /[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFF]/;

// ---------------------------------------------------------------------------
// Sampling / resampling

/**
 * Resample a raw polyline: drop consecutive points closer than `minDist`
 * (world units) and remove midpoints that are nearly collinear with their
 * neighbours. Always keeps the first and last point, so fast flick strokes
 * never lose their endpoints (no visible gaps when drawing quickly).
 */
export function resampleStroke(points: readonly WorldPoint[], minDist: number): WorldPoint[] {
  const n = points.length;
  if (n <= 2) return points as WorldPoint[];
  const out: WorldPoint[] = [points[0]];
  for (let i = 1; i < n - 1; i++) {
    const prev = out[out.length - 1];
    const cur = points[i];
    if ((cur.x - prev.x) * (cur.x - prev.x) + (cur.y - prev.y) * (cur.y - prev.y) < minDist * minDist) continue;
    const next = points[i + 1];
    // Collinear midpoints carry no information (angle ~ 180°): drop them.
    if (turnCos(prev, cur, next) <= 1 - 1e-6 && localized(prev, cur, next, minDist * 2)) continue;
    out.push(cur);
  }
  const last = points[n - 1];
  const prev = out[out.length - 1];
  if (Math.hypot(last.x - prev.x, last.y - prev.y) >= minDist || out.length === 1) out.push(last);
  return out;
}

/** Cosine of the interior angle at `b` (1 = straight ahead, -1 = hairpin). */
function turnCos(a: Point, b: Point, c: Point): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const bcx = c.x - b.x;
  const bcy = c.y - b.y;
  const len = Math.hypot(abx, aby) * Math.hypot(bcx, bcy);
  if (!Number.isFinite(len) || len === 0) return 1;
  return (abx * bcx + aby * bcy) / len;
}

function localized(a: Point, b: Point, c: Point, span: number): boolean {
  return Math.hypot(b.x - a.x, b.y - a.y) < span && Math.hypot(c.x - b.x, c.y - b.y) < span;
}

// ---------------------------------------------------------------------------
// Smoothing (corner-preserving Chaikin)

/**
 * Detect sharp corners in a polyline. An index is a corner when the direction
 * of travel turns sharply: the cosine of the turn is below `-threshold`, i.e.
 * the interior angle is smaller than `~acos(-threshold)`. With the default
 * `-0.5` that means turns of more than ~60° (interior angle < ~120°) — right
 * angles and hairpins qualify, straight runs and gentle curves do not. The
 * first and last points are never corners.
 */
export function cornerMask(points: readonly WorldPoint[], threshold = -0.5): boolean[] {
  const n = points.length;
  const mask = new Array<boolean>(n).fill(false);
  for (let i = 1; i < n - 1; i++) {
    mask[i] = turnCos(points[i - 1], points[i], points[i + 1]) < -threshold;
  }
  return mask;
}

/** One Chaikin pass: keeps corners intact, rounds everything else. */
function chaikinOnce(points: readonly WorldPoint[], corners: readonly boolean[]): WorldPoint[] {
  const n = points.length;
  if (n < 3) return points as WorldPoint[];
  const out: WorldPoint[] = [points[0]];
  for (let i = 0; i < n - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    // The far endpoint is a corner: drop the segment's midpoint pair so the
    // corner itself remains the exact turn point.
    if (corners[i + 1]) {
      out.push(b);
      continue;
    }
    out.push(
      { x: a.x + (b.x - a.x) * 0.25, y: a.y + (b.y - a.y) * 0.25 },
      { x: a.x + (b.x - a.x) * 0.75, y: a.y + (b.y - a.y) * 0.75 }
    );
  }
  return out;
}

/**
 * Corner-preserving Chaikin smoothing. Sharp angles are retained verbatim so
 * handwriting corners (L, V, cross strokes) stay crisp while wrist jitter is
 * rounded away. `iterations` 0 = unchanged, 1..2 = progressively smoother.
 */
export function smoothStroke(points: readonly WorldPoint[], iterations: number): WorldPoint[] {
  if (iterations <= 0 || points.length < 5) return points as WorldPoint[];
  let pts: WorldPoint[] = points as WorldPoint[];
  let corners = cornerMask(pts);
  for (let i = 0; i < iterations; i++) {
    pts = chaikinOnce(pts, corners);
    corners = cornerMask(pts);
  }
  return pts;
}

/**
 * Rubber-band stabilizer: roll the final `lag` raw samples into a single
 * trailing-average tip. The stroke trails the pen by a handful of samples, so
 * micro-jitter at the tip (the part the eye watches) lags out of the line
 * while the captured geometry before the tail is untouched. The resolved tip
 * keeps the per-vertex width of the last sample so pressure strokes stay
 * tapered. `lag` <= 0 (or longer than the whole stroke) returns the points
 * unchanged — stabilizer off must reproduce the input exactly.
 */
export function stabilizeStroke(points: readonly WorldPoint[], lag: number): WorldPoint[] {
  const n = points.length;
  if (lag <= 0 || n <= lag + 1) return points as WorldPoint[];
  const out: WorldPoint[] = points.slice(0, n - lag) as WorldPoint[];
  let sx = 0;
  let sy = 0;
  for (let i = n - lag; i < n; i++) {
    sx += points[i].x;
    sy += points[i].y;
  }
  const last = points[n - 1];
  const tip: WorldPoint = { x: sx / lag, y: sy / lag };
  if (last.width !== undefined) tip.width = last.width;
  out.push(tip);
  return out;
}

// ---------------------------------------------------------------------------
// Bounding boxes / translation

/** Axis-aligned bounds of a polyline (world units). */
export function strokeBounds(points: readonly WorldPoint[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return {
    x: Number.isFinite(minX) ? minX : 0,
    y: Number.isFinite(minY) ? minY : 0,
    width: Number.isFinite(minX) ? maxX - minX : 0,
    height: Number.isFinite(minY) ? maxY - minY : 0,
  };
}

export function translatePoints(points: readonly WorldPoint[], dx: number, dy: number): WorldPoint[] {
  return points.map((p) => ({
    x: p.x + dx,
    y: p.y + dy,
    ...(p.width !== undefined ? { width: p.width } : {}),
  }));
}

// ---------------------------------------------------------------------------
// Distance helpers

function distPointToSegment(p: Point, a: Point, b: Point): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  let t = 0;
  if (len2 > 0) t = Math.min(1, Math.max(0, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2));
  const cx = a.x + t * abx;
  const cy = a.y + t * aby;
  return Math.hypot(p.x - cx, p.y - cy);
}

export function distPointToPolyline(p: Point, path: readonly Point[], max = Infinity): number {
  if (path.length === 0) return Infinity;
  if (path.length === 1) return Math.hypot(p.x - path[0].x, p.y - path[0].y);
  let best = Infinity;
  for (let i = 1; i < path.length; i++) {
    const d = distPointToSegment(p, path[i - 1], path[i]);
    if (d < best) best = d;
    if (best <= max) return best;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Partial eraser

/**
 * Split a stroke by an eraser sweep.
 *
 * `eraser` is the swept eraser path (world space) with round caps; `radius` is
 * the effective eraser radius in world units and SHOULD already include the
 * stroke's own half width. A vertex is erased when its distance to the sweep
 * (or to a single eraser dot) is strictly less than `radius`. Segment
 * midpoints are bridged for sweeps (multi-point paths) so a fast pass that
 * lands near a middle vertex severs the whole crossing stretch, not a hole in
 * the middle of the line; a single tap only cuts points the disc actually
 * covers (a tap must never erase shadowed stretch beyond its radius).
 *
 * Returns the surviving fragments, each with at least one point (a stub —
 * erasing the center of a sparse stroke leaves two single-point ends, which is
 * the honest remainder and can't re-join into a false line). A (near) full
 * pass returns zero fragments, which the caller treats as "delete the stroke".
 */
export function eraseStroke(
  points: readonly WorldPoint[],
  eraser: readonly Point[],
  radius: number
): WorldPoint[][] {
  const n = points.length;
  if (n === 0 || eraser.length === 0 || radius <= 0) return [points as WorldPoint[]];

  const erased = new Array<boolean>(n).fill(false);
  if (eraser.length === 1) {
    const c = eraser[0];
    for (let i = 0; i < n; i++) {
      if (Math.hypot(points[i].x - c.x, points[i].y - c.y) < radius) erased[i] = true;
    }
  } else {
    for (let i = 0; i < n; i++) {
      if (distPointToPolyline(points[i], eraser, radius) <= radius) erased[i] = true;
    }
  }

  // Bridge: only for sweeps. A segment whose midpoint is under the eraser
  // erases both endpoints, so the eraser cleanly severs crossings even with
  // sparse sampling between consecutive sweep samples.
  if (eraser.length > 1) {
    for (let i = 0; i < n - 1; i++) {
      if (erased[i] && erased[i + 1]) continue;
      const mid = { x: (points[i].x + points[i + 1].x) / 2, y: (points[i].y + points[i + 1].y) / 2 };
      if (distPointToPolyline(mid, eraser, radius) <= radius) {
        erased[i] = true;
        erased[i + 1] = true;
      }
    }
  }

  const fragments: WorldPoint[][] = [];
  let run: WorldPoint[] = [];
  for (let i = 0; i <= n; i++) {
    if (i < n && !erased[i]) {
      run.push(points[i]);
      continue;
    }
    if (run.length >= 1) fragments.push(run);
    run = [];
  }
  return fragments;
}

// ---------------------------------------------------------------------------
// Selection geometry (lasso + marquee)

/** Even-odd ray casting point-in-polygon test. */
export function pointInPolygon(p: Point, poly: readonly Point[]): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const orient = (p: Point, q: Point, r: Point): number => {
    const v = (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    return v > 1e-9 ? 1 : v < -1e-9 ? -1 : 0;
  };
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a, b, c)) return true;
  if (o2 === 0 && onSegment(a, b, d)) return true;
  if (o3 === 0 && onSegment(c, d, a)) return true;
  if (o4 === 0 && onSegment(c, d, b)) return true;
  return false;
}

function onSegment(a: Point, b: Point, p: Point): boolean {
  return (
    Math.min(a.x, b.x) <= p.x + 1e-9 && p.x <= Math.max(a.x, b.x) + 1e-9 &&
    Math.min(a.y, b.y) <= p.y + 1e-9 && p.y <= Math.max(a.y, b.y) + 1e-9
  );
}

/**
 * True when a stroke is selected by a lasso: any vertex inside the polygon, or
 * any stroke segment crossing a polygon edge (`radius` adds stroke half-width
 * slack so strokes just grazing the lasso edge are caught).
 */
export function strokeIntersectsLasso(
  points: readonly WorldPoint[],
  lasso: readonly Point[],
  radius = 0
): boolean {
  const n = points.length;
  if (n < 2 || lasso.length < 3) return false;
  for (const p of points) {
    if (pointInPolygon(p, lasso)) return true;
  }
  for (let i = 0; i < n - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    for (let j = 0; j < lasso.length; j++) {
      const c = lasso[j];
      const d = lasso[(j + 1) % lasso.length];
      if (segmentsIntersect(a, b, c, d)) return true;
      if (radius > 0) {
        if (distPointToSegment(c, a, b) <= radius) return true;
        if (distPointToSegment(a, c, d) <= radius) return true;
      }
    }
  }
  return false;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Whether a stroke's bounds overlap a rect (used for marquee ink selection). */
export function strokeTouchesRect(points: readonly WorldPoint[], rect: Rect): boolean {
  if (points.length === 0) return false;
  return rectsIntersect(strokeBounds(points), rect);
}

/** Per-line RTL detection for canvas text drawing. */
export function isRtlLine(line: string): boolean {
  return RTL_RE.test(line);
}