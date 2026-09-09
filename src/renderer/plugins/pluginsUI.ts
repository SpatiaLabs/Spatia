import type { PluginEntry } from "../../shared/plugins/manifest.js";
import type { PluginCommand } from "./pluginManager.js";

/**
 * Thin DOM layer for the Plugins dialog. The dialog is shared markup in both
 * the desktop and web index.html shells; this class only wires events and
 * renders the entry list. All state lives in the PluginManager / App.
 */
export class PluginsUI {
  private dialog: HTMLElement;
  private list: HTMLElement;
  private installBtn: HTMLButtonElement;
  private closeBtn: HTMLButtonElement;
  private urlInput: HTMLInputElement | null;
  private urlBtn: HTMLButtonElement | null;

  onInstall: (() => void) | null = null;
  onInstallUrl: ((url: string) => void) | null = null;
  onToggle: ((id: string, enabled: boolean) => void) | null = null;
  onRemove: ((id: string) => void) | null = null;
  onRunCommand: ((commandId: string) => void) | null = null;

  constructor() {
    this.dialog = requireEl("plugins-dialog");
    this.list = requireEl("plugins-list");
    this.installBtn = requireEl<HTMLButtonElement>("plugins-install");
    this.closeBtn = requireEl<HTMLButtonElement>("plugins-close");
    this.urlInput = document.getElementById("plugins-url") as HTMLInputElement | null;
    this.urlBtn = document.getElementById("plugins-install-url") as HTMLButtonElement | null;

    this.installBtn.addEventListener("click", () => this.onInstall?.());
    this.urlBtn?.addEventListener("click", () => {
      const url = (this.urlInput?.value ?? "").trim();
      if (url) this.onInstallUrl?.(url);
    });
    this.urlInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.urlBtn?.click();
    });
    this.closeBtn.addEventListener("click", () => this.close());
    this.dialog.addEventListener("mousedown", (e) => {
      if (e.target === this.dialog) this.close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.isOpen()) this.close();
    });
  }

  isOpen(): boolean {
    return this.dialog.classList.contains("open");
  }

  open(): void {
    this.dialog.classList.add("open");
    this.dialog.setAttribute("aria-hidden", "false");
  }

  close(): void {
    this.dialog.classList.remove("open");
    this.dialog.setAttribute("aria-hidden", "true");
  }

  render(entries: PluginEntry[], commands: PluginCommand[], runtimeError?: (id: string) => string | null): void {
    const runtimeErr = runtimeError ?? (() => null);
    const cmdsFor = new Map<string, PluginCommand[]>();
    for (const c of commands) {
      const list = cmdsFor.get(c.pluginId) ?? [];
      list.push(c);
      cmdsFor.set(c.pluginId, list);
    }

    if (entries.length === 0) {
      this.list.innerHTML =
        '<div class="plugin-empty">No plugins installed yet.<br>' +
        '<span>Install a plugin from its manifest.json URL, or pick a plugin folder (manifest.json + main.js) to extend Spatia.</span></div>';
      return;
    }

    const rows: string[] = [];
    for (const e of entries) {
      const m = e.manifest;
      const name = m?.name ?? e.id;
      const version = m?.version ? `v${m.version}` : "";
      const author = m?.author ? `by ${m.author}` : "";
      const description = m?.description ?? "";
      const error = e.error ?? runtimeErr(e.id) ?? "";
      const perms = m && Array.isArray(m.permissions) ? (m.permissions as string[]) : [];

      rows.push(
        `<div class="plugin-entry${e.enabled ? " enabled" : ""}" data-plugin="${escapeAttr(e.id)}">` +
          `<div class="plugin-head">` +
          `<label class="plugin-toggle">` +
          `<input type="checkbox" data-plugin-toggle="${escapeAttr(e.id)}"${e.enabled ? " checked" : ""}>` +
          `<span class="plugin-toggle-track"><span class="plugin-toggle-thumb"></span></span>` +
          `<span class="plugin-toggle-label">${e.enabled ? "Enabled" : "Disabled"}</span>` +
          `</label>` +
          `<span class="plugin-name">${escapeHtml(name)}</span>` +
          (version ? `<span class="plugin-version">${escapeHtml(version)}</span>` : "") +
          (m?.apiVersion ? `<span class="plugin-version plugin-api-badge">API v${m.apiVersion}</span>` : "") +
          `</div>` +
          `<div class="plugin-meta">${escapeHtml([author, description].filter(Boolean).join(" &nbsp;·&nbsp; "))}</div>` +
          (perms.length
            ? `<div class="plugin-perms">${perms
                .map((p) => `<span class="plugin-perm">${escapeHtml(p)}</span>`)
                .join("")}</div>`
            : "") +
          (error ? `<div class="plugin-error">${escapeHtml(error)}</div>` : "") +
          (cmdsFor.get(e.id)?.length
            ? `<div class="plugin-actions">${(cmdsFor.get(e.id) ?? [])
                .map(
                  (c) =>
                    `<button class="btn inspector-btn plugin-action" data-plugin-run="${escapeAttr(c.id)}" type="button">${escapeHtml(c.label)}</button>`
                )
                .join("")}</div>`
            : "") +
          (e.builtIn
            ? `<div class="plugin-row-foot"><span class="plugin-builtin">Built-in</span></div>`
            : `<div class="plugin-row-foot"><button class="btn inspector-btn plugin-remove" data-plugin-remove="${escapeAttr(e.id)}" type="button">Remove</button></div>`) +
          `</div>`
      );
    }
    this.list.innerHTML = rows.join("");

    this.list.querySelectorAll("[data-plugin-toggle]").forEach((el) => {
      const input = el as HTMLInputElement;
      input.addEventListener("change", () => {
        this.onToggle?.(input.getAttribute("data-plugin-toggle") ?? "", input.checked);
      });
    });
    this.list.querySelectorAll("[data-plugin-run]").forEach((el) => {
      el.addEventListener("click", () => this.onRunCommand?.(el.getAttribute("data-plugin-run") ?? ""));
    });
    this.list.querySelectorAll("[data-plugin-remove]").forEach((el) => {
      el.addEventListener("click", () => this.onRemove?.(el.getAttribute("data-plugin-remove") ?? ""));
    });
  }
}

function requireEl<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}