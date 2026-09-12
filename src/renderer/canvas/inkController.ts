/**
 * InkController — the runtime layer that treats freehand strokes as first-class
 * ink instead of generic canvas objects.
 *
 * On disk strokes remain `type:"pen"` entries in `objects[]` (file/SSON/export/
 * plugin compatibility), but while a document is open this controller owns
 * their specialized behaviour: stroke capture + smoothing, true partial
 * erasing, a dedicated ink selection set (no generic handles, no object
 * counting), lasso selection and ink restyle/move.
 *
 * The controller is deliberately separate from the render loop: it owns ink
 * *state* and *geometry*, and lets the engine route rendering + pointer capture
 * through it (`renderDraft`, `renderInkSelection`, `renderLasso`,
 * `renderEraserGuide`).
 */
import type { ViewportFrame, Point, Rect } from "../../shared/geometry/viewport.js";
import { screenToWorld, worldToScreen } from "../../shared/geometry/viewport.js";
import type { PenObject, WorldPoint } from "../../shared/types/object.js";
import {
  resampleStroke,
  smoothStroke,
  strokeBounds,
  translatePoints,
  eraseStroke,
  strokeIntersectsLasso,
  strokeTouchesRect,
  distPointToPolyline,
} from "../../shared/geometry/ink.js";
import type { Command } from "../command/commandManager.js";
import {
  addInkCommand,
  replaceStrokesCommand,
  compositeCommand,
  setPropsCommand,
  deleteObjectsCommand,
  type PropChange,
} from "../command/commands.js";
import type { ProjectStore } from "../project/projectStore.js";
import { strokeWorldPath } from "./objects.js";

export type PenToolMode = "pen" | "eraser" | "lasso";

/** Live pen tool settings (inspector + tablet UI + quick keys all land here). */
export interface InkSettings {
  /** Base stroke width in world units. */
  width: number;
  /** Stroke color. */
  color: string;
  /** Ink opacity (0.05..1). */
  opacity: number;
  /** Chaikin smoothing passes applied to uniform-pen strokes. */
  smoothing: 0 | 1 | 2;
  /**
   * Rubber-banding stabilizer. `off` = draw as captured; `mild`/`strong` pull
   * the live stroke toward the current tip so jitter lags out of the line.
   */
  stabilizer: "off" | "mild" | "strong";
  /** Ingest stylus pressure as per-vertex stroke width. */
  pressure: boolean;
  /** What the eraser does: split partial segments, or delete whole strokes. */
  eraserMode: "partial" | "stroke";
  /** Eraser size (diameter) in screen pixels. */
  eraserRadius: number;
}

export const DEFAULT_INK_SETTINGS: InkSettings = {
  width: 3,
  color: "#e8eaed",
  opacity: 1,
  smoothing: 1,
  stabilizer: "off",
  pressure: false,
  eraserMode: "partial",
  eraserRadius: 18,
};

export interface InkHooks {
  getFrame(): ViewportFrame;
  project: ProjectStore;
  commitCommand(cmd: Command): void;
  requestRender(): void;
}

interface DragState {
  start: Point;
  moved: boolean;
  before: { id: string; points: WorldPoint[] }[];
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function uid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return "obj_" + crypto.randomUUID();
  }
  return "obj_" + Math.random().toString(36).slice(2, 10);
}

function samePoints(a: readonly WorldPoint[], b: readonly WorldPoint[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].x !== b[i].x || a[i].y !== b[i].y) return false;
  }
  return true;
}

export class InkController {
  private baseWidth = DEFAULT_INK_SETTINGS.width;
  private color = DEFAULT_INK_SETTINGS.color;
  private opacity = DEFAULT_INK_SETTINGS.opacity;
  private smoothing = DEFAULT_INK_SETTINGS.smoothing;
  private useStabilizer = 0 as 0 | 1 | 2;
  private usePressure = DEFAULT_INK_SETTINGS.pressure;
  private eraserMode = DEFAULT_INK_SETTINGS.eraserMode;
  private eraserRadius = DEFAULT_INK_SETTINGS.eraserRadius;
  /** Active pen-tool sub-mode, mirrored from the engine so the renderer can
   *  draw the right live preview (draft stroke vs. eraser sweep). */
  private toolMode: PenToolMode = "pen";

  private raw: WorldPoint[] = [];
  private draftVersion = 0;
  private draftProcessed: WorldPoint[] | null = null;
  private draftVer = -1;

  private inkSelection: Set<string> = new Set();
  private inkPreview: Set<string> = new Set();

  private lassoActive = false;
  private lasso: Point[] = [];
  private lassoStart: Set<string> = new Set();

  private inkDrag: DragState | null = null;
  private eraserPreview: Point | null = null;

  constructor(private readonly hooks: InkHooks) {}

  /** Keep the controller in sync with the active pen-tool sub-mode. */
  setToolMode(mode: PenToolMode): void {
    this.toolMode = mode;
  }

  // -------- Settings (fully undoable via commands, except live pen style) --------

  /** The complete current tool settings backing the inspector. */
  getSettings(): InkSettings {
    return {
      width: this.baseWidth,
      color: this.color,
      opacity: this.opacity,
      smoothing: this.smoothing,
      stabilizer: this.useStabilizer === 2 ? "strong" : this.useStabilizer === 1 ? "mild" : "off",
      pressure: this.usePressure,
      eraserMode: this.eraserMode,
      eraserRadius: this.eraserRadius,
    };
  }

  setSettings(patch: Partial<InkSettings>): void {
    if (patch.width !== undefined) {
      const w = Number(patch.width);
      if (Number.isFinite(w)) this.baseWidth = Math.min(64, Math.max(0.5, w));
    }
    if (patch.color !== undefined && typeof patch.color === "string" && patch.color !== "") this.color = patch.color;
    if (patch.opacity !== undefined) {
      const o = Number(patch.opacity);
      if (Number.isFinite(o)) this.opacity = Math.min(1, Math.max(0.05, o));
    }
    if (patch.smoothing !== undefined) {
      const s = Number(patch.smoothing);
      if (s === 0 || s === 1 || s === 2) this.smoothing = s;
    }
    if (patch.stabilizer !== undefined) this.useStabilizer = patch.stabilizer === "strong" ? 2 : patch.stabilizer === "mild" ? 1 : 0;
    if (patch.pressure !== undefined) this.usePressure = patch.pressure;
    if (patch.eraserMode !== undefined) this.eraserMode = patch.eraserMode === "stroke" ? "stroke" : "partial";
    if (patch.eraserRadius !== undefined) {
      const r = Number(patch.eraserRadius);
      if (Number.isFinite(r)) this.eraserRadius = Math.min(80, Math.max(6, r));
    }
    this.draftProcessed = null;
    this.hooks.requestRender();
  }

  // -------- Stroke capture --------

  beginStroke(screen: Point, pressure?: number): void {
    this.raw = [];
    this.draftVersion++;
    this.strokeTo(screen, pressure);
  }

  strokeTo(screen: Point, pressure?: number): void {
    const w = screenToWorld(screen, this.hooks.getFrame());
    const last = this.raw[this.raw.length - 1];
    const minGrid = 0.5 / this.hooks.getFrame().zoom;
    if (last && Math.hypot(w.x - last.x, w.y - last.y) < minGrid) return;
    const usePressure = this.usePressure && pressure !== undefined && pressure > 0;
    this.raw.push(usePressure ? { x: w.x, y: w.y, width: this.pressureWidth(pressure) } : { x: w.x, y: w.y });
    this.draftVersion++;
    // CRITICAL: redraw on every move so the stroke (or eraser sweep) is visible
    // WHILE drawing — not only after the pointer is released. requestRender is
    // coalesced, so this is one canvas paint per animation frame, not per event.
    this.hooks.requestRender();
  }

  cancelStroke(): void {
    this.raw = [];
    this.draftVersion++;
    this.draftProcessed = null;
    this.hooks.requestRender();
  }

  hasDraft(): boolean {
    return this.raw.length > 1;
  }

  /** Finished processed points for the current draft (smoothed / resampled). */
  draftPoints(): WorldPoint[] {
    if (this.raw.length === 0) return [];
    if (this.draftProcessed === null || this.draftVer !== this.draftVersion) {
      this.draftProcessed = this.processStroke(this.raw);
      this.draftVer = this.draftVersion;
    }
    return this.draftProcessed;
  }

  /**
   * Finish the active draft: commit a new stroke, or (in eraser mode) apply the
   * sweep to every coincident ink stroke and commit one undoable erase.
   */
  endStroke(mode: PenToolMode): void {
    if (mode === "eraser") {
      const path: Point[] = this.raw.map((p) => ({ x: p.x, y: p.y }));
      const hadDraft = this.raw.length > 0;
      this.cancelStroke();
      if (!hadDraft) return;
      if (this.eraserMode === "stroke") {
        const ids: string[] = [];
        for (const pen of this.pens()) {
          if (this.strokeTouched(path, pen)) ids.push(pen.id);
        }
        if (ids.length > 0) {
          this.hooks.commitCommand(deleteObjectsCommand(this.hooks.project, ids));
        }
        return;
      }
      const ops: Command[] = [];
      for (const pen of this.pens()) {
        const frags = this.eraseWith(pen, path);
        if (frags.length === 0) {
          ops.push(deleteObjectsCommand(this.hooks.project, [pen.id]));
        } else if (frags.length === 1 && samePoints(frags[0], pen.points)) {
          continue; // light graze produced no visible change
        } else {
          const after = frags.map((f) => this.buildStroke(f, pen.zIndex, pen.color, pen.strokeWidth ?? 3, pen.opacity ?? 1));
          ops.push(replaceStrokesCommand(this.hooks.project, [pen], after));
        }
      }
      if (ops.length > 0) this.hooks.commitCommand(compositeCommand("Erase ink", ops));
      return;
    }

    const raw = this.raw;
    this.cancelStroke();
    const points = this.processStroke(raw);
    if (points.length < 2) return;
    const pen = this.buildStroke(points, this.hooks.project.nextZIndex(), this.color, this.baseWidth, this.opacity);
    this.hooks.commitCommand(addInkCommand(this.hooks.project, pen));
  }

  private processStroke(raw: WorldPoint[]): WorldPoint[] {
    if (raw.length < 2) return raw;
    const minDist = Math.max(0.3, 0.6 / this.hooks.getFrame().zoom);
    const hadWidth = raw.some((p) => p.width !== undefined);
    const resampled = resampleStroke(raw, minDist);
    // Pressure strokes carry their width per vertex and are rendered as-is
    // (smoothing would blur their character); uniform strokes get Chaikin.
    if (hadWidth) return resampled;
    return smoothStroke(resampled, this.collectSmoothing());
  }

  private collectSmoothing(): number {
    // Stabilizer maps to extra smoothing passes on top of the base setting:
    // off keeps the chosen value, mild/strong raise it to at least 1 / 2.
    if (this.useStabilizer === 2) return Math.max(this.smoothing, 2);
    if (this.useStabilizer === 1) return Math.max(this.smoothing, 1);
    return this.smoothing;
  }

  private pressureWidth(pressure: number): number {
    const p = clamp01(pressure);
    // 0.35x..1.2x of the base width gives a natural light/dark pen taper.
    return this.baseWidth * (0.35 + 0.85 * p);
  }

  private buildStroke(
    points: WorldPoint[],
    zIndex: number,
    color: string,
    width: number,
    opacity: number
  ): PenObject {
    const b = strokeBounds(points);
    return {
      type: "pen",
      id: uid(),
      points,
      color,
      strokeWidth: width,
      ...(opacity !== undefined && opacity < 1 ? { opacity } : {}),
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      rotation: 0,
      zIndex,
      locked: false,
      metadata: {},
    };
  }

  // -------- Eraser geometry --------

  private eraseWith(pen: PenObject, path: Point[]): WorldPoint[][] {
    const zoom = this.hooks.getFrame().zoom;
    const radius = this.eraserRadius / zoom + (pen.strokeWidth || 3) / 2;
    return eraseStroke(pen.points, path, radius);
  }

  private strokeTouched(path: Point[], pen: PenObject): boolean {
    const zoom = this.hooks.getFrame().zoom;
    const radius = this.eraserRadius / zoom + (pen.strokeWidth || 3) / 2;
    for (const p of pen.points) {
      if (distPointToPolyline(p, path, radius) <= radius) return true;
    }
    return false;
  }

  // -------- Ink selection (dedicated set, never the object selection) --------

  private pens(): PenObject[] {
    return this.hooks.project
      .getObjects()
      .filter((o): o is PenObject => o.type === "pen");
  }

  hasInkSelection(): boolean {
    return this.inkSelection.size > 0;
  }

  inkSelectedIds(): string[] {
    return [...this.inkSelection];
  }

  inkSelectedObjects(): PenObject[] {
    const out: PenObject[] = [];
    for (const id of this.inkSelection) {
      const o = this.hooks.project.getObject(id);
      if (o && o.type === "pen") out.push(o);
    }
    return out;
  }

  setInkSelection(ids: readonly string[]): void {
    this.inkSelection = new Set(ids);
  }

  clearInkSelection(): void {
    if (this.inkSelection.size === 0 && this.inkPreview.size === 0) return;
    this.inkSelection.clear();
    this.inkPreview.clear();
    this.hooks.requestRender();
  }

  selectAllInk(): void {
    const ids = this.pens().map((p) => p.id);
    this.inkSelection = new Set(ids);
    this.hooks.requestRender();
  }

  /** Route a select-tool click to ink. Returns true when ink is selected after. */
  selectInkAt(screen: Point, additive: boolean): boolean {
    const hit = this.hitInk(screen);
    if (hit) {
      if (additive) {
        if (this.inkSelection.has(hit)) this.inkSelection.delete(hit);
        else this.inkSelection.add(hit);
      } else if (!this.inkSelection.has(hit)) {
        this.inkSelection = new Set([hit]);
      }
    }
    this.hooks.requestRender();
    return this.inkSelection.size > 0;
  }

  /** Topmost stroke under the pointer (hits with slope-width/2 slack). */
  hitInk(screen: Point): string | null {
    const wp = screenToWorld(screen, this.hooks.getFrame());
    const frame = this.hooks.getFrame();
    const slack = Math.max(2 / frame.zoom, 4 / frame.zoom);
    let best: PenObject | null = null;
    for (const pen of this.pens()) {
      const radius = (pen.strokeWidth || 3) / 2 + slack;
      if (distPointToPolyline(wp, pen.points, radius) <= radius) {
        if (!best || pen.zIndex >= best.zIndex) best = pen;
      }
    }
    return best ? best.id : null;
  }

  selectInkByRect(rect: Rect, additive: boolean): void {
    const next = additive ? new Set(this.inkSelection) : new Set<string>();
    for (const pen of this.pens()) {
      if (strokeTouchesRect(pen.points, rect)) next.add(pen.id);
    }
    this.inkSelection = next;
    this.hooks.requestRender();
  }

  // -------- Lasso --------

  beginLasso(screen: Point, additive: boolean): void {
    this.lassoStart = new Set(additive ? this.inkSelection : []);
    this.inkPreview = new Set(this.lassoStart);
    if (!additive) this.inkSelection.clear();
    this.lassoActive = true;
    this.lasso = [screenToWorld(screen, this.hooks.getFrame())];
    this.hooks.requestRender();
  }

  lassoTo(screen: Point): void {
    if (!this.lassoActive) return;
    const w = screenToWorld(screen, this.hooks.getFrame());
    const last = this.lasso[this.lasso.length - 1];
    if (last && Math.hypot(w.x - last.x, w.y - last.y) < 1.5 / this.hooks.getFrame().zoom) return;
    this.lasso.push(w);
    this.updateLassoPreview();
    this.hooks.requestRender();
  }

  private updateLassoPreview(): void {
    const next = new Set(this.lassoStart);
    if (this.lasso.length >= 2) {
      const zoom = this.hooks.getFrame().zoom;
      for (const pen of this.pens()) {
        if (strokeIntersectsLasso(pen.points, this.lasso, (pen.strokeWidth || 3) / 2 + 2 / zoom)) {
          next.add(pen.id);
        }
      }
    }
    this.inkPreview = next;
  }

  endLasso(): void {
    if (!this.lassoActive) return;
    this.lassoActive = false;
    this.lasso = [];
    this.inkSelection = this.inkPreview;
    this.inkPreview = new Set();
    this.hooks.requestRender();
  }

  cancelLasso(): void {
    if (!this.lassoActive) return;
    this.lassoActive = false;
    this.lasso = [];
    this.inkPreview = new Set();
    this.inkSelection = this.lassoStart;
    this.hooks.requestRender();
  }

  // -------- Ink drag (move) --------

  prepareInkDrag(screen: Point): void {
    const before: DragState["before"] = [];
    for (const id of this.inkSelection) {
      const o = this.hooks.project.getObject(id);
      if (o && o.type === "pen") before.push({ id, points: o.points.map((p) => ({ ...p })) });
    }
    this.inkDrag = { start: screenToWorld(screen, this.hooks.getFrame()), moved: false, before };
  }

  inkDragTo(screen: Point): void {
    const drag = this.inkDrag;
    if (!drag) return;
    const w = screenToWorld(screen, this.hooks.getFrame());
    const dx = w.x - drag.start.x;
    const dy = w.y - drag.start.y;
    if (dx !== 0 || dy !== 0) drag.moved = true;
    for (const b of drag.before) {
      const o = this.hooks.project.getObject(b.id);
      if (!o) continue;
      const moved = translatePoints(b.points, dx, dy);
      const nb = strokeBounds(moved);
      this.hooks.project.setObjectProp(b.id, "points", moved);
      this.hooks.project.setObjectProp(b.id, "x", nb.x);
      this.hooks.project.setObjectProp(b.id, "y", nb.y);
      if (nb.width !== o.width) this.hooks.project.setObjectProp(b.id, "width", nb.width);
      if (nb.height !== o.height) this.hooks.project.setObjectProp(b.id, "height", nb.height);
    }
  }

  endInkDrag(): void {
    const drag = this.inkDrag;
    this.inkDrag = null;
    if (!drag || !drag.moved) return;
    const changes: PropChange[] = [];
    for (const b of drag.before) {
      const o = this.hooks.project.getObject(b.id);
      if (!o || o.type !== "pen") continue;
      changes.push({ id: b.id, key: "points", before: b.points, after: o.points });
      changes.push({ id: b.id, key: "x", before: strokeBounds(b.points).x, after: o.x });
      changes.push({ id: b.id, key: "y", before: strokeBounds(b.points).y, after: o.y });
    }
    if (changes.length > 0) this.hooks.commitCommand(setPropsCommand(this.hooks.project, changes));
  }

  // -------- Restyle (color / width / opacity over the ink selection) --------

  setInkStyle(style: { color?: string; width?: number; opacity?: number }): void {
    const changes: PropChange[] = [];
    for (const pen of this.inkSelectedObjects()) {
      if (style.color !== undefined && style.color !== pen.color) {
        changes.push({ id: pen.id, key: "color", before: pen.color, after: style.color });
      }
      if (style.opacity !== undefined && Math.abs((pen.opacity ?? 1) - style.opacity) > 0.001) {
        changes.push({ id: pen.id, key: "opacity", before: pen.opacity ?? 1, after: style.opacity });
      }
      if (style.width !== undefined && style.width !== pen.strokeWidth) {
        const ratio = style.width / pen.strokeWidth;
        changes.push({ id: pen.id, key: "strokeWidth", before: pen.strokeWidth, after: style.width });
        if (pen.points.some((p) => p.width !== undefined)) {
          changes.push({
            id: pen.id,
            key: "points",
            before: pen.points.map((p) => ({ ...p })),
            after: pen.points.map((p) => (p.width === undefined ? { ...p } : { ...p, width: p.width * ratio })),
          });
        }
      }
    }
    if (changes.length > 0) {
      this.hooks.commitCommand(setPropsCommand(this.hooks.project, changes));
      this.hooks.requestRender();
    }
  }

  // -------- Eraser guide (hover circle) --------

  setEraserPreview(screen: Point | null): void {
    this.eraserPreview = screen;
    this.hooks.requestRender();
  }

  // -------- Rendering --------

  /**
   * True while an eraser sweep is in progress (mode + at least two captured
   * moves). The engine uses this to skip drawing the committed pen objects so
   * the live eraser preview below is the only ink on screen — otherwise the
   * original strokes would stay visible through the erased gaps.
   */
  eraserDraftActive(): boolean {
    return this.toolMode === "eraser" && this.raw.length >= 2;
  }

  renderDraft(ctx: CanvasRenderingContext2D, frame: ViewportFrame): void {
    // Eraser sweep: paint the post-erase ink live (see renderEraserLive).
    if (this.eraserDraftActive()) {
      this.renderEraserLive(ctx, frame);
      return;
    }
    const pts = this.draftPoints();
    if (pts.length < 2) return;
    ctx.save();
    ctx.strokeStyle = this.color;
    ctx.globalAlpha = this.opacity;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    strokeWorldPath(ctx, pts, frame, Math.max(1, this.baseWidth * frame.zoom));
    ctx.restore();
  }

  /**
   * Live eraser preview: every pen object drawn as it will look once the sweep
   * is committed — strokes the sweep touched are shown split into their
   * surviving fragments (or hidden entirely for whole-stroke mode / full
   * passes). Purely visual; the commit in endStroke() applies the real edit.
   */
  private renderEraserLive(ctx: CanvasRenderingContext2D, frame: ViewportFrame): void {
    const path = this.raw.map((p) => ({ x: p.x, y: p.y }));
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const pen of this.pens()) {
      const alpha = pen.opacity ?? 1;
      const width = Math.max(1, (pen.strokeWidth || 3) * frame.zoom);
      if (this.eraserMode === "stroke") {
        if (this.strokeTouched(path, pen)) continue; // whole stroke erased
        ctx.strokeStyle = pen.color;
        ctx.globalAlpha = alpha;
        strokeWorldPath(ctx, pen.points, frame, width);
        continue;
      }
      for (const frag of this.eraseWith(pen, path)) {
        ctx.strokeStyle = pen.color;
        ctx.globalAlpha = alpha;
        strokeWorldPath(ctx, frag, frame, width);
      }
    }
    ctx.restore();
    // Guide circle riding the sweep tip so the user sees where the eraser is.
    const tip = worldToScreen({ x: this.raw[this.raw.length - 1].x, y: this.raw[this.raw.length - 1].y }, frame);
    this.renderGuideCircle(ctx, tip, "rgba(232,234,237,0.55)");
    this.renderGuideCircle(ctx, tip, "rgba(232,234,237,0.8)");
  }

  private renderGuideCircle(ctx: CanvasRenderingContext2D, tip: Point, color: string): void {
    ctx.save();
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, this.eraserRadius / 2, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  renderInkSelection(ctx: CanvasRenderingContext2D, frame: ViewportFrame): void {
    const ids = new Set([...this.inkSelection, ...this.inkPreview]);
    if (ids.size === 0) return;
    let any = false;
    for (const id of ids) {
      const o = this.hooks.project.getObject(id);
      if (!o || o.type !== "pen") continue;
      const b = strokeBounds(o.points);
      const tl = worldToScreen(b, frame);
      const w = b.width * frame.zoom;
      const h = b.height * frame.zoom;
      const pad = 3;
      const x = tl.x - pad;
      const y = tl.y - pad;
      const rw = w + pad * 2;
      const rh = h + pad * 2;
      if (!any) {
        ctx.save();
        any = true;
      }
      ctx.beginPath();
      ctx.rect(x, y, rw, rh);
      ctx.fillStyle = "rgba(91,124,250,0.12)";
      ctx.fill();
      ctx.strokeStyle = "#5b7cfa";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    if (any) ctx.restore();
  }

  renderLasso(ctx: CanvasRenderingContext2D, frame: ViewportFrame): void {
    if (!this.lassoActive || this.lasso.length < 2) return;
    const pts = this.lasso.map((p) => worldToScreen(p, frame));
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = "rgba(91,124,250,0.14)";
    ctx.fill();
    ctx.strokeStyle = "#5b7cfa";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  renderEraserGuide(ctx: CanvasRenderingContext2D): void {
    if (!this.eraserPreview) return;
    ctx.save();
    ctx.beginPath();
    ctx.arc(this.eraserPreview.x, this.eraserPreview.y, this.eraserRadius / 2, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(232,234,237,0.55)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(this.eraserPreview.x, this.eraserPreview.y, 1.5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(232,234,237,0.7)";
    ctx.fill();
    ctx.restore();
  }
}