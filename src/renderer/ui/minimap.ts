import type { ViewportState } from "../../shared/types/project.js";
import type { CanvasObject } from "../../shared/types/object.js";
import type { Point } from "../../shared/geometry/viewport.js";
import { unionRect } from "../../shared/geometry/workspace.js";

/**
 * A small always-visible overview of the workspace drawn on its own canvas. It
 * renders every object/frame as a compact rect plus a highlighted rectangle for
 * the current viewport, so the user always knows where the camera is relative to
 * the content. Clicking / dragging the minimap recentres the camera on the
 * chosen world point (view-independent), keeping world coordinates authoritative.
 *
 * The minimap displays a fixed "world window" computed from the union of all
 * object bounds (plus margin). Because the world is the source of truth, panning
 * the main view just moves the highlight; the content rects never shift.
 */
export class Minimap {
  private dpr = 1;
  private unsub: Array<() => void> = [];
  private dragging = false;
  private readonly W = 220;
  private readonly H = 150;
  private readonly MARGIN = 40;

  constructor(
    private canvas: HTMLCanvasElement,
    private project: () => readonly CanvasObject[],
    private viewport: () => ViewportState,
    private navigate: (world: Point) => void
  ) {
    canvas.width = this.W * this.dpr;
    canvas.height = this.H * this.dpr;
    canvas.style.width = `${this.W}px`;
    canvas.style.height = `${this.H}px`;
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    this.render();
  }

  attach(): void {
    // No-op: created already rendering; callers call update() on changes.
  }

  dispose(): void {
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    for (const u of this.unsub) u();
    this.unsub = [];
  }

  /** Re-read project + viewport and redraw. Cheap enough to call on each change. */
  update(): void {
    this.render();
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.dragging = true;
    this.canvas.setPointerCapture(e.pointerId);
    this.locate(e);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.dragging) this.locate(e);
  };

  private onPointerUp = (): void => {
    this.dragging = false;
  };

  private locate(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const world = this.worldAt(px, py);
    if (world) this.navigate(world);
  }

  private worldAt(px: number, py: number): Point | null {
    const windowRect = this.worldWindow();
    if (!windowRect) return null;
    const wx = windowRect.x + (px / this.W) * windowRect.width;
    const wy = windowRect.y + (py / this.H) * windowRect.height;
    return { x: wx, y: wy };
  }

  /** Fixed world window fit around all content (plus margin). */
  private worldWindow(): { x: number; y: number; width: number; height: number } | null {
    const objects = this.project().filter((o) => o.type !== "connection");
    const rects = objects.map((o) => ({ x: o.x, y: o.y, width: o.width, height: o.height }));
    const u = unionRect(rects);
    if (!u) return null;
    return {
      x: u.x - this.MARGIN,
      y: u.y - this.MARGIN,
      width: u.width + this.MARGIN * 2,
      height: u.height + this.MARGIN * 2,
    };
  }

  private render(): void {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.W, this.H);
    ctx.fillStyle = "#1a1d22";
    ctx.beginPath();
    ctx.roundRect(0, 0, this.W, this.H, 8);
    ctx.fill();

    const windowRect = this.worldWindow();
    const vpState = this.viewport();
    // World rect currently visible in the main viewport.
    const vpWorld = {
      x: vpState.x,
      y: vpState.y,
      width: this.canvas.parentElement ? this.canvas.parentElement.clientWidth / vpState.zoom : 800 / vpState.zoom,
      height: this.canvas.parentElement ? this.canvas.parentElement.clientHeight / vpState.zoom : 600 / vpState.zoom,
    };

    const toPx = (rx: number, ry: number, rw: number, rh: number) => ({
      x: windowRect ? ((rx - windowRect.x) / windowRect.width) * this.W : 0,
      y: windowRect ? ((ry - windowRect.y) / windowRect.height) * this.H : 0,
      w: (rw / (windowRect ? windowRect.width : 1)) * this.W,
      h: (rh / (windowRect ? windowRect.height : 1)) * this.H,
    });

    if (windowRect) {
      // Content rects.
      for (const o of this.project()) {
        if (o.type === "connection") continue;
        const r = toPx(o.x, o.y, o.width, o.height);
        ctx.fillStyle = o.type === "frame" ? "rgba(42,109,245,0.35)" : "rgba(120,180,250,0.55)";
        ctx.fillRect(r.x, r.y, Math.max(1, r.w), Math.max(1, r.h));
      }
      // Viewport indicator.
      const v = toPx(vpWorld.x, vpWorld.y, vpWorld.width, vpWorld.height);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(v.x, v.y, v.w, v.h);
      ctx.fillStyle = "rgba(255,255,255,0.06)";
      ctx.fillRect(v.x, v.y, v.w, v.h);
    } else {
      ctx.fillStyle = "rgba(255,255,255,0.3)";
      ctx.font = "11px 'Segoe UI', system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Empty", this.W / 2, this.H / 2);
    }
  }
}