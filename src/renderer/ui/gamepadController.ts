/**
 * GamepadController — the runtime half of controller support.
 *
 * Polls `navigator.getGamepads()` once per animation frame, converts the raw
 * pad into a deadzoned frame (see shared/input/gamepad.ts) and forwards the
 * result to the host:
 *  - continuous left/right stick to `panByScreen` and `zoomByFactor`;
 *  - button *edges* (never held repeats) to `onButton`, so one press is one
 *    command and holding a button cannot spam undo/delete.
 *
 * It is deliberately defensive: with no Gamepad API, no connected pad, or while
 * a text field/modal owns focus it does nothing, so mouse, keyboard, stylus and
 * touch continue to behave exactly as before. Connection/disconnection are
 * surfaced through `onConnectionChange` so the app can report the mapping.
 */
import {
  DEFAULT_DEADZONE,
  firstConnected,
  newlyPressed,
  readGamepadFrame,
  type GamepadButtonId,
} from "../../shared/input/gamepad.js";

export interface GamepadHooks {
  /** Pan by a screen-space drag delta (content follows the stick). */
  panByScreen(dx: number, dy: number): void;
  /** Multiply the zoom by `factor` (anchored at the viewport centre). */
  zoomByFactor(factor: number): void;
  /** A button was pressed this frame (edge). */
  onButton(id: GamepadButtonId): void;
  /** True while a text field / modal should swallow controller commands. */
  isInputBlocked(): boolean;
  /** Connection state changed (for a status hint). */
  onConnectionChange(connected: boolean): void;
}

/** Pixels of pan per second at full stick deflection. */
const PAN_SPEED = 950;
/** Zoom e-folds per second at full right-stick deflection. */
const ZOOM_RATE = 2.2;

export class GamepadController {
  private raf = 0;
  private last = 0;
  private prev = new Set<GamepadButtonId>();
  private connected = false;

  constructor(
    private readonly hooks: GamepadHooks,
    private readonly deadzone = DEFAULT_DEADZONE
  ) {}

  static isSupported(): boolean {
    return (
      typeof navigator !== "undefined" &&
      typeof (navigator as Navigator & { getGamepads?: () => unknown }).getGamepads === "function"
    );
  }

  get isConnected(): boolean {
    return this.connected;
  }

  start(): void {
    if (!GamepadController.isSupported() || this.raf !== 0) return;
    window.addEventListener("gamepadconnected", this.onConnect);
    window.addEventListener("gamepaddisconnected", this.onDisconnect);
    this.last = now();
    this.raf = requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (this.raf !== 0) cancelAnimationFrame(this.raf);
    this.raf = 0;
    window.removeEventListener("gamepadconnected", this.onConnect);
    window.removeEventListener("gamepaddisconnected", this.onDisconnect);
    this.prev.clear();
  }

  private onConnect = (): void => {
    if (!this.connected) {
      this.connected = true;
      this.hooks.onConnectionChange(true);
    }
  };

  private onDisconnect = (): void => {
    this.connected = false;
    this.prev.clear();
    this.hooks.onConnectionChange(false);
  };

  private tick = (nowMs: number): void => {
    this.raf = requestAnimationFrame(this.tick);
    const dt = Math.min(0.05, Math.max(0, (nowMs - this.last) / 1000));
    this.last = nowMs;

    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = firstConnected(pads);
    if (!gp) {
      if (this.connected) {
        this.connected = false;
        this.hooks.onConnectionChange(false);
      }
      this.prev.clear();
      return;
    }
    if (!this.connected) {
      this.connected = true;
      this.hooks.onConnectionChange(true);
    }

    const frame = readGamepadFrame(gp, this.deadzone);
    if (!this.hooks.isInputBlocked()) {
      if (frame.panX !== 0 || frame.panY !== 0) {
        this.hooks.panByScreen(frame.panX * PAN_SPEED * dt, frame.panY * PAN_SPEED * dt);
      }
      if (frame.secondaryX !== 0) {
        this.hooks.panByScreen(frame.secondaryX * PAN_SPEED * dt, 0);
      }
      if (frame.zoomY !== 0) {
        // Right stick up (negative axis) zooms in.
        this.hooks.zoomByFactor(Math.exp(-frame.zoomY * ZOOM_RATE * dt));
      }
      for (const button of newlyPressed(this.prev, frame)) {
        this.hooks.onButton(button);
      }
    }
    this.prev = frame.pressed;
  };
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
