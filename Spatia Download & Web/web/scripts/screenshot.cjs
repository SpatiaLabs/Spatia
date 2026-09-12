"use strict";

/**
 * Captures REAL screenshots of the actual Spatia application by booting the
 * functional Spatia Web build (the #/web route) in an Electron window and
 * driving the real renderer through the app's own API.
 *
 * Run with:  electron screenshot.cjs
 * (uses the project's electron + serves the website statically on 127.0.0.1)
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const { app, BrowserWindow, nativeImage } = require("electron");

const BASE = path.resolve(__dirname, "..", ".."); // "Spatia Download & Web"
const PROJECT = path.resolve(__dirname, "..", "..", ".."); // Spatia repo root
const PORT = 8755;
const WIDTH = 1440;
const HEIGHT = 900;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function execute(win, fn) {
  const result = await win.webContents.executeJavaScript(`(${fn.toString()})()`);
  return result;
}

const waitForApp = async (win) => {
  for (let i = 0; i < 150; i++) {
    const ok = await win.webContents.executeJavaScript(
      `!!(window.__spatia && window.__spatia.engine && window.__spatia.engine.canvas().width > 0)`
    );
    if (ok) return true;
    await sleep(150);
  }
  const diag = await win.webContents.executeJavaScript(`(function(){
    const c = document.getElementById("canvas");
    return {
      spatia: !!window.__spatia,
      bridge: !!window.__spatiaBridge,
      bootError: window.__webBootError || null,
      status: (document.getElementById("status-text")||{}).innerText || null,
      canvas: c ? { w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight } : null,
      scripts: [].map.call(document.scripts || [], function (s) { return s.src; }),
      webPlatform: navigator.platform,
    };
  })()`);
  const probe = await win.webContents.executeJavaScript(
    `import("./web/js/renderer/main.js").then(function(){ return "ok"; }).catch(function(e){ return "ERR: " + (e && e.message); })`
  ).catch((e) => "probefail:" + e.message);
  process.stderr.write("boot diagnostics:\n" + JSON.stringify({ diag, probe }, null, 2) + "\n");
  return false;
};

const capture = async (win, name) => {
  await sleep(250);
  const img = await win.webContents.capturePage();
  if (img.isEmpty()) throw new Error(`Empty capture for ${name}`);
  const outDir = path.join(BASE, "assets", "raw");
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `${name}.png`);
  fs.writeFileSync(out, img.toPNG());
  process.stdout.write(`  captured ${name}.png (${img.getSize().width}x${img.getSize().height})\n`);
};

// ---------- Scene seeding (runs inside the page, against the real App) ----------

const seed = async function () {
  const app = window.__spatia;
  const engine = app.engine;
  const project = app.project;

  const fi = (box, padX, padY) => {
    const f = engine.getFrame();
    const z = Math.max(0.2, Math.min(4, (f.originWidth - padX * 2) / box.w, (f.originHeight - padY * 2) / box.h));
    return { x: box.cx - f.originWidth / (2 * z), y: box.cy - f.originHeight / (2 * z), zoom: z };
  };
  const focus = (box, padX, padY) => app.viewport.set(fi(box, padX, padY));

  const note = (cx, cy, title, text, color) => {
    const id = engine.createObject("note", { x: cx, y: cy });
    const o = project.getObject(id);
    if (o) {
      o.title = title;
      o.text = text;
      o.color = typeof color === "string" && color ? color : "#f0c33c";
    }
    return id;
  };
  const textObj = (cx, cy, text, fontSize) => {
    const id = engine.createObject("text", { x: cx, y: cy });
    const o = project.getObject(id);
    if (o) {
      o.text = text;
      o.fontSize = fontSize || 24;
      o.bold = /[0-9]+/.test(text) && text.length < 16;
    }
    return id;
  };
  const conn = (a, b) => { if (a && b) engine.createConnection(a, b); };

  // --- left / title cluster ---
  const t2 = textObj(300, 60, "Spatia 0.2.0", 46);
  const n5 = note(150, 260, "Ideas", "The canvas is the app.\nEverything else disappears.");

  // --- main frame ---
  const frameId = engine.createFrame({ x: 360, y: 320 });
  const fr = project.getObject(frameId);
  fr.x = 140; fr.y = 140; fr.width = 640; fr.height = 430; fr.name = "Launch — v0.2";

  const n1 = note(300, 260, "Scope", "Desktop v0.2\nWeb preview\nPublish the site");
  const n2 = note(580, 250, "Users", "Interview 3 teams\nShip early\nTalk to beta testers");
  const n3 = note(430, 480, "Milestones", "Beta → GA\nWindows 10 / 11 · x64");

  conn(n1, n2);

  // --- right cluster ---
  const t1 = textObj(910, 220, "Fast. Local. Yours.", 24);
  const penId = (() => {
    const points = [
      { x: 780, y: 308 }, { x: 810, y: 324 }, { x: 850, y: 333 }, { x: 892, y: 330 },
      { x: 930, y: 321 }, { x: 964, y: 306 }, { x: 990, y: 290 },
    ];
    const minX = Math.min(...points.map((p) => p.x));
    const maxX = Math.max(...points.map((p) => p.x));
    const minY = Math.min(...points.map((p) => p.y));
    const maxY = Math.max(...points.map((p) => p.y));
    const o = {
      type: "pen",
      id: "obj_" + (crypto.randomUUID ? crypto.randomUUID() : "pen" + Math.random().toString(36).slice(2)),
      x: minX, y: minY, width: maxX - minX, height: maxY - minY,
      rotation: 0, zIndex: project.nextZIndex(), locked: false, metadata: {},
      points, color: "#8aa2ff", strokeWidth: 3,
    };
    project.addObject(o);
    return o.id;
  })();
  const u1 = engine.createUrlObject("https://spatiaweb.surge.sh", "Spatia — official site", { x: 980, y: 430 });
  const n4 = note(880, 610, "Notes", "Ship the web build\nKeep it local-first\nExport anytime");

  // --- icon image (the real Spatia icon) ---
  const iconMeta = await (async () => {
    const res = await fetch("./web/sample/spatia-icon.png");
    const blob = await res.blob();
    const file = new File([blob], "spatia-icon.png", { type: "image/png" });
    return window.__spatiaBridge.importFile(file, project.getMeta().id);
  })();
  project.addAssets([iconMeta]);
  app.engine.createImageObject(iconMeta.id, { x: 720, y: 700 });
  app.engine.ensureImage(iconMeta.id);

  conn(t2, frameId);
  conn(n5, frameId);
  conn(frameId, t1);
  conn(t1, u1);
  conn(u1, n4);

  // --- group the left cluster ---
  app.selection.setIds([t2, n5]);
  engine.groupSelection();
  app.selection.setIds([]);
  app.ui.setSidebarOpen(false);

  window.__scene = {
    ids: { t2, n5, frameId, n1, n2, n3, t1, u1, n4 },
    focus,
    all: () => ({
      w: 1030, h: 820, cx: 555, cy: 380,
    }),
  };
  return true;
};

const shotOverview = async function () {
  window.__spatia.engine.setSelection([]);
  window.__spatia.ui.setSidebarOpen(false);
  window.__scene.focus(window.__scene.all(), 110, 110);
  return true;
};

const shotWorkspace = async function () {
  window.__spatia.engine.setSelection([window.__scene.ids.u1]);
  window.__spatia.ui.setSidebarOpen(true);
  window.__scene.focus({ w: 640, h: 700, cx: 850, cy: 400 }, 60, 80);
  return true;
};

const shotDetail = async function () {
  window.__spatia.engine.setSelection([window.__scene.ids.n1]);
  window.__spatia.ui.setSidebarOpen(false);
  window.__scene.focus({ w: 780, h: 620, cx: 470, cy: 300 }, 80, 70);
  return true;
};

// ---------- Main ----------

app.whenReady().then(async () => {
  const outDir = path.join(BASE, "assets", "raw");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(BASE, "web", "sample"), { recursive: true });

  // Export the real app icon as a PNG (favicon + sample canvas asset).
  const iconPng = path.join(BASE, "web", "sample", "spatia-icon.png");
  if (!fs.existsSync(iconPng)) {
    const ico = nativeImage.createFromPath(path.join(PROJECT, "build", "icon.ico"));
    if (!ico.isEmpty()) fs.writeFileSync(iconPng, ico.toPNG());
  }

  const server = serve();
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  process.stdout.write(`serving ${BASE} on http://127.0.0.1:${PORT}/\n`);

  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    x: -2000,
    y: -2000,
    show: true,
    frame: true,
    backgroundColor: "#121417",
    webPreferences: { backgroundThrottling: false, nodeIntegration: false, contextIsolation: true },
  });

  win.webContents.on("console-message", (e, level, message) => {
    if (level >= 3) process.stdout.write(`  [console:${level}] ${message}\n`);
  });

  // 1) Verify the landing page loads (no runtime errors).
  await win.loadURL(`http://127.0.0.1:${PORT}/?no-sw=1`);
  const landingText = await win.webContents.executeJavaScript(`document.body.innerText || ""`);
  if (!/Think in space/.test(landingText)) throw new Error("Landing page did not render");
  process.stdout.write("  landing page OK\n");

  // 2) Enter the web workspace.
  await win.loadURL(`http://127.0.0.1:${PORT}/?no-sw=1#/web`);
  const webText = await win.webContents.executeJavaScript(`document.body.innerText || ""`);
  if (!/Reset/.test(webText) || !/No recent projects/.test(webText)) {
    throw new Error(`Web workspace shell missing (${webText.slice(0, 90)})`);
  }
  process.stdout.write("  web workspace shell OK\n");

  const booted = await waitForApp(win);
  if (!booted) throw new Error("Spatia app did not become ready in the browser");
  process.stdout.write("  spatiate app booted (window.__spatia ready)\n");

  // 3) Seed the scene.
  await execute(win, seed);
  await sleep(900);
  process.stdout.write("  scene seeded\n");

  // 4) Captures.
  await execute(win, shotOverview);
  await capture(win, "overview");

  await execute(win, shotWorkspace);
  await capture(win, "workspace");

  await execute(win, shotDetail);
  await capture(win, "detail");

  win.destroy();
  server.close();
  app.quit();
}).catch((err) => {
  process.stderr.write("capture failed: " + (err && err.stack ? err.stack : err) + "\n");
  app.exit(1);
});