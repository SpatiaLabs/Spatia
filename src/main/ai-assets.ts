/**
 * Serves the bundled Local-AI runtime files (the wllama compat build) to the
 * renderer as base64. The renderer cannot fetch() static files over file://
 * (CORS blocks it), so the main process reads them and hands the bytes over.
 * Only a fixed whitelist of names is readable.
 */
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { AiAssetResult } from "./preload.js";

const WHITELIST: Record<string, { file: string; mime: string }> = {
  "compat.js": { file: "compat.js", mime: "text/javascript" },
  "compat.wasm": { file: "compat.wasm", mime: "application/wasm" },
};

export function getAiAsset(name: string): AiAssetResult | null {
  const entry = WHITELIST[name];
  if (!entry) return null;
  try {
    const filePath = path.join(app.getAppPath(), "dist", "renderer", "ai", "vendor", entry.file);
    const bytes = fs.readFileSync(filePath);
    return { data: bytes.toString("base64"), mime: entry.mime };
  } catch {
    return null;
  }
}