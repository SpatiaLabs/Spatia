import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_BRUSH_PRESETS,
  CUSTOM_BRUSH_PRESETS_KEY,
  MAX_CUSTOM_PRESETS,
  allBrushPresets,
  loadCustomPresets,
  matchPresetId,
  normalizeBrushPreset,
  presetToPenSettings,
  removeCustomPreset,
  saveCustomPresets,
  settingsMatchPreset,
  upsertCustomPreset,
  type BrushPreset,
  type PresetStorage,
} from "../shared/input/brushPresets.js";
import { isBrushKind } from "../shared/input/brushes.js";

function memStorage(): PresetStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

function custom(id: string, over: Partial<BrushPreset> = {}): BrushPreset {
  return {
    id,
    name: "My brush",
    width: 5,
    opacity: 1,
    color: "#e8eaed",
    smoothing: 1,
    stabilizer: "off",
    pressure: true,
    brush: "pen",
    ...over,
  };
}

test("built-in presets are all valid, uniquely identified and non-deletable", () => {
  const ids = new Set<string>();
  for (const p of BUILTIN_BRUSH_PRESETS) {
    assert.equal(p.builtin, true, `${p.id} must be marked built-in (non-deletable)`);
    assert.ok(p.id.startsWith("builtin:"));
    assert.ok(p.name.length > 0);
    assert.ok(Number.isFinite(p.width) && p.width > 0);
    assert.ok(p.opacity >= 0.05 && p.opacity <= 1);
    assert.ok(/^#[0-9a-f]{6}$/.test(p.color));
    assert.ok(p.smoothing === 0 || p.smoothing === 1 || p.smoothing === 2);
    assert.ok(p.stabilizer === "off" || p.stabilizer === "mild" || p.stabilizer === "strong");
    assert.equal(typeof p.pressure, "boolean");
    assert.ok(isBrushKind(p.brush), `${p.id} must carry a valid brush kind`);
    assert.ok(!ids.has(p.id), `duplicate preset id ${p.id}`);
    ids.add(p.id);
  }
  assert.ok(BUILTIN_BRUSH_PRESETS.length >= 4);
});

test("normalizeBrushPreset clamps ranges, lowercases the colour and rejects junk", () => {
  assert.equal(normalizeBrushPreset(null), null);
  assert.equal(normalizeBrushPreset("nope"), null);
  assert.equal(normalizeBrushPreset({}), null);
  assert.equal(normalizeBrushPreset({ id: "x", name: "" }), null);
  assert.equal(normalizeBrushPreset({ id: "", name: "x" }), null);
  assert.equal(normalizeBrushPreset({ id: "x", name: "y", width: 1, opacity: 1, color: "red" }), null);
  // Built-in ids cannot be shadowed by an import.
  assert.equal(normalizeBrushPreset({ id: "builtin:fine", name: "evil", width: 1, opacity: 1, color: "#000000" }), null);

  const norm = normalizeBrushPreset({
    id: "u1",
    name: "  My Pen  ",
    width: 9999,
    opacity: 0.0,
    color: "#AABBCC",
    smoothing: 9,
    stabilizer: "wat",
    pressure: 1,
    brush: "marker",
  });
  assert.ok(norm);
  assert.equal(norm.id, "u1");
  assert.equal(norm.name, "My Pen");
  assert.equal(norm.width, 128);
  assert.equal(norm.opacity, 0.05);
  assert.equal(norm.color, "#aabbcc");
  assert.equal(norm.smoothing, 2);
  assert.equal(norm.stabilizer, "off");
  assert.equal(norm.pressure, false);
  assert.equal(norm.brush, "marker");
  // A missing or unknown brush kind falls back to the plain pen.
  assert.equal(normalizeBrushPreset({ id: "u2", name: "x", width: 2, opacity: 1, color: "#000000" })?.brush, "pen");
  assert.equal(normalizeBrushPreset({ id: "u3", name: "x", width: 2, opacity: 1, color: "#000000", brush: "crayon" })?.brush, "pen");
});

test("loadCustomPresets tolerates missing, broken and non-array payloads", () => {
  assert.deepEqual(loadCustomPresets(null), []);
  const bad = memStorage();
  bad.setItem(CUSTOM_BRUSH_PRESETS_KEY, "{not json");
  assert.deepEqual(loadCustomPresets(bad), []);
  const obj = memStorage();
  obj.setItem(CUSTOM_BRUSH_PRESETS_KEY, JSON.stringify({ id: "x" }));
  assert.deepEqual(loadCustomPresets(obj), []);
});

test("loadCustomPresets drops malformed and duplicate entries", () => {
  const s = memStorage();
  s.setItem(
    CUSTOM_BRUSH_PRESETS_KEY,
    JSON.stringify([
      custom("u1", { name: "Alpha" }),
      { id: "broken" },
      custom("u1", { name: "Alpha again" }),
      custom("u2", { name: "Beta" }),
    ])
  );
  const out = loadCustomPresets(s);
  assert.deepEqual(
    out.map((p) => p.id),
    ["u1", "u2"]
  );
  assert.equal(out[0].name, "Alpha");
});

test("save then load round trips custom presets", () => {
  const s = memStorage();
  const presets = [custom("u1", { name: "One" }), custom("u2", { name: "Two", color: "#112233" })];
  assert.equal(saveCustomPresets(presets, s), true);
  assert.deepEqual(loadCustomPresets(s), presets);
  assert.equal(saveCustomPresets(presets, null), false);
});

test("saveCustomPresets reports false when storage throws", () => {
  const throwing: PresetStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota");
    },
  };
  assert.equal(saveCustomPresets([custom("u1")], throwing), false);
});

test("upsertCustomPreset replaces by id and keeps insertion order", () => {
  let list = upsertCustomPreset([], custom("a", { name: "A" }));
  list = upsertCustomPreset(list, custom("b", { name: "B" }));
  list = upsertCustomPreset(list, custom("a", { name: "A2" }));
  assert.deepEqual(
    list.map((p) => p.id),
    ["b", "a"]
  );
  assert.equal(list[1].name, "A2");
});

test("custom preset list is capped at the maximum", () => {
  let list: BrushPreset[] = [];
  for (let i = 0; i < MAX_CUSTOM_PRESETS + 10; i++) list = upsertCustomPreset(list, custom(`u${i}`));
  assert.equal(list.length, MAX_CUSTOM_PRESETS);
  assert.ok(list[list.length - 1].id === `u${MAX_CUSTOM_PRESETS + 9}`);

  const s = memStorage();
  const many = Array.from({ length: MAX_CUSTOM_PRESETS + 5 }, (_, i) => custom(`m${i}`));
  saveCustomPresets(many, s);
  assert.equal(loadCustomPresets(s).length, MAX_CUSTOM_PRESETS);
});

test("removeCustomPreset removes only the target id", () => {
  const list = [custom("a"), custom("b")];
  assert.deepEqual(
    removeCustomPreset(list, "a").map((p) => p.id),
    ["b"]
  );
  assert.deepEqual(removeCustomPreset(list, "zzz"), list);
});

test("allBrushPresets places built-ins before custom presets", () => {
  const all = allBrushPresets([custom("mine")]);
  assert.equal(all.length, BUILTIN_BRUSH_PRESETS.length + 1);
  assert.equal(all[0].id, BUILTIN_BRUSH_PRESETS[0].id);
  assert.equal(all[all.length - 1].id, "mine");
});

test("presetToPenSettings copies exactly the style fields", () => {
  const p = custom("u1", { width: 7, opacity: 0.5, color: "#abcdef", smoothing: 2, stabilizer: "strong", pressure: false, brush: "calligraphy" });
  assert.deepEqual(presetToPenSettings(p), {
    width: 7,
    opacity: 0.5,
    color: "#abcdef",
    smoothing: 2,
    stabilizer: "strong",
    pressure: false,
    brush: "calligraphy",
  });
});

test("matchPresetId finds the preset matching the live settings, else null", () => {
  const presets = allBrushPresets([]);
  const marker = BUILTIN_BRUSH_PRESETS.find((p) => p.id === "builtin:marker")!;
  assert.equal(matchPresetId(presets, presetToPenSettings(marker)), "builtin:marker");
  const tweaked = { ...presetToPenSettings(marker), width: 9 };
  assert.equal(matchPresetId(presets, tweaked), null);
  assert.ok(settingsMatchPreset(marker, presetToPenSettings(marker)));
});
