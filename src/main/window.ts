import { BrowserWindow, Menu, shell } from "electron";
import * as path from "path";

/**
 * Creates the main Spatia application window with secure defaults: context
 * isolation enabled, node integration disabled, and a preload bridge only.
 */
export function createMainWindow(): BrowserWindow {
  const preloadPath = path.join(__dirname, "preload.js");
  const indexHtml = path.join(__dirname, "..", "..", "renderer", "index.html");

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: "Spatia",
    backgroundColor: "#121417",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: preloadPath,
      // Enables the `<webview>` tag used by the Browser Frame plugin's canvas
      // rendering primitive. Guests are hardened by will-attach-webview below.
      webviewTag: true,
      // Only forwarded when the process is started with SPATIA_BENCH=1; lets the
      // renderer emit startup marks on the main process's clock (see main.ts).
      additionalArguments: process.env.SPATIA_BENCH === "1"
        ? ["--spatia-bench", `--spatia-t0=${process.env.SPATIA_BENCH_T0 ?? Date.now()}`]
        : [],
    },
  });

  win.setMenuBarVisibility(false);

  // Browser Frame guests carry untrusted web content. Whatever the embedder
  // requests, force the guest into a minimal profile: no preload, no node, a
  // sandbox, and a non-persistent (in-memory) partition so browsing stays
  // session-only. Non-http(s) payloads are refused outright.
  win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    const src = String(params.src || "");
    if (!/^https?:\/\//.test(src)) {
      event.preventDefault();
      return;
    }
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    delete webPreferences.preload;
    webPreferences.partition = "browser-frame";
  });

  // Remove the default application menu. Electron's default menu registers
  // role-based accelerators (Ctrl+Z / Ctrl+Y / Ctrl+X / Ctrl+C / Ctrl+V /
  // Ctrl+A) that are consumed by the OS/browser accelerator layer BEFORE they
  // reach the renderer window's `keydown` listeners. Spatia handles all of its
  // shortcuts in the renderer, so detaching the default menu lets those Ctrl
  // key events propagate normally. The menu bar is already hidden, so this is
  // invisible to the user.
  Menu.setApplicationMenu(null);

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  void win.loadFile(indexHtml);

  // F11 toggles fullscreen. Using before-input-event on webContents keeps it
  // in the main process so it never interferes with the renderer's keyboard
  // handling or shortcuts.
  win.webContents.on("before-input-event", (_event, input) => {
    if (input.type === "keyDown" && input.key === "F11") {
      win.setFullScreen(!win.isFullScreen());
    }
  });

  return win;
}
