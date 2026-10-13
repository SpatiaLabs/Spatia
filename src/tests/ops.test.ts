import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { applyOps, diffOps, isCollabOp, type CollabOp, type CollabOpsState } from "../shared/collab/ops.js";

const A = { type: "note", id: "a", x: 1, y: 2, width: 100, height: 80, rotation: 0, zIndex: 1, locked: false, metadata: {}, title: "A", text: "alpha", color: "#f0c33c" };
const B = { type: "note", id: "b", x: 1, y: 2, width: 100, height: 80, rotation: 0, zIndex: 1, locked: false, metadata: {}, title: "B", text: "beta", color: "#f0c33c" };
const IMG = { id: "img1", kind: "image", name: "pic.png", size: 10, mime: "image/png", ext: ".png" };

function state(partial?: Partial<CollabOpsState>): CollabOpsState {
  return { objects: [], assets: [], meta: { name: "Room" }, ...(partial ?? {}) };
}

describe("diffOps", () => {
  it("emits upserts for new objects and assets and meta name/tags changes", () => {
    const prev = state();
    const next = state({ objects: [A], assets: [IMG], meta: { name: "Renamed", tags: ["x", "y"] } });
    const ops = diffOps(prev, next);
    assert.deepEqual(
      ops.map((o) => o.kind).sort(),
      ["asset:upsert", "meta", "obj:upsert"],
    );
    const meta = ops.find((o) => o.kind === "meta") as { kind: "meta"; name?: string; tags?: string[] };
    assert.equal(meta.name, "Renamed");
    assert.deepEqual(meta.tags, ["x", "y"]);
  });

  it("emits deletes and upserts for changed objects symmetrically", () => {
    const C = { type: "note", id: "c", x: 0, y: 0, width: 20, height: 20, rotation: 0, zIndex: 2, locked: false, metadata: {}, title: "C", text: "gamma", color: "#f0c33c" };
    const prev = state({ objects: [A, B] });
    const next = state({ objects: [{ ...A, x: 99 }, C] });
    const ops = diffOps(prev, next);
    assert.ok(ops.some((o) => o.kind === "obj:upsert" && o.id === "a" && (o.obj as { x: number }).x === 99));
    assert.ok(ops.some((o) => o.kind === "obj:upsert" && o.id === "c"));
    assert.ok(ops.some((o) => o.kind === "obj:delete" && o.id === "b"));
  });

  it("emits nothing when state is equal", () => {
    const prev = state({ objects: [A], meta: { name: "Room", tags: ["t"] } });
    const next = state({ objects: [A], meta: { name: "Room", tags: ["t"] } });
    assert.equal(diffOps(prev, next).length, 0);
  });
});

describe("applyOps", () => {
  it("applies upserts/updates/deletes and reports material changes", () => {
    const s = state({ objects: [{ ...A }], meta: { name: "Room" } });
    const C = { type: "note", id: "new", x: 0, y: 0, width: 20, height: 20, rotation: 0, zIndex: 2, locked: false, metadata: {}, title: "C", text: "gamma", color: "#f0c33c" };
    const batch: CollabOp[] = [
      { kind: "obj:upsert", id: "a", obj: { ...A, x: 5 } },
      { kind: "obj:upsert", id: "new", obj: C },
      { kind: "obj:delete", id: "missing" },
      { kind: "meta", name: "Renamed" },
    ];
    const changed = applyOps(s, batch);
    assert.equal(changed, 3);
    assert.equal(s.objects.length, 2);
    assert.equal((s.objects[0] as { x: number }).x, 5);
    assert.equal(s.meta.name, "Renamed");
    // Applying the batch again is a no-op (LWW keeps state stable).
    assert.equal(applyOps(s, batch), 0);
  });

  it("caps and dedupes tags", () => {
    const s = state({ meta: { name: "Room", tags: [] } });
    const tags = Array.from({ length: 120 }, (_, i) => `t${i % 3}`);
    applyOps(s, [{ kind: "meta", tags }]);
    assert.equal(s.meta.tags?.length, 3);
    assert.equal(applyOps(s, [{ kind: "obj:delete", id: "zzz" }]), 0);
  });
});

describe("isCollabOp", () => {
  it("accepts well-formed ops and rejects malformed ones", () => {
    assert.ok(isCollabOp({ kind: "obj:upsert", id: "x", obj: { type: "note" } }));
    assert.ok(isCollabOp({ kind: "obj:delete", id: "x" }));
    assert.ok(isCollabOp({ kind: "meta", name: "N", tags: ["a"] }));
    assert.ok(isCollabOp({ kind: "asset:delete", id: "x" }));
    assert.ok(!isCollabOp({ kind: "obj:upsert", obj: {} }));
    assert.ok(!isCollabOp({ kind: "meta" }));
    assert.ok(!isCollabOp({ kind: "meta", name: 5 }));
    assert.ok(!isCollabOp({ kind: "wat", id: "x" }));
    assert.ok(!isCollabOp(null));
  });
});