import type { Point, Rect } from "../../shared/geometry/viewport.js";
import { screenToWorld } from "../../shared/geometry/viewport.js";
import type { InteractionHost } from "./interactionHost.js";
import { isEditingText } from "../ui/textEditor.js";

/**
 * Pointer/keyboard state machine translating pointer, wheel, and (for
 * connection creation / space-pan) keyboard events into interaction-host calls.
 * Connection creation is keyboard-driven: holding Ctrl while hovering an object
 * starts a draft with no mouse button involved. Moves and resizes are driven
 * through the host's absolute grab/drag API (position = current pointer world
 * point + fixed grab offset), never by accumulating per-event deltas.
 */

type Mode = "none" | "pending" | "move" | "resize" | "marquee" | "pan" | "connect" | "pen";

const WHEEL_FACTOR_PER_NOTCH = 1.1;
const DRAG_THRESHOLD = 3;
const CONTROL_KEY = "Control";

export class CanvasInput {
  private mode: Mode = "none";
  private spaceHeld = false;
  private additive = false;
  private start = { x: 0, y: 0 };
  private last = { x: 0, y: 0 };
  private startWorld = { x: 0, y: 0 };
  private dragArmed = false;
  private ctrlHeld = false;
  private pos = { x: 0, y: 0 };

  constructor(private host: InteractionHost) {}

  attach(): void {
    const el = this.host.canvas();
    el.addEventListener("pointerdown", this.onPointerDown);
    el.addEventListener("pointermove", this.onPointerMove);
    el.addEventListener("pointerup", this.onPointerUp);
    el.addEventListener("pointercancel", this.onPointerUp);
    el.addEventListener("wheel", this.onWheel, { passive: false });
    el.addEventListener("contextmenu", this.onContextMenu);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  dispose(): void {
    const el = this.host.canvas();
    el.removeEventListener("pointerdown", this.onPointerDown);
    el.removeEventListener("pointermove", this.onPointerMove);
    el.removeEventListener("pointerup", this.onPointerUp);
    el.removeEventListener("pointercancel", this.onPointerUp);
    el.removeEventListener("wheel", this.onWheel);
    el.removeEventListener("contextmenu", this.onContextMenu);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.cancelConnect();
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    // Text editing has priority: while typing, the canvas must not intercept
    // space / shortcuts (so the text input receives space and other keys).
    if (isEditingText()) return;

    if (e.key === CONTROL_KEY) {
      if (e.repeat || this.ctrlHeld) return;
      this.ctrlHeld = true;
      e.preventDefault();
      this.maybeStartConnection();
      return;
    }

    if (e.code !== "Space" || e.repeat) return;
    this.spaceHeld = true;
    e.preventDefault();
    this.updateCursor();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (isEditingText()) {
      if (e.key === CONTROL_KEY) this.ctrlHeld = false;
      return;
    }

    if (e.key === CONTROL_KEY) {
      this.ctrlHeld = false;
      if (this.mode === "connect") {
        this.host.finishConnection(this.pos);
        this.cancelConnect();
      }
      this.updateCursor();
      return;
    }

    if (e.code !== "Space") return;
    this.spaceHeld = false;
    this.updateCursor();
  };

  private maybeStartConnection(): void {
    // Only start a draft when idle (no active mouse gesture) and hovering an
    // eligible object. A connection cannot source from another connection.
    if (this.mode !== "none") return;
    const hit = this.host.hitTest(this.pos);
    if (!hit) return;
    this.host.beginConnection(hit, this.pos);
    // beginConnection no-ops (no draft) for ineligible sources such as
    // connection objects — only enter connect mode when a draft was started.
    // We optimistically set mode; connectionDragTo/finishConnection are safe
    // no-ops when no draft exists on the host side.
    this.mode = "connect";
    this.host.setMarquee(null);
  }

  private cancelConnect(): void {
    if (this.mode === "connect") this.mode = "none";
  }

  private localPoint(e: PointerEvent | MouseEvent): Point {
    const rect = this.host.canvas().getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private onPointerDown = (e: PointerEvent): void => {
    const isPanButton = e.button === 1;
    const isLeft = e.button === 0;
    const isRight = e.button === 2;
    if (!isPanButton && !isLeft && !isRight) return;

    const p = this.localPoint(e);
    this.additive = e.shiftKey || e.ctrlKey || e.metaKey;

    // While a connection draft is active (Ctrl held, no click), ignore mouse
    // buttons so a stray click does not start a move/marquee.
    if (this.mode === "connect") return;

    if (isPanButton || this.spaceHeld) {
      this.mode = "pan";
      this.last = p;
      this.host.setMarquee(null);
      this.host.setInteractionCursor("pan");
      return;
    }

    if (isLeft) {
      this.handlePrimaryDown(p);
    }
  };

  private handlePrimaryDown(p: Point): void {
    this.start = p;
    this.last = p;

    // Pen tool: left-drag draws anywhere (objects or empty space).
    if (this.host.isPenTool()) {
      this.mode = "pen";
      this.host.startPenStroke(p);
      return;
    }

    // Resize handles take priority (they sit on the selection box edges).
    const handle = this.host.hitHandle(p);
    if (handle) {
      this.mode = "resize";
      this.host.beginResize(handle, p);
      this.host.setInteractionCursor("default");
      return;
    }

    const hit = this.host.hitTest(p);

    if (hit) {
      if (this.additive) {
        this.host.toggleSelection(hit);
      } else if (!this.host.inSelection(hit)) {
        this.host.setSelection([hit]);
      }
      // Grab the (possibly multi-)selection without resetting it.
      this.host.grabSelection(p);
      this.dragArmed = true;
      this.mode = "pending";
    } else {
      this.mode = "pending";
      this.dragArmed = false;
      if (!this.additive) {
        this.host.setSelection([]);
      }
    }
    this.host.setMarquee(null);
  }

  private onPointerMove = (e: PointerEvent): void => {
    const p = this.localPoint(e);
    const prev = this.last;
    this.last = p;
    this.pos = p;

    switch (this.mode) {
      case "pan":
        this.host.applyPan(p.x - prev.x, p.y - prev.y);
        break;
      case "move":
        this.host.dragTo(p);
        break;
      case "resize":
        this.host.resizeTo(p);
        break;
      case "connect":
        this.host.connectionDragTo(p);
        break;
      case "pen":
        this.host.penStrokeTo(p);
        break;
      case "marquee":
        this.updateMarquee(p);
        break;
      case "pending": {
        const dist = Math.hypot(p.x - this.start.x, p.y - this.start.y);
        if (dist <= DRAG_THRESHOLD) break;
        if (this.dragArmed) {
          this.mode = "move";
          this.host.setInteractionCursor("move");
          // Initial move to establish the absolute grab.
          this.host.dragTo(p);
        } else {
          this.mode = "marquee";
          this.startWorld = screenToWorld(this.start, this.host.getFrame());
          this.updateMarquee(p);
        }
        break;
      }
      case "none":
        break;
    }
  };

  private onPointerUp = (_e: PointerEvent): void => {
    // A connection draft is keyboard-driven (Ctrl keyup finishes it); a pointer
    // release must not cancel or finish it.
    if (this.mode === "connect") return;
    if (this.mode === "pen") {
      this.host.endPenStroke();
    } else {
      if (this.mode === "move") this.host.dropGrab();
      if (this.mode === "resize") this.host.endResize();
      if (this.mode === "marquee") this.onPointerUpMarqueeSettle();
    }
    this.mode = "none";
    this.dragArmed = false;
    this.updateCursor();
  };

  private updateMarquee(p: Point): void {
    const frame = this.host.getFrame();
    const cur = screenToWorld(p, frame);
    const x = Math.min(this.startWorld.x, cur.x);
    const y = Math.min(this.startWorld.y, cur.y);
    const rect: Rect = {
      x,
      y,
      width: Math.abs(cur.x - this.startWorld.x),
      height: Math.abs(cur.y - this.startWorld.y),
    };
    this.host.setMarquee(rect);
    // Report the live rect for selection preview (end applies the selection).
    this.lastMarqueeRect = rect;
  }

  private lastMarqueeRect: Rect | null = null;

  private onPointerUpMarqueeSettle(): void {
    if (this.lastMarqueeRect) {
      this.host.onMarqueeEnd(this.lastMarqueeRect, this.additive);
    }
    this.lastMarqueeRect = null;
    this.host.setMarquee(null);
  }

  private onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    const p = this.localPoint(e);
    const world = screenToWorld(p, this.host.getFrame());
    this.host.onContextMenu(p, world);
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const rect = this.host.canvas().getBoundingClientRect();
    const anchor: Point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const factor = Math.pow(WHEEL_FACTOR_PER_NOTCH, -e.deltaY / 100);
    this.host.applyAnchoredZoom(factor, anchor);
  };

  private updateCursor(): void {
    const kind = this.spaceHeld ? "grab" : this.mode === "pan" ? "pan" : "default";
    this.host.setInteractionCursor(kind);
  }
}
