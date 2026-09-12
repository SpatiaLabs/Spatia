/**
 * Thin DOM layer for the Command Palette (Ctrl+K). Holds no logic of its own:
 * the App supplies the filtered command rows each time the query changes, and
 * owns navigation state so keyboard handling stays coherent with the app's
 * other global shortcuts.
 *
 * Keyboard rules — as with SearchUI, only these navigation keys are consumed:
 *   ArrowDown / ArrowUp   move the active row (wrapping),
 *   Tab / Shift+Tab       move the active row (wrapping),
 *   Enter                 run the active row,
 *   Ctrl+K (meta+K)       close the palette again,
 *   Escape                close the palette.
 * Every other key falls through to the native input (spaces, text, IME…), and
 * because the input is an <input>, the global canvas/app handlers already
 * yield to it (see ui/editTarget.ts).
 */
export class CommandPalette {
  private dialog: HTMLElement;
  private input: HTMLInputElement;
  private list: HTMLElement;
  private count: HTMLElement;

  onQuery: ((q: string) => void) | null = null;
  onPick: ((index: number) => void) | null = null;
  onDismiss: (() => void) | null = null;

  constructor() {
    this.dialog = requireEl("command-dialog");
    this.input = requireEl<HTMLInputElement>("command-input");
    this.list = requireEl("command-list");
    this.count = requireEl("command-count");
    this.bind();
  }

  private bind(): void {
    this.input.addEventListener("input", () => this.onQuery?.(this.input.value));
    this.input.addEventListener("keydown", (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key;
      if (mod && (key === "k" || key === "K")) {
        e.preventDefault();
        this.onDismiss?.();
        return;
      }
      switch (key) {
        case "ArrowDown":
        case "Tab":
          e.preventDefault();
          this.onPick?.(e.shiftKey ? -1 : 1);
          return;
        case "ArrowUp":
          e.preventDefault();
          this.onPick?.(-1);
          return;
        case "Enter":
          e.preventDefault();
          this.onPick?.(0);
          return;
        case "Escape":
          e.preventDefault();
          this.onDismiss?.();
          return;
      }
    });
    this.list.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest("[data-index]") as HTMLElement | null;
      if (!row) return;
      this.onPick?.(Number(row.dataset.index ?? "-1"));
    });
    this.dialog.addEventListener("mousedown", (e) => {
      if (e.target === this.dialog) this.onDismiss?.();
    });
  }

  open(): void {
    this.dialog.classList.add("open");
    this.dialog.setAttribute("aria-hidden", "false");
    this.input.value = "";
    this.input.focus();
    this.input.select();
  }

  close(): void {
    this.dialog.classList.remove("open");
    this.dialog.setAttribute("aria-hidden", "true");
  }

  isOpen(): boolean {
    return this.dialog.classList.contains("open");
  }

  query(): string {
    return this.input.value;
  }

  escapeHtml(s: string): string {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /** Render filtered rows. Passing a pre-filled query keeps input stable. */
  render(rows: PaletteRow[], query: string): void {
    if (this.input.value !== query) this.input.value = query;
    this.count.textContent = rows.length === 0 ? "" : `${rows.length} command${rows.length === 1 ? "" : "s"}`;
    if (rows.length === 0) {
      this.list.innerHTML = `<div class="command-empty">No matching commands</div>`;
      return;
    }
    this.list.innerHTML = rows
      .map(
        (r) =>
          `<button type="button" class="command-row${r.active ? " active" : ""}${r.disabled ? " disabled" : ""}" data-index="${r.index}" ${r.disabled ? "tabindex=\"-1\"" : ""}>` +
          `<span class="command-category">${this.escapeHtml(r.category)}</span>` +
          `<span class="command-label">${this.escapeHtml(r.label)}</span>` +
          `<span class="command-shortcut">${this.escapeHtml(r.shortcut ?? "")}</span>` +
          `</button>`
      )
      .join("");
    const active = this.list.querySelector<HTMLElement>(".command-row.active");
    if (active) active.scrollIntoView({ block: "nearest" });
  }
}

export interface PaletteRow {
  index: number;
  category: string;
  label: string;
  shortcut?: string;
  active: boolean;
  disabled?: boolean;
}

export function requireEl<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}