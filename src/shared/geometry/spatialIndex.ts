import type { Point, Rect } from "./viewport.js";

/**
 * A uniform-grid spatial index over an unbounded world. Buckets objects into
 * fixed-size world cells so point/range queries only touch overlapping cells
 * instead of scanning every object. Framework-free for renderer + tests.
 */
export interface IndexedRect {
  id: string;
  rect: Rect;
}

const CELL_SIZE = 512;

export class SpatialGrid {
  private cells = new Map<string, Set<string>>();
  private rects = new Map<string, Rect>();

  private key(cx: number, cy: number): string {
    return cx + ":" + cy;
  }

  private addToCell(id: string, cx: number, cy: number): void {
    const k = this.key(cx, cy);
    let set = this.cells.get(k);
    if (!set) {
      set = new Set();
      this.cells.set(k, set);
    }
    set.add(id);
  }

  insert(id: string, rect: Rect): void {
    if (this.rects.has(id)) return;
    this.rects.set(id, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    this.forEachCell(rect.x, rect.y, rect.width, rect.height, (cx, cy) => this.addToCell(id, cx, cy));
  }

  remove(id: string): void {
    const rect = this.rects.get(id);
    if (!rect) return;
    this.rects.delete(id);
    this.forEachCell(rect.x, rect.y, rect.width, rect.height, (cx, cy) => {
      const k = this.key(cx, cy);
      const set = this.cells.get(k);
      if (set) {
        set.delete(id);
        if (set.size === 0) this.cells.delete(k);
      }
    });
  }

  update(id: string, _oldRect: Rect, newRect: Rect): void {
    this.remove(id);
    this.insert(id, newRect);
  }

  rebuild(entries: readonly IndexedRect[]): void {
    this.cells.clear();
    this.rects.clear();
    for (const e of entries) this.insert(e.id, e.rect);
  }

  clear(): void {
    this.cells.clear();
    this.rects.clear();
  }

  get size(): number {
    return this.rects.size;
  }

  allIds(): string[] {
    return [...this.rects.keys()];
  }

  queryPoint(p: Point): string[] {
    const cx = Math.floor(p.x / CELL_SIZE);
    const cy = Math.floor(p.y / CELL_SIZE);
    const set = this.cells.get(this.key(cx, cy));
    return set ? [...set] : [];
  }

  queryRect(rect: Rect): string[] {
    const out = new Set<string>();
    this.forEachCell(rect.x, rect.y, rect.width, rect.height, (cx, cy) => {
      const set = this.cells.get(this.key(cx, cy));
      if (set) for (const id of set) out.add(id);
    });
    return [...out];
  }

  contains(id: string): boolean {
    return this.rects.has(id);
  }

  private forEachCell(x: number, y: number, width: number, height: number, fn: (cx: number, cy: number) => void): void {
    if (!Number.isFinite(x + y + width + height)) return;
    const minCx = Math.floor(x / CELL_SIZE);
    const minCy = Math.floor(y / CELL_SIZE);
    const maxCx = Math.floor((x + width) / CELL_SIZE);
    const maxCy = Math.floor((y + height) / CELL_SIZE);
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) fn(cx, cy);
    }
  }
}
