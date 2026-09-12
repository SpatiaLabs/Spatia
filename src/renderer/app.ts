import { createNewDocument, ProjectStore, serialize } from "./project/projectStore.js";
import type { ProjectDocument } from "../shared/types/project.js";
import type { CanvasObject, ObjectKind, AssetMeta, ShapeKind, FrameShape, ChartKind } from "../shared/types/object.js";
import type { TableData } from "../shared/data/table.js";
import { objectTags, sameTags } from "../shared/types/object.js";
import type { LibraryData } from "../shared/library/library.js";
import { filterProjects, sortProjects } from "../shared/library/library.js";
import type { VersionSnapshotMeta, RecoveryEntry } from "./types/bridge.js";
import type { SearchableItem, RankedHit } from "../shared/search/search.js";
import { SearchStore } from "./state/searchStore.js";
import { SearchUI } from "./ui/searchUI.js";
import { deserialize, ProjectFormatError } from "../shared/project/serialize.js";
import { ViewportStore } from "./state/viewportStore.js";
import { SelectionStore } from "./state/selectionStore.js";
import { CommandManager } from "./command/commandManager.js";
import { CanvasEngine } from "./canvas/engine.js";
import { estimateTextHeight } from "./canvas/objects.js";
import { BrowserFrameOverlay } from "./canvas/browserOverlay.js";
import { browserUrlOf, normalizeBrowserUrl } from "../shared/plugins/browserFrame.js";
import { AppUI } from "./ui/appUI.js";
import { AssetStore } from "./assets/assetStore.js";
import { showContextMenu, hideContextMenu, type ContextMenuItem } from "./ui/contextMenu.js";
import { openTextEditor, closeTextEditor, isEditingText } from "./ui/textEditor.js";
import { openDataEditor, closeDataEditor, isEditingData } from "./ui/dataEditor.js";
import { openTableCellEditor, closeTableCellEditor, isEditingTableCell } from "./ui/tableCellEditor.js";
import { isEditableEventTarget } from "./ui/editTarget.js";
import { CommandPalette, type PaletteRow } from "./ui/commandPalette.js";
import { fuzzyFilter } from "../shared/search/fuzzy.js";
import { tableLayout, tableCellAt, tableCellRect } from "../shared/geometry/tableLayout.js";
import { selectionBounds } from "../shared/geometry/selection.js";
import { setCell, renameColumn } from "../shared/data/table.js";
import { Minimap } from "./ui/minimap.js";
import type { Point } from "../shared/geometry/viewport.js";
import { screenToWorld, worldToScreen, viewportForRect, type Rect } from "../shared/geometry/viewport.js";
import { addObjectCommand, resizeObjectsCommand, setPropsCommand, type PropChange } from "./command/commands.js";
import { deleteObjectsCommand } from "./command/commands.js";
import { PluginManager, type PluginApiGateway, type PluginObjectView } from "./plugins/pluginManager.js";
import { PluginsUI } from "./plugins/pluginsUI.js";
import { SHAPE_KINDS, shapeLabel } from "../shared/geometry/shapes.js";
import { exportBounds } from "../shared/export/bounds.js";
import { buildMarkdown } from "../shared/export/markdown.js";
import { buildPdfFromJpegs, type PdfPage } from "../shared/export/pdf.js";
import { bytesToBase64 } from "../shared/export/base64.js";
import { TEMPLATES, templateById } from "../shared/templates/templates.js";
import { CollaborationStore } from "./state/collaborationStore.js";
import { CollabUI, type CollabShareView } from "./ui/collabUI.js";
import { loadCollabIdentity } from "./state/collabIdentity.js";
import { sanitizeRoomId, DEFAULT_COLLAB_URL, type CollabUser } from "../shared/collab/protocol.js";
import { createId } from "../shared/core/id.js";
import { AssetsUI } from "./ui/assetsUI.js";
import { APP_VERSION } from "../shared/core/version.js";

const EFFECTS_KEY = "spatia:reduced-effects";

/** Font families offered in the text-object inspector (CSS-safe names). */
const FONT_CHOICES = ["Arial", "Calibri", "Courier New", "Georgia", "Segoe UI", "Times New Roman", "Trebuchet MS", "Verdana"];

/** One entry in the Command Palette registry (Ctrl+K). */
interface PaletteCommand {
  id: string;
  category: string;
  label: string;
  keywords: string;
  shortcut?: string;
  enabled: () => boolean;
  run: () => void;
}

/**
 * Top-level controller composing state stores, the canvas engine, the command
 * (undo/redo) stack, the asset store, persistence (via the preload bridge) and
 * the UI shell. Document state only ever changes through undoable commands.
 */
export class App {
  private viewport = new ViewportStore();
  private selection = new SelectionStore();
  private commands = new CommandManager();
  private project = new ProjectStore();
  private engine: CanvasEngine;
  private browserOverlay: BrowserFrameOverlay;
  private assets = new AssetStore();
  private ui = new AppUI();
  private minimap: Minimap;
  private palette = new CommandPalette();
  private paletteCommands: PaletteCommand[] = [];
  private paletteRows: PaletteCommand[] = [];
  private paletteActive = 0;
  private recentPaletteIds: string[] = [];
  private recentRows = 0;

  private clipboard: CanvasObject[] = [];
  private isolation: { containerId: string; visibleIds: string[] } | null = null;
  private pluginsManager: PluginManager;
  private pluginsUi: PluginsUI;
  private search = new SearchStore();
  private searchUi = new SearchUI();

  private collab = new CollaborationStore();
  private collabUi = new CollabUI();
  private assetsUi = new AssetsUI();
  private collabIdentity: CollabUser | null = null;
  private collabSnapshotTimer: number | null = null;
  private overlayTimer: number | null = null;
  private applyingRemote = false;
  private pendingJoinRoom = "";
  private inspectorMinimized = false;

  /** File path of the current project once a save location exists. */
  private activeFilePath: string | null = null;
  /** The format the export details panel is currently configured for. */
  private pendingExportFormat: AppExportFormat | null = null;
  private autoSaveTimer: number | null = null;
  private autoSaveInFlight = false;
  private recoveryTimer: number | null = null;
  private recoveryBound = false;

  /** Public plugin manager — used by the UI, the mobile shell and tests. */
  get plugins(): PluginManager {
    return this.pluginsManager;
  }

  constructor(canvas: HTMLCanvasElement) {
    this.project.replace(createNewDocument());
    this.engine = new CanvasEngine(canvas, this.viewport, this.project, this.selection);
    this.ui.setFocusReturn(this.engine.canvas());
    this.browserOverlay = new BrowserFrameOverlay(this.engine, this.project, this.selection);
    const minimapEl = document.getElementById("minimap");
    if (minimapEl instanceof HTMLCanvasElement) {
      this.minimap = new Minimap(
        minimapEl,
        () => this.project.getObjects(),
        () => this.viewport.get(),
        (world) => this.navigateTo(world)
      );
    } else {
      this.minimap = undefined as unknown as Minimap;
    }

    this.engine.setHistory((cmd) => this.commands.execute(cmd));
    this.engine.emitContextMenu = (screen, world) => this.showContextMenu(screen, world);

    this.bindUI();
    this.bindEvents();
    this.bindDragDrop(canvas);
    this.refreshProjectRefs();
    this.ui.setTools(false);
    this.ui.setVersion(APP_VERSION);
    this.ui.onRecentPick = (filePath) => void this.openProjectPath(filePath);
    this.ui.onExitIsolation = () => this.exitIsolation();
    this.bindSearch();
    this.bindCollab();
    this.bindAssets();
    this.bindPalette();
    void this.refreshRecent();

    this.pluginsUi = new PluginsUI();
    this.pluginsManager = new PluginManager(this.pluginGateway());
    this.bindPlugins();
    void this.pluginsManager.reload();
  }

  private navigateTo(world: Point): void {
    const f = this.engine.getFrame();
    const zoom = this.viewport.get().zoom;
    this.viewport.set({
      x: world.x - f.originWidth / 2 / zoom,
      y: world.y - f.originHeight / 2 / zoom,
      zoom,
    });
    this.setStatus(`Navigated to ${Math.round(world.x)}, ${Math.round(world.y)}.`);
  }

  /** Return keyboard focus to the canvas so global shortcuts keep working. */
  private focusCanvas(): void {
    this.engine.canvas().focus({ preventScroll: true });
  }

  // -------- Command Palette (Ctrl+K) --------

  private bindPalette(): void {
    this.paletteCommands = this.buildPaletteCommands();
    this.palette.onQuery = () => this.refreshPalette();
    this.palette.onDismiss = () => this.closeCommandPalette();
    this.palette.onPick = (delta) => this.paletteMove(delta);
  }

  openCommandPalette(): void {
    if (this.palette.isOpen()) return;
    this.palette.open();
    this.refreshPalette();
    this.setStatus("Type to filter commands — Enter to run, Esc to close.");
  }

  closeCommandPalette(): void {
    this.palette.close();
    this.focusCanvas();
  }

  toggleCommandPalette(): void {
    if (this.palette.isOpen()) {
      this.closeCommandPalette();
      return;
    }
    this.openCommandPalette();
  }

  /** Toggle the pen tool (HUD button, sidebar button and command palette). */
  private togglePenTool(): void {
    const on = !this.engine.isPenTool();
    this.engine.setPenTool(on);
    this.ui.setTools(on);
    if (on) this.selection.setIds([]);
    this.refreshUI();
  }

  /** Recomputed on every query change so enabled state is always current. */
  private refreshPalette(): void {
    const query = this.palette.query();
    const activeQuery = query.trim().length > 0;
    const matched = fuzzyFilter(query, this.paletteCommands, (c) => `${c.label} ${c.keywords}`);
    let rows = matched.map((m) => m.item).filter((c) => c.enabled());
    this.recentRows = 0;
    // With a blank query, surface recently used commands first under "Recent".
    if (!activeQuery && this.recentPaletteIds.length > 0) {
      const recent = this.recentPaletteIds
        .map((id) => this.paletteCommands.find((c) => c.id === id))
        .filter((c): c is PaletteCommand => !!c && c.enabled());
      if (recent.length > 0) {
        rows = [...recent, ...rows.filter((c) => !this.recentPaletteIds.includes(c.id))];
        this.recentRows = recent.length;
      }
    }
    this.paletteRows = rows;
    this.paletteActive = 0;
    this.renderPaletteRows();
  }

  private renderPaletteRows(): void {
    const recentCount = this.recentRows;
    const rows: PaletteRow[] = this.paletteRows.map((c, i) => ({
      index: i,
      category: i < recentCount ? "Recent" : c.category,
      label: c.label,
      shortcut: c.shortcut,
      active: i === this.paletteActive,
    }));
    this.palette.render(rows, this.palette.query());
  }

  private paletteMove(delta: number): void {
    const n = this.paletteRows.length;
    if (n === 0) return;
    if (delta === 0) {
      const command = this.paletteRows[this.paletteActive % n];
      this.closeCommandPalette();
      this.markPaletteRecent(command.id);
      command.run();
      return;
    }
    this.paletteActive = (this.paletteActive + delta + n) % n;
    this.renderPaletteRows();
  }

  /** Lightweight, session-only history of recently run commands. */
  private markPaletteRecent(id: string): void {
    this.recentPaletteIds = [id, ...this.recentPaletteIds.filter((x) => x !== id)].slice(0, 5);
  }

  private buildPaletteCommands(): PaletteCommand[] {
    const addAt = (kind: ObjectKind): void => {
      this.addObjectAt(kind, this.centerWorld());
    };
    const addShape = (kind: ShapeKind): void => {
      this.addShapeAt(kind, this.centerWorld());
    };
    const canUndo = () => this.commands.canUndo;
    const canRedo = () => this.commands.canRedo;
    const hasSel = () => this.selection.size > 0;
    const selAtLeast = (n: number) => () => this.selection.size >= n;
    const notPen = () => !this.engine.isPenTool();
    return [
      // -------- Canvas --------
      { id: "zoom-in", category: "Canvas", label: "Zoom In", keywords: "magnify closer", shortcut: "Ctrl+=", enabled: () => true, run: () => this.zoomIn() },
      { id: "zoom-out", category: "Canvas", label: "Zoom Out", keywords: "shrink farther", shortcut: "Ctrl+-", enabled: () => true, run: () => this.zoomOut() },
      { id: "zoom-reset", category: "Canvas", label: "Reset Zoom", keywords: "fit view 100 percent", enabled: () => true, run: () => this.resetView() },
      { id: "focus-selection", category: "Canvas", label: "Focus Selection", keywords: "center on selected", shortcut: "F", enabled: hasSel, run: () => this.focusSelection() },
      // -------- Objects --------
      { id: "add-text", category: "Objects", label: "Add Text", keywords: "text label type", enabled: () => true, run: () => addAt("text") },
      { id: "add-note", category: "Objects", label: "Add Note", keywords: "sticky note annotation", enabled: () => true, run: () => addAt("note") },
      { id: "add-image", category: "Objects", label: "Add Image…", keywords: "picture photo file", enabled: () => true, run: () => addAt("image") },
      { id: "add-file", category: "Objects", label: "Add File…", keywords: "attachment pdf doc", enabled: () => true, run: () => addAt("file") },
      { id: "add-url", category: "Objects", label: "Add URL / Link…", keywords: "link website web", enabled: () => true, run: () => addAt("url") },
      { id: "add-frame", category: "Objects", label: "Add Frame", keywords: "container board", enabled: () => true, run: () => this.addFrameAt(this.centerWorld()) },
      { id: "add-table", category: "Objects", label: "Add Table", keywords: "rows columns grid", enabled: () => true, run: () => this.addTableAt(this.centerWorld()) },
      { id: "add-comparison-table", category: "Objects", label: "Add Comparison Table", keywords: "compare matrix pros cons", enabled: () => true, run: () => this.addTableAt(this.centerWorld(), true) },
      { id: "add-chart", category: "Objects", label: "Add Chart", keywords: "graph data", enabled: () => true, run: () => this.addChartAt("bar", this.centerWorld()) },
      { id: "add-connection", category: "Objects", label: "Connect Selection", keywords: "link arrow between two", shortcut: "Ctrl+Shift+C", enabled: () => this.selection.size === 2, run: () => this.connectSelection() },
      { id: "add-pen", category: "Objects", label: "Add Pen", keywords: "freehand sketch draw", enabled: notPen, run: () => this.togglePenTool() },
      { id: "add-group", category: "Objects", label: "Add Group", keywords: "combine group selection", enabled: selAtLeast(2), run: () => this.groupSelection() },
      // -------- Shapes --------
      { id: "shape-rectangle", category: "Shapes", label: "Add Rectangle", keywords: "shape box square", enabled: () => true, run: () => addShape("rectangle") },
      { id: "shape-rounded", category: "Shapes", label: "Add Rounded Rectangle", keywords: "shape round corners box", enabled: () => true, run: () => addShape("rounded-rectangle") },
      { id: "shape-ellipse", category: "Shapes", label: "Add Ellipse", keywords: "shape circle oval", enabled: () => true, run: () => addShape("ellipse") },
      { id: "shape-diamond", category: "Shapes", label: "Add Diamond", keywords: "shape rhombus", enabled: () => true, run: () => addShape("diamond") },
      { id: "shape-triangle", category: "Shapes", label: "Add Triangle", keywords: "shape polygon", enabled: () => true, run: () => addShape("triangle") },
      { id: "shape-line", category: "Shapes", label: "Add Line", keywords: "shape straight segment", enabled: () => true, run: () => addShape("line") },
      { id: "shape-arrow", category: "Shapes", label: "Add Arrow", keywords: "shape direction pointer", enabled: () => true, run: () => addShape("arrow") },
      // -------- Charts --------
      { id: "chart-bar", category: "Charts", label: "Add Bar Chart", keywords: "chart bar columns data", enabled: () => true, run: () => this.addChartAt("bar", this.centerWorld()) },
      { id: "chart-line", category: "Charts", label: "Add Line Chart", keywords: "chart line trend data", enabled: () => true, run: () => this.addChartAt("line", this.centerWorld()) },
      { id: "chart-pie", category: "Charts", label: "Add Pie Chart", keywords: "chart pie donut data", enabled: () => true, run: () => this.addChartAt("pie", this.centerWorld()) },
      // -------- Editing -------
      { id: "undo", category: "Editing", label: "Undo", keywords: "revert back", shortcut: "Ctrl+Z", enabled: canUndo, run: () => this.undo() },
      { id: "redo", category: "Editing", label: "Redo", keywords: "reapply forward", shortcut: "Ctrl+Shift+Z", enabled: canRedo, run: () => this.redo() },
      { id: "copy", category: "Editing", label: "Copy", keywords: "duplicate clone", shortcut: "Ctrl+C", enabled: hasSel, run: () => this.copySelection() },
      { id: "paste", category: "Editing", label: "Paste", keywords: "clipboard insert", shortcut: "Ctrl+V", enabled: () => true, run: () => this.pasteClipboard() },
      { id: "duplicate", category: "Editing", label: "Duplicate", keywords: "clone copy", shortcut: "Ctrl+D", enabled: hasSel, run: () => this.duplicateSelection() },
      { id: "delete", category: "Editing", label: "Delete", keywords: "remove clear erase", shortcut: "Del", enabled: hasSel, run: () => this.deleteSelection() },
      { id: "select-all", category: "Editing", label: "Select All", keywords: "all objects", shortcut: "Ctrl+A", enabled: () => true, run: () => this.engine.selectAll() },
      // -------- Transform --------
      { id: "rotate-cw", category: "Transform", label: "Rotate Clockwise", keywords: "rotate right turn", shortcut: "R", enabled: hasSel, run: () => this.rotateSelection(15) },
      { id: "rotate-ccw", category: "Transform", label: "Rotate Counterclockwise", keywords: "rotate left turn", shortcut: "Shift+R", enabled: hasSel, run: () => this.rotateSelection(-15) },
      { id: "group", category: "Transform", label: "Group", keywords: "combine group", shortcut: "Ctrl+G", enabled: selAtLeast(2), run: () => this.groupSelection() },
      { id: "ungroup", category: "Transform", label: "Ungroup", keywords: "split group", shortcut: "Ctrl+Shift+G", enabled: hasSel, run: () => this.ungroupSelection() },
      // -------- Projects --------
      { id: "save", category: "Projects", label: "Save", keywords: "store persist", shortcut: "Ctrl+S", enabled: () => true, run: () => void this.saveProject() },
      { id: "save-as", category: "Projects", label: "Save As…", keywords: "store persist copy", enabled: () => true, run: () => void this.saveAsProject() },
      { id: "open-projects", category: "Projects", label: "Open Projects…", keywords: "library recent list", enabled: () => true, run: () => void this.openProjectsDialog() },
      { id: "version-history", category: "Projects", label: "Version History", keywords: "undo history snapshots", enabled: () => true, run: () => void this.openVersionsDialog() },
      { id: "recover", category: "Projects", label: "Recover Project…", keywords: "unsaved crash backup recovery", enabled: () => true, run: () => void this.refreshRecoveryBanner() },
      // -------- Export --------
      { id: "export-png", category: "Export", label: "Export PNG…", keywords: "image raster", enabled: () => true, run: () => this.exportFormat("png") },
      { id: "export-jpeg", category: "Export", label: "Export JPEG…", keywords: "image raster jpg", enabled: () => true, run: () => this.exportFormat("jpeg") },
      { id: "export-pdf", category: "Export", label: "Export PDF…", keywords: "document print", enabled: () => true, run: () => this.exportFormat("pdf") },
      { id: "export-markdown", category: "Export", label: "Export Markdown…", keywords: "md text", enabled: () => true, run: () => this.exportFormat("md") },
      { id: "export-spatia", category: "Export", label: "Export Spatia…", keywords: "spatia folder project file", enabled: () => true, run: () => this.exportFormat("spatia-folder") },
      // -------- Application --------
      { id: "plugins", category: "Application", label: "Plugins", keywords: "extensions addons", enabled: () => true, run: () => this.openPluginsDialog() },
      { id: "settings", category: "Application", label: "Settings", keywords: "preferences options", enabled: () => true, run: () => this.openSettingsDialog() },
      { id: "templates", category: "Application", label: "Templates…", keywords: "start new blank", enabled: () => true, run: () => this.openTemplatesDialog() },
      { id: "search-canvas", category: "Application", label: "Search Canvas", keywords: "find objects", shortcut: "Ctrl+F", enabled: () => true, run: () => this.openSearch() },
    ];
  }

  // -------- Search (Find modal) --------

  private bindSearch(): void {
    this.searchUi.onQuery = (q) => this.search.setQuery(q);
    this.searchUi.onPick = (id) => this.pickSearchHit(id);
    this.searchUi.onNext = () => this.search.selectNext();
    this.searchUi.onPrev = () => this.search.selectPrev();
    this.searchUi.onDismiss = () => this.closeSearch();
    this.search.onChange(() => {
      this.searchUi.setQuery(this.search.query);
      this.searchUi.render(this.search.resultList, this.search.activeId);
      this.searchUi.scrollActiveIntoView();
    });
  }

  /** Open the Find modal (Ctrl+F or "/"). */
  openSearch(): void {
    this.search.open(this.buildSearchCorpus());
    this.searchUi.open();
    this.setStatus("Search the canvas — Enter to jump to the first match.");
  }

  closeSearch(): void {
    this.search.close();
    this.searchUi.close();
    this.focusCanvas();
  }

  private buildSearchCorpus(): SearchableItem[] {
    const items: SearchableItem[] = [];
    const assets = this.project.getAssets();
    const assetName = new Map(assets.map((a) => [a.id, a.name]));
    for (const obj of this.project.getObjects()) {
      items.push(objectToSearchItem(obj, assetName));
    }
    items.push({
      id: "__project__",
      kind: "project",
      label: this.project.getMeta().name || "Project",
      text: this.project.getMeta().name ?? "",
      tags: this.project.getMeta().tags ?? [],
      typeLabel: "project",
    });
    return items;
  }

  private pickSearchHit(id: string): void {
    const hit = id ? this.search.resultList.find((r) => r.id === id) : this.search.activeHit();
    if (!hit) return;
    this.closeSearch();
    this.focusSearchHit(hit);
  }

  private focusSearchHit(hit: RankedHit): void {
    this.exitIsolation();
    const obj = this.project.getObject(hit.id);
    if (obj) {
      this.selection.setIds([hit.id]);
      this.navigateTo({ x: obj.x + obj.width / 2, y: obj.y + obj.height / 2 });
      this.setStatus(`Found ${outlineFor(hit.typeLabel)} "${hit.label}".`);
      return;
    }
    // Project hit — the current document already matches.
    if (hit.kind === "project") {
      this.setStatus(`You're in project "${hit.label}".`);
    }
  }

  // -------- Collaboration (share, presence) --------

  private bindCollab(): void {
    this.collabUi.btnShare.addEventListener("click", () => void this.openShareDialog());
    this.collabUi.onConnect = (url) => this.connectCollab(url);
    this.collabUi.onDisconnect = () => this.collab.disconnect();
    this.collabUi.onJoinRoom = (roomId) => void this.joinRoom(roomId);
    this.collabUi.onLeaveRoom = () => this.leaveRoom();
    this.collabUi.onCreateRoom = () => void this.createSharedRoom();
    this.collabUi.onCopyLink = () => void this.copyInviteLink();
    this.collabUi.onPermSet = (userId, role) => this.collab.sendPermSet(userId, role);

    this.collab.onRemoteFile = (file) => this.applyRemoteFile(file);
    this.collab.changed.subscribe(() => {
      this.refreshCollabUi();
      this.refreshAssetsUi();
    });

    // Desktop deep link (spatia://join?room=…) and web join URL (?room=…).
    window.spatia?.onJoinRequest?.((room) => void this.joinRoom(room));
    const urlRoom = new URLSearchParams(location.search).get("room");
    if (urlRoom) this.pendingJoinRoom = urlRoom;

    // Note: the main window is created later in lifecycle, so the join invite
    // that arrives AFTER the window exists is handled by onJoinRequest above.
    void this.bootstrapCollab();
  }

  private async ensureCollabIdentity(): Promise<CollabUser> {
    if (this.collabIdentity) return this.collabIdentity;
    const identity = await loadCollabIdentity();
    this.collabIdentity = identity;
    this.collab.user = identity;
    this.collabUi.selfId = identity.id;
    return identity;
  }

  /** Wait for any server identity then honor a boot-time join invite. */
  private async bootstrapCollab(): Promise<void> {
    await this.ensureCollabIdentity();
    if (this.pendingJoinRoom) {
      const room = sanitizeRoomId(this.pendingJoinRoom);
      this.pendingJoinRoom = "";
      if (room) await this.joinRoom(room);
    }
  }

  private connectCollab(url: string): void {
    this.collab.connect(url || DEFAULT_COLLAB_URL);
    this.setStatus(`Connecting to collaboration server…`);
  }

  private async openShareDialog(): Promise<void> {
    await this.ensureCollabIdentity();
    this.refreshCollabUi();
    this.collabUi.openShare();
  }

  /** Used by the mobile menu sheet. */
  private bindAssets(): void {
    this.assetsUi.btnAssets.addEventListener("click", () => this.assetsUi.toggle());
    this.assetsUi.onOpen = (id) => void this.openAsset(id);
    this.assetsUi.onRelink = (id) => void this.relinkAsset(id);
    this.assetsUi.onRemove = (id) => void this.removeAsset(id);
    this.assetsUi.onSelect = (id) => void this.findAssetOnCanvas(id);
    this.assetsUi.onPanelToggle = () => this.refreshAssetsUi();
    this.project.changed.subscribe(() => this.refreshAssetsUi());
    this.refreshAssetsUi();
  }

  /** Used by the mobile menu sheet. */
  toggleAssetsPanel(): void {
    this.assetsUi.toggle();
  }

  private assetsUsedBy(): Map<string, number> {
    const used = new Map<string, number>();
    for (const o of this.project.getObjects()) {
      if (o.type === "image" || o.type === "file") {
        used.set(o.assetId, (used.get(o.assetId) ?? 0) + 1);
      }
    }
    return used;
  }

  private refreshAssetsUi(): void {
    this.assetsUi.render({
      assets: this.project.getAssets(),
      usedBy: this.assetsUsedBy(),
      canEdit: this.canEditAssets(),
    });
  }

  /** Asset edits are allowed when we hold write permission (or are offline). */
  private canEditAssets(): boolean {
    if (!this.collab.isJoined) return true;
    return this.collab.role === "owner" || this.collab.role === "editor";
  }

  private async openAsset(assetId: string): Promise<void> {
    const ok = await window.spatia.openAsset(this.project.getMeta().id, assetId);
    this.setStatus(ok ? "Opened in your default app." : "Asset file is missing.");
  }

  private async relinkAsset(assetId: string): Promise<void> {
    if (!this.canEditAssets()) {
      this.setStatus("You are a viewer — you cannot change assets.");
      return;
    }
    const result = await window.spatia.relinkAsset(this.project.getMeta().id, assetId);
    if (!result.canceled && result.asset) {
      this.project.replaceAsset(result.asset);
      this.engine.invalidateImage(assetId);
      this.setStatus(`Relinked asset "${result.asset.name}".`);
    } else {
      this.setStatus("Could not relink asset.");
    }
    this.refreshAssetsUi();
  }

  private async removeAsset(assetId: string): Promise<void> {
    if (!this.canEditAssets()) {
      this.setStatus("You are a viewer — you cannot change assets.");
      return;
    }
    const meta = this.project.getAsset(assetId);
    if (!meta) return;
    const count = this.assetsUsedBy().get(assetId) ?? 0;
    const ok = window.confirm(
      count > 0
        ? `Delete "${meta.name}" and the file behind it? ${count} object${count > 1 ? "s are" : " is"} still using it and will show a missing-file notice.`
        : `Delete "${meta.name}" and the file behind it?`
    );
    if (!ok) return;
    await window.spatia.deleteAsset(this.project.getMeta().id, assetId);
    this.engine.invalidateImage(assetId);
    this.project.removeAsset(assetId);
    this.setStatus(`Removed asset "${meta.name}".`);
    this.refreshAssetsUi();
  }

  /** Center the viewport on the first object that uses the given asset. */
  private async findAssetOnCanvas(assetId: string): Promise<void> {
    const obj = this.project
      .getObjects()
      .find((o) => (o.type === "image" || o.type === "file") && o.assetId === assetId);
    if (!obj) {
      this.setStatus(
        this.project.getAssets().length > 0 ? "This asset is not used on the canvas." : "No assets yet."
      );
      return;
    }
    this.selection.setIds([obj.id]);
    const frame = this.engine.getFrame();
    const cx = obj.x + obj.width / 2;
    const cy = obj.y + obj.height / 2;
    const zoom = Math.max(frame.zoom, 1);
    this.viewport.set({
      x: cx - frame.originWidth / 2 / zoom,
      y: cy - frame.originHeight / 2 / zoom,
      zoom,
    });
    this.setStatus(`Found at ${Math.round(cx)}, ${Math.round(cy)}.`);
  }

  async joinRoom(roomId: string): Promise<void> {
    const room = sanitizeRoomId(roomId);
    if (!room) {
      this.setStatus("That room id is not valid (use 4+ letters, digits, - or _).");
      return;
    }
    const user = await this.ensureCollabIdentity();
    this.collab.join(room, user);
    this.collabUi.openShare();
    this.setStatus(`Joining room ${room}…`);
  }

  leaveRoom(): void {
    const room = this.collab.roomId;
    this.collab.disconnect();
    if (room) this.setStatus(`Left room ${room}.`);
  }

  async createSharedRoom(): Promise<void> {
    const user = await this.ensureCollabIdentity();
    const room = this.collab.roomId || createId("room");
    const url = this.collab.serverUrl || DEFAULT_COLLAB_URL;
    if (!this.collab.isJoined) {
      this.collab.connect(url);
      if (this.collab.status === "connecting") {
        // Wait for open before joining (store joins on open via pendingJoin).
        this.collab.join(room, user);
      } else {
        this.collab.join(room, user);
      }
    }
    this.collabUi.openShare();
    this.refreshCollabUi();
  }

  private async copyInviteLink(): Promise<void> {
    const room = this.collab.roomId;
    if (!room) return;
    const link = this.inviteLink(room);
    try {
      await navigator.clipboard.writeText(link);
      this.setStatus("Invite link copied.");
    } catch {
      this.setStatus(`Invite link: ${link}`);
    }
  }

  /** A real URL the owner can send; same server, room in the query string. */
  private inviteLink(room: string): string {
    const here = `${location.origin}${location.pathname}`;
    return `${here}?room=${encodeURIComponent(room)}`;
  }

  private refreshCollabUi(): void {
    this.collabUi.renderShare(this.shareView());
    this.scheduleOverlayUpdate();

    // Reflect room/role changes in the status bar (once per transition).
    const label = this.collab.isJoined ? `Room ${this.collab.roomId} (${this.collab.role})` : "";
    if (label !== this.lastCollabStatusText) {
      this.lastCollabStatusText = label;
      if (label) this.setStatus(`In room ${this.collab.roomId} as ${this.collab.role}. Server-enforced.`);
    }
    // Persist share metadata on the document so the room is recoverable.
    if (this.collab.isJoined && this.project.getShared()?.roomId !== this.collab.roomId) {
      this.project.setShared({
        roomId: this.collab.roomId,
        serverUrl: this.collab.serverUrl,
        role: this.collab.role,
        lastSyncedAt: new Date().toISOString(),
      });
    }
    // Push the current document once after (re)joining so the room always has a
    // baseline for new members.
    if (this.collab.isJoined && this.collab.canEdit && !this.collabBaselineSent) {
      this.collabBaselineSent = true;
      this.scheduleCollabSnapshot();
    }
    if (!this.collab.isJoined) this.collabBaselineSent = false;
  }
  private lastCollabStatusText = "";
  private collabBaselineSent = false;

  private shareView(): CollabShareView {
    const peers = [...this.collab.peers.values()].map((p) => ({ user: p.user, role: p.role }));
    return {
      status: this.collab.status,
      error: this.collab.error,
      serverUrl: this.collab.serverUrl,
      roomId: this.collab.roomId,
      role: this.collab.role,
      ownerId: this.collab.ownerId,
      canConnect: this.collab.status !== "connected" && this.collab.status !== "connecting",
      canLeave: this.collab.isJoined,
      canCreate: this.collab.status === "connected" && !this.collab.isJoined,
      inviteLink: this.collab.roomId ? this.inviteLink(this.collab.roomId) : "",
      selfName: this.collab.user?.id ?? "",
      peers,
    };
  }

  private scheduleOverlayUpdate(): void {
    if (this.overlayTimer !== null) return;
    this.overlayTimer = requestAnimationFrame(() => {
      this.overlayTimer = null;
      this.renderOverlay();
    });
  }

  private renderOverlay(): void {
    const frame = this.engine.getFrame();
    this.browserOverlay.sync();
    const selections = new Map<string, readonly string[]>();
    for (const [id, peer] of this.collab.peers) {
      if (id === this.collab.user?.id) continue;
      if (peer.selection.length > 0) selections.set(id, peer.selection);
    }
    this.collabUi.renderOverlay({
      toScreen: (w) => worldToScreen(w, frame),
      zoom: frame.zoom,
      objects: this.project.getObjects(),
      presences: this.collab.activePeers.map((p) => ({ user: p.user, x: p.presence.x, y: p.presence.y })),
      selections,
    });
  }

  private scheduleCollabSnapshot(): void {
    if (!this.collab.isJoined || !this.collab.canEdit || this.applyingRemote) return;
    if (this.collabSnapshotTimer !== null) return;
    this.collabSnapshotTimer = window.setTimeout(() => {
      this.collabSnapshotTimer = null;
      if (!this.collab.isJoined || !this.collab.canEdit) return;
      try {
        this.collab.sendSnapshot(JSON.parse(this.serialize()) as Record<string, unknown>);
      } catch {
        /* serialization is validated before sending */
      }
    }, 700);
  }

  /** A peer's authoritative document snapshot replaces this session's state. */
  private applyRemoteFile(file: Record<string, unknown>): void {
    try {
      const parsed = deserialize(JSON.stringify(file));
      const doc: ProjectDocument = { ...fileToDocument(parsed) };
      this.applyingRemote = true;
      try {
        this.applyDocument(doc);
      } finally {
        this.applyingRemote = false;
      }
      this.setStatus("Loaded the shared document from the room.");
    } catch {
      this.setStatus("Received a document that doesn't match the Spatia format.");
    }
  }

  start(): void {
    this.initReducedEffects();
    this.engine.attach();
    this.refreshUI();
    this.viewport.changed.emit(this.viewport.get());
    this.ui.setStatus("Ready.");
    void this.refreshRecoveryBanner();
  }

  // -------- Project operations --------

  async newProject(): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    this.applyDocument(createNewDocument());
    this.activeFilePath = null;
    this.setStatus("Created a new project.");
  }

  async openProject(): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    const result = await window.spatia.openProject();
    if (result.canceled) {
      this.setStatus("Open canceled.");
      return;
    }
    try {
      const file = deserialize(result.contents);
      const doc: ProjectDocument = fileToDocument(file);
      this.applyDocument(doc);
      this.activeFilePath = result.filePath;
      void this.refreshRecent();
      this.setStatus(`Opened ${file.project.name}.`);
    } catch (err) {
      const msg = err instanceof ProjectFormatError ? err.message : "Failed to load project.";
      this.setStatus(msg);
    }
  }

  async saveProject(): Promise<void> {
    if (!this.activeFilePath) {
      await this.saveProjectAsNew();
      return;
    }
    const json = this.serialize();
    const result = await window.spatia.saveProject(json);
    if (result.canceled) {
      this.setStatus("Save canceled.");
      return;
    }
    this.commands.markSaved();
    this.refreshUI();
    void this.refreshRecent();
    this.autoSnapshotAfterSave();
    this.clearRecoveryForCurrent();
    this.setStatus(`Saved to ${result.filePath}.`);
  }

  /** First save: name the project, then create its default per-project folder. */
  private async saveProjectAsNew(): Promise<void> {
    const current = this.project.getMeta().name || "Untitled Project";
    const name = await this.ui.promptText("Name your project", current, "Project name", "Save");
    if (!name || !name.trim()) {
      this.setStatus("Save canceled.");
      return;
    }
    this.project.rename(name.trim());
    const json = this.serialize();
    const out = await window.spatia.projectSaveDefault(this.project.getMeta().id, name.trim(), json);
    if (!out.ok) {
      this.setStatus(out.error ?? "Could not save the project.");
      return;
    }
    this.activeFilePath = out.filePath;
    this.commands.markSaved();
    this.refreshUI();
    void this.refreshRecent();
    this.autoSnapshotAfterSave();
    this.clearRecoveryForCurrent();
    this.setStatus(`Saved "${name.trim()}" to its project folder.`);
  }

  async saveAsProject(): Promise<void> {
    const suggestion = `${this.project.getMeta().name}.spatia.json`;
    const json = this.serialize();
    const result = await window.spatia.saveAsProject(json, suggestion);
    if (result.canceled) {
      this.setStatus("Save As canceled.");
      return;
    }
    this.activeFilePath = result.filePath;
    this.commands.markSaved();
    this.refreshUI();
    void this.refreshRecent();
    this.autoSnapshotAfterSave();
    this.clearRecoveryForCurrent();
    this.setStatus(`Saved project as ${result.filePath}.`);
  }

  /** Remove this project's crash-recovery draft after a successful save. */
  private clearRecoveryForCurrent(): void {
    const id = this.project.getMeta().id;
    if (!id) return;
    void window.spatia.recoveryClear(id).then(() => void this.refreshRecoveryBanner());
  }

  /**
   * Debounced silent autosave once a save location exists. Only fires on
   * actual changes (commands emit once per gesture), skips while a save is in
   * flight, and never marks the document saved when the write fails.
   */
  private scheduleAutoSave(): void {
    if (this.autoSaveInFlight) return;
    if (!this.commands.isDirty() || !this.activeFilePath) return;
    if (this.autoSaveTimer !== null) window.clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = window.setTimeout(() => {
      this.autoSaveTimer = null;
      void this.autoSave();
    }, 900);
  }

  private async autoSave(): Promise<void> {
    if (this.autoSaveInFlight || !this.commands.isDirty() || !this.activeFilePath) return;
    this.autoSaveInFlight = true;
    try {
      const result = await window.spatia.saveProject(this.serialize());
      if (!result.canceled && result.filePath) this.commands.markSaved();
    } catch {
      /* keep the document dirty; a later change will retry */
    } finally {
      this.autoSaveInFlight = false;
      this.refreshUI();
    }
  }

  /**
   * Crash recovery: while a document is dirty (or has never been saved) its
   * serialized state is mirrored to a recovery store. On launch the banner
   * offers to restore any drafts left behind.
   */
  private scheduleRecovery(): void {
    if (!this.commands.isDirty() && this.activeFilePath !== null) return;
    if (this.recoveryTimer !== null) window.clearTimeout(this.recoveryTimer);
    this.recoveryTimer = window.setTimeout(() => {
      this.recoveryTimer = null;
      void this.writeRecoveryDraft();
    }, 1500);
  }

  private async writeRecoveryDraft(): Promise<void> {
    try {
      await window.spatia.recoveryWrite(this.project.getMeta().id, this.serialize());
    } catch {
      /* best-effort */
    }
  }

  private async refreshRecoveryBanner(): Promise<void> {
    let entries: RecoveryEntry[] = [];
    try {
      entries = await window.spatia.recoveryList();
    } catch {
      entries = [];
    }
    const current = this.project.getMeta().id;
    this.ui.setRecovery(entries.filter((e) => e.projectId !== current).slice(0, 6));
    if (!this.recoveryBound) {
      this.recoveryBound = true;
      this.ui.onRecover = (id) => void this.recoverDraft(id);
      this.ui.onDiscardRecovery = (id) => void this.discardRecoveryDraft(id);
    }
  }

  private async recoverDraft(projectId: string): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    const entries = await window.spatia.recoveryList().catch((): RecoveryEntry[] => []);
    const draft = entries.find((e) => e.projectId === projectId);
    if (!draft) return;
    try {
      const file = deserialize(draft.contents);
      this.applyDocument(fileToDocument(file));
      this.activeFilePath = null;
      this.setStatus(`Recovered "${file.project.name}".`);
    } catch (err) {
      const msg = err instanceof ProjectFormatError ? err.message : "That recovery draft is not a valid project.";
      this.setStatus(msg);
    }
    await window.spatia.recoveryClear(projectId);
    void this.refreshRecoveryBanner();
  }

  private async discardRecoveryDraft(projectId: string): Promise<void> {
    await window.spatia.recoveryClear(projectId);
    void this.refreshRecoveryBanner();
  }

  async exportProject(): Promise<void> {
    const json = this.serialize();
    const meta = this.project.getMeta();
    const result = await window.spatia.exportProject(meta.id, json, `${meta.name}.spatia.json`);
    if (result.canceled) {
      this.setStatus("Export canceled.");
      return;
    }
    this.setStatus(`Exported to ${result.filePath}.`);
  }

  // -------- Export formats (assets) --------

  /** Open the export dialog (sidebar button + mobile menu). */
  openExportDialog(): void {
    this.ui.openExportDialog();
    this.setStatus("Choose an export format.");
  }

  /** Run one of the export formats picked from the dialog. */
  exportFormat(format: AppExportFormat): void {
    switch (format) {
      case "spatia-folder":
        this.closeExportDialog();
        void this.exportProject();
        return;
      case "spatia-json":
        this.closeExportDialog();
        void this.saveAsProject();
        return;
      case "png":
      case "jpeg":
      case "pdf":
        this.configureExport(format);
        return;
      case "md":
        this.closeExportDialog();
        void this.exportMarkdown();
        return;
    }
  }

  /**
   * Open the export details step (scope + resolution + summary). The dialog
   * stays open so the user can tune options before confirming; PNG/JPEG raster
   * scopes include selection and all-frames, PDF skips the single selection.
   */
  private configureExport(format: AppExportFormat): void {
    this.pendingExportFormat = format;
    const isRaster = format === "png" || format === "jpeg";
    const isPdf = format === "pdf";
    this.ui.showExportDetails({
      title: isRaster ? `Export ${format.toUpperCase()}` : "Export PDF",
      scopes: isPdf ? ["canvas", "frame", "frames"] : ["canvas", "selection", "frame", "frames"],
      showScale: isRaster,
    });
    this.updateExportSummary();
  }

  private closeExportDialog(): void {
    this.ui.closeExportDialog();
    this.focusCanvas();
  }

  /** World-space bounds covering every object, used by raster exports. */
  exportBounds(): Rect {
    return exportBounds(this.project.getObjects());
  }

  /** The document scope used by the currently configured export. */
  private exportScope(scope: string): { bounds: Rect; onlyIds: Set<string> | null } {
    if (scope === "selection") {
      const ids = new Set(this.selection.get());
      const objects = this.project.getObjectsByIds([...ids]);
      if (objects.length === 0) return { bounds: this.exportBounds(), onlyIds: null };
      const rects = objects.map((o) => ({ x: o.x, y: o.y, width: o.width, height: o.height }));
      // selectionBounds returns null only when the input rects are empty.
      const bounds = selectionBounds(rects) ?? this.exportBounds();
      return { bounds, onlyIds: ids };
    }
    if (scope === "frame") {
      const frame = this.selectedFrame();
      if (frame) {
        return {
          bounds: { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
          onlyIds: new Set(this.isolationContents(frame)),
        };
      }
    }
    return { bounds: this.exportBounds(), onlyIds: null };
  }

  /** The currently selected frame object, if any. */
  private selectedFrame(): Extract<CanvasObject, { type: "frame" }> | null {
    const ids = this.selection.get();
    if (ids.length === 1) {
      const obj = this.project.getObject(ids[0]);
      if (obj && obj.type === "frame") return obj;
    }
    return null;
  }

  /** All frame objects (export scope "frames"), each with its member id set. */
  private frameExportTargets(): { frame: Extract<CanvasObject, { type: "frame" }>; onlyIds: Set<string> }[] {
    return this.project
      .getObjects()
      .filter((o): o is Extract<CanvasObject, { type: "frame" }> => o.type === "frame")
      .map((frame) => ({ frame, onlyIds: new Set(this.isolationContents(frame)) }));
  }

  private selectedFrameLabel(): string {
    const frame = this.selectedFrame();
    return frame ? frame.name || "Untitled" : "";
  }

  /** Live summary of the configured export scope/resolution. */
  updateExportSummary(): void {
    const format = this.pendingExportFormat;
    if (!format) return;
    const scope = this.ui.getExportScope();
    const isRaster = format === "png" || format === "jpeg";
    let summary = "";
    let canRun = true;
    if (scope === "selection") {
      const count = this.selection.size;
      canRun = count > 0;
      summary = count > 0 ? `${count} selected object${count === 1 ? "" : "s"}.` : "Nothing selected.";
    } else if (scope === "frame") {
      const frame = this.selectedFrame();
      canRun = frame !== null;
      summary = frame ? `Selected frame "${this.selectedFrameLabel()}" (${Math.round(frame.width)} \u00d7 ${Math.round(frame.height)}).` : "Select a frame on the canvas.";
    } else if (scope === "frames") {
      const frames = this.frameExportTargets();
      canRun = frames.length > 0;
      summary =
        frames.length > 0
          ? `${frames.length} frame${frames.length === 1 ? "" : "s"}: ${isRaster ? "one image per frame, saved to the project exports folder." : "one PDF page per frame."}`
          : "The document has no frames.";
    } else {
      const b = this.exportBounds();
      summary = `Entire canvas (${Math.round(b.width)} \u00d7 ${Math.round(b.height)} world units).`;
    }
    if (isRaster && canRun) {
      const scale = this.ui.getExportScale();
      summary = `${summary} Resolution ${scale}\u00d7 (${Math.round(this.exportScope(scope).bounds.width * scale)} \u00d7 ${Math.round(this.exportScope(scope).bounds.height * scale)} px).`;
    }
    this.ui.setExportSummary(summary);
    this.ui.exportRun.disabled = !canRun;
  }

  /** Run the currently configured PNG/JPEG export at the chosen scope/resolution. */
  private async runImageExport(kind: "png" | "jpeg"): Promise<void> {
    const scope = this.ui.getExportScope();
    const scale = this.ui.getExportScale();
    const mime = kind === "jpeg" ? "image/jpeg" : "image/png";
    const ext = kind === "jpeg" ? "jpg" : "png";
    const base = this.exportBaseName();
    if (scope === "frames") {
      const targets = this.frameExportTargets();
      if (targets.length === 0) {
        this.setStatus("The document has no frames.");
        return;
      }
      let done = 0;
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        const rect: Rect = { x: t.frame.x, y: t.frame.y, width: t.frame.width, height: t.frame.height };
        const raster = await this.engine.rasterizeExport(rect, scale, mime, t.onlyIds);
        if (!raster) continue;
        const payload = raster.dataUrl.split(",")[1] ?? "";
        const fileName = `${base} - Frame ${i + 1}.${ext}`;
        const result = await window.spatia.exportToExports(this.project.getMeta().id, fileName, payload);
        if (result.canceled) {
          this.setStatus("Export canceled.");
          return;
        }
        done += 1;
      }
      this.setStatus(`Exported ${done} ${kind.toUpperCase()} image${done === 1 ? "" : "s"} to the project exports folder.`);
      return;
    }
    const { bounds, onlyIds } = this.exportScope(scope);
    const raster = await this.engine.rasterizeExport(bounds, scale, mime, onlyIds);
    if (!raster) {
      this.setStatus("Could not rasterize the canvas.");
      return;
    }
    const payload = raster.dataUrl.split(",")[1] ?? "";
    const result = await window.spatia.exportFile(kind, `${base}.${ext}`, payload);
    if (result.canceled) {
      this.setStatus("Export canceled.");
      return;
    }
    this.setStatus(`Exported ${kind.toUpperCase()} to ${result.filePath}.`);
  }

  /** Run the currently configured PDF export (canvas or frame/frames scope). */
  private async runPdfExport(): Promise<void> {
    const scope = this.ui.getExportScope();
    const base = this.exportBaseName();
    let targets = [] as { frame: Extract<CanvasObject, { type: "frame" }>; onlyIds: Set<string> }[];
    if (scope === "frames") {
      targets = this.frameExportTargets();
    } else if (scope === "frame") {
      const frame = this.selectedFrame();
      if (frame) targets = [{ frame, onlyIds: new Set(this.isolationContents(frame)) }];
    }
    if (scope === "frame" || scope === "frames") {
      if (targets.length === 0) {
        this.setStatus(scope === "frame" ? "Select a frame on the canvas." : "The document has no frames.");
        return;
      }
      const pages = [] as PdfPage[];
      for (const t of targets) {
        const rect: Rect = { x: t.frame.x, y: t.frame.y, width: t.frame.width, height: t.frame.height };
        // Scale 2 + dpi 144 → page size equals the frame's logical units in points.
        const raster = await this.engine.rasterizeExport(rect, 2, "image/jpeg", t.onlyIds);
        if (!raster) continue;
        pages.push({
          jpegBase64: raster.dataUrl.split(",")[1] ?? "",
          pixelWidth: raster.width,
          pixelHeight: raster.height,
          dpi: 144,
        });
      }
      if (pages.length === 0) {
        this.setStatus("Could not rasterize the frame(s).");
        return;
      }
      void this.writePdf(pages, `${base}.pdf`);
      return;
    }
    const bounds = this.exportBounds();
    const raster = await this.engine.rasterizeExport(bounds, 2, "image/jpeg");
    if (!raster) {
      this.setStatus("Could not rasterize the canvas.");
      return;
    }
    void this.writePdf(
      [
        {
          jpegBase64: raster.dataUrl.split(",")[1] ?? "",
          pixelWidth: raster.width,
          pixelHeight: raster.height,
          dpi: 96,
        },
      ],
      `${base}.pdf`
    );
  }

  private async writePdf(pages: PdfPage[], fileName: string): Promise<void> {
    const pdf = buildPdfFromJpegs(pages);
    const result = await window.spatia.exportFile("pdf", fileName, bytesToBase64(pdf));
    if (result.canceled) {
      this.setStatus("Export canceled.");
      return;
    }
    this.setStatus(`Exported PDF to ${result.filePath}.`);
  }

  /** Run the currently configured export (from the details panel). */
  private runConfiguredExport(): void {
    const format = this.pendingExportFormat;
    if (!format) return;
    this.closeExportDialog();
    if (format === "png" || format === "jpeg") void this.runImageExport(format);
    else if (format === "pdf") void this.runPdfExport();
  }

  /** Markdown down-export of the current document (notes/text/links). */
  buildMarkdownText(): string {
    return buildMarkdown(this.project.getMeta().name, this.project.getObjects());
  }

  private exportBaseName(): string {
    const name = (this.project.getMeta().name || "Spatia").trim();
    const cleaned = name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-");
    return cleaned || "spatia-export";
  }

  private async exportMarkdown(): Promise<void> {
    const text = this.buildMarkdownText();
    const result = await window.spatia.exportFile("md", `${this.exportBaseName()}.md`, text);
    if (result.canceled) {
      this.setStatus("Export canceled.");
      return;
    }
    this.setStatus(`Exported Markdown to ${result.filePath}.`);
  }

  // -------- Templates --------

  /** Open the template picker dialog and render the starter cards. */
  openTemplatesDialog(): void {
    const list = this.ui.templatesList;
    list.innerHTML = TEMPLATES.map(
      (t) =>
        `<button class="template-card" data-template="${t.id}" type="button">` +
        `<span class="template-accent" style="background:${t.accent}"></span>` +
        `<span class="template-name">${escapeHtml(t.name)}</span>` +
        `<span class="template-desc">${escapeHtml(t.description)}</span>` +
        `</button>`
    ).join("");
    Array.from(list.querySelectorAll("[data-template]")).forEach((el) => {
      el.addEventListener("click", () => {
        const id = (el as HTMLElement).getAttribute("data-template");
        if (id) void this.applyTemplate(id);
      });
    });
    this.ui.openTemplatesDialog();
  }

  private closeTemplatesDialog(): void {
    this.ui.closeTemplatesDialog();
    this.focusCanvas();
  }

  /** Replace the current document with the given template's starter canvas. */
  async applyTemplate(id: string): Promise<void> {
    this.closeTemplatesDialog();
    const tpl = templateById(id);
    if (!tpl) {
      this.setStatus("Unknown template.");
      return;
    }
    if (!(await this.confirmDiscard())) return;
    const doc = createNewDocument();
    doc.objects = tpl.build();
    this.applyDocument(doc);
    this.setStatus(`Applied the "${tpl.name}" template.`);
  }

  // -------- Project library dialog --------

  private library: LibraryData | null = null;

  /** Open the project library (browse / search / favorite / organize). */
  async openProjectsDialog(): Promise<void> {
    this.setStatus("Loading project library…");
    try {
      this.library = await window.spatia.libraryGet();
    } catch {
      this.library = null;
    }
    this.renderProjects();
    this.ui.openProjectsDialog();
  }

  private closeProjectsDialog(): void {
    this.ui.closeProjectsDialog();
    this.focusCanvas();
  }

  private async reloadLibrary(): Promise<boolean> {
    try {
      this.library = await window.spatia.libraryGet();
      this.renderProjects();
      return true;
    } catch {
      return false;
    }
  }

  private renderProjects(): void {
    if (!this.library) {
      this.ui.projectsList.innerHTML = `<span class="recent-empty">Could not load the project library.</span>`;
      return;
    }
    const query = this.ui.projectsSearch.value.trim();
    const sort = this.ui.projectsSort.value as "name" | "updated";
    const folder = this.ui.projectsFolder.value;
    let items = filterProjects(this.library.projects, query);
    if (folder === "__fav") items = items.filter((p) => p.favorite);
    else if (folder === "__none") items = items.filter((p) => !p.folderId);
    else if (folder !== "__all") items = items.filter((p) => p.folderId === folder);
    const sorted = sortProjects(items, sort);

    const folderName = (id: string | null | undefined): string | null => {
      if (!id) return null;
      return this.library!.folders.find((f) => f.id === id)?.name ?? null;
    };
    const folderOptions = `<option value="__all">All folders</option>
      <option value="__fav">Favorites</option>
      <option value="__none">Uncategorized</option>
      ${this.library.folders.map((f) => `<option value="${escapeAttr(f.id)}">${escapeHtml(f.name)}</option>`).join("")}`;
    this.ui.projectsFolder.innerHTML = folderOptions;
    this.ui.projectsFolder.value = folder;

    let html = "";
    // Folder management strip.
    for (const f of this.library.folders) {
      const count = this.library.projects.filter((p) => p.folderId === f.id).length;
      html += `<div class="project-folder-row">
        <button class="projects-link" data-action="filter-folder" data-folder="${escapeAttr(f.id)}">📁 ${escapeHtml(f.name)}</button>
        <span class="project-count">${count}</span>
        <button class="btn projects-mini" data-action="rename-folder" data-folder="${escapeAttr(f.id)}" title="Rename folder">Rename</button>
        <button class="btn projects-mini danger" data-action="delete-folder" data-folder="${escapeAttr(f.id)}" title="Delete folder">Delete</button>
      </div>`;
    }

    if (sorted.length === 0) {
      html += `<div class="projects-empty">No projects found.</div>`;
    }
    for (const p of sorted) {
      const tags = (p.tags ?? [])
        .map((t) => `<span class="project-tag">${escapeHtml(t)}</span>`)
        .join("");
      const folderLabel = folderName(p.folderId);
      html += `<div class="project-row${p.exists === false ? " missing" : ""}">
        <button class="projects-fav" data-action="fav" data-path="${escapeAttr(p.filePath)}" title="Toggle favorite">${p.favorite ? "★" : "☆"}</button>
        <div class="project-main">
          <button class="projects-link project-name" data-action="open" data-path="${escapeAttr(p.filePath)}">${escapeHtml(p.displayName)}</button>
          ${p.exists === false ? `<span class="project-missing">missing</span>` : ""}
          <div class="project-meta">${escapeHtml(p.filePath)}</div>
          <div class="project-tags">${tags}</div>
          ${folderLabel ? `<div class="project-meta">Folder: ${escapeHtml(folderLabel)}</div>` : ""}
        </div>
        <div class="project-actions">
          <button class="btn projects-mini" data-action="rename" data-path="${escapeAttr(p.filePath)}">Rename</button>
          <button class="btn projects-mini" data-action="tags" data-path="${escapeAttr(p.filePath)}" title="Edit tags">Tags</button>
          <select class="projects-folder-select" data-action="folder" data-path="${escapeAttr(p.filePath)}" title="Move to folder">
            <option value="">No folder</option>
            ${this.library.folders.map((f) => `<option value="${escapeAttr(f.id)}"${p.folderId === f.id ? " selected" : ""}>${escapeHtml(f.name)}</option>`).join("")}
          </select>
          <button class="btn projects-mini" data-action="remove" data-path="${escapeAttr(p.filePath)}" title="Remove from list">Remove</button>
          <button class="btn projects-mini danger" data-action="trash" data-path="${escapeAttr(p.filePath)}" title="Delete the project file">Trash</button>
        </div>
      </div>`;
    }
    this.ui.projectsList.innerHTML = html;
  }

  /** Handle a click/change inside the project library dialog. */
  private onProjectsAction(e: Event): void {
    const target = e.target as HTMLElement;
    const isSelect = target.closest?.("[data-action='folder']") as HTMLSelectElement | null;
    const btn = (target.closest("[data-action]") as HTMLElement | null) ?? isSelect;
    if (!btn) return;
    const action = btn.dataset.action;
    const path = btn.dataset.path ?? "";
    const voidFn = async (): Promise<void> => {
      if (action === "open" && path) {
        this.closeProjectsDialog();
        await this.openProjectPath(path);
      } else if (action === "fav" && path && this.library) {
        const p = this.library.projects.find((x) => x.filePath === path);
        if (p) await window.spatia.librarySetFavorite(path, !p.favorite);
      } else if (action === "filter-folder") {
        const id = btn.dataset.folder ?? "";
        this.ui.projectsFolder.value = id;
      } else if (action === "rename" && path) {
        const p = this.library?.projects.find((x) => x.filePath === path);
        const name = await this.ui.promptText("Rename project", p?.displayName ?? "", "New name");
        if (name !== null) {
          const res = await window.spatia.libraryRename(path, name.trim());
          this.setStatus(res.ok ? "Project renamed." : `Rename failed: ${res.error ?? "unknown error"}`);
        }
      } else if (action === "tags" && path) {
        const p = this.library?.projects.find((x) => x.filePath === path);
        const value = await this.ui.promptText("Project tags (comma separated)", (p?.tags ?? []).join(", "), "tag1, tag2");
        if (value !== null) {
          const tags = value.split(",").map((s) => s.trim()).filter(Boolean);
          await window.spatia.librarySetTags(path, tags);
        }
      } else if (action === "folder" && path) {
        const folderId = isSelect ? isSelect.value || null : null;
        await window.spatia.librarySetFolder(path, folderId);
      } else if (action === "remove" && path) {
        if (window.confirm(`Remove "${path}" from the library? The file is not deleted.`)) {
          await window.spatia.libraryRemove(path);
        }
      } else if (action === "trash" && path) {
        if (window.confirm(`Delete the project file "${path}"?`)) {
          const ok = await window.spatia.libraryTrash(path);
          this.setStatus(ok ? "Project file deleted." : "Could not delete the project file.");
        }
      } else if (action === "rename-folder") {
        const id = btn.dataset.folder ?? "";
        const f = this.library?.folders.find((x) => x.id === id);
        const name = await this.ui.promptText("Rename folder", f?.name ?? "", "Folder name");
        if (name !== null && name.trim()) await window.spatia.libraryRenameFolder(id, name.trim());
      } else if (action === "delete-folder") {
        const id = btn.dataset.folder ?? "";
        if (window.confirm("Delete this folder? Projects inside will become uncategorized.")) {
          await window.spatia.libraryDeleteFolder(id);
        }
      }
      await this.reloadLibrary();
    };
    void voidFn();
  }

  private async createLibraryFolder(): Promise<void> {
    const name = await this.ui.promptText("New folder", "", "Folder name");
    if (name !== null && name.trim()) {
      const folder = await window.spatia.libraryCreateFolder(name.trim());
      if (folder) this.ui.projectsFolder.value = folder.id;
      await this.reloadLibrary();
    }
  }

  // -------- Version history dialog --------

  /** Open the version history for the current project. */
  async openVersionsDialog(): Promise<void> {
    await this.captureVersionSnapshot("Autosave on open");
    this.ui.openVersionsDialog();
    await this.refreshVersionsDialog();
  }

  private closeVersionsDialog(): void {
    this.ui.closeVersionsDialog();
    this.focusCanvas();
  }

  private async refreshVersionsDialog(): Promise<void> {
    const meta = this.project.getMeta();
    let snapshots: VersionSnapshotMeta[] = [];
    try {
      snapshots = await window.spatia.versionsList(meta.id);
    } catch {
      snapshots = [];
    }
    if (snapshots.length === 0) {
      this.ui.versionsList.innerHTML = `<span class="recent-empty">No snapshots yet — save the project to capture one.</span>`;
      return;
    }
    this.ui.versionsList.innerHTML = snapshots
      .map(
        (s) =>
          `<div class="version-row">
        <div class="version-main">
          <div class="version-label">${escapeHtml(s.label)}</div>
          <div class="project-meta">${escapeHtml(new Date(s.createdAt).toLocaleString())}</div>
        </div>
        <div class="project-actions">
          <button class="btn projects-mini" data-action="restore" data-token="${escapeAttr(s.token)}">Restore</button>
          <button class="btn projects-mini danger" data-action="delete" data-token="${escapeAttr(s.token)}">Delete</button>
        </div>
      </div>`
      )
      .join("");
  }

  /** Capture a snapshot of the current document. */
  async captureVersionSnapshot(label: string): Promise<void> {
    const meta = this.project.getMeta();
    try {
      await window.spatia.versionsAdd(meta.id, label, this.serialize());
    } catch {
      /* snapshots are best-effort */
    }
  }

  private handleVersionsAction(e: Event): void {
    const btn = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
    if (!btn) return;
    const token = btn.dataset.token ?? "";
    const voidFn = async (): Promise<void> => {
      const meta = this.project.getMeta();
      if (btn.dataset.action === "restore" && token) {
        if (!(await this.confirmDiscard())) return;
        const json = await window.spatia.versionsRestore(meta.id, token);
        if (json === null) {
          this.setStatus("Could not read that snapshot.");
          return;
        }
        try {
          const file = deserialize(json);
          this.applyDocument(fileToDocument(file));
          this.setStatus(`Restored snapshot "${btn.textContent}".`);
        } catch {
          this.setStatus("That snapshot is not a valid project.");
        }
      } else if (btn.dataset.action === "delete" && token) {
        if (window.confirm("Delete this snapshot?")) {
          await window.spatia.versionsDelete(meta.id, token);
        }
      }
      await this.refreshVersionsDialog();
    };
    void voidFn();
  }

  /** Auto-snapshot after a successful save (bounded by the store at 20/project). */
  private autoSnapshotAfterSave(): void {
    const meta = this.project.getMeta();
    void window.spatia
      .versionsAdd(meta.id, `Autosave — ${meta.name}`, this.serialize())
      .catch(() => {
        /* best-effort */
      });
  }

async importProject(): Promise<void> {
    const result = await window.spatia.importProject();
    if (result.canceled || result.contents === null) {
      this.setStatus("Import canceled.");
      return;
    }
    try {
      const file = deserialize(result.contents);
      const doc: ProjectDocument = fileToDocument(file);
      this.applyDocument(doc);
      // Imported documents start unpersisted under their new project id; the
      // first manual save creates a per-project folder for them.
      this.activeFilePath = null;
      void this.refreshRecent();
      this.setStatus(`Imported "${file.project.name}".`);
    } catch (err) {
      const msg = err instanceof ProjectFormatError ? err.message : "Failed to import project.";
      this.setStatus(msg);
    }
  }

  async openProjectPath(filePath: string): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    const result = await window.spatia.openProjectPath(filePath);
    if (result.canceled) {
      this.setStatus("Could not open project.");
      return;
    }
    try {
      const file = deserialize(result.contents);
      const doc: ProjectDocument = fileToDocument(file);
      this.applyDocument(doc);
      this.activeFilePath = result.filePath;
      void this.refreshRecent();
      this.setStatus(`Opened ${file.project.name}.`);
    } catch (err) {
      const msg = err instanceof ProjectFormatError ? err.message : "Failed to load project.";
      this.setStatus(msg);
    }
  }

  private async refreshRecent(): Promise<void> {
    try {
      const recent = await window.spatia.getRecentProjects();
      this.ui.setRecent(recent);
    } catch {
      /* recent list is best-effort */
    }
  }

  // -------- Object creation --------

  private addObjectAt(kind: ObjectKind, worldCenter: Point): void {
    if (kind === "image") {
      void this.addImageObjectAt(worldCenter);
      return;
    }
    if (kind === "file") {
      void this.addFileObjectAt(worldCenter);
      return;
    }
    if (kind === "text") {
      this.addTextAt(worldCenter);
      return;
    }
    if (kind === "note") {
      this.addNoteAt(worldCenter);
      return;
    }
    if (kind === "url") {
      this.addUrlAt(worldCenter);
      return;
    }
    if (kind === "table") {
      this.addTableAt(worldCenter);
      return;
    }
    if (kind === "chart") {
      this.addChartAt("bar", worldCenter);
      return;
    }
    const id = this.engine.addObjectAt(kind, worldCenter);
    if (id) this.selection.setIds([id]);
    this.refreshUI();
  }

  /**
   * Create a text object and immediately begin editing it inline — no
   * double-click and no placeholder text to delete. The object starts empty
   * and the caret is placed in the editor right away.
   */
  private addTextAt(worldCenter: Point): void {
    const size = { width: 200, height: 120 };
    const obj: CanvasObject = {
      type: "text",
      id: "obj_" + crypto.randomUUID(),
      x: worldCenter.x - size.width / 2,
      y: worldCenter.y - size.height / 2,
      width: size.width,
      height: size.height,
      rotation: 0,
      zIndex: this.project.nextZIndex(),
      locked: false,
      metadata: {},
      text: "",
      fontSize: 24,
      bold: false,
      italic: false,
      align: "left",
    };
    this.commands.execute(addObjectCommand(this.project, obj));
    this.selection.setIds([obj.id]);
    this.refreshUI();
    this.editTextObject(obj);
  }

  private async addUrlAt(worldCenter: Point): Promise<void> {
    const input = await this.ui.promptUrl();
    const trimmed = (input ?? "").trim();
    if (!trimmed) {
      this.setStatus("Link creation canceled.");
      return;
    }
    const url = normalizeUrl(trimmed);
    const title = trimmed.replace(/^https?:\/\//i, "");
    const id = this.engine.createUrlObject(url, title || trimmed, worldCenter);
    this.selection.setIds([id]);
    this.refreshUI();
  }

  /**
   * Create a sticky note and immediately begin editing its body — the same
   * "no extra click" flow as text. Starts blank so typing creates the note.
   */
  private addNoteAt(worldCenter: Point): void {
    const size = { width: 180, height: 140 };
    const colors = ["#f0c33c", "#f28c5c", "#5cb8f2", "#5cd69b", "#c07cf2"];
    const obj: CanvasObject = {
      type: "note",
      id: "obj_" + crypto.randomUUID(),
      x: worldCenter.x - size.width / 2,
      y: worldCenter.y - size.height / 2,
      width: size.width,
      height: size.height,
      rotation: 0,
      zIndex: this.project.nextZIndex(),
      locked: false,
      metadata: {},
      title: "",
      text: "",
      color: colors[Math.floor(Math.random() * colors.length)],
    };
    this.commands.execute(addObjectCommand(this.project, obj));
    this.selection.setIds([obj.id]);
    this.refreshUI();
    this.editTextObject(obj);
  }

  /** Create a diagram shape centered on `worldCenter` and select it. */
  private addShapeAt(kind: ShapeKind, worldCenter: Point): void {
    const id = this.engine.addShapeObject(kind, worldCenter);
    if (id) {
      this.selection.setIds([id]);
      this.refreshUI();
    }
  }

  private addImageObjectAt(worldCenter: Point): Promise<void> {
    return this.importAssetObject(worldCenter);
  }

  private addFileObjectAt(worldCenter: Point): Promise<void> {
    return this.importAssetObject(worldCenter);
  }

  private async importAssetObject(worldCenter: Point): Promise<void> {
    const asset = await this.assets.pick();
    if (!asset) {
      this.setStatus("Import canceled.");
      return;
    }
    this.project.addAssets([asset]);
    if (asset.kind === "image") {
      const id = this.engine.createImageObject(asset.id, worldCenter);
      this.selection.setIds([id]);
      void this.engine.ensureImage(asset.id);
    } else {
      const id = this.engine.createFileObject(asset.id, worldCenter);
      this.selection.setIds([id]);
    }
    this.refreshUI();
  }

  // -------- Selection / clipboard / z-order --------

  private copySelection(): void {
    const inkIds = new Set(this.engine.getInkSelectedObjects().map((o) => o.id));
    const objects = this.project
      .getObjects()
      .filter((o) => this.selection.has(o.id) && !this.engine.isInkId(o.id));
    if (objects.length === 0 && inkIds.size === 0) return;
    const all = [...objects, ...this.engine.getInkSelectedObjects()];
    this.clipboard = all.map((o) => structuredClone(o) as CanvasObject);
    this.setStatus(`Copied ${all.length} object${all.length > 1 ? "s" : ""}.`);
  }

  private pasteClipboard(): void {
    if (this.clipboard.length === 0) {
      this.setStatus("Clipboard is empty.");
      return;
    }
    const center = screenToWorld({ x: this.engine.getFrame().originWidth / 2, y: this.engine.getFrame().originHeight / 2 }, this.engine.getFrame());
    const pasted: string[] = [];
    const pastedInk: string[] = [];
    const self = this;
    const clones = this.clipboard.map((o, i) => ({
      ...structuredClone(o),
      id: "obj_" + crypto.randomUUID(),
      x: o.x + 30,
      y: o.y + 30,
      zIndex: this.project.nextZIndex() + i,
    }));
    this.commands.execute({
      label: "Paste",
      redo() {
        for (const c of clones) {
          self.project.addObject(c as CanvasObject);
          if ((c as CanvasObject).type === "pen") pastedInk.push(c.id);
          else pasted.push(c.id);
        }
      },
      undo() {
        for (const c of clones) self.project.removeObjects([c.id]);
      },
    });
    void center;
    this.selection.setIds(pasted);
    this.engine.setInkSelection(pastedInk);
    this.refreshUI();
  }

  private deleteSelection(): void {
    if (this.selection.size === 0 && !this.engine.hasInkSelection()) return;
    this.engine.deleteSelection();
    this.refreshUI();
  }

  private bringToFront(): void {
    if (this.selection.size === 0) return;
    this.engine.raiseSelection();
    this.refreshUI();
  }

  private sendToBack(): void {
    if (this.selection.size === 0) return;
    this.engine.lowerSelection();
    this.refreshUI();
  }

  // -------- Text / note editing --------

  private editSelectedText(): void {
    const ids = this.selection.get();
    if (ids.length !== 1) return;
    const obj = this.project.getObject(ids[0]);
    if (!obj || (obj.type !== "text" && obj.type !== "note")) return;
    this.editTextObject(obj);
  }

  private editTextObject(obj: Extract<CanvasObject, { type: "text" | "note" }>): void {
    const frame = this.engine.getFrame();
    const tl = screenPoint(obj.x, obj.y, frame);
    const w = obj.width * frame.zoom;
    const h = obj.height * frame.zoom;
    const fontSize = (obj.type === "text" ? obj.fontSize : obj.width * 0.07) * frame.zoom;
    const fontFamily = obj.type === "text" ? obj.fontFamily : undefined;

    openTextEditor({
      left: tl.x,
      top: tl.y,
      width: w,
      height: h,
      fontSize,
      value: obj.text,
      multiline: true,
      fontFamily,
      onCommit: (text) => {
        if (text === obj.text) {
          this.refreshUI();
          return;
        }
        const changes: PropChange[] = [{ id: obj.id, key: "text", before: obj.text, after: text }];
        // Grow the text object with its content so long text never clips after
        // commit (a rough pass when no canvas measure is available).
        if (obj.type === "text") {
          const ctx = this.engine.canvas().getContext("2d");
          let measure: ((s: string) => number) | undefined;
          if (ctx) {
            const fam = obj.fontFamily ? `"${obj.fontFamily}"` : `"Segoe UI", system-ui, sans-serif`;
            ctx.font = `${obj.italic ? "italic " : ""}${obj.bold ? "bold " : ""}${obj.fontSize}px ${fam}`;
            measure = (s) => ctx.measureText(s).width;
          }
          const nextHeight = estimateTextHeight(text, obj.fontSize, obj.width, measure);
          if (Math.abs(nextHeight - obj.height) > 4) {
            changes.push({ id: obj.id, key: "height", before: obj.height, after: nextHeight });
          }
        }
        this.commands.execute(setPropsCommand(this.project, changes));
        this.refreshUI();
      },
    });
  }

  // -------- Context menu --------

  private editDataObject(obj: CanvasObject): void {
    if (obj.type !== "table" && obj.type !== "chart") return;
    const isChart = obj.type === "chart";
    openDataEditor({
      title: isChart ? "Chart data" : obj.comparison ? "Comparison data" : "Table data",
      data: obj.data,
      onCommit: (data: TableData) => {
        const change: PropChange = { id: obj.id, key: "data", before: obj.data, after: data };
        this.commands.execute(setPropsCommand(this.project, [change]));
        this.refreshUI();
      },
    });
  }

  /**
   * Open the inline editor over the table cell under a screen point. Uses the
   * same layout math as the renderer, so the input always sits on the cell.
   * Commits through the command stack (undoable) on the `data` property.
   */
  private editTableCell(obj: CanvasObject, screen: Point): void {
    if (obj.type !== "table") return;
    const frame = this.engine.getFrame();
    const world = screenToWorld(screen, frame);
    const cx = obj.x + obj.width / 2;
    const cy = obj.y + obj.height / 2;

    const invCos = Math.cos(-obj.rotation);
    const invSin = Math.sin(-obj.rotation);
    const dx = world.x - cx;
    const dy = world.y - cy;
    const lx = dx * invCos - dy * invSin;
    const ly = dx * invSin + dy * invCos;

    const layout = tableLayout(obj.data, obj.width, obj.height, frame.zoom);
    const cell = tableCellAt(obj.data, layout, obj.width, obj.height, { x: lx, y: ly });
    if (!cell) return;
    const rect = tableCellRect(obj.data, layout, obj.width, obj.height, cell.row, cell.col);

    const cos = Math.cos(obj.rotation);
    const sin = Math.sin(obj.rotation);
    const topLeft = worldToScreen({ x: cx + rect.x * cos - rect.y * sin, y: cy + rect.x * sin + rect.y * cos }, frame);

    const current =
      cell.row < 0 ? (obj.data.columns[cell.col] ?? "") : (obj.data.rows[cell.row]?.[cell.col] ?? "");
    const fontSize = Math.max(7, Math.min(11, layout.headerPx * 0.58));

    closeTableCellEditor();
    openTableCellEditor({
      left: topLeft.x,
      top: topLeft.y,
      width: rect.width * frame.zoom,
      height: rect.height * frame.zoom,
      fontSize,
      value: current,
      onCommit: (value) => {
        if (value === current) {
          this.refreshUI();
          return;
        }
        const before = obj.data;
        const after = cell.row < 0 ? renameColumn(before, cell.col, value) : setCell(before, cell.row, cell.col, value);
        const change: PropChange = { id: obj.id, key: "data", before, after };
        this.commands.execute(setPropsCommand(this.project, [change]));
        this.refreshUI();
      },
    });
  }

  private showContextMenu(screen: Point, world: Point): void {
    const hit = this.engine.hitTest(screen);
    if (hit && !this.engine.inSelection(hit)) {
      this.selection.setIds([hit]);
    }
    const hasSelection = this.selection.size > 0;
    const single = this.selection.size === 1;
    const two = this.selection.size === 2;
    const obj = single ? this.project.getObject(this.selection.get()[0]) : undefined;
    const editableText = obj !== undefined && (obj.type === "text" || obj.type === "note");
    const canEdit = obj !== undefined && !obj.locked;
    const selectionIds = this.selection.get();
    const singleGroup = single && (this.project.getObject(selectionIds[0])?.type === "group");
    const groupable = this.selection.size >= 2;

    const items: ContextMenuItem[] = [];
    const openableFile = obj?.type === "file";
    const openableUrl = obj?.type === "url";
    if (openableFile || openableUrl) {
      items.push({
        label: openableUrl ? "Open link" : "Open file",
        action: () => this.openObject(obj),
      });
    }
    if (editableText) {
      items.push({ label: "Edit text", action: () => this.editSelectedText() });
      items.push({ separatorBefore: true, label: "Bring to front", shortcut: "]", enabled: canEdit, action: () => this.bringToFront() });
      items.push({ label: "Send to back", shortcut: "[", enabled: canEdit, action: () => this.sendToBack() });
    } else if (hasSelection) {
      items.push({ label: "Bring to front", shortcut: "]", enabled: canEdit, action: () => this.bringToFront() });
      items.push({ label: "Send to back", shortcut: "[", enabled: canEdit, action: () => this.sendToBack() });
    }
    if (hasSelection) {
      items.push({ separatorBefore: true, label: "Focus selection", shortcut: "F", action: () => this.focusSelection() });
      items.push({ label: "Isolate container", shortcut: "Shift+I", enabled: single && (obj?.type === "group" || obj?.type === "frame"), action: () => this.isolateSelection() });
      items.push({ separatorBefore: true, label: "Duplicate", shortcut: "Ctrl+D", enabled: canEdit, action: () => this.duplicateSelection() });
      items.push({ label: "Delete", shortcut: "Del", enabled: canEdit, action: () => this.deleteSelection() });
      if (obj && (obj.type === "table" || obj.type === "chart")) {
        items.push({
          separatorBefore: true,
          label: "Edit data…",
          enabled: canEdit,
          action: () => this.editDataObject(obj),
        });
      }
      if (obj && (obj.type === "file" || obj.type === "image")) {
        items.push({
          separatorBefore: true,
          label: "Relink file…",
          action: () => void this.relinkObject(obj),
        });
      }
    }
    if (two) {
      items.push({
        separatorBefore: true,
        label: "Connect selection",
        shortcut: "Ctrl+Shift+C",
        action: () => this.connectSelection(),
      });
    }
    if (hasSelection) {
      items.push({
        separatorBefore: true,
        label: "Group",
        shortcut: "Ctrl+G",
        enabled: groupable,
        action: () => this.groupSelection(),
      });
      items.push({
        label: "Ungroup",
        shortcut: "Ctrl+Shift+G",
        enabled: singleGroup,
        action: () => this.ungroupSelection(),
      });
    }
    items.push({ separatorBefore: true, label: "Add text", action: () => this.addObjectAt("text", world) });
    items.push({ label: "Add note", action: () => this.addObjectAt("note", world) });
    items.push({ label: "Add image", action: () => this.addObjectAt("image", world) });
    items.push({ label: "Add file", action: () => this.addObjectAt("file", world) });
    items.push({ label: "Add link", action: () => this.addObjectAt("url", world) });
    items.push({ label: "Add frame", action: () => this.addFrameAt(world), items: [
      { label: "Rectangle", action: () => this.addFrameAt(world, "rectangle") },
      { label: "Rounded", action: () => this.addFrameAt(world, "rounded") },
      { label: "Ellipse", action: () => this.addFrameAt(world, "ellipse") },
      ] });
    items.push({ separatorBefore: true, label: "Add data", enabled: false, action: () => {} });
    items.push({ label: "Add table", action: () => this.addTableAt(world) });
    items.push({ label: "Add comparison", action: () => this.addTableAt(world, true) });
    items.push({ label: "Add chart", action: () => this.addChartAt("bar", world), items: [
      { label: "Bar", action: () => this.addChartAt("bar", world) },
      { label: "Line", action: () => this.addChartAt("line", world) },
      { label: "Pie", action: () => this.addChartAt("pie", world) },
    ] });
    items.push({
      separatorBefore: true,
      label: "Shapes",
      items: SHAPE_KINDS.map((sk) => ({
        label: `Add ${shapeLabel(sk)}`,
        action: () => this.addShapeAt(sk, world),
      })),
    });
    items.push({ separatorBefore: true, label: "Paste here", enabled: this.clipboard.length > 0, action: () => this.pasteClipboard() });

    const pluginCommands = this.pluginsManager.commandsList();
    if (pluginCommands.length > 0) {
      items.push({ separatorBefore: true, label: "Plugins", enabled: false, action: () => {} });
      for (const c of pluginCommands) {
        items.push({ label: c.label, action: () => void this.pluginsManager.dispatchCommand(c.id) });
      }
    }

    showContextMenu(items, screen.x, screen.y);
  }

  private async openObject(obj: CanvasObject | undefined): Promise<void> {
    if (!obj) return;
    if (obj.type === "url") {
      const ok = await window.spatia.openExternal(obj.url || obj.title);
      this.setStatus(ok ? `Opened ${obj.title}.` : `Could not open ${obj.title}.`);
      return;
    }
    if (obj.type === "file") {
      const ok = await window.spatia.openAsset(this.project.getMeta().id, obj.assetId);
      this.setStatus(ok ? "Opened in your default app." : "File is missing — relink it?");
      return;
    }
    this.setStatus("Nothing to open for this object.");
  }

  private async relinkObject(obj: CanvasObject): Promise<void> {
    if (obj.type !== "file" && obj.type !== "image") return;
    const result = await window.spatia.relinkAsset(this.project.getMeta().id, obj.assetId);
    if (result.canceled) {
      this.setStatus("Relink canceled.");
      return;
    }
    if (!result.asset) {
      this.setStatus("Could not relink file.");
      return;
    }
    this.project.replaceAsset(result.asset);
    if (obj.type === "image") {
      this.engine.invalidateImage(obj.assetId);
      void this.engine.ensureImage(obj.assetId);
    }
    this.refreshUI();
    this.setStatus(`Relinked "${result.asset.name}".`);
  }

  private connectSelection(): void {
    const ids = this.selection.get();
    if (ids.length !== 2) return;
    this.engine.createConnection(ids[0], ids[1]);
    this.refreshUI();
    this.setStatus("Connected objects.");
  }

  private groupSelection(): void {
    if (this.selection.size < 2) return;
    const id = this.engine.groupSelection();
    if (id) {
      this.refreshUI();
      this.setStatus("Grouped objects.");
    }
  }

  private ungroupSelection(): void {
    this.engine.ungroupSelection();
    this.refreshUI();
    this.setStatus("Ungrouped.");
  }

  private addFrameAt(world: Point, frameShape: FrameShape = "rectangle"): void {
    const id = this.engine.createFrame(world, frameShape);
    if (id) {
      this.selection.setIds([id]);
      this.refreshUI();
    }
  }

  private addTableAt(world: Point, comparison = false): void {
    const id = this.engine.createTableObject(world, comparison);
    if (id) {
      this.selection.setIds([id]);
      this.refreshUI();
    }
  }

  private addChartAt(kind: ChartKind, world: Point): void {
    const id = this.engine.createChartObject(kind, world);
    if (id) {
      this.selection.setIds([id]);
      this.refreshUI();
    }
  }

  private duplicateSelection(): void {
    if (this.selection.size === 0) return;
    this.engine.duplicateSelection();
    this.refreshUI();
  }

  /** Rotate the selection by `deg` degrees; R = 15°, Shift+R = -15°. */
  private rotateSelection(deg: number): void {
    if (this.selection.size === 0) return;
    this.engine.rotateSelection(deg);
    this.refreshUI();
    this.setStatus(`Rotated by ${deg}° (${deg > 0 ? "R" : "Shift+R"}).`);
  }

  // -------- Focus / isolation --------

  private focusSelection(): void {
    const bounds = this.engine.selectionWorldBounds();
    if (!bounds) {
      this.setStatus("Select one or more objects to focus.");
      return;
    }
    const next = viewportForRect(bounds, this.engine.getFrame());
    if (!next) {
      this.setStatus("Could not focus this selection.");
      return;
    }
    this.viewport.set(next);
    this.setStatus(`Focused ${this.selection.size} object${this.selection.size === 1 ? "" : "s"}.`);
  }

  private isolateSelection(): void {
    if (this.selection.size !== 1) {
      this.setStatus("Select one group or frame to isolate.");
      return;
    }
    const container = this.project.getObject(this.selection.get()[0]);
    if (!container || (container.type !== "group" && container.type !== "frame")) {
      this.setStatus("Only groups and frames can be isolated.");
      return;
    }
    const visible = this.isolationContents(container);
    this.isolation = { containerId: container.id, visibleIds: visible };
    this.engine.setIsolation(visible);
    this.ui.setIsolation(container.type, container.name || "Untitled");
    this.focusSelection();
    this.scheduleOverlayUpdate();
    this.setStatus(`Isolated ${container.type}. Press Escape to exit.`);
  }

  private isolationContents(container: Extract<CanvasObject, { type: "group" | "frame" }>): string[] {
    const ids = new Set<string>([container.id]);
    if (container.type === "group") {
      for (const id of container.memberIds) ids.add(id);
    } else {
      const bounds: Rect = { x: container.x, y: container.y, width: container.width, height: container.height };
      for (const obj of this.project.getObjects()) {
        if (obj.type === "connection" || obj.type === "frame") continue;
        if (isContainedBy(obj, bounds)) ids.add(obj.id);
      }
    }
    // A connection is useful in isolation only when both of its endpoints are in scope.
    for (const obj of this.project.getObjects()) {
      if (obj.type === "connection" && ids.has(obj.from) && ids.has(obj.to)) ids.add(obj.id);
    }
    return [...ids];
  }

  private exitIsolation(): void {
    if (!this.isolation) return;
    this.isolation = null;
    this.engine.setIsolation(null);
    this.ui.clearIsolation();
    this.scheduleOverlayUpdate();
    this.setStatus("Exited isolation.");
  }

  // -------- Undo / redo / view --------

  private undo(): void {
    if (!this.commands.canUndo) return;
    closeTextEditor();
    this.commands.undo();
    this.refreshUI();
  }

  private redo(): void {
    if (!this.commands.canRedo) return;
    this.commands.redo();
    this.refreshUI();
  }

  private zoomIn(): void {
    this.engine.zoomBy(1.2);
  }

  private zoomOut(): void {
    this.engine.zoomBy(1 / 1.2);
  }

  private resetView(): void {
    this.engine.resetView();
    this.setStatus("View reset.");
  }

  // -------- Plugins --------

  private bindPlugins(): void {
    this.ui.btnPlugins.addEventListener("click", () => void this.openPluginsDialog());
    this.pluginsManager.changed.subscribe(() => this.renderPluginsDialog());
    this.pluginsUi.onInstall = () => void this.pluginsManager.install();
    this.pluginsUi.onInstallUrl = (url) => void this.pluginsManager.installFromUrl(url);
    this.pluginsUi.onToggle = (id, enabled) => void this.pluginsManager.setEnabled(id, enabled);
    this.pluginsUi.onRemove = (id) => void this.pluginsManager.remove(id);
    this.pluginsUi.onRunCommand = (commandId) => void this.pluginsManager.dispatchCommand(commandId);

    // API v2: push app events to subscribed plugins (selection / document /
    // viewport). The manager filters to plugins that registered a listener.
    this.selection.changed.subscribe((ids) =>
      this.pluginsManager.publish("selection", { ids: [...ids] })
    );
    this.project.changed.subscribe(() =>
      this.pluginsManager.publish("document", { objectCount: this.project.getObjects().length })
    );
    this.viewport.changed.subscribe((vp) =>
      this.pluginsManager.publish("viewport", { x: vp.x, y: vp.y, zoom: vp.zoom })
    );
  }

  /** Open the Plugins dialog (also reachable from the mobile menu sheet). */
  openPluginsDialog(): void {
    this.renderPluginsDialog();
    this.pluginsUi.open();
  }

  private renderPluginsDialog(): void {
    this.pluginsUi.render(
      this.pluginsManager.entriesList(),
      this.pluginsManager.commandsList(),
      (id) => this.pluginsManager.runtimeErrorOf(id)
    );
  }

  private pluginGateway(): PluginApiGateway {
    return {
      notify: (text) => this.ui.notify(text),
      selectionIds: () => [...this.selection.get()],
      projectMeta: () => {
        const m = this.project.getMeta();
        return { id: m.id, name: m.name, createdAt: m.createdAt, updatedAt: m.updatedAt };
      },
      viewportState: () => {
        const vp = this.viewport.get();
        return { x: vp.x, y: vp.y, zoom: vp.zoom };
      },
      viewportCenter: () => this.centerWorld(),
      objects: () =>
        this.project
          .getObjects()
          .map((o) => this.toObjectView(o))
          .filter((v): v is PluginObjectView => v !== null),
      objectById: (id) => this.toObjectView(this.project.getObject(id)),
      createObject: (kind, x, y, props) => this.pluginCreateObject(kind, x, y, props),
      updateObject: (id, props) => {
        this.applyPluginProps(id, props);
        return this.toObjectView(this.project.getObject(id));
      },
      deleteObjects: (ids) => this.pluginDeleteObjects(ids),
      select: (ids) => this.selection.setIds(ids.filter((id) => this.project.getObject(id) !== undefined)),
      selectAdd: (ids) => this.selection.add(ids.filter((id) => this.project.getObject(id) !== undefined)),
      clearSelection: () => this.selection.clear(),
      focusSelection: () => this.focusSelection(),
      zoom: (factor) => this.engine.zoomBy(factor),
      undo: () => {
        const had = this.commands.canUndo;
        if (had) this.undo();
        return had;
      },
      redo: () => {
        const had = this.commands.canRedo;
        if (had) this.redo();
        return had;
      },
    };
  }

  private toObjectView(o: CanvasObject | undefined): PluginObjectView | null {
    if (!o) return null;
    const view: Record<string, unknown> = {
      type: o.type,
      id: o.id,
      x: o.x,
      y: o.y,
      width: o.width,
      height: o.height,
      rotation: o.rotation,
      zIndex: o.zIndex,
      locked: o.locked,
    };
    if (o.type === "text") {
      view.text = o.text;
      view.fontSize = o.fontSize;
      view.bold = o.bold;
      view.italic = o.italic;
      view.align = o.align;
    } else if (o.type === "note") {
      view.text = o.text;
    } else if (o.type === "url") {
      view.url = o.url;
      view.title = o.title;
    } else if (o.type === "frame") {
      const url = browserUrlOf(o);
      if (url) view.url = url;
    } else if (o.type === "shape") {
      view.kind = o.kind;
      view.fill = o.fill;
      view.stroke = o.stroke;
      view.strokeWidth = o.strokeWidth;
    }
    if ("name" in o && o.name !== undefined) view.name = o.name;
    return view as PluginObjectView;
  }

  private pluginCreateObject(
    kind: string,
    x: number,
    y: number,
    props: Record<string, unknown>
  ): PluginObjectView | null {
    const center = { x, y };
    let id: string | null = null;
    if (kind === "url") {
      const url = typeof props.url === "string" ? normalizeUrl(props.url) : "";
      if (!url) return null;
      id = this.engine.createUrlObject(url, typeof props.title === "string" ? props.title : "", center);
    } else if (kind === "frame") {
      id = this.engine.createFrame(center);
    } else if (kind === "shape") {
      const sk =
        typeof props.kind === "string" && (SHAPE_KINDS as readonly string[]).includes(props.kind)
          ? (props.kind as ShapeKind)
          : "rectangle";
      id = this.engine.addShapeObject(sk, center);
    } else if (kind === "text" || kind === "note" || kind === "test-object") {
      id = this.engine.addObjectAt(kind, center);
    }
    if (!id) return null;
    this.applyPluginProps(id, props);
    this.refreshUI();
    return this.toObjectView(this.project.getObject(id));
  }

  private applyPluginProps(id: string, props: Record<string, unknown>): void {
    const obj = this.project.getObject(id);
    if (!obj || Object.keys(props).length === 0) return;
    const numKeys: readonly string[] = ["x", "y", "rotation", "zIndex", "fontSize", "strokeWidth"];
    const boolKeys: readonly string[] = ["locked", "bold", "italic", "arrowhead"];
    const strKeys: readonly string[] = ["text", "title", "url", "align", "name", "color", "fill", "stroke"];
    const changes: PropChange[] = [];
    const sizeAdjust: Partial<Record<"width" | "height", number>> = {};

    for (const [key, raw] of Object.entries(props)) {
      if (obj.locked && key !== "locked") continue;
      // A frame's address is project metadata, never a top-level field — the
      // serializer drops unknown top-level keys but keeps `metadata` verbatim.
      if (key === "url" && obj.type === "frame") {
        const url = normalizeBrowserUrl(typeof raw === "string" ? raw : "");
        if (!url) continue;
        if (browserUrlOf(obj) === url) continue;
        changes.push({ id, key: "metadata", before: { ...obj.metadata }, after: { ...obj.metadata, browserUrl: url } });
        continue;
      }
      const before = (obj as unknown as Record<string, unknown>)[key];
      let after: unknown;
      if (key === "width" || key === "height") {
        const n = typeof raw === "number" ? raw : Number(raw);
        if (!Number.isFinite(n)) continue;
        sizeAdjust[key] = n;
        continue;
      }
      if (numKeys.includes(key)) {
        const n = typeof raw === "number" ? raw : Number(raw);
        if (!Number.isFinite(n)) continue;
        after = n;
      } else if (boolKeys.includes(key)) {
        after = raw === true || raw === "true" || raw === 1;
      } else if (strKeys.includes(key)) {
        if (typeof raw !== "string") continue;
        after = raw;
      } else {
        continue;
      }
      if (after !== before) changes.push({ id, key, before, after });
    }

    if (sizeAdjust.width !== undefined || sizeAdjust.height !== undefined) {
      const before = { id: obj.id, x: obj.x, y: obj.y, width: obj.width, height: obj.height };
      const after = { ...before };
      if (sizeAdjust.width !== undefined) after.width = Math.max(4, sizeAdjust.width);
      if (sizeAdjust.height !== undefined) after.height = Math.max(4, sizeAdjust.height);
      this.commands.execute(resizeObjectsCommand(this.project, [before], [after]));
    }
    if (changes.length > 0) {
      this.commands.execute(setPropsCommand(this.project, changes));
    }
    this.refreshUI();
  }

  private pluginDeleteObjects(ids: string[]): number {
    const existing = ids.filter((id) => this.project.getObject(id) !== undefined);
    if (existing.length === 0) return 0;
    this.commands.execute(deleteObjectsCommand(this.project, existing));
    this.refreshUI();
    return existing.length;
  }

  // -------- Internals --------

  private serialize(): string {
    const m = this.project.getMeta();
    return serialize(
      { ...this.project.get().viewport },
      this.project.getObjects(),
      {
        id: m.id,
        name: m.name,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        tags: m.tags,
        shared: m.shared,
      },
      this.project.getAssets(),
    );
  }

  private applyDocument(doc: ProjectDocument): void {
    this.exitIsolation();
    this.project.replace(doc);
    this.viewport.set({ ...doc.viewport });
    this.selection.clear();
    this.commands.clear();
    this.commands.markSaved();
    this.assets.setProjectId(doc.meta.id);
    void this.engine.loadImagesFor(doc.objects);
    this.refreshUI();
  }

  private refreshProjectRefs(): void {
    this.assets.setProjectId(this.project.getMeta().id);
  }

  /** Toggle the tools panel. */
  private setSidebar(open: boolean): void {
    this.ui.setSidebarOpen(open);
  }

  // -------- Reduced visual effects --------

  /** Apply the persisted reduced-effects preference to <html>. */
  private initReducedEffects(): void {
    let on = false;
    try {
      on = localStorage.getItem(EFFECTS_KEY) === "1";
    } catch {
      /* storage unavailable; default to full effects */
    }
    document.documentElement.classList.toggle("spatia-reduced-effects", on);
    this.ui.settingsEffects.checked = on;
  }

  private bindReducedEffects(): void {
    this.ui.settingsEffects.addEventListener("change", () => {
      const on = this.ui.settingsEffects.checked;
      document.documentElement.classList.toggle("spatia-reduced-effects", on);
      try {
        localStorage.setItem(EFFECTS_KEY, on ? "1" : "0");
      } catch {
        /* best-effort persistence */
      }
    });
  }

  // -------- Settings --------

  /** Open the in-app Settings dialog. */
  openSettingsDialog(): void {
    this.ui.openSettingsDialog();
    this.setStatus(`Spatia v${APP_VERSION} — local-first, offline by default.`);
  }

  private confirmDiscard(): Promise<boolean> {
    if (!this.commands.isDirty()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const ok = window.confirm("You have unsaved changes in the current project. Continue without saving?");
      resolve(ok);
    });
  }

  private bindEvents(): void {
    this.commands.changed.subscribe(() => {
      this.refreshUI();
      this.scheduleAutoSave();
      this.scheduleRecovery();
    });
    this.project.changed.subscribe(() => {
      if (this.isolation && !this.project.getObject(this.isolation.containerId)) this.exitIsolation();
      this.refreshUI();
      this.scheduleOverlayUpdate();
      this.scheduleCollabSnapshot();
      this.scheduleAutoSave();
      this.scheduleRecovery();
    });
    this.project.replaced.subscribe(() => {
      this.refreshUI();
      this.refreshAssetsUi();
    });
    this.viewport.changed.subscribe((vp) => {
      this.ui.setZoom(vp.zoom);
      this.minimap?.update();
      this.scheduleOverlayUpdate();
    });
    this.selection.changed.subscribe(() => {
      this.refreshUI();
      this.collab.sendSelection(this.selection.get());
    });
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("paste", this.onPaste);
    // A normal workspace click dismisses the sidebar. The sidebar is a sibling
    // of the canvas, so pointer events inside it never reach this listener.
    this.engine.canvas().addEventListener("pointerdown", () => {
      this.focusCanvas();
      if (this.ui.isSidebarOpen()) this.setSidebar(false);
    });
    // Collaborative cursor presence: send the world-space pointer on move.
    this.engine.canvas().addEventListener("pointermove", (e) => {
      if (!this.collab.isJoined) return;
      const rect = this.engine.canvas().getBoundingClientRect();
      const frame = this.engine.getFrame();
      const world = screenToWorld({ x: e.clientX - rect.left, y: e.clientY - rect.top }, frame);
      this.collab.sendPresence(world.x, world.y);
    });
  }

  /** Handle OS pasted files/text (images, files); internal objects use Ctrl+V. */
  private onPaste = (e: ClipboardEvent): void => {
    if (isEditingText()) return;
    if (isEditingTableCell()) return;
    // When a real editable field (e.g. the Add Link URL input or an inspector
    // input) has focus, the OS paste must go into that field, not the canvas.
    // ClipboardEvent.target is the focused editable element in that case.
    if (isEditableEventTarget(e)) return;
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      const file = files[0];
      const path = window.spatia.getDroppedFilePath(file);
      if (path) {
        e.preventDefault();
        void this.importDropped(path, file.name);
        return;
      }
    }
    // Pasted text creates a link if it looks like a URL, else a text object.
    const text = (e.clipboardData?.getData("text/plain") || "").trim();
    if (text) {
      e.preventDefault();
      const world = screenToWorld(
        { x: this.engine.getFrame().originWidth / 2, y: this.engine.getFrame().originHeight / 2 },
        this.engine.getFrame()
      );
      if (/^[a-zA-Z]+\:/.test(text)) {
        const id = this.engine.createUrlObject(normalizeUrl(text), text, world);
        this.selection.setIds([id]);
      } else {
        this.addTextAt(world);
        // fill the freshly created text with the pasted value via the editor
        const ta = document.querySelector(".spatia-text-editor") as HTMLTextAreaElement | null;
        if (ta) ta.value = text;
      }
      this.refreshUI();
      this.setStatus("Pasted.");
    }
  };

  private refreshUI(): void {
    this.ui.setProject(this.project.getMeta());
    this.ui.setSaved(this.commands.isDirty());
    this.ui.setUndoEnabled(this.commands.canUndo);
    this.ui.setRedoEnabled(this.commands.canRedo);
    this.minimap?.update();
    this.updateInspector();
  }

  private updateInspector(): void {
    // While the pen tool is active the inspector hosts the pen's tool panel
    // (size / color / eraser) so new strokes are fully editable; drawing never
    // holds a selection, so the object view is irrelevant here.
    if (this.engine.isPenTool()) {
      this.setInspectorMinimized(false);
      this.ui.setInspectorOpen(true);
      this.ui.setInspector(this.penToolInspector());
      return;
    }
    // Ink selection (freehand strokes) takes priority over the object view
    // when strokes are selected, since stroke objects are rarely edited through
    // the object inspector.
    if (this.engine.hasInkSelection()) {
      this.ui.setInspectorOpen(true);
      this.ui.setInspector(this.inkInspector());
      return;
    }
    const ids = this.selection.get();
    if (ids.length === 0) {
      this.ui.setInspectorOpen(false);
      return;
    }
    this.ui.setInspectorOpen(true);
    if (ids.length === 1) {
      const obj = this.project.getObject(ids[0]);
      if (!obj) {
        this.ui.setInspector(`<span class="inspector-empty">Select an object</span>`);
        return;
      }
      this.ui.setInspector(this.inspectorFor(obj));
      void this.refreshMissingFlag(obj);
    } else {
      this.ui.setInspector(`<span class="inspector-empty">${ids.length} objects selected</span>`);
    }
  }

  /** Inspector view shown while the pen tool is active (live tool style). */
  private penToolInspector(): string {
    const s = this.engine.getPenSettings();
    const mode = this.engine.getPenToolMode();
    const smoothing = Number(s.smoothing);
    const stabilizer = s.stabilizer === "strong" ? "strong" : s.stabilizer === "mild" ? "mild" : "off";
    const eraserMode = s.eraserMode === "stroke" ? "stroke" : "partial";
    const num = (v: number) => round(v);
    const checked = (v: boolean) => (v ? " checked" : "");
    return (
      `<div class="inspector-row"><span class="inspector-label">Mode</span>` +
        `<select class="inspector-input" data-pen="mode">` +
          `<option value="pen"${mode === "pen" ? " selected" : ""}>Pen</option>` +
          `<option value="eraser"${mode === "eraser" ? " selected" : ""}>Eraser</option>` +
          `<option value="lasso"${mode === "lasso" ? " selected" : ""}>Lasso</option>` +
        `</select></div>` +
      `<div class="inspector-row"><span class="inspector-label">Size</span>` +
        `<input class="inspector-input" data-pen="size" type="number" min="0.5" max="64" step="0.5" value="${num(s.width)}"></div>` +
      `<div class="inspector-row"><span class="inspector-label">Opacity</span>` +
        `<input class="inspector-input" data-pen="opacity" type="number" min="0.05" max="1" step="0.05" value="${num(s.opacity)}"></div>` +
      `<div class="inspector-row"><span class="inspector-label">Color</span>` +
        `<input class="inspector-input share-color" data-pen="color" type="color" value="${escapeAttr(s.color)}"></div>` +
      `<div class="inspector-row"><span class="inspector-label">Smoothing</span>` +
        `<select class="inspector-input" data-pen="smoothing">` +
          `<option value="0"${smoothing === 0 ? " selected" : ""}>0</option>` +
          `<option value="1"${smoothing === 1 ? " selected" : ""}>1</option>` +
          `<option value="2"${smoothing === 2 ? " selected" : ""}>2</option>` +
        `</select></div>` +
      `<div class="inspector-row"><span class="inspector-label">Stabilizer</span>` +
        `<select class="inspector-input" data-pen="stabilizer">` +
          `<option value="off"${stabilizer === "off" ? " selected" : ""}>Off</option>` +
          `<option value="mild"${stabilizer === "mild" ? " selected" : ""}>Mild</option>` +
          `<option value="strong"${stabilizer === "strong" ? " selected" : ""}>Strong</option>` +
        `</select></div>` +
      `<div class="inspector-row"><span class="inspector-label">Pressure</span>` +
        `<input class="inspector-input" data-pen="pressure" type="checkbox"${checked(s.pressure)}></div>` +
      `<div class="inspector-row"><span class="inspector-label">Eraser mode</span>` +
        `<select class="inspector-input" data-pen="eraser-mode">` +
          `<option value="partial"${eraserMode === "partial" ? " selected" : ""}>Partial</option>` +
          `<option value="stroke"${eraserMode === "stroke" ? " selected" : ""}>Whole stroke</option>` +
        `</select></div>` +
      `<div class="inspector-row"><span class="inspector-label">Eraser size</span>` +
        `<input class="inspector-input" data-pen="eraser-size" type="number" min="6" max="80" step="1" value="${Math.round(s.eraserRadius)}"></div>` +
      `<div class="inspector-row"><span class="inspector-label">Eraser</span>` +
        `<input class="inspector-input" data-pen="eraser" type="checkbox"${mode === "eraser" ? " checked" : ""}></div>`
    );
  }

  /** Ink selection inspector (freehand strokes selected through ink selection). */
  private inkInspector(): string {
    const ids = this.engine.getInkSelectedObjects();
    if (ids.length === 0) return `<span class="inspector-empty">No strokes selected</span>`;
    const head =
      ids.length > 1
        ? `<div class="inspector-row"><span class="inspector-label">Type</span><span>Ink (${ids.length} strokes)</span></div>`
        : `<div class="inspector-row"><span class="inspector-label">Type</span><span>Ink stroke</span></div>`;
    const color = ids.length === 1 ? ids[0].color : "#e8eaed";
    const width = ids.length === 1 ? ids[0].strokeWidth : 3;
    const opacity = ids.length === 1 ? (ids[0].opacity ?? 1) : 1;
    const buttons =
      `<div class="inspector-buttons">` +
      `<button class="inspector-btn" data-action="duplicate">Duplicate</button>` +
      `<button class="inspector-btn" data-action="delete">Delete</button>` +
      `</div>`;
    return (
      head +
      `<div class="inspector-row"><span class="inspector-label">Color</span>` +
        `<input class="inspector-input share-color" data-ink="color" type="color" value="${escapeAttr(color)}"></div>` +
      `<div class="inspector-row"><span class="inspector-label">Width</span>` +
        `<input class="inspector-input" data-ink="width" type="number" min="0.5" step="0.5" value="${round(width)}"></div>` +
      `<div class="inspector-row"><span class="inspector-label">Opacity</span>` +
        `<input class="inspector-input" data-ink="opacity" type="number" min="0.05" max="1" step="0.05" value="${round(opacity)}"></div>` +
      buttons
    );
  }

  /** Build the single-object inspector DOM from the object reference. */
  private inspectorFor(obj: CanvasObject): string {
    const typeLabel = obj.type.charAt(0).toUpperCase() + obj.type.slice(1);
    const numField = (label: string, key: string, value: number, step = 1): string =>
      `<div class="inspector-row"><span class="inspector-label">${label}</span>` +
      `<input class="inspector-input" data-prop="${key}" type="number" step="${step}" value="${round(value)}"></div>`;
    const rows: string[] = [
      `<div class="inspector-row"><span class="inspector-label">Type</span><span>${typeLabel}</span></div>`,
      `<div class="inspector-row"><span class="inspector-label">Tags</span>` +
        `<input class="inspector-input" data-prop="metadata-tags" value="${escapeAttr(objectTags(obj).join(", "))}" placeholder="comma, separated"></div>`,
    ];
    if (obj.type === "url") {
      rows.push(
        `<div class="inspector-row"><span class="inspector-label">Title</span>` +
          `<input class="inspector-input" data-prop="title" value="${escapeAttr((obj as { title: string }).title)}"></div>`,
        `<div class="inspector-row"><span class="inspector-label">URL</span>` +
          `<input class="inspector-input" data-prop="url" value="${escapeAttr((obj as { url: string }).url)}"></div>`
      );
    } else if (obj.type === "text") {
      const text = obj as Extract<CanvasObject, { type: "text" }>;
      const family = text.fontFamily || "";
      rows.push(
        `<div class="inspector-row"><span class="inspector-label">Text</span>` +
          `<textarea class="inspector-input" data-prop="text" rows="3">${escapeHtml(text.text)}</textarea></div>`
      );
      rows.push(
        `<div class="inspector-row"><span class="inspector-label">Font size</span>` +
          `<input class="inspector-input" data-prop="fontSize" type="number" min="8" step="1" value="${round(text.fontSize)}"></div>`,
        `<div class="inspector-row"><span class="inspector-label">Font</span>` +
          `<select class="inspector-input" data-prop="fontFamily">` +
          FONT_CHOICES.map((f) => `<option value="${f}"${family === f ? " selected" : ""}>${f}</option>`).join("") +
          `<option value=""${family === "" ? " selected" : ""}>Default</option>` +
          `</select></div>`,
        `<div class="inspector-row"><span class="inspector-label">Bold</span>` +
          `<input class="inspector-input" data-prop="bold" type="checkbox"${text.bold ? " checked" : ""}></div>`,
        `<div class="inspector-row"><span class="inspector-label">Italic</span>` +
          `<input class="inspector-input" data-prop="italic" type="checkbox"${text.italic ? " checked" : ""}></div>`,
        `<div class="inspector-row"><span class="inspector-label">Align</span>` +
          `<select class="inspector-input" data-prop="align">` +
          `<option value="left"${text.align === "left" ? " selected" : ""}>Left</option>` +
          `<option value="center"${text.align === "center" ? " selected" : ""}>Center</option>` +
          `<option value="right"${text.align === "right" ? " selected" : ""}>Right</option>` +
          `</select></div>`
      );
    } else if (obj.type === "pen") {
      // Committed strokes: color + base stroke width are editable. The stroke
      // width edit scales any per-vertex (pressure) widths proportionally so
      // the whole stroke stays consistent (see commitInspectorProp).
      rows.push(
        `<div class="inspector-row"><span class="inspector-label">Color</span>` +
          `<input class="inspector-input share-color" data-prop="color" type="color" value="${escapeAttr(obj.color || "#e8eaed")}"></div>`,
        `<div class="inspector-row"><span class="inspector-label">Stroke W</span>` +
          `<input class="inspector-input" data-prop="strokeWidth" type="number" min="0.5" step="0.5" value="${round(obj.strokeWidth || 3)}"></div>`
      );
    } else if (obj.type === "shape") {
      const shape = obj as Extract<CanvasObject, { type: "shape" }>;
      rows.push(
        `<div class="inspector-row"><span class="inspector-label">Kind</span><span>${shapeLabel(shape.kind)}</span></div>`,
        `<div class="inspector-row"><span class="inspector-label">Fill</span><input class="inspector-input share-color" data-prop="fill" type="color" value="${escapeAttr(shape.fill || "#ffffff")}"></div>`,
        `<div class="inspector-row"><span class="inspector-label">Stroke</span><input class="inspector-input share-color" data-prop="stroke" type="color" value="${escapeAttr(shape.stroke)}"></div>`,
        `<div class="inspector-row"><span class="inspector-label">Stroke W</span><input class="inspector-input" data-prop="strokeWidth" type="number" min="0.5" step="0.5" value="${round(shape.strokeWidth)}"></div>`
      );
    } else if (obj.type === "table") {
      const table = obj as Extract<CanvasObject, { type: "table" }>;
      rows.push(
        `<div class="inspector-row"><span class="inspector-label">Rows</span><span>${table.data.rows.length}</span></div>`,
        `<div class="inspector-row"><span class="inspector-label">Columns</span><span>${table.data.columns.length}</span></div>`,
        `<div class="inspector-row"><span class="inspector-label">Comparison</span>` +
          `<input class="inspector-input" data-prop="comparison" type="checkbox"${table.comparison ? " checked" : ""}></div>`
      );
    } else if (obj.type === "chart") {
      const chart = obj as Extract<CanvasObject, { type: "chart" }>;
      rows.push(
        `<div class="inspector-row"><span class="inspector-label">Title</span>` +
          `<input class="inspector-input" data-prop="title" value="${escapeAttr(chart.title || "")}"></div>`,
        `<div class="inspector-row"><span class="inspector-label">Chart type</span>` +
          `<select class="inspector-input" data-prop="chart-kind">` +
          `<option value="bar"${chart.kind === "bar" ? " selected" : ""}>Bar</option>` +
          `<option value="line"${chart.kind === "line" ? " selected" : ""}>Line</option>` +
          `<option value="pie"${chart.kind === "pie" ? " selected" : ""}>Pie</option>` +
          `</select></div>`
      );
    }
    rows.push(numField("X", "x", obj.x, 1));
    rows.push(numField("Y", "y", obj.y, 1));
    rows.push(numField("Width", "width", obj.width, 1));
    rows.push(numField("Height", "height", obj.height, 1));
    rows.push(numField("Rotation", "rotation", obj.rotation, 0.1));
    rows.push(
      `<div class="inspector-row"><span class="inspector-label">Z</span>` +
        `<input class="inspector-input" data-prop="zIndex" type="number" value="${obj.zIndex}"></div>`
    );
    rows.push(
      `<div class="inspector-row"><span class="inspector-label">Locked</span>` +
        `<input class="inspector-input" data-prop="locked" type="checkbox"${obj.locked ? " checked" : ""}></div>`
    );
    const warn =
      this.isAssetObject(obj)
        ? `<div class="inspector-warn" id="inspector-missing-warning" ${this.missingAssets.has(obj.assetId) ? "" : 'style="display:none"'}>Missing file — reopen or relink it.</div>`
        : "";
    const buttons: string[] = [];
    if (obj.type === "file" || obj.type === "url") {
      buttons.push(`<button class="inspector-btn" data-action="open">${obj.type === "url" ? "Open link" : "Open"}</button>`);
    }
    if (obj.type === "file" || obj.type === "image") {
      buttons.push(`<button class="inspector-btn" data-action="relink">Relink…</button>`);
    }
    buttons.push(`<button class="inspector-btn" data-action="duplicate">Duplicate</button>`);
    buttons.push(`<button class="inspector-btn" data-action="delete">Delete</button>`);
    if (obj.type === "text" || obj.type === "note") {
      buttons.push(`<button class="inspector-btn" data-action="edit">Edit</button>`);
    }
    return (
      rows.join("") +
      `${warn}` +
      `<div class="inspector-buttons">${buttons.join("")}</div>`
    );
  }

  private isAssetObject(obj: CanvasObject): obj is Extract<CanvasObject, { type: "file" | "image" }> {
    return obj.type === "file" || obj.type === "image";
  }

  private missingAssets = new Set<string>();

  private async refreshMissingFlag(obj: CanvasObject): Promise<void> {
    if (!this.isAssetObject(obj)) return;
    try {
      const exists = await window.spatia.assetExists(this.project.getMeta().id, obj.assetId);
      this.missingAssets[exists ? "delete" : "add"](obj.assetId);
      const warn = document.getElementById("inspector-missing-warning");
      if (warn) warn.style.display = exists ? "none" : "";
    } catch {
      /* ignore */
    }
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    // Text editing and IME composition always win. Any editable control (the
    // inline text editor, table cell editor, inspector inputs, dialog fields,
    // search box, plugin/collab inputs…) owns its keys: typing, Backspace,
    // Ctrl+A/C/C/V, cursor movement and Space must never be intercepted here.
    if (isEditingText() || isEditingTableCell() || isEditableEventTarget(e)) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (mod && key === "s" && !e.shiftKey) {
      e.preventDefault();
      void this.saveProject();
      return;
    }
    if (mod && key === "z") {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && key === "y") {
      e.preventDefault();
      this.redo();
      return;
    }
    if (mod && key === "k") {
      e.preventDefault();
      this.toggleCommandPalette();
      return;
    }
    if ((key === "delete" || key === "backspace")) {
      e.preventDefault();
      this.deleteSelection();
      return;
    }
    if (mod && key === "c") {
      e.preventDefault();
      this.copySelection();
      return;
    }
    if (mod && key === "v") {
      e.preventDefault();
      this.pasteClipboard();
      return;
    }
    if (mod && key === "d") {
      e.preventDefault();
      this.duplicateSelection();
      return;
    }
    if (mod && key === "a") {
      e.preventDefault();
      this.engine.selectAll();
      return;
    }
    // Pen-tool quick keys (only while the pen tool is active; they must never
    // steal typing — e.g. a lone "E" in a future search box).
    if (this.engine.isPenTool() && !mod) {
      if (key === "e") {
        e.preventDefault();
        this.engine.setPenToolMode("eraser");
        this.refreshUI();
        return;
      }
      if (key === "p") {
        e.preventDefault();
        this.engine.setPenToolMode("pen");
        this.refreshUI();
        return;
      }
      if (key === "l") {
        e.preventDefault();
        this.engine.setPenToolMode("lasso");
        this.refreshUI();
        return;
      }
      if (key === "=" || key === "+") {
        e.preventDefault();
        this.engine.setPenSettings({ width: Math.min(64, this.engine.getPenSettings().width + 1) });
        this.refreshUI();
        return;
      }
      if (key === "-" || key === "_") {
        e.preventDefault();
        this.engine.setPenSettings({ width: Math.max(0.5, this.engine.getPenSettings().width - 1) });
        this.refreshUI();
        return;
      }
    }
    if (mod && key === "g") {
      e.preventDefault();
      if (e.shiftKey) this.ungroupSelection();
      else this.groupSelection();
      return;
    }
    if (mod && e.shiftKey && key === "c") {
      e.preventDefault();
      this.connectSelection();
      return;
    }
    if (e.key === "]") {
      e.preventDefault();
      this.bringToFront();
      return;
    }
    if (e.key === "[") {
      e.preventDefault();
      this.sendToBack();
      return;
    }
    if (key === "f" && !mod) {
      e.preventDefault();
      this.focusSelection();
      return;
    }
    if ((mod && key === "f") || key === "/") {
      e.preventDefault();
      this.openSearch();
      return;
    }
    if (key === "i" && e.shiftKey && !mod) {
      e.preventDefault();
      this.isolateSelection();
      return;
    }
    if (key === "r" && !mod) {
      e.preventDefault();
      this.rotateSelection(e.shiftKey ? -15 : 15);
      return;
    }
    if (e.key === "Escape") {
      if (isEditingData()) {
        closeDataEditor();
        return;
      }
      hideContextMenu();
      // Ink selection is its own set: Escape clears it before falling back to
      // the object selection, so one tap always dismisses the strokes.
      if (this.isolation) this.exitIsolation();
      else if (this.engine.hasInkSelection()) {
        this.engine.clearInkSelection();
        this.refreshUI();
      } else this.selection.clear();
      return;
    }
  };

  private bindDragDrop(canvas: HTMLCanvasElement): void {
    const prevent = (e: DragEvent): void => {
      e.preventDefault();
    };
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", this.onDrop);
    window.addEventListener("dragenter", () => {
      this.engine.setInteractionCursor("copy");
    });
    canvas.addEventListener("dragleave", () => {
      this.engine.setInteractionCursor("default");
    });
  }

  private onDrop = (e: DragEvent): void => {
    e.preventDefault();
    this.engine.setInteractionCursor("default");
    const dt = e.dataTransfer;
    if (!dt) return;
    const file = dt.files?.[0];
    if (file) {
      const path = window.spatia.getDroppedFilePath(file);
      if (!path) {
        this.setStatus("Could not access dropped file.");
        return;
      }
      void this.importDropped(path, file.name, e);
      return;
    }
    // URL / text link drop (e.g. from a browser): create a link object.
    const url = (dt.getData("text/uri-list") || dt.getData("text/plain") || "").trim();
    if (url && /^[a-zA-Z]+\:/.test(url)) {
      const world = screenToWorld(
        { x: e.clientX - this.engine.canvas().getBoundingClientRect().left, y: e.clientY - this.engine.canvas().getBoundingClientRect().top },
        this.engine.getFrame()
      );
      const id = this.engine.createUrlObject(normalizeUrl(url), url, world);
      this.selection.setIds([id]);
      this.refreshUI();
      this.setStatus("Added link.");
    }
  };

  private async importDropped(
    sourcePath: string,
    name: string,
    e?: { clientX?: number; clientY?: number }
  ): Promise<void> {
    const asset = await this.assets.importFromPath(sourcePath, name);
    if (!asset) {
      this.setStatus("Could not import dropped file.");
      return;
    }
    this.project.addAssets([asset]);
    const rect = this.engine.canvas().getBoundingClientRect();
    const cx = e?.clientX !== undefined ? e.clientX - rect.left : this.engine.getFrame().originWidth / 2;
    const cy = e?.clientY !== undefined ? e.clientY - rect.top : this.engine.getFrame().originHeight / 2;
    const world = screenToWorld({ x: cx, y: cy }, this.engine.getFrame());
    if (asset.kind === "image") {
      const id = this.engine.createImageObject(asset.id, world);
      this.selection.setIds([id]);
      void this.engine.ensureImage(asset.id);
    } else {
      const id = this.engine.createFileObject(asset.id, world);
      this.selection.setIds([id]);
    }
    this.refreshUI();
    this.setStatus(`Added "${asset.name}".`);
  }

  private bindUI(): void {
    this.ui.btnNew.addEventListener("click", () => void this.newProject());
    this.ui.btnOpen.addEventListener("click", () => void this.openProject());
    this.ui.btnImport.addEventListener("click", () => void this.importProject());
    this.ui.btnSave.addEventListener("click", () => void this.saveProject());
    this.ui.btnSaveAs.addEventListener("click", () => void this.saveAsProject());
    this.ui.btnExport.addEventListener("click", () => this.openExportDialog());
    this.ui.btnTemplates.addEventListener("click", () => this.openTemplatesDialog());
    this.ui.btnUndo.addEventListener("click", () => this.undo());
    this.ui.btnRedo.addEventListener("click", () => this.redo());
    this.ui.btnZoomIn.addEventListener("click", () => this.zoomIn());
    this.ui.btnZoomOut.addEventListener("click", () => this.zoomOut());
    this.ui.btnZoomReset.addEventListener("click", () => this.resetView());
    this.ui.btnAddText.addEventListener("click", () => this.addObjectAt("text", this.centerWorld()));
    this.ui.btnAddNote.addEventListener("click", () => this.addObjectAt("note", this.centerWorld()));
    this.ui.btnAddImage.addEventListener("click", () => this.addObjectAt("image", this.centerWorld()));
    this.ui.btnAddFile.addEventListener("click", () => this.addObjectAt("file", this.centerWorld()));
    this.ui.btnAddUrl.addEventListener("click", () => this.addObjectAt("url", this.centerWorld()));
    this.ui.btnAddTest.addEventListener("click", () => this.addObjectAt("test-object", this.centerWorld()));
    this.ui.btnAddShapeRectangle.addEventListener("click", () => this.addShapeAt("rectangle", this.centerWorld()));
    this.ui.btnAddShapeRoundedRectangle.addEventListener("click", () => this.addShapeAt("rounded-rectangle", this.centerWorld()));
    this.ui.btnAddShapeEllipse.addEventListener("click", () => this.addShapeAt("ellipse", this.centerWorld()));
    this.ui.btnAddShapeDiamond.addEventListener("click", () => this.addShapeAt("diamond", this.centerWorld()));
    this.ui.btnAddShapeTriangle.addEventListener("click", () => this.addShapeAt("triangle", this.centerWorld()));
    this.ui.btnAddShapeLine.addEventListener("click", () => this.addShapeAt("line", this.centerWorld()));
    this.ui.btnAddShapeArrow.addEventListener("click", () => this.addShapeAt("arrow", this.centerWorld()));
    this.ui.btnAddTable.addEventListener("click", () => this.addTableAt(this.centerWorld()));
    this.ui.btnAddComparison.addEventListener("click", () => this.addTableAt(this.centerWorld(), true));
    this.ui.btnAddChart.addEventListener("click", () => this.addChartAt("bar", this.centerWorld()));

    // Export dialog format buttons + close / backdrop.
    this.ui.exportDialog.querySelectorAll("[data-export]").forEach((el) => {
      el.addEventListener("click", () => {
        const format = (el as HTMLElement).getAttribute("data-export") as AppExportFormat | null;
        if (format) this.exportFormat(format);
      });
    });
    this.ui.exportClose.addEventListener("click", () => this.closeExportDialog());
    this.ui.exportDialog.addEventListener("mousedown", (e) => {
      if (e.target === this.ui.exportDialog) this.closeExportDialog();
    });
    this.ui.exportRun.addEventListener("click", () => this.runConfiguredExport());
    this.ui.exportBack.addEventListener("click", () => {
      this.pendingExportFormat = null;
      this.ui.showExportFormats();
    });
    this.ui.onExportConfigChange = () => this.updateExportSummary();

    // Templates dialog.
    this.ui.templatesClose.addEventListener("click", () => this.closeTemplatesDialog());
    this.ui.templatesDialog.addEventListener("mousedown", (e) => {
      if (e.target === this.ui.templatesDialog) this.closeTemplatesDialog();
    });

    // Project library dialog.
    this.ui.btnProjects.addEventListener("click", () => void this.openProjectsDialog());
    this.ui.projectsClose.addEventListener("click", () => this.closeProjectsDialog());
    this.ui.projectsDialog.addEventListener("mousedown", (e) => {
      if (e.target === this.ui.projectsDialog) this.closeProjectsDialog();
    });
    this.ui.projectsSearch.addEventListener("input", () => this.renderProjects());
    this.ui.projectsSort.addEventListener("change", () => this.renderProjects());
    this.ui.projectsFolder.addEventListener("change", () => this.renderProjects());
    this.ui.projectsNewFolder.addEventListener("click", () => void this.createLibraryFolder());
    this.ui.projectsList.addEventListener("click", (e) => this.onProjectsAction(e));
    this.ui.projectsList.addEventListener("change", (e) => this.onProjectsAction(e));

    // Version history dialog.
    this.ui.btnVersions.addEventListener("click", () => void this.openVersionsDialog());
    this.ui.versionsClose.addEventListener("click", () => this.closeVersionsDialog());
    this.ui.versionsDialog.addEventListener("mousedown", (e) => {
      if (e.target === this.ui.versionsDialog) this.closeVersionsDialog();
    });
    this.ui.versionsCapture.addEventListener("click", () => void this.captureVersionSnapshot("Manual snapshot"));
    this.ui.versionsList.addEventListener("click", (e) => this.handleVersionsAction(e));

    // Tool panel toggle (hamburger)
    this.ui.btnMenu.addEventListener("click", () => this.setSidebar(!this.ui.isSidebarOpen()));
    this.ui.btnSidebarClose.addEventListener("click", () => this.setSidebar(false));

    // Settings dialog.
    this.ui.settingsClose.addEventListener("click", () => {
      this.ui.closeSettingsDialog();
      this.focusCanvas();
    });
    this.ui.settingsDialog.addEventListener("mousedown", (e) => {
      if (e.target === this.ui.settingsDialog) {
        this.ui.closeSettingsDialog();
        this.focusCanvas();
      }
    });
    this.ui.btnSettings.addEventListener("click", () => this.openSettingsDialog());
    this.bindReducedEffects();

    // Pen tool (both HUD button and sidebar button) — toggle ON/OFF
    const togglePen = () => this.togglePenTool();
    const enableSelect = () => {
      this.engine.setPenTool(false);
      this.ui.setTools(false);
      this.setSidebar(false);
      this.refreshUI();
    };
    this.ui.btnPen.addEventListener("click", togglePen);
    this.ui.btnPenSidebar.addEventListener("click", togglePen);
    this.ui.btnSelect.addEventListener("click", enableSelect);

    // Find modal sidebar button.
    this.searchUi.btn.addEventListener("click", () => this.openSearch());

    // Double-click on canvas edits text/note: simplest is handled through
    // selection + an explicit signal. We wire the canvas dblclick below.
    this.engine.canvas().addEventListener("dblclick", this.onDblClick);

    this.bindInspectorEvents();
    this.setupInspectorWindowControls();
  }

  /** Window controls for the Properties panel: minimize-to-chip + close. */
  private setupInspectorWindowControls(): void {
    const header = document.querySelector<HTMLElement>("#inspector .inspector-header");
    if (!header) return;
    header.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-inspector]");
      if (!btn) return;
      const act = btn.dataset["inspector"];
      if (act === "min") this.setInspectorMinimized(true);
      else if (act === "expand") this.setInspectorMinimized(false);
      else if (act === "close") {
        this.setInspectorMinimized(false);
        this.ui.setInspectorOpen(false);
        this.setStatus("Properties closed — selecting an object reopens them.");
      }
    });
    this.renderInspectorHeader(header);
  }

  private renderInspectorHeader(header: HTMLElement): void {
    if (this.inspectorMinimized) {
      header.innerHTML =
        `<button class="inspector-window-btn inspector-expand" data-inspector="expand" type="button" ` +
        `title="Expand properties" aria-label="Expand properties">&#8250;</button>`;
      return;
    }
    const tablet = document.documentElement.classList.contains("tb-active");
    header.innerHTML =
      `<span class="inspector-title">Properties</span>` +
      (tablet
        ? `<button id="tb-inspector-close" class="tb-inspector-close" data-inspector="close" type="button" aria-label="Close properties">Done</button>`
        : "") +
      `<button class="inspector-window-btn" data-inspector="min" type="button" title="Minimize properties" aria-label="Minimize properties">&#8249;</button>` +
      `<button class="inspector-window-btn" data-inspector="close" type="button" title="Close properties" aria-label="Close properties">&#10005;</button>`;
  }

  /** Toggle the Properties panel between full and collapsed (chip) mode. */
  setInspectorMinimized(on: boolean): void {
    this.inspectorMinimized = on;
    const inspector = document.getElementById("inspector");
    inspector?.classList.toggle("minimized", on);
    const header = document.querySelector<HTMLElement>("#inspector .inspector-header");
    if (header) this.renderInspectorHeader(header);
  }

  private bindInspectorEvents(): void {
    const body = this.ui.inspectorBodyEl;
    // Pen tool panel (shown while the pen tool is active): live tool style edits.
    const applyPenControl = (t: HTMLInputElement): void => {
      const key = t.dataset["pen"];
      if (!key) return;
      if (key === "size") this.engine.setPenSettings({ width: Number(t.value) });
      else if (key === "color") this.engine.setPenSettings({ color: t.value });
      else if (key === "opacity") this.engine.setPenSettings({ opacity: Number(t.value) });
      else if (key === "smoothing") this.engine.setPenSettings({ smoothing: Number(t.value) as 0 | 1 | 2 });
      else if (key === "stabilizer") {
        const v = t.value;
        this.engine.setPenSettings({ stabilizer: v === "mild" || v === "strong" ? v : "off" });
      } else if (key === "pressure") this.engine.setPenSettings({ pressure: t.checked });
      else if (key === "eraser-mode") this.engine.setPenSettings({ eraserMode: t.value === "stroke" ? "stroke" : "partial" });
      else if (key === "eraser-size") this.engine.setPenSettings({ eraserRadius: Number(t.value) });
      else if (key === "mode") {
        const m = t.value;
        if (m === "pen" || m === "eraser" || m === "lasso") this.engine.setPenToolMode(m);
      } else if (key === "eraser") this.engine.setPenEraser(t.checked);
      this.refreshUI();
    };
    body.addEventListener("input", (e) => {
      const t = e.target;
      if (t instanceof HTMLElement && t.dataset["pen"]) applyPenControl(t as HTMLInputElement);
    });
    body.addEventListener("change", (e) => {
      const t = e.target;
      if (t instanceof HTMLElement && t.dataset["pen"]) applyPenControl(t as HTMLInputElement);
    });
    // Ink selection panel: restyles commit as a single undoable step (only on
    // explicit change, never on intermediate keystrokes).
    body.addEventListener("change", (e) => {
      const t = e.target as HTMLElement;
      const key = t.dataset["ink"];
      if (!key) return;
      const input = t as HTMLInputElement;
      if (key === "color") this.engine.setInkStyle({ color: input.value });
      else if (key === "width") {
        const w = Number(input.value);
        if (Number.isFinite(w) && w > 0) this.engine.setInkStyle({ width: w });
      } else if (key === "opacity") {
        const o = Number(input.value);
        if (Number.isFinite(o) && o >= 0.05 && o <= 1) this.engine.setInkStyle({ opacity: o });
      }
      this.refreshUI();
    });
    // Committed object properties are applied only on explicit commit (Enter,
    // blur, a checkbox/color change) — never on intermediate keystrokes — so
    // typing can never corrupt or partially commit an object. The pen pane is
    // the deliberate exception above (live tool-style edits are safe).
    body.addEventListener("change", (e) => {
      const t = e.target as HTMLElement;
      if (t.dataset.prop) {
        this.commitInspectorProp(t.dataset.prop, t as HTMLInputElement | HTMLTextAreaElement);
      }
    });
    body.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
      if (!btn) return;
      const action = btn.dataset.action;
      const ids = this.selection.get();
      const obj = ids.length === 1 ? this.project.getObject(ids[0]) : undefined;
      if (action === "open") void this.openObject(obj);
      else if (action === "relink" && obj) void this.relinkObject(obj);
      else if (action === "duplicate") this.duplicateSelection();
      else if (action === "delete") this.deleteSelection();
      else if (action === "edit" && obj) {
        if (obj.type === "text" || obj.type === "note") this.editTextObject(obj);
        else if (obj.type === "table" || obj.type === "chart") this.editDataObject(obj);
      }
    });
  }

  private commitInspectorProp(key: string, el: HTMLInputElement | HTMLTextAreaElement): void {
    const ids = this.selection.get();
    if (ids.length !== 1) return;
    const obj = this.project.getObject(ids[0]);
    // A locked object blocks normal property edits, but the lock control itself
    // must always be allowed to toggle so the user can unlock it again.
    if (!obj || (obj.locked && key !== "locked")) return;
    if (key === "metadata-tags") {
      const tags = String(el.value)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const current = objectTags(obj);
      if (!sameTags(current, tags)) {
        this.commands.execute(
          setPropsCommand(this.project, [
            { id: obj.id, key: "metadata", before: { ...obj.metadata }, after: { ...obj.metadata, tags } },
          ])
        );
      }
      this.refreshUI();
      return;
    }
    // Pen stroke width edit: scale any per-vertex (pressure-sensitive) widths
    // by the same ratio so the whole stroke thickens/thins consistently, not
    // just the width-less fallback segments.
    if (key === "strokeWidth" && obj.type === "pen") {
      const after = Number(el.value);
      const before = obj.strokeWidth;
      if (!(after > 0) || after === before) return;
      const points = obj.points;
      const changes: PropChange[] = [{ id: obj.id, key: "strokeWidth", before, after }];
      if (points.some((p) => p.width !== undefined)) {
        const ratio = after / before;
        const scaled = points.map((p) => (p.width === undefined ? p : { ...p, width: p.width * ratio }));
        changes.push({ id: obj.id, key: "points", before: points, after: scaled });
      }
      this.commands.execute(setPropsCommand(this.project, changes));
      this.refreshUI();
      return;
    }
    const current = (obj as unknown as Record<string, unknown>)[key];
    let next: unknown;
    if (key === "locked" || key === "comparison" || key === "bold" || key === "italic") {
      next = (el as HTMLInputElement).checked;
    } else if (key === "chart-kind") {
      const kind = el.value;
      if (kind !== "bar" && kind !== "line" && kind !== "pie") return;
      if ((obj as Extract<CanvasObject, { type: "chart" }>).kind === kind) return;
      this.commands.execute(
        setPropsCommand(this.project, [{ id: obj.id, key: "kind", before: (obj as Extract<CanvasObject, { type: "chart" }>).kind, after: kind }])
      );
      this.refreshUI();
      return;
    } else if (key === "x" || key === "y" || key === "width" || key === "height" || key === "zIndex" || key === "strokeWidth" || key === "fontSize") {
      // Reject empty/NaN input a commit would otherwise turn into 0 — a blank
      // or bogus partial value must never corrupt the object's geometry.
      if (el.value.trim() === "" || !Number.isFinite(Number(el.value))) return;
      next = Number(el.value);
    } else if (key === "rotation") {
      if (el.value.trim() === "" || !Number.isFinite(Number(el.value))) return;
      next = Number(el.value);
    } else {
      next = el.value;
    }
    if (next === current) return;
    if (key === "width" || key === "height") {
      const value = Number(el.value);
      const rect = { id: obj.id, x: obj.x, y: obj.y, width: obj.width, height: obj.height };
      if (key === "width") rect.width = Math.max(4, value);
      else rect.height = Math.max(4, value);
      this.commands.execute(
        resizeObjectsCommand(this.project, [{ id: obj.id, x: obj.x, y: obj.y, width: obj.width, height: obj.height }], [rect])
      );
      this.refreshUI();
      return;
    }
    this.commands.execute(setPropsCommand(this.project, [{ id: obj.id, key, before: current, after: next }]));
    this.refreshUI();
  }

  private onDblClick = (e: MouseEvent): void => {
    const rect = this.engine.canvas().getBoundingClientRect();
    const screen: Point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const hit = this.engine.hitTest(screen);
    if (hit) {
      this.selection.setIds([hit]);
      const obj = this.project.getObject(hit);
      if (!obj) return;
      if (obj.type === "text" || obj.type === "note") {
        this.editSelectedText();
      } else if (obj.type === "table") {
        this.editTableCell(obj, screen);
      } else if (obj.type === "chart") {
        this.editDataObject(obj);
      } else if (obj.type === "file" || obj.type === "url") {
        void this.openObject(obj);
      }
    }
  };

  private centerWorld(): Point {
    const f = this.engine.getFrame();
    return screenToWorld({ x: f.originWidth / 2, y: f.originHeight / 2 }, f);
  }

  private setStatus(text: string): void {
    this.ui.setStatus(text);
  }
}

function screenPoint(worldX: number, worldY: number, frame: { cameraX: number; cameraY: number; zoom: number }): Point {
  return { x: (worldX - frame.cameraX) * frame.zoom, y: (worldY - frame.cameraY) * frame.zoom };
}

function firstLine(text: string): string {
  const line = String(text || "").split("\n")[0] ?? "";
  return line.length > 60 ? line.slice(0, 60) + "…" : line;
}

/** Build a searchable index entry for one canvas object. */
function objectToSearchItem(obj: CanvasObject, assetName: Map<string, string>): SearchableItem {
  let label = "";
  let text = "";
  switch (obj.type) {
    case "text":
      label = firstLine(obj.text);
      text = obj.text;
      break;
    case "note":
      label = firstLine(obj.text) || obj.title;
      text = `${obj.title} ${obj.text}`;
      break;
    case "shape":
      label = shapeLabel(obj.kind);
      text = shapeLabel(obj.kind);
      break;
    case "frame":
      label = obj.name || "Frame";
      break;
    case "group":
      label = obj.name || "Group";
      text = `${obj.memberIds.length} members`;
      break;
    case "url":
      label = obj.title || obj.url;
      text = obj.url;
      break;
    case "image":
    case "file":
      label = assetName.get(obj.assetId) ?? obj.type;
      text = label;
      break;
    default:
      label = obj.type;
  }
  return {
    id: obj.id,
    kind: "object",
    label,
    text,
    tags: objectTags(obj),
    typeLabel: obj.type === "shape" ? "shape" : obj.type,
    scoreBoost: obj.type === "note" || obj.type === "text" ? 1 : 0,
  };
}

/** Indefinite article for status messages that read naturally. */
function outlineFor(typeLabel: string): string {
  return /^[aeiou]/i.test(typeLabel) ? `an ${typeLabel}` : `a ${typeLabel}`;
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return trimmed;
  return "https://" + trimmed;
}

function round(v: number): string {
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** Turn a parsed project file into the in-memory document model. */
function fileToDocument(file: ReturnType<typeof deserialize>): ProjectDocument {
  return {
    meta: file.project,
    viewport: file.viewport,
    objects: file.objects,
    assets: file.assets,
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

export type { AssetMeta };

export type AppExportFormat = "spatia-folder" | "spatia-json" | "png" | "jpeg" | "pdf" | "md";

function isContainedBy(obj: CanvasObject, bounds: Rect): boolean {
  return obj.x >= bounds.x && obj.y >= bounds.y &&
    obj.x + obj.width <= bounds.x + bounds.width &&
    obj.y + obj.height <= bounds.y + bounds.height;
}
