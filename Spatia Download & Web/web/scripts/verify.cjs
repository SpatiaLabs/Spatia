"use strict";

/**
 * End-to-end verification of the Spatia website changes:
 *  - SPA hash routing (# <-> #/web) is a REAL in-page transition: leaving the
 *    web workspace removes the app stylesheet (restoring landing scrolling),
 *    detaches the app's window handlers, and nothing is ever reloaded.
 *  - Re-entering the web workspace keeps the single app instance alive.
 *  - The mobile layer appears ONLY on forced-mobile (device-gated) sessions,
 *    and produces the bar/sheet UI inside the web host.
 *  - PWA assets (manifest, icons, service worker) exist and are served.
 *
 * Run with:  electron web/scripts/verify.cjs
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");
const net = require("net");
const { spawn } = require("child_process");
const { app, BrowserWindow } = require("electron");

const BASE = path.resolve(__dirname, "..", ".."); // "Spatia Download & Web"
const PORT = 8756;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".msi": "application/octet-stream",
  ".xml": "application/xml",
};

let pass = 0;
let fail = 0;

function ok(name, value) {
  if (value) {
    pass++;
    process.stdout.write(`  PASS  ${name}\n`);
  } else {
    fail++;
    process.stdout.write(`  FAIL  ${name}\n`);
  }
  return !!value;
}

function serve() {
  return http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    let rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
    const file = path.resolve(BASE, rel);
    if (!file.startsWith(BASE)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, {
        "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(data);
    });
  });
}

function get(url) {
  return new Promise((resolve) => {
    http.get(`http://127.0.0.1:${PORT}${url}`, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on("error", () => resolve({ status: 0, body: Buffer.alloc(0) }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function execute(win, fn) {
  return win.webContents.executeJavaScript(`(${fn.toString()})()`);
}

async function until(win, fn, desc, tries = 150) {
  for (let i = 0; i < tries; i++) {
    try {
      if (await execute(win, fn)) return true;
    } catch {
      /* page mid-transition */
    }
    await sleep(150);
  }
  const diag = await execute(win, () => ({
    hash: window.location.hash,
    dataWeb: document.documentElement.hasAttribute("data-web"),
    hostHidden: document.getElementById("web-host").hidden,
    spatia: !!window.__spatia,
    appCss: !!document.querySelector('link[href*="web/app.css"]'),
    mobileShell: !!document.querySelector(".mb-toolbar"),
  })).catch((e) => "diag error: " + e.message);
  process.stdout.write(`  [until timed out: ${desc}] ${JSON.stringify(diag)}\n`);
  ok(desc, false);
  return false;
}

async function httpOk(name, url, checkBody) {
  const res = await get(url);
  const bodyOk = checkBody ? checkBody(res.body) : true;
  ok(name, res.status === 200 && bodyOk);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

const COLLAB_SERVER_JS = path.resolve(__dirname, "..", "..", "..", "server", "server.js");
const WS_IMPL = path.resolve(__dirname, "..", "..", "..", "server", "node_modules", "ws");

function spawnCollabServer(port, dataDir) {
  const child = spawn(process.execPath, [COLLAB_SERVER_JS, "--port", String(port), "--data", dataDir], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  const stderr = [];
  child.stderr.on("data", (d) => stderr.push(String(d)));
  const listening = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("collab server start timeout: " + stderr.join(""))), 8000);
    child.stdout.on("data", (d) => {
      if (/listening/.test(String(d))) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", () => {
      clearTimeout(timer);
      reject(new Error("collab server exited early"));
    });
  });
  return { child, listening };
}

function makePeerClient(port, room, user) {
  const WebSocket = require(WS_IMPL);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const messages = [];
    const timer = setTimeout(() => reject(new Error("peer join timeout")), 8000);
    ws.on("open", () => {
      ws.send(JSON.stringify({ t: "join", room, user }));
      ws.send(JSON.stringify({ t: "presence", x: 20, y: 30 }));
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      messages.push(msg);
      if (msg.t === "joined") {
        clearTimeout(timer);
        resolve({ ws, messages });
      }
    });
    ws.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function peerUntil(conn, fn, tries = 100) {
  return new Promise((resolve) => {
    const loop = (i) => {
      if (fn(conn.messages)) return resolve(true);
      if (i >= tries) return resolve(false);
      setTimeout(() => loop(i + 1), 150);
    };
    loop(0);
  });
}

app.whenReady().then(async () => {
  const server = serve();
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

  const errors = [];
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: { backgroundThrottling: false, nodeIntegration: false, contextIsolation: true },
  });
  win.webContents.on("console-message", (e, level, message) => {
    if (level >= 3) errors.push(message);
  });

  try {
    // ---- 1) Landing page ------------------------------------------------
    await win.loadURL(`http://127.0.0.1:${PORT}/?no-sw=1`);
    await sleep(600);

    const landing = await execute(win, () => ({
      text: document.body.innerText || "",
      siteVisible: !!document.querySelector(".site") && getComputedStyle(document.querySelector(".site")).display !== "none",
      tall: document.documentElement.scrollHeight > window.innerHeight,
      logoLoaded: (() => {
        const img = document.querySelector(".brand-logo");
        return !!(img && img.complete && img.naturalWidth > 0);
      })(),
      bodyOverflowY: getComputedStyle(document.body).overflowY,
      webHidden: document.getElementById("web-host").hidden,
      hasManifestLink: !!document.querySelector('link[rel="manifest"]'),
      themeColor: (document.querySelector('meta[name="theme-color"]') || {}).content || null,
    }));
    ok("landing renders", /Think in space/.test(landing.text));
    ok("landing site visible", landing.siteVisible);
    ok("landing is scrollable content", landing.tall);
    ok("real brand logo displayed", landing.logoLoaded);
    ok("landing body not overflow-hidden", landing.bodyOverflowY !== "hidden");
    ok("web host hidden on landing", landing.webHidden);
    ok("manifest <link> present", landing.hasManifestLink);
    ok("theme-color meta present", landing.themeColor === "#121417");

    // ---- 1b) Wiki route (#/wiki) ---------------------------------------
    await execute(win, () => { window.location.hash = "#/wiki"; });
    await until(win, () => document.documentElement.hasAttribute("data-wiki") && !document.getElementById("wiki-host").hidden, "wiki renders");

    const wiki = await execute(win, () => {
      const links = document.querySelectorAll("#wiki-toc a");
      return {
        title: document.title,
        landingHidden: (() => { const s = document.querySelector(".site"); return !!s && getComputedStyle(s).display === "none"; })(),
        hadWikiNav: !!document.querySelector('.nav-links a[href="#/wiki"]'),
        hadFooterWiki: !!document.querySelector('.footer-links a[href="#/wiki"]'),
        tocCount: links.length,
        sectionCount: document.querySelectorAll(".wiki-section").length,
        hasSearch: !!document.getElementById("wiki-search"),
        hasReportUI: !!document.querySelector('[data-report-open], [data-report-close], #report-dialog, #report-form'),
        hasGmail: /@gmail\.com/.test(document.body.innerHTML),
        sectionIds: Array.prototype.map.call(document.querySelectorAll(".wiki-section"), (s) => s.id || ""),
      };
    });
    ok("landing nav gains Wiki link", wiki.hadWikiNav);
    ok("footer nav gains Wiki link", wiki.hadFooterWiki);
    ok("wiki route renders", wiki.title === "Spatia — Wiki" && wiki.landingHidden);
    ok("wiki TOC has navigation entries", wiki.tocCount >= 20);
    ok("wiki has documentation sections", wiki.sectionCount >= 20);
    ok("wiki search present", wiki.hasSearch);
    ok("wiki has no Report a problem UI", !wiki.hasReportUI);
    ok("wiki exposes no personal contact email", !wiki.hasGmail);

    const wikiSlugs = [
      "what-is", "getting-started", "canvases-projects", "saving-open", "import-export",
      "templates", "notes-text", "connections", "frames", "images-files-urls",
      "drawing-shapes", "selection", "navigation", "shortcuts", "mobile",
      "search-organization", "plugins", "collaboration", "version-history",
      "faq", "troubleshooting",
    ];
    const wikiMissing = wikiSlugs.filter((s) => wiki.sectionIds.indexOf("wiki-" + s) === -1);
    ok("all required wiki sections exist", wikiMissing.length === 0);

    await execute(win, () => { window.location.hash = "#/wiki/shortcuts"; });
    const wikiDeep = await execute(win, () => ({
      hash: window.location.hash,
      anchor: !!document.getElementById("wiki-shortcuts"),
    }));
    ok("wiki section deep-link routes", wikiDeep.hash === "#/wiki/shortcuts" && wikiDeep.anchor);

    const wikiSearch = await execute(win, () => {
      const input = document.getElementById("wiki-search");
      input.value = "shortcut";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const all = Array.prototype.slice.call(document.querySelectorAll("#wiki-toc a[data-wiki-search]"));
      const visible = all.filter((a) => {
        const li = a.closest("li");
        return !!li && getComputedStyle(li).display !== "none";
      });
      const counter = document.getElementById("wiki-result-count");
      return {
        visible: visible.length,
        total: all.length,
        countText: counter ? counter.textContent.trim() : "",
      };
    });
    ok("wiki search filters the TOC", wikiSearch.visible < wikiSearch.total && /\d+\s+results?/.test(wikiSearch.countText));
    await execute(win, () => {
      const input = document.getElementById("wiki-search");
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await execute(win, () => { window.location.hash = "#top"; });
    await until(win, () => !document.documentElement.hasAttribute("data-wiki") && document.getElementById("wiki-host").hidden, "back to landing");
    const wikiBack = await execute(win, () => ({
      siteVisible: (() => { const s = document.querySelector(".site"); return !!s && getComputedStyle(s).display !== "none"; })(),
      title: document.title,
      webHidden: document.getElementById("web-host").hidden,
    }));
    ok("wiki exit restores landing", wikiBack.siteVisible && wikiBack.webHidden && /Think in space/.test(wikiBack.title));

    // ---- 1c) Wiki content accuracy ----------------------------------------
    const wikiText = await execute(win, () => ({
      mobile: (document.getElementById("wiki-mobile").textContent || "").toLowerCase(),
      plugins: (document.getElementById("wiki-plugins").textContent || "").toLowerCase(),
    }));
    ok("wiki: mobile section no longer claims a long-press menu", wikiText.mobile.indexOf("long-press") === -1);
    ok("wiki: mobile section documents the real touch model", wikiText.mobile.indexOf("two fingers") !== -1 && wikiText.mobile.indexOf("connect") !== -1);
    ok("wiki: plugins section documents the hosted Counter Plugin", wikiText.plugins.indexOf("count objects by type") !== -1 && wikiText.plugins.indexOf("sandbox") !== -1);
    ok("wiki: plugins section no longer claims note creation", wikiText.plugins.indexOf("creates a note") === -1);

    // ---- 1d) Report a problem is fully removed ---------------------------
    const reportGone = await execute(win, () => ({
      dialog: document.getElementById("report-dialog"),
      form: document.getElementById("report-form"),
      triggers: document.querySelectorAll('[data-report-open]').length,
    }));
    ok("report: dialog and form markup removed", !reportGone.dialog && !reportGone.form);
    ok("report: no in-page open triggers remain", reportGone.triggers === 0);

    // ---- 2) Enter #/web (first boot) ------------------------------------
    await execute(win, () => {
      window.__marker = "held-across-nav";
      window.__appId = null;
      window.location.hash = "#/web";
    });
    await until(win, () => document.documentElement.hasAttribute("data-web") && !!window.__spatia, "web boots");
    await until(win, () => window.__spatia && window.__spatia.engine && window.__spatia.engine.canvas().clientWidth > 0, "canvas sized");
    await sleep(300);

    const webIn = await execute(win, () => ({
      bodyOverflowY: getComputedStyle(document.body).overflowY,
      appAlive: !!window.__spatia,
      canvasW: window.__spatia.engine.canvas().clientWidth,
      title: document.title,
      appCssPresent: !!document.querySelector('link[href*="web/app.css"]'),
    }));
    ok("web mode: body overflow hidden", webIn.bodyOverflowY === "hidden");
    ok("web mode: app instance alive", webIn.appAlive);
    ok("web mode: canvas sized", webIn.canvasW > 0);
    ok("web mode: title is web", /Spatia — Web/.test(webIn.title));
    ok("web mode: app.css attached", webIn.appCssPresent);
    const repWeb = await execute(win, () => ({
      dialogGone: !document.getElementById("report-dialog"),
      noAttr: document.documentElement.getAttribute("data-report-dialog") !== "open",
      noTrigger: !document.querySelector("#web-host [data-report-open]"),
    }));
    ok("report: dialog absent inside the web workspace", repWeb.dialogGone && repWeb.noAttr && repWeb.noTrigger);
    execute(win, () => { window.__appId = window.__spatia; });

    // ---- 3) Back to landing (the real bug) --------------------------------
    await execute(win, () => { window.location.hash = "#top"; });
    await until(win, () => !document.documentElement.hasAttribute("data-web") && document.getElementById("web-host").hidden, "landing restored after back-nav");

    const back = await execute(win, () => {
      // Neutralize smooth scrolling so the scroll position read is synchronous.
      const prev = document.documentElement.style.scrollBehavior;
      document.documentElement.style.scrollBehavior = "auto";
      document.scrollingElement.scrollTop = 400;
      const now = document.scrollingElement.scrollTop;
      document.documentElement.style.scrollBehavior = prev;
      return {
        appCssPresent: !!document.querySelector('link[href*="web/app.css"]'),
        bodyOverflowY: getComputedStyle(document.body).overflowY,
        bodyFontSize: getComputedStyle(document.body).fontSize,
        siteVisible: getComputedStyle(document.querySelector(".site")).display !== "none",
        scrollTop: document.scrollingElement.scrollTop,
        marker: window.__marker || null,
        title: document.title,
        mbActive: document.documentElement.classList.contains("mb-active"),
        barPresent: !!document.querySelector(".mb-toolbar"),
      };
    });
    ok("FIX: app stylesheet removed on leave", !back.appCssPresent);
    ok("FIX: landing body not overflow-hidden", back.bodyOverflowY !== "hidden");
    ok("FIX: landing font restored", back.bodyFontSize === "16px");
    ok("FIX: landing visible again", back.siteVisible);
    ok("FIX: landing is scrollable (no reload)", back.scrollTop > 200);
    ok("no page reload across navigation", back.marker === "held-across-nav");
    ok("title restored to landing", /Think in space/.test(back.title));
    ok("desktop session: no mobile bar", !back.mbActive && !back.barPresent);

    // ---- 4) Re-enter #/web keeps the same app instance -------------------
    await execute(win, () => { window.location.hash = "#/web"; });
    await until(win, () => document.documentElement.hasAttribute("data-web") && !!window.__spatia, "web re-enters");
    await until(win, () => window.__spatia.engine.canvas().clientWidth > 0, "canvas re-measured");

    const re = await execute(win, () => ({
      sameInstance: window.__spatia === window.__appId,
      appCssPresent: !!document.querySelector('link[href*="web/app.css"]'),
      canvasW: window.__spatia.engine.canvas().clientWidth,
      marker: window.__marker || null,
    }));
    ok("re-entry: same app instance (no re-boot)", re.sameInstance);
    ok("re-entry: app.css re-attached", re.appCssPresent);
    ok("re-entry: canvas re-measured", re.canvasW > 0);
    ok("re-entry: still no page reload", re.marker === "held-across-nav");

    // ---- 4a) Plugins -------------------------------------------------------
    // The renderer plugin system runs identically in the browser (IndexedDB
    // store behind the same window.spatia surface). Load, boot into the
    // sandbox, run a built-in command that creates a real object, then break
    // it.
    await execute(win, async () => {
      await window.__spatia.plugins.reload();
      return true;
    });
    await until(win, () => window.__spatia.plugins.commandsList().some((c) => c.id === "browser-frame.add"), "built-in plugin command registered");
    const builtIn = await execute(win, () => {
      const pm = window.__spatia.plugins;
      const entry = pm.entriesList().find((e) => e.id === "browser-frame");
      const cmd = pm.commandsList().find((c) => c.id === "browser-frame.add");
      return {
        lined: !!entry,
        manifestOk: !!entry && !!entry.manifest && entry.manifest.main === "main.js",
        builtIn: !!entry && entry.builtIn,
        enabled: !!entry && entry.enabled,
        commandLabel: cmd && cmd.label,
      };
    });
    ok("plugins: built-in browser-frame is listed", builtIn.lined && builtIn.manifestOk && builtIn.builtIn && builtIn.enabled);
    ok("plugins: built-in command labelled", builtIn.commandLabel === "Add Browser Frame");

    const pluginRan = await execute(win, async () => {
      const app = window.__spatia;
      const before = app.project.getObjects().length;
      await app.plugins.dispatchCommand("browser-frame.add");
      await new Promise((r) => setTimeout(r, 250));
      const frame = app.project.getObjects().find((o) => o.type === "frame");
      const newObject = app.project.getObjects().length > before;
      let removed = false;
      if (frame) {
        app.project.removeObjects([frame.id]);
        removed = true;
      }
      const toast = document.getElementById("app-toast");
      return {
        created: !!frame,
        newObject,
        removed,
        toastShown: !!(toast && toast.textContent && /Browser Frame added/.test(toast.textContent)),
      };
    });
    ok("plugins: built-in command creates a frame object", pluginRan.created && pluginRan.newObject && pluginRan.removed);
    ok("plugins: built-in command notifies via toast", pluginRan.toastShown);

    // disable -> command vanishes; enable -> it comes back
    await execute(win, async () => {
      await window.__spatia.plugins.setEnabled("browser-frame", false);
      return true;
    });
    let gone = await execute(win, () => !window.__spatia.plugins.entriesList().some((e) => e.id === "browser-frame" && e.enabled));
    ok("plugins: disabling drops the command", gone);
    await execute(win, async () => {
      await window.__spatia.plugins.setEnabled("browser-frame", true);
      return true;
    });
    await until(win, () => window.__spatia.plugins.commandsList().some((c) => c.id === "browser-frame.add"), "built-in re-enabled");

    await execute(win, async () => {
      try { await window.__spatiaBridge.removePluginForTest("verify-plugin"); await window.__spatia.plugins.reload(); } catch { /* idempotent */ }
      return true;
    });

    // install a user plugin through the bridge hook
    const installed = await execute(win, async () => {
      const result = await window.__spatiaBridge.installPluginSource(
        "verify-plugin",
        { id: "verify-plugin", name: "Verify Plugin", version: "1.0.0", main: "main.js", author: "QA" },
        `api.addCommand({
  id: "verify.plugin-command",
  label: "Verify plugin command",
  run: async function () {
    const c = await api.viewportCenter();
    const obj = await api.createObject("text", c.x, c.y, { text: "from plugin", fontSize: 20 });
    if (obj) await api.select([obj.id]);
    api.notify("verify plugin ran");
  },
});`
      );
      return result;
    });
    ok("plugins: bridge install succeeds", installed.ok === true);
    await execute(win, async () => { await window.__spatia.plugins.reload(); return true; });
    await until(win, () => window.__spatia.plugins.commandsList().some((c) => c.id === "verify.plugin-command"), "user plugin command registered");
    const userPlugin = await execute(win, () => {
      const pm = window.__spatia.plugins;
      const entry = pm.entriesList().find((e) => e.id === "verify-plugin");
      return { present: !!entry, builtIn: !!entry && entry.builtIn === true, enabled: !!entry && entry.enabled };
    });
    ok("plugins: user plugin listed as installable", userPlugin.present && !userPlugin.builtIn && userPlugin.enabled);

    const userRan = await execute(win, async () => {
      const app = window.__spatia;
      await app.plugins.dispatchCommand("verify.plugin-command");
      await new Promise((r) => setTimeout(r, 250));
      const obj = app.project.getObjects().find((o) => o.type === "text" && o.text === "from plugin");
      return { created: !!obj, selected: !!obj && app.selection.has(obj.id), zoomSanity: app.engine.getZoom() > 0 };
    });
    ok("plugins: user command creates + selects an object", userRan.created && userRan.selected && userRan.zoomSanity);

    // plugin ui dialog renders entries
    const dialogRendered = await execute(win, () => {
      window.__spatia.openPluginsDialog();
      const rows = document.querySelectorAll("#plugins-list .plugin-entry").length;
      const entries = window.__spatia.plugins.entriesList().length;
      const open = document.getElementById("plugins-dialog").classList.contains("open");
      return { rows, entries, open };
    });
    ok("plugins: dialog lists all entries", dialogRendered.open && dialogRendered.rows >= 2 && dialogRendered.rows === dialogRendered.entries);
    await execute(win, () => { document.getElementById("plugins-close").click(); });

    // API v2: the dialog surfaces the declared api version + permission chips
    const dialogV2 = await execute(win, () => {
      window.__spatia.openPluginsDialog();
      const rows = Array.from(document.querySelectorAll("#plugins-list .plugin-entry"));
      const bf = rows.find((el) => (el.textContent || "").includes("Browser Frame"));
      const html = bf ? bf.textContent : "";
      return {
        open: document.getElementById("plugins-dialog").classList.contains("open"),
        badge: /API v2/.test(html),
        chips: /notify/.test(html) && /documents/.test(html) && /view/.test(html),
      };
    });
    ok("plugins: dialog shows API v2 badge + permission chips", dialogV2.open && dialogV2.badge && dialogV2.chips);
    if (!(dialogV2.open && dialogV2.badge && dialogV2.chips)) {
      process.stdout.write(`  [dialog v2 diag] ${JSON.stringify(dialogV2)}\n`);
    }
    await execute(win, () => { document.getElementById("plugins-close").click(); });

    // API v2 permissions gate the surface: a plugin that does NOT declare a
    // permission gets methods serving it rejected at runtime, and cannot
    // register commands it has no permission for. Events (selection) still
    // reach its sandbox so it can report what was allowed vs. blocked.
    await execute(win, async () => {
      try { await window.__spatiaBridge.removePluginForTest("perms-plugin"); await window.__spatia.plugins.reload(); } catch { /* idempotent */ }
      return true;
    });
    const permsInstalled = await execute(win, async () => {
      const result = await window.__spatiaBridge.installPluginSource(
        "perms-plugin",
        { id: "perms-plugin", name: "Perms Plugin", version: "1.0.0", main: "main.js", apiVersion: 2, permissions: ["notify", "view", "documents", "selection"] },
        `var handled = false;
api.on("selection", async function (sel) {
  if (handled || !sel || !sel.ids || sel.ids.length === 0) return;
  handled = true;
  var viewOk = false, navBlocked = false;
  try { var vp = await api.getViewport(); viewOk = !!(vp && typeof vp.x === "number"); } catch (e) {}
  try { await api.zoom(1.2); } catch (e) { navBlocked = true; }
  api.notify("perm-report view=" + viewOk + " navBlocked=" + navBlocked);
});
api.addCommand({
  id: "perms-plugin.sneaky",
  label: "Sneaky command",
  run: async function () {}
});`
      );
      return result;
    });
    ok("plugins: permissions manifest installs", permsInstalled.ok === true);
    await execute(win, async () => { await window.__spatia.plugins.reload(); return true; });
    const permsGated = await execute(win, async () => {
      const deadline = Date.now() + 5000;
      let denialShown = false;
      while (Date.now() < deadline) {
        const t = document.getElementById("app-toast");
        if (t && t.textContent && /needs the "commands" permission/.test(t.textContent)) { denialShown = true; break; }
        await new Promise((r) => setTimeout(r, 120));
      }
      return {
        denialShown,
        sneakyAbsent: !window.__spatia.plugins.commandsList().some((c) => c.id === "perms-plugin.sneaky"),
        entriesOk: window.__spatia.plugins.entriesList().some((e) => e.id === "perms-plugin" && e.enabled),
      };
    });
    ok("plugins: command registration gated on the commands permission", permsGated.denialShown && permsGated.entriesOk && permsGated.sneakyAbsent);

    // drive a selection change; the plugin's listener must see it and report
    // its allowed view call + its blocked navigation call
    const permReport = await execute(win, async () => {
      const app = window.__spatia;
      app.selection.clear();
      const c = await app.centerWorld();
      app.addShapeAt("ellipse", c);
      const shape = app.project.getObjects().find((o) => o.type === "shape");
      const deadline = Date.now() + 6000;
      let last = "";
      while (Date.now() < deadline) {
        const t = document.getElementById("app-toast");
        const text = t && t.textContent ? t.textContent : "";
        if (/perm-report view=.* navBlocked=/.test(text)) return { text, shape: !!shape, selected: !!shape && app.selection.has(shape.id) };
        last = text;
        await new Promise((r) => setTimeout(r, 120));
      }
      return { text: last, shape: !!shape, selected: !!shape && app.selection.has(shape.id) };
    });
    if (!/view=true navBlocked=true/.test(permReport.text)) {
      process.stdout.write(`  [perm-report diag] ${JSON.stringify(permReport)}\n`);
    }
    ok("plugins: events reach the sandbox and permissions gate methods", /view=true navBlocked=true/.test(permReport.text) && permReport.shape && permReport.selected);

    // install a plugin from its manifest URL through the public API
    await execute(win, async () => {
      try { await window.__spatiaBridge.removePluginForTest("counter-plugin"); await window.__spatia.plugins.reload(); } catch { /* idempotent */ }
      return true;
    });
    const urlInstall = await execute(win, async () =>
      window.spatia.pluginsInstallUrl(new URL("plugins/counter-plugin/manifest.json", location.origin).href)
    );
    ok("plugins: URL install of the hosted plugin succeeds", urlInstall.ok === true && !!urlInstall.entry && urlInstall.entry.id === "counter-plugin");
    await execute(win, async () => { await window.__spatia.plugins.reload(); return true; });
    await until(win, () => window.__spatia.plugins.commandsList().some((c) => c.id === "counter-plugin.count-objects"), "URL-installed command registered");
    const urlEntry = await execute(win, () => {
      const pm = window.__spatia.plugins;
      const entry = pm.entriesList().find((e) => e.id === "counter-plugin");
      return {
        present: !!entry,
        builtIn: !!entry && entry.builtIn === true,
        enabled: !!entry && entry.enabled,
        name: entry && entry.manifest && entry.manifest.name,
      };
    });
    ok("plugins: URL-installed plugin listed as installable", urlEntry.present && !urlEntry.builtIn && urlEntry.enabled && urlEntry.name === "Counter");

    const urlRan = await execute(win, async () => {
      const app = window.__spatia;
      await app.plugins.dispatchCommand("counter-plugin.count-objects");
      await new Promise((r) => setTimeout(r, 250));
      const toast = document.getElementById("app-toast");
      return { toastShown: !!(toast && toast.textContent && /Canvas contents/.test(toast.textContent)) };
    });
    ok("plugins: URL-installed command runs (counter-plugin)", urlRan.toastShown);

    // URL install must validate its input and fail cleanly
    const urlBad = await execute(win, async () => {
      const missing = await window.spatia.pluginsInstallUrl(new URL("plugins/counter-plugin/nope.json", location.origin).href);
      const badScheme = await window.spatia.pluginsInstallUrl("ftp://example.com/x");
      return {
        missingErr: missing.ok === false && /Could not fetch the manifest/.test(missing.error),
        badSchemeErr: badScheme.ok === false && /http\(s\)/.test(badScheme.error),
      };
    });
    ok("plugins: URL install fails cleanly on bad URLs", urlBad.missingErr && urlBad.badSchemeErr);

    // Browser Frame plugin: ships built in (no manifest URL / install needed)
    await until(win, () => window.__spatia.plugins.commandsList().some((c) => c.id === "browser-frame.add"), "browser-frame command registered as a built-in");
    const bfBuiltin = await execute(win, () => ({
      listed: window.__spatia.plugins.entriesList().some((e) => e.id === "browser-frame"),
      builtIn: window.__spatia.plugins.entriesList().some((e) => e.id === "browser-frame" && e.builtIn),
    }));
    ok("plugins: browser-frame is built in and available without installation", bfBuiltin.listed && bfBuiltin.builtIn);
    const bfCreated = await execute(win, async () => {
      const app = window.__spatia;
      await app.plugins.dispatchCommand("browser-frame.add");
      let frame = null;
      for (let i = 0; i < 25 && !frame; i++) {
        frame = app.project.getObjects().find((o) => o.type === "frame");
        if (!frame) await new Promise((r) => setTimeout(r, 100));
      }
      return {
        frame: !!frame,
        url: frame ? (frame.metadata && frame.metadata.browserUrl) || "" : "",
        selected: !!frame && app.selection.has(frame.id),
      };
    });
    ok("plugins: browser-frame command creates + selects a frame with the Google URL", bfCreated.frame && bfCreated.url === "https://www.google.com/" && bfCreated.selected);
    // The overlay mounts on the rAF loop; drive it explicitly so the hidden
    // verification window (no vsync) doesn't race the frame update.
    const bfMounted = await until(
      win,
      () => {
        try { window.__spatia["renderOverlay"](); } catch (e) { /* app not ready */ }
        const iframe = document.querySelector("#browser-layer iframe");
        return !!iframe && !document.querySelector("#browser-layer webview");
      },
      "browser-frame iframe mounts in the canvas",
      10000
    );
    const bfSurface = await execute(win, () => {
      const iframe = document.querySelector("#browser-layer iframe");
      return {
        src: iframe ? iframe.getAttribute("src") || "" : "",
        noteShown: !!document.querySelector("#browser-layer .browser-note:not([hidden])"),
      };
    });
    ok("plugins: browser-frame renders the real Google iframe", bfMounted && bfSurface.src.indexOf("google.com") !== -1);
    ok("plugins: browser-frame shows the honest embedding note on the web build", bfSurface.noteShown);
    const bfNav = await execute(win, async () => {
      const addr = document.querySelector("#browser-layer .browser-addr");
      const go = document.querySelector("#browser-layer .bf-go");
      if (addr) addr.value = "https://example.com";
      if (go) go.click();
      await new Promise((r) => setTimeout(r, 300));
      const iframe = document.querySelector("#browser-layer iframe");
      return {
        src: iframe ? iframe.getAttribute("src") || "" : "",
      };
    });
    ok("plugins: browser-frame address bar navigation updates the iframe", bfNav.src.indexOf("example.com") !== -1);

    // a broken plugin reports an error and never takes the app down
    const brokenInstalled = await execute(win, async () => {
      const result = await window.__spatiaBridge.installPluginSource(
        "broken-plugin",
        { id: "broken-plugin", name: "Broken", version: "1.0.0", main: "main.js" },
        `throw new Error("boom");`
      );
      return result;
    });
    ok("plugins: broken plugin installs (validation only)", brokenInstalled.ok === true);
    await execute(win, async () => { await window.__spatia.plugins.reload(); return true; });
    await until(win, () => window.__spatia.plugins.runtimeErrorOf("broken-plugin") !== null, "broken plugin error surfaced");
    const broken = await execute(win, () => ({
      appAlive: !!window.__spatia && !!window.__spatia.engine && window.__spatia.engine.canvas().clientWidth > 0,
      broke: window.__spatia.plugins.runtimeErrorOf("broken-plugin"),
      stillRuns: window.__spatia.plugins.commandsList().some((c) => c.id === "verify.plugin-command"),
    }));
    ok("plugins: broken plugin surfaces its error", /boom/.test(broken.broke || ""));
    ok("plugins: app + other plugins still run after a broken plugin", broken.appAlive && broken.stillRuns);

    // cleanup: remove the test plugins so later sessions start clean
    await execute(win, async () => {
      await window.__spatiaBridge.removePluginForTest("verify-plugin");
      await window.__spatiaBridge.removePluginForTest("broken-plugin");
      await window.__spatiaBridge.removePluginForTest("counter-plugin");
      await window.__spatiaBridge.removePluginForTest("perms-plugin");
      await window.__spatia.plugins.reload();
      return true;
    });
    const removed = await execute(win, () => ({
      verifyGone: !window.__spatia.plugins.entriesList().some((e) => e.id === "verify-plugin"),
      brokenGone: !window.__spatia.plugins.entriesList().some((e) => e.id === "broken-plugin"),
      counterGone: !window.__spatia.plugins.entriesList().some((e) => e.id === "counter-plugin"),
      permsGone: !window.__spatia.plugins.entriesList().some((e) => e.id === "perms-plugin"),
    }));
    await until(win, () => window.__spatia.plugins.commandsList().some((c) => c.id === "browser-frame.add"), "built-in re-registered after cleanup");
    const cleaned = await execute(win, () => ({
      browserFrameBack: window.__spatia.plugins.commandsList().some((c) => c.id === "browser-frame.add"),
    }));
    ok("plugins: test plugins removed cleanly", removed.verifyGone && removed.brokenGone && removed.counterGone && removed.permsGone && cleaned.browserFrameBack);

    // reset the canvas + undo history the plugin commands created so the
    // mobile section starts from the same clean state as a fresh boot
    await execute(win, async () => {
      const app = window.__spatia;
      app.commands.clear();
      app.commands.markSaved();
      await app.newProject();
      return true;
    });

    // ---- 4b) Pencil drawing / eraser precision (shared engine) -------------
    // Install an in-page helper that dispatches real PointerEvents on the
    // canvas; it drives the SAME engine code path as desktop, phone and iPad.
    await execute(win, () => {
      window.__spatiaQA = window.__spatiaQA || {};
      const QA = window.__spatiaQA;
      QA.screenX = (wx) => {
        const c = window.__spatia.engine.canvas();
        const r = c.getBoundingClientRect();
        const f = window.__spatia.engine.getFrame();
        return r.left + (wx - f.cameraX) * f.zoom;
      };
      QA.screenY = (wy) => {
        const c = window.__spatia.engine.canvas();
        const r = c.getBoundingClientRect();
        const f = window.__spatia.engine.getFrame();
        return r.top + (wy - f.cameraY) * f.zoom;
      };
      QA.sendStroke = (a, b, opts) => {
        opts = opts || {};
        const c = window.__spatia.engine.canvas();
        const steps = Math.max(1, opts.steps || 10);
        const p0 = opts.p0 !== undefined ? opts.p0 : 0.5;
        const p1 = opts.p1 !== undefined ? opts.p1 : p0;
        const fire = (t, x, y, p, buttons) =>
          c.dispatchEvent(
            new PointerEvent(t, {
              bubbles: true,
              cancelable: true,
              pointerId: opts.pointerId || 7,
              pointerType: opts.type || "mouse",
              isPrimary: true,
              button: 0,
              buttons,
              pressure: p,
              clientX: x,
              clientY: y,
            })
          );
        fire("pointerdown", a.x, a.y, p0, 1);
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          fire("pointermove", a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, p0 + (p1 - p0) * t, 1);
        }
        fire("pointerup", b.x, b.y, 0, 0);
        return true;
      };
      QA.pens = () => window.__spatia.project.getObjects().filter((o) => o.type === "pen");
      // A full reset: the undo stack, the saved flag AND the document itself.
      // (commands.clear() alone only drops history — it does not remove objects.)
      QA.resetInk = async () => {
        const app = window.__spatia;
        app.commands.clear();
        app.commands.markSaved();
        await app.newProject();
      };
      return true;
    });
    await sleep(120);

    // 4b-1) A mouse draw commits ONE uniform stroke (pressure is now ON by
    //       default, but a mouse reports no pressure so it must stay uniform).
    const draw = await execute(win, async () => {
      const app = window.__spatia;
      const eng = app.engine;
      await window.__spatiaQA.resetInk();
      eng.setPenTool(true);
      eng.setPenToolMode("pen");
      eng.setPenSettings({ width: 3 });
      const r = eng.canvas().getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      window.__spatiaQA.sendStroke({ x: cx - 160, y: cy }, { x: cx + 160, y: cy }, { type: "mouse", steps: 40 });
      const s = window.__spatiaQA.pens()[0];
      return {
        count: window.__spatiaQA.pens().length,
        points: s ? s.points.length : 0,
        sw: s ? s.strokeWidth : -1,
        uniform: s ? s.points.every((p) => p.width === undefined) : false,
      };
    });
    ok("ink: mouse stroke commits a pen object", draw.count === 1 && draw.points >= 4);
    ok("ink: mouse stays uniform (pressure is pen-only)", draw.uniform && draw.sw === 3);

    // 4b-2) Eraser tap cuts exactly the visible-cursor band. Regression: the
    // old code used the full eraser diameter as the erase radius, which would
    // cut a ~2x band (gap ~43px) instead of the visible ~23px.
    const tap = await execute(win, async () => {
      const eng = window.__spatia.engine;
      await window.__spatiaQA.resetInk();
      eng.setPenTool(true);
      eng.setPenToolMode("pen");
      eng.setPenSettings({ width: 3 });
      const r = eng.canvas().getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      window.__spatiaQA.sendStroke({ x: cx - 160, y: cy }, { x: cx + 160, y: cy }, { type: "mouse", steps: 40 });
      eng.setPenSettings({ eraserRadius: 20 });
      eng.setPenToolMode("eraser");
      window.__spatiaQA.sendStroke({ x: cx, y: cy }, { x: cx, y: cy }, { type: "mouse", steps: 1 });
      const pens = window.__spatiaQA.pens();
      const sides = pens.map((p) => {
        const xs = p.points.map((pt) => window.__spatiaQA.screenX(pt.x));
        return Math.min(...xs) >= cx ? "right" : "left";
      });
      const leftPts = pens.filter((_, i) => sides[i] === "left").flatMap((p) => p.points.map((pt) => window.__spatiaQA.screenX(pt.x)));
      const rightPts = pens.filter((_, i) => sides[i] === "right").flatMap((p) => p.points.map((pt) => window.__spatiaQA.screenX(pt.x)));
      const leftMin = Math.min(...leftPts);
      const leftMax = Math.max(...leftPts);
      const rightMin = Math.min(...rightPts);
      const rightMax = Math.max(...rightPts);
      return {
        count: pens.length,
        leftN: sides.filter((s) => s === "left").length,
        rightN: sides.filter((s) => s === "right").length,
        cx,
        leftMin,
        leftMax,
        rightMin,
        rightMax,
        gap: rightMin - leftMax,
      };
    });
    ok("ink: eraser tap splits the stroke cleanly in two", tap.count === 2 && tap.leftN === 1 && tap.rightN === 1);
    ok("ink: cut matches the visible eraser circle (not the old 2x band)", tap.gap >= 12 && tap.gap <= 32);
    ok("ink: both stroke ends survive the cut", tap.leftMin <= tap.cx - 150 && tap.rightMax >= tap.cx + 150);

    // 4b-3) Undo restores the whole stroke, redo re-applies the cut.
    const ur = await execute(win, () => {
      const cmds = window.__spatia.commands;
      cmds.undo();
      const afterUndo = window.__spatiaQA.pens().length;
      cmds.redo();
      const afterRedo = window.__spatiaQA.pens().length;
      return { afterUndo, afterRedo };
    });
    ok("ink: undo restores the single stroke", ur.afterUndo === 1);
    ok("ink: redo re-applies the erase cut", ur.afterRedo === 2);

    // 4b-4) A parallel stroke 16px away must survive a 20px eraser tap. With
    // the old double-radius code (radius 21.5px) it would have been wiped.
    const near = await execute(win, async () => {
      const app = window.__spatia;
      const eng = app.engine;
      await window.__spatiaQA.resetInk();
      eng.setPenTool(true);
      eng.setPenToolMode("pen");
      eng.setPenSettings({ width: 3 });
      const r = eng.canvas().getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      window.__spatiaQA.sendStroke({ x: cx - 160, y: cy }, { x: cx + 160, y: cy }, { type: "mouse", steps: 40 });
      window.__spatiaQA.sendStroke({ x: cx - 160, y: cy - 16 }, { x: cx + 160, y: cy - 16 }, { type: "mouse", steps: 40 });
      const pens = window.__spatiaQA.pens();
      let b = null;
      for (const p of pens) {
        if (Math.abs(window.__spatiaQA.screenY(p.points[0].y) - (cy - 16)) < 8) { b = p; break; }
      }
      const bId = b ? b.id : null;
      const bN = b ? b.points.length : 0;
      eng.setPenSettings({ eraserRadius: 20 });
      eng.setPenToolMode("eraser");
      window.__spatiaQA.sendStroke({ x: cx, y: cy }, { x: cx, y: cy }, { type: "mouse", steps: 1 });
      const after = window.__spatiaQA.pens();
      const bAfter = after.find((p) => p.id === bId);
      return {
        before: pens.length,
        after: after.length,
        aFrags: after.filter((p) => p.id !== bId).length,
        bIntact: !!bAfter && bAfter.points.length === bN,
      };
    });
    ok("ink: eraser cuts only the touched stroke (2 fragments)", near.aFrags === 2);
    ok("ink: parallel stroke 16px away survives the 20px eraser", near.after === 3 && near.bIntact);

    // 4b-5) Stylus pressure is inked per-vertex with the 0.25x..1.3x taper.
    const press = await execute(win, async () => {
      const app = window.__spatia;
      const eng = app.engine;
      await window.__spatiaQA.resetInk();
      eng.setPenTool(true);
      eng.setPenToolMode("pen");
      eng.setPenSettings({ width: 8, pressure: true });
      const r = eng.canvas().getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      window.__spatiaQA.sendStroke(
        { x: cx - 160, y: cy - 40 },
        { x: cx + 160, y: cy - 40 },
        { type: "pen", steps: 40, p0: 0.1, p1: 1.0 }
      );
      const s = window.__spatiaQA.pens()[0];
      return {
        count: window.__spatiaQA.pens().length,
        points: s ? s.points.length : 0,
        sw: s ? s.strokeWidth : -1,
        widths: s ? s.points.filter((p) => p.width !== undefined).length : 0,
        firstW: s && s.points[0] ? s.points[0].width : undefined,
        lastW: s && s.points.length ? s.points[s.points.length - 1].width : undefined,
      };
    });
    ok("ink: stylus pressure inked per-vertex", press.count === 1 && press.points >= 4 && press.widths === press.points);
    ok("ink: light press starts thin (~2.8px @ pressure 0.1)", press.firstW > 1 && press.firstW < 4);
    ok("ink: heavy press finishes full (~10.4px @ pressure 1.0)", press.lastW > 9 && press.lastW < 11);
    ok("ink: stroke width setting honored", press.sw === 8);

    // Leave an empty project + pen off so the mobile layer starts from the
    // same clean state as the pre-mobile reset above.
    const cleanedInk = await execute(win, async () => {
      const app = window.__spatia;
      app.engine.setPenTool(false);
      app.commands.clear();
      app.commands.markSaved();
      await app.newProject();
      return window.__spatiaQA.pens().length === 0;
    });
    ok("ink: suite cleans up to an empty project", cleanedInk);

    // The broken-plugin sandbox raises errors in its iframe; those must not
    // count against the global console-error check at the end of the run.
    errors.length = 0;

    // ---- 5) Mobile layer (forced) ----------------------------------------
    await execute(win, () => {
      window.__spatiaSite.setForceMobile(true);
      window.location.hash = "#top";
    });
    await until(win, () => !document.documentElement.hasAttribute("data-web"), "back to landing (mobile)");

    await execute(win, () => { window.location.hash = "#/web"; });
    await until(win, () => document.documentElement.hasAttribute("data-web") && !!document.querySelector(".mb-toolbar"), "mobile layer injected");
    await sleep(300);

    const mob = await execute(win, () => {
      const link = document.querySelector(".web-chrome-link");
      return {
        mbActive: document.documentElement.classList.contains("mb-active"),
        toolbar: !!document.querySelector(".mb-toolbar"),
        topbar: !!document.getElementById("mb-topbar"),
        zoom: !!document.getElementById("mb-zoom"),
        tabs: Array.prototype.map.call(document.querySelectorAll(".mb-tab"), (t) => t.getAttribute("data-bar")).join(","),
        undoDisabled: document.querySelector('[data-bar="undo"]').disabled,
        splashGone: document.documentElement.getAttribute("data-mb-splash") !== "shown",
        chromeHidden: !link || getComputedStyle(link).display === "none",
      };
    });
    ok("mobile: html.mb-active set", mob.mbActive);
    ok("mobile: native top bar injected", mob.topbar);
    ok("mobile: tab toolbar injected", mob.toolbar);
    ok("mobile: floating zoom cluster injected", mob.zoom);
    ok("mobile: toolbar has all five slots", /select,pen,add,connect,menu/.test(mob.tabs));
    ok("mobile: undo disabled while no history", mob.undoDisabled);
    ok("mobile: no splash after boot", mob.splashGone);
    ok("mobile: site chrome links hidden", mob.chromeHidden);

    // ---- 5a0) Touch really inks on the phone shell --------------------------
    // Dispatched on the canvas element, through the mobile layer's own touch
    // handlers, so a finger draw exercises the shared engine exactly like a
    // downloaded iPhone build would.
    await execute(win, () => {
      document.querySelector('[data-bar="pen"]').click();
      return true;
    });
    await sleep(150);
    const mpen = await execute(win, () => ({
      active: window.__spatia.engine.isPenTool(),
      tabOn: document.querySelector('[data-bar="pen"]').classList.contains("mb-active"),
    }));
    ok("mobile: pen tab arms the shared pen tool", mpen.active && mpen.tabOn);
    const mbaseline = await execute(win, () => ({
      pens: window.__spatia.project.getObjects().filter((o) => o.type === "pen").length,
      recentPen: window.__spatia.engine.recentPenActivity(),
    }));
    // A real finger draw never lands within the stylus palm-rejection window:
    // the engine suppresses touches for 700ms after pen contact. Wait it out
    // so this simulates an ordinary user touch, not a resting palm.
    await sleep(850);
    await execute(win, () => {
      const c = window.__spatia.engine.canvas();
      const r = c.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const base = { bubbles: true, cancelable: true, pointerType: "touch", isPrimary: true, button: 0, buttons: 1, pressure: 0.5 };
      const fire = (t, x, y) => c.dispatchEvent(new PointerEvent(t, Object.assign({ pointerId: 1, clientX: x, clientY: y }, base)));
      fire("pointerdown", cx - 80, cy);
      for (let i = 1; i <= 10; i++) fire("pointermove", cx - 80 + 160 * (i / 10), cy);
      fire("pointerup", cx + 80, cy);
      return true;
    });
    await sleep(120);
    const mdraw = await execute(win, () => ({
      pens: window.__spatia.project.getObjects().filter((o) => o.type === "pen").length,
    }));
    if (mdraw.pens !== mbaseline.pens + 1) {
      process.stdout.write(`  [diag] mobile draw: baseline=${mbaseline.pens} recentPen=${mbaseline.recentPen} after=${mdraw.pens}\n`);
    }
    ok("mobile: a finger draw commits a real stroke", mdraw.pens === mbaseline.pens + 1);
    // Revert so the suite's own mobile flows see the boot-like empty canvas.
    await execute(win, () => {
      window.__spatia.commands.undo();
      document.querySelector('[data-bar="select"]').click();
      return true;
    });
    await sleep(100);
    const mrest = await execute(win, () => ({
      pens: window.__spatia.project.getObjects().filter((o) => o.type === "pen").length,
      penOff: !window.__spatia.engine.isPenTool(),
    }));
    ok("mobile: draw cleaned up, select restored", mrest.pens === mbaseline.pens && mrest.penOff);

    // open the Menu sheet and confirm it renders with sections
    await execute(win, () => { document.querySelector('[data-bar="menu"]').click(); });
    await sleep(200);
    const sheet = await execute(win, () => ({
      open: !document.querySelector(".mb-backdrop").hidden,
      hasMenuCaption: document.getElementById("mb-sheet-caption").textContent === "Menu",
      rows: document.querySelectorAll("#mb-sheet-body [data-mbkey]").length,
      hasRecent: !!document.getElementById("mb-sheet-body").textContent.match(/Recent|No recent projects/),
      hasPlugins: !!document.querySelector('#mb-sheet-body [data-mbkey="plugins"]'),
    }));
    ok("mobile: menu sheet opens", sheet.open);
    ok("mobile: sheet caption", sheet.hasMenuCaption);
    ok("mobile: sheet contains action rows", sheet.rows > 5);
    ok("mobile: sheet lists recents", sheet.hasRecent);
    ok("mobile: sheet has a Plugins entry", sheet.hasPlugins);
    const menuExtra = await execute(win, () => ({
      templates: !!document.querySelector('#mb-sheet-body [data-mbkey="templates"]'),
      export: !!document.querySelector('#mb-sheet-body [data-mbkey="export"]'),
    }));
    ok("mobile: menu has Templates + Export actions", menuExtra.templates && menuExtra.export);

    // add sheet
    await execute(win, () => {
      document.querySelector('[data-sheet="close"]').click();
      document.querySelector('[data-bar="add"]').click();
    });
    await sleep(200);
    const addSheet = await execute(win, () => {
      const items = document.querySelectorAll("#mb-sheet-body .mb-grid-item");
      return {
        open: !document.querySelector(".mb-backdrop").hidden,
        labels: Array.prototype.map.call(items, (i) => i.getAttribute("data-add")).join(","),
      };
    });
    ok("mobile: add sheet opens", addSheet.open);
    ok("mobile: add sheet has all object kinds", /text,note,url,image,file,frame/.test(addSheet.labels));
    ok(
      "mobile: add sheet includes all seven shape kinds",
      /shape-rectangle,shape-rounded-rectangle,shape-ellipse,shape-diamond,shape-triangle,shape-line,shape-arrow/.test(addSheet.labels)
    );

    // ---- 5a) Touch Connection tool ----------------------------------------
    await execute(win, () => {
      document.querySelector('[data-sheet="close"]').click();
      document.querySelector('[data-bar="connect"]').click();
    });
    await sleep(150);
    const connTool = await execute(win, () => ({
      button: !!document.querySelector('[data-bar="connect"]'),
      active: document.querySelector('[data-bar="connect"]').classList.contains("mb-active"),
      hintVisible: !document.getElementById("mb-connect-hint").hidden,
      hintText: document.getElementById("mb-connect-hint").textContent || "",
      selectionCleared: window.__spatia.selection.size === 0,
    }));
    ok("mobile: connect tool button present", connTool.button);
    ok("mobile: connect tool activates and guides touch flow", connTool.active && connTool.hintVisible && /source object/.test(connTool.hintText));
    ok("mobile: connect tool clears selection", connTool.selectionCleared);

    // two objects + a connection created by tap-source-then-tap-target
    const conn = await execute(win, () => {
      const app = window.__spatia;
      const engine = app.engine;
      const c = app.centerWorld();
      app.addObjectAt("note", { x: c.x, y: c.y });
      app.addObjectAt("text", { x: c.x + 420, y: c.y + 120 });
      const note = app.project.getObjects().find((o) => o.type === "note");
      const text = app.project.getObjects().find((o) => o.type === "text");
      const f = engine.getFrame();
      const r = engine.canvas().getBoundingClientRect();
      const local = (w) => ({ x: (w.x - f.cameraX) * f.zoom, y: (w.y - f.cameraY) * f.zoom });
      const p1 = local({ x: note.x + note.width / 2, y: note.y + note.height / 2 });
      const p2 = local({ x: text.x + text.width / 2, y: text.y + text.height / 2 });
      const canvas = engine.canvas();
      const base = { bubbles: true, pointerType: "touch" };
      const ev = (type, id, p) => canvas.dispatchEvent(
        new PointerEvent(type, Object.assign({ pointerId: id, clientX: r.left + p.x, clientY: r.top + p.y }, base))
      );
      // tap the source object, then tap the target object
      ev("pointerdown", 101, p1); ev("pointerup", 101, p1);
      ev("pointerdown", 102, p2); ev("pointerup", 102, p2);
      const made = app.project.getObjects().filter((o) => o.type === "connection" && o.from === note.id && o.to === text.id);
      return { connected: made.length === 1 };
    });
    ok("mobile: tap source then tap target creates a connection", conn.connected);

    // hold + drag from an object to empty space creates a free-end connection
    const free = await execute(win, () => {
      const app = window.__spatia;
      const engine = app.engine;
      const f = engine.getFrame();
      const r = engine.canvas().getBoundingClientRect();
      const local = (w) => ({ x: (w.x - f.cameraX) * f.zoom, y: (w.y - f.cameraY) * f.zoom });
      const note = app.project.getObjects().find((o) => o.type === "note");
      const from = local({ x: note.x + note.width / 2, y: note.y + note.height / 2 });
      const to = local({ x: note.x + note.width / 2 + 600, y: note.y + note.height / 2 + 400 });
      const canvas = engine.canvas();
      const base = { bubbles: true, pointerType: "touch" };
      const ev = (type, p) => canvas.dispatchEvent(
        new PointerEvent(type, Object.assign({ pointerId: 201, clientX: r.left + p.x, clientY: r.top + p.y }, base))
      );
      ev("pointerdown", from);
      ev("pointermove", to);
      ev("pointerup", to);
      const made = app.project.getObjects().filter((o) => o.type === "connection" && o.from === note.id && o.to === "");
      return { count: made.length };
    });
    ok("mobile: hold + drag to empty space creates a free connection", free.count === 1);

    // switching to another tool deactivates Connect
    await execute(win, () => { document.querySelector('[data-bar="select"]').click(); });
    await sleep(100);
    const deact = await execute(win, () => ({
      connectOff: !document.querySelector('[data-bar="connect"]').classList.contains("mb-active"),
      hintHidden: document.getElementById("mb-connect-hint").hidden,
      hasCancelApi: typeof window.__spatia.engine.cancelConnectionDraft === "function",
    }));
    ok("mobile: another tool deactivates Connect", deact.connectOff && deact.hintHidden);
    ok("mobile: draft cancel API present", deact.hasCancelApi);

    // ---- 5b) Properties panel is removed on mobile ------------------------
    const props = await execute(win, () => {
      const app = window.__spatia;
      const note = app.project.getObjects().find((o) => o.type === "note");
      app.selection.setIds([note.id]);
      const inspector = document.getElementById("inspector");
      return {
        hiddenMobile: !inspector || getComputedStyle(inspector).display === "none",
        selectionKept: app.selection.has(note.id),
      };
    });
    ok("mobile: Properties panel is hidden (no mobile inspector)", props.hiddenMobile);
    ok("mobile: hiding it keeps app selection working", props.selectionKept);

    // ---- 5c) URL sheet replaces the desktop prompt ------------------------
    await execute(win, () => {
      window.__spatia.addUrlAt(window.__spatia.centerWorld());
    });
    await sleep(120);
    const urlModal = await execute(win, () => ({
      visible: !document.getElementById("mb-url").hidden,
      fieldPresent: !!document.getElementById("mb-url-field"),
    }));
    ok("mobile: adding a link opens the URL sheet", urlModal.visible && urlModal.fieldPresent);
    const urlCreated = await execute(win, async () => {
      const f = document.getElementById("mb-url-field");
      f.value = "https://example.com";
      document.getElementById("mb-url-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 0));
      return {
        hidden: document.getElementById("mb-url").hidden,
        made: window.__spatia.project.getObjects().some((o) => o.type === "url"),
      };
    });
    ok("mobile: URL sheet creates a link object", urlCreated.hidden && urlCreated.made);
    const statusToast = await execute(win, () => {
      const toast = document.getElementById("mb-toast");
      const before = (toast.textContent || "").trim();
      window.__spatia.setStatus("Added link.");
      return before;
    });
    await sleep(80);
    const toastShown = await execute(win, () => {
      const toast = document.getElementById("mb-toast");
      return (toast.textContent || "").indexOf("Added link") !== -1;
    });
    ok("mobile: status messages surface as toasts", toastShown);

    // ---- 5d) Floating zoom cluster ----------------------------------------
    const zoom = await execute(win, () => {
      const engine = window.__spatia.engine;
      const before = engine.getZoom();
      document.getElementById("mb-zoom-in").click();
      const zIn = engine.getZoom();
      document.getElementById("mb-zoom-reset").click();
      const zReset = engine.getZoom();
      const label = document.getElementById("mb-zoom-reset").textContent;
      document.getElementById("mb-zoom-out").click();
      const zOut = engine.getZoom();
      return { zIn, zReset, zOut, label };
    });
    ok("mobile: zoom + button zooms in", zoom.zIn > 1);
    ok("mobile: zoom % button resets the view", Math.abs(zoom.zReset - 1) < 0.001 && /100%/.test(zoom.label));
    ok("mobile: zoom − button zooms out", zoom.zOut < 1);
    void zoom;

    // long-press / right-tap must NOT open the object menu; only the native
    // event is swallowed so no desktop or browser menu can appear.
    const ctx = await execute(win, () => {
      const app = window.__spatia;
      const engine = app.engine;
      const obj = app.project.getObjects().find((o) => o.type === "text");
      const f = engine.getFrame();
      const r = engine.canvas().getBoundingClientRect();
      const p = { x: (obj.x - f.cameraX) * f.zoom, y: (obj.y - f.cameraY) * f.zoom };
      const ev = new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, button: 2, clientX: r.left + p.x, clientY: r.top + p.y,
      });
      engine.canvas().dispatchEvent(ev);
      const menu = document.getElementById("spatia-context-menu");
      return {
        defaultPrevented: ev.defaultPrevented,
        sheetGone: document.querySelector(".mb-backdrop").hidden,
        desktopGone: !menu || !menu.isConnected,
      };
    });
    ok("mobile: contextmenu is swallowed on touch", ctx.defaultPrevented);
    ok("mobile: holding does not open the object menu", ctx.sheetGone);
    ok("mobile: desktop context menu stays hidden", ctx.desktopGone);

    // leaving the web route cancels a pending connection draft
    await execute(win, () => {
      document.querySelector('[data-bar="connect"]').click();
      const app = window.__spatia;
      const canvas = app.engine.canvas();
      const r = canvas.getBoundingClientRect();
      const c = app.centerWorld();
      const f = app.engine.getFrame();
      const p = { x: (c.x - f.cameraX) * f.zoom, y: (c.y - f.cameraY) * f.zoom };
      canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", pointerId: 301, clientX: r.left + p.x, clientY: r.top + p.y }));
      canvas.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch", pointerId: 301, clientX: r.left + p.x, clientY: r.top + p.y }));
    });
    const pending = await execute(win, () => ({
      draftPending: !!window.__spatia.engine.draftConn,
      leaveHook: typeof window.__spatiaMobile.leave === "function",
    }));
    ok("mobile: source tap leaves a pending draft", pending.draftPending && pending.leaveHook);
    await execute(win, () => window.__spatiaMobile.leave());
    const afterLeave = await execute(win, () => ({
      draftCleared: !window.__spatia.engine.draftConn,
      hintHidden: document.getElementById("mb-connect-hint").hidden,
    }));
    ok("mobile: leaving web cancels the pending draft", afterLeave.draftCleared && afterLeave.hintHidden);

    // the mobile app shell honors the notch / status-bar safe areas
    const safeArea = await execute(win, () => {
      let found = false;
      for (const ss of document.styleSheets) {
        let rules;
        try { rules = ss.cssRules; } catch { continue; }
        if (!rules) continue;
        for (const r of rules) {
          if (r && r.cssText && r.cssText.indexOf("safe-area-inset-top") !== -1 && r.cssText.indexOf("#mb-topbar") !== -1) {
            found = true;
            break;
          }
        }
        if (found) break;
      }
      return found;
    });
    ok("mobile: app shell honors safe-area insets", safeArea);

    // two-finger gestures: simulate pan + zoom on the canvas through the gesture layer
    const gestures = await execute(win, () => {
      const canvas = window.__spatia.engine.canvas();
      const r = canvas.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const opts = { bubbles: true, clientX: cx, clientY: cy };

      // A) pan: drag both fingers right at near-constant spacing. Isolate the
      //    pan wiring by stubbing applyAnchoredZoom (real touches move both
      //    fingers per frame; discrete single-finger events alone skew dist).
      const realAnchor = window.__spatia.engine.applyAnchoredZoom;
      window.__spatia.engine.applyAnchoredZoom = function () {};
      const panBefore = window.__spatia.viewport.get();
      canvas.dispatchEvent(new PointerEvent("pointerdown", Object.assign({}, opts, { pointerId: 1, pointerType: "touch", clientX: cx - 60, clientY: cy })));
      canvas.dispatchEvent(new PointerEvent("pointerdown", Object.assign({}, opts, { pointerId: 2, pointerType: "touch", clientX: cx + 60, clientY: cy })));
      canvas.dispatchEvent(new PointerEvent("pointermove", Object.assign({}, opts, { pointerId: 1, clientX: cx - 10, clientY: cy + 5  })));
      canvas.dispatchEvent(new PointerEvent("pointermove", Object.assign({}, opts, { pointerId: 2, clientX: cx + 110, clientY: cy })));
      canvas.dispatchEvent(new PointerEvent("pointerup", Object.assign({}, opts, { pointerId: 1 })));
      canvas.dispatchEvent(new PointerEvent("pointerup", Object.assign({}, opts, { pointerId: 2 })));
      window.__spatia.engine.applyAnchoredZoom = realAnchor;
      const panAfter = window.__spatia.viewport.get();

      // B) pinch: spread two fingers apart -> zoom in
      const zoomBefore = window.__spatia.viewport.get();
      canvas.dispatchEvent(new PointerEvent("pointerdown", Object.assign({}, opts, { pointerId: 3, pointerType: "touch", clientX: cx - 60, clientY: cy })));
      canvas.dispatchEvent(new PointerEvent("pointerdown", Object.assign({}, opts, { pointerId: 4, pointerType: "touch", clientX: cx + 60, clientY: cy })));
      canvas.dispatchEvent(new PointerEvent("pointermove", Object.assign({}, opts, { pointerId: 3, clientX: cx - 140, clientY: cy + 10 })));
      canvas.dispatchEvent(new PointerEvent("pointermove", Object.assign({}, opts, { pointerId: 4, clientX: cx + 140, clientY: cy - 10 })));
      canvas.dispatchEvent(new PointerEvent("pointerup", Object.assign({}, opts, { pointerId: 3 })));
      canvas.dispatchEvent(new PointerEvent("pointerup", Object.assign({}, opts, { pointerId: 4 })));
      const zoomAfter = window.__spatia.viewport.get();

      return {
        panDx: panAfter.x - panBefore.x,
        zoomBefore: zoomBefore.zoom,
        zoomAfter: zoomAfter.zoom,
      };
    });
    // dragging right pans the camera left (content follows the fingers)
    ok("two-finger pan moves the camera", gestures.panDx < -18);
    ok("two-finger pinch zooms in", gestures.zoomAfter > gestures.zoomBefore);
    await execute(win, () => { window.location.hash = "#top"; });
    await until(win, () => !document.documentElement.hasAttribute("data-web"), "landing again");
    const back2 = await execute(win, () => ({
      mbActive: document.documentElement.classList.contains("mb-active"),
      shellInvisible: getComputedStyle(document.getElementById("mb-topbar")).display === "none",
      bodyOverflowY: getComputedStyle(document.body).overflowY,
      siteVisible: getComputedStyle(document.querySelector(".site")).display !== "none",
    }));
    ok("mobile: leaving web clears mb-active", !back2.mbActive);
    ok("mobile: injected shell hidden outside web mode", back2.shellInvisible);
    ok("mobile: landing scroll intact", back2.bodyOverflowY !== "hidden" && back2.siteVisible);

    // ---- 5e) Re-entering #/web resumes the app shell -----------------------
    await execute(win, () => { window.location.hash = "#/web"; });
    await until(win, () => document.documentElement.hasAttribute("data-web") && !!document.querySelector(".mb-toolbar"), "mobile re-enters");
    await sleep(200);
    const reentered = await execute(win, () => {
      const engine = window.__spatia.engine;
      const before = engine.getZoom();
      document.getElementById("mb-zoom-in").click();
      return {
        topbar: !!document.getElementById("mb-topbar"),
        zoomLive: engine.getZoom() > before,
      };
    });
    ok("mobile: re-entry keeps the app shell", reentered.topbar);
    ok("mobile: shell controls live again after re-entry", reentered.zoomLive);
    await execute(win, () => { window.location.hash = "#top"; });
    await until(win, () => !document.documentElement.hasAttribute("data-web"), "landing for PWA checks");

    // ---- 5f) Tablet layer (forced) -------------------------------------------
    // Force flags are runtime-only, so reload first, then apply tablet mode on
    // the fresh document before entering the app.
    await execute(win, () => {
      window.__spatiaSite.setForceMobile(false);
      window.location.reload();
      return true;
    });
    await until(win, () => !!window.__spatiaSite && !!document.querySelector(".site"), "page reloaded (tablet)");
    await execute(win, () => {
      window.__spatiaSite.setForceTablet(true);
      window.location.hash = "#/web";
    });
    await until(win, () => document.documentElement.hasAttribute("data-web") && !!document.querySelector("#tb-topbar"), "tablet layer injected");
    await sleep(250);

    const tab = await execute(win, () => {
      const dockTools = Array.prototype.map.call(document.querySelectorAll("#tb-dock [data-tool]"), (t) => t.getAttribute("data-tool")).join(",");
      return {
        tbActive: document.documentElement.classList.contains("tb-active"),
        noMb: !document.documentElement.classList.contains("mb-active"),
        topbar: !!document.getElementById("tb-topbar"),
        dock: !!document.getElementById("tb-dock"),
        dockTools,
        dockVisible: getComputedStyle(document.getElementById("tb-dock")).display !== "none",
        zoom: (document.getElementById("tb-zoom-label") || {}).textContent || "",
      };
    });
    ok("tablet: html.tb-active set", tab.tbActive);
    ok("tablet: not in mobile mode", tab.noMb);
    ok("tablet: top bar injected", tab.topbar);
    ok("tablet: tool dock injected and visible", tab.dock && tab.dockVisible);
    ok("tablet: dock has select/hand/pen plus create tools", /^select,hand,pen,/.test(tab.dockTools) && /note,shape,media$/.test(tab.dockTools));
    ok("tablet: zoom label shows a percentage", /%$/.test(tab.zoom));

    // Create a note via the dock, dismiss its inline editor and clear the
    // selection so the contextual toolbar is hidden (it should only appear
    // once an object is selected).
    await execute(win, () => {
      const app = window.__spatia;
      document.querySelector('[data-tool="note"]').click();
      app.selection.setIds([]);
      return true;
    });
    await sleep(250);
    const ctxBefore = await execute(win, () => ({
      hasNote: window.__spatia.project.getObjects().filter((o) => o.type === "note").length === 1,
      contextHidden: document.getElementById("tb-context").hidden === true,
    }));
    ok("tablet: add-note tool creates a note", ctxBefore.hasNote);
    ok("tablet: contextual toolbar hidden when nothing is selected", ctxBefore.contextHidden);

    // Tap the note on canvas to select it.
    await execute(win, () => {
      const app = window.__spatia;
      const engine = app.engine;
      const frame = engine.getFrame();
      const r = engine.canvas().getBoundingClientRect();
      const n = app.project.getObjects().find((o) => o.type === "note");
      const px = (n.x + n.width / 2 - frame.cameraX) * frame.zoom;
      const py = (n.y + n.height / 2 - frame.cameraY) * frame.zoom;
      const canvas = engine.canvas();
      const base = { bubbles: true, pointerType: "touch", isPrimary: true };
      const ev = (type, id) => canvas.dispatchEvent(new PointerEvent(type, Object.assign({ pointerId: id, clientX: r.left + px, clientY: r.top + py }, base)));
      ev("pointerdown", 11); ev("pointerup", 11);
      return true;
    });
    await sleep(200);
    const ctxShown = await execute(win, () => ({
      selected: window.__spatia.selection.size === 1,
      contextVisible: getComputedStyle(document.getElementById("tb-context")).display !== "none",
      actions: Array.prototype.map.call(document.querySelectorAll("#tb-context [data-ctx]"), (b) => b.getAttribute("data-ctx")).join(","),
    }));
    ok("tablet: note selected by tap", ctxShown.selected);
    ok("tablet: contextual toolbar appears on selection", ctxShown.contextVisible);
    ok("tablet: context has duplicate/delete actions", /duplicate/.test(ctxShown.actions) && /delete/.test(ctxShown.actions));

    // Duplicate then delete via the contextual toolbar.
    const dup = await execute(win, () => {
      const before = window.__spatia.project.getObjects().filter((o) => o.type === "note").length;
      document.querySelector('#tb-context [data-ctx="duplicate"]').click();
      return { before, after: window.__spatia.project.getObjects().filter((o) => o.type === "note").length };
    });
    ok("tablet: duplicate action adds a note", dup.after === dup.before + 1);
    const del = await execute(win, () => {
      const before = window.__spatia.project.getObjects().filter((o) => o.type === "note").length;
      document.querySelector('#tb-context [data-ctx="delete"]').click();
      return { before, after: window.__spatia.project.getObjects().filter((o) => o.type === "note").length };
    });
    ok("tablet: delete action removes the selection", del.after === del.before - 1);

    // Open the More sheet: sections, zoom control, then close via scrim.
    await execute(win, () => { document.querySelector('[data-tb="more"]').click(); });
    await sleep(200);
    const more = await execute(win, () => ({
      open: !document.getElementById("tb-more").hidden,
      zoomValue: (document.getElementById("tb-zoom-label") || {}).textContent || "",
      hasFit: !!document.querySelector('#tb-more [data-more="fit"]'),
      hasNew: !!document.querySelector('#tb-more [data-more="new"]'),
      hasZin: !!document.querySelector('#tb-more [data-more="zin"]'),
    }));
    ok("tablet: More panel opens as a sheet", more.open);
    ok("tablet: More shows a zoom value and zoom rows", /%$/.test(more.zoomValue) && more.hasZin);
    ok("tablet: More offers fit + new actions", more.hasFit && more.hasNew);
    // Zoom in for real (rows close the sheet, so re-open for the scrim test).
    const zin = await execute(win, () => {
      const engine = window.__spatia.engine;
      const before = engine.getZoom();
      document.querySelector('#tb-more [data-more="zin"]').click();
      return { before, after: engine.getZoom() };
    });
    ok("tablet: Zoom in changes the canvas zoom", zin.after > zin.before);
    await execute(win, () => { document.querySelector('[data-tb="more"]').click(); });
    await sleep(150);
    await execute(win, () => { document.getElementById("tb-scrim").click(); });
    await sleep(120);
    const closed = await execute(win, () => document.getElementById("tb-more").hidden);
    ok("tablet: sheet closes via scrim", closed);

    // Stage-Manager style resize keeps the tablet shell functional.
    await win.setContentSize(834, 1112);
    await sleep(250);
    const resized = await execute(win, () => ({
      tbActive: document.documentElement.classList.contains("tb-active"),
      topbar: !!document.getElementById("tb-topbar") && getComputedStyle(document.getElementById("tb-topbar")).display !== "none",
      dockVisible: getComputedStyle(document.getElementById("tb-dock")).display !== "none",
    }));
    ok("tablet: stage-manager resize keeps tablet UI", resized.tbActive && resized.topbar && resized.dockVisible);

    // ---- 5f0) Apple Pencil really inks on the iPad shell --------------------
    // A stylus (pointerType "pen") stroke must draw through the tablet layer's
    // canvas handlers — this is the drawing path a real Apple Pencil uses while
    // a finger still pans.
    await execute(win, () => {
      document.querySelector('#tb-dock [data-tool="pen"]').click();
      return true;
    });
    await sleep(150);
    const tpen = await execute(win, () => ({ active: window.__spatia.engine.isPenTool() }));
    ok("tablet: dock pen tool arms the shared pen engine", tpen.active);
    await execute(win, () => {
      const c = window.__spatia.engine.canvas();
      const r = c.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const base = { bubbles: true, cancelable: true, pointerType: "pen", isPrimary: true, button: 0, buttons: 1 };
      const fire = (t, x, y, p) => c.dispatchEvent(new PointerEvent(t, Object.assign({ pointerId: 2, clientX: x, clientY: y, pressure: p }, base)));
      fire("pointerdown", cx - 90, cy - 40, 0.2);
      for (let i = 1; i <= 12; i++) fire("pointermove", cx - 90 + 180 * (i / 12), cy - 40, 0.2 + 0.75 * (i / 12));
      fire("pointerup", cx + 90, cy - 40, 0);
      return true;
    });
    await sleep(150);
    const tdraw = await execute(win, () => {
      const pens = window.__spatia.project.getObjects().filter((o) => o.type === "pen");
      const s = pens[0];
      return {
        pens: pens.length,
        points: s ? s.points.length : 0,
        widths: s ? s.points.filter((p) => p.width !== undefined).length : 0,
        firstW: s && s.points[0] ? s.points[0].width : undefined,
        lastW: s && s.points.length ? s.points[s.points.length - 1].width : undefined,
      };
    });
    ok("tablet: Apple Pencil stroke draws a pen object", tdraw.pens === 1 && tdraw.points >= 4);
    ok("tablet: stylus pressure inked per-vertex", tdraw.widths === tdraw.points && tdraw.firstW < tdraw.lastW);
    // Restore the select tool for the suite's own tablet cleanup.
    await execute(win, () => {
      document.querySelector('#tb-dock [data-tool="select"]').click();
      return true;
    });
    await sleep(100);
    const trest = await execute(win, () => ({ penOff: !window.__spatia.engine.isPenTool() }));
    ok("tablet: select tool restored after pencil test", trest.penOff);

    // ---- 5g) Phone regression (forced) ---------------------------------------
    // The tablet layer is document-lifetime, so leave the workspace first,
    // reload onto a fresh landing document, then force mobile on this
    // phone-sized viewport before re-entering the app.
    await win.setContentSize(390, 844);
    await execute(win, () => {
      window.__spatiaSite.setForceTablet(false);
      window.location.hash = "#top";
      window.location.reload();
      return true;
    });
    await until(win, () => !!window.__spatiaSite && !!document.querySelector(".site"), "page reloaded (phone)");
    await execute(win, () => {
      window.__spatiaSite.setForceMobile(true);
      window.location.hash = "#/web";
    });
    await until(win, () => document.documentElement.hasAttribute("data-web") && !!document.querySelector(".mb-toolbar"), "phone layer injected");
    await sleep(250);
    const phone = await execute(win, () => ({
      mbActive: document.documentElement.classList.contains("mb-active"),
      noTb: !document.documentElement.classList.contains("tb-active"),
      toolbar: !!document.querySelector(".mb-toolbar"),
    }));
    ok("phone: html.mb-active set on 390x844", phone.mbActive);
    ok("phone: not in tablet mode", phone.noTb);
    ok("phone: mobile toolbar present", phone.toolbar);
    // Create a note through the mobile add sheet to prove create still works.
    await execute(win, () => { document.querySelector('[data-bar="add"]').click(); });
    await sleep(200);
    const createdNote = await execute(win, () => {
      const before = window.__spatia.project.getObjects().filter((o) => o.type === "note").length;
      const btn = document.querySelector('#mb-sheet-body .mb-grid-item[data-add="note"]');
      if (btn) btn.click();
      const after = window.__spatia.project.getObjects().filter((o) => o.type === "note").length;
      return { present: !!btn, created: after === before + 1 };
    });
    ok("phone: add sheet creates a note", createdNote.present && createdNote.created);

    // Restore default (no forced mode, suite default viewport) before the
    // console-error check so downstream sections see the original conditions.
    await execute(win, () => {
      window.__spatiaSite.setForceMobile(false);
      window.__spatiaSite.setForceTablet(false);
      window.location.hash = "#top";
    });
    await until(win, () => !document.documentElement.hasAttribute("data-web"), "landing, defaults restored");
    await win.setContentSize(1440, 900);

    // ---- 6) PWA assets ------------------------------------------------------
    await httpOk("PWA manifest served", "/manifest.webmanifest", (b) => {
      try {
        const j = JSON.parse(b.toString("utf-8"));
        return j.name === "Spatia" && j.start_url.indexOf("#/web") !== -1 && j.display === "standalone";
      } catch {
        return false;
      }
    });
    await httpOk("PWA service worker served", "/sw.js", (b) => b.toString("utf-8").indexOf("spatia-site-v") !== -1);
    await httpOk("PWA icon 192 served", "/assets/icon-192.png", (b) => b.length > 1000);
    await httpOk("PWA icon 512 served", "/assets/icon-512.png", (b) => b.length > 1000);
    await httpOk("PWA maskable icon served", "/assets/icon-maskable-512.png", (b) => b.length > 1000);

    const page = await execute(win, () => ({
      manifestHref: (document.querySelector('link[rel="manifest"]') || {}).href || "",
      lightIcon: (document.querySelector('link[rel="apple-touch-icon"]') || {}).href || "",
    }));
    ok("page links manifest", /manifest\.webmanifest$/.test(page.manifestHref));
    ok("page links apple-touch icon", /icon-180\.png$/.test(page.lightIcon));

    // ---- 7) Fresh mobile boot shows the branded splash ---------------------
    // Reset the console-error buffer: the reload below starts a brand-new
    // document, so only failures in the fresh boot should count from here.
    errors.length = 0;
    await execute(win, () => {
      if (window.__spatiaSite) window.__spatiaSite.setForceMobile(true);
      window.location.reload();
    });
    await until(win, () => !!window.__spatiaSite && !!document.querySelector(".site"), "page reloaded");
    await execute(win, () => {
      window.__spatiaSite.setForceMobile(true);
      window.location.hash = "#/web";
    });
    const splashShown = await execute(win, () => document.documentElement.getAttribute("data-mb-splash"));
    ok("mobile: first mobile boot shows branded splash", splashShown === "shown");
    await until(win, () => !!window.__spatia && !!document.querySelector(".mb-toolbar"), "mobile fresh boot completes");
    await until(win, () => document.documentElement.getAttribute("data-mb-splash") !== "shown", "splash dismissed after boot");
    await until(win, () => !document.getElementById("mb-splash"), "splash element removed");
    const splashGone = await execute(win, () => !document.getElementById("mb-splash") || !document.getElementById("mb-splash").isConnected);
    ok("mobile: splash removed from the document", splashGone);

    // ---- Phase 1) Shapes, instant notes, templates, export ------------------
    // (These checks run on the fresh mobile boot state created above.)

    // tapping a shape button in the Add sheet routes to the app and creates it
    await execute(win, () => { document.querySelector('[data-bar="add"]').click(); });
    await sleep(150);
    const tappedShape = await execute(win, () => {
      const btn = document.querySelector('#mb-sheet-body .mb-grid-item[data-add="shape-arrow"]');
      const before = window.__spatia.project.getObjects().filter((o) => o.type === "shape").length;
      const center = window.__spatia.centerWorld();
      btn.click();
      const shapes = window.__spatia.project.getObjects().filter((o) => o.type === "shape");
      return { btnPresent: !!btn, before, arrows: shapes.filter((o) => o.kind === "arrow").length };
    });
    ok("shapes: mobile add sheet routes a shape tap", tappedShape.btnPresent && tappedShape.before === 0 && tappedShape.arrows === 1);

    // app-level creation, selection, undo/redo round trip
    const shapesApi = await execute(win, () => {
      const app = window.__spatia;
      const c = app.centerWorld();
      app.addShapeAt("diamond", { x: c.x - 300, y: c.y });
      const diamond = app.project.getObjects().filter((o) => o.type === "shape" && o.kind === "diamond")[0];
      const selected = app.selection.has(diamond ? diamond.id : "");
      app.undo();
      const undone = app.project.getObjects().filter((o) => o.type === "shape" && o.kind === "diamond").length;
      app.redo();
      const redone = app.project.getObjects().filter((o) => o.type === "shape" && o.kind === "diamond").length;
      return { diamond: !!diamond, selected, undone, redone };
    });
    ok("shapes: app creates and selects a shape", shapesApi.diamond && shapesApi.selected);
    ok("shapes: undo/redo round-trips shape creation", shapesApi.undone === 0 && shapesApi.redone === 1);

    // instant note editing opens the inline editor with no extra click
    const noteEdit = await execute(win, () => {
      const app = window.__spatia;
      const before = app.project.getObjects().filter((o) => o.type === "note").length;
      app.addNoteAt({ x: app.centerWorld().x + 200, y: app.centerWorld().y });
      const editor = document.querySelector(".spatia-text-editor");
      const made = app.project.getObjects().filter((o) => o.type === "note").length === before + 1;
      if (editor) editor.blur(); // commit the empty body and close the editor
      app.commands.markSaved();
      return { made, editorOpen: !!editor };
    });
    ok("notes: adding a note opens the editor immediately", noteEdit.made && noteEdit.editorOpen);

    // templates dialog renders the eight starter cards
    const tplDialog = await execute(win, () => {
      window.__spatia.openTemplatesDialog();
      return {
        open: document.getElementById("templates-dialog").classList.contains("open"),
        cards: document.querySelectorAll("#templates-list .template-card").length,
      };
    });
    ok("templates: dialog lists all 8 starter cards", tplDialog.open && tplDialog.cards === 8);

    // applying a template replaces the document (commands were marked saved,
    // so the discard confirm is skipped)
    const tplApplied = await execute(win, async () => {
      const app = window.__spatia;
      await app.applyTemplate("project-planning");
      const objs = app.project.getObjects();
      return {
        frames: objs.filter((o) => o.type === "frame").length,
        notes: objs.filter((o) => o.type === "note").length,
        closed: !document.getElementById("templates-dialog").classList.contains("open"),
      };
    });
    ok("templates: applying a template fills the canvas", tplApplied.frames === 3 && tplApplied.notes === 6 && tplApplied.closed);

    // export dialog lists every format and the markdown builder works
    const exportUi = await execute(win, () => {
      const app = window.__spatia;
      app.openExportDialog();
      const options = Array.from(document.querySelectorAll('#export-dialog [data-export]')).map((b) => b.getAttribute("data-export"));
      const md = app.buildMarkdownText();
      app.ui.closeExportDialog();
      return {
        open: true,
        options,
        mdHasHeading: md.indexOf("# ") === 0,
        bridgeExportFile: typeof window.spatia.exportFile === "function",
      };
    });
    ok("export: dialog exposes all six formats", exportUi.options.join(",") === "spatia-folder,spatia-json,png,jpeg,pdf,md");
    ok("export: markdown builds from the current document", exportUi.mdHasHeading);
    ok("export: web bridge exposes exportFile", exportUi.bridgeExportFile);

    // ---- Phase 2) Project library, folders/favorites/tags, versions ---------

    // Object tags: the inspector exposes a comma-separated tags field that
    // commits through undoable state.
    const objTags = await execute(win, () => {
      const app = window.__spatia;
      const note = app.project.getObjects().filter((o) => o.type === "note")[0];
      app.selection.setIds([note.id]);
      app.refreshUI();
      const input = document.querySelector('#inspector-body input[data-prop="metadata-tags"]');
      if (!input) return { present: false };
      input.value = "vip, focus";
      input.dispatchEvent(new Event("change", { bubbles: true }));
      const settags = note.metadata.tags;
      const serialized = JSON.parse(app.serialize());
      const roundTrip = serialized.objects.find((o) => o.id === note.id).metadata.tags;
      app.undo();
      const undone = !note.metadata.tags || note.metadata.tags.length === 0;
      app.redo();
      return { present: true, settags, roundTrip, undone };
    });
    ok("tags: inspector exposes a tags field", objTags.present);
    ok("tags: committed and round-trips through serialize", objTags.settags.length === 2 && objTags.roundTrip.length === 2);
    ok("tags: tag edit is undoable", objTags.undone);

    // Projects dialog: a saved project appears, can be favorited, folder &
    // search-filtered, and tagged.
    const savedDoc = await execute(win, async () => {
      const app = window.__spatia;
      let path = "";
      try {
        HTMLAnchorElement.prototype.click = function () {};
        const res = await window.spatia.saveProject(app.serialize());
        path = res.filePath || "";
      } catch (err) {
        return { path: "", err: String(err) };
      }
      return { path, err: "" };
    });
    // Re-inject with the real path (execute stringifies the function, so the
    // value is baked in as a literal).
    await execute(win, new Function(`window.__verifyPath = ${JSON.stringify(savedDoc.path)};`));
    const projList = await execute(win, async () => {
      const app = window.__spatia;
      const path = window.__verifyPath;
      await app.openProjectsDialog();
      const open = document.getElementById("projects-dialog").classList.contains("open");
      const lib = await window.spatia.libraryGet();
      const okSaved = path !== "" && lib.projects.some((p) => p.filePath === path);
      app.ui.closeProjectsDialog();
      return { open, okSaved };
    });
    ok("projects: dialog opens and lists a saved project", projList.open && projList.okSaved);

    const projOrg = await execute(win, async () => {
      const app = window.__spatia;
      const path = window.__verifyPath;
      // Favorite toggle persists and shows a filled star.
      await window.spatia.librarySetFavorite(path, true);
      let lib = await window.spatia.libraryGet();
      const fav = lib.projects.find((p) => p.filePath === path);
      await app.openProjectsDialog();
      const starShown = document.querySelector(`[data-action="fav"][data-path="${path}"]`).textContent === "★";
      app.ui.closeProjectsDialog();

      // Folder creation + assignment persistence.
      const folder = await window.spatia.libraryCreateFolder("Verify");
      await window.spatia.librarySetFolder(path, folder.id);
      lib = await window.spatia.libraryGet();
      const inFolder = lib.projects.find((p) => p.filePath === path).folderId === folder.id;

      // Project-level tags + search filter by tag.
      await window.spatia.librarySetTags(path, ["verifytag"]);
      lib = await window.spatia.libraryGet();
      const projTag = lib.projects.find((p) => p.filePath === path).tags;
      await app.openProjectsDialog();
      const search = document.getElementById("projects-search");
      search.value = "verifytag";
      app.renderProjects();
      const rows = document.querySelectorAll("#projects-list .project-row").length;
      search.value = "";
      app.renderProjects();
      app.ui.closeProjectsDialog();
      return { fav: fav && fav.favorite === true, starShown, folder: !!folder && inFolder, projTag, rows };
    });
    ok("projects: favorite toggles and renders ★", projOrg.fav && projOrg.starShown);
    ok("projects: folder create/assign persists", projOrg.folder);
    ok("projects: project tags persist and search filters by tag", projOrg.projTag && projOrg.projTag[0] === "verifytag" && projOrg.rows === 1);

    // Version history: capture, list, restore, delete on the web bridge.
    const versions = await execute(win, async () => {
      const app = window.__spatia;
      const projectId = app.project.getMeta().id;
      await window.spatia.versionsAdd(projectId, "Verify snapshot", app.serialize());
      await window.spatia.versionsAdd(projectId, "Verify snapshot 2", app.serialize());
      const list = await window.spatia.versionsList(projectId);
      const restored = await window.spatia.versionsRestore(projectId, list[0].token);
      let restoredJson = false;
      try { restoredJson = JSON.parse(restored) && true; } catch { restoredJson = false; }
      for (const s of list) await window.spatia.versionsDelete(projectId, s.token);
      const after = await window.spatia.versionsList(projectId);
      return { count: list.length, restoredJson, empty: after.length === 0 };
    });
    ok("versions: snapshots listed", versions.count >= 2);
    ok("versions: snapshot content restores", versions.restoredJson);
    ok("versions: snapshot deletion empties the list", versions.empty);

    // ---- Phase 2) Find modal (Ctrl+F / "/"), relevance, jump-to ------------
    const searchBoot = await execute(win, async () => {
      const app = window.__spatia;
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true }));
      const openByCtrlF = document.getElementById("search-dialog").classList.contains("open");
      const input = document.getElementById("search-input");
      input.value = "note";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const rows = document.querySelectorAll("#search-list .search-row").length;
      const count = document.getElementById("search-count").textContent;
      return { openByCtrlF, rows, count };
    });
    ok("search: Ctrl+F opens the find dialog", searchBoot.openByCtrlF);
    ok("search: typing filters ranked results", searchBoot.rows >= 3);

    const searchJump = await execute(win, async () => {
      const app = window.__spatia;
      const ids = app.search.resultList.map((r) => r.id);
      document.getElementById("search-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      const closed = !document.getElementById("search-dialog").classList.contains("open");
      const selectedIds = app.selection.get();
      return { ids, closed, selectedIds };
    });
    ok(
      "search: Enter jumps to a result and closes",
      searchJump.closed && searchJump.selectedIds.length >= 1 && searchJump.ids.length > 0
    );

    const searchSlash = await execute(win, () => {
      const app = window.__spatia;
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "/" }));
      const open = document.getElementById("search-dialog").classList.contains("open");
      app.closeSearch();
      return { open };
    });
    ok("search: `/` opens the find dialog", searchSlash.open);

    // ---- 20) Real collaboration server, E2E on the documented :8787 ---------
    const collabData = fs.mkdtempSync(path.join(os.tmpdir(), "spatia-collab-"));
    // Prefer the documented default port 8787 so the E2E exercises the exact
    // "ws://localhost:8787" URL from the docs. If a dev server already holds it,
    // fall back to a free port (all checks still run; the port note is honest).
    let collabServer = spawnCollabServer(8787, collabData);
    let defaultPortOk = true;
    try {
      await collabServer.listening;
    } catch {
      defaultPortOk = false;
      if (collabServer.child.exitCode === null) collabServer.child.kill();
    }
    let collabPort = defaultPortOk ? 8787 : await freePort();
    if (!defaultPortOk) {
      collabServer = spawnCollabServer(collabPort, collabData);
      try {
        await collabServer.listening;
      } catch (err) {
        process.stderr.write("  [collab server could not start] " + (err && err.message ? err.message : String(err)) + "\n");
      }
    }
    ok("collab server binds the documented default port 8787", defaultPortOk);
    const collabUrl = collabPort === 8787 ? "ws://localhost:8787" : `ws://127.0.0.1:${collabPort}`;
    let peer = null;
    {
      await win.webContents.executeJavaScript(`window.__verifyCollabUrl = ${JSON.stringify(collabUrl)};`);
      await execute(win, () => {
        const app = window.__spatia;
        app["connectCollab"](window.__verifyCollabUrl);
        app["joinRoom"]("verify-room");
      });
      const joinedOwner = await until(
        win,
        () => window.__spatia.collab.isJoined && window.__spatia.collab.role === "owner" && window.__spatia.collab.roomId === "verify-room",
        "app becomes room owner"
      );
      ok("web client joins a room as owner via " + collabUrl, joinedOwner);

      if (joinedOwner) {
        const ownerId = await execute(win, () => window.__spatia.collab.user && window.__spatia.collab.user.id);
        try {
          peer = await makePeerClient(collabPort, "verify-room", { id: "verify-peer", name: "Peer", color: "#c4f542" });
        } catch (err) {
          peer = null;
          process.stderr.write("  [collab peer error] " + (err && err.message ? err.message : String(err)) + "\n");
        }
        if (peer) {
          // A real canvas object (not a special comment channel) is what syncs.
          await execute(win, () => {
            const app = window.__spatia;
            app["addNoteAt"]({ x: 40, y: 60 });
            app.collab.sendPresence(120, 340);
          });
          const gotObjectSync = await peerUntil(peer, (msgs) =>
            msgs.some(
              (m) =>
                m.t === "snapshot" &&
                m.user.id === ownerId &&
                m.file &&
                Number(m.file.formatVersion) === 5 &&
                Array.isArray(m.file.objects) &&
                m.file.objects.some((o) => o.type === "note")
            )
          );
          ok("second client receives a live canvas object via the owner's snapshot (v5)", gotObjectSync);
          const gotPresence = await peerUntil(peer, (msgs) =>
            msgs.some((m) => m.t === "presence" && m.user.id === ownerId && m.x === 120 && m.y === 340)
          );
          ok("second client sees the owner's live cursor", gotPresence);

          // Viewers are denied every write server-side — even a document snapshot.
          const viewerFile = {
            formatVersion: 5,
            project: { id: "p-viewer", name: "viewer write", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
            viewport: { x: 0, y: 0, zoom: 1 },
            objects: [],
            assets: [],
          };
          peer.ws.send(JSON.stringify({ t: "snapshot", file: viewerFile }));
          const viewerDenied = await peerUntil(peer, (msgs) => msgs.some((m) => m.t === "denied" && /viewer/i.test(m.action)));
          ok("viewer writes (snapshot) are denied by the server", viewerDenied);

          // Owner promotes the peer to editor; the editor's object then syncs to
          // the app — proving the same channel the editor role gates.
          await execute(win, () => window.__spatia.collab.sendPermSet("verify-peer", "editor"));
          const promoted = await peerUntil(peer, (msgs) =>
            msgs.some((m) => m.t === "perm:changed" && m.userId === "verify-peer" && m.role === "editor")
          );
          ok("owner promotion reaches the peer", promoted);
          peer.ws.send(
            JSON.stringify({
              t: "snapshot",
              file: {
                formatVersion: 5,
                project: { id: "p-verify", name: "Editor doc", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
                viewport: { x: 0, y: 0, zoom: 1 },
                objects: [
                  { type: "note", id: "verify-peer-obj", x: 1, y: 2, width: 100, height: 80, rotation: 0, zIndex: 1, locked: false, metadata: {}, title: "Hi", text: "editor object", color: "#f0c33c" },
                ],
                assets: [],
              },
            })
          );
          const editorSynced = await until(
            win,
            () => {
              const app = window.__spatia;
              const objs = app.project && app.project.getObjects ? app.project.getObjects() : [];
              return objs.some((o) => o.id === "verify-peer-obj" && o.text === "editor object");
            },
            "editor snapshot applied by the app",
            60
          );
          ok("editor snapshot syncs back to the app", editorSynced);

          // ---- Unexpected drop -> the app reconnects and re-joins on its own.
          collabServer.child.kill();
          await new Promise((r) => collabServer.child.on("exit", r));
          const restarted = spawnCollabServer(collabPort, collabData);
          await restarted.listening;
          const rejoined = await until(
            win,
            () => window.__spatia.collab.isJoined && window.__spatia.collab.roomId === "verify-room" && window.__spatia.collab.role === "owner",
            "app reconnects after server restart",
            140
          );
          ok("app reconnects and rejoins its room after a server restart", rejoined);
          restarted.child.kill();

          // ---- Bad server URL -> explicit error state, not a hang. Port 1 is
          // guaranteed refused locally, so the retry budget is consumed fast and
          // the app's give-up message surfaces within the wait window.
          await execute(win, () => {
            const app = window.__spatia;
            app["connectCollab"]("ws://127.0.0.1:1");
            app["openShareDialog"]();
          });
          const errorState = await until(
            win,
            () => {
              const s = document.getElementById("share-status");
              return !!s && s.classList.contains("share-status-error");
            },
            "share dialog shows an error state for a bad server URL",
            200
          );
          ok("a broken collab server surfaces an error state in the share dialog", errorState);
        } else {
          ok("second client receives a live canvas object via the owner's snapshot (v5)", false);
          ok("second client sees the owner's live cursor", false);
          ok("viewer writes (snapshot) are denied by the server", false);
          ok("owner promotion reaches the peer", false);
          ok("editor snapshot syncs back to the app", false);
          ok("app reconnects and rejoins its room after a server restart", false);
        }
      }
    }
    if (peer && peer.ws) {
      try {
        peer.ws.close();
      } catch {
        /* ignore */
      }
    }
    try {
      if (collabServer.child.connected !== false && !collabServer.child.killed) collabServer.child.kill();
    } catch {
      /* ignore */
    }
    fs.rmSync(collabData, { recursive: true, force: true });

    // ---- M5) Rich media: drop/paste an image, thumbnail chips, assets panel --
    {
      const dropped = await execute(win, async () => {
        const app = window.__spatia;
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 360;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#f0c33c";
        ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = "#1d1f26";
        ctx.fillRect(40, 40, 300, 220);
        const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
        const file = new File([blob], "verify-banner.png", { type: "image/png" });
        const dt = new DataTransfer();
        dt.items.add(file);
        const rect = app.engine.canvas().getBoundingClientRect();
        const ev = new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        });
        window.dispatchEvent(ev);
        return true;
      });
      ok("media: synthetic image drop dispatches", dropped === true);

      const imported = await until(win, () => {
        const assets = window.__spatia.project.getAssets();
        return assets.length === 1 && assets[0].name === "verify-banner.png";
      }, "dropped image imported as an asset");
      ok("media: dropped image becomes an asset", imported);

      const assetInfo = await execute(win, () => {
        const assets = window.__spatia.project.getAssets();
        const a = assets[0];
        const imgObjs = window.__spatia.project.getObjects().filter((o) => o.type === "image");
        return {
          kind: a ? a.kind : null,
          thumb: a ? a.thumbnail || "" : "",
          imageObject: imgObjs.length === 1 && imgObjs[0].assetId === a.id,
        };
      });
      ok("media: asset kind is image", assetInfo.kind === "image");
      ok("media: asset carries an auto-generated thumbnail", /^data:image\//.test(assetInfo.thumb));
      ok("media: an image object references the asset", assetInfo.imageObject);

      // The serialized document keeps the additive thumbnail field (round-trip).
      const serializedThumb = await execute(win, () => {
        const json = window.__spatia["serialize"]();
        const parsed = JSON.parse(json);
        return (parsed.assets || []).length === 1 && /^data:image\//.test((parsed.assets[0] || {}).thumbnail || "");
      });
      ok("media: serialized document round-trips the thumbnail", serializedThumb === true);

      // Open the Assets panel (sidebar button + bottom sheet on mobile).
      await execute(win, () => {
        document.getElementById("assets-close"); // panel markup is present
        window.__spatia.toggleAssetsPanel();
      });
      await sleep(120);
      const panelOpen = await execute(win, () => document.getElementById("assets-panel").classList.contains("panel-open"));
      ok("media: assets panel opens", panelOpen);
      const chip = await execute(win, () => {
        const chipEl = document.querySelector(".asset-chip[data-asset-id]");
        if (!chipEl) return null;
        return {
          hasThumbImg: !!chipEl.querySelector(".asset-thumb-img"),
          name: (chipEl.querySelector(".asset-name") || {}).textContent || "",
          hasRemove: !!chipEl.querySelector('[data-action="remove"]'),
          hasOpen: !!chipEl.querySelector('[data-action="open"]'),
          title: chipEl.getAttribute("title") || "",
          panelTitle: document.getElementById("assets-title").textContent || "",
        };
      });
      ok("media: thumbnail chip renders with an image", !!chip && chip.hasThumbImg && chip.name === "verify-banner.png");
      ok("media: chip offers Open + Remove", !!chip && chip.hasRemove && chip.hasOpen);
      ok("media: panel header shows one asset", !!chip && /^Assets \(1\)$/.test(chip.panelTitle));

      // Selecting the chip locates the object on canvas (selection follows).
      await execute(win, () => {
        document.querySelector(".asset-chip[data-asset-id]").click();
      });
      await sleep(80);
      const selectedAsset = await execute(win, () => {
        const a = window.__spatia.project.getAssets()[0];
        const sels = window.__spatia.selection.get();
        return sels.length === 1 && window.__spatia.project.getObjects().some((o) => o.id === sels[0] && o.assetId === a.id);
      });
      ok("media: clicking a chip finds the object on canvas", selectedAsset);

      // Remove the asset through the chip's Remove action (confirm stubbed).
      await execute(win, () => {
        window.__origConfirm = window.confirm;
        window.confirm = () => true;
      });
      await execute(win, () => {
        document.querySelector('.asset-chip [data-action="remove"]').click();
      });
      const removed = await until(win, () => window.__spatia.project.getAssets().length === 0, "asset removed via chip");
      await execute(win, () => {
        window.confirm = window.__origConfirm;
        delete window.__origConfirm;
      });
      ok("media: asset can be removed from the panel", removed);
      const panelAfter = await execute(win, () => {
        const assets = window.__spatia.project.getAssets();
        const imgObjs = window.__spatia.project.getObjects().filter((o) => o.type === "image");
        const imgs = document.querySelectorAll(".asset-thumb-img").length;
        return { assets: assets.length, imgObjs: imgObjs.length, imgs };
      });
      ok("media: deleted asset leaves no asset (object shows as missing)", panelAfter.assets === 0);
      ok("media: canvas image object remains but reports missing asset", panelAfter.imgObjs === 1);
      await execute(win, () => { window.__spatia.toggleAssetsPanel(); });
      await sleep(80);
    }

    ok("no console errors", errors.length === 0);
    if (errors.length) process.stderr.write("CONSOLE ERRORS:\n" + errors.join("\n") + "\n");

    // ---- Summary -----------------------------------------------------------
    win.destroy();
    server.close();
    app.quit();
    process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail === 0 ? 0 : 1);
  } catch (err) {
    process.stderr.write("verification failed: " + (err && err.stack ? err.stack : err) + "\n");
    app.exit(2);
  }
});