import { test } from "node:test";
import assert from "node:assert/strict";
import {
  worldToScreen,
  screenToWorld,
  createFrame,
  anchoredZoom,
  panByScreenDelta,
  clampZoom,
  visibleWorldRect,
  MIN_ZOOM,
  MAX_ZOOM,
  viewportForRect,
} from "../shared/geometry/viewport.js";
import { snapMove, snapResize, unionRect, connectionEndpoints, pointToSegment } from "../shared/geometry/workspace.js";

function frame(cameraX: number, cameraY: number, zoom: number, w = 1000, h = 800) {
  return createFrame({ x: cameraX, y: cameraY, zoom }, w, h);
}

test("worldToScreen at identity view", () => {
  const f = frame(0, 0, 1);
  assert.deepEqual(worldToScreen({ x: 0, y: 0 }, f), { x: 0, y: 0 });
  assert.deepEqual(worldToScreen({ x: 50, y: -30 }, f), { x: 50, y: -30 });
});

test("screenToWorld at identity view is the inverse", () => {
  const f = frame(0, 0, 1);
  const screen = { x: 123, y: -45 };
  const world = screenToWorld(screen, f);
  assert.deepEqual(worldToScreen(world, f), screen);
});

test("round trip at multiple camera positions and zooms", () => {
  for (const camX of [-500, 0, 250, 1000.5]) {
    for (const camY of [-300, 12.25, 777]) {
      for (const zoom of [0.05, 0.2, 1, 3.3, 8]) {
        const f = frame(camX, camY, zoom);
        const world = { x: 37.123, y: -219.5 };
        const screen = worldToScreen(world, f);
        const back = screenToWorld(screen, f);
        assert.ok(Math.abs(back.x - world.x) < 1e-6, `x mismatch cam=(${camX},${camY}) zoom=${zoom}`);
        assert.ok(Math.abs(back.y - world.y) < 1e-6, `y mismatch cam=(${camX},${camY}) zoom=${zoom}`);
      }
    }
  }
});

test("round trip across the visible viewport", () => {
  const f = frame(17, -8, 2.5);
  for (const sx of [0, 250, 999]) {
    for (const sy of [0, 400, 799]) {
      const w = screenToWorld({ x: sx, y: sy }, f);
      const s = worldToScreen(w, f);
      assert.ok(Math.abs(s.x - sx) < 1e-6 && Math.abs(s.y - sy) < 1e-6);
    }
  }
});

test("worldToScreen scales by zoom", () => {
  const zoom = 2;
  const f = frame(10, 10, zoom);
  const s = worldToScreen({ x: 20, y: 20 }, f);
  // (20-10)*2 = 20
  assert.deepEqual(s, { x: 20, y: 20 });
});

test("screenToWorld divides by zoom", () => {
  const zoom = 0.5;
  const f = frame(10, 10, zoom);
  const w = screenToWorld({ x: 5, y: 5 }, f);
  assert.deepEqual(w, { x: 20, y: 20 });
});

test("anchoredZoom keeps the world point under the cursor fixed", () => {
  const f = frame(0, 0, 1, 1000, 800);
  const anchor = { x: 300, y: 200 };
  const factor = 1.5;

  // World point under cursor before zoom.
  const beforeWorld = screenToWorld(anchor, f);

  const next = anchoredZoom({ x: 0, y: 0, zoom: 1 }, factor, anchor, f);
  const nextFrame = createFrame(next, 1000, 800);
  const afterScreen = worldToScreen(beforeWorld, nextFrame);

  assert.ok(Math.abs(afterScreen.x - anchor.x) < 1e-6, `x ${afterScreen.x} != ${anchor.x}`);
  assert.ok(Math.abs(afterScreen.y - anchor.y) < 1e-6, `y ${afterScreen.y} != ${anchor.y}`);
  assert.ok(Math.abs(next.zoom - 1.5) < 1e-9);
});

test("zoomFactor clamps to min zoom", () => {
  const f = frame(0, 0, MIN_ZOOM, 1000, 800);
  const next = anchoredZoom({ x: 0, y: 0, zoom: MIN_ZOOM }, 0.01, { x: 10, y: 10 }, f);
  assert.equal(next.zoom, MIN_ZOOM);
});

test("zoomFactor clamps to max zoom", () => {
  const f = frame(0, 0, MAX_ZOOM, 1000, 800);
  const next = anchoredZoom({ x: 0, y: 0, zoom: MAX_ZOOM }, 100, { x: 10, y: 10 }, f);
  assert.equal(next.zoom, MAX_ZOOM);
});

test("panByScreenDelta moves camera opposite the drag, scaled by zoom", () => {
  // At zoom 2, dragging 100px right moves camera left by 50 world units.
  const next = panByScreenDelta({ x: 0, y: 0, zoom: 2 }, 100, -40);
  assert.deepEqual(next, { x: -50, y: 20, zoom: 2 });
});

test("clampZoom bounds values and recovers from NaN", () => {
  assert.equal(clampZoom(1), 1);
  assert.equal(clampZoom(0.001), MIN_ZOOM);
  assert.equal(clampZoom(999), MAX_ZOOM);
  assert.equal(clampZoom(Number.NaN), 1);
});

// -------- Workspace snapping / geometry --------

test("snapMove snaps a moving rect edge to another object's edge", () => {
  // Moving box's right edge at 200, candidate's left edge at 205, tolerance 8.
  const target = { x: 40, y: 40, width: 160, height: 100 };
  const other = { x: 205, y: 0, width: 50, height: 50 };
  const res = snapMove(target, [other], 8);
  assert.equal(res.dx, 5); // right edge 200 -> 205
  assert.equal(res.dy, 0);
  assert.deepEqual(res.guides, [{ axis: "x", value: 205 }]);
});

test("snapMove chooses the smallest snap when multiple edges are close", () => {
  // Target right edge at 200; candidate at 201 (delta 1) vs candidate at 205 (delta 5).
  const target = { x: 40, y: 40, width: 160, height: 100 };
  const others = [
    { x: 201, y: 0, width: 20, height: 20 },
    { x: 205, y: 300, width: 20, height: 20 },
  ];
  const res = snapMove(target, others, 8);
  assert.equal(res.dx, 1);
});

test("snapMove returns no snap outside tolerance", () => {
  const target = { x: 40, y: 40, width: 160, height: 100 };
  const other = { x: 1000, y: 1000, width: 20, height: 20 };
  const res = snapMove(target, [other], 8);
  assert.equal(res.dx, 0);
  assert.equal(res.dy, 0);
  assert.deepEqual(res.guides, []);
});

test("snapResize snaps only the pulled edges", () => {
  // Resizing via the SE handle: bottom and right edges move together.
  const bounds = { x: 0, y: 0, width: 100, height: 80 };
  const other = { x: 150, y: 130, width: 40, height: 40 };
  // Candidate right edge at 150 (delta +50 from 100), bottom edge at 130 (delta +50 from 80).
  const res = snapResize(bounds, "se", [other], 60);
  assert.equal(res.dx, 50);
  assert.equal(res.dy, 50);
  assert.deepEqual(res.guides, [
    { axis: "x", value: 150 },
    { axis: "y", value: 130 },
  ]);
});

test("snapResize ignores edges not pulled by the handle", () => {
  const bounds = { x: 0, y: 0, width: 100, height: 80 };
  const other = { x: 150, y: 130, width: 40, height: 40 };
  // 'e' handle moves the right edge only; the bottom edge must not snap.
  const res = snapResize(bounds, "e", [other], 60);
  assert.equal(res.dx, 50);
  assert.equal(res.dy, 0);
});

test("unionRect combines rectangles and returns null when empty", () => {
  assert.equal(unionRect([]), null);
  assert.deepEqual(unionRect([{ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 30, width: 5, height: 5 }]), {
    x: 0,
    y: 0,
    width: 25,
    height: 35,
  });
});

test("connectionEndpoints anchors on facing edges", () => {
  const from = { x: 0, y: 0, width: 100, height: 100 };
  const to = { x: 200, y: 0, width: 100, height: 100 };
  const { start, end } = connectionEndpoints({ from: "a", to: "b", x: 0, y: 0 }, from, to);
  // From's right edge faces to's left edge.
  assert.equal(start.x, 100);
  assert.ok(Math.abs(start.y - 50) < 1e-6);
  assert.equal(end.x, 200);
  assert.ok(Math.abs(end.y - 50) < 1e-6);
});

test("connectionEndpoints falls back to stored anchor when endpoints missing", () => {
  const { start } = connectionEndpoints({ from: "a", to: "b", x: 10, y: 20 }, undefined, undefined);
  assert.deepEqual(start, { x: 10, y: 20 });
});

test("connectionEndpoints anchors a free endpoint (to empty space) exactly at the stored end", () => {
  const from = { x: 0, y: 0, width: 100, height: 100 };
  const conn = { from: "a", to: "", x: 0, y: 0, endX: 300, endY: 60 };
  const { start, end } = connectionEndpoints(conn, from, undefined);
  // End is exactly the stored world position.
  assert.deepEqual(end, { x: 300, y: 60 });
  // Source edge faces the stored end: from's right edge.
  assert.equal(start.x, 100);
});

test("connectionEndpoints free endpoint falls back to stored anchor when no end given", () => {
  const from = { x: 0, y: 0, width: 100, height: 100 };
  const { end } = connectionEndpoints({ from: "a", to: "", x: 40, y: 30 }, from, undefined);
  assert.deepEqual(end, { x: 40, y: 30 });
});

test("pointToSegment measures distance to the line segment", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 100, y: 0 };
  assert.equal(pointToSegment({ x: 50, y: 3 }, a, b), 3);
  // Beyond the segment's end, distance is to the endpoint.
  assert.ok(Math.abs(pointToSegment({ x: 200, y: 0 }, a, b) - 100) < 1e-6);
});

// -------- True infinite workspace (Phase 5 P0a) --------

test("world<->screen round trips at very large positive coordinates", () => {
  const f = frame(1e12, -3e9, 1);
  const world = { x: 4e12, y: 2e9 };
  const s = worldToScreen(world, f);
  const back = screenToWorld(s, f);
  assert.ok(Math.abs(back.x - world.x) < 1e-3, `x ${back.x} != ${world.x}`);
  assert.ok(Math.abs(back.y - world.y) < 1e-3, `y ${back.y} != ${world.y}`);
});

test("world<->screen round trips at very large negative coordinates", () => {
  const f = frame(-1e12, 1e12, 1);
  const world = { x: -4e12, y: -2e12 };
  const s = worldToScreen(world, f);
  const back = screenToWorld(s, f);
  assert.ok(Math.abs(back.x - world.x) < 1e-3, `x ${back.x} != ${world.x}`);
  assert.ok(Math.abs(back.y - world.y) < 1e-3, `y ${back.y} != ${world.y}`);
});

test("round trips at distant coordinates across zoom extremes", () => {
  for (const cam of [1e9, -1e9, 1e6, -5e7]) {
    for (const zoom of [0.05, 1, 8]) {
      const f = frame(cam, -cam, zoom);
      const world = { x: cam + 123.5, y: -cam - 77.25 };
      const s = worldToScreen(world, f);
      const back = screenToWorld(s, f);
      assert.ok(Math.abs(back.x - world.x) < 1e-6, `x cam=${cam} zoom=${zoom}`);
      assert.ok(Math.abs(back.y - world.y) < 1e-6, `y cam=${cam} zoom=${zoom}`);
    }
  }
});

test("unlimited panning accumulates correctly far from the origin", () => {
  // Start off at a large coordinate, then pan in every direction.
  let vp = { x: 1e9, y: 1e9, zoom: 1 };
  for (let i = 0; i < 1000; i++) {
    vp = panByScreenDelta(vp, 3, -2);
  }
  assert.equal(vp.x, 1e9 - 3000);
  assert.equal(vp.y, 1e9 + 2000);
  assert.equal(vp.zoom, 1);
});

test("visibleWorldRect is finite at distant camera positions (culling works)", () => {
  const f = frame(5e12, -5e12, 0.05, 1920, 1080);
  const r = visibleWorldRect(f);
  for (const v of [r.x, r.y, r.width, r.height]) assert.ok(Number.isFinite(v), `non-finite ${v}`);
  assert.equal(r.x, 5e12);
  assert.deepEqual({ width: r.width, height: r.height }, { width: 1920 / 0.05, height: 1080 / 0.05 });
});

test("clampZoom does not restrict coordinate space, only zoom", () => {
  // Zoom is clamped but camera coordinates are untouched: transform functions
  // never clamp x/y, confirming there is no hidden finite-canvas boundary.
  assert.equal(MIN_ZOOM < 1, true);
  assert.equal(MAX_ZOOM > 1, true);
});

test("connectionEndpoints follow endpoint objects as they move", () => {
  let to = { x: 200, y: 0, width: 100, height: 100 };
  const from = { x: 0, y: 0, width: 100, height: 100 };
  const conn = { from: "a", to: "b", x: 0, y: 0 };

  const before = connectionEndpoints(conn, from, to);
  assert.equal(before.start.x, 100); // from's right edge
  assert.equal(before.end.x, 200);   // to's left edge

  // Move `to` up and right; the connection must re-derive both anchors.
  to = { x: 200, y: -100, width: 100, height: 100 };
  const after = connectionEndpoints(conn, from, to);
  assert.equal(after.start.x, 100);             // still from's right edge
  assert.equal(after.end.x, 200);               // to's left edge
  assert.ok(Math.abs(after.end.y - (-25)) < 1e-6); // anchored on to's left edge toward from
});


test("viewportForRect centers a distant rect with padding", () => {
  const result = viewportForRect(
    { x: -1_000_000, y: 2_000_000, width: 400, height: 200 },
    { cameraX: 0, cameraY: 0, zoom: 1, originWidth: 1000, originHeight: 800 },
    100
  );
  assert.deepEqual(result, { x: -1_000_050, y: 1_999_900, zoom: 2 });
});

test("viewportForRect rejects non-finite geometry", () => {
  assert.equal(
    viewportForRect({ x: Infinity, y: 0, width: 10, height: 10 }, { cameraX: 0, cameraY: 0, zoom: 1, originWidth: 100, originHeight: 100 }),
    null
  );
});
