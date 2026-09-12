"use strict";
const http = require("http");
const path = require("path");
const fs = require("fs");
const { app, BrowserWindow } = require("electron");

const BASE = path.resolve(__dirname, "..", ".."); // "Spatia Download & Web"

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    let rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
    const file = path.resolve(BASE, rel);
    if (!file.startsWith(BASE)) { res.writeHead(403); res.end("no"); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(data);
    });
  });
  await new Promise((r) => server.listen(8757, "127.0.0.1", r));
  console.log("server on 8757");

  const errors = [];
  const win = new BrowserWindow({ width: 1200, height: 800, show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.on("console-message", (e, level, message) => { if (level >= 3) errors.push(message); console.log("console[%s]: %s", level, message); });

  await win.loadURL("http://127.0.0.1:8757/?no-sw=1");
  await sleep(400);
  await win.webContents.executeJavaScript(`(() => { window.location.hash = "#/web"; })()`);
  await sleep(3000);

  const exec = (fn) => win.webContents.executeJavaScript(`(${fn.toString()})()`);

  const probe = await exec(() => {
    const pm = window.__spatia && window.__spatia.plugins;
    return {
      spatia: !!window.__spatia,
      plugins: !!pm,
      baseURI: document.baseURI,
      hostUrl: pm ? (pm.hostUrl ? String(pm.hostUrl) : "(not exposed)") : "(no pm)",
      iframes: document.querySelectorAll("iframe.spatia-plugin-host").length,
    };
  });
  console.log("probe:", JSON.stringify(probe, null, 2));

  // manual host load test
  const host = await exec(() => {
    return new Promise((resolve) => {
      const iframe = document.createElement("iframe");
      iframe.setAttribute("sandbox", "allow-scripts");
      iframe.style.display = "none";
      const t0 = Date.now();
      let got = null;
      window.addEventListener("message", (e) => {
        const d = e.data;
        if (d && d.__plugin) {
          got = { type: d.type, payload: d.payload, src: e.source === iframe.contentWindow, loadMs: Date.now() - t0 };
          resolve(got);
        }
      });
      iframe.addEventListener("load", () => {
        iframe.contentWindow.postMessage({ __plugin: true, type: "init", payload: { manifest: { id: "probe", name: "Probe", version: "1.0.0", main: "main.js" }, main: "api.addCommand({ id: 'probe.cmd', label: 'Probe', run: function(){ api.notify('x'); } });" } }, "*");
      });
      iframe.src = new URL("plugins/pluginHost.html", document.baseURI).href;
      document.body.appendChild(iframe);
      setTimeout(() => resolve({ timeout: true, got }), 5000);
    });
  });
  console.log("host:", JSON.stringify(host, null, 2));

  // reproduce the verify flow: install -> reload -> inspect
  const flow = await exec(async () => {
    const out = { install: null, entries: [], commands: [], errors: {}, counts: {} };
    try {
      out.install = await window.__spatiaBridge.installPluginSource(
        "verify-plugin",
        { id: "verify-plugin", name: "Verify Plugin", version: "1.0.0", main: "main.js", author: "QA" },
        `api.addCommand({ id: "verify.plugin-command", label: "Verify plugin command", run: async function () { api.notify("hi"); } });`
      );
    } catch (err) { out.install = { threw: String(err) }; }
    await window.__spatia.plugins.reload();
    await new Promise((r) => setTimeout(r, 1500));
    out.entries = window.__spatia.plugins.entriesList().map((e) => ({ id: e.id, builtIn: e.builtIn, enabled: e.enabled, hasManifest: !!e.manifest, main: e.manifest && e.manifest.main }));
    out.commands = window.__spatia.plugins.commandsList().map((c) => ({ id: c.id, label: c.label, pluginId: c.pluginId }));
    out.counts = { entries: out.entries.length, commands: out.commands.length };
    return out;
  });
  console.log("flow:", JSON.stringify(flow, null, 2));

  // cleanup what the flow installed so the next run starts clean
  await exec(async () => {
    try { await window.__spatiaBridge.removePluginForTest("verify-plugin"); } catch (e) { /* ignore */ }
    try { await window.__spatia.plugins.reload(); } catch (e) { /* ignore */ }
    return true;
  });

  console.log("console errors:", JSON.stringify(errors));
  win.destroy();
  server.close();
  app.quit();
});