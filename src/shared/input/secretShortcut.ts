/**
 * The hidden tablet-interface shortcut: a single keyboard chord.
 *
 * This is deliberately a pure predicate — no DOM, no mutable state — so the
 * exact activation semantics can be unit-tested and reused by the renderer
 * without pulling in browser globals. A single chord needs no arming state
 * machine (an earlier two-step chord was removed).
 *
 * Design guarantees:
 *  - The chord is a bare letter plus one modifier, with NO Ctrl/Cmd and NO
 *    Shift, so the browser's Ctrl+I / Ctrl+Shift+I (devtools) and plain typing
 *    are all left untouched.
 *  - Ignores OS key auto-repeat (`ev.repeat`) so holding the keys fires once.
 *  - The renderer only runs it when no text field or editable control has
 *    focus, so the chord can never swallow typing.
 */

export const SECRET_SHORTCUT_KEY = "i";

export interface SecretShortcutEvent {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  /** OS key auto-repeat flag (KeyboardEvent.repeat). */
  repeat?: boolean;
}

/** True when this keydown is the secret chord. */
export function isSecretShortcut(ev: SecretShortcutEvent): boolean {
  if (ev.repeat) return false;
  if (!ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return false;
  return ev.key.toLowerCase() === SECRET_SHORTCUT_KEY;
}
