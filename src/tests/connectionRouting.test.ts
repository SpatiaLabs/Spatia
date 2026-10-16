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
  routeBounds,
  routeEndAngle,
  routePolyline,
  type ConnRoute,
} from "../shared/geometry/connectionRouting.js";
import { connectionBounds } from "../shared/geometry/workspace.js";
import { createFrame, isRectVisible } from "../shared/geometry/viewport.js";
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

test("routeBounds encloses the route and its padding", () => {
  const a = rect(0, 0);
  const b = rect(400, 0);
  const route = routeBetween(a, b, "bracket");
  const pad = 10;
  const bounds = routeBounds(route, pad);
  for (const p of routePolyline(route, 16)) {
    assert.ok(p.x >= bounds.x && p.x <= bounds.x + bounds.width, "point within x bounds");
    assert.ok(p.y >= bounds.y && p.y <= bounds.y + bounds.height, "point within y bounds");
  }
  // Bracket rail drops below both frames, so the bounds must reach past them.
  assert.ok(bounds.y + bounds.height >= 100 + 26, "bounds include the rail");
});

test("connectionBounds follows moved endpoints (regression: stale AABB hides links)", () => {
  const a = rect(0, 0, 100, 100);
  const bNear = rect(150, 0, 100, 100);
  const bFar = rect(3000, 0, 100, 100);
  // Snapshot captured by createConnection while the endpoints were adjacent.
  const snapshot: Rect = { x: 96, y: 46, width: 58, height: 8 };
  const conn = { from: "a", to: "b", x: snapshot.x, y: snapshot.y, strokeWidth: 2 };

  // Camera parked near the far endpoint's new location.
  const frame = createFrame({ x: 2600, y: -200, zoom: 1 }, 800, 600);
  assert.equal(isRectVisible(snapshot, frame), false, "the stale snapshot would be culled");

  const live = connectionBounds(conn, a, bFar);
  assert.equal(isRectVisible(live, frame), true, "live route bounds stay on screen");

  // Geometry is derived, so distinct endpoint positions give distinct bounds.
  const liveNear = connectionBounds(conn, a, bNear);
  assert.notDeepEqual(live, liveNear);
});

test("connectionBounds uses the free endpoint when a target is absent", () => {
  const a = rect(0, 0, 100, 100);
  const conn = { from: "a", to: "", x: 100, y: 50, endX: 500, endY: 50, strokeWidth: 2 };
  const bounds = connectionBounds(conn, a, undefined);
  assert.ok(bounds.x <= 100 && bounds.x + bounds.width >= 500, "spans source to free end");
});

test("routeBounds encloses a curved (cubic) route", () => {
  const from = rect(0, 0);
  const to = rect(400, 200);
  const route = routeBetween(from, to, "curved");
  assert.equal(route.kind, "cubic");
  const bounds = routeBounds(route, 24);
  for (const p of routePolyline(route, 32)) {
    assert.ok(p.x >= bounds.x && p.x <= bounds.x + bounds.width, "point within x bounds");
    assert.ok(p.y >= bounds.y && p.y <= bounds.y + bounds.height, "point within y bounds");
  }
});

test("connectionBounds honors an explicit side (side-aware bounds)", () => {
  const a = rect(0, 0, 100, 100);
  const b = rect(300, 0, 100, 100);
  // Auto routing exits A on its right edge; pinning the top edge must move the
  // derived bounds (and therefore the culling rect + spatial index entry).
  const auto = connectionBounds({ from: "a", to: "b", x: 0, y: 0, strokeWidth: 2 }, a, b);
  const pinned = connectionBounds(
    { from: "a", to: "b", x: 0, y: 0, strokeWidth: 2, metadata: { fromSide: "top" } },
    a,
    b
  );
  assert.notDeepEqual(auto, pinned);
  // The top-anchored route starts at A's top edge, above the auto route's start.
  assert.ok(pinned.y < auto.y, "pinned top side reaches higher than auto");
});
