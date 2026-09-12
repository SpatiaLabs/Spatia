import type { ViewportFrame, Point, Rect } from "../../shared/geometry/viewport.js";
import {
  createFrame,
  screenToWorld,
  worldToScreen,
  anchoredZoom,
  panByScreenDelta,
} from "../../shared/geometry/viewport.js";
import type { CanvasObject, ObjectKind, ShapeKind, FrameShape, ChartKind, PenObject } from "../../shared/types/object.js";
import { createTableData, createComparisonTableData, createChartTableData } from "../../shared/data/table.js";
import type { ViewportStore } from "../state/viewportStore.js";
import type { ProjectStore } from "../project/projectStore.js";
import type { SelectionStore } from "../state/selectionStore.js";
import type { Command } from "../command/commandManager.js";
import {
  addObjectCommand,
  deleteObjectsCommand,
  moveObjectsCommand,
  resizeObjectsCommand,
  rotateObjectsCommand,
} from "../command/commands.js";
import { drawGrid } from "./grid.js";
import { drawObjects, screenPointInObj, type ObjectDrawContext } from "./objects.js";
import { CanvasInput } from "./input.js";
import { ImageCache } from "./imageCache.js";
import { InkController, type InkSettings, type PenToolMode } from "./inkController.js";
import { resizeRect, rotateKnobWorld, type Handle } from "../../shared/geometry/selection.js";
import { SpatialGrid } from "../../shared/geometry/spatialIndex.js";
import type { InteractionHost } from "./interactionHost.js";
import { connectionEndpoints, connectionHit, expandMembers, unionRect, snapMove, snapResize, edgeAnchor, pointToSegment, type SnapGuide } from "../../shared/geometry/workspace.js";
import { SHAPE_DEFAULTS, pointInShape } from "../../shared/geometry/shapes.js";

const DEFAULT_SIZES: Record<"test-object" | "text" | "note" | "table" | "chart", { width: number; height: number }> = {
  "test-object": { width: 160, height: 160 },
  text: { width: 200, height: 120 },
  note: { width: 180, height: 140 },
  table: { width: 320, height: 220 },
  chart: { width: 360, height: 260 },
};

const IMAGE_DEFAULT = { width: 240, height: 180 };
const FILE_DEFAULT = { width: 160, height: 120 };
const TABLE_DEFAULT = { width: 320, height: 220 };
const COMPARISON_DEFAULT = { width: 400, height: 240 };
const CHART_DEFAULT = { width: 360, height: 260 };

/** World-space snap distance, scaled so snapping feels consistent at any zoom. */
const SNAP_PX = 6;

/** Browser frames keep a usable minimum so the embedded page never collapses. */
const FRAME_MIN_WIDTH = 200;
const FRAME_MIN_HEIGHT = 150;

/** Handles a single move/resize gesture's before/after snapshots. */
interface GrabState {
  before: { id: string; x: number; y: number }[];
  offsets: Map<string, { x: number; y: number }>;
  moved: boolean;
  /** Snap targets (all non-moving, non-decorative AABBs) captured once per gesture. */
  others: Rect[];
}

interface ResizeState {
  handle: Handle;
  beforeBounds: Rect;
  startWorld: Point;
  beforeRects: { id: string; x: number; y: number; width: number; height: number }[];
  /** Snap targets (all non-selected, non-decorative AABBs) captured once per gesture. */
  others: Rect[];
}

interface RotateState {
  before: { id: string; rotation: number }[];
  /** Selection-box center in world space (the angular reference point). */
  center: Point;
  /** Pointer angle when the knob drag began. */
  refAngle: number;
}

/**
 * Owns the HTML canvas and drives a (coalesced) render loop. Implements the
 * interaction host contract so select/move/resize/pan/zoom translate into state
 * changes on the viewport / project / selection stores. Moves and resizes are
 * absolute (position derived from the current pointer world point + grab
 * offset), which keeps the selection glued to the cursor at any zoom.
 */
export class CanvasEngine implements InteractionHost {
  private frame: ViewportFrame = { cameraX: 0, cameraY: 0, zoom: 1, originWidth: 0, originHeight: 0 };
  private dpr = 1;
  private width = 0;
  private height = 0;
  private renderQueued = false;
  private resizeObserver: ResizeObserver;
  private images = new ImageCache();
  private spatial = new SpatialGrid();
  private unsubscribers: Array<() => void> = [];

  private grab: GrabState | null = null;
  private resizeState: ResizeState | null = null;
  private rotateState: RotateState | null = null;
  private marqueeRect: Rect | null = null;
  private guides: SnapGuide[] = [];
  private draftConn: { from: string; end: Point; valid: boolean } | null = null;
  private ink: InkController;
  private penActive = false;
  private penToolMode: PenToolMode = "pen";
  private lastPenActivity = 0;
  /** Touch hosts get larger selection handles + a rotation knob; desktop is unchanged. */
  private coarse = false;
  /** Object ids allowed while a group or frame is isolated; null means full workspace. */
  private isolationIds: ReadonlySet<string> | null = null;

  /** Set by the App to route undoable commands into the history stack. */
  private input: CanvasInput;

  /** Set by the App to route undoable commands into the history stack. */
  private history: (cmd: Command) => void = () => undefined;

  constructor(
    private canvasEl: HTMLCanvasElement,
    private viewport: ViewportStore,
    private project: ProjectStore,
    private selection: SelectionStore
  ) {
    this.input = new CanvasInput(this);
    this.ink = new InkController({
      getFrame: () => this.frame,
      project: this.project,
      commitCommand: (cmd) => this.commitCommand(cmd),
      requestRender: () => this.requestRender(),
    });
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.onWindowResize = this.onWindowResize.bind(this);
  }

  attach(): void {
    this.input.attach();
    const resizeTarget = this.canvasEl.parentElement ?? this.canvasEl;
    this.resizeObserver.observe(resizeTarget);
    window.addEventListener("resize", this.onWindowResize);
    this.handleResize();
    this.unsubscribers.push(
      this.viewport.changed.subscribe((vp) => {
        this.syncFromViewport(vp);
        this.requestRender();
      })
    );
    this.unsubscribers.push(
      this.project.changed.subscribe(() => {
        this.refreshIndex();
        this.requestRender();
      })
    );
    this.unsubscribers.push(
      this.selection.changed.subscribe(() => {
        this.requestRender();
      })
    );
    this.requestRender();
  }

  dispose(): void {
    this.input.dispose();
    this.resizeObserver.disconnect();
    window.removeEventListener("resize", this.onWindowResize);
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }

  private onWindowResize(): void {
    this.handleResize();
  }

  setHistory(history: (cmd: Command) => void): void {
    this.history = history;
  }

  // -------- InteractionHost --------

  canvas(): HTMLCanvasElement {
    return this.canvasEl;
  }

  getFrame(): ViewportFrame {
    return this.frame;
  }

  selectedIds(): readonly string[] {
    return this.selection.get();
  }

  inSelection(id: string): boolean {
    return this.selection.has(id);
  }

  setSelection(ids: readonly string[]): void {
    this.selection.setIds(ids);
  }

  toggleSelection(id: string): void {
    this.selection.toggle(id);
  }

  selectionWorldBounds(): Rect | null {
    const ids = this.selection.get();
    if (ids.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const id of ids) {
      const o = this.project.getObject(id);
      if (!o || o.type === "connection" || o.type === "pen") continue;
      minX = Math.min(minX, o.x);
      minY = Math.min(minY, o.y);
      maxX = Math.max(maxX, o.x + o.width);
      maxY = Math.max(maxY, o.y + o.height);
    }
    if (!Number.isFinite(minX)) return null;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  hitTest(screen: Point): string | null {
    // Resolve the world point's grid cell to a small candidate set rather than
    // scanning and sorting every object on the canvas.
    const wp = screenToWorld(screen, this.frame);
    const candidates = this.spatial.queryPoint(wp)
      .map((id) => this.project.getObject(id))
      .filter((o): o is CanvasObject => o !== undefined && this.isObjectVisible(o.id));
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.zIndex - a.zIndex);
    for (const obj of candidates) {
      if (obj.type === "connection") {
        const fromObj = this.project.getObject(obj.from);
        const toObj = this.project.getObject(obj.to);
        const { start, end } = connectionEndpoints(obj, fromObj, toObj);
        const hitRadius = 12 / this.frame.zoom;
        if (connectionHit(wp, start, end, hitRadius)) return obj.id;
        continue;
      }
      if (obj.type === "group") {
        const members = obj.memberIds
          .map((id) => this.project.getObject(id))
          .filter((o): o is CanvasObject => o !== undefined && o.type !== "group");
        const memberRects = members.map((m) => ({ x: m.x, y: m.y, width: m.width, height: m.height }));
        const bounds = unionRect(memberRects) ?? { x: obj.x, y: obj.y, width: obj.width || 120, height: obj.height || 90 };
        if (wp.x >= bounds.x && wp.x <= bounds.x + bounds.width && wp.y >= bounds.y && wp.y <= bounds.y + bounds.height) return obj.id;
        continue;
      }
      if (obj.type === "pen") {
        const pen = obj as Extract<CanvasObject, { type: "pen" }>;
        if (pen.points.length === 0) continue;
        const hitRadius = (pen.strokeWidth / 2 + 4) / this.frame.zoom;
        for (let i = 1; i < pen.points.length; i++) {
          if (pointToSegment(wp, pen.points[i - 1], pen.points[i]) <= hitRadius) return obj.id;
        }
        if (pen.points.length === 1 && Math.hypot(wp.x - pen.points[0].x, wp.y - pen.points[0].y) <= hitRadius) {
          return obj.id;
        }
        continue;
      }
      if (obj.type === "shape") {
        const shape = obj as Extract<CanvasObject, { type: "shape" }>;
        if (pointInShape(shape.kind, aabb(shape), shape.rotation, wp)) return obj.id;
        continue;
      }
      if (screenPointInObj(screen, obj, this.frame)) return obj.id;
    }
    return null;
  }

  hitHandle(screen: Point): Handle | null {
    const bounds = this.selectionWorldBounds();
    if (!bounds) return null;
    const handles: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
    const hitRadius = this.coarse ? Math.max(14, 6 / this.frame.zoom) : Math.max(8, 4 / this.frame.zoom);
    for (const h of handles) {
      const hw = handleWorldRect(bounds, h);
      const p = worldToScreen(hw, this.frame);
      if (Math.abs(screen.x - p.x) <= hitRadius && Math.abs(screen.y - p.y) <= hitRadius) {
        return h;
      }
    }
    return null;
  }

  /** Whether the rotation knob (touch hosts only) is under the pointer. */
  hitRotateHandle(screen: Point): boolean {
    if (!this.coarse) return false;
    const bounds = this.selectionWorldBounds();
    if (!bounds) return false;
    const knob = rotateKnobWorld(bounds, this.frame.zoom);
    const p = worldToScreen(knob, this.frame);
    return Math.abs(screen.x - p.x) <= 28 && Math.abs(screen.y - p.y) <= 28;
  }

  // Connection gesture (Ctrl + drag)
  beginConnection(fromId: string, screen: Point): void {
    const fromObj = this.project.getObject(fromId);
    if (!fromObj || fromObj.type === "connection") {
      this.draftConn = null;
      return;
    }
    this.draftConn = { from: fromId, end: screenToWorld(screen, this.frame), valid: false };
    this.updateDraftValidity(screen);
    this.requestRender();
  }

  connectionDragTo(screen: Point): void {
    if (!this.draftConn) return;
    this.draftConn.end = screenToWorld(screen, this.frame);
    this.updateDraftValidity(screen);
    this.requestRender();
  }

  private updateDraftValidity(screen: Point): void {
    if (!this.draftConn) return;
    const target = this.hitTest(screen);
    const valid =
      !!this.project.getObject(this.draftConn.from) &&
      !!target &&
      target !== this.draftConn.from &&
      this.project.getObject(target)?.type !== "connection";
    this.draftConn.valid = valid;
  }

  finishConnection(screen: Point): string | null {
    if (!this.draftConn) return null;
    const fromId = this.draftConn.from;
    this.draftConn = null;
    this.requestRender();
    const fromObj = this.project.getObject(fromId);
    if (!fromObj) return null;
    const target = this.hitTest(screen);
    // Releasing over the source is a self-connection -> cancel.
    if (target === fromId) return null;
    // Valid object target (not another connection) -> create A -> B.
    const toObj = target ? this.project.getObject(target) : undefined;
    if (target && toObj && toObj.type !== "connection") {
      return this.createConnection(fromId, target);
    }
    // Otherwise (empty space, or a connection which cannot be a target) keep a
    // free endpoint at the current world position instead of cancelling.
    return this.createFreeConnection(fromId, screenToWorld(screen, this.frame));
  }

  /** Drop an in-progress connection draft without creating anything. */
  cancelConnectionDraft(): void {
    if (this.draftConn) {
      this.draftConn = null;
      this.requestRender();
    }
  }

  // Pen tool (freehand drawing) — a completely separate tool from connections.

  isPenTool(): boolean {
    return this.penActive;
  }

  setPenTool(on: boolean): void {
    if (this.penActive === on) return;
    this.penActive = on;
    this.setInteractionCursor("default");
    if (!on) {
      this.ink.cancelStroke();
      this.ink.cancelLasso();
      this.ink.setEraserPreview(null);
    }
  }

  /** Toggle touch-sized selection handles + the rotation knob. */
  setCoarseHandles(on: boolean): void {
    if (this.coarse === on) return;
    this.coarse = on;
    this.requestRender();
  }

  isCoarseHandles(): boolean {
    return this.coarse;
  }

  /** Current pen style (stroke color + base width in world units). */
  getPenStyle(): { color: string; size: number } {
    const s = this.ink.getSettings();
    return { color: s.color, size: s.width };
  }

  setPenStyle(style: { color?: string; size?: number }): void {
    this.ink.setSettings({ color: style.color, width: style.size });
  }

  /** Full live pen settings for the tool inspector. */
  getPenSettings(): InkSettings {
    return this.ink.getSettings();
  }

  setPenSettings(patch: Partial<InkSettings>): void {
    this.ink.setSettings(patch);
  }

  /** Whether the pen tool is currently in eraser mode (legacy tablet UI). */
  isPenEraser(): boolean {
    return this.penToolMode === "eraser";
  }

  /** Put the pen into eraser mode (strokes draw/erase instead of draw ink). */
  setPenEraser(on: boolean): void {
    this.setPenToolMode(on ? "eraser" : "pen");
  }

  /** Active pen-tool mode: pen / eraser / lasso. */
  getPenToolMode(): PenToolMode {
    return this.penToolMode;
  }

  setPenToolMode(mode: PenToolMode): void {
    if (this.penToolMode === mode) {
      this.requestRender();
      return;
    }
    const prev = this.penToolMode;
    this.penToolMode = mode;
    this.ink.setToolMode(mode);
    if (prev === "lasso" && mode !== "lasso") this.ink.cancelLasso();
    this.ink.cancelStroke();
    if (mode !== "eraser") this.ink.setEraserPreview(null);
    this.requestRender();
  }

  startPenStroke(screen: Point, pressure?: number): void {
    if (this.penToolMode === "eraser") this.ink.setEraserPreview(null);
    this.ink.beginStroke(screen, pressure);
  }

  penStrokeTo(screen: Point, pressure?: number): void {
    this.ink.strokeTo(screen, pressure);
  }

  endPenStroke(): void {
    this.ink.endStroke(this.penToolMode);
    this.ink.setEraserPreview(null);
  }

  /** Topmost stroke under the pointer (select-tool ink clicks). */
  hitInk(screen: Point): string | null {
    return this.ink.hitInk(screen);
  }

  // -------- Ink selection / drag / lasso (first-class strokes) --------

  isInkId(id: string): boolean {
    const o = this.project.getObject(id);
    return o !== undefined && o.type === "pen";
  }

  selectInkAt(screen: Point, additive: boolean): boolean {
    return this.ink.selectInkAt(screen, additive);
  }

  clearInkSelection(): void {
    this.ink.clearInkSelection();
  }

  hasInkSelection(): boolean {
    return this.ink.hasInkSelection();
  }

  setInkSelection(ids: readonly string[]): void {
    this.ink.setInkSelection(ids);
  }

  selectAllInk(): void {
    this.ink.selectAllInk();
  }

  setInkStyle(style: { color?: string; width?: number; opacity?: number }): void {
    this.ink.setInkStyle(style);
  }

  getInkSelectedObjects(): PenObject[] {
    return this.ink.inkSelectedObjects();
  }

  prepareInkDrag(screen: Point): void {
    this.ink.prepareInkDrag(screen);
  }

  inkDragTo(screen: Point): void {
    this.ink.inkDragTo(screen);
  }

  endInkDrag(): void {
    this.ink.endInkDrag();
  }

  beginLasso(screen: Point, additive: boolean): void {
    this.ink.beginLasso(screen, additive);
  }

  lassoTo(screen: Point): void {
    this.ink.lassoTo(screen);
  }

  endLasso(): void {
    this.ink.endLasso();
  }

  cancelLasso(): void {
    this.ink.cancelLasso();
  }

  setEraserPreview(screen: Point | null): void {
    this.ink.setEraserPreview(screen);
  }

  notePenActivity(): void {
    this.lastPenActivity = performance.now();
  }

  recentPenActivity(): boolean {
    return performance.now() - this.lastPenActivity < 700;
  }

  /** Create a free-endpoint connection from `fromId` ending at `end` (world). */
  createFreeConnection(fromId: string, end: Point): string | null {
    const fromObj = this.project.getObject(fromId);
    if (!fromObj || fromObj.type === "connection") return null;
    const start = edgeAnchor(aabb(fromObj), end);
    const minX = Math.min(start.x, end.x) - 4;
    const minY = Math.min(start.y, end.y) - 4;
    const maxX = Math.max(start.x, end.x) + 4;
    const maxY = Math.max(start.y, end.y) + 4;
    const obj: CanvasObject = {
      type: "connection",
      id: createObjectId(),
      from: fromId,
      to: "",
      endX: end.x,
      endY: end.y,
      arrowhead: true,
      color: "#91a3f0",
      strokeWidth: 2,
      edgeFrom: "auto",
      edgeTo: "auto",
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
      rotation: 0,
      zIndex: this.project.nextZIndex(),
      locked: false,
      metadata: {},
    };
    this.commitCommand(addObjectCommand(this.project, obj));
    return obj.id;
  }

  // Move gesture (absolute)
  grabSelection(screen: Point): void {
    const world = screenToWorld(screen, this.frame);
    const expanded = expandMembers(this.selection.get(), this.project.getObjects(), (o) => o.type === "group");
    const before: { id: string; x: number; y: number }[] = [];
    const offsets = new Map<string, { x: number; y: number }>();
    for (const o of this.project.getObjects()) {
      if (expanded.has(o.id) && !o.locked && o.type !== "connection" && o.type !== "pen") {
        before.push({ id: o.id, x: o.x, y: o.y });
        offsets.set(o.id, { x: o.x - world.x, y: o.y - world.y });
      }
    }
    this.grab = { before, offsets, moved: false, others: buildOthers(this.project, expanded) };
  }

  dragTo(screen: Point): void {
    if (!this.grab) return;
    const world = screenToWorld(screen, this.frame);
    const positions: { id: string; x: number; y: number }[] = [];
    const sizes = new Map<string, { w: number; h: number }>();
    for (const b of this.grab.before) {
      const off = this.grab.offsets.get(b.id);
      if (!off) continue;
      positions.push({ id: b.id, x: world.x + off.x, y: world.y + off.y });
      if (b.x !== world.x + off.x || b.y !== world.y + off.y) this.grab.moved = true;
      const o = this.project.getObject(b.id);
      if (o) sizes.set(b.id, { w: o.width, h: o.height });
    }
    if (positions.length) {
      const movingBounds = unionRect(
        positions.map((p) => ({ x: p.x, y: p.y, width: sizes.get(p.id)?.w ?? 0, height: sizes.get(p.id)?.h ?? 0 }))
      );
      const snap = movingBounds ? snapMove(movingBounds, this.grab.others, SNAP_PX / this.frame.zoom) : { dx: 0, dy: 0, guides: [] };
      this.guides = snap.guides;
      if (snap.dx !== 0 || snap.dy !== 0) {
        for (const p of positions) {
          p.x += snap.dx;
          p.y += snap.dy;
        }
      }
      this.project.moveObjectsTo(positions);
    }
  }

  dropGrab(): void {
    if (!this.grab) return;
    const before = this.grab.before;
    const after = before
      .map((b) => {
        const o = this.project.getObject(b.id);
        return o ? { id: o.id, x: o.x, y: o.y } : null;
      })
      .filter((p): p is { id: string; x: number; y: number } => p !== null);
    if (this.grab.moved) {
      this.commitCommand(moveObjectsCommand(this.project, before, after));
    }
    this.grab = null;
    this.guides = [];
  }

  // Resize gesture (absolute, scales selection bounds)
  beginResize(handle: Handle, screen: Point): void {
    const bounds = this.selectionWorldBounds();
    if (!bounds) return;
    const selectedSet = expandMembers(this.selection.get(), this.project.getObjects(), (o) => o.type === "group");
    const beforeRects: { id: string; x: number; y: number; width: number; height: number }[] = [];
    const handled = new Set<string>();
    const addRect = (o: CanvasObject): void => {
      if (handled.has(o.id) || o.locked) return;
      if (o.type === "connection" || o.type === "pen") return;
      handled.add(o.id);
      beforeRects.push({ id: o.id, x: o.x, y: o.y, width: o.width, height: o.height });
    };
    for (const o of this.project.getObjects()) {
      if (this.selection.has(o.id)) {
        addRect(o);
        if (o.type === "group" && o.memberIds.length > 0) {
          // Scale the group's members coherently with the container, keeping
          // their positions/dimensions relative to the group's original bounds.
          for (const m of o.memberIds) {
            const mo = this.project.getObject(m);
            if (mo) addRect(mo);
          }
        }
      }
    }
    if (beforeRects.length === 0) return;
    this.resizeState = {
      handle,
      beforeBounds: { ...bounds },
      startWorld: screenToWorld(screen, this.frame),
      beforeRects,
      others: buildOthers(this.project, selectedSet),
    };
  }

  resizeTo(screen: Point): void {
    if (!this.resizeState) return;
    const s = this.resizeState;
    const world = screenToWorld(screen, this.frame);
    let next = resizeRect(s.beforeBounds, s.handle, s.startWorld, world);
    const snap = snapResize(next, s.handle, s.others, SNAP_PX / this.frame.zoom);
    this.guides = snap.guides;
    if (snap.dx !== 0) {
      if (s.handle.includes("w")) next = { ...next, x: next.x + snap.dx, width: next.width - snap.dx };
      else if (s.handle.includes("e")) next = { ...next, width: next.width + snap.dx };
    }
    if (snap.dy !== 0) {
      if (s.handle.includes("n")) next = { ...next, y: next.y + snap.dy, height: next.height - snap.dy };
      else if (s.handle.includes("s")) next = { ...next, height: next.height + snap.dy };
    }
    // Browser frames keep a usable minimum so the embedded page never collapses
    // to a dot; the anchored edge stays fixed while the min is enforced.
    if (s.beforeRects.some((r) => this.project.getObject(r.id)?.type === "frame")) {
      if (next.width < FRAME_MIN_WIDTH) {
        if (s.handle.includes("w")) next = { ...next, x: next.x + next.width - FRAME_MIN_WIDTH };
        next = { ...next, width: FRAME_MIN_WIDTH };
      }
      if (next.height < FRAME_MIN_HEIGHT) {
        if (s.handle.includes("n")) next = { ...next, y: next.y + next.height - FRAME_MIN_HEIGHT };
        next = { ...next, height: FRAME_MIN_HEIGHT };
      }
    }
    const scaleX = s.beforeBounds.width > 0 ? next.width / s.beforeBounds.width : 1;
    const scaleY = s.beforeBounds.height > 0 ? next.height / s.beforeBounds.height : 1;
    const minSize = 8;
    for (const r of s.beforeRects) {
      const obj = this.project.getObject(r.id);
      const minW = obj && obj.type === "frame" ? FRAME_MIN_WIDTH : minSize;
      const minH = obj && obj.type === "frame" ? FRAME_MIN_HEIGHT : minSize;
      const nx = next.x + (r.x - s.beforeBounds.x) * scaleX;
      const ny = next.y + (r.y - s.beforeBounds.y) * scaleY;
      const nw = Math.max(minW, r.width * scaleX);
      const nh = Math.max(minH, r.height * scaleY);
      this.project.resizeObject(r.id, nx, ny, nw, nh);
    }
  }

  endResize(): void {
    if (!this.resizeState) return;
    const before = this.resizeState.beforeRects;
    const after = before
      .map((r) => {
        const o = this.project.getObject(r.id);
        return o
          ? { id: o.id, x: o.x, y: o.y, width: o.width, height: o.height }
          : null;
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);
    this.commitCommand(resizeObjectsCommand(this.project, before, after));
    this.resizeState = null;
    this.guides = [];
  }

  // Rotate gesture (touch hosts only). The knob sits above the selection box;
  // dragging it rotates every selected object about its own center by the same
  // angular delta, so relative placement is preserved and undo/redo is exact.
  beginRotate(screen: Point): void {
    const bounds = this.selectionWorldBounds();
    if (!bounds) return;
    const expanded = expandMembers(this.selection.get(), this.project.getObjects(), (o) => o.type === "group");
    const before: { id: string; rotation: number }[] = [];
    for (const o of this.project.getObjects()) {
      if (expanded.has(o.id) && !o.locked && o.type !== "connection" && o.type !== "pen") {
        before.push({ id: o.id, rotation: o.rotation });
      }
    }
    if (before.length === 0) return;
    const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const world = screenToWorld(screen, this.frame);
    this.rotateState = {
      before,
      center,
      refAngle: Math.atan2(world.y - center.y, world.x - center.x),
    };
  }

  rotateTo(screen: Point): void {
    if (!this.rotateState) return;
    const world = screenToWorld(screen, this.frame);
    const delta =
      Math.atan2(world.y - this.rotateState.center.y, world.x - this.rotateState.center.x) -
      this.rotateState.refAngle;
    for (const b of this.rotateState.before) {
      this.project.setObjectProp(b.id, "rotation", normalizeAngle(b.rotation + delta));
    }
    this.requestRender();
  }

  endRotate(): void {
    if (!this.rotateState) return;
    const before = this.rotateState.before;
    const after = before
      .map((b) => {
        const o = this.project.getObject(b.id);
        return o ? { id: o.id, rotation: o.rotation } : null;
      })
      .filter((p): p is { id: string; rotation: number } => p !== null);
    if (after.length > 0) {
      this.commitCommand(rotateObjectsCommand(this.project, before, after));
    }
    this.rotateState = null;
  }

  /** Rotate the current selection by `deg` degrees (undoable). */
  rotateSelection(deg: number): void {
    const expanded = expandMembers(this.selection.get(), this.project.getObjects(), (o) => o.type === "group");
    const before: { id: string; rotation: number }[] = [];
    for (const o of this.project.getObjects()) {
      if (expanded.has(o.id) && !o.locked && o.type !== "connection" && o.type !== "pen") {
        before.push({ id: o.id, rotation: o.rotation });
      }
    }
    if (before.length === 0) return;
    const rad = (deg * Math.PI) / 180;
    const after = before.map((b) => ({ id: b.id, rotation: normalizeAngle(b.rotation + rad) }));
    this.commitCommand(rotateObjectsCommand(this.project, before, after));
    this.requestRender();
  }

  // Viewport
  applyPan(dx: number, dy: number): void {
    this.viewport.set(panByScreenDelta(this.viewport.get(), dx, dy));
  }

  applyAnchoredZoom(factor: number, anchor: Point): void {
    this.viewport.set(anchoredZoom(this.viewport.get(), factor, anchor, this.frame));
  }

  setInteractionCursor(kind: "default" | "pan" | "grab" | "move" | "resize" | "copy"): void {
    const map: Record<string, string> = {
      pan: "grabbing",
      grab: "grab",
      move: "move",
      copy: "copy",
      resize: "default",
      default: "default",
    };
    this.canvasEl.style.cursor = map[kind] ?? "default";
  }

  // Document mutations
  createObject(kind: ObjectKind, worldCenter: Point): string | null {
    if (kind === "image" || kind === "file" || kind === "url" || kind === "connection" || kind === "group" || kind === "frame" || kind === "pen" || kind === "shape") {
      return null;
    }
    const size = DEFAULT_SIZES[kind];
    const obj: CanvasObject = {
      type: kind,
      id: createObjectId(),
      x: worldCenter.x - size.width / 2,
      y: worldCenter.y - size.height / 2,
      width: size.width,
      height: size.height,
      rotation: 0,
      zIndex: this.project.nextZIndex(),
      locked: false,
      metadata: {},
      ...(kind === "text"
        ? { text: "Text", fontSize: 24, bold: false, italic: false, align: "left" as const }
        : {}),
      ...(kind === "note" ? { title: "Note", text: "Double-click to edit", color: "#f0c33c" } : {}),
    } as CanvasObject;
    this.commitCommand(addObjectCommand(this.project, obj));
    return obj.id;
  }

  createImageObject(assetId: string, worldCenter: Point): string {
    const obj: CanvasObject = {
      type: "image",
      id: createObjectId(),
      x: worldCenter.x - IMAGE_DEFAULT.width / 2,
      y: worldCenter.y - IMAGE_DEFAULT.height / 2,
      width: IMAGE_DEFAULT.width,
      height: IMAGE_DEFAULT.height,
      rotation: 0,
      zIndex: this.project.nextZIndex(),
      locked: false,
      metadata: {},
      assetId,
    };
    this.commitCommand(addObjectCommand(this.project, obj));
    return obj.id;
  }

  createFileObject(assetId: string, worldCenter: Point): string {
    const obj: CanvasObject = {
      type: "file",
      id: createObjectId(),
      x: worldCenter.x - FILE_DEFAULT.width / 2,
      y: worldCenter.y - FILE_DEFAULT.height / 2,
      width: FILE_DEFAULT.width,
      height: FILE_DEFAULT.height,
      rotation: 0,
      zIndex: this.project.nextZIndex(),
      locked: false,
      metadata: {},
      assetId,
    };
    this.commitCommand(addObjectCommand(this.project, obj));
    return obj.id;
  }

  createUrlObject(url: string, title: string, worldCenter: Point): string {
    const w = 220;
    const h = 90;
    const obj: CanvasObject = {
      type: "url",
      id: createObjectId(),
      url,
      title: title || url,
      x: worldCenter.x - w / 2,
      y: worldCenter.y - h / 2,
      width: w,
      height: h,
      rotation: 0,
      zIndex: this.project.nextZIndex(),
      locked: false,
      metadata: {},
    };
    this.commitCommand(addObjectCommand(this.project, obj));
    return obj.id;
  }

  commitCommand(cmd: Command): void {
    this.history(cmd);
  }

  onContextMenu(screen: Point, world: Point): void {
    this.emitContextMenu?.(screen, world);
  }

  /** Set by the App to show the custom context menu. */
  emitContextMenu: ((screen: Point, world: Point) => void) | null = null;

  setMarquee(rect: Rect | null): void {
    this.marqueeRect = rect;
    this.requestRender();
  }

  onMarqueeEnd(rect: Rect, additive: boolean): void {
    const ids: string[] = [];
    for (const id of this.spatial.queryRect(rect)) {
      const o = this.project.getObject(id);
      if (!o || !this.isObjectVisible(o.id)) continue;
      if (o.type === "pen") continue;
      if (rectsIntersect(aabb(o), rect)) ids.push(o.id);
    }
    if (additive) this.selection.add(ids);
    else this.selection.setIds(ids);
    // Freehand strokes are selected through the ink selection set instead.
    this.ink.selectInkByRect(rect, additive);
  }

  /** Restrict rendering and pointer queries to an isolation scope. */
  setIsolation(ids: readonly string[] | null): void {
    this.isolationIds = ids === null ? null : new Set(ids);
    this.marqueeRect = null;
    this.requestRender();
  }

  private isObjectVisible(id: string): boolean {
    return this.isolationIds === null || this.isolationIds.has(id);
  }

  /** Whether an object participates in the current (possibly isolated) scope. */
  isObjectInScope(id: string): boolean {
    return this.isObjectVisible(id);
  }

  // -------- Actions used by the UI --------

  addObjectAt(kind: ObjectKind, centerWorld: Point): string | null {
    return this.createObject(kind, centerWorld);
  }

  addObjectAtScreenCenter(kind: ObjectKind): string | null {
    return this.createObject(kind, screenToWorld({ x: this.width / 2, y: this.height / 2 }, this.frame));
  }

  zoomBy(factor: number): void {
    this.applyAnchoredZoom(factor, { x: this.width / 2, y: this.height / 2 });
  }

  resetView(): void {
    this.viewport.reset();
  }

  getZoom(): number {
    return this.frame.zoom;
  }

  selectAll(): void {
    const ids = this.project
      .getObjects()
      .filter((o) => o.type !== "pen")
      .map((o) => o.id);
    this.setSelection(ids);
    this.ink.selectAllInk();
  }

  duplicateSelection(): void {
    const sourceObjects = this.project
      .getObjects()
      .filter((o) => this.selection.has(o.id) && o.type !== "pen");
    const sourceInk = this.ink.inkSelectedObjects();
    const source: CanvasObject[] = [...sourceObjects, ...sourceInk];
    if (source.length === 0) return;
    const dup: CanvasObject[] = source.map((o) => ({
      ...o,
      id: createObjectId(),
      x: o.x + 20,
      y: o.y + 20,
      // Freehand strokes carry a points array that must not be shared between
      // the original and the clone (a later move/restyle must stay independent).
      ...(o.type === "pen" ? { points: o.points.map((p) => ({ ...p })) } : {}),
    }));
    const self = this;
    this.commitCommand({
      label: dup.length > 1 ? `Duplicate ${dup.length} objects` : "Duplicate",
      redo() {
        for (const d of dup) self.project.addObject(d);
      },
      undo() {
        for (const d of dup) self.project.removeObjects([d.id]);
      },
    });
    this.selection.setIds(dup.filter((d) => d.type !== "pen").map((d) => d.id));
    this.ink.setInkSelection(dup.filter((d) => d.type === "pen").map((d) => d.id));
  }

  deleteSelection(): void {
    const objectIds = this.selection.get().filter((id) => !this.isInkId(id));
    const inkIds = this.ink.inkSelectedIds();
    const ids = [...objectIds, ...inkIds];
    if (ids.length === 0) return;
    this.commitCommand(deleteObjectsCommand(this.project, ids));
    this.selection.clear();
    this.ink.clearInkSelection();
    this.requestRender();
  }

  raiseSelection(): void {
    const ids = this.selection.get();
    if (ids.length === 0) return;
    const before = this.project.getObjects().map((o) => ({ id: o.id, zIndex: o.zIndex }));
    this.project.bringToFront(ids);
    const after = this.project.getObjects().map((o) => ({ id: o.id, zIndex: o.zIndex }));
    this.commitCommand(zOrderCommandRef(before, after, this.project));
  }

  lowerSelection(): void {
    const ids = this.selection.get();
    if (ids.length === 0) return;
    const before = this.project.getObjects().map((o) => ({ id: o.id, zIndex: o.zIndex }));
    this.project.sendToBack(ids);
    const after = this.project.getObjects().map((o) => ({ id: o.id, zIndex: o.zIndex }));
    this.commitCommand(zOrderCommandRef(before, after, this.project));
  }

  // -------- Phase 3 object creation --------

  createConnection(fromId: string, toId: string): string | null {
    const fromObj = this.project.getObject(fromId);
    const toObj = this.project.getObject(toId);
    if (!fromObj || !toObj) return null;
    const endpoints = connectionEndpoints({ from: fromId, to: toId, x: fromObj.x, y: fromObj.y }, fromObj, toObj);
    const minX = Math.min(endpoints.start.x, endpoints.end.x) - 4;
    const minY = Math.min(endpoints.start.y, endpoints.end.y) - 4;
    const maxX = Math.max(endpoints.start.x, endpoints.end.x) + 4;
    const maxY = Math.max(endpoints.start.y, endpoints.end.y) + 4;
    const obj: CanvasObject = {
      type: "connection",
      id: createObjectId(),
      from: fromId,
      to: toId,
      arrowhead: true,
      color: "#91a3f0",
      strokeWidth: 2,
      edgeFrom: "auto",
      edgeTo: "auto",
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
      rotation: 0,
      zIndex: this.project.nextZIndex(),
      locked: false,
      metadata: {},
    };
    this.commitCommand(addObjectCommand(this.project, obj));
    return obj.id;
  }

  groupSelection(): string | null {
    const ids = this.selection.get();
    const memberIds = ids.filter((id) => {
      const o = this.project.getObject(id);
      return o !== undefined && o.type !== "group" && o.type !== "connection";
    });
    if (memberIds.length < 2) return null;
    const rects = memberIds
      .map((id) => this.project.getObject(id))
      .filter((o): o is CanvasObject => o !== undefined)
      .map((o) => ({ x: o.x, y: o.y, width: o.width, height: o.height }));
    const bounds = unionRect(rects);
    const obj: CanvasObject = {
      type: "group",
      id: createObjectId(),
      x: bounds?.x ?? 0,
      y: bounds?.y ?? 0,
      width: bounds?.width ?? 120,
      height: bounds?.height ?? 90,
      rotation: 0,
      zIndex: this.project.nextZIndex(),
      locked: false,
      metadata: {},
      memberIds,
      name: "",
    };
    this.commitCommand(addObjectCommand(this.project, obj));
    this.selection.setIds([obj.id]);
    return obj.id;
  }

  ungroupSelection(): void {
    const ids = this.selection.get();
    for (const id of [...ids]) {
      const o = this.project.getObject(id);
      if (o && o.type === "group") {
        this.commitCommand(deleteObjectsCommand(this.project, [id]));
      }
    }
    this.selection.setIds(ids.filter((id) => this.project.getObject(id) !== undefined));
  }

  createFrame(worldCenter: Point, frameShape: FrameShape = "rectangle"): string | null {
    const obj: CanvasObject = {
      type: "frame",
      id: createObjectId(),
      x: worldCenter.x - 200,
      y: worldCenter.y - 150,
      width: 400,
      height: 300,
      rotation: 0,
      zIndex: this.project.nextZIndex(),
      locked: false,
      metadata: {},
      name: "",
      color: "#2a6df5",
      frameShape,
    };
    this.commitCommand(addObjectCommand(this.project, obj));
    return obj.id;
  }

  /** Create a data/side-by-side comparison table centered on `worldCenter`. */
  createTableObject(worldCenter: Point, comparison = false): string {
    const d = comparison ? COMPARISON_DEFAULT : TABLE_DEFAULT;
    const obj: CanvasObject = {
      type: "table",
      id: createObjectId(),
      x: worldCenter.x - d.width / 2,
      y: worldCenter.y - d.height / 2,
      width: d.width,
      height: d.height,
      rotation: 0,
      zIndex: this.project.nextZIndex(),
      locked: false,
      metadata: {},
      comparison,
      data: comparison ? createComparisonTableData() : createTableData(),
    } as CanvasObject;
    this.commitCommand(addObjectCommand(this.project, obj));
    return obj.id;
  }

  /** Create a chart of the given kind centered on `worldCenter`. */
  createChartObject(kind: ChartKind, worldCenter: Point): string {
    const obj: CanvasObject = {
      type: "chart",
      id: createObjectId(),
      x: worldCenter.x - CHART_DEFAULT.width / 2,
      y: worldCenter.y - CHART_DEFAULT.height / 2,
      width: CHART_DEFAULT.width,
      height: CHART_DEFAULT.height,
      rotation: 0,
      zIndex: this.project.nextZIndex(),
      locked: false,
      metadata: {},
      kind,
      title: "",
      data: createChartTableData(),
    } as CanvasObject;
    this.commitCommand(addObjectCommand(this.project, obj));
    return obj.id;
  }

  /** Create a diagram shape of the given kind centered on `worldCenter`. */
  addShapeObject(kind: ShapeKind, worldCenter: Point): string {
    const d = SHAPE_DEFAULTS[kind];
    const obj: CanvasObject = {
      type: "shape",
      kind,
      id: createObjectId(),
      x: worldCenter.x - d.width / 2,
      y: worldCenter.y - d.height / 2,
      width: d.width,
      height: d.height,
      rotation: 0,
      zIndex: this.project.nextZIndex(),
      locked: false,
      metadata: {},
      fill: d.fill,
      stroke: d.stroke,
      strokeWidth: d.strokeWidth,
    } as CanvasObject;
    this.commitCommand(addObjectCommand(this.project, obj));
    return obj.id;
  }

  // -------- Image loading --------

  async ensureImage(assetId: string): Promise<HTMLImageElement | null> {
    if (this.images.has(assetId)) return this.images.get(assetId);
    const dataUrl = await window.spatia.readAssetDataUrl(this.project.getMeta().id, assetId);
    if (!dataUrl) return null;
    try {
      return await this.images.load(assetId, dataUrl);
    } catch {
      return null;
    }
  }

  /** Drop a cached image so the next load reflects a relinked binary. */
  invalidateImage(assetId: string): void {
    this.images.invalidate(assetId);
  }

  async loadImagesFor(objects: readonly CanvasObject[]): Promise<void> {
    const jobs = objects
      .filter((o) => o.type === "image")
      .map((o) => (o as { assetId: string }).assetId)
      .filter((id) => !this.images.has(id));
    await Promise.all(jobs.map((id) => this.ensureImage(id).catch(() => null)));
    this.requestRender();
  }

  // -------- Rendering --------

  /**
   * Rasterize the document (optionally restricted to a set of object ids) to
   * an offscreen canvas and return its data URL. This drives PNG / JPEG / PDF
   * export while reusing the exact same drawing pipeline the interactive
   * canvas uses. `onlyIds` (when provided) limits drawing to those objects so
   * a frame or selection export renders just that scope.
   */
  async rasterizeExport(
    bounds: Rect,
    scale = 2,
    mime: "image/png" | "image/jpeg" = "image/png",
    onlyIds: ReadonlySet<string> | null = null
  ): Promise<{ dataUrl: string; width: number; height: number } | null> {
    let s = scale;
    const maxDim = Math.max(bounds.width, bounds.height);
    if (maxDim <= 0) return null;
    // Cap extremely large documents so the raster stays in the 8192px budget.
    if (bounds.width * s > 8192 || bounds.height * s > 8192) {
      s = Math.max(0.1, 8192 / maxDim);
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bounds.width * s));
    canvas.height = Math.max(1, Math.round(bounds.height * s));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#121417";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const frame: ViewportFrame = {
      cameraX: bounds.x,
      cameraY: bounds.y,
      zoom: s,
      originWidth: bounds.width,
      originHeight: bounds.height,
    };
    const drawCtx: ObjectDrawContext = {
      imageOf: (assetId) => this.images.get(assetId),
      objLabel: (assetId) => this.project.getAsset(assetId)?.name ?? "File",
      assetKindOf: (assetId) => this.project.getAsset(assetId)?.kind,
      assetExtOf: (assetId) => this.project.getAsset(assetId)?.ext,
      objectById: (id) => this.project.getObject(id),
    };
    const all = this.project.getObjectsSorted();
    const objects = onlyIds === null ? all : all.filter((o) => onlyIds.has(o.id));
    drawObjects(ctx, frame, objects, new Set(), drawCtx);
    // Wait for image assets so the raster reflects the loaded binaries, then
    // re-draw once (the first pass may still contain placeholder fills).
    const imageIds = objects
      .filter((o) => o.type === "image")
      .map((o) => (o as { assetId: string }).assetId);
    await Promise.all(imageIds.map((id) => this.ensureImage(id).catch(() => null)));
    drawObjects(ctx, frame, objects, new Set(), drawCtx);
    const dataUrl = mime === "image/jpeg" ? canvas.toDataURL("image/jpeg", 0.92) : canvas.toDataURL("image/png");
    return { dataUrl, width: canvas.width, height: canvas.height };
  }

  render(): void {
    const ctx = this.canvasEl.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = "#121417";
    ctx.fillRect(0, 0, this.width, this.height);

    drawGrid(ctx, this.frame);
    const selected = new Set(this.selection.get());
    const drawCtx: ObjectDrawContext = {
      imageOf: (assetId) => this.images.get(assetId),
      objLabel: (assetId) => this.project.getAsset(assetId)?.name ?? "File",
      assetKindOf: (assetId) => this.project.getAsset(assetId)?.kind,
      assetExtOf: (assetId) => this.project.getAsset(assetId)?.ext,
      objectById: (id) => this.project.getObject(id),
    };
    const srcObjects = this.isolationIds === null
      ? this.project.getObjectsSorted()
      : this.project.getObjectsSorted().filter((obj) => this.isObjectVisible(obj.id));
    // While an eraser sweep is live, drop the committed pens from the object
    // pass — inkController.renderDraft repaints the post-erase ink in its place.
    const objects = this.ink.eraserDraftActive()
      ? srcObjects.filter((o) => o.type !== "pen")
      : srcObjects;
    drawObjects(ctx, this.frame, objects, selected, drawCtx, this.coarse);

    if (this.draftConn) {
      const fromObj = this.project.getObject(this.draftConn.from);
      if (fromObj) {
        const start = edgeAnchor(aabb(fromObj), this.draftConn.end);
        const sp = worldToScreen(start, this.frame);
        const ep = worldToScreen(this.draftConn.end, this.frame);
        const lineColor = this.draftConn.valid ? "#3ddc84" : "rgba(145,163,240,0.9)";
        ctx.save();
        ctx.strokeStyle = lineColor;
        ctx.lineWidth = Math.max(1, 2 * this.frame.zoom);
        ctx.setLineDash([6, 4]);
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(sp.x, sp.y);
        ctx.lineTo(ep.x, ep.y);
        ctx.stroke();
        ctx.setLineDash([]);
        const angle = Math.atan2(ep.y - sp.y, ep.x - sp.x);
        const arrowLen = Math.max(10, 12 * this.frame.zoom);
        const arrowAngle = Math.PI / 6;
        ctx.fillStyle = lineColor;
        ctx.beginPath();
        ctx.moveTo(ep.x, ep.y);
        ctx.lineTo(ep.x - arrowLen * Math.cos(angle - arrowAngle), ep.y - arrowLen * Math.sin(angle - arrowAngle));
        ctx.lineTo(ep.x - arrowLen * Math.cos(angle + arrowAngle), ep.y - arrowLen * Math.sin(angle + arrowAngle));
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }

    this.ink.renderDraft(ctx, this.frame);

    if (this.marqueeRect) {
      const tl = worldToScreen({ x: this.marqueeRect.x, y: this.marqueeRect.y }, this.frame);
      ctx.save();
      ctx.fillStyle = "rgba(91,124,250,0.12)";
      ctx.strokeStyle = "#5b7cfa";
      ctx.lineWidth = 1;
      ctx.fillRect(tl.x, tl.y, this.marqueeRect.width * this.frame.zoom, this.marqueeRect.height * this.frame.zoom);
      ctx.strokeRect(tl.x, tl.y, this.marqueeRect.width * this.frame.zoom, this.marqueeRect.height * this.frame.zoom);
      ctx.restore();
    }

    if (this.guides.length) {
      ctx.save();
      ctx.strokeStyle = "#ff5b7c";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      for (const g of this.guides) {
        const p = worldToScreen(g.axis === "x" ? { x: g.value, y: 0 } : { x: 0, y: g.value }, this.frame);
        ctx.beginPath();
        if (g.axis === "x") {
          ctx.moveTo(p.x, 0);
          ctx.lineTo(p.x, this.height);
        } else {
          ctx.moveTo(0, p.y);
          ctx.lineTo(this.width, p.y);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    this.ink.renderInkSelection(ctx, this.frame);
    this.ink.renderLasso(ctx, this.frame);
    this.ink.renderEraserGuide(ctx);
  }

  private requestRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  private handleResize(): void {
    const target = this.canvasEl.parentElement ?? this.canvasEl;
    const rect = target.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    const newWidth = Math.max(1, Math.floor(rect.width));
    const newHeight = Math.max(1, Math.floor(rect.height));
    if (newWidth === this.width && newHeight === this.height) return;
    this.width = newWidth;
    this.height = newHeight;
    this.canvasEl.width = Math.floor(this.width * this.dpr);
    this.canvasEl.height = Math.floor(this.height * this.dpr);
    this.canvasEl.style.width = `${this.width}px`;
    this.canvasEl.style.height = `${this.height}px`;
    this.syncFrame();
    this.requestRender();
    // The canvas just changed size (e.g. a panel opened/closed). The camera did
    // not move, but the viewport frame did, so overlay/culling/minimap math
    // dependent on the canvas size must re-baseline.
    this.viewport.changed.emit(this.viewport.get());
  }

  private syncFrame(): void {
    const vp = this.viewport.get();
    this.frame = createFrame(vp, this.width, this.height);
  }

  syncFromViewport(vp: ReturnType<ViewportStore["get"]>): void {
    this.frame = createFrame(vp, this.width, this.height);
  }

  /** Rebuild the spatial index from current document objects (on any change). */
  private refreshIndex(): void {
    this.spatial.rebuild(
      this.project.getObjects().map((o) => ({ id: o.id, rect: { x: o.x, y: o.y, width: o.width, height: o.height } }))
    );
  }
}

function createObjectId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return "obj_" + crypto.randomUUID();
  }
  return "obj_" + Math.random().toString(36).slice(2, 10);
}

function handleWorldRect(rect: Rect, handle: Handle): Point {
  const pos = {
    nw: { x: rect.x, y: rect.y },
    n: { x: rect.x + rect.width / 2, y: rect.y },
    ne: { x: rect.x + rect.width, y: rect.y },
    e: { x: rect.x + rect.width, y: rect.y + rect.height / 2 },
    se: { x: rect.x + rect.width, y: rect.y + rect.height },
    s: { x: rect.x + rect.width / 2, y: rect.y + rect.height },
    sw: { x: rect.x, y: rect.y + rect.height },
    w: { x: rect.x, y: rect.y + rect.height / 2 },
  } as const;
  return pos[handle];
}

/** Normalize an angle to (-PI, PI] so serialized rotations stay canonical. */
function normalizeAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

function aabb(o: CanvasObject): Rect {
  return { x: o.x, y: o.y, width: o.width, height: o.height };
}

/** All eligible snap targets: every object not in `exclude`, minus decorative types. */
function buildOthers(project: ProjectStore, exclude: ReadonlySet<string>): Rect[] {
  const others: Rect[] = [];
  for (const o of project.getObjects()) {
    if (exclude.has(o.id) || o.type === "connection" || o.type === "pen") continue;
    others.push({ x: o.x, y: o.y, width: o.width, height: o.height });
  }
  return others;
}

function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function zOrderCommandRef(
  before: { id: string; zIndex: number }[],
  after: { id: string; zIndex: number }[],
  project: ProjectStore
): Command {
  return {
    label: "Reorder objects",
    redo() {
      project.setZOrder(after);
    },
    undo() {
      project.setZOrder(before);
    },
  };
}
