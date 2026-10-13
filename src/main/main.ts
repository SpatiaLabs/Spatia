import { app, BrowserWindow } from "electron";
import { createMainWindow } from "./window.js";
import { registerIpc } from "./ipc.js";

let mainWindow: BrowserWindow | null = null;
let pendingInvite: string | null = null;
let inviteDeliveryReady = false;

app.setName("Spatia");

// Windows: a stable AppUserModelID keeps taskbar grouping, notifications and
// the Jump List attached to the installed app rather than the Electron shell.
if (process.platform === "win32") {
  app.setAppUserModelId("com.spatia.desktop");
}

const SPDT_URL_SCHEME = "spatia";
// Flags used by the packaged app; ignored (but harmless) in dev.
app.setAsDefaultProtocolClient(SPDT_URL_SCHEME);

/** A Jump List task = a one-click entry in the taskbar's right-click menu. */
function installWindowsJumpList(): void {
  // No-op on non-Windows platforms (addRecentDocument and setUserTasks are
  // Windows/macOS APIs; the macOS dock ignores tasks).
  if (process.platform !== "win32") return;
  try {
    app.setUserTasks([
      {
        program: process.execPath,
        arguments: "",
        title: "New workspace",
        description: "Open a fresh Spatia canvas",
        iconPath: process.execPath,
        iconIndex: 0,
      },
    ]);
  } catch {
    /* the Jump List is best-effort */
  }
}

/** Deliver a queued invite once the renderer is ready to receive it. */
function flushInvite(): void {
  if (!pendingInvite) return;
  const win = mainWindow ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed() && inviteDeliveryReady) {
    win.webContents.send("collab:join", pendingInvite);
    pendingInvite = null;
  }
}

/** Forward an invite link to the renderer so it can join the shared room. */
function forwardJoinUrl(targetUrl: string | null | undefined): void {
  if (!targetUrl) return;
  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol !== `${SPDT_URL_SCHEME}:`) return;
    const room = parsed.searchParams.get("room");
    if (!room) return;
    pendingInvite = room;
    flushInvite();
  } catch {
    /* not a usable invite link */
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    forwardJoinUrl(argv.find((a) => a.startsWith(`${SPDT_URL_SCHEME}:`)));
  });

  function onReady(): void {
    registerIpc();
    installWindowsJumpList();
    mainWindow = createMainWindow();
    mainWindow.webContents.once("did-finish-load", () => {
      inviteDeliveryReady = true;
      flushInvite();
    });
    mainWindow.on("closed", () => {
      mainWindow = null;
      inviteDeliveryReady = false;
    });
    if (process.platform === "darwin") {
      app.on("open-url", (_event, url) => forwardJoinUrl(url));
    } else {
      const viaArgv = process.argv.find((a) => a.startsWith(`${SPDT_URL_SCHEME}:`));
      if (viaArgv) forwardJoinUrl(viaArgv);
    }
  }

  app.whenReady().then(onReady);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
      mainWindow.webContents.once("did-finish-load", () => {
        inviteDeliveryReady = true;
        flushInvite();
      });
      mainWindow.on("closed", () => {
        mainWindow = null;
        inviteDeliveryReady = false;
      });
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}