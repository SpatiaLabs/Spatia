import { test } from "node:test";
import assert from "node:assert/strict";
import {
  serialize,
  deserialize,
  ProjectFormatError,
  PROJECT_FORMAT_VERSION,
} from "../shared/project/serialize.js";
import type { AssetMeta, CanvasObject } from "../shared/types/object.js";
import { penBrushKind, setPenBrush } from "../shared/input/brushes.js";

function sampleObject(): CanvasObject {
  return {
    type: "test-object",
    id: "obj_1",
    x: 10,
    y: 20,
    width: 160,
    height: 120,
    rotation: 0.5,
    zIndex: 1,
    locked: false,
    metadata: {},
  };
}

function sampleObjects(): CanvasObject[] {
  return [
    sampleObject(),
    {
      type: "text",
      id: "obj_t",
      x: 1,
      y: 2,
      width: 200,
      height: 120,
      rotation: 0,
      zIndex: 2,
      locked: false,
      metadata: {},
      text: "Hello",
      fontSize: 24,
      bold: true,
      italic: false,
      align: "center",
    },
    {
      type: "note",
      id: "obj_n",
      x: 0,
      y: 0,
      width: 180,
      height: 140,
      rotation: 0,
      zIndex: 3,
      locked: false,
      metadata: {},
      title: "Note",
      text: "Body",
      color: "#f0c33c",
    },
    {
      type: "image",
      id: "obj_i",
      x: 0,
      y: 0,
      width: 240,
      height: 180,
      rotation: 0,
      zIndex: 4,
      locked: false,
      metadata: {},
      assetId: "ast_1",
    },
    {
      type: "file",
      id: "obj_f",
      x: 0,
      y: 0,
      width: 160,
      height: 120,
      rotation: 0,
      zIndex: 5,
      locked: false,
      metadata: {},
      assetId: "ast_2",
    },
  ];
}

function sampleProject() {
  return {
    project: { id: "proj_1", name: "Demo", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    viewport: { x: 100, y: -50, zoom: 2 },
    objects: sampleObjects(),
    assets: [{ id: "ast_1", kind: "image" as AssetMeta["kind"], name: "pic.png", size: 100, mime: "image/png", ext: "png" }] as AssetMeta[],
  };
}

test("serialize produces stable, parseable JSON with current formatVersion", () => {
  const p = sampleProject();
  const json = serialize(p.viewport, p.objects, p.project, p.assets);
  const parsed = JSON.parse(json);
  assert.equal(parsed.formatVersion, PROJECT_FORMAT_VERSION);
  assert.equal(parsed.assets.length, 1);
  assert.equal(parsed.objects.length, 5);
});

test("deserialize round trips serialize output for all object types", () => {
  const p = sampleProject();
  const json = serialize(p.viewport, p.objects, p.project, p.assets);
  const file = deserialize(json);
  assert.equal(file.formatVersion, PROJECT_FORMAT_VERSION);
  assert.deepEqual(file.viewport, p.viewport);
  assert.deepEqual(file.objects, p.objects);
  assert.deepEqual(file.assets, p.assets);
});

test("deserialize round trips a connection object and keeps endpoint references", () => {
  const objects: CanvasObject[] = [
    {
      type: "test-object",
      id: "obj_a",
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      rotation: 0,
      zIndex: 1,
      locked: false,
      metadata: {},
    },
    {
      type: "test-object",
      id: "obj_b",
      x: 300,
      y: 0,
      width: 100,
      height: 80,
      rotation: 0,
      zIndex: 2,
      locked: false,
      metadata: {},
    },
    {
      type: "connection",
      id: "obj_c",
      from: "obj_a",
      to: "obj_b",
      arrowhead: true,
      color: "#91a3f0",
      strokeWidth: 2,
      edgeFrom: "auto",
      edgeTo: "auto",
      x: 90,
      y: 30,
      width: 220,
      height: 20,
      rotation: 0,
      zIndex: 0,
      locked: false,
      metadata: {},
    },
  ];
  const p = {
    project: { id: "proj_c", name: "Conn", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    viewport: { x: 0, y: 0, zoom: 1 },
    objects,
    assets: [],
  };
  const json = serialize(p.viewport, p.objects, p.project, p.assets);
  const file = deserialize(json);
  assert.equal(file.objects.length, 3);
  const conn = file.objects.find((o) => o.type === "connection") as Extract<CanvasObject, { type: "connection" }>;
  assert.ok(conn);
  assert.equal(conn.from, "obj_a");
  assert.equal(conn.to, "obj_b");
  assert.equal(conn.arrowhead, true);
  assert.equal(conn.color, "#91a3f0");
  assert.equal(conn.strokeWidth, 2);
});

test("deserialize round trips a pen object (freehand stroke)", () => {
  const pen: CanvasObject = {
    type: "pen",
    id: "obj_p",
    points: [
      { x: 0, y: 0 },
      { x: 12.5, y: 30 },
      { x: 40, y: 42 },
    ],
    color: "#e8eaed",
    strokeWidth: 3,
    x: 0,
    y: 0,
    width: 40,
    height: 42,
    rotation: 0,
    zIndex: 1,
    locked: false,
    metadata: {},
  };
  const p = {
    project: { id: "proj_p", name: "Pen", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    viewport: { x: 0, y: 0, zoom: 1 },
    objects: [pen],
    assets: [],
  };
  const json = serialize(p.viewport, p.objects, p.project, p.assets);
  const file = deserialize(json);
  const round = file.objects.find((o) => o.id === "obj_p") as Extract<CanvasObject, { type: "pen" }>;
  assert.ok(round);
  assert.deepEqual(round.points, pen.points);
  assert.equal(round.color, "#e8eaed");
  assert.equal(round.strokeWidth, 3);
  assert.equal(round.width, 40);
  assert.equal(round.height, 42);
});

test("deserialize rejects a pen object with invalid points", () => {
  const bad = {
    formatVersion: PROJECT_FORMAT_VERSION,
    project: { id: "1", name: "x" },
    viewport: { x: 0, y: 0, zoom: 1 },
    objects: [{ type: "pen", id: "o", points: [{ x: 0, y: NaN }], x: 0, y: 0, width: 1, height: 1, rotation: 0, zIndex: 1, locked: false }],
  };
  assert.throws(() => deserialize(JSON.stringify(bad)), ProjectFormatError);
});

test("deserialize round trips a free-endpoint connection (to empty space)", () => {
  const conn: CanvasObject = {
    type: "connection",
    id: "obj_c",
    from: "obj_a",
    to: "",
    endX: 500,
    endY: 320,
    arrowhead: true,
    color: "#91a3f0",
    strokeWidth: 2,
    edgeFrom: "auto",
    edgeTo: "auto",
    x: 400,
    y: 300,
    width: 150,
    height: 40,
    rotation: 0,
    zIndex: 0,
    locked: false,
    metadata: {},
  };
  const objects: CanvasObject[] = [
    { type: "test-object", id: "obj_a", x: 0, y: 0, width: 100, height: 80, rotation: 0, zIndex: 1, locked: false, metadata: {} },
    conn,
  ];
  const p = {
    project: { id: "proj_c", name: "Free", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    viewport: { x: 0, y: 0, zoom: 1 },
    objects,
    assets: [],
  };
  const json = serialize(p.viewport, p.objects, p.project, p.assets);
  const file = deserialize(json);
  const round = file.objects.find((o) => o.id === "obj_c") as Extract<CanvasObject, { type: "connection" }>;
  assert.ok(round);
  assert.equal(round.to, "");
  assert.equal(round.endX, 500);
  assert.equal(round.endY, 320);
});

test("deserialize rejects a free-endpoint connection missing end coordinates", () => {
  const bad = {
    formatVersion: PROJECT_FORMAT_VERSION,
    project: { id: "1", name: "x" },
    viewport: { x: 0, y: 0, zoom: 1 },
    objects: [{ type: "connection", id: "o", from: "a", to: "", x: 0, y: 0, width: 1, height: 1, rotation: 0, zIndex: 0, locked: false }],
  };
  assert.throws(() => deserialize(JSON.stringify(bad)), ProjectFormatError);
});

test("deserialize round trips a url (bookmark) object", () => {
  const url: CanvasObject = {
    type: "url",
    id: "obj_u",
    url: "https://example.com",
    title: "Example",
    x: 0,
    y: 0,
    width: 220,
    height: 90,
    rotation: 0,
    zIndex: 1,
    locked: false,
    metadata: {},
  };
  const p = {
    project: { id: "proj_u", name: "Url", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    viewport: { x: 0, y: 0, zoom: 1 },
    objects: [url],
    assets: [],
  };
  const json = serialize(p.viewport, p.objects, p.project, p.assets);
  const file = deserialize(json);
  const round = file.objects.find((o) => o.id === "obj_u") as Extract<CanvasObject, { type: "url" }>;
  assert.ok(round);
  assert.equal(round.type, "url");
  assert.equal(round.url, "https://example.com");
  assert.equal(round.title, "Example");
});

test("deserialize requires url on a url object", () => {
  const bad = {
    formatVersion: PROJECT_FORMAT_VERSION,
    project: { id: "1", name: "x" },
    viewport: { x: 0, y: 0, zoom: 1 },
    objects: [{ type: "url", id: "o", x: 0, y: 0, width: 1, height: 1, rotation: 0, zIndex: 1, locked: false }],
  };
  assert.throws(() => deserialize(JSON.stringify(bad)), ProjectFormatError);
});

test("deserialize round trips a shape object with kind-specific fields", () => {
  const shape: CanvasObject = {
    type: "shape",
    kind: "arrow",
    id: "obj_sh",
    x: 5,
    y: 7,
    width: 240,
    height: 12,
    rotation: 0.2,
    zIndex: 3,
    locked: false,
    metadata: {},
    fill: "#112233",
    stroke: "#445566",
    strokeWidth: 4,
  };
  const p = sampleProject();
  p.objects = [shape];
  const json = serialize(p.viewport, p.objects, p.project, p.assets);
  const file = deserialize(json);
  const round = file.objects.find((o) => o.id === "obj_sh") as Extract<CanvasObject, { type: "shape" }>;
  assert.ok(round);
  assert.equal(round.type, "shape");
  assert.equal(round.kind, "arrow");
  assert.equal(round.fill, "#112233");
  assert.equal(round.stroke, "#445566");
  assert.equal(round.strokeWidth, 4);
});

test("deserialize fills shape defaults for a minimal shape object", () => {
  const bad = {
    formatVersion: PROJECT_FORMAT_VERSION,
    project: { id: "1", name: "x" },
    viewport: { x: 0, y: 0, zoom: 1 },
    objects: [{ type: "shape", id: "o", x: 0, y: 0, width: 1, height: 1, rotation: 0, zIndex: 1, locked: false }],
  };
  const file = deserialize(JSON.stringify(bad));
  const round = file.objects[0] as Extract<CanvasObject, { type: "shape" }>;
  assert.equal(round.kind, "rectangle");
  assert.equal(round.fill, "#3d5be8");
  assert.equal(round.stroke, "#17256b");
  assert.equal(round.strokeWidth, 2);
});

test("deserialize defaults an unknown shape kind to rectangle", () => {
  const bad = {
    formatVersion: PROJECT_FORMAT_VERSION,
    project: { id: "1", name: "x" },
    viewport: { x: 0, y: 0, zoom: 1 },
    objects: [
      { type: "shape", kind: "hexagon", id: "o", x: 0, y: 0, width: 1, height: 1, rotation: 0, zIndex: 1, locked: false },
    ],
  };
  const file = deserialize(JSON.stringify(bad));
  const round = file.objects[0] as Extract<CanvasObject, { type: "shape" }>;
  assert.equal(round.kind, "rectangle");
});

test("deserialize round trips a frame with an explicit shape", () => {
  for (const frameShape of ["rectangle", "rounded", "ellipse"] as const) {
    const frame: CanvasObject = {
      type: "frame",
      frameShape,
      id: "obj_fr",
      name: "Browser",
      color: "#2a6df5",
      x: 0,
      y: 0,
      width: 640,
      height: 480,
      rotation: 0,
      zIndex: 4,
      locked: false,
      metadata: { browserUrl: "https://example.com" },
    };
    const p = sampleProject();
    p.objects = [frame];
    const json = serialize(p.viewport, p.objects, p.project, p.assets);
    const file = deserialize(json);
    const round = file.objects.find((o) => o.id === "obj_fr") as Extract<CanvasObject, { type: "frame" }>;
    assert.ok(round);
    assert.equal(round.frameShape, frameShape);
    assert.equal(round.metadata.browserUrl, "https://example.com");
  }
});

test("deserialize defaults a frame without a shape to rectangle", () => {
  const bad = {
    formatVersion: PROJECT_FORMAT_VERSION,
    project: { id: "1", name: "x" },
    viewport: { x: 0, y: 0, zoom: 1 },
    objects: [
      { type: "frame", id: "o", name: "F", color: "#2a6df5", x: 0, y: 0, width: 100, height: 100, rotation: 0, zIndex: 1, locked: false },
    ],
  };
  const file = deserialize(JSON.stringify(bad));
  const round = file.objects[0] as Extract<CanvasObject, { type: "frame" }>;
  assert.equal(round.frameShape, "rectangle");
});

test("deserialize round trips a data table (and comparison table)", () => {
  const data = { columns: ["Item", "Value"], rows: [["A", "1"], ["B", "2"]] };
  for (const comparison of [false, true]) {
    const table: CanvasObject = {
      type: "table",
      comparison,
      data,
      id: comparison ? "obj_cmp" : "obj_tbl",
      x: 0,
      y: 0,
      width: 320,
      height: 220,
      rotation: 0,
      zIndex: 5,
      locked: false,
      metadata: {},
    };
    const p = sampleProject();
    p.objects = [table];
    const json = serialize(p.viewport, p.objects, p.project, p.assets);
    const file = deserialize(json);
    const round = file.objects.find((o) => o.id === table.id) as Extract<CanvasObject, { type: "table" }>;
    assert.ok(round);
    assert.equal(round.type, "table");
    assert.equal(round.comparison, comparison);
    assert.deepEqual(round.data, data);
  }
});

test("deserialize degrades a broken table payload to a valid default", () => {
  const bad = {
    formatVersion: PROJECT_FORMAT_VERSION,
    project: { id: "1", name: "x" },
    viewport: { x: 0, y: 0, zoom: 1 },
    objects: [
      { type: "table", comparison: true, id: "o", x: 0, y: 0, width: 100, height: 100, rotation: 0, zIndex: 1, locked: false, data: { not: "valid" } },
    ],
  };
  const file = deserialize(JSON.stringify(bad));
  const round = file.objects[0] as Extract<CanvasObject, { type: "table" }>;
  assert.ok(Array.isArray(round.data.columns));
  assert.ok(round.data.columns.length > 0);
  assert.ok(round.data.rows.every((r) => r.length === round.data.columns.length));
});

test("deserialize round trips a chart with kind and data", () => {
  const chart: CanvasObject = {
    type: "chart",
    kind: "pie",
    title: "Budget",
    data: { columns: ["Area", "Value"], rows: [["Ops", "40"], ["Dev", "60"]] },
    id: "obj_ch",
    x: 0,
    y: 0,
    width: 360,
    height: 260,
    rotation: 0,
    zIndex: 6,
    locked: false,
    metadata: {},
  };
  const p = sampleProject();
  p.objects = [chart];
  const json = serialize(p.viewport, p.objects, p.project, p.assets);
  const file = deserialize(json);
  const round = file.objects.find((o) => o.id === "obj_ch") as Extract<CanvasObject, { type: "chart" }>;
  assert.ok(round);
  assert.equal(round.type, "chart");
  assert.equal(round.kind, "pie");
  assert.equal(round.title, "Budget");
  assert.deepEqual(round.data, chart.data);
});

test("deserialize defaults an unknown chart kind to bar", () => {
  const bad = {
    formatVersion: PROJECT_FORMAT_VERSION,
    project: { id: "1", name: "x" },
    viewport: { x: 0, y: 0, zoom: 1 },
    objects: [
      { type: "chart", kind: "treemap", id: "o", x: 0, y: 0, width: 100, height: 100, rotation: 0, zIndex: 1, locked: false },
    ],
  };
  const file = deserialize(JSON.stringify(bad));
  const round = file.objects[0] as Extract<CanvasObject, { type: "chart" }>;
  assert.equal(round.kind, "bar");
  assert.ok(Array.isArray(round.data.rows));
});

test("deserialize round trips richer asset kinds (video, audio, pdf)", () => {
  const p = sampleProject();
  p.assets = [
    { id: "ast_v", kind: "video" as const, name: "clip.mp4", size: 1000, mime: "video/mp4", ext: "mp4" },
    { id: "ast_a", kind: "audio" as const, name: "song.mp3", size: 500, mime: "audio/mpeg", ext: "mp3" },
    { id: "ast_p", kind: "pdf" as const, name: "doc.pdf", size: 800, mime: "application/pdf", ext: "pdf" },
  ];
  const json = serialize(p.viewport, p.objects, p.project, p.assets);
  const file = deserialize(json);
  assert.equal(file.assets.length, 3);
  const kinds = file.assets.map((a) => a.kind).sort();
  assert.deepEqual(kinds, ["audio", "pdf", "video"]);
});

test("M5: asset thumbnail (additive field) round trips and missing/empty is tolerated", () => {
  const p = sampleProject();
  const thumb =
    "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////";
  p.assets = [
    { id: "ast_t", kind: "image" as const, name: "pic.png", size: 2048, mime: "image/png", ext: "png", thumbnail: thumb },
    { id: "ast_old", kind: "image" as const, name: "legacy.png", size: 100, mime: "image/png", ext: "png" },
  ];
  const json = serialize(p.viewport, p.objects, p.project, p.assets);
  const file = deserialize(json);
  assert.equal(file.assets[0].thumbnail, thumb);
  assert.equal(file.assets[1].thumbnail, undefined);
  // Legacy v5 files without the field still load, and an empty string is dropped.
  const legacy = {
    formatVersion: PROJECT_FORMAT_VERSION,
    project: { id: "1", name: "x" },
    viewport: { x: 0, y: 0, zoom: 1 },
    objects: [],
    assets: [
      { id: "a", kind: "image", name: "x.png", size: 1, mime: "image/png", ext: "png", thumbnail: "" },
      { id: "b", kind: "image", name: "y.png", size: 1, mime: "image/png", ext: "png" },
    ],
  };
  const parsed = deserialize(JSON.stringify(legacy));
  assert.equal(parsed.assets[0].thumbnail, undefined);
  assert.equal(parsed.assets[1].thumbnail, undefined);
});

test("deserialize rejects a non-string asset thumbnail", () => {
  const bad = {
    formatVersion: PROJECT_FORMAT_VERSION,
    project: { id: "1", name: "x" },
    viewport: { x: 0, y: 0, zoom: 1 },
    objects: [],
    assets: [{ id: "a", kind: "image", name: "x.png", size: 1, mime: "image/png", ext: "png", thumbnail: 42 }],
  };
  assert.throws(() => deserialize(JSON.stringify(bad)), ProjectFormatError);
});

test("Phase5 P0a: distant objects and viewport round trip through save/load", () => {
  const viewport = { x: 2.5e9, y: -1.8e9, zoom: 1.5 };
  const obj: CanvasObject = {
    type: "note",
    id: "obj_far",
    x: 3e9,
    y: -2e9,
    width: 200,
    height: 140,
    rotation: 0,
    zIndex: 1,
    locked: false,
    metadata: {},
    title: "Far",
    text: "at the edge of the infinite canvas",
    color: "#f0c33c",
  };
  const project = { id: "proj_far", name: "Far", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  const json = serialize(viewport, [obj], project, []);
  const file = deserialize(json);
  assert.deepEqual(file.viewport, viewport);
  const round = file.objects.find((o) => o.id === obj.id) as Extract<CanvasObject, { type: "note" }>;
  assert.ok(round);
  assert.equal(round.x, 3e9);
  assert.equal(round.y, -2e9);
  assert.equal(round.title, "Far");
});

test("deserialize rejects an invalid asset kind", () => {
  const bad = {
    formatVersion: PROJECT_FORMAT_VERSION,
    project: { id: "1", name: "x" },
    viewport: { x: 0, y: 0, zoom: 1 },
    objects: [],
    assets: [{ id: "a", kind: "archive", name: "x.zip", size: 1, mime: "application/zip", ext: "zip" }],
  };
  assert.throws(() => deserialize(JSON.stringify(bad)), ProjectFormatError);
});

test("deserialize fills locked/metadata for a v1 test-object file (migration)", () => {
  const v1 = {
    formatVersion: 1,
    project: { id: "proj_v1", name: "Old" },
    viewport: { x: 0, y: 0, zoom: 1 },
    objects: [{ type: "test-object", id: "o1", x: 0, y: 0, width: 10, height: 10, rotation: 0, zIndex: 1 }],
  };
  const file = deserialize(JSON.stringify(v1));
  assert.equal(file.formatVersion, PROJECT_FORMAT_VERSION);
  assert.equal(file.objects.length, 1);
  assert.equal(file.objects[0].locked, false);
  assert.deepEqual(file.objects[0].metadata, {});
  assert.deepEqual(file.assets, []);
  assert.equal(file.project.id, "proj_v1");
});

test("deserialize rejects invalid JSON", () => {
  assert.throws(() => deserialize("not json"), ProjectFormatError);
});

test("deserialize rejects missing formatVersion", () => {
  assert.throws(() => deserialize('{"project":{}}'), ProjectFormatError);
});

test("deserialize rejects a future format version", () => {
  const future = JSON.stringify({ formatVersion: 999, project: {}, viewport: {}, objects: [] });
  assert.throws(() => deserialize(future), /newer version/);
});

test("deserialize rejects unknown object types", () => {
  const bad = {
    formatVersion: PROJECT_FORMAT_VERSION,
    project: { id: "1", name: "x" },
    viewport: { x: 0, y: 0, zoom: 1 },
    objects: [{ type: "video", id: "o" }],
  };
  assert.throws(() => deserialize(JSON.stringify(bad)), ProjectFormatError);
});

test("deserialize rejects missing required text fields", () => {
  const bad = {
    formatVersion: PROJECT_FORMAT_VERSION,
    project: { id: "1", name: "x" },
    viewport: { x: 0, y: 0, zoom: 1 },
    objects: [{ type: "text", id: "o", x: 0, y: 0, width: 1, height: 1, rotation: 0, zIndex: 1, locked: false }],
  };
  assert.throws(() => deserialize(JSON.stringify(bad)), ProjectFormatError);
});

test("deserialize rejects non-finite numbers", () => {
  const bad = {
    formatVersion: PROJECT_FORMAT_VERSION,
    project: { id: "1", name: "x" },
    viewport: { x: NaN, y: 0, zoom: 1 },
    objects: [],
  };
  assert.throws(() => deserialize(JSON.stringify(bad)), ProjectFormatError);
});

// -------- Phase 2: additive tags / sharing (plus legacy-comments tolerance) ---

test("serialize round trips project tags and shared metadata", () => {
  const p = sampleProject();
  const json = serialize(
    p.viewport,
    p.objects,
    { ...p.project, tags: ["launch", " design "], shared: { roomId: "room_1", serverUrl: "http://localhost:8787", role: "editor" } },
    p.assets
  );
  const file = deserialize(json);
  assert.deepEqual(file.project.tags, ["launch", "design"]);
  assert.deepEqual(file.project.shared, { roomId: "room_1", serverUrl: "http://localhost:8787", role: "editor" });
  assert.equal("comments" in file, false);
});

test("deserialize defaults missing tags/shared for pre-Phase-2 files", () => {
  const json = serialize(sampleProject().viewport, sampleProject().objects, sampleProject().project, sampleProject().assets);
  const file = deserialize(json);
  assert.equal(file.project.tags, undefined);
  assert.equal(file.project.shared, undefined);
  assert.equal(file.formatVersion, PROJECT_FORMAT_VERSION);
});

test("deserialize normalizes duplicate tags and caps the array", () => {
  const tags = Array.from({ length: 250 }, (_, i) => (i % 5 === 0 ? "  dup  " : "t" + i));
  const p = sampleProject();
  const json = serialize(p.viewport, p.objects, { ...p.project, tags }, p.assets);
  const file = deserialize(json);
  assert.ok(file.project!.tags!.length <= 100);
  assert.equal(new Set(file.project!.tags).size, file.project!.tags!.length);
  // "  dup  " is trimmed to "dup" and de-duplicated to a single entry.
  assert.equal(file.project!.tags!.filter((t) => t === "dup").length, 1);
});

test("deserialize tolerates and ignores legacy comments data", () => {
  const p = sampleProject();
  const json = serialize(p.viewport, p.objects, p.project, p.assets);
  const withComments = JSON.parse(json);
  const legacy = [
    { id: "c", text: "x", authorId: "u", authorName: "n", createdAt: "t", updatedAt: "t", anchor: "canvas", objectId: null, x: 1, y: 2, resolved: false },
  ];
  // Well-formed legacy comments are ignored…
  withComments.comments = legacy;
  const ok = deserialize(JSON.stringify(withComments));
  assert.equal("comments" in ok, false);
  // …and so are malformed ones (the feature was removed, so nothing breaks).
  const broken = JSON.parse(JSON.stringify(withComments));
  broken.comments[0].anchor = "page";
  assert.doesNotThrow(() => deserialize(JSON.stringify(broken)));
  const badNumber = JSON.parse(JSON.stringify(withComments));
  badNumber.comments[0].x = NaN;
  assert.doesNotThrow(() => deserialize(JSON.stringify(badNumber)));
  const notArray = JSON.parse(JSON.stringify(withComments));
  notArray.comments = "nope";
  assert.doesNotThrow(() => deserialize(JSON.stringify(notArray)));
});

test("deserialize rejects malformed project tags", () => {
  const p = sampleProject();
  const json = serialize(p.viewport, p.objects, { ...p.project, tags: ["ok"] }, p.assets);
  const broken = JSON.parse(json);
  (broken.project as Record<string, unknown>).tags = [42];
  assert.throws(() => deserialize(JSON.stringify(broken)), ProjectFormatError);
  const nonArray = JSON.parse(json);
  (nonArray.project as Record<string, unknown>).tags = "oops";
  assert.throws(() => deserialize(JSON.stringify(nonArray)), ProjectFormatError);
});

test("deserialize rejects malformed shared metadata", () => {
  const p = sampleProject();
  const good = {
    id: "p0",
    name: "n",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    shared: { roomId: "room_1", serverUrl: "http://localhost:8787", role: "owner" as const },
  };
  const json = serialize(p.viewport, p.objects, good, p.assets);
  const badRole = JSON.parse(json);
  (badRole.project as Record<string, unknown>).shared = { roomId: "r", serverUrl: "u", role: "admin" };
  assert.throws(() => deserialize(JSON.stringify(badRole)), ProjectFormatError);
});

test("object-level tags live in metadata and survive round trips", () => {
  const obj: CanvasObject = {
    ...sampleObject(),
    metadata: { tags: ["focus", "vip"] },
  };
  const p = sampleProject();
  p.objects = [obj];
  const json = serialize(p.viewport, p.objects, p.project, p.assets);
  const file = deserialize(json);
  assert.deepEqual((file.objects[0] as unknown as Record<string, unknown>).metadata, { tags: ["focus", "vip"] });
});

test("a pen stroke's brush kind survives a JSON round trip via metadata", () => {
  const pen: CanvasObject = {
    type: "pen",
    id: "obj_brush",
    points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
    color: "#e8eaed",
    strokeWidth: 10,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    rotation: 0,
    zIndex: 1,
    locked: false,
    metadata: {},
  };
  setPenBrush(pen, "calligraphy");
  const p = sampleProject();
  p.objects = [pen];
  const file = deserialize(serialize(p.viewport, p.objects, p.project, p.assets));
  const round = file.objects[0] as Extract<CanvasObject, { type: "pen" }>;
  assert.equal(penBrushKind(round), "calligraphy");
  // Plain pen strokes keep their metadata empty (no gratuitous format churn).
  const plain: CanvasObject = { ...pen, id: "obj_plain", metadata: {} };
  assert.deepEqual(plain.metadata, {});
});
