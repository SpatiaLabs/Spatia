"use strict";

/**
 * Spatia Web — mobile application layer.
 * Loaded ONLY on coarse-pointer / mobile devices (gated by js/site.js via
 * html.mb-active). Desktop browsers never see any of this.
 *
 * Turns the canvas into a native-feeling app:
 *  - a system-style navigation bar (back / title / undo / redo / menu),
 *  - a tab-style bottom toolbar with a primary "Add" action,
 *  - a floating zoom cluster (− · % · +) that follows the live viewport,
 *  - a touch-driven Connection tool (tap a source object, then its target),
 *  - bottom action/URL sheets with drag-to-dismiss,
 *  - long-press / right-tap object menu with haptics,
 *  - toast status messages replacing the desktop status bar,
 *  - two-finger pan + pinch-zoom on the canvas.
 */
(function () {
  if (!window.__spatia) return;
  var app = window.__spatia;
  var engine = app.engine;
  var host = document.getElementById("web-host");
  if (!host) return;
  // Re-entering the web route after a leave(): resume the existing instance
  // (re-apply runtime hooks the leave() restored) instead of rebuilding it.
  if (window.__spatiaMobile && typeof window.__spatiaMobile.resume === "function") {
    try { window.__spatiaMobile.resume(); } catch (err) { /* ignore */ }
    return;
  }

  // TS-private members exist as plain runtime properties/methods.
  function call() {
    var name = arguments[0];
    var fn = app[name];
    if (typeof fn !== "function") return undefined;
    var args = [];
    for (var i = 1; i < arguments.length; i++) args.push(arguments[i]);
    return fn.apply(app, args);
  }

  var ICONS = {
    undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h9a6 6 0 0 1 6 6v1a6 6 0 0 1-6 6h-3"/></svg>',
    redo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14l5-5-5-5"/><path d="M20 9h-9a6 6 0 0 0-6 6v1a6 6 0 0 0 6 6h3"/></svg>',
    select: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 3l7 17 2.6-6.4L20 11 4 3z"/></svg>',
    pen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/></svg>',
    add: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    connect: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="6" r="2.4"/><path d="M8.2 16L15.8 8"/></svg>',
    menu: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
    text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 6V5h14v1M12 5v14M9 19h6"/></svg>',
    note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M5 3h10l4 4v14H5z"/><path d="M15 3v4h4"/></svg>',
    url: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>',
    image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M6 2h9l5 5v15H6z"/><path d="M15 2v5h5"/></svg>',
    frame: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>',
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
    done: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>',
    save: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M5 2h12l2 2v20H5z"/><path d="M17 2v5H8V2M9 12h6v10H9z"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
    collapse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
    stabilize: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 13c2-5 4-5 6 0s4 5 6 0 2.5-5 4-5"/></svg>',
    pressure: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 20c3-3 4.5-6 4.5-11"/><path d="M19 20c-3-3-4.5-6-4.5-11"/><path d="M9.5 20h5"/></svg>',
  };

  var PEN_PALETTE = ["#ff6b6b", "#ffa94d", "#ffd43b", "#69db7c", "#38d9a9", "#22b8cf", "#4dabf7", "#5b7cfa", "#845ef7", "#f783ac", "#e8eaed", "#adb5bd"];

  var SHELL_HTML =
    '<div id="mb-topbar" role="banner">' +
    '<button class="mb-top-title" data-bar="title" type="button" aria-label="Open projects">' +
    '<span class="mb-title-dot" id="mb-saved-dot" aria-label="Saved"></span>' +
    '<span class="mb-title-name" id="mb-title-name">Untitled</span>' +
    '</button>' +
    '<button class="mb-top-action" data-bar="save" type="button" aria-label="Save">' + ICONS.save + "</button>" +
    '<button class="mb-top-action" data-bar="undo" type="button" aria-label="Undo" disabled>' + ICONS.undo + "</button>" +
    '<button class="mb-top-action" data-bar="redo" type="button" aria-label="Redo" disabled>' + ICONS.redo + "</button>" +
    '<button class="mb-top-action" data-bar="search" type="button" aria-label="Search">' + ICONS.search + "</button>" +
    '<button class="mb-top-action" data-bar="more" type="button" aria-label="More">' + ICONS.more + "</button>" +
    '</div>' +
    '<div class="mb-toolbar" role="toolbar" aria-label="Tools">' +
    '<button class="mb-tab" data-bar="select" data-tab="select" type="button">' + ICONS.select + "<span>Select</span></button>" +
    '<button class="mb-tab" data-bar="pen" data-tab="pen" type="button">' + ICONS.pen + "<span>Pen</span></button>" +
    '<button class="mb-tab" data-bar="add" data-tab="add" type="button"><span class="mb-tab-add-badge">' + ICONS.add + "</span><span>Add</span></button>" +
    '<button class="mb-tab" data-bar="connect" data-tab="connect" type="button">' + ICONS.connect + "<span>Connect</span></button>" +
    '<button class="mb-tab" data-bar="menu" data-tab="menu" type="button">' + ICONS.menu + "<span>Menu</span></button>" +
    "</div>" +
    '<div id="mb-penbar" class="mb-penbar" hidden role="toolbar" aria-label="Pen controls">' +
    '<button class="mb-pen-btn" data-pen="eraser" type="button" aria-label="Eraser" aria-pressed="false">' + ICONS.eraser + "</button>" +
    '<span class="mb-pen-sep"></span>' +
    '<button class="mb-pen-btn" data-pen="size-down" type="button" aria-label="Smaller pen">' + ICONS["size-down"] + "</button>" +
    '<button class="mb-pen-size" data-pen="size" type="button" aria-label="Pen size"><span class="mb-pen-dot" id="mb-pen-dot"></span></button>' +
    '<button class="mb-pen-btn" data-pen="size-up" type="button" aria-label="Larger pen">' + ICONS["size-up"] + "</button>" +
    '<span class="mb-pen-sep"></span>' +
    '<div class="mb-pen-palette" id="mb-pen-palette"></div>' +
    '<span class="mb-pen-sep"></span>' +
    '<button class="mb-pen-btn" data-pen="stabilizer" type="button" aria-label="Stabilizer: off" aria-pressed="false">' + ICONS.stabilize + "</button>" +
    '<button class="mb-pen-btn" data-pen="pressure" type="button" aria-label="Pressure: on" aria-pressed="true">' + ICONS.pressure + "</button>" +
    '<span class="mb-pen-sep"></span>' +
    '<button class="mb-pen-btn" data-pen="undo" type="button" aria-label="Undo" disabled>' + ICONS.undo + "</button>" +
    '<button class="mb-pen-btn" data-pen="redo" type="button" aria-label="Redo" disabled>' + ICONS.redo + "</button>" +
    '<span class="mb-pen-sep"></span>' +
    '<button class="mb-pen-btn mb-pen-hide" data-pen="collapse" type="button" aria-label="Hide pen controls">' + ICONS.collapse + '<span class="mb-pen-hide-label">Hide</span></button>' +
    '<button class="mb-pen-btn mb-pen-done" data-pen="done" type="button" aria-label="Done">' + ICONS.done + "</button>" +
    "</div>" +
    '<div id="mb-zoom" role="group" aria-label="Zoom">' +
    '<button type="button" class="mb-zoom-btn" id="mb-zoom-out" aria-label="Zoom out">−</button>' +
    '<button type="button" class="mb-zoom-btn mb-zoom-label" id="mb-zoom-reset" aria-label="Reset view">100%</button>' +
    '<button type="button" class="mb-zoom-btn" id="mb-zoom-in" aria-label="Zoom in">+</button>' +
    "</div>" +
    '<div class="mb-selrow" hidden aria-live="polite">' +
    '<button class="mb-btn" data-sel="focus" type="button">Focus</button>' +
    '<button class="mb-btn" data-sel="duplicate" type="button">Duplicate</button>' +
    '<button class="mb-btn mb-danger" data-sel="delete" type="button">Delete</button>' +
    "</div>" +
    '<div class="mb-hint" id="mb-connect-hint" hidden role="status" aria-live="polite"></div>' +
    '<div class="mb-toast" id="mb-toast" role="status" aria-live="polite"></div>' +
    '<div class="mb-backdrop" hidden>' +
    '<div class="mb-sheet" role="dialog" aria-modal="true" aria-label="Spatia sheet">' +
    '<div class="mb-sheet-grab"></div>' +
    '<div class="mb-sheet-title"><span id="mb-sheet-caption">Sheet</span>' +
    '<button class="mb-sheet-close" data-sheet="close" type="button" aria-label="Close">&times;</button></div>' +
    '<div id="mb-sheet-body"></div>' +
    "</div>" +
    "</div>" +
    '<div id="mb-url" hidden aria-hidden="true">' +
    '<div class="mb-url-scrim" data-url="cancel"></div>' +
    '<div class="mb-sheet">' +
    '<div class="mb-sheet-grab"></div>' +
    '<div class="mb-sheet-title">Add link<button class="mb-sheet-close" data-url="cancel" type="button" aria-label="Close">&times;</button></div>' +
    '<form id="mb-url-form" action="#" novalidate>' +
    '<input class="mb-url-field" id="mb-url-field" type="url" inputmode="url" placeholder="https://" autocomplete="url" autocapitalize="off" autocorrect="off" spellcheck="false">' +
    '<div class="mb-url-actions">' +
    '<button class="mb-url-btn" type="button" data-url="cancel">Cancel</button>' +
    '<button class="mb-url-btn mb-url-primary" type="submit">Add</button>' +
    "</div>" +
    "</form>" +
    "</div>" +
    "</div>";

  host.insertAdjacentHTML("beforeend", SHELL_HTML);

  var toolbar = host.querySelector(".mb-toolbar");
  var topUndo = host.querySelector('[data-bar="undo"]');
  var topRedo = host.querySelector('[data-bar="redo"]');
  var topTitle = document.getElementById("mb-title-name");
  var savedDot = document.getElementById("mb-saved-dot");
  var selRow = host.querySelector(".mb-selrow");
  var backdrop = host.querySelector(".mb-backdrop");
  var sheetEl = host.querySelector(".mb-backdrop .mb-sheet");
  var sheetBody = host.querySelector("#mb-sheet-body");
  var sheetCaption = host.querySelector("#mb-sheet-caption");
  var sheetMode = "menu"; // "menu" | "add"
  var toastEl = host.querySelector("#mb-toast");
  var urlBox = host.querySelector("#mb-url");
  var urlField = host.querySelector("#mb-url-field");
  var zoomLabel = host.querySelector("#mb-zoom-reset");
  var alive = true;

  var penBar = document.getElementById("mb-penbar");
  var penDot = document.getElementById("mb-pen-dot");
  var penPalette = document.getElementById("mb-pen-palette");
  var penEraserBtn = penBar ? penBar.querySelector('[data-pen="eraser"]') : null;
  var penUndoBtn = penBar ? penBar.querySelector('[data-pen="undo"]') : null;
  var penRedoBtn = penBar ? penBar.querySelector('[data-pen="redo"]') : null;
  var penStabBtn = penBar ? penBar.querySelector('[data-pen="stabilizer"]') : null;
  var penPressBtn = penBar ? penBar.querySelector('[data-pen="pressure"]') : null;
  var penPanelHidden = false;

  var toastTimer = null;
  function toast(text) {
    if (!alive) return;
    toastEl.textContent = text || "";
    toastEl.classList.remove("hide");
    toastEl.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove("show");
      toastEl.classList.add("hide");
      toastTimer = setTimeout(function () {
        toastEl.classList.remove("hide");
        toastEl.textContent = "";
      }, 240);
    }, 2400);
  }

  // ---------------------------------------------------------------- helpers

  function selectionState() {
    var ids = app.selection.get();
    var n = app.selection.size;
    var obj = n === 1 ? app.project.getObject(ids[0]) : null;
    return { ids: ids, n: n, obj: obj, single: n === 1 };
  }

  function setDisabled(btn, disabled) {
    if (btn) btn.disabled = !!disabled;
  }

  function isConnection(id) {
    var o = app.project.getObject(id);
    return !!(o && o.type === "connection");
  }

  function setHint(text) {
    var el = document.getElementById("mb-connect-hint");
    if (!el) return;
    el.hidden = !text;
    el.textContent = text || "";
  }

  function buzz(pattern) {
    try {
      // Only vibrate after a real user activation; synthetic clicks (e.g. the
      // web-setup/verify harness) otherwise trigger a Chromium console warning.
      if (navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) {
        navigator.vibrate(pattern);
      }
    } catch (err) { /* unsupported */ }
  }

  // Touch Connection tool state. Lives entirely in this layer: it drives the
  // engine's existing beginConnection / connectionDragTo / finishConnection
  // API (the same code path the desktop uses for Ctrl+drag), so desktop
  // behavior is untouched.
  var connectActive = false;
  var connSource = null; // object id the draft is starting from
  var connPointer = null; // active pointer id while dragging the draft
  var connStart = null; // where the source tap began (screen, canvas-relative)
  var connMoved = false;

  function connReset() {
    connSource = null;
    connPointer = null;
    connStart = null;
    connMoved = false;
  }

  function cancelConnectTool() {
    if (typeof engine.cancelConnectionDraft === "function") engine.cancelConnectionDraft();
    connReset();
    setHint("");
  }

  function setConnect(on) {
    connectActive = !!on;
    toolbar.querySelector('[data-bar="connect"]').classList.toggle("mb-active", connectActive);
    if (connectActive) {
      engine.setPenTool(false);
      app.ui.setTools(false);
      app.ui.setSidebarOpen(false);
      app.selection.setIds([]);
      connReset();
      setHint("Connect: tap a source object, then tap its target.");
    } else {
      cancelConnectTool();
    }
    refresh();
  }

  // ------------------------------------------------------- app shell state

  function updateZoomLabel() {
    if (!alive) return;
    try {
      zoomLabel.textContent = Math.round((engine.getZoom() || 1) * 100) + "%";
    } catch (err) { /* ignore */ }
  }

  function updateTopBar() {
    if (!alive) return;
    try {
      var meta = app.project.getMeta();
      var name = meta && meta.name && String(meta.name).trim() ? String(meta.name) : "Untitled";
      if (topTitle) topTitle.textContent = name;
      var dirty = !!app.commands.isDirty();
      if (savedDot) {
        savedDot.classList.toggle("mb-dirty", dirty);
        savedDot.setAttribute("aria-label", dirty ? "Unsaved changes" : "Saved");
      }
    } catch (err) { /* ignore */ }
  }

  function refresh() {
    if (!alive) return;
    var s = selectionState();
    updateTopBar();
    setDisabled(topUndo, !app.commands.canUndo);
    setDisabled(topRedo, !app.commands.canRedo);
    toolbar.querySelector('[data-bar="pen"]').classList.toggle("mb-active", engine.isPenTool());
    toolbar.querySelector('[data-bar="connect"]').classList.toggle("mb-active", connectActive);
    toolbar.querySelector('[data-bar="select"]').classList.toggle("mb-active", !engine.isPenTool() && !connectActive);
    selRow.hidden = s.n === 0;
    if (s.n > 0) {
      var locked = !!(s.obj && s.obj.locked);
      setDisabled(selRow.querySelector('[data-sel="duplicate"]'), locked);
      setDisabled(selRow.querySelector('[data-sel="delete"]'), locked);
    }
    renderPenBar();
    updateZoomLabel();
  }

  function renderPenBar() {
    if (!penBar || !penDot || !penPalette) return;
    var on = !!engine.isPenTool();
    penBar.hidden = !(on && !penPanelHidden);
    var sett = null;
    try { sett = engine.getPenSettings(); } catch (err) { /* ignore */ }
    if (sett) {
      var stab = sett.stabilizer === "strong" ? "strong" : sett.stabilizer === "mild" ? "mild" : "off";
      var pressure = sett.pressure !== false;
      if (penStabBtn) {
        var stabOn = stab !== "off";
        penStabBtn.classList.toggle("mb-active", stabOn);
        penStabBtn.setAttribute("aria-pressed", stabOn ? "true" : "false");
        penStabBtn.setAttribute("aria-label", "Pen stabilizer: " + stab);
      }
      if (penPressBtn) {
        penPressBtn.classList.toggle("mb-active", pressure);
        penPressBtn.setAttribute("aria-pressed", pressure ? "true" : "false");
        penPressBtn.setAttribute("aria-label", "Pressure size: " + (pressure ? "on" : "off"));
      }
    }
    if (!on) return;
    var style = engine.getPenStyle();
    var eraser = engine.isPenEraser();
    if (penEraserBtn) {
      penEraserBtn.classList.toggle("mb-active", eraser);
      penEraserBtn.setAttribute("aria-pressed", eraser ? "true" : "false");
    }
    var px = Math.min(26, Math.max(3, style.size * 2.4));
    penDot.style.width = px + "px";
    penDot.style.height = px + "px";
    penDot.style.background = style.color;
    penPalette.innerHTML = PEN_PALETTE.map(function (hex) {
      return '<button type="button" class="mb-pen-swatch' + (hex === style.color ? " mb-active" : "") + '" data-pencolor="' + hex + '" aria-label="Pen color ' + hex + '" style="--mpsw:' + hex + '"></button>';
    }).join("");
    if (penUndoBtn) setDisabled(penUndoBtn, !app.commands.canUndo);
    if (penRedoBtn) setDisabled(penRedoBtn, !app.commands.canRedo);
  }

  function penStabVal() {
    try {
      var s = engine.getPenSettings();
      if (s) return s.stabilizer === "strong" ? "strong" : s.stabilizer === "mild" ? "mild" : "off";
    } catch (err) { /* ignore */ }
    return "off";
  }

  function penPressVal() {
    try {
      var s = engine.getPenSettings();
      if (s) return s.pressure !== false;
    } catch (err) { /* ignore */ }
    return true;
  }

  // Users can collapse the pen panel to reclaim canvas while staying in the
  // pen tool. The drawing-time auto-collapse (.mb-collapsed) is separate and
  // transient; this hide survives until the Pen tab is pressed again.
  function hidePenPanel() {
    penPanelHidden = true;
    renderPenBar();
    buzz(6);
  }

  function penBarCollapse(on) {
    if (!penBar) return;
    penBar.classList.toggle("mb-collapsed", !!on);
  }

  function closeSheet() {
    backdrop.hidden = true;
    sheetEl.style.transform = "";
  }

  function openSheet(mode, caption) {
    sheetMode = mode;
    sheetCaption.textContent = caption;
    backdrop.hidden = false;
    sheetEl.style.transform = "";
    renderSheet();
    buzz(6);
  }

  // Sheets can be dragged down to dismiss.
  function attachSheetDrag(dragEl, container, onClose) {
    var dragging = null;
    function down(e) {
      dragging = { id: e.pointerId, y: e.clientY, dy: 0 };
      container.style.transition = "none";
      dragEl.setPointerCapture && dragEl.setPointerCapture(e.pointerId);
    }
    function move(e) {
      if (!dragging || dragging.id !== e.pointerId) return;
      dragging.dy = Math.max(0, e.clientY - dragging.y);
      container.style.transform = "translateY(" + dragging.dy + "px)";
      if (dragging.dy > 8) container.style.transition = "";
    }
    function up(e) {
      if (!dragging || dragging.id !== e.pointerId) return;
      var dy = dragging.dy;
      dragging = null;
      container.style.transition = "";
      if (dy > 88) {
        onClose();
      } else {
        container.style.transform = "";
      }
    }
    dragEl.addEventListener("pointerdown", down);
    dragEl.addEventListener("pointermove", move);
    dragEl.addEventListener("pointerup", up);
    dragEl.addEventListener("pointercancel", up);
  }

  // ------------------------------------------------------------- sheet body

  var MENU_GROUPS = [
    { name: "Selected", ids: ["edit-text", "open-object", "focus", "isolate", "duplicate", "delete", "connect", "group", "ungroup", "front", "back"] },
    { name: "Edit", ids: ["undo", "redo"] },
    { name: "File", ids: ["new", "open-project", "import", "save", "save-as", "export", "templates"] },
    { name: "Collaborate", ids: ["share", "assets"] },
    { name: "Plugins", ids: ["plugins"] },
    { name: "View", ids: ["exitiso", "zin", "zout", "zreset", "fit"] },
    { name: "Site", ids: ["back-site"] },
  ];

  var MENU_ITEMS = {
    "edit-text": { label: "Edit text", enabled: function (s) { return s.single && s.obj && (s.obj.type === "text" || s.obj.type === "note") && !s.obj.locked; }, run: function () { call("editSelectedText"); } },
    "open-object": { label: "Open", enabled: function (s) { return s.single && s.obj && (s.obj.type === "url" || s.obj.type === "file"); }, run: function () { call("openObject", app.project.getObject(app.selection.get()[0])); } },
    focus: { label: "Focus selection", enabled: function (s) { return s.n > 0; }, run: function () { call("focusSelection"); } },
    isolate: { label: "Isolate", enabled: function (s) { return s.single && s.obj && (s.obj.type === "group" || s.obj.type === "frame"); }, run: function () { call("isolateSelection"); } },
    duplicate: { label: "Duplicate", enabled: function (s) { return s.n > 0 && !(s.obj && s.obj.locked); }, run: function () { call("duplicateSelection"); } },
    delete: { label: "Delete", enabled: function (s) { return s.n > 0 && !(s.obj && s.obj.locked); }, run: function () { call("deleteSelection"); } },
    connect: { label: "Connect selection", enabled: function (s) { return s.n === 2; }, run: function () { call("connectSelection"); } },
    group: { label: "Group", enabled: function (s) { return s.n >= 2; }, run: function () { call("groupSelection"); } },
    ungroup: { label: "Ungroup", enabled: function (s) { return s.single && s.obj && s.obj.type === "group"; }, run: function () { call("ungroupSelection"); } },
    front: { label: "Bring to front", enabled: function (s) { return s.n > 0 && !(s.obj && s.obj.locked); }, run: function () { call("bringToFront"); } },
    back: { label: "Send to back", enabled: function (s) { return s.n > 0 && !(s.obj && s.obj.locked); }, run: function () { call("sendToBack"); } },
    undo: { label: "Undo", enabled: function () { return !!app.commands.canUndo; }, run: function () { call("undo"); } },
    redo: { label: "Redo", enabled: function () { return !!app.commands.canRedo; }, run: function () { call("redo"); } },
    new: { label: "New project", enabled: function () { return true; }, run: function () { call("newProject"); } },
    "open-project": { label: "Open project…", enabled: function () { return true; }, run: function () { call("openProject"); } },
    import: { label: "Import…", enabled: function () { return true; }, run: function () { call("importProject"); } },
    save: { label: "Save project", enabled: function () { return true; }, run: function () { call("saveProject"); } },
    "save-as": { label: "Save as…", enabled: function () { return true; }, run: function () { call("saveAsProject"); } },
    export: { label: "Export…", enabled: function () { return true; }, run: function () { closeSheet(); call("openExportDialog"); } },
    templates: { label: "Templates…", enabled: function () { return true; }, run: function () { closeSheet(); call("openTemplatesDialog"); } },
    plugins: { label: "Plugins…", enabled: function () { return true; }, run: function () { closeSheet(); call("openPluginsDialog"); } },
    share: { label: "Share & collaborate…", enabled: function () { return true; }, run: function () { closeSheet(); call("openShareDialog"); } },
    assets: { label: "Assets", enabled: function () { return true; }, run: function () { closeSheet(); call("toggleAssetsPanel"); } },
    exitiso: { label: "Exit isolation", enabled: function () { return !!app.isolation; }, run: function () { call("exitIsolation"); } },
    zin: { label: "Zoom in", enabled: function () { return true; }, run: function () { call("zoomIn"); } },
    zout: { label: "Zoom out", enabled: function () { return true; }, run: function () { call("zoomOut"); } },
    zreset: { label: "Reset view", enabled: function () { return true; }, run: function () { call("resetView"); } },
    fit: { label: "Fit all", enabled: function () { return true; }, run: function () { engine.selectAll(); var s = selectionState(); if (s.n > 0) call("focusSelection"); } },
    "back-site": { label: "Back to Spatia site", enabled: function () { return true; }, run: function () { window.location.hash = "#top"; } },
  };

  var ADD_KINDS = ["text", "note", "url", "image", "file", "frame",
    "shape-rectangle", "shape-rounded-rectangle", "shape-ellipse", "shape-diamond", "shape-triangle", "shape-line", "shape-arrow"];
  var ADD_LABELS = {
    text: "Text", note: "Note", url: "Link", image: "Image", file: "File", frame: "Frame",
    "shape-rectangle": "Rectangle", "shape-rounded-rectangle": "Rounded", "shape-ellipse": "Ellipse",
    "shape-diamond": "Diamond", "shape-triangle": "Triangle", "shape-line": "Line", "shape-arrow": "Arrow"
  };

  function renderSheet() {
    if (sheetMode === "add") {
      var addHtml = '<div class="mb-grid">';
      for (var a = 0; a < ADD_KINDS.length; a++) {
        var kind = ADD_KINDS[a];
        addHtml += '<button class="mb-grid-item" data-add="' + kind + '" type="button">' +
          (ICONS[kind] || "") + "<span>" + ADD_LABELS[kind] + "</span></button>";
      }
      addHtml += "</div>";
      sheetBody.innerHTML = addHtml;
      var items = sheetBody.querySelectorAll(".mb-grid-item");
      Array.prototype.forEach.call(items, function (item) {
        item.addEventListener("click", function () {
          var k = item.getAttribute("data-add");
          closeSheet();
          var center = app.centerWorld();
          if (k === "frame") call("addFrameAt", center);
          else if (k.indexOf("shape-") === 0) call("addShapeAt", k.slice(6), center);
          else call("addObjectAt", k, center);
          refresh();
        });
      });
      return;
    }

    var s = selectionState();
    var html = "";
    for (var g = 0; g < MENU_GROUPS.length; g++) {
      var group = MENU_GROUPS[g];
      var rendered = [];
      for (var k = 0; k < group.ids.length; k++) {
        var def = MENU_ITEMS[group.ids[k]];
        var enabled = def.enabled(s);
        rendered.push({ id: group.ids[k], label: def.label, enabled: !!enabled });
      }
      var visible = rendered.filter(function (r) {
        return r.id !== "exitiso" || !!app.isolation;
      });
      if (visible.length === 0) continue;
      html += '<div class="mb-sheet-section">' + group.name + "</div>";
      for (var r = 0; r < visible.length; r++) {
        html += '<button class="mb-item mb-item-row" data-mbkey="' + visible[r].id + '"' +
          (visible[r].enabled ? "" : ' disabled="disabled"') + ">" + visible[r].label + "</button>";
      }
    }
    sheetBody.innerHTML = html;
    renderRecents();
  }

  function renderRecents() {
    if (sheetMode !== "menu" || !window.spatia || typeof window.spatia.getRecentProjects !== "function") return;
    window.spatia.getRecentProjects().then(function (list) {
      if (sheetMode !== "menu" || backdrop.hidden) return;
      var html = '<div class="mb-sheet-section">Recent</div>';
      if (!list || list.length === 0) {
        html += '<div class="mb-recent-empty">No recent projects</div>';
      } else {
        for (var i = 0; i < list.length; i++) {
          html += '<div class="mb-recent" data-recent="' + encodeURIComponent(list[i].filePath) + '">' +
            '<span class="mb-recent-name">' + escapeHtml(list[i].name || "Untitled") + "</span>" +
            '<span class="mb-chevron">›</span></div>';
        }
      }
      sheetBody.insertAdjacentHTML("beforeend", html);
      var recentEls = sheetBody.querySelectorAll(".mb-recent");
      Array.prototype.forEach.call(recentEls, function (el) {
        el.addEventListener("click", function () {
          closeSheet();
          call("openProjectPath", decodeURIComponent(el.getAttribute("data-recent")));
        });
      });
    }).catch(function () { /* best-effort */ });
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ------------------------------------------------------- URL sheet patch

  var urlResolver = null;
  var realPromptUrl = null;

  function closeUrlSheet(result) {
    urlBox.hidden = true;
    var resolve = urlResolver;
    urlResolver = null;
    if (resolve) resolve(result);
  }

  function wireUrlSheet() {
    var cancels = urlBox.querySelectorAll('[data-url="cancel"]');
    Array.prototype.forEach.call(cancels, function (el) {
      el.addEventListener("click", function () { closeUrlSheet(null); });
    });
    urlBox.querySelector("#mb-url-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var v = urlField.value.trim();
      closeUrlSheet(v || null);
    });
    var grab = urlBox.querySelector(".mb-sheet-grab");
    if (grab) attachSheetDrag(grab, urlBox.querySelector(".mb-sheet"), function () { closeUrlSheet(null); });
  }

  function patchUi() {
    var ui = app.ui;
    if (!ui) return;
    realPromptUrl = ui.promptUrl;
    ui.promptUrl = function () {
      urlResolver = null;
      urlBox.hidden = false;
      var f = urlBox.querySelector("#mb-url-field");
      f.value = "";
      setTimeout(function () { if (f && !urlBox.hidden) { try { f.focus(); } catch (err) { /* ignore */ } } }, 60);
      return new Promise(function (resolve) {
        urlResolver = resolve;
      });
    };
    var origSetStatus = ui.setStatus;
    ui.setStatus = function (text) {
      if (text) toast(String(text));
      return origSetStatus.call(ui, text);
    };
    ui.__mbOriginalStatus = origSetStatus;
  }

  function restoreUi() {
    var ui = app.ui;
    if (!ui) return;
    if (realPromptUrl && typeof realPromptUrl === "function") ui.promptUrl = realPromptUrl;
    if (ui.__mbOriginalStatus) {
      ui.setStatus = ui.__mbOriginalStatus;
      delete ui.__mbOriginalStatus;
    }
  }

  // ------------------------------------------------------------ shell wiring

  function onHostClick(e) {
    if (!alive) return;
    var btn = e.target.closest("[data-bar]");
    if (!btn) return;
    var kind = btn.getAttribute("data-bar");
    if (kind === "title") { setConnect(false); call("openProjectsDialog"); }
    else if (kind === "save") { setConnect(false); call("saveProject"); refresh(); }
    else if (kind === "undo") { setConnect(false); call("undo"); refresh(); }
    else if (kind === "redo") { setConnect(false); call("redo"); refresh(); }
    else if (kind === "search") { setConnect(false); call("openSearch"); }
    else if (kind === "more") { setConnect(false); openSheet("menu", "Menu"); }
    else if (kind === "menu") { setConnect(false); openSheet("menu", "Menu"); }
    else if (kind === "add") { setConnect(false); openSheet("add", "Add to canvas"); }
    else if (kind === "select") {
      setConnect(false);
      engine.setPenTool(false);
      app.ui.setTools(false);
      app.ui.setSidebarOpen(false);
      refresh();
    } else if (kind === "pen") {
      setConnect(false);
      if (engine.isPenTool()) {
        // Pen already on: if the user hid the panel, re-show it (keep the pen
        // tool selected); otherwise the tap deselects the tool like before.
        if (penPanelHidden) penPanelHidden = false;
        else { engine.setPenTool(false); app.ui.setTools(false); }
      } else {
        penPanelHidden = false;
        engine.setPenTool(true);
        app.ui.setTools(true);
        app.selection.setIds([]);
      }
      refresh();
    } else if (kind === "connect") {
      setConnect(!connectActive);
    }
  }

  function onPenClick(e) {
    if (!alive) return;
    var el = e.target.closest("[data-pen], [data-pencolor]");
    if (!el) return;
    e.stopPropagation();
    var act = el.getAttribute("data-pen");
    if (act) {
      if (act === "eraser") {
        engine.setPenEraser(!engine.isPenEraser());
      } else if (act === "size-down") {
        engine.setPenStyle({ size: engine.getPenStyle().size - 1 });
      } else if (act === "size-up") {
        engine.setPenStyle({ size: engine.getPenStyle().size + 1 });
      } else if (act === "stabilizer") {
        var cur = penStabVal();
        var next = cur === "off" ? "mild" : cur === "mild" ? "strong" : "off";
        engine.setPenSettings({ stabilizer: next });
        buzz(6);
      } else if (act === "pressure") {
        var was = penPressVal();
        engine.setPenSettings({ pressure: !was });
        buzz(6);
      } else if (act === "collapse") {
        hidePenPanel();
      } else if (act === "undo") {
        setConnect(false);
        call("undo");
      } else if (act === "redo") {
        setConnect(false);
        call("redo");
      } else if (act === "done") {
        setConnect(false);
        engine.setPenTool(false);
        app.ui.setTools(false);
      }
    } else {
      var hex = el.getAttribute("data-pencolor");
      if (hex) engine.setPenStyle({ color: hex });
    }
    refresh();
  }

  function onSelRowClick(e) {
    if (!alive) return;
    var btn = e.target.closest("[data-sel]");
    if (!btn) return;
    var kind = btn.getAttribute("data-sel");
    if (kind === "focus") call("focusSelection");
    else if (kind === "duplicate") call("duplicateSelection");
    else if (kind === "delete") call("deleteSelection");
    refresh();
  }

  function onSheetClick(e) {
    if (!alive) return;
    if (e.target === backdrop) { closeSheet(); return; }
    if (e.target.closest('[data-sheet="close"]')) { closeSheet(); return; }
    var row = e.target.closest("[data-mbkey]");
    if (!row || row.disabled) return;
    var def = MENU_ITEMS[row.getAttribute("data-mbkey")];
    if (def) {
      closeSheet();
      buzz(8);
      def.run();
      refresh();
    }
  }

  host.addEventListener("click", onHostClick);
  if (penBar) penBar.addEventListener("click", onPenClick);
  selRow.addEventListener("click", onSelRowClick);
  backdrop.addEventListener("click", onSheetClick);
  attachSheetDrag(host.querySelector(".mb-backdrop .mb-sheet-grab"), sheetEl, closeSheet);
  attachSheetDrag(host.querySelector(".mb-backdrop .mb-sheet-title"), sheetEl, closeSheet);
  wireUrlSheet();

  // Zoom cluster.
  host.querySelector("#mb-zoom-out").addEventListener("click", function (e) { if (!alive) return; e.stopPropagation(); engine.zoomBy(1 / 1.2); });
  host.querySelector("#mb-zoom-in").addEventListener("click", function (e) { if (!alive) return; e.stopPropagation(); engine.zoomBy(1.2); });
  zoomLabel.addEventListener("click", function (e) { if (!alive) return; e.stopPropagation(); engine.resetView(); });

  // Live undo/redo, viewport and selection states.
  try { app.selection.changed.subscribe(refresh); } catch (err) { /* ignore */ }
  try { app.commands.changed.subscribe(refresh); } catch (err) { /* ignore */ }
  try { app.project.changed.subscribe(updateTopBar); } catch (err) { /* ignore */ }
  try { app.viewport.changed.subscribe(updateZoomLabel); } catch (err) { /* ignore */ }
  patchUi();
  refresh();

  // Hook for js/site.js: when the user leaves #/web, tear down state so
  // nothing can linger into the next visit (or the desktop session). Re-entry
  // runs the resume branch at the top of this module instead of rebuilding.
  window.__spatiaMobile = {
    leave: function () { leaveMobile(); },
    resume: resumeMobile,
  };

  function leaveMobile() {
    alive = false;
    cancelConnectTool();
    connectActive = false;
    restoreUi();
    closeSheet();
    closeUrlSheet(null);
    setHint("");
    if (penBar) {
      penBar.hidden = true;
      penBar.classList.remove("mb-collapsed");
    }
    penPanelHidden = false;
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
  }

  function resumeMobile() {
    alive = true;
    setHint("");
    try { patchUi(); } catch (err) { /* ignore */ }
    try { refresh(); } catch (err) { /* ignore */ }
  }

  // ------------------------------------------------- two-finger pan / pinch

  if (typeof window.PointerEvent !== "function") return;

  var canvas = engine.canvas();
  var pointers = new Map();
  var multi = false;
  var lastDist = null;
  var lastMid = null;

  var TAP_PX = 6; // treat drags under this distance as taps (tap source -> tap target)

  function relPos(x, y) {
    var r = canvas.getBoundingClientRect();
    return { x: x - r.left, y: y - r.top };
  }

  function distAndMid() {
    var keys = Array.from(pointers.keys());
    var a = pointers.get(keys[0]);
    var b = pointers.get(keys[1]);
    return {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    };
  }

  // Touch Connection tool: "tap a source object, then tap its target". A hold
  // and drag also works (the draft follows the finger, exactly like the
  // desktop Ctrl+drag). Releasing over an object connects the two; releasing
  // over empty space keeps a free endpoint. Tapping the source again cancels.
  function connectDown(e) {
    var p = relPos(e.clientX, e.clientY);
    if (connSource === null) {
      var hit = engine.hitTest(p);
      if (hit && !isConnection(hit)) {
        engine.beginConnection(hit, p);
        connSource = hit;
        connPointer = e.pointerId;
        connStart = { x: p.x, y: p.y };
        connMoved = false;
        setHint("Now tap the target object, or empty space for a free end.");
      } else if (hit) {
        setHint("Connections cannot start from another connection.");
      } else {
        setHint("Tap an object to start a connection.");
      }
      return;
    }
    var id = engine.finishConnection(p);
    connReset();
    setHint(id ? "Connection created. Start another one, or pick another tool." : "Canceled — tap a source object to start again.");
  }

  function onPointerDown(e) {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1 && engine.isPenTool() && !connectActive) penBarCollapse(true);
    if (pointers.size === 2) {
      // Take over the canvas for the two-finger gesture. Settle any pending
      // engine interaction (marquee / move) with a synthetic pointerup that
      // uses a sentinel pointerId so our own bookkeeping is not disturbed.
      multi = true;
      lastDist = null;
      lastMid = null;
      canvas.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: -1 }));
    }
    if (pointers.size >= 2) { e.stopImmediatePropagation(); return; }
    if (connectActive) {
      e.stopImmediatePropagation();
      connectDown(e);
      return;
    }
  }

  function onPointerMove(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (multi && pointers.size >= 2) {
      e.stopImmediatePropagation();
      var g = distAndMid();
      if (lastDist !== null && lastMid !== null) {
        var zoom = g.dist / lastDist;
        engine.applyAnchoredZoom(zoom, relPos(g.mid.x, g.mid.y));
        engine.applyPan(g.mid.x - lastMid.x, g.mid.y - lastMid.y);
      }
      lastDist = g.dist;
      lastMid = g.mid;
      return;
    }
    if (connectActive && connSource !== null && connPointer === e.pointerId) {
      e.stopImmediatePropagation();
      var np = relPos(e.clientX, e.clientY);
      if (!connMoved && connStart && Math.hypot(np.x - connStart.x, np.y - connStart.y) < TAP_PX) return;
      engine.connectionDragTo(np);
      connMoved = true;
    }
  }

  function onPointerEnd(e) {
    if (connectActive && connSource !== null && connPointer === e.pointerId) {
      e.stopImmediatePropagation();
      if (connMoved) {
        var id = engine.finishConnection(relPos(e.clientX, e.clientY));
        connReset();
        setHint(id ? "Connection created. Start another one, or pick another tool." : "Canceled — tap a source object to start again.");
      } else {
        // Plain tap on the source: keep the draft and wait for the target tap.
        connPointer = null;
      }
    }
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (multi) e.stopImmediatePropagation();
    if (pointers.size < 2) {
      multi = false;
      lastDist = null;
      lastMid = null;
    }
    if (pointers.size === 0) penBarCollapse(false);
  }

  // The engine's desktop right-click menu is a bubble listener on the canvas.
  // On mobile the native context menu (long-press on touch, right-click with a
  // mouse) stays disabled, so swallow the event here at capture. The object
  // menu sheet is only ever opened from the toolbar and sheet UI — never from
  // holding a finger on the canvas.
  function onContextMenu(e) {
    try { e.preventDefault(); } catch (err) { /* ignore */ }
    try { e.stopImmediatePropagation(); } catch (err) { /* ignore */ }
  }

  canvas.addEventListener("pointerdown", onPointerDown, true);
  canvas.addEventListener("pointermove", onPointerMove, true);
  canvas.addEventListener("pointerup", onPointerEnd, true);
  canvas.addEventListener("pointercancel", onPointerEnd, true);
  canvas.addEventListener("contextmenu", onContextMenu, true);
})();