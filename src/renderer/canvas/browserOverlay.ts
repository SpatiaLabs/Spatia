/**
 * Browser Frame overlay.
 *
 * The Browser Frame plugin stores a web address on a `frame` object's
 * metadata ("browserUrl"). Drawing a live website cannot live inside the
 * plugin sandbox (it has no DOM and a null-origin iframe), so the app owns a
 * thin rendering primitive that projects those objects into the canvas:
 *
 *  - Desktop (Electron): a real `<webview>` (a Chromium guest frame). It is
 *    not constrained by the embedding site's frame-busting headers and plays
 *    video/audio natively. Loads happen in a non-persistent partition, so no
 *    cookies or credentials are written to disk, and the page never gains
 *    Node/Electron access.
 *  - Web (any browser): a plain `<iframe>` fallback. Many sites refuse to be
 *    framed (X-Frame-Options / CSP frame-ancestors), which is a genuine
 *    platform limitation â€” the toolbar's back/forward/reload and the Go bar
 *    still work for sites that do allow embedding.
 *
 * Only the URL itself is ever persisted (into the object's metadata). Page
 * contents, favicons and credentials are never stored in the project.
 */

import { screenToWorld, visibleWorldRect, type Point, type ViewportFrame } from "../../shared/geometry/viewport.js";
import { browserUrlOf, normalizeBrowserUrl } from "../../shared/plugins/browserFrame.js";
import type { CanvasObject } from "../../shared/types/object.js";
import type { CanvasEngine } from "../canvas/engine.js";
import type { ProjectStore } from "../project/projectStore.js";
import type { SelectionStore } from "../state/selectionStore.js";
import { moveObjectsCommand, resizeObjectsCommand } from "../command/commands.js";

/** Zoom below which rendering the overlay is pointless but expensive. */
const MIN_OVERLAY_ZOOM = 0.08;

interface WebGuest {
  element: HTMLElement;
  activeUrl: string;
  setUrl(url: string): void;
  reload(): void;
  goBack(): void;
  goForward(): void;
  dispose(): void;
  navState(): { canBack: boolean; canForward: boolean };
  isLive: boolean;
}

interface FrameEntry {
  id: string;
  root: HTMLDivElement;
  toolbar: HTMLDivElement;
  addr: HTMLInputElement;
  backBtn: HTMLButtonElement;
  fwdBtn: HTMLButtonElement;
  reloadBtn: HTMLButtonElement;
  goBtn: HTMLButtonElement;
  note: HTMLDivElement;
  guest: WebGuest;
  drag: {
    pointerId: number;
    before: { id: string; x: number; y: number };
    offX: number;
    offY: number;
    moved: boolean;
  } | null;
  resize: {
    pointerId: number;
    dir: string;
    before: { id: string; x: number; y: number; width: number; height: number };
    start: Point;
  } | null;
  /** Last geometry actually written to the DOM, so unchanged frames skip layout. */
  last: { left: number; top: number; width: number; height: number; zoom: number; visible: boolean } | null;
}

type WebviewElement = HTMLElement & {
  getURL?: () => string;
  canGoBack?: () => boolean;
  canGoForward?: () => boolean;
  goBack?: () => void;
  goForward?: () => void;
  reload?: () => void;
};

export class BrowserFrameOverlay {
  readonly #engine: CanvasEngine;
  readonly #project: ProjectStore;
  readonly #selection: SelectionStore;
  #layer: HTMLDivElement | null = null;
  #entries = new Map<string, FrameEntry>();
  #webviewSupported: boolean | null = null;
  /** Per-frame debounce for persisting the current URL back to the object. */
  #persistTimers = new Map<string, number>();

  constructor(engine: CanvasEngine, project: ProjectStore, selection: SelectionStore) {
    this.#engine = engine;
    this.#project = project;
    this.#selection = selection;
  }

  private supportsWebview(): boolean {
    if (this.#webviewSupported === null) {
      const el = document.createElement("webview") as WebviewElement;
      this.#webviewSupported = typeof el.getURL === "function";
    }
    return this.#webviewSupported;
  }

  private layer(): HTMLDivElement {
    if (!this.#layer) {
      const el = document.getElementById("browser-layer");
      this.#layer = el instanceof HTMLDivElement ? el : document.createElement("div");
      this.#layer.id = "browser-layer";
      this.#layer.className = "browser-layer";
      if (!this.#layer.isConnected) {
        const canvas = this.#engine.canvas();
        canvas.parentElement?.appendChild(this.#layer);
      }
    }
    return this.#layer;
  }

  /** Reconcile the overlay DOM with the document. Called from the rAF loop. */
  sync(): void {
    const layer = this.layer();
    const frame = this.#engine.getFrame();
    const zoomedOut = this.#engine.getZoom() <= MIN_OVERLAY_ZOOM;
    const wanted = new Set<string>();

    for (const obj of this.#project.getObjects()) {
      if (obj.type !== "frame") continue;
      if (!browserUrlOf(obj)) continue;
      if (!this.#engine.isObjectInScope(obj.id)) continue;
      wanted.add(obj.id);
      const entry = this.#entries.get(obj.id);
      if (!entry) continue;
      entry.root.classList.toggle("bf-selected", this.#selection.has(obj.id));
      if (zoomedOut) {
        entry.root.classList.add("bf-min", "bf-off");
        continue;
      }
      entry.root.classList.remove("bf-min");
      this.#position(entry, obj, frame, this.#isOnScreen(obj, frame));
    }

    for (const [id, entry] of [...this.#entries]) {
      if (wanted.has(id)) continue;
      entry.root.remove();
      entry.guest.dispose();
      const t = this.#persistTimers.get(id);
      if (t !== undefined) window.clearTimeout(t);
      this.#persistTimers.delete(id);
      this.#entries.delete(id);
    }
    for (const obj of this.#project.getObjects()) {
      if (obj.type !== "frame") continue;
      if (!wanted.has(obj.id)) continue;
      if (this.#entries.has(obj.id)) continue;
      const url = browserUrlOf(obj);
      if (!url) continue;
      // Don't build DOM for frames that are far off-screen or zoomed-out.
      if (zoomedOut || !this.#isOnScreen(obj, frame)) continue;
      const entry = this.#buildEntry(obj.id, url);
      if (!entry) continue;
      entry.root.classList.toggle("bf-selected", this.#selection.has(obj.id));
      this.#position(entry, obj, frame, true);
      layer.appendChild(entry.root);
      this.#entries.set(obj.id, entry);
    }
  }

  /**
   * Position a frame's DOM element, skipping writes when nothing changed.
   * Off-screen frames are set to display:none (`.bf-off`) so the guest stops
   * painting/using the compositor without having its page torn down.
   */
  #position(entry: FrameEntry, obj: CanvasObject, frame: ViewportFrame, visible: boolean): void {
    if (!visible) {
      if (!entry.last || entry.last.visible) {
        entry.root.classList.add("bf-off");
        entry.last = { left: 0, top: 0, width: 0, height: 0, zoom: frame.zoom, visible: false };
      }
      return;
    }
    const left = (obj.x - frame.cameraX) * frame.zoom;
    const top = (obj.y - frame.cameraY) * frame.zoom;
    const width = obj.width * frame.zoom;
    const height = obj.height * frame.zoom;
    const zoom = frame.zoom;
    const last = entry.last;
    if (
      last &&
      last.visible &&
      last.left === left &&
      last.top === top &&
      last.width === width &&
      last.height === height &&
      last.zoom === zoom
    ) {
      return;
    }
    entry.root.classList.remove("bf-off");
    entry.root.style.left = `${left}px`;
    entry.root.style.top = `${top}px`;
    entry.root.style.width = `${width}px`;
    entry.root.style.height = `${height}px`;
    entry.root.style.setProperty("--browser-zoom", String(zoom));
    entry.last = { left, top, width, height, zoom, visible: true };
  }

  /** The frame overlaps the visible region (with a generous margin to avoid edge flicker). */
  #isOnScreen(obj: CanvasObject, frame: ViewportFrame): boolean {
    const view = visibleWorldRect(frame);
    return (
      obj.x < view.x + view.width + obj.width &&
      obj.x + obj.width > view.x - obj.width &&
      obj.y < view.y + view.height + obj.height &&
      obj.y + obj.height > view.y - obj.height
    );
  }

  #buildEntry(id: string, url: string): FrameEntry | null {
    const root = document.createElement("div");
    root.className = "browser-frame";
    root.dataset.id = id;

    const toolbar = document.createElement("div");
    toolbar.className = "browser-toolbar";

    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "browser-btn bf-nav";
    backBtn.title = "Back";
    backBtn.textContent = "\u2190";

    const fwdBtn = document.createElement("button");
    fwdBtn.type = "button";
    fwdBtn.className = "browser-btn bf-nav";
    fwdBtn.title = "Forward";
    fwdBtn.textContent = "\u2192";

    const reloadBtn = document.createElement("button");
    reloadBtn.type = "button";
    reloadBtn.className = "browser-btn";
    reloadBtn.title = "Reload";
    reloadBtn.textContent = "\u21bb";

    const addr = document.createElement("input");
    addr.type = "text";
    addr.className = "browser-addr";
    addr.spellcheck = false;
    addr.autocomplete = "off";
    addr.placeholder = "Enter a web address or search\u2026";
    addr.setAttribute("aria-label", "Web address");

    const goBtn = document.createElement("button");
    goBtn.type = "button";
    goBtn.className = "browser-btn bf-go";
    goBtn.title = "Go";
    goBtn.textContent = "Go";

    const exitBtn = document.createElement("button");
    exitBtn.type = "button";
    exitBtn.className = "browser-exit";
    exitBtn.title = "Done — stop selecting this frame";
    exitBtn.textContent = "Done";
    exitBtn.addEventListener("click", () => {
      this.#selection.clear();
    });

    toolbar.append(backBtn, fwdBtn, reloadBtn, addr, goBtn, exitBtn);

    const content = document.createElement("div");
    content.className = "browser-content";

    const note = document.createElement("div");
    note.className = "browser-note";
    note.textContent = "Web build: sites that refuse embedding won't appear. Use the desktop app for the full browser.";
    note.hidden = true;

    const webviewMode = this.supportsWebview();
    const guest = webviewMode ? this.#createWebviewGuest(url, content, addr) : this.#createIframeGuest(url, content, addr, note);
    if (!guest) return null;

    const handles = document.createElement("div");
    handles.className = "browser-resize-handles";
    for (const dir of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
      const h = document.createElement("div");
      h.className = `browser-resize-handle r-${dir}`;
      h.dataset.dir = dir;
      handles.appendChild(h);
    }

    root.append(toolbar, content, note, handles);

    const entry: FrameEntry = {
      id,
      root,
      toolbar,
      addr,
      backBtn,
      fwdBtn,
      reloadBtn,
      goBtn,
      note,
      guest,
      drag: null,
      resize: null,
      last: null,
    };
    this.#bindToolbar(entry, webviewMode);
    this.#bindDrag(entry);
    this.#bindResize(entry);
    entry.root.addEventListener("pointerdown", () => {
      const obj = this.#project.getObject(id);
      if (obj && obj.type === "frame" && !obj.locked) this.#selection.setIds([id]);
    });
    return entry;
  }

  #createWebviewGuest(url: string, content: HTMLDivElement, addr: HTMLInputElement): WebGuest | null {
    const el = document.createElement("webview") as WebviewElement;
    el.className = "browser-guest bf-webview";
    el.setAttribute("partition", "browser-frame");
    el.setAttribute("webpreferences", "contextIsolation=yes,nodeIntegration=no,sandbox=yes");
    el.setAttribute("allowfullscreen", "true");
    el.setAttribute("src", url);
    content.appendChild(el);

    const guest: WebGuest = {
      element: el,
      activeUrl: url,
      setUrl(u) {
        guest.activeUrl = u;
        el.setAttribute("src", u);
      },
      reload: () => {
        try {
          (el as WebviewElement).reload?.();
        } catch {
          /* guest already disposed */
        }
      },
      goBack: () => {
        try {
          (el as WebviewElement).goBack?.();
        } catch {
          /* guest already disposed */
        }
      },
      goForward: () => {
        try {
          (el as WebviewElement).goForward?.();
        } catch {
          /* guest already disposed */
        }
      },
      dispose: () => el.remove(),
      navState: () => {
        let canBack = false;
        let canForward = false;
        try {
          canBack = (el as WebviewElement).canGoBack?.() ?? false;
          canForward = (el as WebviewElement).canGoForward?.() ?? false;
        } catch {
          /* guest disposed */
        }
        return { canBack, canForward };
      },
      isLive: true,
    };

    const markNavigated = (u: string): void => {
      if (!u) return;
      guest.activeUrl = u;
      addr.value = u;
    };
    el.addEventListener("did-navigate", (e) => {
      const u = (e as unknown as { url?: string }).url;
      if (!u) return;
      markNavigated(u);
      this.#persist(entryIdOf(el), u);
    });
    el.addEventListener("did-navigate-in-page", (e) => {
      const u = (e as unknown as { url?: string }).url;
      if (!u) return;
      markNavigated(u);
      this.#persist(entryIdOf(el), u);
    });
    el.addEventListener("did-stop-loading", () => {
      const current = (el as WebviewElement).getURL?.() ?? "";
      if (current) {
        guest.activeUrl = current;
        addr.value = current;
      }
      this.#refreshNav(el);
    });
    el.addEventListener("new-window", (e) => {
      const u = (e as unknown as { url?: string }).url ?? "";
      if (!u) return;
      e.preventDefault();
      void window.spatia.openExternal(u);
    });
    el.addEventListener("will-navigate", (e) => {
      const u = (e as unknown as { url?: string }).url ?? "";
      if (u && !/^https?:/.test(u)) e.preventDefault();
    });
    return guest;
  }

  #createIframeGuest(
    url: string,
    content: HTMLDivElement,
    addr: HTMLInputElement,
    note: HTMLDivElement
  ): WebGuest {
    const el = document.createElement("iframe");
    el.className = "browser-guest bf-iframe";
    el.setAttribute("allow", "autoplay; encrypted-media; picture-in-picture; fullscreen");
    el.setAttribute("allowfullscreen", "true");
    el.setAttribute("src", url);
    content.appendChild(el);

    const guest: WebGuest = {
      element: el,
      activeUrl: url,
      setUrl(u) {
        guest.activeUrl = u;
        el.setAttribute("src", u);
      },
      reload: () =>
        (() => {
          el.setAttribute("src", guest.activeUrl);
        })(),
      goBack: () => undefined,
      goForward: () => undefined,
      dispose: () => el.remove(),
      navState: () => ({ canBack: false, canForward: false }),
      isLive: false,
    };

    el.addEventListener("load", () => {
      addr.value = guest.activeUrl;
      note.hidden = false;
    });
    note.hidden = false;
    return guest;
  }

  #refreshNav(el: WebviewElement): void {
    const entry = this.#entryFor(el);
    if (!entry) return;
    const state = entry.guest.navState();
    entry.backBtn.disabled = !state.canBack;
    entry.fwdBtn.disabled = !state.canForward;
  }

  /**
   * Persist the current address back to the frame's metadata. Debounced per
   * frame so busy SPA navigation (pushState) doesn't hammer the project store
   * (which cascades into UI refresh + collab snapshots) while a page is live.
   */
  #persist(id: string, url: string): void {
    const existing = this.#persistTimers.get(id);
    if (existing !== undefined) window.clearTimeout(existing);
    this.#persistTimers.set(
      id,
      window.setTimeout(() => {
        this.#persistTimers.delete(id);
        const obj = this.#project.getObject(id);
        if (!obj || obj.type !== "frame") return;
        if (browserUrlOf(obj) === url) return;
        const metadata = { ...(obj.metadata ?? {}), browserUrl: url };
        // Non-undoable, like the camera: it only tracks where a frame currently is.
        this.#project.setObjectProp(id, "metadata", metadata);
      }, 300)
    );
  }

  #bindToolbar(entry: FrameEntry, webviewMode: boolean): void {
    const { addr, backBtn, fwdBtn, reloadBtn, goBtn, guest } = entry;
    if (!webviewMode) {
      backBtn.disabled = true;
      fwdBtn.disabled = true;
      reloadBtn.title = "Not available in the browser build";
    }

    const go = (): void => {
      const target = normalizeBrowserUrl(addr.value);
      if (!target) {
        addr.select();
        return;
      }
      if (target === guest.activeUrl) {
        guest.reload();
        return;
      }
      guest.setUrl(target);
      addr.value = target;
    };
    goBtn.addEventListener("click", go);
    addr.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        go();
      }
    });
    backBtn.addEventListener("click", () => guest.goBack());
    fwdBtn.addEventListener("click", () => guest.goForward());
    reloadBtn.addEventListener("click", () => guest.reload());
  }

  #bindDrag(entry: FrameEntry): void {
    entry.toolbar.addEventListener("pointerdown", (e) => {
      const target = e.target as HTMLElement;
      if (target instanceof HTMLButtonElement || target instanceof HTMLInputElement) return;
      const obj = this.#project.getObject(entry.id);
      if (!obj || obj.type !== "frame" || obj.locked) return;
      const frame = this.#engine.getFrame();
      const rect = this.layer().getBoundingClientRect();
      const screen: Point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const world = screenToWorld(screen, frame);
      entry.drag = {
        pointerId: e.pointerId,
        before: { id: entry.id, x: obj.x, y: obj.y },
        offX: obj.x - world.x,
        offY: obj.y - world.y,
        moved: false,
      };
      entry.toolbar.setPointerCapture(e.pointerId);
    });
    entry.toolbar.addEventListener("pointermove", (e) => {
      if (!entry.drag || e.pointerId !== entry.drag.pointerId) return;
      const frame = this.#engine.getFrame();
      const rect = this.layer().getBoundingClientRect();
      const world = screenToWorld({ x: e.clientX - rect.left, y: e.clientY - rect.top }, frame);
      this.#project.moveObjectsTo([
        { id: entry.id, x: world.x + entry.drag.offX, y: world.y + entry.drag.offY },
      ]);
      entry.drag.moved = true;
    });
    const endDrag = (e: PointerEvent): void => {
      if (!entry.drag || e.pointerId !== entry.drag.pointerId) return;
      const drag = entry.drag;
      entry.drag = null;
      if (entry.toolbar.hasPointerCapture(e.pointerId)) entry.toolbar.releasePointerCapture(e.pointerId);
      if (!drag.moved) return;
      const obj = this.#project.getObject(entry.id);
      if (!obj) return;
      const after: { id: string; x: number; y: number }[] = [{ id: entry.id, x: obj.x, y: obj.y }];
      this.#engine.commitCommand(moveObjectsCommand(this.#project, [drag.before], after));
    };
    entry.toolbar.addEventListener("pointerup", endDrag);
    entry.toolbar.addEventListener("pointercancel", endDrag);
  }

  /**
   * Resize a selected frame via the overlay's DOM corner/edge handles. The
   * canvas grab-handles are unreachable underneath the always-interactive
   * page, so the frame gets its own resize handles while selected. Live
   * updates apply directly; a single undoable resize command is committed on
   * release (mirroring how the canvas engine commits move gestures).
   */
  #bindResize(entry: FrameEntry): void {
    const MIN_SIZE = 40;
    const handleEls = entry.root.querySelectorAll<HTMLElement>(".browser-resize-handle");
    for (const el of handleEls) {
      const dir = el.dataset.dir ?? "";
      if (!dir) continue;
      el.addEventListener("pointerdown", (e) => {
        if (entry.resize) return;
        const obj = this.#project.getObject(entry.id);
        if (!obj || obj.type !== "frame" || obj.locked) return;
        e.preventDefault();
        e.stopPropagation();
        const frame = this.#engine.getFrame();
        const rect = this.layer().getBoundingClientRect();
        const start = screenToWorld({ x: e.clientX - rect.left, y: e.clientY - rect.top }, frame);
        entry.resize = {
          pointerId: e.pointerId,
          dir,
          before: { id: entry.id, x: obj.x, y: obj.y, width: obj.width, height: obj.height },
          start,
        };
        el.setPointerCapture(e.pointerId);
      });
      const move = (e: PointerEvent): void => {
        const r = entry.resize;
        if (!r || r.pointerId !== e.pointerId) return;
        const frame = this.#engine.getFrame();
        const rect = this.layer().getBoundingClientRect();
        const p = screenToWorld({ x: e.clientX - rect.left, y: e.clientY - rect.top }, frame);
        const before = r.before;
        let left = before.x;
        let right = before.x + before.width;
        let top = before.y;
        let bottom = before.y + before.height;
        const dx = p.x - r.start.x;
        const dy = p.y - r.start.y;
        if (r.dir.includes("w")) left = before.x + dx;
        if (r.dir.includes("e")) right = before.x + before.width + dx;
        if (r.dir.includes("n")) top = before.y + dy;
        if (r.dir.includes("s")) bottom = before.y + before.height + dy;
        if (right - left < MIN_SIZE) {
          if (r.dir.includes("w")) right = left + MIN_SIZE;
          else left = right - MIN_SIZE;
        }
        if (bottom - top < MIN_SIZE) {
          if (r.dir.includes("n")) bottom = top + MIN_SIZE;
          else top = bottom - MIN_SIZE;
        }
        this.#project.resizeObject(entry.id, left, top, right - left, bottom - top);
      };
      const end = (e: PointerEvent): void => {
        const r = entry.resize;
        if (!r || r.pointerId !== e.pointerId) return;
        entry.resize = null;
        if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
        const obj = this.#project.getObject(entry.id);
        if (!obj || obj.type !== "frame") return;
        if (obj.x === r.before.x && obj.y === r.before.y && obj.width === r.before.width && obj.height === r.before.height) return;
        const after = { id: entry.id, x: obj.x, y: obj.y, width: obj.width, height: obj.height };
        this.#engine.commitCommand(resizeObjectsCommand(this.#project, [r.before], [after]));
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", end);
    }
  }

  #entryFor(el: HTMLElement): FrameEntry | undefined {
    for (const entry of this.#entries.values()) {
      if (entry.guest.element === el || entry.root === el) return entry;
    }
    return undefined;
  }
}

function entryIdOf(el: HTMLElement): string {
  return el.closest(".browser-frame")?.getAttribute("data-id") ?? "";
}
