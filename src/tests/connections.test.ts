import { test } from "node:test";
import assert from "node:assert/strict";
import {
  connectionBetween,
  connectionsTouching,
  connectionTouches,
  isConnectableEndpoint,
  remapConnection,
} from "../shared/geometry/workspace.js";
import type { CanvasObject } from "../shared/types/object.js";

function frame(id: string): CanvasObject {
  return {
    type: "frame",
    id,
    name: id,
    color: "#2a6df5",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    zIndex: 0,
    locked: false,
    metadata: {},
    frameShape: "rounded",
  };
}

function link(id: string, from: string, to: string): Extract<CanvasObject, { type: "connection" }> {
  return {
    type: "connection",
    id,
    from,
    to,
    arrowhead: true,
    color: "#91a3f0",
    strokeWidth: 2,
    edgeFrom: "auto",
    edgeTo: "auto",
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    rotation: 0,
    zIndex: 1,
    locked: false,
    metadata: {},
  };
}

const A = frame("a");
const B = frame("b");
const C = frame("c");

test("branching: one source fans out to many, many sources converge", () => {
  const objects = [A, B, C, link("ab", "a", "b"), link("ac", "a", "c"), link("bc", "b", "c")];
  // "a" fans out: two independent outgoing edges.
  assert.equal(connectionsTouching(objects, new Set(["a"])).length, 2);
  // "b" has one incoming and one outgoing.
  assert.deepEqual(connectionsTouching(objects, new Set(["b"])).sort(), ["ab", "bc"]);
  // "c" converges: two independent incoming edges.
  assert.deepEqual(connectionsTouching(objects, new Set(["c"])).sort(), ["ac", "bc"]);
});

test("deleting several endpoints gathers each attached edge exactly once", () => {
  const objects = [A, B, C, link("ab", "a", "b"), link("ac", "a", "c"), link("bc", "b", "c")];
  const touched = connectionsTouching(objects, new Set(["a", "b"]));
  assert.deepEqual([...touched].sort(), ["ab", "ac", "bc"]);
});

test("free endpoints are not treated as touching a frame", () => {
  const free = link("free", "a", "");
  assert.equal(connectionTouches(free, new Set(["a"])), true);
  assert.equal(connectionTouches(free, new Set([""])), false);
  assert.equal(connectionTouches(free, new Set(["b"])), false);
});

test("connectionBetween finds an exact directed edge and ignores the reverse", () => {
  const objects = [A, B, link("ab", "a", "b")];
  assert.equal(connectionBetween(objects, "a", "b"), "ab");
  assert.equal(connectionBetween(objects, "b", "a"), undefined);
  // A second edge to a different target is not a duplicate.
  assert.equal(connectionBetween(objects, "a", "c"), undefined);
});

test("a connection cannot be an endpoint of another connection", () => {
  assert.equal(isConnectableEndpoint(A), true);
  assert.equal(isConnectableEndpoint(link("ab", "a", "b")), false);
  assert.equal(isConnectableEndpoint(undefined), false);
});

test("remap re-points duplicated endpoints and keeps external ones", () => {
  const map = new Map([
    ["a", "a'"],
    ["b", "b'"],
  ]);
  const inner = remapConnection(link("ab", "a", "b"), map);
  assert.deepEqual([inner.from, inner.to], ["a'", "b'"]);
  // Endpoint outside the selection stays put; free endpoint stays free.
  const outward = remapConnection(link("ac", "a", "c"), map);
  assert.deepEqual([outward.from, outward.to], ["a'", "c"]);
  const free = remapConnection(link("free", "a", ""), map);
  assert.deepEqual([free.from, free.to], ["a'", ""]);
  // No mapping -> same object identity (no needless churn).
  const untouched = remapConnection(link("x", "p", "q"), map);
  assert.deepEqual([untouched.from, untouched.to], ["p", "q"]);
});
