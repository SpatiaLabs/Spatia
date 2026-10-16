import type { ViewportFrame, Point, Rect } from "../../shared/geometry/viewport.js";
import type { Handle } from "../../shared/geometry/selection.js";
import type { ObjectKind } from "../../shared/types/object.js";
import type { Command } from "../command/commandManager.js";
import type { PenToolMode, InkSettings } from "./inkController.js";
import type { PenObject } from "../../shared/types/object.js";
import type { Side } from "../../shared/geometry/connectionRouting.js";

/**
 * Contract between the pointer state machine (CanvasInput) and the canvas
 * engine. All moves/resizes are *absolute*: the engine positions objects from
 * the current pointer world point plus a fixed grab offset, never by
 * accumulating deltas, so the selection tracks the cursor 1:1.
 */
export interface InteractionHost {
  canvas(): HTMLCanvasElement;
  getFrame(): ViewportFrame;

  // Selection
  selectedIds(): readonly string[];
  inSelection(id: string): boolean;
  setSelection(ids: readonly string[]): void;
  toggleSelection(id: string): void;
  hitTest(screen: Point): string | null;
  hitHandle(screen: Point): Handle | null;
  /** True when the rotation knob (touch hosts only) is under the pointer. */
  hitRotateHandle(screen: Point): boolean;
  /** World-space AABB of the current selection, or null. */
  selectionWorldBounds(): Rect | null;

  // Rotate gesture (touch hosts only; rotates each selected object about its
  // own center by the knob-drag delta).
  beginRotate(screen: Point): void;
  rotateTo(screen: Point): void;
  endRotate(): void;

  // Move gesture
  grabSelection(screen: Point): void;
  dragTo(screen: Point): void;
  dropGrab(): void;

  // Ink move gesture (freehand strokes are dragged through the ink controller)
  prepareInkDrag(screen: Point): void;
  inkDragTo(screen: Point): void;
  endInkDrag(): void;

  // Resize gesture
  beginResize(handle: Handle, screen: Point): void;
  resizeTo(screen: Point): void;
  endResize(): void;

  // Viewport
  applyPan(dx: number, dy: number): void;
  applyAnchoredZoom(factor: number, anchor: Point): void;
  setInteractionCursor(kind: "default" | "pan" | "grab" | "move" | "resize" | "copy"): void;
  /** Show/hide the live marquee selection rectangle (world space). */
  setMarquee(rect: Rect | null): void;

  // Document mutations (each should be a single undoable command)
  createObject(kind: ObjectKind, worldCenter: Point): string | null;
  commitCommand(cmd: Command): void;

  // Connection gesture (Ctrl + drag between two objects, or drag from a hover
  // edge handle). `fromSide` pins the source attachment side when grabbed.
  beginConnection(fromId: string, screen: Point, fromSide?: Side | null): void;
  connectionDragTo(screen: Point): void;
  /** Create a connection from the gesture's source to the object under the
   *  pointer (if valid), returning the new connection id or null. */
  finishConnection(screen: Point): string | null;
  /** Drop an in-progress connection draft without creating anything. */
  cancelConnectionDraft(): void;

  // Hover edge handles (Obsidian-style drag-to-connect)
  /** Update hover state: show edge handles on the object under the pointer. */
  hoverAt(screen: Point): void;
  /** Hide the hover edge handles (pointer left the canvas). */
  clearHover(): void;
  /** Edge handle of the object under the pointer, if any. */
  hitConnectHandle(screen: Point): { id: string; side: Side } | null;

  // Reconnection: drag an endpoint dot of a selected connection onto a new target.
  hitConnectionEndpoint(screen: Point): { id: string; end: "from" | "to" } | null;
  beginReconnect(id: string, end: "from" | "to", screen: Point): void;
  reconnectDragTo(screen: Point): void;
  finishReconnect(screen: Point): void;
  cancelReconnect(): void;

  // Pen tool (freehand drawing). Separate from connections.
  isPenTool(): boolean;
  setPenTool(on: boolean): void;
  startPenStroke(screen: Point, pressure?: number): void;
  penStrokeTo(screen: Point, pressure?: number): void;
  endPenStroke(): void;

  // Ink (dedicated freehand-stroke selection, distinct from object selection)
  isInkId(id: string): boolean;
  selectInkAt(screen: Point, additive: boolean): boolean;
  clearInkSelection(): void;
  hasInkSelection(): boolean;
  setInkSelection(ids: readonly string[]): void;
  selectAllInk(): void;
  setInkStyle(style: { color?: string; width?: number; opacity?: number }): void;
  getInkSelectedObjects(): PenObject[];
  /** The active pen-tool mode (pen / eraser / lasso), used by input + UI. */
  getPenToolMode(): PenToolMode;
  setPenToolMode(mode: PenToolMode): void;
  getPenSettings(): InkSettings;
  setPenSettings(patch: Partial<InkSettings>): void;
  /** Record recent stylus contact for palm rejection. */
  notePenActivity(): void;
  recentPenActivity(): boolean;

  // Lasso (pen tool, mode "lasso")
  beginLasso(screen: Point, additive: boolean): void;
  lassoTo(screen: Point): void;
  endLasso(): void;
  cancelLasso(): void;

  // Eraser hover guide (screen px)
  setEraserPreview(screen: Point | null): void;

  // Callbacks
  onContextMenu(screen: Point, world: Point): void;
  onMarqueeEnd(rect: Rect, additive: boolean): void;
}
