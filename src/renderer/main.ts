import { App } from "./app.js";
import { TabletUI } from "./ui/tabletUI.js";
import { bench, benchEnabled } from "./util/bench.js";

bench("script-start");

interface SpatiaSiteHooks {
  isTablet?(): boolean;
}

/**
 * Whether the renderer is running in a web context that should offer the
 * dedicated iPad / tablet interface. Site.js owns the canonical answer when it
 * is loaded (it knows about the test-forcing hooks in `window.__spatiaSite`);
 * otherwise fall back to the plain device checks. Desktop Electron (file://)
 * and plain desktop browsers never take this path.
 */
function isTabletDevice(): boolean {
  if (!/^https?:$/.test(window.location.protocol)) return false;
  const site = (window as unknown as Record<string, unknown>).__spatiaSite as SpatiaSiteHooks | undefined;
  if (site && typeof site.isTablet === "function") return site.isTablet();
  const ua = navigator.userAgent || "";
  const wide =
    typeof window.matchMedia === "function" && window.matchMedia("(min-width: 768px)").matches;
  const coarse =
    typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  if (/iPad/.test(ua)) return true;
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1 && wide) return true;
  return coarse && wide;
}

function bootstrap(): void {
  bench("bootstrap");
  const canvas = document.getElementById("canvas");
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error("Canvas element not found.");
  }

  const app = new App(canvas);
  bench("app-constructed");
  app.start();
  bench("app-started");

  const tablet = isTabletDevice();
  // Desktop panels stay anchored at their CSS positions; the tablet gets its
  // own shell (web context only), so mount it after the shared app starts.
  if (tablet) {
    new TabletUI(app).attach();
    bench("tablet-mounted");
  }

  // Keep a handle for future debugging/tests.
  (window as unknown as Record<string, unknown>).__spatia = app;

  // Mark the first frame after the app is usable. The main process uses this to
  // end a SPATIA_BENCH run (see src/main/main.ts).
  if (benchEnabled()) {
    requestAnimationFrame(() => requestAnimationFrame(() => bench("interactive")));
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}