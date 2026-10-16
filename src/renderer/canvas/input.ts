import type { Point, Rect } from "../../shared/geometry/viewport.js";
import { screenToWorld } from "../../shared/geometry/viewport.js";
import type { InteractionHost } from "./interactionHost.js";
import { isEditableEventTarget } from "../ui/editTarget.js";

/**
 * Pointer/keyboard state machine translating pointer, wheel, and (for
 * connection creation / space-pan) keyboard events into interaction-host calls.
 * Connection creation is keyboard-driven: holding Ctrl while hovering an object
 * starts a draft with no mouse button involved. Moves and resizes are driven
 * through the host's absolute grab/drag API (position = current pointer world
 * point + fixed grab offset), never by accumulating per-event deltas.
 */

type Mode = "none" | "pending" | "move" | "resize" | "marquee" | "pan" | "connect" | "pen" | "rotate" | "inkmove" | "lasso" | "reconnect";

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
  private inkDragArmed = false;
  /** Only the primary pointer drives gestures (a second finger on a touch
   *  surface must never interrupt a stroke or start a marquee). */
  private activePointerId: number | null = null;
  private ctrlHeld = false;
  private pos = { x: 0, y: 0 };
  /** True while a pointer-drag connection gesture (from an edge handle). */
  private connectDrag = false;

  constructor(private host: InteractionHost) {}

  attach(): void {
    const el = this.host.canvas();
    el.addEventListener("pointerdown", this.onPointerDown);
    el.addEventListener("pointermove", this.onPointerMove);
    el.addEventListener("pointerup", this.onPointerUp);
    el.addEventListener("pointercancel", this.onPointerUp);
    el.addEventListener("pointerleave", this.onPointerLeave);
    el.addEventListener("wheel", this.onWheel, { passive: false });
    el.addEventListener("contextmenu", this.onContextMenu);
    el.addEventListener("lostpointercapture", this.onLostPointerCapture);
    window.addEventListener("blur", this.onWindowBlur);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  dispose(): void {
    const el = this.host.canvas();
    el.removeEventListener("pointerdown", this.onPointerDown);
    el.removeEventListener("pointermove", this.onPointerMove);
    el.removeEventListener("pointerup", this.onPointerUp);
    el.removeEventListener("pointercancel", this.onPointerUp);
    el.removeEventListener("pointerleave", this.onPointerLeave);
    el.removeEventListener("wheel", this.onWheel);
    el.removeEventListener("contextmenu", this.onContextMenu);
    el.removeEventListener("lostpointercapture", this.onLostPointerCapture);
    window.removeEventListener("blur", this.onWindowBlur);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.cancelConnect();
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    // Text editing has priority: while the user is typing in any editable
    // control (or an IME composition is in progress), the canvas must not
    // intercept space / shortcuts, so the input receives everything natively.
    if (isEditableEventTarget(e)) return;

if (e.key === CONTROL_KEY) {
      if (e.repeat || this.ctrlHeld) return;
      this.ctrlHeld = true;
      e.preventDefault();
      this.maybeStartConnection();
      return;
    }

    // Cancel an in-progress ink lasso (Escape); the app handles the rest.
    if (e.key === "Escape" && this.mode === "lasso") {
      e.preventDefault();
      this.host.cancelLasso();
      this.mode = "none";
      this.dragArmed = false;
      this.inkDragArmed = false;
      this.activePointerId = null;
      this.updateCursor();
      return;
    }

    if (e.code !== "Space" || e.repeat) return;
    this.spaceHeld = true;
    e.preventDefault();
    this.updateCursor();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    // Key releases must always clear held state (even when focus moved into an
    // editable control mid-press) so no stale space/ctrl state survives.
    if (e.code === "Space") {
      this.spaceHeld = false;
      this.updateCursor();
      return;
    }
    if (e.key !== CONTROL_KEY) return;
    this.ctrlHeld = false;
    if (this.mode === "connect") {
      this.host.finishConnection(this.pos);
      this.cancelConnect();
    }
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

    // Multi-touch + palm rejection: ignore secondary pointers entirely, and
    // ignore a second touch arriving right after stylus contact (the resting
    // palm often lands a few hundred ms after the pen tip).
    if (this.activePointerId !== null && e.pointerId !== this.activePointerId) return;
    if (!e.isPrimary && e.pointerType === "touch") return;
    if (e.pointerType === "touch" && this.host.recentPenActivity()) return;

    const p = this.localPoint(e);
    this.additive = e.shiftKey || e.ctrlKey || e.metaKey;

    // While a connection draft is active (Ctrl held, no click), ignore mouse
    // buttons so a stray click does not start a move/marquee.
    if (this.mode === "connect") return;

    if (isPanButton || this.spaceHeld) {
      this.mode = "pan";
      this.last = p;
      this.activePointerId = e.pointerId;
      this.host.setMarquee(null);
      this.host.setInteractionCursor("pan");
      return;
    }

    if (isLeft) {
      // Record stylus contact for palm rejection and to keep the eraser guide
      // honest before the first move event.
      if (e.pointerType === "pen") this.host.notePenActivity();
      this.handlePrimaryDown(p, e);
      if (this.mode !== "none") this.activePointerId = e.pointerId;
    }
  };

  /**
   * Stylus pressure, only trusted when the pointer really is a pen: mouse /
   * touch report arbitrary values and would add noise to the stroke shape.
   */
  private penPressure(e: PointerEvent): number | undefined {
    if (e.pointerType !== "pen") return undefined;
    return e.pressure > 0 ? e.pressure : undefined;
  }

  /**
   * Hold explicit pointer capture while a pen stroke is active. Implicit
   * capture usually covers a held button, but some pen drivers drop moves the
   * instant the tip orbits the canvas edge; explicit capture keeps the stroke
   * routed to the canvas and only ends on release / lostpointercapture.
   */
  private captureActivePointer(e: PointerEvent): void {
    const el = this.host.canvas();
    if (typeof el.setPointerCapture !== "function") return;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic dispatch (tests) or a pointer already released — fine.
    }
  }

  private handlePrimaryDown(p: Point, e: PointerEvent): void {
    this.start = p;
    this.last = p;
    this.inkDragArmed = false;

    // Pen tool: left-drag draws anywhere (objects or empty space).
    if (this.host.isPenTool()) {
      const toolMode = this.host.getPenToolMode();
      if (toolMode === "lasso") {
        this.mode = "lasso";
        this.host.beginLasso(p, this.additive);
        this.host.setMarquee(null);
        return;
      }
      this.mode = "pen";
      this.host.startPenStroke(p, this.penPressure(e));
      this.captureActivePointer(e);
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

    // Rotation knob lives above the selection box (touch hosts only).
    if (this.host.hitRotateHandle(p)) {
      this.mode = "rotate";
      this.host.beginRotate(p);
      this.host.setMarquee(null);
      return;
    }

    // Reconnection: grab an endpoint dot on a selected connection and drag it
    // onto a new target (Obsidian-style re-bind).
    const endpoint = this.host.hitConnectionEndpoint(p);
    if (endpoint) {
      this.mode = "reconnect";
      this.host.beginReconnect(endpoint.id, endpoint.end, p);
      this.host.setMarquee(null);
      this.host.setInteractionCursor("copy");
      this.captureActivePointer(e);
      return;
    }

    // Drag-to-connect: grab an edge handle that appears when hovering an object.
    const connectHandle = this.host.hitConnectHandle(p);
    if (connectHandle) {
      this.mode = "connect";
      this.connectDrag = true;
      this.host.beginConnection(connectHandle.id, p, connectHandle.side);
      this.host.setMarquee(null);
      this.host.setInteractionCursor("copy");
      this.captureActivePointer(e);
      return;
    }

    const hit = this.host.hitTest(p);

    // Freehand strokes are first-class ink: a click selects them through the
    // dedicated ink selection (never the generic object selection), and a drag
    // moves the whole selection through the ink controller.
    if (hit && this.host.isInkId(hit)) {
      if (!this.additive) this.host.setSelection([]);
      const selected = this.host.selectInkAt(p, this.additive);
      if (selected) {
        this.host.prepareInkDrag(p);
        this.dragArmed = true;
        this.inkDragArmed = true;
      } else {
        this.dragArmed = false;
      }
      this.mode = "pending";
      this.host.setMarquee(null);
      return;
    }

    if (hit) {
      if (!this.additive) this.host.clearInkSelection();
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
        this.host.clearInkSelection();
      }
    }
    this.host.setMarquee(null);
  }

  private onPointerMove = (e: PointerEvent): void => {
    const p = this.localPoint(e);
    const prev = this.last;
    this.last = p;
    this.pos = p;

    // Only the pointer that started the gesture drives it; stray fingers must
    // never steer a stroke.
    if (this.activePointerId !== null && e.pointerId !== this.activePointerId) return;

    // Eraser hover guide (pen tool, eraser mode): show the erase radius even
    // before the user presses, so a sweep lands exactly where intended.
    if (this.host.isPenTool() && this.host.getPenToolMode() === "eraser" && this.mode !== "pen") {
      this.host.setEraserPreview(p);
    }

    // Idle hover: reveal the Obsidian-style edge handles on the object under
    // the pointer so a connection can be dragged out directly.
    if (this.mode === "none" && !this.host.isPenTool()) {
      this.host.hoverAt(p);
    }

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
      case "rotate":
        this.host.rotateTo(p);
        break;
      case "connect":
        this.host.connectionDragTo(p);
        break;
      case "reconnect":
        this.host.reconnectDragTo(p);
        break;
      case "pen":
        this.host.penStrokeTo(p, this.penPressure(e));
        break;
      case "inkmove":
        this.host.inkDragTo(p);
        break;
      case "lasso":
        this.host.lassoTo(p);
        break;
      case "marquee":
        this.updateMarquee(p);
        break;
      case "pending": {
        const dist = Math.hypot(p.x - this.start.x, p.y - this.start.y);
        if (dist <= DRAG_THRESHOLD) break;
        if (this.dragArmed) {
          if (this.inkDragArmed) {
            this.mode = "inkmove";
            this.host.inkDragTo(p);
          } else {
            this.mode = "move";
            this.host.setInteractionCursor("move");
            // Initial move to establish the absolute grab.
            this.host.dragTo(p);
          }
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

  /** The cursor left the canvas — drop the eraser guide (no more hover data). */
  private onPointerLeave = (): void => {
    this.host.setEraserPreview(null);
    this.host.clearHover();
  };

  private onPointerUp = (e: PointerEvent): void => {
    // A pointer-driven connection drag finishes on release; the keyboard-driven
    // Ctrl draft is instead finished by the Ctrl keyup.
    if (this.mode === "connect") {
      if (this.connectDrag) {
        this.host.finishConnection(this.localPoint(e));
        this.host.clearHover();
        this.connectDrag = false;
        this.endActiveInteraction();
      }
      return;
    }
    if (this.mode === "reconnect") {
      this.host.finishReconnect(this.localPoint(e));
      this.host.clearHover();
      this.endActiveInteraction();
      return;
    }
    const el = this.host.canvas();
    if (typeof el.releasePointerCapture === "function") {
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        // Pointer was never captured (non-pen gestures) — safe to ignore.
      }
    }
    this.endActiveInteraction();
  };

  /**
   * The window/document lost focus (or the pointer capture was lost) while an
   * interaction was in progress. The browser keeps routing pointer moves to the
   * canvas via implicit pointer capture as long as the button is held, so an
   * active resize/move/pen/marquee WOULD otherwise continue from wherever the
   * cursor reappears after focus returns. Terminate the interaction now so no
   * stale drag state survives a focus change. Browsers can drop key events sent
   * to a blurred window, so also clear any held modifier state.
   */
  private onWindowBlur = (): void => {
    this.endActiveInteraction();
    this.cancelConnect();
    this.forceClearHeldKeys();
  };

  private onLostPointerCapture = (_e: PointerEvent): void => {
    this.endActiveInteraction();
    this.cancelConnect();
  };

  private forceClearHeldKeys(): void {
    this.ctrlHeld = false;
    this.spaceHeld = false;
  }

  /** Finalize the currently active mouse gesture and reset the interaction. */
  private endActiveInteraction(): void {
    if (this.mode === "pen") {
      this.host.endPenStroke();
    } else {
      if (this.mode === "move") this.host.dropGrab();
      if (this.mode === "resize") this.host.endResize();
      if (this.mode === "rotate") this.host.endRotate();
      if (this.mode === "inkmove") this.host.endInkDrag();
      if (this.mode === "lasso") this.host.endLasso();
      if (this.mode === "marquee") this.onPointerUpMarqueeSettle();
      // A pointer-driven connection drag that ends without an explicit finish
      // (blur, lost capture) must drop its draft rather than leave it hanging.
      if (this.mode === "connect" && this.connectDrag) this.host.cancelConnectionDraft();
      if (this.mode === "reconnect") this.host.cancelReconnect();
    }
    this.mode = "none";
    this.connectDrag = false;
    this.dragArmed = false;
    this.inkDragArmed = false;
    this.activePointerId = null;
    this.lastMarqueeRect = null;
    this.updateCursor();
  }

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
