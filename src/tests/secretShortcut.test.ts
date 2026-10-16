import { test } from "node:test";
import assert from "node:assert/strict";
import { isSecretShortcut, type SecretShortcutEvent } from "../shared/input/secretShortcut.js";

function ev(key: string, over: Partial<SecretShortcutEvent> = {}): SecretShortcutEvent {
  return { key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false, ...over };
}

test("Alt+I fires the secret shortcut", () => {
  assert.equal(isSecretShortcut(ev("i", { altKey: true })), true);
  assert.equal(isSecretShortcut(ev("I", { altKey: true })), true, "the letter case is irrelevant");
});

test("a bare I is inert", () => {
  assert.equal(isSecretShortcut(ev("i")), false);
});

test("Ctrl+I and Ctrl+Shift+I (devtools) are never the chord", () => {
  assert.equal(isSecretShortcut(ev("i", { ctrlKey: true })), false);
  assert.equal(isSecretShortcut(ev("i", { ctrlKey: true, shiftKey: true })), false);
  assert.equal(isSecretShortcut(ev("i", { ctrlKey: true, altKey: true })), false, "Ctrl+Alt+I is a different chord");
});

test("Cmd (meta) and Shift variants are ignored", () => {
  assert.equal(isSecretShortcut(ev("i", { metaKey: true, altKey: true })), false);
  assert.equal(isSecretShortcut(ev("i", { altKey: true, shiftKey: true })), false);
});

test("Alt plus any other key does not fire", () => {
  assert.equal(isSecretShortcut(ev("p", { altKey: true })), false);
  assert.equal(isSecretShortcut(ev("escape", { altKey: true })), false);
  assert.equal(isSecretShortcut(ev("Enter", { altKey: true })), false);
});

test("auto-repeat never fires, even with Alt+I held down", () => {
  assert.equal(isSecretShortcut(ev("i", { altKey: true, repeat: true })), false);
});

test("the exact Alt, no-Ctrl/Cmd/Shift combination is required", () => {
  const good = ev("i", { altKey: true });
  assert.equal(isSecretShortcut(good), true);
  assert.equal(isSecretShortcut({ ...good, altKey: false }), false);
  assert.equal(isSecretShortcut({ ...good, ctrlKey: true }), false);
  assert.equal(isSecretShortcut({ ...good, metaKey: true }), false);
  assert.equal(isSecretShortcut({ ...good, shiftKey: true }), false);
});
