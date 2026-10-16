import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BRUSH_KINDS,
  BRUSH_PROFILES,
  applyBrushGeometry,
  brushProfile,
  calligraphyWidths,
  isBrushKind,
  penBrushKind,
  setPenBrush,
} from "../shared/input/brushes.js";
import type { WorldPoint } from "../shared/types/object.js";

const straight = (n: number, dx = 1, dy = 0): WorldPoint[] =>
  Array.from({ length: n }, (_, i) => ({ x: i * dx, y: i * dy }));

test("every brush kind has a profile and is recognised", () => {
  assert.ok(BRUSH_KINDS.length >= 6);
  for (const k of BRUSH_KINDS) {
    assert.ok(BRUSH_PROFILES[k], `${k} profile missing`);
    assert.equal(BRUSH_PROFILES[k].id, k);
    assert.equal(isBrushKind(k), true);
  }
  assert.equal(isBrushKind("crayon"), false);
  assert.equal(isBrushKind(3), false);
  assert.equal(isBrushKind(undefined), false);
});

test("brush profiles are genuinely distinct (not opacity-only aliases)", () => {
  const pen = brushProfile("pen");
  const pencil = brushProfile("pencil");
  const marker = brushProfile("marker");
  const highlighter = brushProfile("highlighter");
  const calligraphy = brushProfile("calligraphy");
  assert.ok(pencil.grain > 0, "pencil must be grainy");
  assert.equal(pen.grain, 0);
  assert.notEqual(marker.cap, pen.cap, "marker has a square tip");
  assert.notEqual(highlighter.blend, pen.blend, "highlighter multiplies");
  assert.ok(highlighter.widthScale > 2, "highlighter is wide");
  assert.equal(typeof calligraphy.nibAngleDeg, "number");
});

test("penBrushKind defaults to pen and round trips through metadata", () => {
  assert.equal(penBrushKind({}), "pen");
  assert.equal(penBrushKind({ metadata: {} }), "pen");
  assert.equal(penBrushKind({ metadata: { brush: "nonsense" } }), "pen");
  const pen = { metadata: {} as Record<string, unknown> };
  setPenBrush(pen, "marker");
  assert.equal(penBrushKind(pen), "marker");
  // The default is dropped so plain strokes stay byte-identical.
  setPenBrush(pen, "pen");
  assert.equal(pen.metadata["brush"], undefined);
});

test("calligraphy nib is widest across the edge and thin along it", () => {
  const nib = 0; // nib edge horizontal
  // Moving horizontally = along the edge -> thin.
  const along = calligraphyWidths(straight(6, 1, 0), 20, nib, 0.2);
  // Moving vertically = across the edge -> full width.
  const across = calligraphyWidths(straight(6, 0, 1), 20, nib, 0.2);
  const wAlong = along[3].width!;
  const wAcross = across[3].width!;
  assert.ok(wAlong < wAcross, `thin ${wAlong} should be < thick ${wAcross}`);
  assert.ok(Math.abs(wAlong - 20 * 0.2) < 1e-6, "thin direction floors at minRatio");
  assert.ok(Math.abs(wAcross - 20) < 1e-6, "across the edge reaches full width");
});

test("calligraphy nib angle rotates the thick/thin directions", () => {
  const deg = 45;
  const along = calligraphyWidths(straight(6, 1, 1), 16, deg, 0.15);
  const across = calligraphyWidths(straight(6, 1, -1), 16, deg, 0.15);
  assert.ok(across[3].width! > along[3].width!);
  assert.ok(along[3].width! >= 16 * 0.15 - 1e-9, "never below the floor");
});

test("calligraphy keeps positions and never emits zero-width vertices", () => {
  const pts: WorldPoint[] = [
    { x: 0, y: 0 },
    { x: 5, y: 5 },
    { x: 10, y: 0 },
    { x: 15, y: 5 },
  ];
  const out = calligraphyWidths(pts, 12, -35, 0.1);
  assert.equal(out.length, pts.length);
  for (let i = 0; i < pts.length; i++) {
    assert.equal(out[i].x, pts[i].x);
    assert.equal(out[i].y, pts[i].y);
    assert.ok(out[i].width! > 0, "width must never collapse to zero");
  }
});

test("calligraphy handles coincident points without NaN", () => {
  const pts: WorldPoint[] = [{ x: 3, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 3 }];
  const out = calligraphyWidths(pts, 8, 30, 0.2);
  for (const p of out) assert.ok(Number.isFinite(p.width!) && p.width! > 0);
});

test("applyBrushGeometry derives angle widths for the nib", () => {
  const out = applyBrushGeometry(straight(5, 0, 1), "calligraphy", 10);
  assert.ok(out.every((p) => p.width !== undefined && p.width! > 0));
});

test("applyBrushGeometry strips widths for uniform brushes", () => {
  const pressure: WorldPoint[] = straight(5).map((p) => ({ ...p, width: 4 }));
  for (const kind of ["ballpoint", "marker", "highlighter"] as const) {
    const out = applyBrushGeometry(pressure, kind, 6);
    assert.ok(out.every((p) => p.width === undefined), `${kind} must be uniform`);
  }
});

test("applyBrushGeometry scales pressure widths for pressure brushes", () => {
  const pressure: WorldPoint[] = straight(5).map((p) => ({ ...p, width: 2 }));
  const scale = brushProfile("brush").widthScale;
  const out = applyBrushGeometry(pressure, "brush", 6);
  assert.ok(out.every((p) => Math.abs(p.width! - 2 * scale) < 1e-9));
  // A mouse stroke (no pressure) stays uniform for the same brush.
  const flat = applyBrushGeometry(straight(5), "brush", 6);
  assert.ok(flat.every((p) => p.width === undefined));
});
