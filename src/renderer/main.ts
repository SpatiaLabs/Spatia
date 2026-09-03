import { App } from "./app.js";

function bootstrap(): void {
  const canvas = document.getElementById("canvas");
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error("Canvas element not found.");
  }

  const app = new App(canvas);
  app.start();

  // Keep a handle for future debugging/tests.
  (window as unknown as Record<string, unknown>).__spatia = app;
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}
