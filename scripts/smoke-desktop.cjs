"use strict";
const path = require("path");
const { app, BrowserWindow, Menu } = require("electron");
const { registerIpc } = require("../dist/main/main/ipc.js");

const ROOT = path.resolve(__dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { spawn } = require("child_process");
const os = require("os");
const fs = require("fs");

function spawnCollabServer(port, dataDir) {
  const child = spawn(process.execPath, [path.join(ROOT, "server", "server.js"), "--port", String(port), "--data", dataDir], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  const listening = new Promise((resolve, reject) => {
    const log = [];
    child.stderr.on("data", (d) => log.push(String(d)));
    const timer = setTimeout(() => reject(new Error("collab server start timeout: " + log.join(""))), 8000);
    child.stdout.on("data", (d) => {
      if (/listening/i.test(String(d))) {
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

let failures = 0;
const check = (name, ok) => {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name);
  if (!ok) failures += 1;
};

const until = async (win, fn, name, timeoutMs = 12000) => {
  const start = Date.now();
  for (;;) {
    try {
      if (await win.webContents.executeJavaScript(`(${fn.toString()})()`)) return true;
    } catch { /* page not ready yet */ }
    if (Date.now() - start > timeoutMs) {
      console.log(`  [until timed out: ${name}]`);
      return false;
    }
    await sleep(150);
  }
};

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  registerIpc();

  // The Browser Frame plugin ships as a built-in, so no seeding is needed — it
  // is registered automatically on first boot.

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(ROOT, "dist", "main", "main", "preload.js"),
      backgroundThrottling: false,
      webviewTag: true,
    },
  });
  const errors = [];
  win.webContents.on("console-message", (e, level, message) => {
    // The collab retry/surrender tests intentionally break the connection; the
    // browser's own "WebSocket connection to … failed" noise is expected there.
    // Navigating the browser-frame webview aborts the in-flight load, which
    // Electron logs as benign guest navigation errors (ERR_ABORTED -3, and a
    // transient network refusal like ERR_SOCKET_NOT_CONNECTED -15).
    const msg = String(message);
    if (level >= 3 && !/WebSocket connection to .+ failed/i.test(msg) && !/\(-\d+\) loading 'https?:\/\//.test(msg)) errors.push(msg);
  });

  await win.loadFile(path.join(ROOT, "dist", "renderer", "index.html"));
  await until(win, () => !!window.__spatia && !!window.__spatia.plugins, "app boots");
  await until(win, () => window.__spatia.plugins.commandsList().some((c) => c.id === "browser-frame.add"), "browser-frame command registers");

  const listed = await win.webContents.executeJavaScript(`(() => {
    const entry = window.__spatia.plugins.entriesList().find((e) => e.id === "browser-frame");
    return { present: !!entry, builtIn: !!entry && entry.builtIn === true, enabled: !!entry && entry.enabled };
  })()`);
  check("desktop: built-in browser-frame listed + enabled", listed.present && listed.builtIn && listed.enabled);

  // API v2: the plugins dialog shows the api version badge + permission chips
  const dialogV2 = await win.webContents.executeJavaScript(`(() => {
    window.__spatia.openPluginsDialog();
    const rows = Array.from(document.querySelectorAll("#plugins-list .plugin-entry"));
    const bf = rows.find((el) => (el.textContent || "").includes("Browser Frame"));
    const html = bf ? bf.textContent : "";
    document.getElementById("plugins-close").click();
    return {
      hasRow: !!bf,
      badge: /API v2/.test(html),
      chips: /notify/.test(html) && /documents/.test(html) && /view/.test(html),
    };
  })()`);
  check("desktop: plugins dialog shows API v2 badge + permission chips", dialogV2.hasRow && dialogV2.badge && dialogV2.chips);

  // ---- Phase 1: shapes, instant notes, templates, export -------------------
  const phase1 = await win.webContents.executeJavaScript(`(async () => {
    const app = window.__spatia;
    const c = app.centerWorld();
    app.commands.markSaved();

    // shape creation, selection and undo/redo round trip
    app.addShapeAt("ellipse", c);
    const shape = app.project.getObjects().filter((o) => o.type === "shape")[0];
    const shapeMade = !!shape && shape.kind === "ellipse" && app.selection.has(shape.id);
    app.undo();
    const shapeUndone = app.project.getObjects().filter((o) => o.type === "shape" && o.id === shape.id).length === 0;
    app.redo();
    const shapeRedone = app.project.getObjects().filter((o) => o.type === "shape" && o.id === shape.id).length === 1;

    // instant note editing opens the inline editor without an extra click
    app.addNoteAt({ x: c.x + 220, y: c.y + 40 });
    const noteEditor = !!document.querySelector(".spatia-text-editor");
    const noteMade = app.project.getObjects().some((o) => o.type === "note");
    const editor = document.querySelector(".spatia-text-editor");
    if (editor) editor.blur();
    app.commands.markSaved();

    // export surface: bridge present, markdown builds, dialog lists all formats
    app.openExportDialog();
    const exportOptions = Array.from(document.querySelectorAll('#export-dialog [data-export]')).map((b) => b.getAttribute("data-export")).join(",");
    app.ui.closeExportDialog();
    const exportOk = typeof window.spatia.exportFile === "function" &&
      app.buildMarkdownText().indexOf("# ") === 0 &&
      exportOptions === "spatia-folder,spatia-json,png,jpeg,pdf,md";

    // templates: dialog renders 8 cards and applying one fills the canvas
    app.openTemplatesDialog();
    const templates = document.querySelectorAll("#templates-list .template-card").length;
    await app.applyTemplate("mind-map");
    const mindmapNotes = app.project.getObjects().filter((o) => o.type === "note").length;
    const templatesOk = templates === 8 && mindmapNotes === 3 &&
      !document.getElementById("templates-dialog").classList.contains("open");
    app.commands.markSaved();

    return { shapeMade, shapeUndone, shapeRedone, noteMade, noteEditor, exportOk, templatesOk };
  })()`);
  check("desktop: shape create/select + undo/redo", phase1.shapeMade && phase1.shapeUndone && phase1.shapeRedone);
  check("desktop: instant note editing opens the editor", phase1.noteMade && phase1.noteEditor);
  check("desktop: export bridge + markdown + five formats", phase1.exportOk);
  check("desktop: templates dialog + apply", phase1.templatesOk);

  // ---- Collaboration on desktop: real E2E over ws://localhost:8787 ---------
  const collabData = fs.mkdtempSync(path.join(os.tmpdir(), "spatia-smoke-collab-"));
  let collabServer = spawnCollabServer(8787, collabData);
  let defaultPortOk = true;
  try {
    await collabServer.listening;
  } catch {
    defaultPortOk = false;
    if (collabServer.child.exitCode === null) collabServer.child.kill();
  }
  let collabPort = defaultPortOk ? 8787 : -1;
  if (!defaultPortOk) {
    const net = require("net");
    collabPort = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.unref();
      srv.on("error", () => resolve(-1));
      srv.listen(0, "127.0.0.1", () => {
        const p = srv.address().port;
        srv.close(() => resolve(p));
      });
    });
    collabServer = spawnCollabServer(collabPort, collabData);
    try {
      await collabServer.listening;
    } catch (err) {
      console.log("  [collab server could not start] " + (err && err.message ? err.message : String(err)));
    }
  }
  const collabUrl = collabPort === 8787 ? "ws://localhost:8787" : `ws://127.0.0.1:${collabPort}`;
  check("desktop: collab server binds the documented default port 8787", defaultPortOk);

  await win.webContents.executeJavaScript(`(async () => {
    const app = window.__spatia;
    if (${JSON.stringify(collabUrl)} !== "ws://localhost:8787") {
      app["connectCollab"](${JSON.stringify(collabUrl)});
    }
    app["joinRoom"]("smoke-" + Date.now());
  })()`);
  const joinedOwner = await until(
    win,
    () => window.__spatia.collab.isJoined && window.__spatia.collab.role === "owner" && /^smoke-/.test(window.__spatia.collab.roomId),
    "desktop becomes owner over " + collabUrl,
    25000
  );
  check("desktop: joins a room as owner over " + collabUrl, joinedOwner);

  if (joinedOwner) {
    const writeState = await win.webContents.executeJavaScript(`(async () => {
      const app = window.__spatia;
      const c = app.centerWorld();
      app.addNoteAt({ x: c.x, y: c.y });
      app.collab.sendPresence(55, 77);
      await new Promise((r) => setTimeout(r, 400));
      return { status: app.collab.status, error: app.collab.error };
    })()`);
    check("desktop: owner shares canvas + presence while joined", writeState.status === "connected");

    // Killing the server must surface an accurate retrying state, not a hang.
    collabServer.child.kill();
    await new Promise((r) => collabServer.child.on("exit", r));
    const noticed = await until(
      win,
      () => {
        const c = window.__spatia.collab;
        return c.status === "connecting" && /retrying/i.test(c.error || "");
      },
      "desktop surfaces the server drop",
      9000
    );
    check("desktop: server drop surfaces an accurate retrying state", noticed);

    // Restart the server: the app reconnects and rejoins on its own.
    const restarted = spawnCollabServer(collabPort, collabData);
    try {
      await restarted.listening;
    } catch (err) {
      console.log("  [collab restart failed] " + (err && err.message ? err.message : String(err)));
    }
    const rejoined = await until(
      win,
      () => window.__spatia.collab.isJoined && window.__spatia.collab.role === "owner" && /^smoke-/.test(window.__spatia.collab.roomId),
      "desktop rejoins after a server restart",
      33000
    );
    check("desktop: auto-reconnects and rejoins after a server restart", rejoined);
    restarted.child.kill();

    // A broken URL must end in the app's accurate give-up error, not a hang.
    // Port 1 is guaranteed refused, so the retry budget exhausts quickly.
    await win.webContents.executeJavaScript(`(async () => {
      window.__spatia["connectCollab"]("ws://127.0.0.1:1");
      window.__spatia["joinRoom"]("smoke-badurl");
    })()`);
    const surrender = await until(
      win,
      () => window.__spatia.collab.status === "error" && /npm run server/i.test(window.__spatia.collab.error || ""),
      "desktop give-up error for a broken server",
      39000
    );
    check("desktop: broken server surfaces an accurate give-up message", surrender);
  } else {
    check("desktop: owner shares canvas + presence while joined", false);
    check("desktop: server drop surfaces an accurate retrying state", false);
    check("desktop: auto-reconnects and rejoins after a server restart", false);
    check("desktop: broken server surfaces an accurate give-up message", false);
  }
  try {
    if (collabServer.child.exitCode === null) collabServer.child.kill();
  } catch {
    /* ignore */
  }
  fs.rmSync(collabData, { recursive: true, force: true });

  // ---- M5 rich media on desktop: real file import → native thumbnail chip ----
  const { Buffer } = require("buffer");
  // 1x1 magenta PNG (solid color, fully decodable by nativeImage).
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
  const tmpPng = path.join(os.tmpdir(), "smoke-asset-" + Date.now() + ".png");
  fs.writeFileSync(tmpPng, pngBytes);
  const media = await win.webContents.executeJavaScript(`(async () => {
    const app = window.__spatia;
    await app["importDropped"](${JSON.stringify(tmpPng)}, "smoke-verify.png");
    await new Promise((r) => setTimeout(r, 300));
    const a = app.project.getAssets()[0];
    const imgObjs = app.project.getObjects().filter((o) => o.type === "image");
    const thumbOk = !!a && a.kind === "image" && /^data:image\\//.test(a.thumbnail || "");
    const imgRef = !!a && imgObjs.length === 1 && imgObjs[0].assetId === a.id;
    app["toggleAssetsPanel"]();
    await new Promise((r) => setTimeout(r, 120));
    const panelOpen = document.getElementById("assets-panel").classList.contains("panel-open");
    const chipImg = !!document.querySelector(".asset-chip .asset-thumb-img");
    const chipName = (document.querySelector(".asset-chip .asset-name") || {}).textContent || "";
    const title = document.getElementById("assets-title").textContent || "";
    app["toggleAssetsPanel"]();
    const deleted = a ? await window.spatia.deleteAsset(app.project.getMeta().id, a.id) : false;
    if (a) app.project.removeAsset(a.id);
    app["refreshAssetsUi"]();
    return { thumbOk, imgRef, panelOpen, chipImg, chipName, title, deleted, remaining: app.project.getAssets().length };
  })()`);
  check("desktop: imported image becomes an asset with a native thumbnail", media.thumbOk);
  check("desktop: image object references the asset", media.imgRef);
  check("desktop: Assets panel opens and renders a thumbnail chip", media.panelOpen && media.chipImg && media.chipName === "smoke-verify.png");
  check("desktop: assets panel title counts imports", /^Assets \(1\)$/.test(media.title));
  check("desktop: deleteAsset removes the underlying file", media.deleted && media.remaining === 0);
  fs.rmSync(tmpPng, { force: true });

  // ---- Browser Frame plugin: real interactive webview in a canvas frame ----
  const bfReady = await until(
    win,
    () => window.__spatia.plugins.entriesList().some((e) => e.id === "browser-frame" && e.enabled),
    "browser-frame plugin listed + enabled",
    15000
  );
  check("desktop: browser-frame plugin loads", bfReady);
  const bfBuiltin = await win.webContents.executeJavaScript(`(() => {
    const e = window.__spatia.plugins.entriesList().find((x) => x.id === "browser-frame");
    return !!e && e.builtIn === true;
  })()`);
  check("desktop: browser-frame is built in (no install URL / server needed)", bfBuiltin);

  const bfCreated = await win.webContents.executeJavaScript(`(async () => {
    const app = window.__spatia;
    await app.plugins.dispatchCommand("browser-frame.add");
    let frame = null;
    for (let i = 0; i < 25 && !frame; i++) {
      frame = app.project.getObjects().find((o) => o.type === "frame");
      if (!frame) await new Promise((r) => setTimeout(r, 100));
    }
    return {
      command: window.__spatia.plugins.commandsList().some((c) => c.id === "browser-frame.add"),
      created: !!frame,
      url: frame ? (frame.metadata && frame.metadata.browserUrl) || "" : "",
      selected: !!frame && app.selection.has(frame.id),
      toast: !!document.getElementById("app-toast"),
    };
  })()`);
  check("desktop: Add Browser Frame command exists", bfCreated.command);
  check("desktop: command creates a frame holding the Google URL", bfCreated.created && bfCreated.url === "https://www.google.com/" && bfCreated.selected);
  check("desktop: toast element present after the command notifies", bfCreated.toast);

  const googleLoaded = await until(
    win,
    () => {
      try { window.__spatia["renderOverlay"](); } catch (e) { /* app not ready */ }
      const wv = document.querySelector("#browser-layer webview");
      let u = ""; try { u = String(wv && typeof wv.getURL === "function" ? wv.getURL() : ""); } catch (e) { u = ""; }
      return u.length > 0 && u.indexOf("google.") !== -1;
    },
    "browser-frame webview loads Google",
    60000
  );
  check("desktop: Google actually loads in the webview", googleLoaded);

  await win.webContents.executeJavaScript(`(() => {
    const addr = document.querySelector("#browser-layer .browser-addr");
    const go = document.querySelector("#browser-layer .bf-go");
    if (addr) addr.value = "https://example.com";
    if (go) go.click();
    return true;
  })()`);
  const exampleLoaded = await until(
    win,
    () => {
      try { window.__spatia["renderOverlay"](); } catch (e) { /* app not ready */ }
      const wv = document.querySelector("#browser-layer webview");
      let u = ""; try { u = String(wv && typeof wv.getURL === "function" ? wv.getURL() : ""); } catch (e) { u = ""; }
      return u.length > 0 && u.indexOf("example.com") !== -1;
    },
    "address bar navigation to example.com",
    45000
  );
  const navPending = await until(
    win,
    () => {
      const frame = window.__spatia.project.getObjects().find((o) => o.type === "frame");
      return frame ? (frame.metadata && frame.metadata.browserUrl || "").indexOf("example.com") !== -1 : false;
    },
    "current URL saved back to frame metadata (debounced)",
    15000
  );
  check("desktop: address bar navigation works", exampleLoaded);
  check("desktop: the current URL is saved back to the frame metadata", navPending);

  await win.webContents.executeJavaScript(`(() => {
    const wv = document.querySelector("#browser-layer webview");
    if (wv && typeof wv.canGoBack === "function" && wv.canGoBack()) {
      const back = document.querySelector("#browser-layer .bf-nav");
      if (back) back.click();
    }
    return true;
  })()`);
  const backOk = await until(
    win,
    () => {
      try { window.__spatia["renderOverlay"](); } catch (e) { /* app not ready */ }
      const wv = document.querySelector("#browser-layer webview");
      let u = ""; try { u = String(wv && typeof wv.getURL === "function" ? wv.getURL() : ""); } catch (e) { u = ""; }
      return u.length > 0 && u.indexOf("google.") !== -1;
    },
    "back button returns to Google",
    45000
  );
  check("desktop: back navigation works", backOk);

  // Move + resize the frame object; the overlay must track it exactly.
  const overlayTrack = await win.webContents.executeJavaScript(`(async () => {
    const app = window.__spatia;
    const frame = app.project.getObjects().find((o) => o.type === "frame");
    if (!frame) return { match: false };
    app.project.moveObjectsTo([{ id: frame.id, x: 500, y: 400 }]);
    app.project.resizeObject(frame.id, 500, 400, 900, 500);
    for (let i = 0; i < 4; i++) {
      app["renderOverlay"]();
      await new Promise((r) => setTimeout(r, 100));
    }
    const el = document.querySelector("#browser-layer .browser-frame");
    if (!el) return { match: false };
    const f = app.engine.getFrame();
    const got = [parseFloat(el.style.left), parseFloat(el.style.top), parseFloat(el.style.width), parseFloat(el.style.height)];
    const exp = [(500 - f.cameraX) * f.zoom, (400 - f.cameraY) * f.zoom, 900 * f.zoom, 500 * f.zoom];
    return {
      match: got.every((g, i) => Math.abs(g - exp[i]) < 2),
      got,
      exp,
    };
  })()`);
  check("desktop: move + resize keep the browser overlay aligned", overlayTrack.match);

  // Resize the frame smaller and larger; the overlay must track live and the
  // webview must never shrink below the usable minimum.
  const resizeTrack = await win.webContents.executeJavaScript(`(async () => {
    const app = window.__spatia;
    const frame = app.project.getObjects().find((o) => o.type === "frame");
    if (!frame) return { match: false };
    const check = async (w, h) => {
      app.project.resizeObject(frame.id, frame.x, frame.y, w, h);
      for (let i = 0; i < 4; i++) {
        app["renderOverlay"]();
        await new Promise((r) => setTimeout(r, 80));
      }
      const el = document.querySelector("#browser-layer .browser-frame");
      if (!el) return false;
      // The store clamps frames to the usable minimum, so compare against the
      // actual (possibly clamped) object size rather than the requested size.
      const o = app.project.getObjects().find((x) => x.id === frame.id);
      const f = app.engine.getFrame();
      const gotW = parseFloat(el.style.width);
      const gotH = parseFloat(el.style.height);
      return (o != null && o.type === "frame")
        ? Math.abs(gotW - o.width * f.zoom) < 2 && Math.abs(gotH - o.height * f.zoom) < 2
        : false;
    };
    const large = await check(1000, 620);
    const small = await check(240, 170);
    const clamped = await check(40, 30);
    const o = app.project.getObjects().find((x) => x.id === frame.id);
    return {
      match: large && small && clamped,
      final: o ? [o.width, o.height] : null,
    };
  })()`);
  check("desktop: frame resizes smaller/larger with the overlay tracking it", resizeTrack.match);
  check("desktop: extreme shrink respects the usable minimum size", resizeTrack.final[0] >= 200 && resizeTrack.final[1] >= 150);

  check("desktop: no uncaught console errors from the plugin boot", errors.length === 0);
  if (errors.length) console.error("CONSOLE ERRORS:\n" + errors.join("\n"));

  win.destroy();
  app.exit(failures === 0 ? 0 : 1);
}).catch((err) => {
  console.error("SMOKE CRASH:", err);
  app.exit(2);
});