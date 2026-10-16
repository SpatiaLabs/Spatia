import { app, BrowserWindow } from "electron";
import { createMainWindow } from "./window.js";
import { registerIpc } from "./ipc.js";

let mainWindow: BrowserWindow | null = null;
let pendingInvite: string | null = null;
let inviteDeliveryReady = false;
let quitScheduled = false;

// ── Startup instrumentation (diagnostic only; enabled with SPATIA_BENCH=1) ──
const BENCH = process.env.SPATIA_BENCH === "1";
const benchT0 = Date.now();
if (BENCH) process.env.SPATIA_BENCH_T0 = String(benchT0);
function bench(label: string): void {
  if (!BENCH) return;
  process.stdout.write(`[bench] ${label} +${Date.now() - benchT0}ms\n`);
}
bench("main:module-start");

app.setName("Spatia");

// Windows: a stable AppUserModelID keeps taskbar grouping, notifications and
// the Jump List attached to the installed app rather than the Electron shell.
if (process.platform === "win32") {
  app.setAppUserModelId("com.spatia.desktop");
}

const SPDT_URL_SCHEME = "spatia";
// The protocol client registration writes HKCU and is only needed for invite
// links. It used to run at module load, on the startup critical path, before
// the window existed; schedule it after the window is up instead.
function registerProtocolClient(): void {
  try {
    app.setAsDefaultProtocolClient(SPDT_URL_SCHEME);
  } catch {
    /* protocol registration is best-effort */
  }
}

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
    bench("app:ready");
    registerIpc();
    bench("ipc-registered");
    mainWindow = createMainWindow();
    bench("window:created");
    // Registry writes (Jump List tasks, protocol client) are not needed for the
    // window to become usable, so run them once the window is on screen.
    mainWindow.once("ready-to-show", () => {
      registerProtocolClient();
      installWindowsJumpList();
      bench("deferred-main-init");
    });
    if (BENCH) {
      const wc = mainWindow.webContents;
      wc.on("dom-ready", () => bench("renderer:dom-ready"));
      wc.on("did-finish-load", () => bench("renderer:did-finish-load"));
      wc.on("did-stop-loading", () => bench("renderer:did-stop-loading"));
      wc.on("console-message", (...args: unknown[]) => {
        const msg = typeof args[1] === "object" && args[1] !== null
          ? (args[1] as { message?: string }).message
          : String(args[2]);
        if (typeof msg === "string" && msg.startsWith("[bench]")) {
          process.stdout.write(msg + "\n");
          // The renderer marks "interactive" once it has painted the first
          // usable frame. Give it a short settle window, then exit so the
          // harness gets a bounded, repeatable measurement.
          if (msg.includes("renderer:interactive") && !quitScheduled) {
            quitScheduled = true;
            setTimeout(() => { bench("harness:exit"); app.exit(0); }, 600);
          }
        }
      });
      mainWindow.once("ready-to-show", () => bench("window:ready-to-show"));
      mainWindow.once("show", () => bench("window:show"));
      mainWindow.once("focus", () => bench("window:focus"));
    }
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