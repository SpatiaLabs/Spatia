/**
 * Targeted per-object synchronization operations (Spatia 0.5.1).
 *
 * Unlike the Phase 2 whole-file snapshot broadcast, a client diffs its live
 * document against a known "baseline" and ships only what changed: object /
 * asset upserts and deletes plus project name/tag edits. The server linearizes
 * admitted batches with a monotonic `seq` and last-writer-wins applies them
 * with LWW per object, so concurrent editors converge without a journal.
 *
 * The module is pure JSON over plain-shaped state (`Record<string, unknown>`)
 * so BOTH the Electron renderer (typed `ProjectDocument`) and the plain-JS
 * collaboration server (persisted `room.file`) share one diff/apply/reducer
 * implementation. It is compiled to CommonJS alongside the protocol module for
 * the server (`dist/test/shared/collab/ops.js`).
 */

/** One targeted change. `obj` / `asset` are full plain-object payloads. */
export type CollabOp =
  | { kind: "meta"; name?: string; tags?: string[] }
  | { kind: "obj:upsert"; id: string; obj: Record<string, unknown> }
  | { kind: "obj:delete"; id: string }
  | { kind: "asset:upsert"; id: string; asset: Record<string, unknown> }
  | { kind: "asset:delete"; id: string };

/**
 * The subset of a document the ops engine stays in sync on: objects, assets
 * and the project's name/tags. Viewport, `shared` metadata and the object
 * `metadata`-independent fields like `updatedAt` are intentionally excluded so
 * local-only data never churns the wire.
 */
export interface CollabOpsState {
  objects: Record<string, unknown>[];
  assets: Record<string, unknown>[];
  meta: { name: string; tags?: string[] };
}

export const MAX_TAGS_SYNCED = 100;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function clonePlain(v: Record<string, unknown>): Record<string, unknown> {
  return { ...v };
}

/** Canonical JSON equality (producers serialize same key order, so this is stable). */
function jsonEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

function byId(list: readonly Record<string, unknown>[]): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const item of list) {
    if (typeof item.id === "string") out.set(item.id, item);
  }
  return out;
}

/**
 * Compute the ops needed to move `prev` (the last state the server knows) to
 * `next` (the local document). Missing ids become deletes, others upserts;
 * name/tags changes become (merged) meta ops. No op is emitted for equal state.
 */
export function diffOps(prev: CollabOpsState, next: CollabOpsState): CollabOp[] {
  const ops: CollabOp[] = [];

  const metaOp: { kind: "meta"; name?: string; tags?: string[] } = { kind: "meta" };
  if (prev.meta.name !== next.meta.name) metaOp.name = next.meta.name;
  const prevTags = prev.meta.tags ?? [];
  const nextTags = next.meta.tags ?? [];
  if (!jsonEq(prevTags, nextTags)) metaOp.tags = [...nextTags].slice(0, MAX_TAGS_SYNCED);
  if (metaOp.name !== undefined || metaOp.tags !== undefined) ops.push(metaOp);

  const prevObjs = byId(prev.objects);
  const nextObjs = byId(next.objects);
  for (const [id, obj] of prevObjs) {
    const n = nextObjs.get(id);
    if (!n) ops.push({ kind: "obj:delete", id });
    else if (!jsonEq(obj, n)) ops.push({ kind: "obj:upsert", id, obj: clonePlain(n) });
  }
  for (const [id, obj] of nextObjs) {
    if (!prevObjs.has(id)) ops.push({ kind: "obj:upsert", id, obj: clonePlain(obj) });
  }

  const prevAssets = byId(prev.assets);
  const nextAssets = byId(next.assets);
  for (const [id, a] of prevAssets) {
    const n = nextAssets.get(id);
    if (!n) ops.push({ kind: "asset:delete", id });
    else if (!jsonEq(a, n)) ops.push({ kind: "asset:upsert", id, asset: clonePlain(n) });
  }
  for (const [id, a] of nextAssets) {
    if (!prevAssets.has(id)) ops.push({ kind: "asset:upsert", id, asset: clonePlain(a) });
  }

  return ops;
}

/**
 * Apply ops to `state` in place (LWW: full-payload upserts win, deletes drop the
 * id, meta writes targeted name/tags). Returns how many ops changed state so
 * the server can skip no-op broadcasts. Delete ops do not honor `locked` here —
 * the rendering store enforces that rule locally; the server is not the source
 * of per-object lock authority.
 */
export function applyOps(state: CollabOpsState, ops: readonly CollabOp[]): number {
  let changed = 0;
  for (const op of ops) {
    switch (op.kind) {
      case "meta": {
        if (op.name !== undefined && state.meta.name !== op.name) {
          state.meta.name = op.name;
          changed++;
        }
        if (op.tags !== undefined) {
          const next = [...new Set(op.tags)].slice(0, MAX_TAGS_SYNCED);
          if (!jsonEq(state.meta.tags ?? [], next)) {
            state.meta.tags = next;
            changed++;
          }
        }
        break;
      }
      case "obj:upsert": {
        const idx = state.objects.findIndex((o) => o.id === op.id);
        if (idx >= 0) {
          if (!jsonEq(state.objects[idx], op.obj)) {
            state.objects[idx] = clonePlain(op.obj);
            changed++;
          }
        } else {
          state.objects.push(clonePlain(op.obj));
          changed++;
        }
        break;
      }
      case "obj:delete": {
        const idx = state.objects.findIndex((o) => o.id === op.id);
        if (idx >= 0) {
          state.objects.splice(idx, 1);
          changed++;
        }
        break;
      }
      case "asset:upsert": {
        const idx = state.assets.findIndex((a) => a.id === op.id);
        if (idx >= 0) {
          if (!jsonEq(state.assets[idx], op.asset)) {
            state.assets[idx] = clonePlain(op.asset);
            changed++;
          }
        } else {
          state.assets.push(clonePlain(op.asset));
          changed++;
        }
        break;
      }
      case "asset:delete": {
        const idx = state.assets.findIndex((a) => a.id === op.id);
        if (idx >= 0) {
          state.assets.splice(idx, 1);
          changed++;
        }
        break;
      }
    }
  }
  return changed;
}

/** Light structural guard for wire safety (deep object validation happens at apply time). */
export function isCollabOp(v: unknown): v is CollabOp {
  if (!isPlainObject(v)) return false;
  switch (v.kind) {
    case "meta": {
      if (v.name === undefined && v.tags === undefined) return false;
      if (v.name !== undefined && typeof v.name !== "string") return false;
      if (v.name !== undefined && v.name.length > 80) return false;
      if (v.tags !== undefined) {
        if (!Array.isArray(v.tags)) return false;
        if (v.tags.some((t) => typeof t !== "string")) return false;
        if (v.tags.length > MAX_TAGS_SYNCED) return false;
      }
      return true;
    }
    case "obj:upsert":
      return typeof v.id === "string" && v.id.length > 0 && v.id.length <= 128 && isPlainObject(v.obj);
    case "obj:delete":
      return typeof v.id === "string" && v.id.length > 0 && v.id.length <= 128;
    case "asset:upsert":
      return typeof v.id === "string" && v.id.length > 0 && v.id.length <= 128 && isPlainObject(v.asset);
    case "asset:delete":
      return typeof v.id === "string" && v.id.length > 0 && v.id.length <= 128;
    default:
      return false;
  }
}