import type { ViewportFrame, Rect } from "../../shared/geometry/viewport.js";
import { worldToScreen, visibleWorldRect } from "../../shared/geometry/viewport.js";

export interface GridSpacing {
  minor: number;
  major: number;
}

/**
 * Choose grid line spacing (in world units) that adapts to the zoom level so
 * successive minor lines are separated by roughly a readable on-screen amount.
 * Lines are placed at world-coordinate multiples of the spacing, which keeps
 * the grid visually stable (no shimmer) while panning and zooming.
 */
export function gridSpacingForZoom(zoom: number): GridSpacing {
  const minMinor = 60 / zoom;
  const exp = Math.floor(Math.log10(minMinor));
  const base = Math.pow(10, exp);
  const mult = [1, 2, 5, 10].find((c) => c * base >= minMinor) ?? 10;
  const minor = mult * base;
  return { minor, major: minor * 5 };
}

/**
 * Draw an infinite-style grid derived from world coordinates for the given
 * frame. Only lines intersecting the visible region are emitted, so the cost is
 * bounded regardless of how far the camera has been panned.
 */
export function drawGrid(ctx: CanvasRenderingContext2D, frame: ViewportFrame): void {
  const { minor, major } = gridSpacingForZoom(frame.zoom);
  const visible = visibleWorldRect(frame);

  drawAxisLines(ctx, frame, visible, minor, false);
  drawAxisLines(ctx, frame, visible, major, true);
}

function drawAxisLines(
  ctx: CanvasRenderingContext2D,
  frame: ViewportFrame,
  visible: Rect,
  spacing: number,
  isMajor: boolean
): void {
  ctx.beginPath();

  // Vertical lines at world multiples of `spacing`.
  const firstX = Math.ceil(visible.x / spacing) * spacing;
  for (let wx = firstX; wx <= visible.x + visible.width; wx += spacing) {
    const sx = worldToScreen({ x: wx, y: 0 }, frame).x;
    ctx.moveTo(round(sx) + 0.5, 0);
    ctx.lineTo(round(sx) + 0.5, frame.originHeight);
  }

  // Horizontal lines.
  const firstY = Math.ceil(visible.y / spacing) * spacing;
  for (let wy = firstY; wy <= visible.y + visible.height; wy += spacing) {
    const sy = worldToScreen({ x: 0, y: wy }, frame).y;
    ctx.moveTo(0, round(sy) + 0.5);
    ctx.lineTo(frame.originWidth, round(sy) + 0.5);
  }

  ctx.strokeStyle = isMajor ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.03)";
  ctx.lineWidth = 1;
  ctx.stroke();
}

function round(v: number): number {
  return Math.round(v);
}
