import { App } from "./app.js";
import { TabletUI } from "./ui/tabletUI.js";

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
  const canvas = document.getElementById("canvas");
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error("Canvas element not found.");
  }

  const app = new App(canvas);
  app.start();

  if (isTabletDevice()) {
    new TabletUI(app).attach();
  }

  // Keep a handle for future debugging/tests.
  (window as unknown as Record<string, unknown>).__spatia = app;
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}