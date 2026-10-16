/**
 * Gamepad support — the pure half.
 *
 * A controller has to drive the *real* workspace (pan, zoom, selection, tools,
 * commands), not a demo. This module turns a raw Web Gamepad snapshot into a
 * small, deterministic frame (deadzoned sticks + a set of pressed buttons) and
 * computes button *edges* so a held button fires once. The renderer's
 * `GamepadController` polls this each animation frame and forwards the results
 * to the existing engine/app commands.
 *
 * The module is DOM-free (it takes a structural `GamepadLike`, not a real
 * `Gamepad`) so the mapping, dead zone and edge detection are unit-testable in
 * Node without a physical controller.
 *
 * Default mapping (also documented in the README):
 *   Left stick .......... pan the canvas
 *   Right stick X/Y ..... horizontal pan / zoom
 *   A ................... activate (open) the selection, else add a note
 *   B ................... cancel (clear selection / exit isolation)
 *   X ................... delete the selection
 *   Y ................... duplicate the selection
 *   LB / RB ............. undo / redo
 *   LT / RT ............. brush size down / up
 *   Back (View) ......... toggle the tool sidebar
 *   Start (Menu) ........ command palette
 *   L3 / R3 ............. reset view / reset zoom to 100%
 *   D-pad up / down ..... select the previous / next object
 *   D-pad left / right .. previous / next tool
 */

export type GamepadButtonId =
  | "a"
  | "b"
  | "x"
  | "y"
  | "lb"
  | "rb"
  | "lt"
  | "rt"
  | "back"
  | "start"
  | "l3"
  | "r3"
  | "dpad-up"
  | "dpad-down"
  | "dpad-left"
  | "dpad-right";

/** Standard Gamepad button index -> id. */
export const GAMEPAD_BUTTONS: readonly GamepadButtonId[] = [
  "a", "b", "x", "y",
  "lb", "rb", "lt", "rt",
  "back", "start", "l3", "r3",
  "dpad-up", "dpad-down", "dpad-left", "dpad-right",
];

/** Minimal structural view of a Web Gamepad (so tests need no DOM). */
export interface GamepadLike {
  axes: ReadonlyArray<number>;
  buttons: ReadonlyArray<{ pressed?: boolean; value?: number }>;
}

export interface GamepadFrame {
  /** Left-stick pan, deadzoned and rescaled to -1..1. */
  panX: number;
  panY: number;
  /** Right-stick horizontal pan. */
  secondaryX: number;
  /** Right-stick vertical zoom driver (-1 = out, +1 = in). */
  zoomY: number;
  /** Everything currently down, as a set for cheap edge diffing. */
  pressed: Set<GamepadButtonId>;
}

export const DEFAULT_DEADZONE = 0.18;

/**
 * Radial-style dead zone with rescaling: values inside the dead zone read as 0,
 * and values outside are rescaled so motion starts smoothly from 0 (no jump at
 * the threshold). Independent per axis, which is the predictable choice for
 * pan/zoom control.
 */
export function applyDeadzone(value: number, deadzone = DEFAULT_DEADZONE): number {
  if (!Number.isFinite(value)) return 0;
  const dz = Math.min(0.9, Math.max(0, deadzone));
  const mag = Math.abs(value);
  if (mag <= dz) return 0;
  const scaled = (mag - dz) / (1 - dz);
  return Math.min(1, scaled) * Math.sign(value);
}

/** Read the standard-mapped axes/buttons of a gamepad into a frame. */
export function readGamepadFrame(gp: GamepadLike | null | undefined, deadzone = DEFAULT_DEADZONE): GamepadFrame {
  const axes = gp?.axes ?? [];
  const buttons = gp?.buttons ?? [];
  const axis = (i: number): number => (typeof axes[i] === "number" ? axes[i] : 0);
  const pressed = new Set<GamepadButtonId>();
  for (let i = 0; i < GAMEPAD_BUTTONS.length; i++) {
    const b = buttons[i];
    if (b && (b.pressed === true || (typeof b.value === "number" && b.value > 0.5))) {
      pressed.add(GAMEPAD_BUTTONS[i]);
    }
  }
  return {
    panX: applyDeadzone(axis(0), deadzone),
    panY: applyDeadzone(axis(1), deadzone),
    secondaryX: applyDeadzone(axis(2), deadzone),
    zoomY: applyDeadzone(axis(3), deadzone),
    pressed,
  };
}

/** Buttons that are down now but were not down on the previous frame. */
export function newlyPressed(prev: ReadonlySet<GamepadButtonId>, frame: GamepadFrame): GamepadButtonId[] {
  const out: GamepadButtonId[] = [];
  for (const id of frame.pressed) if (!prev.has(id)) out.push(id);
  return out;
}

/** Pick the first connected gamepad from a `navigator.getGamepads()` list. */
export function firstConnected(pads: ReadonlyArray<GamepadLike | null | undefined>): GamepadLike | null {
  for (const p of pads) if (p) return p;
  return null;
}
