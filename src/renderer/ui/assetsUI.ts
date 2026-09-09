import type { AssetMeta } from "../../shared/types/object.js";

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

function humanSize(bytes: number): string {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

function kindLabel(kind: AssetMeta["kind"]): string {
  if (kind === "image") return "Image";
  if (kind === "video") return "Video";
  if (kind === "audio") return "Audio";
  if (kind === "pdf") return "PDF";
  return "File";
}

/** Glyph shown when an asset has no generated thumbnail. */
function kindGlyph(kind: AssetMeta["kind"]): string {
  if (kind === "image") return "&#128247;";
  if (kind === "video") return "&#127909;";
  if (kind === "audio") return "&#127911;";
  if (kind === "pdf") return "&#128196;";
  return "&#128194;";
}

export interface AssetsUIView {
  assets: readonly AssetMeta[];
  usedBy: Map<string, number>;
  canEdit: boolean;
}

/**
 * Thin DOM layer for the Assets panel: a gallery of thumbnail chips over the
 * project's imported media/files. This class owns DOM + events only; the App
 * controller provides the data and performs the bridge operations.
 */
export class AssetsUI {
  readonly panel = el<HTMLElement>("assets-panel");
  readonly btnAssets = el<HTMLButtonElement>("btn-assets");

  private closeBtn = el<HTMLButtonElement>("assets-close");
  private title = el<HTMLDivElement>("assets-title");
  private list = el<HTMLDivElement>("assets-list");
  private canEdit = true;

  onOpen: ((assetId: string) => void) | null = null;
  onRelink: ((assetId: string) => void) | null = null;
  onRemove: ((assetId: string) => void) | null = null;
  onSelect: ((assetId: string) => void) | null = null;
  onPanelToggle: ((open: boolean) => void) | null = null;

  constructor() {
    this.bind();
  }

  isOpen(): boolean {
    return this.panel.classList.contains("panel-open");
  }

  setOpen(open: boolean): void {
    this.panel.classList.toggle("panel-open", open);
    this.panel.setAttribute("aria-hidden", open ? "false" : "true");
    this.onPanelToggle?.(open);
  }

  toggle(): void {
    this.setOpen(!this.isOpen());
  }

  private bind(): void {
    this.closeBtn.addEventListener("click", () => this.setOpen(false));
    this.list.addEventListener("click", (e) => {
      const chip = (e.target as HTMLElement).closest<HTMLElement>("[data-asset-id]");
      const assetId = chip?.dataset.assetId ?? "";
      if (!assetId) return;
      const actionNode = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
      const action = actionNode?.dataset.action;
      if (action === "open") {
        this.onOpen?.(assetId);
      } else if (action === "relink") {
        this.onRelink?.(assetId);
      } else if (action === "remove") {
        this.onRemove?.(assetId);
      } else if (chip) {
        this.onSelect?.(assetId);
      }
    });
  }

  render(view: AssetsUIView): void {
    this.canEdit = view.canEdit;
    this.title.textContent = `Assets (${view.assets.length})`;
    if (view.assets.length === 0) {
      this.list.innerHTML = `<div class="assets-empty">No assets yet. Import images or files onto the canvas.</div>`;
      return;
    }
    this.list.innerHTML = view.assets
      .map((a) => {
        const used = view.usedBy.get(a.id) ?? 0;
        const thumb = a.thumbnail
          ? `<img class="asset-thumb-img" src="${escapeHtml(a.thumbnail)}" alt="" loading="lazy" />`
          : `<span class="asset-thumb-glyph">${kindGlyph(a.kind)}</span>`;
        const actions = this.canEdit
          ? `<div class="asset-actions">` +
            `<button class="btn asset-btn" data-action="open" type="button" title="Open file">Open</button>` +
            `<button class="btn asset-btn" data-action="relink" type="button" title="Replace file">Relink</button>` +
            `<button class="btn asset-btn asset-btn-danger" data-action="remove" type="button" title="Delete asset permanently">Remove</button>` +
            `</div>`
          : `<div class="asset-actions"><span class="asset-viewer-note">Viewer — cannot change assets</span></div>`;
        return (
          `<div class="asset-chip" data-asset-id="${escapeHtml(a.id)}" title="Click to find on canvas">` +
          `<span class="asset-thumb">${thumb}</span>` +
          `<div class="asset-info">` +
          `<div class="asset-name">${escapeHtml(a.name)}</div>` +
          `<div class="asset-meta">${kindLabel(a.kind)} · ${humanSize(a.size)} · used by ${used}</div>` +
          actions +
          `</div>` +
          `</div>`
        );
      })
      .join("");
  }
}