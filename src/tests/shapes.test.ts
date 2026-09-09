import { test } from "node:test";
import assert from "node:assert/strict";
import { SHAPE_KINDS, SHAPE_DEFAULTS, shapeLabel, isStrokeOnly, pointInShape } from "../shared/geometry/shapes.js";
import type { Rect } from "../shared/geometry/viewport.js";

test("shape kinds are ordered and uniformly labelled", () => {
  assert.deepEqual(SHAPE_KINDS, [
    "rectangle",
    "rounded-rectangle",
    "ellipse",
    "diamond",
    "triangle",
    "line",
    "arrow",
  ]);
  assert.equal(shapeLabel("rectangle"), "Rectangle");
  assert.equal(shapeLabel("arrow"), "Arrow");
  assert.equal(isStrokeOnly("rectangle"), false);
  assert.equal(isStrokeOnly("line"), true);
  assert.equal(isStrokeOnly("arrow"), true);
});

test("shape defaults exist for every kind", () => {
  for (const kind of SHAPE_KINDS) {
    const d = SHAPE_DEFAULTS[kind];
    assert.ok(d, `defaults for ${kind}`);
    assert.equal(typeof d.width, "number");
    assert.equal(typeof d.height, "number");
    assert.equal(typeof d.stroke, "string");
    assert.equal(typeof d.strokeWidth, "number");
    assert.equal(typeof d.fill, "string");
  }
});

function rect(x: number, y: number, w: number, h: number): Rect {
  return { x, y, width: w, height: h };
}

test("pointInShape hits inside a rectangle and misses outside", () => {
  const r = rect(-80, -50, 160, 100);
  assert.ok(pointInShape("rectangle", r, 0, { x: 0, y: 0 }));
  assert.ok(pointInShape("rectangle", r, 0, { x: 70, y: 0 }));
  assert.ok(!pointInShape("rectangle", r, 0, { x: 81, y: 0 }));
  assert.ok(!pointInShape("rectangle", r, 0, { x: 0, y: 200 }));
});

test("pointInShape honours rotation", () => {
  const r = rect(-80, -10, 160, 20); // thin horizontal strip
  const p = { x: 0, y: 40 }; // outside when unrotated
  assert.ok(!pointInShape("rectangle", r, 0, p));
  assert.ok(pointInShape("rectangle", r, Math.PI / 2, p)); // vertical strip now
});

test("pointInShape ellipse excludes the AABB corners", () => {
  const r = rect(-100, -60, 200, 120);
  assert.ok(pointInShape("ellipse", r, 0, { x: 0, y: 0 }));
  assert.ok(pointInShape("ellipse", r, 0, { x: 90, y: 0 }));
  const corner = { x: 60, y: 50 }; // inside the box but outside the ellipse
  assert.ok(!pointInShape("ellipse", r, 0, corner));
});

test("pointInShape line and arrow tolerate nearby points", () => {
  const r = rect(-120, -5, 240, 10); // horizontal line
  assert.ok(pointInShape("line", r, 0, { x: -100, y: 3 }));
  assert.ok(pointInShape("arrow", r, 0, { x: 100, y: -3 }));
  assert.ok(!pointInShape("line", r, 0, { x: 0, y: 40 }));
  assert.ok(pointInShape("line", r, 0, { x: 0, y: 0 })); // exact center
});

test("pointInShape diamond and triangle use their outlines", () => {
  const r = rect(-80, -60, 160, 120);
  assert.ok(pointInShape("diamond", r, 0, { x: 0, y: 0 }));
  assert.ok(pointInShape("diamond", r, 0, { x: 60, y: 0 }));
  assert.ok(!pointInShape("diamond", r, 0, { x: 40, y: 40 }));
  const t = rect(-70, -60, 140, 120);
  assert.ok(pointInShape("triangle", t, 0, { x: 0, y: 30 }));
  assert.ok(pointInShape("triangle", t, 0, { x: 0, y: -40 }));
  assert.ok(!pointInShape("triangle", t, 0, { x: 0, y: -70 }));
});