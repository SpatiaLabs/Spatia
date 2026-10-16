import type { ProjectDocument, ProjectMeta, ShareInfo } from "../../shared/types/project.js";
import type { CanvasObject, AssetMeta } from "../../shared/types/object.js";
import { deserialize, serialize } from "../../shared/project/serialize.js";
import { Emitter } from "../state/emitter.js";
import type { CollabOp } from "../../shared/collab/ops.js";

export interface ProjectDocEvents {
  /** Emitted whenever document data changes (objects, meta, assets). */
  changed: void;
  /** Emitted when the active project is replaced wholesale (new / open). */
  replaced: void;
}

/**
 * Holds the project/document state: metadata, canvas objects and project-local
 * asset metadata. Exposes low-level, atomic mutation primitives used by the
 * command layer — the app only mutates document state through commands so
 * every change is undoable. Emits coarse "changed" signals; consumers decide
 * whether a redraw / UI update is needed.
 */
export class ProjectStore {
  private doc: ProjectDocument;
  /** Cached ascending-zIndex order, invalidated on any document mutation. */
  private sortedCache: CanvasObject[] | null = null;
  /**
   * Monotonic counter bumped on every document mutation. The canvas engine uses
   * it to fingerprint the static render layer, so it can skip repainting
   * committed objects while nothing but transient ink is changing.
   */
  private revision = 0;
  readonly changed = new Emitter<void>();
  readonly replaced = new Emitter<void>();

  constructor(doc?: ProjectDocument) {
    this.doc = doc ?? createNewDocument();
  }

  get(): ProjectDocument {
    return this.doc;
  }

  getMeta(): ProjectMeta {
    return { ...this.doc.meta };
  }

  getObjects(): readonly CanvasObject[] {
    return this.doc.objects;
  }

  /**
   * The objects in ascending z-order (bottom-most first). The order is cached
   * on first access and invalidated whenever document state changes, so the
   * render path never re-sorts the whole array per frame.
   */
  getObjectsSorted(): readonly CanvasObject[] {
    if (!this.sortedCache) {
      this.sortedCache = [...this.doc.objects].sort((a, b) => a.zIndex - b.zIndex);
    }
    return this.sortedCache;
  }

  getObject(id: string): CanvasObject | undefined {
    return this.doc.objects.find((o) => o.id === id);
  }

  getObjectsByIds(ids: readonly string[]): CanvasObject[] {
    return ids
      .map((id) => this.getObject(id))
      .filter((o): o is CanvasObject => o !== undefined);
  }

  getAssets(): readonly AssetMeta[] {
    return this.doc.assets;
  }

  getAsset(id: string): AssetMeta | undefined {
    return this.doc.assets.find((a) => a.id === id);
  }

  /** Replace the whole document (used by New / Open). */
  replace(doc: ProjectDocument): void {
    this.doc = doc;
    this.sortedCache = null;
    this.replaced.emit();
    this.changed.emit();
  }

  rename(name: string): void {
    if (this.doc.meta.name === name) return;
    this.doc.meta.name = name;
    this.touch();
  }

  // -------- Project meta (tags / sharing) --------

  getTags(): string[] {
    return [...(this.doc.meta.tags ?? [])];
  }

  setTags(tags: readonly string[]): void {
    const next = [...new Set(tags)].slice(0, 100);
    if (JSON.stringify(next) === JSON.stringify(this.getTags())) return;
    this.doc.meta.tags = next;
    this.touch();
  }

  getShared(): ShareInfo | undefined {
    return this.doc.meta.shared ? { ...this.doc.meta.shared } : undefined;
  }

  setShared(info: ShareInfo | null): void {
    this.doc.meta.shared = info ? { ...info } : undefined;
    this.touch();
  }

  // -------- Object mutation primitives (called only via commands) --------

  /** Append an object to the end (top) of the stack. */
  addObject(o: CanvasObject): void {
    this.doc.objects.push(o);
    this.touch();
  }

  /** Insert an object at a specific index (used by undo of delete). */
  insertObjectAt(index: number, o: CanvasObject): void {
    this.doc.objects.splice(Math.min(index, this.doc.objects.length), 0, o);
    this.touch();
  }

  /**
   * Remove the given ids and return snapshots (object + original index) in
   * stable order so a later insert can restore them exactly. Locked objects
   * are preserved (not removed).
   */
  removeObjects(ids: readonly string[]): { obj: CanvasObject; index: number }[] {
    const remove = new Set(ids.filter((id) => {
      const o = this.getObject(id);
      return o !== undefined && !o.locked;
    }));
    if (remove.size === 0) return [];
    const removed: { obj: CanvasObject; index: number }[] = [];
    const remaining: CanvasObject[] = [];
    for (let i = 0; i < this.doc.objects.length; i++) {
      const o = this.doc.objects[i];
      if (remove.has(o.id)) removed.push({ obj: o, index: i });
      else remaining.push(o);
    }
    this.doc.objects = remaining;
    this.touch();
    return removed;
  }

  /** Move several objects to absolute positions (top-left corner). */
  moveObjectsTo(positions: { id: string; x: number; y: number }[]): void {
    const byId = new Map(positions.map((p) => [p.id, p]));
    for (const o of this.doc.objects) {
      const p = byId.get(o.id);
      if (p) {
        o.x = p.x;
        o.y = p.y;
      }
    }
    this.touch();
  }

  /** Resize an object to the given rect (x, y, width, height). */
  resizeObject(id: string, x: number, y: number, width: number, height: number): void {
    const o = this.getObject(id);
    if (!o || o.locked) return;
    if (o.type === "frame") {
      // Browser frames keep a usable minimum on every resize path (handles,
      // inspector, plugins, undo/redo) so the page never collapses.
      width = Math.max(200, width);
      height = Math.max(150, height);
    }
    o.x = x;
    o.y = y;
    o.width = width;
    o.height = height;
    this.touch();
  }

  /** Set a named property on an object (used for style/type-specific edits). */
  setObjectProp(id: string, key: string, value: unknown): void {
    const o = this.getObject(id);
    if (!o) return;
    (o as unknown as Record<string, unknown>)[key] = value;
    this.touch();
  }

  /** Set the z-index of (possibly many) objects in one history step. */
  setZOrder(entries: { id: string; zIndex: number }[]): void {
    const byId = new Map(entries.map((e) => [e.id, e.zIndex]));
    for (const o of this.doc.objects) {
      const z = byId.get(o.id);
      if (z !== undefined) o.zIndex = z;
    }
    this.touch();
  }

  /** Assign fresh z-indexes so the given ids move to the very top (largest). */
  bringToFront(ids: readonly string[]): void {
    this.reorder(ids, "top");
  }

  /** Assign fresh z-indexes so the given ids move to the very bottom. */
  sendToBack(ids: readonly string[]): void {
    this.reorder(ids, "bottom");
  }

  private reorder(ids: readonly string[], where: "top" | "bottom"): void {
    const set = new Set(ids);
    const selected = this.doc.objects.filter((o) => set.has(o.id));
    const others = this.doc.objects.filter((o) => !set.has(o.id));
    let entries: { id: string; zIndex: number }[];
    if (where === "top") {
      entries = [...others, ...selected].map((o, i) => ({ id: o.id, zIndex: i + 1 }));
    } else {
      entries = [...selected, ...others].map((o, i) => ({ id: o.id, zIndex: i + 1 }));
    }
    this.setZOrder(entries);
  }

  // -------- Assets --------

  addAssets(assets: readonly AssetMeta[]): void {
    const existing = new Set(this.doc.assets.map((a) => a.id));
    for (const a of assets) {
      if (!existing.has(a.id)) {
        this.doc.assets.push(a);
        existing.add(a.id);
      }
    }
    this.touch();
  }

  /** Replace an asset's metadata (used after a successful relink). */
  replaceAsset(meta: AssetMeta): void {
    const idx = this.doc.assets.findIndex((a) => a.id === meta.id);
    if (idx >= 0) this.doc.assets[idx] = meta;
    else this.doc.assets.push(meta);
    this.touch();
  }

  /** Remove an asset record by id (used when cleaning up unused assets). */
  removeAsset(id: string): void {
    this.doc.assets = this.doc.assets.filter((a) => a.id !== id);
    this.touch();
  }

  // -------- Remote collaboration (ops sync, 0.5.1) --------

  /**
   * Apply a batch of remote ops from the collaboration server. Targeted per
   * object/asset/meta so a peer's change never wipes the local undo history
   * (full-file snapshots previously replaced the document and cleared it).
   * Locked objects survive remote deletes. Returns whether anything changed.
   */
  applyRemoteOps(ops: readonly CollabOp[]): boolean {
    let changed = false;
    for (const op of ops) {
      switch (op.kind) {
        case "meta": {
          if (op.name !== undefined && op.name !== this.doc.meta.name) {
            this.doc.meta.name = op.name;
            changed = true;
          }
          if (op.tags !== undefined) {
            const next = [...new Set(op.tags)].slice(0, 100);
            if (JSON.stringify(next) !== JSON.stringify(this.getTags())) {
              this.doc.meta.tags = next;
              changed = true;
            }
          }
          break;
        }
        case "obj:upsert": {
          const obj = toCanvasObject(op.obj);
          if (!obj) break;
          const idx = this.doc.objects.findIndex((o) => o.id === op.id);
          if (idx >= 0) {
            if (!jsonEqual(this.doc.objects[idx], obj)) {
              this.doc.objects[idx] = obj;
              changed = true;
            }
          } else {
            this.doc.objects.push(obj);
            changed = true;
          }
          break;
        }
        case "obj:delete": {
          const idx = this.doc.objects.findIndex((o) => o.id === op.id);
          if (idx >= 0 && !this.doc.objects[idx].locked) {
            this.doc.objects.splice(idx, 1);
            changed = true;
          }
          break;
        }
        case "asset:upsert": {
          const asset = toAssetMeta(op.asset);
          if (!asset) break;
          const idx = this.doc.assets.findIndex((a) => a.id === op.id);
          if (idx >= 0) {
            if (!jsonEqual(this.doc.assets[idx], asset)) {
              this.doc.assets[idx] = asset;
              changed = true;
            }
          } else {
            this.doc.assets.push(asset);
            changed = true;
          }
          break;
        }
        case "asset:delete": {
          const idx = this.doc.assets.findIndex((a) => a.id === op.id);
          if (idx >= 0) {
            this.doc.assets.splice(idx, 1);
            changed = true;
          }
          break;
        }
      }
    }
    if (changed) this.touch();
    return changed;
  }

  /**
   * Adopt the reconciled state produced by the sync engine on (re)join: the
   * union of the room's authoritative objects/assets and the local edits the
   * merge decided to keep. Replaces the arrays in place so undo history and
   * the document identity survive — no `replaced` (and thus no history wipe).
   */
  applyMerged(objects: readonly CanvasObject[], assets: readonly AssetMeta[], meta: ProjectMeta): void {
    this.doc.objects = objects.map((o) => ({ ...o }));
    this.doc.assets = assets.map((a) => ({ ...a }));
    this.doc.meta.id = meta.id;
    this.doc.meta.name = meta.name;
    this.doc.meta.createdAt = meta.createdAt;
    if (meta.tags !== undefined) this.doc.meta.tags = [...meta.tags];
    this.touch();
  }

  // -------- Viewport --------

  setViewport(x: number, y: number, zoom: number): void {
    this.doc.viewport.x = x;
    this.doc.viewport.y = y;
    this.doc.viewport.zoom = zoom;
  }

  /** Largest z-index currently in use. */
  nextZIndex(): number {
    let max = 0;
    for (const o of this.doc.objects) if (o.zIndex > max) max = o.zIndex;
    return max + 1;
  }

  private touch(): void {
    this.doc.meta.updatedAt = new Date().toISOString();
    this.revision += 1;
    this.sortedCache = null;
    this.changed.emit();
  }

  /** Fingerprint of the current document state (see {@link revision}). */
  getRevision(): number {
    return this.revision;
  }
}

/** Canonical deep equality used to detect no-op remote ops. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Validate and normalize a raw wire object payload into a typed CanvasObject by
 * running it through the same projector validation the file loader uses.
 * Returns null when the payload is not a valid object shape.
 */
function toCanvasObject(raw: Record<string, unknown>): CanvasObject | null {
  try {
    const container = {
      formatVersion: 5,
      project: { id: "shared", name: "shared", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      viewport: { x: 0, y: 0, zoom: 1 },
      objects: [raw],
      assets: [],
    };
    const parsed = deserialize(JSON.stringify(container));
    return parsed.objects[0];
  } catch {
    return null;
  }
}

const ASSET_KINDS = new Set(["image", "file", "video", "audio", "pdf"]);

function toAssetMeta(raw: Record<string, unknown>): AssetMeta | null {
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  if (!ASSET_KINDS.has(String(raw.kind))) return null;
  if (typeof raw.name !== "string" || typeof raw.size !== "number" || typeof raw.mime !== "string" || typeof raw.ext !== "string") {
    return null;
  }
  const asset: AssetMeta = {
    id: raw.id,
    kind: raw.kind as AssetMeta["kind"],
    name: raw.name,
    size: raw.size,
    mime: raw.mime,
    ext: raw.ext,
  };
  if (typeof raw.thumbnail === "string" && raw.thumbnail !== "") asset.thumbnail = raw.thumbnail;
  return asset;
}

export function createNewDocument(name = "Untitled Project"): ProjectDocument {
  const now = new Date().toISOString();
  return {
    meta: {
      id: "proj_" + createUuid(),
      name,
      createdAt: now,
      updatedAt: now,
    },
    viewport: { x: 0, y: 0, zoom: 1 },
    objects: [],
    assets: [],
  };
}

function createUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export { serialize };
