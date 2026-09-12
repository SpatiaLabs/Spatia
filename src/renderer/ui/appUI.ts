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

/** Compact relative/absolute timestamp for the recovery banner. */
function formatRecoveryTime(iso: string): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/**
 * Thin DOM layer for the Spatia shell. Holds no state of its own; the app
 * controller tells it what to render. Keeps DOM manipulation out of the canvas
 * engine and state stores.
 */
export class AppUI {
  private statusText = el<HTMLSpanElement>("status-text");
  private zoomLabel = el<HTMLDivElement>("zoom-label");

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
  readonly btnAddTable = el<HTMLButtonElement>("btn-add-table");
  readonly btnAddComparison = el<HTMLButtonElement>("btn-add-comparison");
  readonly btnAddChart = el<HTMLButtonElement>("btn-add-chart");
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
  private exportFormats = el<HTMLElement>("export-formats");
  private exportDetails = el<HTMLElement>("export-details");
  private exportScopeSelection = el<HTMLDivElement>("export-scope-selection");
  private exportScaleField = el<HTMLDivElement>("export-scale-field");
  private exportTitle = el<HTMLElement>("export-title");
  private exportSummary = el<HTMLParagraphElement>("export-summary");
  readonly exportBack = el<HTMLButtonElement>("export-back");
  readonly exportRun = el<HTMLButtonElement>("export-run");
  private docTitle = el<HTMLSpanElement>("doc-title");
  private savedState = el<HTMLSpanElement>("saved-state");
  private recoveryBanner = el<HTMLElement>("recovery-banner");
  private recoveryEntries = el<HTMLDivElement>("recovery-entries");
  readonly btnSidebarClose = el<HTMLButtonElement>("sidebar-close");
  readonly settingsEffects = el<HTMLInputElement>("settings-effects");
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
  /** Fired when the user changes export scope/resolution (live summary). */
  onExportConfigChange: (() => void) | null = null;
  /** Fired when the user recovers a crash draft by id. */
  onRecover: ((projectId: string) => void) | null = null;
  /** Fired when the user dismisses a crash draft by id. */
  onDiscardRecovery: ((projectId: string) => void) | null = null;

  private urlResolver: ((value: string | null) => void) | null = null;
  private urlTitle = el<HTMLDivElement>("url-title");
  private urlConfirmLabel = el<HTMLButtonElement>("url-confirm");
  /** Element to return keyboard focus to once any transient dialog closes. */
  private focusReturn: HTMLElement | null = null;

  /** Assign the element restored focus should return to after dialog close. */
  setFocusReturn(el: HTMLElement | null): void {
    this.focusReturn = el;
  }

  private restoreFocus(): void {
    this.focusReturn?.focus({ preventScroll: true });
  }

  constructor() {
    this.exitIsolationButton.addEventListener("click", () => this.onExitIsolation?.());
    const reportConfig = () => this.onExportConfigChange?.();
    this.exportScopeSelection.addEventListener("change", reportConfig);
    this.exportScaleField.addEventListener("change", reportConfig);
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
    this.restoreFocus();
    resolve?.(value);
  }

  openExportDialog(): void {
    this.exportDialog.classList.add("open");
    this.exportDialog.setAttribute("aria-hidden", "false");
  }

  closeExportDialog(): void {
    this.exportDialog.classList.remove("open");
    this.exportDialog.setAttribute("aria-hidden", "true");
    this.restoreFocus();
  }

  /**
   * Show the export details step (scope + resolution + summary) for a chosen
   * format. Scope radios are derived per format: selection is meaningless for
   * PDF, and the resolution field only applies to raster formats.
   */
  showExportDetails(opts: { title: string; scopes: readonly string[]; showScale: boolean }): void {
    this.exportTitle.textContent = opts.title;
    for (const radio of this.exportScopeSelection.querySelectorAll<HTMLInputElement>("input[name='export-scope']")) {
      const wrapper = radio.closest("label");
      if (wrapper) wrapper.hidden = !opts.scopes.includes(radio.value);
    }
    this.exportScopeSelection.hidden = opts.scopes.length === 0;
    this.exportScaleField.hidden = !opts.showScale;
    this.ensureScopeSelected(opts.scopes);
    this.exportFormats.hidden = true;
    this.exportDetails.hidden = false;
    this.exportRun.textContent = "Export";
    this.exportRun.disabled = opts.scopes.length === 0;
    if (opts.scopes.length === 0) this.exportSummary.textContent = "";
    else this.onExportConfigChange?.();
  }

  showExportFormats(): void {
    this.exportTitle.textContent = "Export";
    this.exportDetails.hidden = true;
    this.exportFormats.hidden = false;
  }

  private ensureScopeSelected(scopes: readonly string[]): void {
    if (scopes.length === 0) return;
    const selected = this.exportScopeSelection.querySelector<HTMLInputElement>(
      "input[name='export-scope']:checked"
    );
    if (selected && scopes.includes(selected.value)) return;
    const first = this.exportScopeSelection.querySelector<HTMLInputElement>(`input[name='export-scope'][value='${scopes[0]}']`);
    if (first) first.checked = true;
  }

  /** Currently selected export scope ("" when none available). */
  getExportScope(): string {
    const checked = this.exportScopeSelection.querySelector<HTMLInputElement>("input[name='export-scope']:checked");
    return checked?.value ?? "";
  }

  /** Currently selected export resolution multiplier. */
  getExportScale(): number {
    const checked = this.exportScaleField.querySelector<HTMLInputElement>("input[name='export-scale']:checked");
    return checked ? Number(checked.value) || 2 : 2;
  }

  setExportSummary(text: string): void {
    this.exportSummary.textContent = text;
  }

  setProject(meta: ProjectMeta): void {
    this.docTitle.textContent = meta.name || "Untitled";
    this.docTitle.title = meta.name || "Untitled";
  }

  setSaved(dirty: boolean): void {
    this.savedState.textContent = dirty ? "Unsaved" : "Saved";
    this.savedState.classList.toggle("dirty", dirty);
    this.savedState.title = dirty ? "Not saved yet" : "All changes saved";
  }

  /** Render the recovery banner. Empty input hides it. */
  setRecovery(entries: { projectId: string; name: string; updatedAt: string }[]): void {
    this.recoveryEntries.textContent = "";
    this.recoveryBanner.hidden = entries.length === 0;
    for (const e of entries) {
      const row = document.createElement("div");
      row.className = "recovery-entry";
      const name = document.createElement("span");
      name.className = "recovery-entry-name";
      name.textContent = e.name;
      name.title = e.updatedAt;
      const time = document.createElement("span");
      time.className = "recovery-entry-time";
      time.textContent = formatRecoveryTime(e.updatedAt);
      const recover = document.createElement("button");
      recover.type = "button";
      recover.className = "btn inspector-btn";
      recover.textContent = "Recover";
      recover.addEventListener("click", () => this.onRecover?.(e.projectId));
      const discard = document.createElement("button");
      discard.type = "button";
      discard.className = "btn inspector-btn";
      discard.textContent = "Discard";
      discard.addEventListener("click", () => this.onDiscardRecovery?.(e.projectId));
      row.append(name, time, recover, discard);
      this.recoveryEntries.appendChild(row);
    }
  }

  openTemplatesDialog(): void {
    this.templatesDialog.classList.add("open");
    this.templatesDialog.setAttribute("aria-hidden", "false");
  }

  closeTemplatesDialog(): void {
    this.templatesDialog.classList.remove("open");
    this.templatesDialog.setAttribute("aria-hidden", "true");
    this.restoreFocus();
  }

  openProjectsDialog(): void {
    this.projectsDialog.classList.add("open");
    this.projectsDialog.setAttribute("aria-hidden", "false");
    this.projectsSearch.focus();
  }

  closeProjectsDialog(): void {
    this.projectsDialog.classList.remove("open");
    this.projectsDialog.setAttribute("aria-hidden", "true");
    this.restoreFocus();
  }

  openVersionsDialog(): void {
    this.versionsDialog.classList.add("open");
    this.versionsDialog.setAttribute("aria-hidden", "false");
  }

  closeVersionsDialog(): void {
    this.versionsDialog.classList.remove("open");
    this.versionsDialog.setAttribute("aria-hidden", "true");
    this.restoreFocus();
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
    this.restoreFocus();
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
}

export type { ViewportState };
