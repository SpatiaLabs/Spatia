import { test } from "node:test";
import assert from "node:assert/strict";
import { TEMPLATES, templateById } from "../shared/templates/templates.js";

test("there are exactly eight templates including a blank one", () => {
  assert.equal(TEMPLATES.length, 8);
  assert.ok(TEMPLATES.some((t) => t.id === "blank"));
});

test("every template has stable metadata", () => {
  for (const t of TEMPLATES) {
    assert.ok(t.id.length > 0);
    assert.ok(t.name.length > 0);
    assert.ok(t.description.length > 0);
    assert.match(t.accent, /^#[0-9a-fA-F]{6}$/);
    assert.equal(typeof t.build, "function");
  }
});

test("template ids are unique and findable", () => {
  const ids = new Set(TEMPLATES.map((t) => t.id));
  assert.equal(ids.size, TEMPLATES.length);
  assert.equal(templateById(TEMPLATES[0].id)?.id, TEMPLATES[0].id);
  assert.equal(templateById("nope"), null);
});

test("non-blank templates build valid objects with fresh ids and valid z-order", () => {
  for (const t of TEMPLATES) {
    if (t.id === "blank") continue;
    const objs = t.build();
    assert.ok(objs.length > 0, `${t.id} produces objects`);
    const ids = new Set(objs.map((o) => o.id));
    assert.equal(ids.size, objs.length, `${t.id} ids are unique`);
    const kinds = objs.map((o) => o.type);
    for (const kind of kinds) {
      assert.ok(["note", "text", "shape", "frame", "connection"].includes(kind), `${t.id} uses known kinds`);
    }
    const zs = objs.map((o) => o.zIndex);
    assert.equal(Math.max(...zs) - Math.min(...zs) + 1 >= zs.length, true, `${t.id} z-ordering is sane`);
    for (const o of objs) {
      assert.ok(Number.isFinite(o.x) && Number.isFinite(o.y), `${t.id} coordinates are finite`);
      if (o.type === "connection") {
        assert.ok(objs.some((x) => x.id === o.from), `${t.id} connection endpoint exists`);
        assert.ok(objs.some((x) => x.id === o.to), `${t.id} connection target exists`);
      }
      if (o.type === "shape") {
        assert.equal(typeof o.kind, "string");
      }
    }
  }
});

test("every build returns unique ids across template instances (not stale)", () => {
  const all = new Set<string>();
  for (const t of TEMPLATES) {
    for (const o of t.build()) {
      assert.ok(!all.has(o.id), `${t.id} reuses an id from an earlier build`);
      all.add(o.id);
    }
  }
});