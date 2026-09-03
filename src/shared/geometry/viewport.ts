import type { ViewportState } from "../types/project.js";

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Transform utilities converting between world coordinates (infinite canvas
 * space) and screen coordinates (viewport / CSS pixel space).
 *
 * A world point `w` maps to screen space as:
 *
 *   screen.x = (world.x - camera.x) * zoom + origin.x
 *   screen.y = (world.y - camera.y) * zoom + origin.y
 *
 * where `camera` is the world point currently at the viewport origin (top-left
 * of the canvas element) and `origin` is the viewport size in screen pixels.
 *
 * The camera position is intentionally stored as the TOP-LEFT corner in world
 * space so that panning simply shifts (camera.x, camera.y) by the inverse of a
 * screen delta divided by zoom.
 */

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 8;

export const DEFAULT_ZOOM = 1;

export const ZOOM_STEP = 1.2;

const EPSILON = 1e-9;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return DEFAULT_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export interface ViewportFrame {
  cameraX: number;
  cameraY: number;
  zoom: number;
  originWidth: number;
  originHeight: number;
}

export function createFrame(
  viewport: ViewportState,
  originWidth: number,
  originHeight: number
): ViewportFrame {
  return {
    cameraX: viewport.x,
    cameraY: viewport.y,
    zoom: viewport.zoom,
    originWidth,
    originHeight,
  };
}

/**
 * Convert a world-space point to screen coordinates. Pure function.
 */
export function worldToScreen(world: Point, frame: ViewportFrame): Point {
  return {
    x: (world.x - frame.cameraX) * frame.zoom,
    y: (world.y - frame.cameraY) * frame.zoom,
  };
}

/**
 * Convert a screen-space point to world coordinates. The screen point is
 * relative to the top-left corner of the canvas viewport. Pure function.
 */
export function screenToWorld(screen: Point, frame: ViewportFrame): Point {
  return {
    x: screen.x / frame.zoom + frame.cameraX,
    y: screen.y / frame.zoom + frame.cameraY,
  };
}

/**
 * Pan the camera so that a world point stays fixed under a screen point whose
 * position does not change. Used to keep geometry anchored under the cursor
 * while zooming. Pure function.
 */
export function anchoredZoom(
  viewport: ViewportState,
  zoomFactor: number,
  anchorScreen: Point,
  frame: ViewportFrame
): ViewportState {
  const zoom = clampZoom(viewport.zoom * zoomFactor);
  if (Math.abs(zoom - viewport.zoom) < EPSILON) {
    return { ...viewport };
  }

  // The world point currently under the cursor before the zoom.
  const anchorWorld = screenToWorld(anchorScreen, frame);

  // camera.x satisfies: anchorScreen.x = (anchorWorld.x - camera.x) * newZoom
  const x = anchorWorld.x - anchorScreen.x / zoom;
  const y = anchorWorld.y - anchorScreen.y / zoom;

  return { x, y, zoom };
}

/**
 * Apply a pan of `dx`,`dy` screen pixels. The camera moves opposite the drag so
 * that the world follows the pointer. Divided by zoom to stay correct at any
 * zoom level. Pure function.
 */
export function panByScreenDelta(
  viewport: ViewportState,
  dx: number,
  dy: number
): ViewportState {
  return {
    ...viewport,
    x: viewport.x - dx / viewport.zoom,
    y: viewport.y - dy / viewport.zoom,
  };
}

/**
 * The visible world-space rectangle (top-left corner + size) for the current
 * frame. Used for culling objects that are far off-screen. Pure function.
 */
export function visibleWorldRect(frame: ViewportFrame): Rect {
  return {
    x: frame.cameraX,
    y: frame.cameraY,
    width: frame.originWidth / frame.zoom,
    height: frame.originHeight / frame.zoom,
  };
}

function pointInRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/**
 * Check whether a world-space rect overlaps the visible region. Uses an
 * inscribed circle approximation only where rotation is involved; otherwise
 * uses exact AABB overlap. Pure function.
 */
export function isRectVisible(r: Rect, frame: ViewportFrame): boolean {
  return rectsOverlap(r, visibleWorldRect(frame));
}

/**
 * Determine whether a screen-space point falls within a rotated world rect.
 * Pure function.
 */
export function pointInRotatedRect(
  screenPoint: Point,
  worldRect: Rect,
  rotation: number,
  frame: ViewportFrame
): boolean {
  if (Math.abs(rotation) < EPSILON) {
    const world = screenToWorld(screenPoint, frame);
    return pointInRect(world, { ...worldRect, x: worldRect.x, y: worldRect.y });
  }

  // Inverse-transform the screen point into the object's local space.
  const world = screenToWorld(screenPoint, frame);
  const cx = worldRect.x + worldRect.width / 2;
  const cy = worldRect.y + worldRect.height / 2;
  const cos = Math.cos(-rotation);
  const sin = Math.sin(-rotation);
  const lx = (world.x - cx) * cos - (world.y - cy) * sin;
  const ly = (world.x - cx) * sin + (world.y - cy) * cos;
  const hw = worldRect.width / 2;
  const hh = worldRect.height / 2;
  return Math.abs(lx) <= hw && Math.abs(ly) <= hh;
}
