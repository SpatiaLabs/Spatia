import type { App } from "../app.js";
import type { CanvasObject, ShapeKind } from "../../shared/types/object.js";
import type { Point, ViewportFrame } from "../../shared/geometry/viewport.js";
import { viewportForRect } from "../../shared/geometry/viewport.js";
import { SHAPE_KINDS, shapeLabel } from "../../shared/geometry/shapes.js";
import type { Command } from "../command/commandManager.js";
import { setPropsCommand } from "../command/commands.js";
import { isEditingText } from "./textEditor.js";

const FLOAT_POS_KEY = "spatia.tbFloatPos";
type FloatPos = { left: number; top: number };

function loadFloatPos(): Record<string, FloatPos> {
  try {
    const raw = JSON.parse(localStorage.getItem(FLOAT_POS_KEY) || "null");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * Dedicated iPad / tablet interface (web context only).
 *
 * Turns the canvas into the primary surface:
 *  - a compact top command bar (project, save, undo/redo, search, …),
 *  - a floating bottom tool dock (select / hand / pen / note / shapes / add),
 *  - a contextual action bar that appears above the dock on selection,
 *  - inspector & asset panels and every dialog re-skinned as iPad-style
 *    right-side slide-over sheets (reusing all existing App logic),
 *  - one-finger select/move (hand tool: one-finger pan), two-finger pan/pinch
 *    (the same gesture model the phone layer uses), larger selection handles
 *    + a rotation knob, action/color/rotate popovers and a "More" menu.
 *
 * Desktop (Electron, file://) is untouched: this module only activates when the
 * renderer runs in a web context on a tablet device (or when forced for tests).
 * Nothing here mutates document state except through undoable commands.
 */
export class TabletUI {
  private readonly app: AppLike;
  private tool: "select" | "hand" | "pen" = "select";

  private pointers = new Map<number, { x: number; y: number }>();
  private touchPan: { pointerId: number; last: { x: number; y: number } } | null = null;
  private multi = false;
  private lastDist: number | null = null;
  private lastMid: { x: number; y: number } | null = null;

  // DOM
  private root!: HTMLElement;
  private topTitle!: HTMLElement;
  private savedDot!: HTMLElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private dock!: HTMLElement;
  private context!: HTMLElement;
  private contextBody!: HTMLElement;
  private actionsPopup!: HTMLElement;
  private shapesPopup!: HTMLElement;
  private colorPopup!: HTMLElement;
  private rotatePopup!: HTMLElement;
  private addSheet!: HTMLElement;
  private morePanel!: HTMLElement;
  private moreBody!: HTMLElement;
  private scrim!: HTMLElement;
  private zoomLabel!: HTMLElement;
  private pentools!: HTMLElement;
  private ptEraserBtn!: HTMLButtonElement;
  private ptDot!: HTMLElement;
  private ptSizeVal!: HTMLElement;
  private ptColorChip!: HTMLElement;
  private ptUndoBtn!: HTMLButtonElement;
  private ptRedoBtn!: HTMLButtonElement;

  constructor(app: App) {
    // App fields are TypeScript-private but exist at runtime; the layers that
    // construct the shell read them duck-typed (same pattern as web-mobile.js).
    this.app = app as unknown as AppLike;
  }

  attach(): void {
    const host = document.getElementById("app");
    if (!host) return;
    document.documentElement.classList.add("tb-active");
    document.documentElement.classList.remove("mb-active");
    this.app.engine.setCoarseHandles(true);

    this.buildShell(host);
    this.captureRefs();
    this.patchStatus();
    this.app.setInspectorMinimized(false);
    this.wire();
    this.restoreFloatPositions();

    this.app.selection.changed.subscribe(() => this.refresh());
    this.app.commands.changed.subscribe(() => this.refresh());
    this.app.project.changed.subscribe(() => this.refresh());
    this.app.viewport.changed.subscribe(() => this.updateZoom());
    this.refresh();
  }

  // ------------------------------------------------------------------ shell

  private buildShell(host: HTMLElement): void {
    host.insertAdjacentHTML("beforeend", SHELL_HTML);
    // The top bar must be the first flex item so #app stacks it above the canvas.
    const app = document.getElementById("app");
    if (app) {
      const top = app.querySelector("#tb-topbar");
      if (top) app.insertBefore(top, app.firstChild);
    }
  }

  private captureRefs(): void {
    const q = <T extends HTMLElement>(id: string): T => {
      const el = document.getElementById(id);
      if (!el) throw new Error(`Tablet UI root element #${id} missing.`);
      return el as T;
    };
    this.root = q("tb-ui");
    this.topTitle = q("tb-title-name");
    this.savedDot = q("tb-saved-dot");
    this.undoBtn = q("tb-undo");
    this.redoBtn = q("tb-redo");
    this.dock = q("tb-dock");
    this.context = q("tb-context");
    this.contextBody = q("tb-context-body");
    this.actionsPopup = q("tb-actions");
    this.shapesPopup = q("tb-shapes");
    this.colorPopup = q("tb-color");
    this.rotatePopup = q("tb-rotate");
    this.addSheet = q("tb-addsheet");
    this.morePanel = q("tb-more");
    this.moreBody = q("tb-more-body");
    this.scrim = q("tb-scrim");
    this.zoomLabel = q("tb-zoom-label");
    this.pentools = q("tb-pentools");
    this.ptEraserBtn = q("tb-pt-eraser");
    this.ptDot = q("tb-pt-dot");
    this.ptSizeVal = q("tb-pt-sizeval");
    this.ptColorChip = q("tb-pt-colorchip");
    this.ptUndoBtn = q("tb-pt-undo");
    this.ptRedoBtn = q("tb-pt-redo");
  }

  private patchStatus(): void {
    const ui = this.app.ui;
    const orig = ui.setStatus.bind(ui);
    ui.setStatus = (text: string): void => {
      orig(text);
      if (text && text !== "Ready.") {
        try {
          ui.notify(String(text));
        } catch {
          /* toast is best-effort */
        }
      }
    };
  }

  // ---------------------------------------------------------------- actions

  invokeApp(name: string, ...args: unknown[]): unknown {
    const fn = (this.app as unknown as Record<string, unknown>)[name];
    if (typeof fn !== "function") return undefined;
    return (fn as (...a: unknown[]) => unknown).apply(this.app, args);
  }

  private centerWorld(): Point {
    const c = this.invokeApp("centerWorld");
    return c && typeof c === "object" ? (c as Point) : { x: 0, y: 0 };
  }

  private addAt(kind: AddKind): void {
    const center = this.centerWorld();
    if (kind === "frame") {
      this.invokeApp("addFrameAt", center);
    } else {
      this.invokeApp("addObjectAt", kind, center);
    }
  }

  fitOverview(): void {
    const objs = this.app.project.getObjects();
    const rects: { x: number; y: number; width: number; height: number }[] = [];
    for (const o of objs) {
      if (o.type === "connection" || o.type === "pen") continue;
      rects.push({ x: o.x, y: o.y, width: o.width, height: o.height });
    }
    if (rects.length === 0) {
      this.app.engine.resetView();
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const r of rects) {
      minX = Math.min(minX, r.x);
      minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.width);
      maxY = Math.max(maxY, r.y + r.height);
    }
    const next = viewportForRect(
      { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
      this.app.engine.getFrame()
    );
    if (next) this.app.viewport.set(next);
    else this.app.engine.resetView();
  }

  private applyColor(hex: string): void {
    const ids = this.app.selection.get();
    const changes: { id: string; key: string; before: unknown; after: unknown }[] = [];
    for (const id of ids) {
      const o = this.app.project.getObject(id);
      if (!o || o.locked) continue;
      if (o.type === "shape") {
        changes.push({ id, key: "fill", before: o.fill, after: hex });
      } else if (o.type === "note" || o.type === "frame" || o.type === "connection" || o.type === "pen") {
        changes.push({ id, key: "color", before: o.color, after: hex });
      }
    }
    if (changes.length > 0) {
      this.app.commands.execute(setPropsCommand(this.app.project as never, changes));
      this.refresh();
    }
  }

  setTool(tool: "select" | "hand" | "pen"): void {
    this.tool = tool;
    this.app.engine.setPenTool(tool === "pen");
    if (tool === "pen") {
      this.app.selection.setIds([]);
    }
    this.refreshTools();
  }

  // --------------------------------------------------------------- refresh

  private refresh(): void {
    if (!this.root || !this.root.isConnected) return;
    this.refreshTools();
    this.updateTopBar();
    this.renderContext();
    this.updateZoom();
  }

  private refreshTools(): void {
    for (const el of Array.from(this.dock.querySelectorAll<HTMLElement>("[data-tool]"))) {
      el.classList.toggle("tb-active", el.dataset["tool"] === this.tool);
    }
    this.renderPentools();
  }

  /** Floating pen toolbar: live pen style, eraser toggle, undo/redo state. */
  private renderPentools(): void {
    if (!this.pentools) return;
    if (this.tool !== "pen") {
      this.pentools.hidden = true;
      this.pentools.classList.remove("tb-pt-collapsed");
      return;
    }
    this.pentools.hidden = false;
    const style = this.app.engine.getPenStyle();
    const eraser = this.app.engine.isPenEraser();
    this.ptEraserBtn.classList.toggle("tb-active", eraser);
    this.ptEraserBtn.setAttribute("aria-pressed", String(eraser));
    const px = Math.min(26, Math.max(3, style.size * 2.4));
    this.ptDot.style.width = `${px}px`;
    this.ptDot.style.height = `${px}px`;
    this.ptDot.style.background = style.color;
    this.ptColorChip.style.background = style.color;
    this.ptSizeVal.textContent = String(Math.round(style.size));
    this.ptUndoBtn.disabled = !this.app.commands.canUndo;
    this.ptRedoBtn.disabled = !this.app.commands.canRedo;
  }

  private updateTopBar(): void {
    const meta = this.app.project.getMeta();
    this.topTitle.textContent = meta.name?.trim() ? String(meta.name) : "Untitled";
    const dirty = this.app.commands.isDirty();
    this.savedDot.classList.toggle("tb-dirty", dirty);
    this.savedDot.setAttribute("aria-label", dirty ? "Unsaved changes" : "Saved");
    this.undoBtn.disabled = !this.app.commands.canUndo;
    this.redoBtn.disabled = !this.app.commands.canRedo;
  }

  /** Actions living in the "⋯" popover (secondary, selection-dependent). */
  private secondaryActions(): CtxDef[] {
    const s = this.selectionState();
    const out: CtxDef[] = [];
    const push = (def: CtxDef): void => {
      if (def.enabled(s, this.app)) out.push(def);
    };
    push(DEFS.focus);
    push(DEFS.isolate);
    push(DEFS.ungroup);
    push(DEFS.group);
    push(DEFS.connect);
    push(DEFS.rotate);
    push(DEFS.front);
    push(DEFS.back);
    return out;
  }

  private selectionState(): SelState {
    const ids = this.app.selection.get();
    const obj = ids.length === 1 ? this.app.project.getObject(ids[0]) : undefined;
    return { ids, n: ids.length, obj, single: ids.length === 1 };
  }

  private renderContext(): void {
    const s = this.selectionState();
    const n = s.n;
    this.context.hidden = n === 0;
    const btn = (def: CtxDef): string => {
      const enabled = def.enabled(s, this.app);
      const danger = def.danger ? " tb-danger" : "";
      return (
        `<button type="button" class="tb-ctx${danger}" data-ctx="${def.key}" data-actid="${def.key}"` +
        `${enabled ? "" : ' disabled="disabled"'}` +
        ` aria-label="${def.label}">` +
        `<span class="tb-ctx-icon">${ICONS[def.icon] ?? ""}</span>` +
        `<span class="tb-ctx-label">${def.label}</span></button>`
      );
    };
    const primary: CtxDef[] = [];
    const addIf = (def: CtxDef): void => {
      if (def.enabled(s, this.app)) primary.push(def);
    };
    if (s.single && s.obj && (s.obj.type === "text" || s.obj.type === "note") && !s.obj.locked) {
      addIf(DEFS.edit);
    } else if (s.single && s.obj && (s.obj.type === "url" || s.obj.type === "file")) {
      addIf(DEFS.open);
    }
    addIf(DEFS.color);
    addIf(DEFS.duplicate);
    if (s.n > 0) primary.push(DEFS.delete);

    if (n === 0) {
      this.contextBody.innerHTML = "";
      this.actionsPopup.hidden = true;
      return;
    }
    let html = primary.map(btn).join("");
    const secondary = this.secondaryActions();
    html +=
      `<button type="button" class="tb-ctx tb-more-ctx" data-pop="actions" aria-label="More actions" aria-haspopup="true">` +
      `<span class="tb-ctx-icon">${ICONS.more}</span><span class="tb-ctx-label">More</span></button>`;
    this.contextBody.innerHTML = html;
    this.renderActions(secondary);
  }

  private renderActions(defs: CtxDef[]): void {
    if (defs.length === 0) {
      this.actionsPopup.hidden = true;
      this.actionsPopup.innerHTML = "";
      return;
    }
    this.actionsPopup.innerHTML =
      '<div class="tb-pane-title">Actions</div>' +
      defs
        .map(
          (d) =>
            `<button type="button" class="tb-row" data-act="${d.key}"${d.enabled(this.selectionState(), this.app) ? "" : ' disabled="disabled"'}><span class="tb-row-icon">${ICONS[d.icon] ?? ""}</span><span>${d.label}</span></button>`
        )
        .join("");
  }

  private renderShapes(): void {
    this.shapesPopup.innerHTML = SHAPE_KINDS.map(
      (kind) =>
        `<button type="button" class="tb-shape" data-shape="${kind}" aria-label="Add ${shapeLabel(kind)}">` +
        `${ICONS["shape-" + kind] ?? ""}<span>${shapeLabel(kind)}</span></button>`
    ).join("");
  }

  private renderColor(): void {
    this.colorPopup.innerHTML = PALETTE.map(
      (hex) =>
        `<button type="button" class="tb-swatch" data-color="${hex}" aria-label="Use color ${hex}" style="--sw:${hex}"></button>`
    ).join("");
  }

  private renderRotate(): void {
    this.rotatePopup.innerHTML = ROTATES.map((deg) => {
      const label = deg === 0 ? "Reset" : `${deg}°`;
      return `<button type="button" class="tb-row" data-rot="${deg}"><span>${label}</span></button>`;
    }).join("") + '<div class="tb-pane-hint">…or drag the knob above the selection.</div>';
  }

  private renderMore(): void {
    this.moreBody.innerHTML = MORE_SECTIONS.map((section) => {
      let rows = "";
      for (const key of section.ids) {
        const def = MORE_ITEMS[key];
        if (!def) continue;
        if (def.visible && !def.visible(this.app)) continue;
        rows +=
          `<button type="button" class="tb-row" data-more="${key}"${def.enabled(this.app) ? "" : ' disabled="disabled"'}><span class="tb-row-icon">${ICONS[def.icon ?? ""] ?? ""}</span><span>${def.label}</span></button>`;
      }
      if (!rows) return "";
      return `<div class="tb-pane-title">${section.name}</div>${rows}`;
    }).join("");
  }

  private updateZoom(): void {
    const zoom = this.app.engine.getZoom();
    this.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  }

  // ----------------------------------------------------- popovers / sheets

  private openPane(el: HTMLElement): void {
    this.renderPopups(el);
    el.hidden = false;
    this.scrim.hidden = false;
  }

  openPop(key: string): void {
    this.closePops();
    const map: Record<string, HTMLElement> = {
      shapes: this.shapesPopup,
      color: this.colorPopup,
      rotate: this.rotatePopup,
      actions: this.actionsPopup,
      more: this.morePanel,
    };
    const el = map[key];
    if (!el) return;
    this.openPane(el);
  }

  private closePops(): void {
    for (const el of [this.actionsPopup, this.shapesPopup, this.colorPopup, this.rotatePopup, this.addSheet, this.morePanel]) {
      el.hidden = true;
    }
    this.scrim.hidden = true;
  }

  /** Render lazily so popovers always reflect the current state. */
  private renderPopups(el: HTMLElement): void {
    if (el === this.shapesPopup) this.renderShapes();
    else if (el === this.colorPopup) this.renderColor();
    else if (el === this.rotatePopup) this.renderRotate();
    else if (el === this.actionsPopup) this.renderActions(this.secondaryActions());
    else if (el === this.morePanel) this.renderMore();
  }

  private isDialogOpen(): boolean {
    return !!document.querySelector(".url-dialog.open");
  }

  private closeOpenDialog(): void {
    const map: Record<string, string> = {
      "url-dialog": "url-cancel",
      "plugins-dialog": "plugins-close",
      "export-dialog": "export-close",
      "templates-dialog": "templates-close",
      "projects-dialog": "projects-close",
      "versions-dialog": "versions-close",
      "share-dialog": "share-close",
    };
    const open = document.querySelector<HTMLElement>(".url-dialog.open");
    if (!open) return;
    const closeId = map[open.id];
    if (closeId) {
      const btn = document.getElementById(closeId);
      if (btn) {
        (btn as HTMLButtonElement).click();
        return;
      }
    }
    if (open.id === "search-dialog") {
      this.invokeApp("closeSearch");
    }
  }

  // ----------------------------------------------------------- events

  private wire(): void {
    this.root.addEventListener("click", this.onShellClick);
    this.root.addEventListener("pointerdown", this.onPanePointerDown);
    this.scrim.addEventListener("click", () => this.closePops());

    const canvas = this.app.engine.canvas();
    canvas.addEventListener("pointerdown", this.onCanvasDown, true);
    canvas.addEventListener("pointermove", this.onCanvasMove, true);
    canvas.addEventListener("pointerup", this.onCanvasUp, true);
    canvas.addEventListener("pointercancel", this.onCanvasUp, true);
    canvas.addEventListener("contextmenu", this.onCanvasContext, true);

    // The top bar is moved out of #tb-ui into the #app flex flow, so it needs
    // its own click listener to reach the shared shell click handler.
    const topbar = document.getElementById("tb-topbar");
    if (topbar) topbar.addEventListener("click", this.onShellClick);

    window.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("resize", this.onResize);

    // Tap the dimmed area around a re-skinned dialog to dismiss it.
    document.addEventListener("click", this.onDialogScrim, true);

    this.bindFloatToolbars();
  }

  /**
   * Make the floating toolbars (#tb-pentools, .tb-context) freely movable via a
   * small drag handle. While a toolbar has been repositioned it keeps its pixel
   * position (the centered CSS default is overridden by .tb-float-moved); the
   * position is clamped to the viewport and persisted across sessions.
   */
  private bindFloatToolbars(): void {
    const handles = Array.from(this.root.querySelectorAll<HTMLElement>("[data-tbfloat]"));
    for (const handle of handles) {
      handle.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        const el = handle.closest<HTMLElement>(".tb-float");
        if (!el) return;
        e.preventDefault();
        this.startFloatDrag(e, el, handle.dataset["tbfloat"]!);
      });
    }
  }

  private startFloatDrag(e: PointerEvent, el: HTMLElement, key: string): void {
    e.preventDefault();
    el.classList.add("tb-float-moved");
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const rect = el.getBoundingClientRect();
    const origLeft = rect.left;
    const origTop = rect.top;
    const apply = (x: number, y: number) => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const left = clamp(x, 8, window.innerWidth - w - 8);
      const top = clamp(y, 8, window.innerHeight - h - 8);
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    };
    apply(origLeft, origTop);
    const onMove = (ev: PointerEvent) => {
      apply(origLeft + (ev.clientX - startX), origTop + (ev.clientY - startY));
    };
    const onUp = () => {
      el.releasePointerCapture(e.pointerId);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      try {
        const pos = { left: parseFloat(el.style.left), top: parseFloat(el.style.top) };
        if (Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
          const store = loadFloatPos();
          store[key] = pos;
          localStorage.setItem(FLOAT_POS_KEY, JSON.stringify(store));
        }
      } catch { /* best-effort */ }
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  }

  private restoreFloatPositions(): void {
    let store: Record<string, { left: number; top: number }> | null = null;
    try {
      store = JSON.parse(localStorage.getItem(FLOAT_POS_KEY) || "null");
    } catch { /* */ }
    if (!store) return;
    for (const el of Array.from(this.root.querySelectorAll<HTMLElement>(".tb-float"))) {
      const h = el.querySelector<HTMLElement>("[data-tbfloat]");
      const key = h ? h.dataset["tbfloat"] : "";
      const saved = key ? store[key] : undefined;
      if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
        el.classList.add("tb-float-moved");
        const w = el.offsetWidth || 0;
        const hpx = el.offsetHeight || 0;
        el.style.left = `${clamp(saved.left, 8, window.innerWidth - w - 8)}px`;
        el.style.top = `${clamp(saved.top, 8, window.innerHeight - hpx - 8)}px`;
      }
    }
  }

  private onResize = (): void => {
    // Stage-manager style width changes never drop out of tablet mode when the
    // device itself is a tablet; no remount required. Keep live UI in sync.
    this.closePops();
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey) {
      const key = (e.key || "").toLowerCase();
      if (key === "s") {
        e.preventDefault();
        e.stopImmediatePropagation();
        void this.invokeApp("saveProject");
        return;
      }
      return;
    }
    if (e.key !== "Escape") return;
    if (isEditingText()) return;
    // Close sheets / popovers before the desktop shortcuts clear selection.
    if (this.isDialogOpen()) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.closeOpenDialog();
      return;
    }
    if (!this.scrim.hidden) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.closePops();
      return;
    }
  };

  private onDialogScrim = (e: MouseEvent): void => {
    const target = e.target as HTMLElement | null;
    if (!target || typeof target.classList !== "object") return;
    if (target.classList.contains("url-dialog") && target.classList.contains("open")) {
      this.closeOpenDialog();
    }
  };

  private onPanePointerDown = (e: PointerEvent): void => {
    // Panes sit above the canvas; a touch starting on a pane must never reach
    // the canvas gesture layer.
    e.stopPropagation();
  };

  private onShellClick = (e: MouseEvent): void => {
    const target = e.target as HTMLElement | null;
    if (!target || typeof target.closest !== "function") return;

    const top = target.closest<HTMLElement>("[data-tb]");
    if (top) {
      this.onTopAction(top.dataset["tb"] ?? "");
      return;
    }
    const pt = target.closest<HTMLElement>("[data-pt]");
    if (pt) {
      this.onPenAction(pt.dataset["pt"] ?? "");
      return;
    }
    const tool = target.closest<HTMLElement>("[data-tool]");
    if (tool) {
      const name = tool.dataset["tool"];
      if (name === "note") {
        this.closePops();
        this.addAt("note");
      } else if (name === "shape") {
        this.openPop("shapes");
      } else if (name === "media") {
        this.closePops();
        this.addSheet.hidden = false;
        this.scrim.hidden = false;
      } else if (name === "select" || name === "hand" || name === "pen") {
        this.closePops();
        this.setTool(name);
      }
      return;
    }
    const ctx = target.closest<HTMLElement>("[data-ctx]");
    if (ctx) {
      if (ctx.dataset["pop"]) {
        this.openPop("actions");
        return;
      }
      this.runCtx(ctx.dataset["ctx"] ?? "");
      return;
    }
    const act = target.closest<HTMLElement>("[data-act]");
    if (act) {
      this.runCtx(act.dataset["act"] ?? "");
      this.closePops();
      return;
    }
    const shape = target.closest<HTMLElement>("[data-shape]");
    if (shape) {
      const kind = shape.dataset["shape"];
      if (kind) {
        this.closePops();
        this.invokeApp("addShapeAt", kind as ShapeKind, this.centerWorld());
      }
      return;
    }
    const color = target.closest<HTMLElement>("[data-color]");
    if (color) {
      const hex = color.dataset["color"] ?? "";
      if (this.tool === "pen") {
        this.app.engine.setPenStyle({ color: hex });
        this.renderPentools();
      } else {
        this.applyColor(hex);
      }
      this.closePops();
      return;
    }
    const rot = target.closest<HTMLElement>("[data-rot]");
    if (rot) {
      const deg = Number(rot.dataset["rot"] ?? 0);
      this.app.engine.rotateSelection(deg);
      this.closePops();
      return;
    }
    const add = target.closest<HTMLElement>("[data-add]");
    if (add) {
      const kind = add.dataset["add"];
      if (kind) {
        this.closePops();
        this.addAt(kind as AddKind);
      }
      return;
    }
    const more = target.closest<HTMLElement>("[data-more]");
    if (more) {
      this.runMore(more.dataset["more"] ?? "");
      return;
    }
  };

  private onPenAction(action: string): void {
    switch (action) {
      case "eraser":
        this.app.engine.setPenEraser(!this.app.engine.isPenEraser());
        this.renderPentools();
        break;
      case "size-down":
        this.app.engine.setPenStyle({ size: this.app.engine.getPenStyle().size - 1 });
        this.renderPentools();
        break;
      case "size-up":
        this.app.engine.setPenStyle({ size: this.app.engine.getPenStyle().size + 1 });
        this.renderPentools();
        break;
      case "color":
        this.closePops();
        this.openPop("color");
        break;
      case "undo":
        this.invokeApp("undo");
        break;
      case "redo":
        this.invokeApp("redo");
        break;
      case "done":
        this.setTool("select");
        break;
    }
  }

  private onTopAction(action: string): void {
    if (action === "title") {
      this.closePops();
      void this.invokeApp("openProjectsDialog");
    } else if (action === "save") {
      void this.invokeApp("saveProject");
    } else if (action === "undo") {
      this.invokeApp("undo");
    } else if (action === "redo") {
      this.invokeApp("redo");
    } else if (action === "search") {
      this.closePops();
      this.invokeApp("openSearch");
    } else if (action === "more") {
      this.openPop("more");
    }
  }

  private runCtx(key: string): void {
    const def = DEFS[key];
    if (!def || !def.enabled(this.selectionState(), this.app)) return;
    def.run(this.app, this);
  }

  private runMore(key: string): void {
    const def = MORE_ITEMS[key];
    if (!def || !def.enabled(this.app)) return;
    this.closePops();
    def.run(this.app, this);
  }

  // ------------------------------------------------- gestures (two fingers)

  private onCanvasContext = (e: Event): void => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  private onCanvasDown = (e: PointerEvent): void => {
    if (e.pointerType === "pen" || e.pointerType === "stylus") {
      if (this.tool === "pen") this.pentools.classList.add("tb-pt-collapsed");
      return;
    }
    if (e.pointerType !== "touch") return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size >= 2) {
      this.multi = true;
      this.touchPan = null;
      this.lastDist = null;
      this.lastMid = null;
      // Settle any in-flight engine interaction (marquee / move / resize) with
      // a sentinel pointerup so the canvas never keeps a stale drag.
      this.app.engine.canvas().dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: -1 }));
      e.stopImmediatePropagation();
      return;
    }
    if (this.tool === "hand" || this.tool === "pen") {
      // One-finger pan in hand tool. In the pen tool a finger never draws on
      // tablets: it pans so touch gestures cannot produce accidental strokes
      // while the Apple Pencil is the drawing input.
      this.touchPan = { pointerId: e.pointerId, last: { x: e.clientX, y: e.clientY } };
      e.stopImmediatePropagation();
    }
  };

  private onCanvasMove = (e: PointerEvent): void => {
    if (this.touchPan && this.touchPan.pointerId === e.pointerId) {
      e.stopImmediatePropagation();
      this.app.engine.applyPan(e.clientX - this.touchPan.last.x, e.clientY - this.touchPan.last.y);
      this.touchPan.last = { x: e.clientX, y: e.clientY };
      return;
    }
    if (e.pointerType !== "touch" || !this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!this.multi || this.pointers.size < 2) return;
    e.stopImmediatePropagation();
    const keys = Array.from(this.pointers.keys());
    const a = this.pointers.get(keys[0]);
    const b = this.pointers.get(keys[1]);
    if (!a || !b) return;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    if (this.lastDist !== null && this.lastMid !== null) {
      const rect = this.app.engine.canvas().getBoundingClientRect();
      const zoom = dist / this.lastDist;
      this.app.engine.applyAnchoredZoom(zoom, { x: mid.x - rect.left, y: mid.y - rect.top });
      this.app.engine.applyPan(mid.x - this.lastMid.x, mid.y - this.lastMid.y);
    }
    this.lastDist = dist;
    this.lastMid = mid;
  };

  private onCanvasUp = (e: PointerEvent): void => {
    if (e.pointerType === "pen" || e.pointerType === "stylus") {
      if (this.tool === "pen") this.pentools.classList.remove("tb-pt-collapsed");
      return;
    }
    if (e.pointerType !== "touch") return;
    if (this.touchPan && this.touchPan.pointerId === e.pointerId) {
      this.pointers.delete(e.pointerId);
      this.touchPan = null;
      e.stopImmediatePropagation();
      return;
    }
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    if (this.multi) e.stopImmediatePropagation();
    if (this.pointers.size < 2) {
      this.multi = false;
      this.lastDist = null;
      this.lastMid = null;
    }
  };
}

// ---------------------------------------------------------------- types

type CallbackApp = AppLike;

type AddKind = "text" | "note" | "url" | "image" | "file" | "frame";

interface EmitterLike {
  subscribe(fn: () => void): () => void;
}

interface AppLike {
  engine: {
    canvas(): HTMLCanvasElement;
    getFrame(): ViewportFrame;
    getZoom(): number;
    applyPan(dx: number, dy: number): void;
    applyAnchoredZoom(factor: number, anchor: Point): void;
    zoomBy(factor: number): void;
    resetView(): void;
    setPenTool(on: boolean): void;
    isPenTool(): boolean;
    setPenStyle(style: { color?: string; size?: number }): void;
    getPenStyle(): { color: string; size: number };
    setPenEraser(on: boolean): void;
    isPenEraser(): boolean;
    setCoarseHandles(on: boolean): void;
    rotateSelection(deg: number): void;
  };
  project: {
    getObjects(): CanvasObject[];
    getObject(id: string): CanvasObject | undefined;
    getMeta(): { name?: string };
    changed: EmitterLike;
  };
  selection: {
    get(): string[];
    size: number;
    setIds(ids: readonly string[]): void;
    changed: EmitterLike;
  };
  commands: {
    canUndo: boolean;
    canRedo: boolean;
    isDirty(): boolean;
    execute(cmd: Command): void;
    changed: EmitterLike;
  };
  viewport: {
    set(state: { x: number; y: number; zoom: number }): void;
    changed: EmitterLike;
  };
  ui: {
    setStatus(text: string): void;
    notify(text: string): void;
    setInspectorOpen(open: boolean): void;
  };
  centerWorld(): Point;
  setInspectorMinimized(on: boolean): void;
  [key: string]: unknown;
}

interface SelState {
  ids: string[];
  n: number;
  obj: CanvasObject | undefined;
  single: boolean;
}

interface CtxDef {
  key: string;
  icon: string;
  label: string;
  danger?: boolean;
  enabled(s: SelState, app: CallbackApp): boolean;
  run(app: AppLike, ui: TabletUI): void;
}

// ---------------------------------------------------------------- registries

const DEFS: Record<string, CtxDef> = {
  edit: {
    key: "edit",
    icon: "edit",
    label: "Edit",
    enabled: (s) => !!s.single && !!s.obj && (s.obj.type === "text" || s.obj.type === "note") && !s.obj.locked,
    run: (_app, ui) => ui.invokeApp("editSelectedText"),
  },
  open: {
    key: "open",
    icon: "external",
    label: "Open",
    enabled: (s) => !!s.single && !!s.obj && (s.obj.type === "url" || s.obj.type === "file"),
    run: (app, ui) => {
      const o = app.project.getObject(app.selection.get()[0]);
      ui.invokeApp("openObject", o);
    },
  },
  focus: {
    key: "focus",
    icon: "focus",
    label: "Focus",
    enabled: (s) => s.n > 0,
    run: (_app, ui) => ui.invokeApp("focusSelection"),
  },
  isolate: {
    key: "isolate",
    icon: "isolate",
    label: "Isolate",
    enabled: (s) => !!s.single && !!s.obj && (s.obj.type === "group" || s.obj.type === "frame"),
    run: (_app, ui) => ui.invokeApp("isolateSelection"),
  },
  ungroup: {
    key: "ungroup",
    icon: "ungroup",
    label: "Ungroup",
    enabled: (s) => !!s.single && !!s.obj && s.obj.type === "group",
    run: (_app, ui) => ui.invokeApp("ungroupSelection"),
  },
  group: {
    key: "group",
    icon: "group",
    label: "Group",
    enabled: (s) => s.n >= 2,
    run: (_app, ui) => ui.invokeApp("groupSelection"),
  },
  connect: {
    key: "connect",
    icon: "connect",
    label: "Connect",
    enabled: (s) => s.n === 2,
    run: (_app, ui) => ui.invokeApp("connectSelection"),
  },
  rotate: {
    key: "rotate",
    icon: "rotate",
    label: "Rotate",
    enabled: () => true,
    run: (_app, ui) => ui.openPop("rotate"),
  },
  duplicate: {
    key: "duplicate",
    icon: "duplicate",
    label: "Duplicate",
    enabled: (s) => s.n > 0 && !(s.obj && s.obj.locked),
    run: (_app, ui) => ui.invokeApp("duplicateSelection"),
  },
  delete: {
    key: "delete",
    icon: "delete",
    label: "Delete",
    danger: true,
    enabled: (s) => s.n > 0 && !(s.obj && s.obj.locked),
    run: (_app, ui) => ui.invokeApp("deleteSelection"),
  },
  front: {
    key: "front",
    icon: "front",
    label: "Bring to front",
    enabled: (s) => s.n > 0 && !(s.obj && s.obj.locked),
    run: (_app, ui) => ui.invokeApp("bringToFront"),
  },
  back: {
    key: "back",
    icon: "back",
    label: "Send to back",
    enabled: (s) => s.n > 0 && !(s.obj && s.obj.locked),
    run: (_app, ui) => ui.invokeApp("sendToBack"),
  },
  color: {
    key: "color",
    icon: "color",
    label: "Color",
    enabled: (s) => {
      if (!s.single || !s.obj || s.obj.locked) return false;
      return s.obj.type === "note" || s.obj.type === "frame" || s.obj.type === "connection" || s.obj.type === "pen" || s.obj.type === "shape";
    },
    run: (_app, ui) => ui.openPop("color"),
  },
};

interface MoreDef {
  key: string;
  label: string;
  icon?: string;
  visible?(app: CallbackApp): boolean;
  enabled(app: CallbackApp): boolean;
  run(app: AppLike, ui: TabletUI): void;
}

const MORE_SECTIONS: { name: string; ids: string[] }[] = [
  { name: "View", ids: ["fit", "zin", "zout", "zreset", "exitiso"] },
  { name: "File", ids: ["new", "open", "import", "save-as", "export", "templates"] },
  { name: "Workspace", ids: ["projects", "versions", "plugins", "assets", "share"] },
  { name: "Tools", ids: ["select", "pen", "search"] },
];

const MORE_ITEMS: Record<string, MoreDef> = {
  fit: {
    key: "fit",
    label: "Fit overview",
    icon: "fit",
    enabled: () => true,
    run: (_app, ui) => ui.fitOverview(),
  },
  zin: {
    key: "zin",
    label: "Zoom in",
    icon: "zin",
    enabled: () => true,
    run: (app) => app.engine.zoomBy(1.2),
  },
  zout: {
    key: "zout",
    label: "Zoom out",
    icon: "zout",
    enabled: () => true,
    run: (app) => app.engine.zoomBy(1 / 1.2),
  },
  zreset: {
    key: "zreset",
    label: "Reset zoom",
    icon: "zreset",
    enabled: () => true,
    run: (app) => app.engine.resetView(),
  },
  exitiso: {
    key: "exitiso",
    label: "Exit isolation",
    icon: "exitiso",
    visible: (app) => !!app["isolation"],
    enabled: () => true,
    run: (_app, ui) => ui.invokeApp("exitIsolation"),
  },
  new: {
    key: "new",
    label: "New project",
    icon: "new",
    enabled: () => true,
    run: (_app, ui) => void ui.invokeApp("newProject"),
  },
  open: {
    key: "open",
    label: "Open project…",
    icon: "open",
    enabled: () => true,
    run: (_app, ui) => void ui.invokeApp("openProject"),
  },
  import: {
    key: "import",
    label: "Import…",
    icon: "import",
    enabled: () => true,
    run: (_app, ui) => void ui.invokeApp("importProject"),
  },
  "save-as": {
    key: "save-as",
    label: "Save As…",
    icon: "save-as",
    enabled: () => true,
    run: (_app, ui) => void ui.invokeApp("saveAsProject"),
  },
  export: {
    key: "export",
    label: "Export…",
    icon: "export",
    enabled: () => true,
    run: (_app, ui) => void ui.invokeApp("openExportDialog"),
  },
  templates: {
    key: "templates",
    label: "Templates…",
    icon: "templates",
    enabled: () => true,
    run: (_app, ui) => void ui.invokeApp("openTemplatesDialog"),
  },
  projects: {
    key: "projects",
    label: "Projects…",
    icon: "projects",
    enabled: () => true,
    run: (_app, ui) => void ui.invokeApp("openProjectsDialog"),
  },
  versions: {
    key: "versions",
    label: "Version history…",
    icon: "versions",
    enabled: () => true,
    run: (_app, ui) => void ui.invokeApp("openVersionsDialog"),
  },
  plugins: {
    key: "plugins",
    label: "Plugins…",
    icon: "plugins",
    enabled: () => true,
    run: (_app, ui) => void ui.invokeApp("openPluginsDialog"),
  },
  assets: {
    key: "assets",
    label: "Assets",
    icon: "assets",
    enabled: () => true,
    run: (_app, ui) => void ui.invokeApp("toggleAssetsPanel"),
  },
  share: {
    key: "share",
    label: "Share & collaborate…",
    icon: "share",
    enabled: () => true,
    run: (_app, ui) => void ui.invokeApp("openShareDialog"),
  },
  select: {
    key: "select",
    label: "Select tool",
    icon: "select",
    enabled: () => true,
    run: (_app, ui) => ui.setTool("select"),
  },
  pen: {
    key: "pen",
    label: "Pen tool",
    icon: "pen",
    enabled: () => true,
    run: (_app, ui) => ui.setTool("pen"),
  },
  search: {
    key: "search",
    label: "Search canvas",
    icon: "search",
    enabled: () => true,
    run: (_app, ui) => void ui.invokeApp("openSearch"),
  },
};

const PALETTE = [
  "#ff6b6b",
  "#ffa94d",
  "#ffd43b",
  "#69db7c",
  "#38d9a9",
  "#22b8cf",
  "#4dabf7",
  "#5b7cfa",
  "#845ef7",
  "#f783ac",
  "#e8eaed",
  "#adb5bd",
];

const ROTATES = [-90, -15, 15, 90, 0];

// ---------------------------------------------------------------- icons

const ICONS: Record<string, string> = {
  save: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M5 2h12l2 2v20H5z"/><path d="M17 2v5H8V2M9 12h6v10H9z"/></svg>',
  undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>',
  redo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14l5-5-5-5"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/></svg>',
  text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6V5h16v1"/><path d="M12 5v14M9 19h6"/></svg>',
  url: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7L11.5 4.5"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5"/></svg>',
  frame: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 12h10M12 7v10"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></svg>',
  select: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 3l7 17 2.6-6.4L20 11 4 3z"/></svg>',
  hand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V5.5a1.5 1.5 0 0 1 3 0M11 7V4.5a1.5 1.5 0 0 1 3 0V8M14 8V5a1.5 1.5 0 0 1 3 0v7M17 12a2 2 0 0 1 2 2c0 3-1.5 6-4.5 7H12c-3 0-5-1.5-6-3.5l-2-4c-.5-1 0-2 1-2.2 1-.2 1.5.4 2 1.5V5a1.5 1.5 0 0 1 3 0"/></svg>',
  pen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/></svg>',
  note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M5 3h10l4 4v14H5z"/><path d="M15 3v4h4"/></svg>',
  media: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/></svg>',
  shape: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="4" y="7" width="16" height="10"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>',
  focus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 3v5M12 21v-5M3 12h5M21 12h-5"/></svg>',
  isolate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>',
  ungroup: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h10M4 18h16"/></svg>',
  group: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><path d="M10 6h4a4 4 0 0 1 4 4v4"/></svg>',
  connect: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="6" r="2.4"/><path d="M8.2 16L15.8 8"/></svg>',
  rotate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>',
  duplicate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  delete: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14"/><path d="M10 11v6M14 11v6"/></svg>',
  front: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="4" y="10" width="12" height="10" rx="1"/><path d="M8 10V7a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-1"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="8" y="4" width="12" height="10" rx="1"/><path d="M16 14v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1"/></svg>',
  color: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22a10 10 0 1 1 10-10c0 1.7-1.3 3-3 3h-1.6a2 2 0 0 0-1.4 3.4c.4.4.4 1.1 0 1.6-.2.2-.4.6-.9.9A1.5 1.5 0 0 1 12 22z"/><circle cx="7.5" cy="11.5" r="1.2"/><circle cx="11" cy="7.5" r="1.2"/><circle cx="16" cy="8.8" r="1.2"/></svg>',
  fit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
  zin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35M8 11h6M11 8v6"/></svg>',
  zout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35M8 11h6"/></svg>',
  zreset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12a9 9 0 1 0 2.6-6.4"/><path d="M3 3v5h5"/></svg>',
  exitiso: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4H5a2 2 0 0 0-2 2v4M15 4h4a2 2 0 0 1 2 2v4M9 20H5a2 2 0 0 1-2-2v-4M15 20h4a2 2 0 0 0 2-2v-4"/></svg>',
  new: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  import: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 19h16"/></svg>',
  "save-as": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M5 2h12l2 2v20H5z"/><path d="M17 2v5H8V2M9 22v-6h6v6"/></svg>',
  export: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 19h16"/></svg>',
  templates: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/></svg>',
  projects: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M8 13h8M8 17h5"/></svg>',
  versions: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  plugins: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M20 12a4 4 0 1 0-3.5-5.9L9 13.5V20h6.5l7.5-6.6A4 4 0 0 0 20 12z"/><path d="M13 20v-6.6L6.5 6.1A4 4 0 1 0 3 9l7.5 6.6V20z"/></svg>',
  assets: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="12" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M8.7 10.7l6.6-3.4M8.7 13.3l6.6 3.4"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>',
  "shape-rectangle": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="4" y="7" width="16" height="10"/></svg>',
  "shape-rounded-rectangle": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="4" y="7" width="16" height="10" rx="3"/></svg>',
  "shape-ellipse": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="12" rx="8" ry="5"/></svg>',
  "shape-diamond": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3l8 9-8 9-8-9z"/></svg>',
  "shape-triangle": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3l9 17H3z"/></svg>',
  "shape-line": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20L20 4"/></svg>',
  "shape-arrow": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20L18 6M18 6H9M18 6v9"/></svg>',
  eraser: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 21h4M21 5l-8.5 8.5M3 7l14 14 4-4L7 3 3 7z"/></svg>',
  "size-down": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="15" r="4"/><path d="M12 3v5M6 7l1.5 1.5M18 7l-1.5 1.5"/></svg>',
  "size-up": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="15" r="6"/><path d="M12 3v5M6 7l1.5 1.5M18 7l-1.5 1.5"/></svg>',
};

// "open" is used both as a ctx action (open link) and a more item (open
// project); both intentionally share the folder icon.

// ---------------------------------------------------------------- shell html

interface PaneDef {
  id: string;
  cls: string;
  label: string;
}

const PANE_SHELL: PaneDef[] = [
  { id: "tb-actions", cls: "tb-pane tb-list", label: "Actions" },
  { id: "tb-rotate", cls: "tb-pane tb-list", label: "Rotate" },
];

function paneHtml(def: PaneDef): string {
  return `<div id="${def.id}" class="${def.cls}" hidden role="dialog" aria-label="${def.label}"></div>`;
}

const SHELL_HTML = `
<div id="tb-ui" class="tb-ui">
  <div id="tb-scrim" class="tb-scrim" hidden aria-hidden="true"></div>

  <header id="tb-topbar" role="banner">
    <button id="tb-title" class="tb-top-btn tb-title" data-tb="title" type="button" aria-label="Open projects">
      <span class="tb-title-dot" id="tb-saved-dot" aria-label="Saved"></span>
      <span class="tb-title-name" id="tb-title-name">Untitled</span>
    </button>
    <span class="tb-top-spacer"></span>
    <button class="tb-top-btn" data-tb="save" type="button" aria-label="Save">
      <span class="tb-top-icon">${ICONS.save}</span>
    </button>
    <button id="tb-undo" class="tb-top-btn" data-tb="undo" type="button" aria-label="Undo" disabled>${ICONS.undo ?? ""}</button>
    <button id="tb-redo" class="tb-top-btn" data-tb="redo" type="button" aria-label="Redo" disabled>${ICONS.redo ?? ""}</button>
    <button class="tb-top-btn" data-tb="search" type="button" aria-label="Search canvas">${ICONS.search}</button>
    <button id="tb-more-btn" class="tb-top-btn" data-tb="more" type="button" aria-label="More" aria-haspopup="true">${ICONS.more}</button>
  </header>

  <nav id="tb-dock" role="toolbar" aria-label="Tools">
    <button class="tb-tool tb-active" data-tool="select" type="button" aria-label="Select / move" aria-pressed="true">${ICONS.select}</button>
    <button class="tb-tool" data-tool="hand" type="button" aria-label="Pan the canvas" aria-pressed="false">${ICONS.hand}</button>
    <button class="tb-tool" data-tool="pen" type="button" aria-label="Pen tool" aria-pressed="false">${ICONS.pen}</button>
    <button class="tb-tool" data-tool="note" type="button" aria-label="Add a note">${ICONS.note}</button>
    <button class="tb-tool" data-tool="shape" type="button" aria-label="Add a shape" aria-haspopup="true">${ICONS.shape}</button>
    <button class="tb-tool" data-tool="media" type="button" aria-label="Add image, file, link, frame or text">${ICONS.media}</button>
  </nav>

  <div id="tb-pentools" class="tb-pentools tb-float" hidden role="toolbar" aria-label="Pen controls">
    <span class="tb-float-handle" data-tbfloat="pentools" role="presentation" aria-hidden="true"></span>
    <button id="tb-pt-eraser" class="tb-pt-btn" data-pt="eraser" type="button" aria-label="Eraser" aria-pressed="false">${ICONS.eraser}</button>
    <span class="tb-pt-sep"></span>
    <button class="tb-pt-btn" data-pt="size-down" type="button" aria-label="Smaller pen">${ICONS["size-down"]}</button>
    <button class="tb-pt-size" data-pt="size" type="button" aria-label="Pen size" aria-haspopup="true">
      <span id="tb-pt-dot" class="tb-pt-dot"></span>
    </button>
    <button class="tb-pt-btn" data-pt="size-up" type="button" aria-label="Larger pen">${ICONS["size-up"]}</button>
    <button class="tb-pt-sizeval" id="tb-pt-sizeval" data-pt="size" type="button" aria-label="Pen size"></button>
    <span class="tb-pt-sep"></span>
    <button id="tb-pt-colorchip" class="tb-pt-chip tb-pt-colorchip" data-pt="color" type="button" aria-label="Pen color" aria-haspopup="true"></button>
    <button class="tb-pt-btn" data-pt="undo" id="tb-pt-undo" type="button" aria-label="Undo" disabled>${ICONS.undo ?? ""}</button>
    <button class="tb-pt-btn" data-pt="redo" id="tb-pt-redo" type="button" aria-label="Redo" disabled>${ICONS.redo ?? ""}</button>
    <span class="tb-pt-sep"></span>
    <button class="tb-pt-btn tb-pt-done" data-pt="done" type="button"><span class="tb-pt-label">Done</span></button>
  </div>

  <div id="tb-context" class="tb-context tb-float" hidden role="toolbar" aria-label="Selected object actions">
    <div id="tb-context-body" class="tb-context-body"></div>
    <span class="tb-float-handle" data-tbfloat="context" role="presentation" aria-hidden="true"></span>
  </div>

  ${paneHtml(PANE_SHELL[0])}
  ${paneHtml(PANE_SHELL[1])}

  <div id="tb-shapes" class="tb-pane tb-shapes" hidden role="dialog" aria-label="Add a shape"></div>

  <div id="tb-color" class="tb-pane tb-color" hidden role="dialog" aria-label="Choose a color">
    <div class="tb-pane-title">Color</div>
    <div class="tb-swatches" id="tb-swatches"></div>
  </div>

  <div id="tb-addsheet" class="tb-pane tb-addsheet" hidden role="dialog" aria-label="Add to canvas">
    <div class="tb-pane-title">Add</div>
    <div class="tb-addgrid" id="tb-addgrid">
      <button class="tb-col" data-add="text" type="button"><span class="tb-col-icon">${ICONS.text ?? ""}</span><span>Text</span></button>
      <button class="tb-col" data-add="note" type="button"><span class="tb-col-icon">${ICONS.note}</span><span>Note</span></button>
      <button class="tb-col" data-add="url" type="button"><span class="tb-col-icon">${ICONS.url ?? ""}</span><span>Link</span></button>
      <button class="tb-col" data-add="frame" type="button"><span class="tb-col-icon">${ICONS.frame ?? ""}</span><span>Frame</span></button>
      <button class="tb-col" data-add="image" type="button"><span class="tb-col-icon">${ICONS.media}</span><span>Image</span></button>
      <button class="tb-col" data-add="file" type="button"><span class="tb-col-icon">${ICONS.file ?? ""}</span><span>File</span></button>
    </div>
    <div class="tb-pane-hint">Two-finger gestures pan and zoom. Pinch to zoom, drag to pan — or hold the Knob tool for precise work.</div>
  </div>

  <div id="tb-more" class="tb-pane tb-more" hidden role="dialog" aria-label="More">
    <div class="tb-more-head">
      <span class="tb-pane-title">More</span>
      <span class="tb-zoomchip" id="tb-zoom-label">100%</span>
    </div>
    <div id="tb-more-body" class="tb-more-body"></div>
  </div>
</div>`;