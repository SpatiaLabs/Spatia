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
import { connectionBounds, connectionEndpoints, connectionHit, expandMembers, unionRect, snapMove, snapResize, edgeAnchor, pointToSegment, connectionBetween, connectionsTouching, remapConnection, type SnapGuide } from "../../shared/geometry/workspace.js";
import { anchorOnSide, chooseSides, connFromSide, connRouteStyle, connToSide, loadDefaultRouteStyle, routeBetweenCached, routePolyline, DEFAULT_ROUTE_STYLE, SIDES, type ConnRoute, type Side } from "../../shared/geometry/connectionRouting.js";
import { SHAPE_DEFAULTS, pointInShape } from "../../shared/geometry/shapes.js";

const DEFAULT_SIZES: Record<"test-object" | "text" | "note" | "table" | "chart", { width: number; height: number }> = {
  "test-object": { width: 160, height: 160 },
  text: { width: 200, height: 120 },
  note: { width: 180, height: 140 },
  table: { width: 320, height: 220 },
  chart: { width: 360, height: 260 },
};

/**
 * The flat colour painted under the infinite canvas grid. The grid itself is
 * drawn by `drawGrid` on top of this fill; the colour matches the dark
 * application theme.
 */
export const CANVAS_BACKGROUND = "#121417";

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
  /**
   * The single cached 2D context for the on-screen canvas. It is acquired once
   * (with an opaque, potentially desynchronized compositor target) and reused
   * for every frame, so the browser can keep the fastest path between the JS
   * rendering raster and the display — no per-frame `getContext` churn and no
   * intermediate alpha blending. `desynchronized` is a hint, not a guarantee:
   * if the display pipeline can't honour it the context falls back gracefully.
   */
  private ctx: CanvasRenderingContext2D | null = null;
  /**
   * Offscreen backing store for the "static" part of a frame: the flat canvas
   * background and every committed object (plus selection chrome).
   * It is only repainted when its fingerprint changes — pan, zoom, a document
   * edit, a selection change or an image decode — so drawing a live stroke
   * costs a single `drawImage` blit instead of re-issuing every vector on the
   * canvas for each pointer move.
   */
  private staticCanvas: HTMLCanvasElement | null = null;
  private staticCtx: CanvasRenderingContext2D | null = null;
  private staticSig: string | null = null;
  /** Bumped whenever a decoded image becomes available (or is dropped). */
  private imageEpoch = 0;
  private resizeObserver: ResizeObserver;
  private images = new ImageCache();
  private spatial = new SpatialGrid();
  private unsubscribers: Array<() => void> = [];

  private grab: GrabState | null = null;
  private resizeState: ResizeState | null = null;
  private rotateState: RotateState | null = null;
  private marqueeRect: Rect | null = null;
  private guides: SnapGuide[] = [];
  private draftConn: {
    from: string;
    end: Point;
    valid: boolean;
    /** Explicit side grabbed on the source (hover handle), or null for auto. */
    fromSide: Side | null;
    /** Id of the object currently under the pointer (the prospective target). */
    targetId: string | null;
    /** Side chosen for the target when hovering a valid target, else null. */
    toSide: Side | null;
  } | null = null;
  /** Object whose edge connection-handles are shown, plus the handle under the pointer. */
  private hover: { id: string; side: Side | null } | null = null;
  /** In-progress re-binding of a selected connection's endpoint. */
  private reconnect: { id: string; end: "from" | "to" } | null = null;
  private reconnectPoint: Point | null = null;
  private reconnectTargetId: string | null = null;
  private ink: InkController;
  private penActive = false;
  private penToolMode: PenToolMode = "pen";
  private lastPenActivity = 0;
  /** Touch hosts get larger selection handles + a rotation knob; desktop is unchanged. */
  private coarse = false;
  /** Object ids allowed while a group or frame is isolated; null means full workspace. */
  private isolationIds: ReadonlySet<string> | null = null;
  /**
   * Object id currently being edited by an inline DOM editor (text/note). While
   * set, the object and its selection chrome are omitted from the canvas so the
   * overlaid editor is the single source of truth — otherwise a duplicate,
   * slightly offset outline/text would show through behind it.
   */
  private editingId: string | null = null;

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

  /**
   * Mark (or clear) the object owned by an inline DOM editor. The engine hides
   * that object and its selection chrome while it is being edited so the
   * overlaid editor never double-draws an offset outline.
   */
  setEditingObject(id: string | null): void {
    if (this.editingId === id) return;
    this.editingId = id;
    this.requestRender();
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
    const seen = new Set<string>();
    for (const obj of candidates) {
      if (seen.has(obj.id)) continue;
      seen.add(obj.id);
      if (obj.type === "connection") {
        const fromObj = this.project.getObject(obj.from);
        const toObj = this.project.getObject(obj.to);
        const hitRadius = 12 / this.frame.zoom;
        let hit = false;
        if (fromObj && toObj) {
          const route = routeBetweenCached(
            { x: fromObj.x, y: fromObj.y, width: fromObj.width, height: fromObj.height },
            { x: toObj.x, y: toObj.y, width: toObj.width, height: toObj.height },
            connRouteStyle(obj),
            connFromSide(obj),
            connToSide(obj)
          );
          const poly = routePolyline(route);
          for (let i = 1; i < poly.length && !hit; i++) {
            if (pointToSegment(wp, poly[i - 1], poly[i]) <= hitRadius) hit = true;
          }
        } else {
          const { start, end } = connectionEndpoints(obj, fromObj, toObj);
          hit = connectionHit(wp, start, end, hitRadius);
        }
        if (hit) return obj.id;
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

  // Connection gesture. Two entry points: the keyboard draft (hold Ctrl while
  // hovering an object) and the Obsidian-style drag from a hover edge handle.

  /** True when an object can be an endpoint (not a connection/pen stroke). */
  private isConnectable(id: string | null): boolean {
    if (!id) return false;
    const o = this.project.getObject(id);
    return !!o && o.type !== "connection" && o.type !== "pen";
  }

  beginConnection(fromId: string, screen: Point, fromSide: Side | null = null): void {
    if (!this.isConnectable(fromId)) {
      this.draftConn = null;
      return;
    }
    this.hover = null;
    this.draftConn = {
      from: fromId,
      end: screenToWorld(screen, this.frame),
      valid: false,
      fromSide,
      targetId: null,
      toSide: null,
    };
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
    const valid = this.isConnectable(target) && target !== this.draftConn.from;
    this.draftConn.valid = valid;
    this.draftConn.targetId = valid ? target : null;
    this.draftConn.toSide = null;
    if (valid && target) {
      const from = this.project.getObject(this.draftConn.from);
      const to = this.project.getObject(target);
      if (from && to) {
        // When the source side is fixed (dragged from a handle) pick the target
        // side that best faces it; otherwise use the facing pair.
        const auto = chooseSides(aabb(from), aabb(to));
        this.draftConn.toSide = auto.to;
        if (!this.draftConn.fromSide) this.draftConn.fromSide = auto.from;
      }
    }
  }

  finishConnection(screen: Point): string | null {
    if (!this.draftConn) return null;
    const draft = this.draftConn;
    this.draftConn = null;
    this.requestRender();
    const fromObj = this.project.getObject(draft.from);
    if (!fromObj) return null;
    const target = this.hitTest(screen);
    // Releasing over the source is a self-connection -> cancel.
    if (target === draft.from) return null;
    // Valid object target (not another connection) -> create A -> B.
    if (this.isConnectable(target)) {
      const toObj = this.project.getObject(target as string);
      const auto = toObj ? chooseSides(aabb(fromObj), aabb(toObj)) : { from: "right" as Side, to: "left" as Side };
      return this.createConnection(draft.from, target as string, {
        fromSide: draft.fromSide ?? auto.from,
        toSide: target === draft.targetId && draft.toSide ? draft.toSide : auto.to,
      });
    }
    // Otherwise (empty space, or a connection which cannot be a target) keep a
    // free endpoint at the current world position instead of cancelling.
    return this.createFreeConnection(draft.from, screenToWorld(screen, this.frame), draft.fromSide);
  }

  /** Drop an in-progress connection draft without creating anything. */
  cancelConnectionDraft(): void {
    if (this.draftConn) {
      this.draftConn = null;
      this.requestRender();
    }
  }

  // --- Hover edge handles (Obsidian-style drag-to-connect) -------------------

  /**
   * Update hover state from the pointer. Shows the four edge handles on a
   * connectable object under the cursor and records which handle is under the
   * pointer so input can start a drag-to-connect from it.
   */
  hoverAt(screen: Point): void {
    if (this.draftConn || this.reconnect) return;
    const hit = this.hitTest(screen);
    if (!this.isConnectable(hit)) {
      if (this.hover) {
        this.hover = null;
        this.requestRender();
      }
      return;
    }
    const obj = this.project.getObject(hit as string);
    if (!obj) return;
    const side = this.handleUnderPointer(obj, screen);
    const next = { id: obj.id, side };
    if (!this.hover || this.hover.id !== next.id || this.hover.side !== next.side) {
      this.hover = next;
      this.requestRender();
    }
  }

  /** Clear the hover handle state (pointer left the canvas / a gesture began). */
  clearHover(): void {
    if (this.hover) {
      this.hover = null;
      this.requestRender();
    }
  }

  /** The world-space center of a given side of an object's AABB. */
  private sideHandleWorld(o: CanvasObject, side: Side): Point {
    const b = aabb(o);
    switch (side) {
      case "top":
        return { x: b.x + b.width / 2, y: b.y };
      case "bottom":
        return { x: b.x + b.width / 2, y: b.y + b.height };
      case "left":
        return { x: b.x, y: b.y + b.height / 2 };
      case "right":
        return { x: b.x + b.width, y: b.y + b.height / 2 };
    }
  }

  /** Which (if any) edge handle of `o` sits under the pointer. */
  private handleUnderPointer(o: CanvasObject, screen: Point): Side | null {
    const radius = this.coarse ? 18 : 11;
    let best: Side | null = null;
    let bestD = Infinity;
    for (const side of SIDES) {
      const p = worldToScreen(this.sideHandleWorld(o, side), this.frame);
      const d = Math.hypot(p.x - screen.x, p.y - screen.y);
      if (d <= radius && d < bestD) {
        bestD = d;
        best = side;
      }
    }
    return best;
  }

  /** Connection handle of the hovered object under the pointer, if any. */
  hitConnectHandle(screen: Point): { id: string; side: Side } | null {
    const hit = this.hitTest(screen);
    if (!this.isConnectable(hit)) return null;
    const obj = this.project.getObject(hit as string);
    if (!obj) return null;
    const side = this.handleUnderPointer(obj, screen);
    return side ? { id: obj.id, side } : null;
  }

  /** Grab an endpoint dot of a selected connection to re-bind it. */
  hitConnectionEndpoint(screen: Point): { id: string; end: "from" | "to" } | null {
    const radius = this.coarse ? 20 : 12;
    for (const id of this.selection.get()) {
      const conn = this.project.getObject(id);
      if (!conn || conn.type !== "connection") continue;
      const points = this.connectionEndpointPoints(conn);
      if (!points) continue;
      const f = worldToScreen(points.start, this.frame);
      const t = worldToScreen(points.end, this.frame);
      if (Math.hypot(f.x - screen.x, f.y - screen.y) <= radius) return { id, end: "from" };
      if (Math.hypot(t.x - screen.x, t.y - screen.y) <= radius) return { id, end: "to" };
    }
    return null;
  }

  beginReconnect(id: string, end: "from" | "to", screen: Point): void {
    const conn = this.project.getObject(id);
    if (!conn || conn.type !== "connection") return;
    const otherId = end === "from" ? conn.to : conn.from;
    // Re-bind from the fixed endpoint; the moving end follows the pointer.
    if (!this.isConnectable(otherId) && otherId !== "") return;
    this.reconnect = { id, end };
    this.selection.setIds([id]);
    this.updateReconnectTarget(screen);
    this.requestRender();
  }

  /** Resolved world-space endpoints of a connection (route ends, or fallback). */
  private connectionEndpointPoints(
    conn: Extract<CanvasObject, { type: "connection" }>
  ): { start: Point; end: Point } | null {
    const fromObj = this.project.getObject(conn.from);
    const toObj = conn.to ? this.project.getObject(conn.to) : undefined;
    if (fromObj && toObj) {
      const route = routeBetweenCached(
        aabb(fromObj),
        aabb(toObj),
        connRouteStyle(conn),
        connFromSide(conn),
        connToSide(conn)
      );
      return { start: route.start, end: route.end };
    }
    return connectionEndpoints(conn, fromObj, toObj);
  }

  private updateReconnectTarget(screen: Point): void {
    if (!this.reconnect) return;
    this.reconnectPoint = screenToWorld(screen, this.frame);
    const target = this.hitTest(screen);
    this.reconnectTargetId = this.isConnectable(target) ? target : null;
    this.requestRender();
  }

  reconnectDragTo(screen: Point): void {
    if (!this.reconnect) return;
    this.updateReconnectTarget(screen);
  }

  finishReconnect(screen: Point): void {
    if (!this.reconnect) return;
    const { id, end } = this.reconnect;
    this.reconnect = null;
    this.reconnectPoint = null;
    this.reconnectTargetId = null;
    const conn = this.project.getObject(id);
    if (!conn || conn.type !== "connection") {
      this.requestRender();
      return;
    }
    const target = this.hitTest(screen);
    if (!this.isConnectable(target)) {
      this.requestRender();
      return;
    }
    const nextFrom = end === "from" ? (target as string) : conn.from;
    const nextTo = end === "to" ? (target as string) : conn.to;
    if (nextFrom === nextTo || nextFrom === "" || nextTo === "") {
      this.requestRender();
      return;
    }
    const fromObj = this.project.getObject(nextFrom);
    const toObj = this.project.getObject(nextTo);
    const auto = fromObj && toObj ? chooseSides(aabb(fromObj), aabb(toObj)) : { from: "right" as Side, to: "left" as Side };
    // Re-pin only the endpoint that moved; leave the other end's anchor (or its
    // auto state) exactly as it was.
    const metadata = { ...conn.metadata };
    if (end === "from") {
      delete metadata.fromSide;
      if (fromObj && toObj) metadata.fromSide = auto.from;
    } else {
      delete metadata.toSide;
      if (fromObj && toObj) metadata.toSide = auto.to;
    }
    const before = { from: conn.from, to: conn.to, metadata: conn.metadata };
    const after = { from: nextFrom, to: nextTo, metadata };
    const apply = (vals: { from: string; to: string; metadata: Record<string, unknown> }): void => {
      this.project.setObjectProp(id, "from", vals.from);
      this.project.setObjectProp(id, "to", vals.to);
      this.project.setObjectProp(id, "metadata", vals.metadata);
    };
    this.commitCommand({ label: "Reconnect edge", redo: () => apply(after), undo: () => apply(before) });
    this.requestRender();
  }

  /** Abandon an in-progress reconnect without changing the connection. */
  cancelReconnect(): void {
    if (this.reconnect) {
      this.reconnect = null;
      this.reconnectPoint = null;
      this.reconnectTargetId = null;
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
  createFreeConnection(fromId: string, end: Point, fromSide: Side | null = null): string | null {
    const fromObj = this.project.getObject(fromId);
    if (!fromObj || fromObj.type === "connection") return null;
    const metadata = connectionMeta({ fromSide });
    const snap = connectionBounds(
      { from: fromId, to: "", x: fromObj.x, y: fromObj.y, endX: end.x, endY: end.y, strokeWidth: 2, metadata },
      fromObj,
      undefined
    );
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
      x: snap.x,
      y: snap.y,
      width: snap.width,
      height: snap.height,
      rotation: 0,
      zIndex: this.project.nextZIndex(),
      locked: false,
      metadata,
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
      const b = o.type === "connection"
        ? connectionBounds(o, this.project.getObject(o.from), this.project.getObject(o.to))
        : aabb(o);
      if (rectsIntersect(b, rect)) ids.push(o.id);
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
    const idMap = new Map<string, string>();
    const dup: CanvasObject[] = source.map((o) => {
      const id = createObjectId();
      idMap.set(o.id, id);
      return {
        ...o,
        id,
        x: o.x + 20,
        y: o.y + 20,
        // Freehand strokes carry a points array that must not be shared between
        // the original and the clone (a later move/restyle must stay independent).
        ...(o.type === "pen" ? { points: o.points.map((p) => ({ ...p })) } : {}),
      };
    });
    // A duplicated cluster keeps its internal branching graph: any connection
    // selected alongside its endpoints is re-pointed at the cloned endpoints
    // instead of the originals.
    const remapped = dup.map((d) => (d.type === "connection" ? remapConnection(d, idMap) : d));
    const self = this;
    this.commitCommand({
      label: remapped.length > 1 ? `Duplicate ${remapped.length} objects` : "Duplicate",
      redo() {
        for (const d of remapped) self.project.addObject(d);
      },
      undo() {
        for (const d of remapped) self.project.removeObjects([d.id]);
      },
    });
    this.selection.setIds(remapped.filter((d) => d.type !== "pen").map((d) => d.id));
    this.ink.setInkSelection(remapped.filter((d) => d.type === "pen").map((d) => d.id));
  }

  deleteSelection(): void {
    const objectIds = this.selection.get().filter((id) => !this.isInkId(id));
    const inkIds = this.ink.inkSelectedIds();
    const ids = [...objectIds, ...inkIds];
    if (ids.length === 0) return;
    // Removing a frame must not leave dangling edges behind: pull in every
    // connection attached to a deleted object so the graph stays consistent.
    const doomed = new Set(ids);
    const linked = connectionsTouching(this.project.getObjects(), doomed);
    for (const id of linked) doomed.add(id);
    const commandIds = [...doomed];
    this.commitCommand(deleteObjectsCommand(this.project, commandIds));
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

  createConnection(
    fromId: string,
    toId: string,
    sides?: { fromSide?: Side | null; toSide?: Side | null }
  ): string | null {
    const fromObj = this.project.getObject(fromId);
    const toObj = this.project.getObject(toId);
    if (!fromObj || !toObj) return null;
    if (fromId === toId) return null;
    // Don't silently stack identical edges: dragging the same link twice just
    // re-selects the one that already exists. Distinct edges (different
    // targets) and branching/converging links are still fully allowed.
    const existing = connectionBetween(this.project.getObjects(), fromId, toId);
    if (existing) {
      this.selection.setIds([existing]);
      this.requestRender();
      return existing;
    }
    const metadata = connectionMeta({ fromSide: sides?.fromSide ?? null, toSide: sides?.toSide ?? null });
    const snap = connectionBounds(
      { from: fromId, to: toId, x: fromObj.x, y: fromObj.y, strokeWidth: 2, metadata },
      fromObj,
      toObj
    );
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
      x: snap.x,
      y: snap.y,
      width: snap.width,
      height: snap.height,
      rotation: 0,
      zIndex: this.project.nextZIndex(),
      locked: false,
      metadata,
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
      const img = await this.images.load(assetId, dataUrl);
      // A decoded bitmap changes what the static layer paints, even though the
      // document itself did not mutate — bump the epoch so it repaints.
      this.imageEpoch += 1;
      return img;
    } catch {
      return null;
    }
  }

  /** Drop a cached image so the next load reflects a relinked binary. */
  invalidateImage(assetId: string): void {
    this.images.invalidate(assetId);
    this.imageEpoch += 1;
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
    ctx.fillStyle = CANVAS_BACKGROUND;
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

  /**
   * Transient connection chrome drawn on the live layer (never cached): target
   * feedback, the drag-to-connect preview route, the reconnect preview, and the
   * hover edge handles that start a connection.
   */
  private drawConnectOverlay(ctx: CanvasRenderingContext2D): void {
    const zoom = this.frame.zoom;

    const targetId = this.draftConn?.targetId ?? this.reconnectTargetId;
    if (targetId) {
      const o = this.project.getObject(targetId);
      if (o && this.isObjectVisible(o.id)) {
        const tl = worldToScreen({ x: o.x, y: o.y }, this.frame);
        ctx.save();
        ctx.strokeStyle = "#3ddc84";
        ctx.lineWidth = 2;
        ctx.strokeRect(tl.x - 2, tl.y - 2, o.width * zoom + 4, o.height * zoom + 4);
        ctx.restore();
      }
    }

    if (this.draftConn) {
      const fromObj = this.project.getObject(this.draftConn.from);
      const toObj = this.draftConn.targetId ? this.project.getObject(this.draftConn.targetId) : undefined;
      if (fromObj && this.draftConn.valid && toObj) {
        const route = routeBetweenCached(
          aabb(fromObj),
          aabb(toObj),
          loadDefaultRouteStyle(),
          this.draftConn.fromSide,
          this.draftConn.toSide
        );
        this.strokePreviewRoute(ctx, route, "#3ddc84");
      } else if (fromObj) {
        const start = this.draftConn.fromSide
          ? anchorOnSide(aabb(fromObj), this.draftConn.fromSide, this.draftConn.end)
          : edgeAnchor(aabb(fromObj), this.draftConn.end);
        this.strokePreviewLine(ctx, start, this.draftConn.end, "rgba(145,163,240,0.9)");
      }
      if (fromObj && this.draftConn.fromSide) {
        const hp = worldToScreen(anchorOnSide(aabb(fromObj), this.draftConn.fromSide, this.draftConn.end), this.frame);
        this.drawHandleDot(ctx, hp.x, hp.y, true);
      }
    }

    if (this.reconnect && this.reconnectPoint) {
      const conn = this.project.getObject(this.reconnect.id);
      if (conn && conn.type === "connection") {
        const pts = this.connectionEndpointPoints(conn);
        if (pts) {
          const fixed = this.reconnect.end === "from" ? pts.end : pts.start;
          this.strokePreviewLine(ctx, fixed, this.reconnectPoint, "#3ddc84");
        }
      }
    }

    if (this.hover && this.draftConn === null && this.reconnect === null) {
      const o = this.project.getObject(this.hover.id);
      if (o && this.isObjectVisible(o.id)) this.drawEdgeHandles(ctx, o, this.hover.side);
    }
  }

  /** Four edge handles around an object; the one under the pointer is enlarged. */
  private drawEdgeHandles(ctx: CanvasRenderingContext2D, o: CanvasObject, activeSide: Side | null): void {
    const b = aabb(o);
    ctx.save();
    ctx.strokeStyle = "rgba(91,124,250,0.6)";
    ctx.lineWidth = 1.5;
    const tl = worldToScreen({ x: b.x, y: b.y }, this.frame);
    ctx.strokeRect(tl.x, tl.y, b.width * this.frame.zoom, b.height * this.frame.zoom);
    ctx.restore();
    for (const side of SIDES) {
      const p = worldToScreen(this.sideHandleWorld(o, side), this.frame);
      this.drawHandleDot(ctx, p.x, p.y, side === activeSide);
    }
  }

  private drawHandleDot(ctx: CanvasRenderingContext2D, x: number, y: number, active: boolean): void {
    const r = active ? 7 : 5;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = active ? "#3ddc84" : "#f4f6fb";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = active ? "#2bb673" : "#5b7cfa";
    ctx.stroke();
    ctx.restore();
  }

  private strokePreviewLine(ctx: CanvasRenderingContext2D, a: Point, b: Point, color: string): void {
    const sp = worldToScreen(a, this.frame);
    const ep = worldToScreen(b, this.frame);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, 2 * this.frame.zoom);
    ctx.setLineDash([6, 4]);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(sp.x, sp.y);
    ctx.lineTo(ep.x, ep.y);
    ctx.stroke();
    ctx.setLineDash([]);
    this.drawPreviewArrow(ctx, sp, ep, color);
    ctx.restore();
  }

  private strokePreviewRoute(ctx: CanvasRenderingContext2D, route: ConnRoute, color: string): void {
    const pts = route.points.map((p) => worldToScreen(p, this.frame));
    if (pts.length < 2) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, 2 * this.frame.zoom);
    ctx.setLineDash([6, 4]);
    ctx.lineCap = "round";
    ctx.beginPath();
    if (route.kind === "cubic") {
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.bezierCurveTo(pts[1].x, pts[1].y, pts[2].x, pts[2].y, pts[3].x, pts[3].y);
    } else {
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    this.drawPreviewArrow(ctx, pts[pts.length - 2], pts[pts.length - 1], color);
    ctx.restore();
  }

  private drawPreviewArrow(ctx: CanvasRenderingContext2D, from: Point, to: Point, color: string): void {
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const arrowLen = Math.max(10, 12 * this.frame.zoom);
    const arrowAngle = Math.PI / 6;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(to.x - arrowLen * Math.cos(angle - arrowAngle), to.y - arrowLen * Math.sin(angle - arrowAngle));
    ctx.lineTo(to.x - arrowLen * Math.cos(angle + arrowAngle), to.y - arrowLen * Math.sin(angle + arrowAngle));
    ctx.closePath();
    ctx.fill();
  }

  render(): void {
    const ctx = this.canvasContext();
    if (!ctx) return;

    // Paint (or reuse) the cached background + grid + committed objects, then
    // blit it back in device pixels. Everything after this point is transient
    // overlay that changes without touching the document, so a live pen stroke
    // costs one `drawImage` instead of re-pathing every object per pointer move.
    this.paintStaticLayer();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.staticCanvas) ctx.drawImage(this.staticCanvas, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    this.drawConnectOverlay(ctx);

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

  /**
   * Repaint the cached static layer only when something it depends on changed:
   * the frame (pan/zoom/resize), the document (revision), the selection, the
   * isolation scope, the coarse-handle mode, a live eraser draft, or a decoded
   * image. While only the transient ink draft changes, the previous layer is
   * reused as-is.
   */
  private paintStaticLayer(): void {
    const sig = this.staticSignature();
    if (sig === this.staticSig && this.staticCanvas && this.staticCtx) return;

    if (!this.staticCanvas) {
      this.staticCanvas = document.createElement("canvas");
      this.staticCtx = this.staticCanvas.getContext("2d");
    }
    const sctx = this.staticCtx;
    if (!sctx) return;

    const deviceW = Math.max(1, Math.floor(this.width * this.dpr));
    const deviceH = Math.max(1, Math.floor(this.height * this.dpr));
    if (this.staticCanvas.width !== deviceW || this.staticCanvas.height !== deviceH) {
      this.staticCanvas.width = deviceW;
      this.staticCanvas.height = deviceH;
    }

    sctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    sctx.clearRect(0, 0, this.width, this.height);
    // Background fill + the zoom-adaptive world grid. Both depend only on the
    // frame, so they live in the cached static layer and cost nothing while a
    // live stroke or overlay repaints on top.
    sctx.fillStyle = CANVAS_BACKGROUND;
    sctx.fillRect(0, 0, this.width, this.height);
    drawGrid(sctx, this.frame);

    let selected = new Set(this.selection.get());
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
    let objects = this.ink.eraserDraftActive()
      ? srcObjects.filter((o) => o.type !== "pen")
      : srcObjects;
    // Hide the object currently owned by an inline DOM editor (and its selection
    // chrome) so the editor overlay is the only thing drawn, with no duplicate
    // or offset outline showing through behind it.
    if (this.editingId !== null) {
      objects = objects.filter((o) => o.id !== this.editingId);
      if (selected.has(this.editingId)) {
        selected = new Set(selected);
        selected.delete(this.editingId);
      }
    }
    drawObjects(sctx, this.frame, objects, selected, drawCtx, this.coarse);

    this.staticSig = sig;
  }

  /** Cheap fingerprint of everything that affects the static layer's pixels. */
  private staticSignature(): string {
    const f = this.frame;
    const iso = this.isolationIds === null ? "*" : [...this.isolationIds].sort().join(",");
    return [
      f.cameraX, f.cameraY, f.zoom, f.originWidth, f.originHeight,
      this.width, this.height, this.dpr,
      this.coarse ? 1 : 0,
      this.ink.eraserDraftActive() ? 1 : 0,
      this.project.getRevision(),
      this.imageEpoch,
      iso,
      this.editingId ?? "",
      this.selection.get().join(","),
    ].join("|");
  }

  private requestRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  /**
   * Lazily acquire the single cached canvas context. Rendering is opaque (the
   * canvas is fully covered by the page background every frame), so `alpha:
   * false` lets the compositor skip blending. `desynchronized: true` makes the
   * browser free to paint as soon as the frame is ready instead of aligning to
   * the display's vertical sync — a hint the JS frame rate is display-driven
   * and never artificially capped by Spatia itself.
   */
  private canvasContext(): CanvasRenderingContext2D | null {
    if (this.ctx) return this.ctx;
    try {
      this.ctx = this.canvasEl.getContext("2d", { alpha: false, desynchronized: true });
    } catch {
      this.ctx = null;
    }
    if (!this.ctx) {
      try {
        this.ctx = this.canvasEl.getContext("2d", { alpha: false });
      } catch {
        this.ctx = null;
      }
    }
    return this.ctx;
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
      this.project.getObjects().map((o) => ({
        id: o.id,
        rect: o.type === "connection"
          ? connectionBounds(o, this.project.getObject(o.from), this.project.getObject(o.to))
          : { x: o.x, y: o.y, width: o.width, height: o.height },
      }))
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

/**
 * Metadata for a freshly created connection: stamp the current default route
 * style, but leave it off when it matches the built-in default so ordinary
 * documents stay lean (readers fall back to {@link DEFAULT_ROUTE_STYLE}).
 */
function connectionMeta(sides?: { fromSide?: Side | null; toSide?: Side | null }): Record<string, unknown> {
  const route = loadDefaultRouteStyle();
  const meta: Record<string, unknown> = route === DEFAULT_ROUTE_STYLE ? {} : { route };
  if (sides?.fromSide) meta.fromSide = sides.fromSide;
  if (sides?.toSide) meta.toSide = sides.toSide;
  return meta;
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
