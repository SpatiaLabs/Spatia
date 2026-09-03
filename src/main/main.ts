import { app, BrowserWindow } from "electron";
import { createMainWindow } from "./window.js";
import { registerIpc } from "./ipc.js";

let mainWindow: BrowserWindow | null = null;

app.setName("Spatia");

function onReady(): void {
  registerIpc();
  mainWindow = createMainWindow();
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(onReady);

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createMainWindow();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
