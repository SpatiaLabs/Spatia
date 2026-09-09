import { searchItems, type RankedHit, type SearchableItem } from "../../shared/search/search.js";
import { Emitter } from "./emitter.js";

/**
 * Search store. Holds a snapshot corpus (built from document objects on open)
 * plus the live query/result state. Pure state — no DOM, no selection side
 * effects; the App controller reacts to results.
 */
export class SearchStore {
  private items: SearchableItem[] = [];
  private results: RankedHit[] = [];
  private _open = false;
  private _query = "";
  private _activeId: string | null = null;
  private emitter = new Emitter();

  onChange(fn: () => void): void {
    this.emitter.subscribe(fn);
  }

  get isOpen(): boolean {
    return this._open;
  }

  get query(): string {
    return this._query;
  }

  get resultList(): readonly RankedHit[] {
    return this.results;
  }

  get activeId(): string | null {
    return this._activeId;
  }

  /** Open the search with a fresh corpus snapshot. */
  open(items: SearchableItem[]): void {
    this.items = items;
    this._query = "";
    this._activeId = null;
    this.results = [];
    this._open = true;
    this.emitter.emit();
  }

  close(): void {
    if (!this._open) return;
    this._open = false;
    this._query = "";
    this._activeId = null;
    this.results = [];
    this.emitter.emit();
  }

  toggle(items: SearchableItem[]): void {
    if (this._open) this.close();
    else this.open(items);
  }

  setQuery(query: string): void {
    this._query = query;
    this._activeId = null;
    this.results = query.trim() ? searchItems(this.items, query) : [];
    if (this.results.length > 0) this._activeId = this.results[0].id;
    this.emitter.emit();
  }

  selectNext(): void {
    if (this.results.length === 0) return;
    const idx = this.results.findIndex((r) => r.id === this._activeId);
    const next = this.results[(idx + 1) % this.results.length];
    this._activeId = next.id;
    this.emitter.emit();
  }

  selectPrev(): void {
    if (this.results.length === 0) return;
    const idx = this.results.findIndex((r) => r.id === this._activeId);
    const next = this.results[(idx - 1 + this.results.length) % this.results.length];
    this._activeId = next.id;
    this.emitter.emit();
  }

  setActiveId(id: string): void {
    this._activeId = id;
    this.emitter.emit();
  }

  /** The first ranked hit, if any. */
  primaryHit(): RankedHit | null {
    return this.results[0] ?? null;
  }

  /** The currently highlighted hit, falling back to the first. */
  activeHit(): RankedHit | null {
    return this.results.find((r) => r.id === this._activeId) ?? this.results[0] ?? null;
  }
}