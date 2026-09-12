/**
 * Shared editable-target guard for global (window/document-level) keyboard and
 * paste handlers.
 *
 * The canvas input layer listens for key events at the window level so that
 * Space-pan and Ctrl-drag connection drafting work no matter what inside the
 * shell has focus. That same globality is dangerous: any editable control
 * (input, textarea, contenteditable), or an in-progress IME composition, must
 * keep full ownership of the keys it is typing. A global handler that calls
 * preventDefault() on such a target eats the very first keystroke (for Space
 * the first press is lost and only the auto-repeat leaks through, which is
 * exactly the "press hard / press again" symptom). Every window-level key or
 * paste handler must consult this guard before consuming anything.
 */
export function isEditableEventTarget(e: { target: EventTarget | null }): boolean {
  const t = e.target as HTMLElement | null;
  if (t) {
    if (t.isContentEditable) return true;
    const tag = t.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return true;
  }
  // IME composition: while composing, key events carry a surrogate keyCode and
  // the committed text is delivered through composition/beforeinput. Acting on
  // (or preventDefault-ing) those events can swallow the commit keystroke.
  if (e instanceof KeyboardEvent && e.isComposing) return true;
  return false;
}