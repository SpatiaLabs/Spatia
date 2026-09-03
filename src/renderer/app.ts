import { createNewDocument, ProjectStore, serialize } from "./project/projectStore.js";
import type { ProjectDocument } from "../shared/types/project.js";
import type { CanvasObject, ObjectKind, AssetMeta } from "../shared/types/object.js";
import { deserialize, ProjectFormatError } from "../shared/project/serialize.js";
import { ViewportStore } from "./state/viewportStore.js";
import { SelectionStore } from "./state/selectionStore.js";
import { CommandManager } from "./command/commandManager.js";
import { CanvasEngine } from "./canvas/engine.js";
import { AppUI } from "./ui/appUI.js";
import { AssetStore } from "./assets/assetStore.js";
import { showContextMenu, hideContextMenu, type ContextMenuItem } from "./ui/contextMenu.js";
import { openTextEditor, closeTextEditor, isEditingText } from "./ui/textEditor.js";
import { Minimap } from "./ui/minimap.js";
import type { Point } from "../shared/geometry/viewport.js";
import { screenToWorld } from "../shared/geometry/viewport.js";
import { addObjectCommand, resizeObjectsCommand, setPropsCommand, type PropChange } from "./command/commands.js";

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
  private assets = new AssetStore();
  private ui = new AppUI();
  private minimap: Minimap;

  private clipboard: CanvasObject[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.project.replace(createNewDocument());
    this.engine = new CanvasEngine(canvas, this.viewport, this.project, this.selection);
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

    this.ui.setWorldReader((screen) => ({ x: screen.x / this.engine.getFrame().zoom + this.engine.getFrame().cameraX, y: screen.y / this.engine.getFrame().zoom + this.engine.getFrame().cameraY }));

    this.bindUI();
    this.bindEvents();
    this.bindDragDrop(canvas);
    this.refreshProjectRefs();
    this.ui.setTools(false);
    this.ui.onRecentPick = (filePath) => void this.openProjectPath(filePath);
    void this.refreshRecent();
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

  start(): void {
    this.engine.attach();
    this.refreshUI();
    this.viewport.changed.emit(this.viewport.get());
    this.ui.setStatus("Ready.");
  }

  // -------- Project operations --------

  async newProject(): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    this.applyDocument(createNewDocument());
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
      const doc: ProjectDocument = {
        meta: file.project,
        viewport: file.viewport,
        objects: file.objects,
        assets: file.assets,
      };
      this.applyDocument(doc);
      void this.refreshRecent();
      this.setStatus(`Opened ${file.project.name}.`);
    } catch (err) {
      const msg = err instanceof ProjectFormatError ? err.message : "Failed to load project.";
      this.setStatus(msg);
    }
  }

  async saveProject(): Promise<void> {
    const json = this.serialize();
    const result = await window.spatia.saveProject(json);
    if (result.canceled) {
      this.setStatus("Save canceled.");
      return;
    }
    this.commands.markSaved();
    this.refreshUI();
    this.setStatus(`Saved to ${result.filePath}.`);
  }

  async saveAsProject(): Promise<void> {
    const suggestion = `${this.project.getMeta().name}.spatia.json`;
    const json = this.serialize();
    const result = await window.spatia.saveAsProject(json, suggestion);
    if (result.canceled) {
      this.setStatus("Save As canceled.");
      return;
    }
    this.commands.markSaved();
    this.refreshUI();
    void this.refreshRecent();
    this.setStatus(`Saved project as ${result.filePath}.`);
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

  async importProject(): Promise<void> {
    const result = await window.spatia.importProject();
    if (result.canceled || result.contents === null) {
      this.setStatus("Import canceled.");
      return;
    }
    try {
      const file = deserialize(result.contents);
      const doc: ProjectDocument = {
        meta: file.project,
        viewport: file.viewport,
        objects: file.objects,
        assets: file.assets,
      };
      this.applyDocument(doc);
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
      const doc: ProjectDocument = {
        meta: file.project,
        viewport: file.viewport,
        objects: file.objects,
        assets: file.assets,
      };
      this.applyDocument(doc);
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
    if (kind === "url") {
      this.addUrlAt(worldCenter);
      return;
    }
    const id = this.engine.addObjectAt(kind, worldCenter);
    if (id) this.selection.setIds([id]);
    this.refreshUI();
    this.setStatus(`Added ${kindLabel(kind)}.`);
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
    this.setStatus("Adding text — start typing.");
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
    this.setStatus(`Added link "${title || trimmed}".`);
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
    this.setStatus(`Added "${asset.name}".`);
  }

  // -------- Selection / clipboard / z-order --------

  private copySelection(): void {
    const objects = this.project.getObjects().filter((o) => this.selection.has(o.id));
    if (objects.length === 0) return;
    this.clipboard = objects.map((o) => structuredClone(o) as CanvasObject);
    this.setStatus(`Copied ${objects.length} object${objects.length > 1 ? "s" : ""}.`);
  }

  private pasteClipboard(): void {
    if (this.clipboard.length === 0) {
      this.setStatus("Clipboard is empty.");
      return;
    }
    const center = screenToWorld({ x: this.engine.getFrame().originWidth / 2, y: this.engine.getFrame().originHeight / 2 }, this.engine.getFrame());
    const pasted: string[] = [];
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
          pasted.push(c.id);
        }
      },
      undo() {
        for (const c of clones) self.project.removeObjects([c.id]);
      },
    });
    void center;
    this.selection.setIds(pasted);
    this.refreshUI();
  }

  private deleteSelection(): void {
    if (this.selection.size === 0) return;
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

    openTextEditor({
      left: tl.x,
      top: tl.y,
      width: w,
      height: h,
      fontSize,
      value: obj.text,
      multiline: true,
      onCommit: (text) => {
        if (text === obj.text) {
          this.refreshUI();
          return;
        }
        const change: PropChange = { id: obj.id, key: "text", before: obj.text, after: text };
        this.commands.execute(setPropsCommand(this.project, [change]));
        this.refreshUI();
      },
    });
  }

  // -------- Context menu --------

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
      items.push({ separatorBefore: true, label: "Duplicate", shortcut: "Ctrl+D", enabled: canEdit, action: () => this.duplicateSelection() });
      items.push({ label: "Delete", shortcut: "Del", enabled: canEdit, action: () => this.deleteSelection() });
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
    items.push({ label: "Add frame", action: () => this.addFrameAt(world) });
    items.push({ separatorBefore: true, label: "Paste here", enabled: this.clipboard.length > 0, action: () => this.pasteClipboard() });

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

  private addFrameAt(world: Point): void {
    const id = this.engine.createFrame(world);
    if (id) {
      this.selection.setIds([id]);
      this.refreshUI();
      this.setStatus("Added frame.");
    }
  }

  private duplicateSelection(): void {
    if (this.selection.size === 0) return;
    this.engine.duplicateSelection();
    this.refreshUI();
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

  // -------- Internals --------

  private serialize(): string {
    const m = this.project.getMeta();
    return serialize(
      { ...this.project.get().viewport },
      this.project.getObjects(),
      { id: m.id, name: m.name, createdAt: m.createdAt, updatedAt: m.updatedAt },
      this.project.getAssets()
    );
  }

  private applyDocument(doc: ProjectDocument): void {
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

  private confirmDiscard(): Promise<boolean> {
    if (!this.commands.isDirty()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const ok = window.confirm("You have unsaved changes in the current project. Continue without saving?");
      resolve(ok);
    });
  }

  private bindEvents(): void {
    this.commands.changed.subscribe(() => this.refreshUI());
    this.project.changed.subscribe(() => this.refreshUI());
    this.project.replaced.subscribe(() => this.refreshUI());
    this.viewport.changed.subscribe((vp) => {
      this.ui.setZoom(vp.zoom);
      this.minimap?.update();
    });
    this.selection.changed.subscribe(() => this.refreshUI());
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("paste", this.onPaste);
    // A normal workspace click dismisses the sidebar. The sidebar is a sibling
    // of the canvas, so pointer events inside it never reach this listener.
    this.engine.canvas().addEventListener("pointerdown", () => {
      if (this.ui.isSidebarOpen()) this.ui.setSidebarOpen(false);
    });
  }

  /** Handle OS pasted files/text (images, files); internal objects use Ctrl+V. */
  private onPaste = (e: ClipboardEvent): void => {
    if (isEditingText()) return;
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

  /** Build the single-object inspector DOM from the object reference. */
  private inspectorFor(obj: CanvasObject): string {
    const typeLabel = obj.type.charAt(0).toUpperCase() + obj.type.slice(1);
    const numField = (label: string, key: string, value: number, step = 1): string =>
      `<div class="inspector-row"><span class="inspector-label">${label}</span>` +
      `<input class="inspector-input" data-prop="${key}" type="number" step="${step}" value="${round(value)}"></div>`;
    const rows: string[] = [
      `<div class="inspector-row"><span class="inspector-label">Type</span><span>${typeLabel}</span></div>`,
    ];
    if (obj.type === "url") {
      rows.push(
        `<div class="inspector-row"><span class="inspector-label">Title</span>` +
          `<input class="inspector-input" data-prop="title" value="${escapeAttr((obj as { title: string }).title)}"></div>`,
        `<div class="inspector-row"><span class="inspector-label">URL</span>` +
          `<input class="inspector-input" data-prop="url" value="${escapeAttr((obj as { url: string }).url)}"></div>`
      );
    } else if (obj.type === "text") {
      rows.push(
        `<div class="inspector-row"><span class="inspector-label">Text</span>` +
          `<textarea class="inspector-input" data-prop="text" rows="3">${escapeHtml((obj as { text: string }).text)}</textarea></div>`
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
    if (isEditingText()) {
      // Let the text editor handle keys (except shortcuts we intentionally pass).
      return;
    }
    // Let real editable fields (e.g. the Link/URL input dialog or inspector
    // inputs) handle typing, Backspace, Ctrl+A/C/C/V and cursor movement.
    // Intercepting these here would block paste/edit in those fields.
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

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
    if (e.key === "Escape") {
      hideContextMenu();
      this.selection.clear();
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
    this.ui.btnExport.addEventListener("click", () => void this.exportProject());
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

    // Tool panel toggle (hamburger)
    this.ui.btnMenu.addEventListener("click", () => this.ui.toggleSidebar());

    // Pen tool (both HUD button and sidebar button) — toggle ON/OFF
    const togglePen = () => {
      const on = !this.engine.isPenTool();
      this.engine.setPenTool(on);
      this.ui.setTools(on);
      if (on) this.selection.setIds([]);
    };
    const enableSelect = () => {
      this.engine.setPenTool(false);
      this.ui.setTools(false);
      this.ui.setSidebarOpen(false);
    };
    this.ui.btnPen.addEventListener("click", togglePen);
    this.ui.btnPenSidebar.addEventListener("click", togglePen);
    this.ui.btnSelect.addEventListener("click", enableSelect);

    // Double-click on canvas edits text/note: simplest is handled through
    // selection + an explicit signal. We wire the canvas dblclick below.
    this.engine.canvas().addEventListener("dblclick", this.onDblClick);

    this.bindInspectorEvents();
  }

  private bindInspectorEvents(): void {
    const body = this.ui.inspectorBodyEl;
    body.addEventListener("input", (e) => {
      const t = e.target as HTMLElement;
      if (!t.dataset.prop) return;
      this.commitInspectorProp(t.dataset.prop, t as HTMLInputElement | HTMLTextAreaElement);
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
    const current = (obj as unknown as Record<string, unknown>)[key];
    let next: unknown;
    if (key === "locked") {
      next = (el as HTMLInputElement).checked;
    } else if (key === "x" || key === "y" || key === "width" || key === "height" || key === "zIndex") {
      next = Number(el.value);
    } else if (key === "rotation") {
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

function kindLabel(kind: ObjectKind): string {
  switch (kind) {
    case "text":
      return "text";
    case "note":
      return "note";
    case "image":
      return "image";
    case "file":
      return "file";
    case "url":
      return "link";
    default:
      return "object";
  }
}

/** Normalize a user-entered link to a navigable URL for external opening. */
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

export type { AssetMeta };
