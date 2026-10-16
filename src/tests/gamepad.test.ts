import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DEADZONE,
  GAMEPAD_BUTTONS,
  applyDeadzone,
  firstConnected,
  newlyPressed,
  readGamepadFrame,
  type GamepadLike,
} from "../shared/input/gamepad.js";

function pad(axe: number[], held: number[] = []): GamepadLike {
  const buttons = Array.from({ length: 16 }, (_, i) => ({ pressed: held.includes(i), value: held.includes(i) ? 1 : 0 }));
  return { axes: axe, buttons };
}

test("dead zone zeroes small deflections and rescales the rest", () => {
  assert.equal(applyDeadzone(0, 0.2), 0);
  assert.equal(applyDeadzone(0.1, 0.2), 0);
  assert.equal(applyDeadzone(-0.2, 0.2), 0);
  // Just outside the dead zone ramps smoothly from 0, not a jump to 0.2.
  assert.ok(applyDeadzone(0.21, 0.2) < 0.05);
  assert.equal(applyDeadzone(1, 0.2), 1);
  assert.equal(applyDeadzone(-1, 0.2), -1);
  assert.equal(applyDeadzone(NaN, 0.2), 0);
});

test("sticks map to pan/zoom axes with the default dead zone", () => {
  const frame = readGamepadFrame(pad([0.8, -0.8, 0.5, -0.5]));
  assert.ok(frame.panX > 0.5 && frame.panX <= 1);
  assert.ok(frame.panY < -0.5 && frame.panY >= -1);
  assert.ok(frame.secondaryX > 0);
  assert.ok(frame.zoomY < 0, "right stick up is zoom-in (negative)");
  // Below the dead zone reads as neutral.
  const idle = readGamepadFrame(pad([0.05, -0.05, 0, 0]));
  assert.deepEqual([idle.panX, idle.panY, idle.secondaryX, idle.zoomY], [0, 0, 0, 0]);
});

test("buttons map by standard index and honour the value threshold", () => {
  assert.equal(GAMEPAD_BUTTONS.length, 16);
  const frame = readGamepadFrame(pad([0, 0, 0, 0], [0, 1, 4, 9, 12]));
  assert.deepEqual(
    [...frame.pressed].sort(),
    ["a", "b", "dpad-up", "lb", "start"].sort()
  );
  // A missing pad reads as an empty frame, never throws.
  const empty = readGamepadFrame(null);
  assert.equal(empty.pressed.size, 0);
  assert.deepEqual([empty.panX, empty.panY], [0, 0]);
});

test("edge detection fires a button once, not while held", () => {
  const first = readGamepadFrame(pad([0, 0, 0, 0], [0]));
  assert.deepEqual(newlyPressed(new Set(), first), ["a"]);
  // Same press on the next frame -> no new edge.
  const held = readGamepadFrame(pad([0, 0, 0, 0], [0]));
  assert.deepEqual(newlyPressed(first.pressed, held), []);
  // Released then pressed again -> fires again.
  const released = readGamepadFrame(pad([0, 0, 0, 0], []));
  assert.deepEqual(newlyPressed(first.pressed, released), []);
  assert.deepEqual(newlyPressed(released.pressed, held), ["a"]);
});

test("firstConnected skips empty slots", () => {
  assert.equal(firstConnected([null, undefined, pad([0, 0, 0, 0])]) !== null, true);
  assert.equal(firstConnected([null, undefined]), null);
});

test("default dead zone is a sane fraction", () => {
  assert.ok(DEFAULT_DEADZONE > 0.05 && DEFAULT_DEADZONE < 0.4);
});
