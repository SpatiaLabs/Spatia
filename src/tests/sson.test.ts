import { test } from "node:test";
import assert from "node:assert/strict";
import { deserialize, serialize } from "../shared/project/serialize.js";
import { isSSON, projectFileToSSON, projectFileFromSSON, ssonToJSON } from "../shared/project/sson.js";
import type { CanvasObject } from "../shared/types/object.js";

function sampleProject() {
  const pen: CanvasObject = {
    type: "pen",
    id: "obj_a291d56c",
    x: 1042,
    y: 394,
    width: 155,
    height: 232,
    rotation: 0,
    zIndex: 0,
    locked: false,
    metadata: { tags: ["stroke"] },
    points: [
      { x: 1153, y: 470 },
      { x: 1159.5, y: 478 },
      { x: 1170, y: 498, width: 2.5 },
      { x: 1180, y: 520 },
      { x: 1186, y: 535, width: 3 },
    ],
    color: "#e8eaed",
    strokeWidth: 3,
  };
  const objects: CanvasObject[] = [
    pen,
    { type: "text", id: "obj_t", x: 10, y: 20, width: 200, height: 120, rotation: 0.25, zIndex: 2, locked: false, metadata: {}, text: "Spatia حاكم", fontSize: 24, bold: true, italic: false, align: "center" },
    { type: "note", id: "obj_n", x: 0, y: 0, width: 180, height: 140, rotation: 0, zIndex: 0, locked: false, metadata: {}, title: "Note", text: "Body", color: "#e91e63" },
    { type: "group", id: "obj_g", x: 0, y: 0, width: 300, height: 200, rotation: 0, zIndex: 0, locked: true, metadata: {}, memberIds: ["obj_t", "obj_n"], name: "Pair" },
    { type: "frame", id: "obj_f", x: 0, y: 0, width: 400, height: 300, rotation: 0, zIndex: 0, locked: false, metadata: {}, name: "Slide", color: "#2a6df5", frameShape: "rounded" },
    { type: "shape", id: "obj_s", x: 0, y: 0, width: 160, height: 100, rotation: 0, zIndex: 0, locked: false, metadata: {}, kind: "diamond", fill: "#5c6ff0", stroke: "#28359b", strokeWidth: 2 },
    { type: "connection", id: "obj_c", x: 0, y: 0, width: 100, height: 50, rotation: 0, zIndex: 0, locked: false, metadata: { route: "elbow" }, from: "obj_t", to: "", endX: 500, endY: 300, color: "#91a3f0", strokeWidth: 2, arrowhead: true, edgeFrom: "auto", edgeTo: "auto" },
    { type: "table", id: "obj_tb", x: 0, y: 0, width: 200, height: 120, rotation: 0, zIndex: 0, locked: false, metadata: {}, data: { columns: ["Item", "Value"], rows: [["A", "1"], ["B", "2"]] }, comparison: true },
    { type: "chart", id: "obj_ch", x: 0, y: 0, width: 200, height: 120, rotation: 0, zIndex: 0, locked: false, metadata: {}, kind: "pie", title: "Split", data: { columns: ["Label", "Value"], rows: [["X", "3"], ["Y", "4"]] } },
  ];
  return {
    project: { id: "proj_0ad4eb8d", name: "حاكم", createdAt: "2026-09-11T07:13:56.637Z", updatedAt: "2026-09-11T07:14:19.275Z", tags: ["design", "kanban"], shared: { roomId: "r1", serverUrl: "wss://collab.example", role: "owner" as const } },
    viewport: { x: 0, y: 0, zoom: 1 },
    objects,
    assets: [{ id: "ast_1", kind: "image" as const, name: "pic.png", size: 100, mime: "image/png", ext: "png" }],
  };
}

test("SSON serializer produces standard-form text for a complete project", () => {
  const p = sampleProject();
  const sson = projectFileToSSON(deserialize(serialize(p.viewport, p.objects, p.project, p.assets)));
  assert.ok(sson.startsWith("project {"));
  assert.match(sson, /format 1/);
  assert.match(sson, /pen "obj_a291d56c" \{/);
  assert.match(sson, /bounds 1042 394 155 232/);
  assert.match(sson, /1180 520/);
  assert.match(sson, /metadata \{ tags \[ "stroke" \] \}/);
  assert.ok(!sson.includes("formatVersion"), "SSON must not leak JSON keys");
  assert.ok(!sson.includes('"type":'), "SSON must not contain JSON");
});

test("SSON parses the canonical spec example", () => {
  const sson = `project {
    format 1

    info {
        id "proj_0ad4eb8d"
        name "حاكم"
        created "2026-09-11T07:13:56.637Z"
        updated "2026-09-11T07:14:19.275Z"
    }

    viewport {
        position 0 0
        zoom 1
    }

    objects [
        pen "obj_a291d56c" {
            color "#e8eaed"
            stroke 3
            bounds 1042 394 155 232

            points [
                1153 470
                1159 478
                1170 498
                1180 520
                1186 535
            ]
        }
    ]
}`;
  assert.ok(isSSON(sson));
  const file = projectFileFromSSON(sson);
  assert.equal(file.viewport.zoom, 1);
  assert.equal(file.objects.length, 1);
  const pen = file.objects[0] as { type: "pen"; points: { x: number; y: number }[]; strokeWidth: number };
  assert.equal(pen.type, "pen");
  assert.equal(pen.strokeWidth, 3);
  assert.equal(pen.points.length, 5);
  assert.deepEqual(pen.points[4], { x: 1186, y: 535 });
});

test("Project -> SSON -> Project round trip preserves the full model", () => {
  const src = sampleProject();
  const json = serialize(src.viewport, src.objects, src.project, src.assets);
  const sson = projectFileToSSON(deserialize(json));
  const reparsed = deserialize(ssonToJSON(sson));
  assert.deepEqual(reparsed.project, { id: "proj_0ad4eb8d", name: "حاكم", createdAt: "2026-09-11T07:13:56.637Z", updatedAt: "2026-09-11T07:14:19.275Z", tags: ["design", "kanban"], shared: { roomId: "r1", serverUrl: "wss://collab.example", role: "owner" } });
  assert.deepEqual(reparsed.viewport, src.viewport);
  assert.equal(reparsed.objects.length, src.objects.length);
  assert.deepEqual(reparsed.assets, src.assets);

  const pen = reparsed.objects[0] as typeof src.objects[0] & { points: { x: number; y: number; width?: number }[] };
  assert.equal(pen.points.length, 5);
  assert.deepEqual(pen.points[1], { x: 1159.5, y: 478 });
  assert.deepEqual(pen.points[2], { x: 1170, y: 498, width: 2.5 });
  const chart = reparsed.objects.find((o) => o.type === "chart") as { kind: string; data: { columns: string[]; rows: string[][] } };
  assert.equal(chart.kind, "pie");
  assert.deepEqual(chart.data, { columns: ["Label", "Value"], rows: [["X", "3"], ["Y", "4"]] });
  const text = reparsed.objects.find((o) => o.type === "text") as { text: string };
  assert.equal(text.text, "Spatia حاكم");
  // A connection's chosen route style survives the SSON round trip via metadata.
  const conn = reparsed.objects.find((o) => o.type === "connection") as { metadata: Record<string, unknown> };
  assert.equal(conn.metadata.route, "elbow");
});

test("Legacy JSON projects are detected and still open through the SSON path", () => {
  const src = sampleProject();
  const json = serialize(src.viewport, src.objects, src.project, src.assets);
  assert.ok(!isSSON(json), "JSON isn't mistaken for SSON");
  const file = deserialize(json);
  const migrated = projectFileToSSON(file);
  assert.ok(isSSON(migrated));
  const loaded = deserialize(ssonToJSON(migrated));
  assert.equal(loaded.objects.length, src.objects.length);
});