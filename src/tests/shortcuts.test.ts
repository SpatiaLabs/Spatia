import { test } from "node:test";
import assert from "node:assert/strict";
import { shortcutIdFor, type ShortcutEventLike } from "../shared/input/shortcuts.js";

const ev = (over: Partial<ShortcutEventLike>): ShortcutEventLike => ({
  code: "",
  key: "",
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
});

test("plain modifier commands resolve by physical key", () => {
  assert.equal(shortcutIdFor(ev({ code: "KeyS", key: "s", ctrlKey: true })), "save");
  assert.equal(shortcutIdFor(ev({ code: "KeyZ", key: "z", ctrlKey: true })), "undo");
  assert.equal(shortcutIdFor(ev({ code: "KeyY", key: "y", ctrlKey: true })), "redo-alt");
  assert.equal(shortcutIdFor(ev({ code: "KeyK", key: "k", ctrlKey: true })), "command-palette");
  assert.equal(shortcutIdFor(ev({ code: "KeyV", key: "v", ctrlKey: true })), "paste");
  assert.equal(shortcutIdFor(ev({ code: "KeyD", key: "d", ctrlKey: true })), "duplicate");
  assert.equal(shortcutIdFor(ev({ code: "KeyA", key: "a", ctrlKey: true })), "select-all");
  assert.equal(shortcutIdFor(ev({ code: "KeyF", key: "f", ctrlKey: true })), "search");
});

test("Cmd (meta) behaves exactly like Ctrl", () => {
  assert.equal(shortcutIdFor(ev({ code: "KeyS", key: "s", metaKey: true })), "save");
  assert.equal(shortcutIdFor(ev({ code: "KeyC", key: "c", metaKey: true })), "copy");
});

test("shift disambiguates colliding pairs (no swallowed connect)", () => {
  assert.equal(shortcutIdFor(ev({ code: "KeyC", key: "c", ctrlKey: true })), "copy");
  assert.equal(shortcutIdFor(ev({ code: "KeyC", key: "C", ctrlKey: true, shiftKey: true })), "connect");
  assert.equal(shortcutIdFor(ev({ code: "KeyG", key: "g", ctrlKey: true })), "group");
  assert.equal(shortcutIdFor(ev({ code: "KeyG", key: "G", ctrlKey: true, shiftKey: true })), "ungroup");
  assert.equal(shortcutIdFor(ev({ code: "KeyZ", key: "z", ctrlKey: true, shiftKey: true })), "redo");
});

test("Ctrl+Shift+S is not a plain save", () => {
  assert.equal(shortcutIdFor(ev({ code: "KeyS", key: "S", ctrlKey: true, shiftKey: true })), null);
});

test("the physical code wins over a layout-specific key value", () => {
  // A Cyrillic layout reports key "ы" but the physical key is still KeyS.
  assert.equal(shortcutIdFor(ev({ code: "KeyS", key: "ы", ctrlKey: true })), "save");
  // Without `code`, the resolver still falls back to `key`.
  assert.equal(shortcutIdFor(ev({ code: "", key: "s", ctrlKey: true })), "save");
  // And to keyCode as a last resort.
  assert.equal(shortcutIdFor(ev({ code: "", key: "", keyCode: 83, ctrlKey: true })), "save");
});

test("AltGr (ctrl+alt) never fires a plain command", () => {
  assert.equal(shortcutIdFor(ev({ code: "KeyS", key: "s", ctrlKey: true, altKey: true })), null);
  assert.equal(shortcutIdFor(ev({ code: "KeyC", key: "c", ctrlKey: true, altKey: true })), null);
});

test("no modifier means no command (letters stay free for tools)", () => {
  assert.equal(shortcutIdFor(ev({ code: "KeyS", key: "s" })), null);
  assert.equal(shortcutIdFor(ev({ code: "KeyC", key: "c" })), null);
});

test("delete keys resolve with or without modifiers; escape is left alone", () => {
  assert.equal(shortcutIdFor(ev({ key: "Delete" })), "delete");
  assert.equal(shortcutIdFor(ev({ key: "Backspace" })), "delete");
  assert.equal(shortcutIdFor(ev({ key: "Backspace", ctrlKey: true })), "delete");
  assert.equal(shortcutIdFor(ev({ key: "Escape" })), null);
  assert.equal(shortcutIdFor(ev({ code: "Digit1", key: "1", ctrlKey: true })), null);
});
