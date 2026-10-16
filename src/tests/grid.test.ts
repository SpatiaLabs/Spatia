import { test } from "node:test";
import assert from "node:assert/strict";
import { gridSpacingForZoom } from "../renderer/canvas/grid.js";

const ZOOMS = [0.05, 0.1, 0.2, 0.5, 1, 1.5, 2, 3.3, 5, 8, 12];

test("major spacing is always five minor cells", () => {
  for (const z of ZOOMS) {
    const { minor, major } = gridSpacingForZoom(z);
    assert.equal(major, minor * 5, `zoom=${z}`);
  }
});

test("minor spacing is a 1/2/5 x 10^k value", () => {
  for (const z of ZOOMS) {
    const { minor } = gridSpacingForZoom(z);
    const exp = Math.floor(Math.log10(minor));
    const mantissa = minor / Math.pow(10, exp);
    assert.ok(
      Math.abs(mantissa - 1) < 1e-9 ||
        Math.abs(mantissa - 2) < 1e-9 ||
        Math.abs(mantissa - 5) < 1e-9,
      `zoom=${z} minor=${minor} mantissa=${mantissa}`
    );
  }
});

test("on-screen minor spacing stays in a readable 60-600px band", () => {
  for (const z of ZOOMS) {
    const { minor } = gridSpacingForZoom(z);
    const onScreen = minor * z;
    assert.ok(onScreen >= 60, `zoom=${z} onScreen=${onScreen}`);
    assert.ok(onScreen < 600, `zoom=${z} onScreen=${onScreen}`);
  }
});

test("spacing is monotonically non-increasing as you zoom in", () => {
  const ascending = [...ZOOMS].sort((a, b) => a - b);
  let prev = Infinity;
  for (const z of ascending) {
    const { minor } = gridSpacingForZoom(z);
    assert.ok(minor <= prev + 1e-9, `zoom=${z} minor=${minor} prev=${prev}`);
    prev = minor;
  }
});

test("very small and very large zooms still yield finite spacing", () => {
  for (const z of [1e-6, 1e-3, 1e3, 1e6]) {
    const { minor, major } = gridSpacingForZoom(z);
    assert.ok(Number.isFinite(minor) && minor > 0, `zoom=${z}`);
    assert.ok(Number.isFinite(major) && major > 0, `zoom=${z}`);
  }
});
