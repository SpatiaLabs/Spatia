import type { ProjectDocument, ProjectMeta } from "../../shared/types/project.js";
import type { CanvasObject, AssetMeta } from "../../shared/types/object.js";
import { serialize } from "../../shared/project/serialize.js";
import { Emitter } from "../state/emitter.js";

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
    this.sortedCache = null;
    this.changed.emit();
  }
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
