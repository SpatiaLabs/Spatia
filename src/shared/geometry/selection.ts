import type { Point, Rect } from "./viewport.js";

/**
 * Pure geometry for selection-box dragging and resize handles. All functions
 * operate in world space so they behave identically at any zoom/pan.
 *
 * The drag/move model is *absolute*: the target position derives solely from
 * the current pointer world point and a fixed grab offset, never from an
 * accumulating delta. This guarantees the object tracks the cursor 1:1 and
 * eliminates the "fly-away" bug where an object accelerates away from the
 * pointer.
 */

/** A resize handle on the selection box. */
export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

/** Anchor of each handle in normalized (0..1) coordinates of the box. */
export const HANDLE_POS: Readonly<Record<Handle, Point>> = {
  nw: { x: 0, y: 0 },
  n: { x: 0.5, y: 0 },
  ne: { x: 1, y: 0 },
  e: { x: 1, y: 0.5 },
  se: { x: 1, y: 1 },
  s: { x: 0.5, y: 1 },
  sw: { x: 0, y: 1 },
  w: { x: 0, y: 0.5 },
};

export const HANDLES: readonly Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** World position of a handle for an axis-aligned rect. */
export function handleWorld(rect: Rect, handle: Handle): Point {
  const p = HANDLE_POS[handle];
  return { x: rect.x + p.x * rect.width, y: rect.y + p.y * rect.height };
}

/**
 * Compute the new rect when resizing from `handle`, keeping the opposite edge
 * fixed. Deliberately pure & absolute: `currentWorld` fully determines the
 * result (with `startWorld` giving the initial drag reference and `original`
 * the pre-drag rect), so dragging never accumulates error.
 */
export function resizeRect(
  original: Rect,
  handle: Handle,
  startWorld: Point,
  currentWorld: Point,
  minSize = 10
): Rect {
  const dx = currentWorld.x - startWorld.x;
  const dy = currentWorld.y - startWorld.y;
  const pos = HANDLE_POS[handle];

  let x = original.x;
  let y = original.y;
  let width = original.width;
  let height = original.height;

  if (pos.x === 0) {
    const nx = Math.min(original.x + dx, original.x + original.width - minSize);
    width = original.x + original.width - nx;
    x = nx;
  } else if (pos.x === 1) {
    width = Math.max(minSize, original.width + dx);
  }

  if (pos.y === 0) {
    const ny = Math.min(original.y + dy, original.y + original.height - minSize);
    height = original.y + original.height - ny;
    y = ny;
  } else if (pos.y === 1) {
    height = Math.max(minSize, original.height + dy);
  }

  return { x, y, width, height };
}

/**
 * Compute the axis-aligned bounding box covering a set of world rects (the
 * selection marquee / multi-select box). Returns null when empty.
 */
export function selectionBounds(objects: readonly Rect[]): Rect | null {
  if (objects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of objects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
