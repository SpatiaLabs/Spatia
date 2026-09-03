import { test } from "node:test";
import assert from "node:assert/strict";
import { SpatialGrid } from "../shared/geometry/spatialIndex.js";

test("point query returns objects overlapping that cell", () => {
  const g = new SpatialGrid();
  g.insert("a", { x: 0, y: 0, width: 10, height: 10 });
  g.insert("b", { x: 10000, y: 10000, width: 10, height: 10 });
  assert.deepEqual(g.queryPoint({ x: 5, y: 5 }).sort(), ["a"]);
  assert.deepEqual(g.queryPoint({ x: 10005, y: 10005 }).sort(), ["b"]);
  assert.deepEqual(g.queryPoint({ x: -5000, y: -5000 }), []);
});

test("queryPoint at very large coordinates (infinite workspace)", () => {
  const g = new SpatialGrid();
  g.insert("far", { x: 2e9, y: -2e9, width: 100, height: 100 });
  const hits = g.queryPoint({ x: 2e9 + 50, y: -2e9 + 50 });
  assert.deepEqual(hits, ["far"]);
  assert.deepEqual(g.queryPoint({ x: 1, y: 1 }), []);
});

test("rect query returns objects whose cells intersect the rect", () => {
  const g = new SpatialGrid();
  g.insert("a", { x: 0, y: 0, width: 100, height: 100 });
  g.insert("near", { x: 500, y: 0, width: 20, height: 20 });
  g.insert("away", { x: 9000, y: 9000, width: 10, height: 10 });
  const hits = g.queryRect({ x: 0, y: 0, width: 540, height: 200 });
  assert.deepEqual(hits.sort(), ["a", "near"]);
});

test("remove drops an object from queries", () => {
  const g = new SpatialGrid();
  g.insert("a", { x: 0, y: 0, width: 10, height: 10 });
  assert.equal(g.size, 1);
  g.remove("a");
  assert.equal(g.size, 0);
  assert.deepEqual(g.queryPoint({ x: 5, y: 5 }), []);
});

test("update moves an object to a new cell", () => {
  const g = new SpatialGrid();
  g.insert("a", { x: 0, y: 0, width: 10, height: 10 });
  g.update("a", { x: 0, y: 0, width: 10, height: 10 }, { x: 5000, y: 5000, width: 10, height: 10 });
  assert.deepEqual(g.queryPoint({ x: 5, y: 5 }), []);
  assert.deepEqual(g.queryPoint({ x: 5005, y: 5005 }), ["a"]);
  assert.equal(g.size, 1);
});

test("rebuild replaces all contents", () => {
  const g = new SpatialGrid();
  g.insert("old", { x: 0, y: 0, width: 10, height: 10 });
  g.rebuild([
    { id: "x", rect: { x: 100, y: 100, width: 10, height: 10 } },
    { id: "y", rect: { x: 200, y: 200, width: 10, height: 10 } },
  ]);
  assert.equal(g.size, 2);
  assert.deepEqual(g.queryPoint({ x: -5000, y: -5000 }), []);
  assert.deepEqual(g.queryPoint({ x: 105, y: 105 }).sort(), ["x", "y"]);
});

test("rect entirely spanning an object's bounding box matches it once", () => {
  const g = new SpatialGrid();
  g.insert("wide", { x: -1000, y: -1000, width: 2000, height: 2000 });
  const hits = g.queryRect({ x: -100, y: -100, width: 200, height: 200 });
  assert.deepEqual(hits, ["wide"]);
});
