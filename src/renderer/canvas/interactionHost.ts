import type { ViewportFrame, Point, Rect } from "../../shared/geometry/viewport.js";
import type { Handle } from "../../shared/geometry/selection.js";
import type { ObjectKind } from "../../shared/types/object.js";
import type { Command } from "../command/commandManager.js";

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
  /** World-space AABB of the current selection, or null. */
  selectionWorldBounds(): Rect | null;

  // Move gesture
  grabSelection(screen: Point): void;
  dragTo(screen: Point): void;
  dropGrab(): void;

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

  // Connection gesture (Ctrl + drag between two objects)
  beginConnection(fromId: string, screen: Point): void;
  connectionDragTo(screen: Point): void;
  /** Create a connection from the gesture's source to the object under the
   *  pointer (if valid), returning the new connection id or null. */
  finishConnection(screen: Point): string | null;

  // Pen tool (freehand drawing). Separate from connections.
  isPenTool(): boolean;
  setPenTool(on: boolean): void;
  startPenStroke(screen: Point): void;
  penStrokeTo(screen: Point): void;
  endPenStroke(): void;

  // Callbacks
  onContextMenu(screen: Point, world: Point): void;
  onMarqueeEnd(rect: Rect, additive: boolean): void;
}
