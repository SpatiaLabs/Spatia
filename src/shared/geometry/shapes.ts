/**
 * Pure geometry for diagram shapes (framework-free, compiles for both main and
 * renderer contexts). Everything lives in world space except where noted:
 * shape paths are authored in a local axis-aligned frame centered on the
 * object's box, then rotated through `rotation` radians at hit-test time.
 */
import type { Point, Rect } from "./viewport.js";
import type { ShapeKind } from "../types/object.js";
import { pointToSegment } from "./workspace.js";

/** Ordered shape kinds — also the order used for sidebar/mobile tool buttons. */
export const SHAPE_KINDS: readonly ShapeKind[] = [
  "rectangle",
  "rounded-rectangle",
  "ellipse",
  "diamond",
  "triangle",
  "line",
  "arrow",
];

export interface ShapeDefaults {
  width: number;
  height: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
}

/** Defaults applied when a shape is first placed on the canvas. */
export const SHAPE_DEFAULTS: Record<ShapeKind, ShapeDefaults> = {
  rectangle: { width: 160, height: 100, fill: "#3d5be8", stroke: "#17256b", strokeWidth: 2 },
  "rounded-rectangle": { width: 160, height: 100, fill: "#3d5be8", stroke: "#17256b", strokeWidth: 2 },
  ellipse: { width: 160, height: 100, fill: "#4a4fd8", stroke: "#1b1e63", strokeWidth: 2 },
  diamond: { width: 160, height: 120, fill: "#5c6ff0", stroke: "#28359b", strokeWidth: 2 },
  triangle: { width: 140, height: 120, fill: "#6f4ade", stroke: "#331c78", strokeWidth: 2 },
  line: { width: 240, height: 10, fill: "", stroke: "#e8eaed", strokeWidth: 2 },
  arrow: { width: 240, height: 10, fill: "#e8eaed", stroke: "#e8eaed", strokeWidth: 2 },
};

/** Human label for a shape kind (for status text, the inspector and menus). */
export function shapeLabel(kind: ShapeKind): string {
  switch (kind) {
    case "rectangle":
      return "Rectangle";
    case "rounded-rectangle":
      return "Rounded rectangle";
    case "ellipse":
      return "Ellipse";
    case "diamond":
      return "Diamond";
    case "triangle":
      return "Triangle";
    case "line":
      return "Line";
    case "arrow":
      return "Arrow";
  }
}

/** True when the shape is a stroke-only primitive (no fill). */
export function isStrokeOnly(kind: ShapeKind): boolean {
  return kind === "line" || kind === "arrow";
}

/** Unrotated local-space endpoints for line/arrow shapes (box center at origin). */
export function shapeEndpoints(bounds: Rect): { a: Point; b: Point } {
  return {
    a: { x: -bounds.width / 2, y: 0 },
    b: { x: bounds.width / 2, y: 0 },
  };
}

/**
 * World-space hit test for a shape box at a given rotation. The point is first
 * rotated into the object's local frame, then tested against the shape
 * primitive: exact curves for ellipse/diamond/triangle, and a stroke-tolerance
 * segment test for line/arrow.
 */
export function pointInShape(kind: ShapeKind, bounds: Rect, rotation: number, p: Point): boolean {
  const boundsW = bounds.width;
  const boundsH = bounds.height;
  if (boundsW <= 0 || boundsH <= 0) return false;
  const cx = bounds.x + boundsW / 2;
  const cy = bounds.y + boundsH / 2;
  let lx = p.x - cx;
  let ly = p.y - cy;
  if (rotation !== 0) {
    const cos = Math.cos(-rotation);
    const sin = Math.sin(-rotation);
    const rx = lx * cos - ly * sin;
    const ry = lx * sin + ly * cos;
    lx = rx;
    ly = ry;
  }
  switch (kind) {
    case "rectangle":
    case "rounded-rectangle":
      return Math.abs(lx) <= boundsW / 2 && Math.abs(ly) <= boundsH / 2;
    case "ellipse": {
      const rx = boundsW / 2;
      const ry = boundsH / 2;
      return (lx * lx) / (rx * rx) + (ly * ly) / (ry * ry) <= 1;
    }
    case "diamond": {
      const rx = boundsW / 2;
      const ry = boundsH / 2;
      return Math.abs(lx) / rx + Math.abs(ly) / ry <= 1;
    }
    case "triangle":
      // Up-pointing triangle with apex at local (0, -h/2).
      return pointInTriangle(lx, ly, -boundsW / 2, boundsH / 2, boundsW / 2, boundsH / 2, 0, -boundsH / 2);
    case "line":
    case "arrow": {
      const { a, b } = shapeEndpoints(bounds);
      const dist = pointToSegment({ x: lx, y: ly }, a, b);
      // Stroke radius plus a small finger-friendly margin.
      const tolerance = Math.max(4, boundsH / 2 + 2);
      return dist <= tolerance;
    }
  }
}

/** Axis-aligned bounding box of a rotated rectangle (before padding). */
export function rotatedBounds(rect: Rect, rotation: number): Rect {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const cos = Math.abs(Math.cos(rotation));
  const sin = Math.abs(Math.sin(rotation));
  const width = rect.width * cos + rect.height * sin;
  const height = rect.width * sin + rect.height * cos;
  return { x: cx - width / 2, y: cy - height / 2, width, height };
}

/** Signed orientation test; zero means the point is on edge abc. */
function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function pointInTriangle(px: number, py: number, v1x: number, v1y: number, v2x: number, v2y: number, v3x: number, v3y: number): boolean {
  const d1 = orient(v1x, v1y, v2x, v2y, px, py);
  const d2 = orient(v2x, v2y, v3x, v3y, px, py);
  const d3 = orient(v3x, v3y, v1x, v1y, px, py);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}