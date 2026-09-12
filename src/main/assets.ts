import { promises as fs } from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { app, dialog, nativeImage } from "electron";
import type { AssetMeta } from "../shared/types/object.js";
import { activeProjectFolder } from "./storage.js";

/**
 * Project-local asset store. The renderer never touches the filesystem; the
 * main process owns asset binaries. Once a project lives in its own default
 * folder (`C:\Spatia\SpatiaProjects\<Name>\assets\`) the binaries are stored
 * there so media travels with the project; otherwise they stay under the app's
 * user-data directory keyed by project id (legacy/imported projects).
 *
 * Project JSON stores only asset *metadata* (never binary), so large
 * images/files stay out of the project file.
 *
 * Layout (folder project):  <project folder>/assets/<assetId><ext>
 * Layout (legacy):          <userData>/spatia-assets/<projectId>/<assetId><ext>
 */

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".avif"]);
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v", ".ogv"]);
const AUDIO_EXTS = new Set([".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac", ".opus", ".webm"]);
const PDF_EXTS = new Set([".pdf"]);

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".m4v": "video/x-m4v",
  ".ogv": "video/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".opus": "audio/opus",
};

function assetsRoot(): string {
  return path.join(app.getPath("userData"), "spatia-assets");
}

function projectDir(projectId: string): string {
  // Folder projects store media inside their own assets/ directory so copying
  // the project folder captures everything. Legacy projects fall back to the
  // user-data store (backward compatible with existing media).
  const folder = activeProjectFolder(projectId);
  if (folder) return path.join(folder, "assets");
  return path.join(assetsRoot(), sanitize(projectId));
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function newAssetId(): string {
  return "ast_" + randomUUID();
}

function kindFor(mime: string, ext: string): AssetMeta["kind"] {
  const lower = ext.toLowerCase();
  if (mime.startsWith("image/") || IMAGE_EXTS.has(lower)) return "image";
  if (PDF_EXTS.has(lower) || mime === "application/pdf") return "pdf";
  if (VIDEO_EXTS.has(lower) || mime.startsWith("video/")) return "video";
  if (AUDIO_EXTS.has(lower) || mime.startsWith("audio/")) return "audio";
  return "file";
}

function mimeFor(ext: string): string {
  const lower = ext.toLowerCase();
  return MIME_BY_EXT[lower] ?? "application/octet-stream";
}

/**
 * Capture a compact thumbnail (256px wide PNG data URL) for an image file.
 * Uses Electron's nativeImage so no canvas is needed in the main process.
 * Returns null when the file isn't a decodable image (e.g. SVG).
 */
function thumbnailForImage(filePath: string): string | null {
  try {
    const image = nativeImage.createFromPath(filePath);
    if (image.isEmpty()) return null;
    const resized = image.getSize().width <= 288 ? image : image.resize({ width: 256 });
    const dataUrl = resized.toDataURL();
    return dataUrl && dataUrl.length > 0 ? dataUrl : null;
  } catch {
    return null;
  }
}

export interface ImportResult {
  canceled: boolean;
  asset: AssetMeta | null;
}

/** Import an asset from an existing source path (used by OS drag-and-drop). */
export async function importFromPath(
  projectId: string,
  sourcePath: string,
  sourceName?: string
): Promise<ImportResult> {
  try {
    const stat = await fs.stat(sourcePath);
    if (!stat.isFile()) return { canceled: true, asset: null };
    const ext = path.extname(sourcePath).toLowerCase() || ".bin";
    const id = newAssetId();
    const dir = projectDir(projectId);
    await fs.mkdir(dir, { recursive: true });
    const dest = path.join(dir, id + ext);
    await fs.copyFile(sourcePath, dest);
    const mime = mimeFor(ext);
    const kind = kindFor(mime, ext);
    const name = sourceName ?? path.basename(sourcePath);
    const thumbnail = kind === "image" ? thumbnailForImage(dest) : undefined;
    const asset: AssetMeta = {
      id,
      kind,
      name,
      size: stat.size,
      mime,
      ext: ext.replace(".", ""),
      ...(thumbnail ? { thumbnail } : {}),
    };
    return { canceled: false, asset };
  } catch {
    return { canceled: true, asset: null };
  }
}

/** Show a native picker for any file and import it into the project's assets. */
export async function pickAndImport(projectId: string): Promise<ImportResult> {
  const result = await dialog.showOpenDialog({
    title: "Add to canvas",
    properties: ["openFile"],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true, asset: null };
  }
  return importFromPath(projectId, result.filePaths[0]);
}

/**
 * Copy externally supplied asset binaries (e.g. from an imported `.spatia`
 * bundle) into the project-local store, keyed by the bundle's asset ids (file
 * names are `<assetId><ext>`). No-op for files that are already present.
 */
export async function importAssetBinaries(
  projectId: string,
  files: Record<string, string>
): Promise<boolean> {
  if (!files || Object.keys(files).length === 0) return true;
  const dir = projectDir(projectId);
  await fs.mkdir(dir, { recursive: true });
  try {
    for (const [fileName, sourcePath] of Object.entries(files)) {
      const dest = path.join(dir, path.basename(fileName));
      if (await fs.stat(dest).catch(() => null)) continue;
      await fs.copyFile(sourcePath, dest);
    }
    return true;
  } catch {
    return false;
  }
}

/** Read an asset back as a data URL (used to render images on canvas). */
export async function readAssetDataUrl(projectId: string, assetId: string): Promise<string | null> {
  try {
    const dir = projectDir(projectId);
    const entries = await fs.readdir(dir);
    const file = entries.find((f) => f.startsWith(assetId + "."));
    if (!file) return null;
    const full = path.join(dir, file);
    const ext = path.extname(file).toLowerCase();
    const mime = mimeFor(ext);
    const data = await fs.readFile(full);
    return `data:${mime};base64,${data.toString("base64")}`;
  } catch {
    return null;
  }
}

/** Resolve the on-disk file path for an asset, or null if it is missing. */
export async function assetFilePath(projectId: string, assetId: string): Promise<string | null> {
  try {
    const dir = projectDir(projectId);
    const entries = await fs.readdir(dir);
    const file = entries.find((f) => f.startsWith(assetId + "."));
    return file ? path.join(dir, file) : null;
  } catch {
    return null;
  }
}

/** Whether an asset's binary currently exists in the project-local store. */
export async function assetExists(projectId: string, assetId: string): Promise<boolean> {
  return (await assetFilePath(projectId, assetId)) !== null;
}

/** Open an asset's source file with the OS default application. */
export async function openAsset(projectId: string, assetId: string): Promise<boolean> {
  const filePath = await assetFilePath(projectId, assetId);
  if (!filePath) return false;
  const { shell } = await import("electron");
  try {
    await shell.openPath(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Replace an asset's stored binary with a new source file, keeping the same
 * asset id and applying the new file's metadata/kind. Returns the updated
 * metadata, or null if the source cannot be read.
 */
export async function relinkAsset(
  projectId: string,
  assetId: string,
  sourcePath: string
): Promise<AssetMeta | null> {
  try {
    const stat = await fs.stat(sourcePath);
    if (!stat.isFile()) return null;
    const currentFile = await assetFilePath(projectId, assetId);
    if (currentFile) await fs.rm(currentFile, { force: true });
    const ext = path.extname(sourcePath).toLowerCase() || ".bin";
    const dir = projectDir(projectId);
    await fs.mkdir(dir, { recursive: true });
    const dest = path.join(dir, assetId + ext);
    await fs.copyFile(sourcePath, dest);
    const mime = mimeFor(ext);
    const kind = kindFor(mime, ext);
    const thumbnail = kind === "image" ? thumbnailForImage(dest) : undefined;
    const meta: AssetMeta = {
      id: assetId,
      kind,
      name: path.basename(sourcePath),
      size: stat.size,
      mime,
      ext: ext.replace(".", ""),
      ...(thumbnail ? { thumbnail } : {}),
    };
    return meta;
  } catch {
    return null;
  }
}

/** Permanently delete an asset binary from the project-local store. */
export async function deleteAsset(projectId: string, assetId: string): Promise<boolean> {
  try {
    const currentFile = await assetFilePath(projectId, assetId);
    if (!currentFile) return false;
    await fs.rm(currentFile, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Show a picker for choosing a replacement source file while relinking. */
export async function pickRelinkSource(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: "Choose replacement file",
    properties: ["openFile"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}
