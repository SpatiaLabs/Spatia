import { test } from "node:test";
import assert from "node:assert/strict";
import {
  eraseStroke,
  smoothStroke,
  cornerMask,
  resampleStroke,
  strokeBounds,
  translatePoints,
  pointInPolygon,
  strokeIntersectsLasso,
  strokeTouchesRect,
  isRtlLine,
  distPointToPolyline,
} from "../shared/geometry/ink.js";
import type { WorldPoint } from "../shared/types/object.js";

function pt(x: number, y: number, width?: number): WorldPoint {
  return width === undefined ? { x, y } : { x, y, width };
}

// ---------------------------------------------------------------------------
// resample / smoothing

test("resampleStroke keeps first and last points", () => {
  const raw = [pt(0, 0), pt(1, 0), pt(2, 0), pt(30, 0)];
  const out = resampleStroke(raw, 2);
  assert.equal(out[0], raw[0]);
  assert.equal(out[out.length - 1], raw[raw.length - 1]);
  assert.ok(out.length <= raw.length);
});

test("smoothStroke preserves sharp corners", () => {
  // An L shape: the corner at (10,10) must survive two Chaikin passes.
  const stroke = [pt(0, 0), pt(5, 5), pt(10, 10), pt(10, 20), pt(10, 30), pt(10, 40)];
  const smoother = smoothStroke(stroke, 2);
  assert.ok(smoother.length >= 4, "smoothing must not collapse the stroke");
  // Some point must stay close to the true corner — otherwise the L became a curve.
  const nearCorner = smoother.some((p) => Math.hypot(p.x - 10, p.y - 10) < 3);
  assert.ok(nearCorner, "corner must be preserved");
  // A straight run should not drift far off the line.
  for (const p of smoother) {
    if (p.x < 8.5) continue; // only check the straight vertical leg
    assert.ok(Math.abs(p.x - 10) < 2, `smoothed leg drifted to x=${p.x}`);
  }
});

test("cornerMask flags sharp turns only", () => {
  const stroke = [pt(0, 0), pt(10, 0), pt(10, 1), pt(10, 9), pt(10, 10)];
  const mask = cornerMask(stroke, -0.55);
  assert.ok(mask.some((v, i) => v && i > 0 && i < stroke.length - 1), "sharp turn must be flagged");
});

// ---------------------------------------------------------------------------
// eraser

test("eraseStroke splits a middle pass into two fragments", () => {
  const stroke: WorldPoint[] = [];
  for (let i = 0; i <= 20; i++) stroke.push(pt(i * 2, 0));
  // Vertical eraser sweep crossing the horizontal stroke near x=20.
  const eraser = [pt(19, -5), pt(20, 5)];
  const frags = eraseStroke(stroke, eraser, 1.5);
  assert.equal(frags.length, 2, "expected two surviving fragments");
  assert.ok(frags[0].every((p) => p.x <= 16));
  assert.ok(frags[1].every((p) => p.x >= 24));
});

test("eraseStroke full pass removes the stroke", () => {
  const stroke = [pt(0, 0), pt(0, 5), pt(0, 10)];
  const frags = eraseStroke(stroke, [pt(0, 0), pt(0, 10)], 3);
  assert.equal(frags.length, 0);
});

test("eraseStroke single tap cuts a dot-sized stroke", () => {
  const stroke = [pt(0, 0), pt(2, 0), pt(4, 0)];
  const frags = eraseStroke(stroke, [pt(2, 0)], 2);
  assert.equal(frags.length, 2);
});

test("eraseStroke leaves untouched strokes alone", () => {
  const stroke = [pt(0, 0), pt(100, 0), pt(200, 0)];
  const frags = eraseStroke(stroke, [pt(50, 60)], 2);
  assert.deepEqual(frags, [stroke]);
});

test("eraseStroke bridges a fast sweep across a vertex", () => {
  const stroke = [pt(0, 0), pt(4, 0), pt(8, 0)];
  // Eraser tip is close to the middle vertex on one side only; the midpoint
  // bridge must erase the crossing anyway.
  const frags = eraseStroke(stroke, [pt(4, 3)], 4.1);
  assert.equal(frags.length, 2);
});

test("eraser: small sweep removes only the touched middle, never the whole stroke", () => {
  const stroke: WorldPoint[] = [];
  for (let i = 0; i <= 100; i++) stroke.push(pt(i * 2, 0)); // 0..200
  // Tiny wiggle just below the middle of the line ("a small movement").
  const frags = eraseStroke(stroke, [pt(98, 4), pt(100, 5)], 6);
  assert.equal(frags.length, 2, "a small sweep must split, not wipe, the stroke");
  const left = frags[0];
  const right = frags[1];
  assert.ok(left[0].x <= 4, "the stroke start must survive");
  assert.ok(right[right.length - 1].x >= 196, "the stroke end must survive");
  assert.ok(left[left.length - 1].x <= 96, "the left cut must stay at the touch point");
  assert.ok(right[0].x >= 104, "the right cut must stay at the touch point");
});

test("eraser: middle pass leaves both far ends intact", () => {
  const stroke: WorldPoint[] = [];
  for (let i = 0; i <= 40; i++) stroke.push(pt(i * 2, 0)); // 0..80
  const frags = eraseStroke(stroke, [pt(39, -5), pt(40, 5)], 2);
  assert.equal(frags.length, 2);
  assert.equal(frags[0][0].x, 0);
  assert.equal(frags[1][frags[1].length - 1].x, 80);
});

test("eraser: near-edge pass clips only the touched tail", () => {
  const stroke: WorldPoint[] = [];
  for (let i = 0; i <= 20; i++) stroke.push(pt(i * 2, 0)); // 0..40
  const frags = eraseStroke(stroke, [pt(38, 0)], 2.5);
  assert.equal(frags.length, 1, "only the touched side survives");
  assert.equal(frags[0].length, 18, "0..34 must survive, 36..40 must be removed");
  assert.equal(frags[0][frags[0].length - 1].x, 34);
});

test("eraser: two nearby strokes — erasing one leaves the other intact", () => {
  const make = (y: number): WorldPoint[] => {
    const s: WorldPoint[] = [];
    for (let i = 0; i <= 20; i++) s.push(pt(i * 2, y));
    return s;
  };
  const strokeA = make(0);
  const strokeB = make(12);
  const eraser = [pt(19, -5), pt(21, 5)];
  const fragsA = eraseStroke(strokeA, eraser, 5);
  const fragsB = eraseStroke(strokeB, eraser, 5);
  assert.equal(fragsA.length, 2, "the nearer stroke must split");
  assert.deepEqual(fragsB, [strokeB], "the nearby stroke must stay untouched");
});

test("eraser: multiple strokes each split only where the sweep crosses", () => {
  const mk = (y: number): WorldPoint[] => {
    const s: WorldPoint[] = [];
    for (let i = 0; i <= 20; i++) s.push(pt(i * 2, y));
    return s;
  };
  const rows = [mk(0), mk(10), mk(20)];
  const eraser = [pt(20, -5), pt(20, 25)];
  for (const s of rows) {
    const frags = eraseStroke(s, eraser, 3);
    assert.equal(frags.length, 2, "each swept stroke splits");
    assert.ok(frags[0].every((p) => p.x <= 20), "left part stays left");
    assert.ok(frags[1].every((p) => p.x >= 20), "right part stays right");
  }
});

test("eraser: fast sweep severs a sparse stroke without wiping it", () => {
  const stroke = [pt(0, 0), pt(50, 0), pt(100, 0), pt(150, 0), pt(200, 0)];
  const frags = eraseStroke(stroke, [pt(49, 3), pt(51, 5)], 4.1);
  assert.equal(frags.length, 2);
  assert.deepEqual(frags[0], [pt(0, 0)]);
  assert.deepEqual(frags[1], [pt(100, 0), pt(150, 0), pt(200, 0)]);
});

test("eraser: slow precise sweep removes exactly the covered band", () => {
  const stroke: WorldPoint[] = [];
  for (let i = 0; i <= 40; i++) stroke.push(pt(i, 0)); // 0..40 every 1
  const frags = eraseStroke(stroke, [pt(20, -1), pt(20, 1)], 1);
  assert.equal(frags.length, 2);
  assert.equal(frags[0][frags[0].length - 1].x, 18);
  assert.equal(frags[1][0].x, 22);
});

test("eraser: zoom scaling — the same screen eraser removes less world at higher zoom", () => {
  const stroke: WorldPoint[] = [];
  for (let i = 0; i <= 40; i++) stroke.push(pt(i, 0));
  const eraser = [pt(20, -1), pt(20, 1)];
  const at1x = eraseStroke(stroke, eraser, 2); // zoom 1: world radius 2
  const at2x = eraseStroke(stroke, eraser, 1); // zoom 2: half the world radius
  const removed1x = stroke.length - at1x.reduce((n, f) => n + f.length, 0);
  const removed2x = stroke.length - at2x.reduce((n, f) => n + f.length, 0);
  assert.ok(removed1x > removed2x, "2x zoom must remove less world geometry");
  assert.equal(at1x[1][0].x, 23);
  assert.equal(at2x[1][0].x, 22);
});

test("eraser: negative world coordinates behave identically", () => {
  const stroke: WorldPoint[] = [];
  for (let i = 0; i <= 20; i++) stroke.push(pt(-64 + i * 2, -10)); // -64..-24
  const frags = eraseStroke(stroke, [pt(-43, -15), pt(-45, -5)], 2);
  assert.equal(frags.length, 2);
  assert.equal(frags[0][0].x, -64);
  assert.equal(frags[1][frags[1].length - 1].x, -24);
});

test("eraser: panned-view coordinates behave identically (translation invariance)", () => {
  const mk = (ox: number): WorldPoint[] => {
    const s: WorldPoint[] = [];
    for (let i = 0; i <= 20; i++) s.push(pt(ox + i * 2, 0));
    return s;
  };
  const atOrigin = eraseStroke(mk(0), [pt(19, -5), pt(20, 5)], 2);
  const panned = eraseStroke(mk(500), [pt(519, -5), pt(520, 5)], 2);
  assert.equal(panned.length, atOrigin.length);
  assert.equal(panned[0][0].x - atOrigin[0][0].x, 500);
  assert.equal(panned[1][panned[1].length - 1].x - atOrigin[1][atOrigin[1].length - 1].x, 500);
});

test("distPointToPolyline dedupes cheaply", () => {
  const seg = [pt(0, 0), pt(10, 0)];
  assert.ok(distPointToPolyline({ x: 5, y: 3 }, seg, 3) <= 3);
  assert.ok(distPointToPolyline({ x: 5, y: 5 }, seg, 3) > 3);
  assert.equal(distPointToPolyline({ x: 5, y: 0 }, seg, 3), 0);
});

// ---------------------------------------------------------------------------
// bounds / translate

test("strokeBounds and translatePoints", () => {
  const stroke = [pt(2, 3), pt(8, 9), pt(4, 1)];
  assert.deepEqual(strokeBounds(stroke), { x: 2, y: 1, width: 6, height: 8 });
  const moved = translatePoints(stroke, 10, -2);
  assert.deepEqual(moved[0], { x: 12, y: 1 });
  assert.deepEqual(strokeBounds(moved), { x: 12, y: -1, width: 6, height: 8 });
});

test("translatePoints preserves per-vertex widths", () => {
  const stroke = [pt(1, 1, 5), pt(2, 2)];
  const moved = translatePoints(stroke, 1, 1);
  assert.deepEqual(moved, [{ x: 2, y: 2, width: 5 }, { x: 3, y: 3 }]);
});

// ---------------------------------------------------------------------------
// selection

test("pointInPolygon basic cases", () => {
  const poly = [pt(0, 0), pt(10, 0), pt(10, 10), pt(0, 10)];
  assert.ok(pointInPolygon({ x: 5, y: 5 }, poly));
  assert.ok(!pointInPolygon({ x: 15, y: 5 }, poly));
  assert.ok(pointInPolygon({ x: -1, y: -1 }, [pt(0, -10), pt(10, -10), pt(10, 0), pt(0, 0)]) === false);
});

test("strokeIntersectsLasso catches top-of-lasso vertices", () => {
  const stroke = [pt(2, 2), pt(6, 2)];
  const lasso = [pt(0, 0), pt(12, 0), pt(12, 12), pt(0, 12)];
  assert.ok(strokeIntersectsLasso(stroke, lasso));
});

test("strokeIntersectsLasso catches crossing segments", () => {
  const stroke = [pt(0, 50), pt(100, 50), pt(150, 50)];
  // Lasso cuts across the stroke without enclosing a vertex.
  const lasso = [pt(40, 0), pt(60, 40), pt(30, 80), pt(10, 30)];
  assert.ok(strokeIntersectsLasso(stroke, lasso));
});

test("strokeIntersectsLasso rejects far away strokes", () => {
  const stroke = [pt(0, 0), pt(4, 0)];
  const lasso = [pt(50, 50), pt(60, 50), pt(60, 60), pt(50, 60)];
  assert.ok(!strokeIntersectsLasso(stroke, lasso));
});

test("strokeTouchesRect uses bounds overlap", () => {
  const stroke = [pt(0, 0), pt(10, 0), pt(10, 10)];
  assert.ok(strokeTouchesRect(stroke, { x: 8, y: 8, width: 4, height: 4 }));
  assert.ok(!strokeTouchesRect(stroke, { x: 50, y: 50, width: 4, height: 4 }));
});

// ---------------------------------------------------------------------------
// RTL

test("isRtlLine detects Arabic and Hebrew", () => {
  assert.ok(isRtlLine("مرحبا"));
  assert.ok(isRtlLine("שלום עולם"));
  assert.ok(!isRtlLine("hello world"));
  assert.ok(!isRtlLine(""));
  assert.ok(isRtlLine("Switch to العربية"));
});