import type { ViewportState } from "../../shared/types/project.js";
import type { ProjectMeta } from "../../shared/types/project.js";
import { initInspectorColorPickers } from "./colorPicker.js";

export interface RecentProjectItem {
  filePath: string;
  name: string;
  openedAt: string;
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

/**
 * Thin DOM layer for the Spatia shell. Holds no state of its own; the app
 * controller tells it what to render. Keeps DOM manipulation out of the canvas
 * engine and state stores.
 */
export class AppUI {
  private statusText = el<HTMLSpanElement>("status-text");
  private zoomLabel = el<HTMLDivElement>("zoom-label");
  private cursorLabel = el<HTMLDivElement>("cursor-label");
  private canvas = el<HTMLCanvasElement>("canvas");

  readonly btnNew = el<HTMLButtonElement>("btn-new");
  readonly btnOpen = el<HTMLButtonElement>("btn-open");
  readonly btnImport = el<HTMLButtonElement>("btn-import");
  readonly btnSave = el<HTMLButtonElement>("btn-save");
  readonly btnSaveAs = el<HTMLButtonElement>("btn-save-as");
  readonly btnExport = el<HTMLButtonElement>("btn-export");
  readonly btnUndo = el<HTMLButtonElement>("btn-undo");
  readonly btnRedo = el<HTMLButtonElement>("btn-redo");
  readonly btnAddText = el<HTMLButtonElement>("btn-add-text");
  readonly btnAddNote = el<HTMLButtonElement>("btn-add-note");
  readonly btnAddImage = el<HTMLButtonElement>("btn-add-image");
  readonly btnAddFile = el<HTMLButtonElement>("btn-add-file");
  readonly btnAddUrl = el<HTMLButtonElement>("btn-add-url");
  readonly btnAddTest = el<HTMLButtonElement>("btn-add-test");
  readonly btnAddShapeRectangle = el<HTMLButtonElement>("btn-add-shape-rectangle");
  readonly btnAddShapeRoundedRectangle = el<HTMLButtonElement>("btn-add-shape-rounded-rectangle");
  readonly btnAddShapeEllipse = el<HTMLButtonElement>("btn-add-shape-ellipse");
  readonly btnAddShapeDiamond = el<HTMLButtonElement>("btn-add-shape-diamond");
  readonly btnAddShapeTriangle = el<HTMLButtonElement>("btn-add-shape-triangle");
  readonly btnAddShapeLine = el<HTMLButtonElement>("btn-add-shape-line");
  readonly btnAddShapeArrow = el<HTMLButtonElement>("btn-add-shape-arrow");
  readonly btnTemplates = el<HTMLButtonElement>("btn-templates");
  readonly btnZoomIn = el<HTMLButtonElement>("btn-zoom-in");
  readonly btnZoomOut = el<HTMLButtonElement>("btn-zoom-out");
  readonly btnZoomReset = el<HTMLButtonElement>("btn-zoom-reset");
  readonly btnPen = el<HTMLButtonElement>("btn-pen");
  readonly btnPenSidebar = el<HTMLButtonElement>("btn-pen-sidebar");
  readonly btnSelect = el<HTMLButtonElement>("btn-select");
  readonly sidebar = el<HTMLElement>("sidebar");
  readonly btnMenu = el<HTMLButtonElement>("btn-menu");
  readonly btnPlugins = el<HTMLButtonElement>("btn-plugins");
  readonly btnSettings = el<HTMLButtonElement>("btn-settings");

  readonly exportDialog = el<HTMLElement>("export-dialog");
  readonly exportClose = el<HTMLButtonElement>("export-close");
  readonly templatesDialog = el<HTMLElement>("templates-dialog");
  readonly templatesClose = el<HTMLButtonElement>("templates-close");
  readonly templatesList = el<HTMLDivElement>("templates-list");
  readonly projectsDialog = el<HTMLElement>("projects-dialog");
  readonly projectsClose = el<HTMLButtonElement>("projects-close");
  readonly projectsList = el<HTMLDivElement>("projects-list");
  readonly projectsSearch = el<HTMLInputElement>("projects-search");
  readonly projectsSort = el<HTMLSelectElement>("projects-sort");
  readonly projectsFolder = el<HTMLSelectElement>("projects-folder");
  readonly projectsNewFolder = el<HTMLButtonElement>("projects-new-folder");
  readonly btnProjects = el<HTMLButtonElement>("btn-projects");
  readonly versionsDialog = el<HTMLElement>("versions-dialog");
  readonly versionsClose = el<HTMLButtonElement>("versions-close");
  readonly versionsCapture = el<HTMLButtonElement>("versions-capture");
  readonly versionsList = el<HTMLDivElement>("versions-list");
  readonly btnVersions = el<HTMLButtonElement>("btn-versions");

  private inspectorEl = el<HTMLElement>("inspector");
  private inspectorBody = el<HTMLDivElement>("inspector-body");
  private recentList = el<HTMLDivElement>("recent-list");
  private urlDialog = el<HTMLElement>("url-dialog");
  private urlInput = el<HTMLInputElement>("url-input");
  private urlConfirm = el<HTMLButtonElement>("url-confirm");
  private urlCancel = el<HTMLButtonElement>("url-cancel");
  private isolationBanner = el<HTMLElement>("isolation-banner");
  private isolationLabel = el<HTMLSpanElement>("isolation-label");
  private exitIsolationButton = el<HTMLButtonElement>("btn-exit-isolation");

  // Settings dialog.
  readonly settingsDialog = el<HTMLElement>("settings-dialog");
  readonly settingsClose = el<HTMLButtonElement>("settings-close");
  private settingsVersion = el<HTMLSpanElement>("settings-version");

  /** The inspector body element, so the app can delegate edit events. */
  readonly inspectorBodyEl = el<HTMLDivElement>("inspector-body");

  /** Fired when the user picks a recent project file to reopen. */
  onRecentPick: ((filePath: string) => void) | null = null;
  /** Fired when the user exits the current group/frame isolation scope. */
  onExitIsolation: (() => void) | null = null;

  private urlResolver: ((value: string | null) => void) | null = null;
  private urlTitle = el<HTMLDivElement>("url-title");
  private urlConfirmLabel = el<HTMLButtonElement>("url-confirm");

  constructor() {
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.exitIsolationButton.addEventListener("click", () => this.onExitIsolation?.());
    const initDialog = () => {
      this.urlConfirm.addEventListener("click", () => this.resolveUrl(this.urlInput.value));
      this.urlCancel.addEventListener("click", () => this.resolveUrl(null));
      this.urlInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.resolveUrl(this.urlInput.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          this.resolveUrl(null);
        }
      });
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initDialog);
    else initDialog();
  }

  /**
   * Prompt the user for a URL using the Spatia-styled dialog. Resolves with the
   * entered value on confirm, or null when cancelled / dismissed with Escape.
   */
  promptUrl(initial = ""): Promise<string | null> {
    return this.promptText("Add link", initial, "https://example.com", "Add link");
  }

  /**
   * Generic single-line text prompt (window.prompt is unavailable in Electron).
   * Resolves with the entered value, or null when cancelled.
   */
  promptText(title: string, initial = "", placeholder = "", confirmLabel = "OK"): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      this.urlResolver = resolve;
      this.urlTitle.textContent = title;
      this.urlConfirmLabel.textContent = confirmLabel;
      this.urlInput.placeholder = placeholder;
      this.urlInput.value = initial;
      this.urlDialog.classList.add("open");
      this.urlDialog.setAttribute("aria-hidden", "false");
      this.urlInput.focus();
      this.urlInput.select();
    });
  }

  private resolveUrl(value: string | null): void {
    this.urlDialog.classList.remove("open");
    this.urlDialog.setAttribute("aria-hidden", "true");
    const resolve = this.urlResolver;
    this.urlResolver = null;
    resolve?.(value);
  }

  openExportDialog(): void {
    this.exportDialog.classList.add("open");
    this.exportDialog.setAttribute("aria-hidden", "false");
  }

  closeExportDialog(): void {
    this.exportDialog.classList.remove("open");
    this.exportDialog.setAttribute("aria-hidden", "true");
  }

  openTemplatesDialog(): void {
    this.templatesDialog.classList.add("open");
    this.templatesDialog.setAttribute("aria-hidden", "false");
  }

  closeTemplatesDialog(): void {
    this.templatesDialog.classList.remove("open");
    this.templatesDialog.setAttribute("aria-hidden", "true");
  }

  openProjectsDialog(): void {
    this.projectsDialog.classList.add("open");
    this.projectsDialog.setAttribute("aria-hidden", "false");
    this.projectsSearch.focus();
  }

  closeProjectsDialog(): void {
    this.projectsDialog.classList.remove("open");
    this.projectsDialog.setAttribute("aria-hidden", "true");
  }

  openVersionsDialog(): void {
    this.versionsDialog.classList.add("open");
    this.versionsDialog.setAttribute("aria-hidden", "false");
  }

  closeVersionsDialog(): void {
    this.versionsDialog.classList.remove("open");
    this.versionsDialog.setAttribute("aria-hidden", "true");
  }

  /** Render the recent-projects list. */
  setRecent(projects: RecentProjectItem[]): void {
    this.recentList.textContent = "";
    if (projects.length === 0) {
      const empty = document.createElement("span");
      empty.className = "recent-empty";
      empty.textContent = "No recent projects";
      this.recentList.appendChild(empty);
      return;
    }
    for (const p of projects) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "recent-item";
      btn.title = p.filePath;
      btn.textContent = p.name || p.filePath;
      btn.addEventListener("click", () => this.onRecentPick?.(p.filePath));
      this.recentList.appendChild(btn);
    }
  }

  // -------- Settings dialog --------

  /** Mirror the current version into the settings dialog. */
  setVersion(version: string): void {
    this.settingsVersion.textContent = `v${version}`;
  }

  openSettingsDialog(): void {
    this.settingsDialog.classList.add("open");
    this.settingsDialog.setAttribute("aria-hidden", "false");
  }

  closeSettingsDialog(): void {
    this.settingsDialog.classList.remove("open");
    this.settingsDialog.setAttribute("aria-hidden", "true");
  }

  /** Render the object inspector body from a list of field descriptors. */
  setInspector(html: string): void {
    this.inspectorBody.innerHTML = html;
    initInspectorColorPickers(this.inspectorBody);
  }

  setInspectorOpen(open: boolean): void {
    this.inspectorEl.classList.toggle("open", open);
    this.inspectorEl.setAttribute("aria-hidden", String(!open));
  }

  setIsolation(type: "group" | "frame", name: string): void {
    this.isolationLabel.textContent = `Isolating ${type}: ${name}`;
    this.isolationBanner.hidden = false;
  }

  clearIsolation(): void {
    this.isolationBanner.hidden = true;
  }

  setProject(_meta: ProjectMeta): void {
    // The removed top bar showed the project name; nothing to render now.
  }

  setSaved(_dirty: boolean): void {
    // The removed top bar showed the saved state; nothing to render now.
  }

  setStatus(text: string): void {
    this.statusText.textContent = text;
  }

  private notifyTimer: number | null = null;

  /** Transient toast for plugin notifications and non-blocking feedback. */
  notify(text: string): void {
    let toast = document.getElementById("app-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "app-toast";
      toast.className = "app-toast";
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.classList.add("show");
    if (this.notifyTimer !== null) window.clearTimeout(this.notifyTimer);
    this.notifyTimer = window.setTimeout(() => toast.classList.remove("show"), 3200);
  }

  setZoom(zoom: number): void {
    this.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  }

  setUndoEnabled(enabled: boolean): void {
    this.btnUndo.disabled = !enabled;
  }

  setRedoEnabled(enabled: boolean): void {
    this.btnRedo.disabled = !enabled;
  }

  /** Reflect the active tool on the Pen / Select buttons (sidebar + HUD). */
  setTools(penActive: boolean): void {
    this.btnPen.classList.toggle("active", penActive);
    this.btnPenSidebar.classList.toggle("active", penActive);
    this.btnSelect.classList.toggle("active", !penActive);
  }

  isSidebarOpen(): boolean {
    return this.sidebar.classList.contains("open");
  }

  setSidebarOpen(open: boolean): void {
    this.sidebar.classList.toggle("open", open);
    this.sidebar.setAttribute("aria-hidden", String(!open));
  }

  toggleSidebar(): void {
    this.setSidebarOpen(!this.isSidebarOpen());
  }

  setCursorWorld(x: number, y: number): void {
    this.cursorLabel.textContent = `${formatCoord(x)}, ${formatCoord(y)}`;
  }

  private onPointerMove = (e: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    if (this.worldReader) {
      const p = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const world = this.worldReader(p);
      this.setCursorWorld(world.x, world.y);
    }
  };

  private _worldReader: ((screen: { x: number; y: number }) => { x: number; y: number }) | null = null;

  setWorldReader(reader: (screen: { x: number; y: number }) => { x: number; y: number }): void {
    this._worldReader = reader;
  }

  private get worldReader(): ((screen: { x: number; y: number }) => { x: number; y: number }) | null {
    return this._worldReader;
  }
}

function formatCoord(v: number): string {
  const rounded = Math.round(v * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export type { ViewportState };
