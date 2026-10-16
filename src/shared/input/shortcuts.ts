/**
 * Central keyboard-shortcut resolution.
 *
 * Spatia handles its workspace shortcuts at the window level (so they work
 * whichever part of the shell has focus) and on both the desktop and web
 * builds. Historically each handler compared `KeyboardEvent.key` directly
 * (`e.key.toLowerCase() === "s"`). That is fragile: `key` is *layout and
 * modifier dependent* — non-Latin layouts, dead keys and Windows `AltGr`
 * (reported as `ctrlKey + altKey`) all produce a different `key` for the same
 * physical key, which is exactly why "Ctrl shortcuts sometimes fail".
 *
 * This module resolves a canonical shortcut id from the *physical* key
 * (`KeyboardEvent.code`) with a `key` fallback, and encodes the modifier rules
 * in one place so there are no order-of-checks bugs (e.g. Ctrl+Shift+C being
 * swallowed by the plain Ctrl+C copy branch). It is pure and dependency-free
 * so it is unit-testable in Node and shared by the renderer and the tablet UI.
 */

export type ShortcutId =
  | "save"
  | "undo"
  | "redo"
  | "redo-alt"
  | "command-palette"
  | "copy"
  | "paste"
  | "duplicate"
  | "select-all"
  | "search"
  | "group"
  | "ungroup"
  | "connect"
  | "delete";

/** The subset of a `KeyboardEvent` the resolver needs (keeps tests DOM-free). */
export interface ShortcutEventLike {
  /** `KeyboardEvent.code` — physical key, e.g. "KeyS". Preferred. */
  code?: string;
  /** `KeyboardEvent.key` — fallback and used for Delete/Backspace. */
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  /** Some browsers spill the physical key only onto `keyCode`. */
  keyCode?: number;
}

/** The physical letter for a key event, lower-cased, or null. */
function letterFor(e: ShortcutEventLike): string | null {
  const code = e.code ?? "";
  // "KeyS" -> "s" (a physical key, unaffected by the active layout).
  if (code.length === 4 && code.startsWith("Key")) return code.slice(3).toLowerCase();
  // "Digit1" etc. are irrelevant here, but a one-character key is a safe
  // fallback for hosts that do not populate `code`.
  if (typeof e.key === "string" && e.key.length === 1) return e.key.toLowerCase();
  if (typeof e.keyCode === "number" && e.keyCode >= 65 && e.keyCode <= 90) {
    return String.fromCharCode(e.keyCode).toLowerCase();
  }
  return null;
}

/**
 * Resolve a workspace shortcut, or null when the event is not one. Rules:
 *  - Delete/Backspace delete the selection (with or without modifiers); Escape
 *    is intentionally left to the caller's richer logic.
 *  - Every other shortcut requires Ctrl or Cmd.
 *  - `AltGr` masquerades as Ctrl+Alt, so an event with Alt set is never a plain
 *    command (this is the main "Ctrl sometimes fails / misfires" fix).
 *  - Shift disambiguates the pairs that would otherwise collide: Ctrl+Shift+C
 *    (connect) vs Ctrl+C (copy), Ctrl+Shift+G (ungroup) vs Ctrl+G (group),
 *    Ctrl+Shift+Z (redo) vs Ctrl+Z (undo).
 *  - Ctrl+Shift+S is deliberately *not* save (no save-as binding exists here),
 *    so it resolves to null instead of silently triggering a plain save.
 */
export function shortcutIdFor(e: ShortcutEventLike): ShortcutId | null {
  if (e.key === "Delete" || e.key === "Backspace") return "delete";
  const mod = !!(e.ctrlKey || e.metaKey);
  if (!mod) return null;
  if (e.altKey) return null;
  const letter = letterFor(e);
  if (!letter) return null;
  const shift = !!e.shiftKey;
  switch (letter) {
    case "s":
      return shift ? null : "save";
    case "z":
      return shift ? "redo" : "undo";
    case "y":
      return "redo-alt";
    case "k":
      return "command-palette";
    case "c":
      return shift ? "connect" : "copy";
    case "v":
      return "paste";
    case "d":
      return "duplicate";
    case "a":
      return "select-all";
    case "f":
      return "search";
    case "g":
      return shift ? "ungroup" : "group";
    default:
      return null;
  }
}
