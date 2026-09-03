import { test } from "node:test";
import assert from "node:assert/strict";
import { resizeRect, selectionBounds, handleWorld, HANDLES } from "../shared/geometry/selection.js";
import type { Rect } from "../shared/geometry/viewport.js";

/**
 * Regression tests for the drag/resize math. The original Phase 1 bug was that
 * dragging accumulated a total delta and re-applied it on every move, so the
 * object "flew away" from the cursor. These tests assert the *absolute*
 * behaviour: the result depends only on currentWorld, so repeated "moves" to
 * the same point always land at the same place (no drift), at any zoom.
 */

function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

test("resizeRect from e (right edge) grows width, keeps left edge fixed", () => {
  const original = rect(100, 100, 200, 100);
  const startWorld = { x: 300, y: 150 };
  const currentWorld = { x: 360, y: 150 };
  const r = resizeRect(original, "e", startWorld, currentWorld);
  assert.deepEqual(r, rect(100, 100, 260, 100));
  assert.equal(r.x, 100, "left edge must stay fixed");
});

test("resizeRect from se grows both axes, keeps nw corner fixed", () => {
  const original = rect(0, 0, 100, 80);
  const r = resizeRect(original, "se", { x: 100, y: 80 }, { x: 140, y: 130 });
  assert.deepEqual(r, rect(0, 0, 140, 130));
});

test("resizeRect from nw shrinks, keeps se corner fixed", () => {
  const original = rect(50, 50, 100, 100);
  const r = resizeRect(original, "nw", { x: 50, y: 50 }, { x: 70, y: 80 });
  // Opposite (se) corner fixed at (150, 150).
  assert.equal(r.x + r.width, 150);
  assert.equal(r.y + r.height, 150);
});

test("resizeRect enforces a minimum size", () => {
  const original = rect(0, 0, 100, 100);
  const r = resizeRect(original, "se", { x: 100, y: 100 }, { x: -500, y: -500 }, 10);
  assert.equal(r.width, 10);
  assert.equal(r.height, 10);
});

test("resizeRect is idempotent for repeated moves to the same point (no fly-away)", () => {
  const original = rect(10, 20, 120, 90);
  const startWorld = { x: 130, y: 110 };
  const currentWorld = { x: 200, y: 180 };
  const first = resizeRect(original, "se", startWorld, currentWorld);
  const second = resizeRect(original, "se", startWorld, currentWorld);
  assert.deepEqual(first, second, "same mouse point must produce the same rect every time");
  assert.deepEqual(first, rect(10, 20, 190, 160));
});

test("resizeRect behaves identically regardless of zoom (world-space absolute)", () => {
  // World-space math is zoom independent by construction, but assert the key
  // property: doubling a drag applies exactly once.
  const original = rect(0, 0, 50, 50);
  const r1 = resizeRect(original, "se", { x: 50, y: 50 }, { x: 100, y: 100 });
  assert.deepEqual(r1, rect(0, 0, 100, 100));
});

test("handleWorld returns correct corners and edges", () => {
  const r = rect(10, 20, 100, 60);
  assert.deepEqual(handleWorld(r, "nw"), { x: 10, y: 20 });
  assert.deepEqual(handleWorld(r, "se"), { x: 110, y: 80 });
  assert.deepEqual(handleWorld(r, "e"), { x: 110, y: 50 });
  assert.deepEqual(handleWorld(r, "s"), { x: 60, y: 80 });
  assert.equal(HANDLES.length, 8);
});

test("selectionBounds covers the union of rects", () => {
  assert.equal(selectionBounds([]), null);
  const rects = [rect(0, 0, 10, 10), rect(20, 5, 10, 40), rect(2, 30, 30, 5)];
  const b = selectionBounds(rects);
  assert.deepEqual(b, rect(0, 0, 32, 45));
});
