import { Emitter } from "./emitter.js";

/**
 * Owns selection state: a set of selected object ids (multi-select). Kept
 * separate from project and viewport state so selection changes only affect
 * the canvas layer that needs to redraw selection outlines.
 */
export class SelectionStore {
  private ids = new Set<string>();
  readonly changed = new Emitter<readonly string[]>();

  get(): readonly string[] {
    return [...this.ids];
  }

  get size(): number {
    return this.ids.size;
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  /** Replace selection with exactly one id (or clear with null). */
  select(id: string | null): void {
    const next = new Set<string>();
    if (id !== null) next.add(id);
    if (setsEqual(this.ids, next)) return;
    this.ids = next;
    this.emit();
  }

  /** Replace with a set of ids. */
  setIds(ids: readonly string[]): void {
    const next = new Set(ids);
    if (setsEqual(this.ids, next)) return;
    this.ids = next;
    this.emit();
  }

  /** Toggle a single id in/out of the selection (shift/ctrl multi-select). */
  toggle(id: string): void {
    const next = new Set(this.ids);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.ids = next;
    this.emit();
  }

  /** Add ids while preserving the existing selection. */
  add(ids: readonly string[]): void {
    const next = new Set(this.ids);
    let changed = false;
    for (const id of ids) {
      if (!next.has(id)) {
        next.add(id);
        changed = true;
      }
    }
    if (changed) {
      this.ids = next;
      this.emit();
    }
  }

  clear(): void {
    if (this.ids.size === 0) return;
    this.ids = new Set();
    this.emit();
  }

  private emit(): void {
    this.changed.emit([...this.ids]);
  }
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
