import type { RankedHit } from "../../shared/search/search.js";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Thin DOM layer for the Find modal. Keeps the keyboard (typing, Enter,
 * arrows, Escape) and click handling out of the App controller.
 */
export class SearchUI {
  readonly dialog = el<HTMLElement>("search-dialog");
  readonly input = el<HTMLInputElement>("search-input");
  readonly list = el<HTMLDivElement>("search-list");
  readonly count = el<HTMLSpanElement>("search-count");
  private readonly btnSearch = el<HTMLButtonElement>("btn-search");

  onQuery: ((q: string) => void) | null = null;
  onPick: ((id: string) => void) | null = null;
  onNext: (() => void) | null = null;
  onPrev: (() => void) | null = null;
  onDismiss: (() => void) | null = null;

  readonly btn: HTMLButtonElement;

  constructor() {
    this.btn = this.btnSearch;
    this.bind();
  }

  bind(): void {
    this.input.addEventListener("input", () => this.onQuery?.(this.input.value));
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.onPick?.("");
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        this.onNext?.();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        this.onPrev?.();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.onDismiss?.();
      }
    });
    this.list.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest("[data-hit-id]") as HTMLElement | null;
      if (row) this.onPick?.(row.dataset.hitId ?? "");
    });
    this.dialog.addEventListener("mousedown", (e) => {
      if (e.target === this.dialog) this.onDismiss?.();
    });
  }

  open(): void {
    this.dialog.classList.add("open");
    this.dialog.setAttribute("aria-hidden", "false");
    this.input.focus();
    this.input.select();
  }

  close(): void {
    this.dialog.classList.remove("open");
    this.dialog.setAttribute("aria-hidden", "true");
  }

  setQuery(query: string): void {
    if (this.input.value !== query) this.input.value = query;
  }

  render(results: readonly RankedHit[], activeId: string | null): void {
    this.count.textContent = results.length === 0 ? "" : `${results.length} result${results.length === 1 ? "" : "s"}`;
    if (results.length === 0) {
      this.list.innerHTML = `<div class="search-empty">No matches</div>`;
      return;
    }
    this.list.innerHTML = results
      .map(
        (r) =>
          `<button type="button" class="search-row${r.id === activeId ? " active" : ""}" data-hit-id="${escapeHtml(r.id)}">` +
          `<span class="search-kind">${escapeHtml(r.typeLabel)}</span>` +
          `<span class="search-label">${escapeHtml(r.label)}</span>` +
          `<span class="search-snippet">${r.snippet}</span>` +
          `</button>`
      )
      .join("");
  }

  /** Scroll the active row into view (used when navigating with arrows). */
  scrollActiveIntoView(): void {
    const active = this.list.querySelector(".search-row.active") as HTMLElement | null;
    if (active) active.scrollIntoView({ block: "nearest" });
  }
}