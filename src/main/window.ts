import { BrowserWindow, shell } from "electron";
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
    },
  });

  win.setMenuBarVisibility(false);

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  void win.loadFile(indexHtml);
  return win;
}
