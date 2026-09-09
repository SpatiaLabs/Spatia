/**
 * Bounds computation for export. Uses per-object *rotated* bounding boxes so
 * rotated shapes/text/images are never clipped at the edge of a PNG/PDF, plus
 * a padding margin.
 */
import type { Rect } from "../geometry/viewport.js";
import type { CanvasObject } from "../types/object.js";
import { rotatedBounds } from "../geometry/shapes.js";

/** World-space rect covering every object (rotated AABBs) plus padding. */
export function exportBounds(objects: readonly CanvasObject[], padding = 40): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const o of objects) {
    const r = rotatedBounds({ x: o.x, y: o.y, width: o.width, height: o.height }, o.rotation);
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  if (!Number.isFinite(minX)) {
    return { x: -400, y: -300, width: 800, height: 600 };
  }
  return {
    x: minX - padding,
    y: minY - padding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
  };
}