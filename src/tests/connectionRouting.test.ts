import { test } from "node:test";
import assert from "node:assert/strict";
import {
  anchorOnSide,
  chooseSides,
  connRouteStyle,
  DEFAULT_ROUTE_STYLE,
  isRouteStyle,
  routeBetween,
  routeBetweenCached,
  routeEndAngle,
  routePolyline,
  type ConnRoute,
} from "../shared/geometry/connectionRouting.js";
import type { Point, Rect } from "../shared/geometry/viewport.js";

function rect(x: number, y: number, width = 100, height = 100): Rect {
  return { x, y, width, height };
}

function axisAligned(route: ConnRoute): boolean {
  for (let i = 1; i < route.points.length; i++) {
    const a = route.points[i - 1];
    const b = route.points[i];
    if (Math.abs(a.x - b.x) > 0.01 && Math.abs(a.y - b.y) > 0.01) return false;
  }
  return true;
}

function endsAt(route: ConnRoute, start: Point, end: Point): boolean {
  const s = route.points[0];
  const e = route.points[route.points.length - 1];
  return Math.hypot(s.x - start.x, s.y - start.y) < 0.01 && Math.hypot(e.x - end.x, e.y - end.y) < 0.01;
}

test("chooseSides: faces the dominant separation axis", () => {
  assert.deepEqual(chooseSides(rect(0, 0), rect(400, 0)), { from: "right", to: "left" });
  assert.deepEqual(chooseSides(rect(400, 0), rect(0, 0)), { from: "left", to: "right" });
  assert.deepEqual(chooseSides(rect(0, 0), rect(0, 400)), { from: "bottom", to: "top" });
  assert.deepEqual(chooseSides(rect(0, 400), rect(0, 0)), { from: "top", to: "bottom" });
});

test("anchorOnSide: lies on the side and stays inside its span", () => {
  const r = rect(0, 0, 200, 100);
  const right = anchorOnSide(r, "right", { x: 400, y: 500 });
  assert.equal(right.x, 200);
  assert.ok(right.y >= 0 && right.y <= 100);
  const top = anchorOnSide(r, "top", { x: -500, y: -500 });
  assert.equal(top.y, 0);
  assert.ok(top.x >= 0 && top.x <= 200);
});

test("curved route is a cubic anchored on facing edges", () => {
  const a = rect(0, 0);
  const b = rect(400, 0);
  const route = routeBetween(a, b, "curved");
  assert.equal(route.kind, "cubic");
  assert.equal(route.points.length, 4);
  assert.ok(endsAt(route, { x: 100, y: 50 }, { x: 400, y: 50 }));
  assert.equal(route.startSide, "right");
  assert.equal(route.endSide, "left");
});

test("elbow route is orthogonal and lands on the anchors", () => {
  const a = rect(0, 0);
  const b = rect(400, 260);
  const route = routeBetween(a, b, "elbow");
  assert.equal(route.kind, "poly");
  assert.ok(axisAligned(route), "every segment is horizontal or vertical");
  const start = route.points[0];
  const end = route.points[route.points.length - 1];
  assert.equal(start.x, 100);
  assert.equal(end.x, 400);
});

test("bracket route has a wide rail joined by perpendicular legs", () => {
  const a = rect(0, 0, 120, 80);
  const b = rect(400, 0, 120, 80);
  const route = routeBetween(a, b, "bracket");
  assert.equal(route.kind, "poly");
  assert.ok(axisAligned(route));
  // Two vertical legs share the rail's y for their lower end.
  const railY = route.points[1].y;
  assert.equal(route.points[2].y, railY);
  assert.ok(railY > 80, "the rail clears the frames");
});

test("routePolyline samples curved routes into a usable polyline", () => {
  const route = routeBetween(rect(0, 0), rect(400, 300), "curved");
  const poly = routePolyline(route, 16);
  assert.equal(poly.length, 17);
  const first = poly[0];
  const last = poly[poly.length - 1];
  assert.ok(Math.hypot(first.x - route.start.x, first.y - route.start.y) < 1e-6);
  assert.ok(Math.hypot(last.x - route.end.x, last.y - route.end.y) < 1e-6);
});

test("routeEndAngle points along the final approach", () => {
  const route = routeBetween(rect(0, 0), rect(400, 0), "curved");
  const angle = routeEndAngle(route);
  // Target is to the right, so the end tangent heads right (angle ~ 0).
  assert.ok(Math.abs(angle) < 0.4, `expected a rightward tangent, got ${angle}`);
});

test("stable across zoom-independent calls and cached", () => {
  const a = rect(0, 0);
  const b = rect(400, 0);
  assert.equal(routeBetweenCached(a, b, "elbow"), routeBetweenCached(a, b, "elbow"));
});

test("route style metadata parses with a safe default", () => {
  assert.equal(connRouteStyle({ metadata: {} }), DEFAULT_ROUTE_STYLE);
  assert.equal(connRouteStyle({ metadata: { route: "bracket" } }), "bracket");
  assert.equal(connRouteStyle({ metadata: { route: "nonsense" } }), DEFAULT_ROUTE_STYLE);
  assert.ok(isRouteStyle("elbow"));
  assert.ok(!isRouteStyle("dotted"));
});
