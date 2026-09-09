import { promises as fs } from "fs";
import { randomUUID } from "node:crypto";
import * as path from "path";
import { app, dialog, shell } from "electron";
import type { ExportFileKind } from "../renderer/types/bridge.js";
import {
  normalizeLibrary,
  upsertProject,
  setProjectFolder,
  setProjectFavorite,
  setProjectTags,
  removeProject,
  renameProject,
  createFolder,
  renameFolder,
  removeFolder,
  markProjectMissing,
  LIBRARY_DATA_VERSION,
  type LibraryData,
  type LibraryFolder,
} from "../shared/library/library.js";

/**
 * Filesystem + dialog operations used for local-first project persistence.
 * All privileged filesystem access happens here (main process) and is exposed
 * to the renderer only through IPC. The renderer never touches the disk.
 */

export interface ProjectFileResult {
  /** Absolute path of the project file, or null if the user canceled. */
  filePath: string | null;
  /** Raw JSON contents of the project file. */
  contents?: string;
}

/** Persisted collaboration identity (id + display name). */
export interface CollabIdentity {
  id: string;
  name: string;
}

function identityFile(): string {
  return path.join(app.getPath("userData"), "collab-identity.json");
}

/**
 * Read (or lazily create) the stable per-machine collaboration identity used
 * for room membership. Generated with crypto's UUID when absent so a user's
 * ownership of rooms survives restarts.
 */
export async function getCollabIdentity(): Promise<CollabIdentity> {
  try {
    const raw = JSON.parse(await fs.readFile(identityFile(), "utf8")) as Partial<CollabIdentity>;
    if (typeof raw.id === "string" && raw.id && typeof raw.name === "string" && raw.name) {
      return { id: raw.id, name: raw.name };
    }
  } catch {
    /* missing/invalid — create below */
  }
  const fresh: CollabIdentity = { id: randomUUID(), name: "Guest" };
  await atomicWriteFile(identityFile(), JSON.stringify(fresh, null, 2));
  return fresh;
}

const PROJECT_FILE_FILTERS = [{ name: "Spatia Project", extensions: ["spatia.json", "json"] }];

/**
 * Atomically write file contents to disk. Writes to a sibling temp file first,
 * then renames it over the destination so a failed/crashed write never leaves a
 * half-written project file at the real path.
 */
export async function atomicWriteFile(targetPath: string, contents: string): Promise<void> {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tmpPath = path.join(dir, `.${base}.${process.pid}.tmp`);

  try {
    await fs.writeFile(tmpPath, contents, "utf8");
    try {
      await fs.rename(tmpPath, targetPath);
    } catch (err) {
      // On Windows, renaming over an existing file can throw EPERM. Fall back
      // to a remove-then-rename pair which preserves content-original safety
      // as closely as the platform allows.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EEXIST") {
        await fs.rm(targetPath, { force: true });
        await fs.rename(tmpPath, targetPath);
      } else {
        throw err;
      }
    }
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Show an "Open Project" dialog and read the chosen file. */
export async function openProjectDialog(): Promise<ProjectFileResult> {
  const result = await dialog.showOpenDialog({
    title: "Open Spatia Project",
    properties: ["openFile"],
    filters: PROJECT_FILE_FILTERS,
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { filePath: null };
  }

  const filePath = result.filePaths[0];
  const contents = await fs.readFile(filePath, "utf8");
  return { filePath, contents };
}

/** Show a "Save Project" dialog and write contents atomically. */
export async function saveWithDialog(
  suggestedName: string,
  contents: string
): Promise<ProjectFileResult> {
  const result = await dialog.showSaveDialog({
    title: "Save Spatia Project",
    defaultPath: suggestedName,
    filters: PROJECT_FILE_FILTERS,
  });

  if (result.canceled || !result.filePath) {
    return { filePath: null };
  }

  const filePath = result.filePath;
  await atomicWriteFile(filePath, contents);
  return { filePath };
}

/** Write existing contents back to the currently active project file. */
export async function writeToPath(filePath: string, contents: string): Promise<void> {
  await atomicWriteFile(filePath, contents);
}

// -------- Recent projects --------

export interface RecentProject {
  filePath: string;
  name: string;
  openedAt: string;
}

const RECENT_LIMIT = 10;

function recentFilePath(): string {
  return path.join(app.getPath("userData"), "recent-projects.json");
}

/** Read the list of recently opened projects (newest first). */
export async function readRecentProjects(): Promise<RecentProject[]> {
  try {
    const raw = await fs.readFile(recentFilePath(), "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter(
      (r): r is RecentProject =>
        r !== null && typeof r === "object" && typeof r.filePath === "string" && typeof r.name === "string"
    );
  } catch {
    return [];
  }
}

/** Record an opened/saved project in the recent list and return the new list. */
export async function recordRecentProject(filePath: string, name: string): Promise<RecentProject[]> {
  const list = await readRecentProjects();
  const pruned = list.filter((r) => r.filePath !== filePath);
  pruned.unshift({ filePath, name, openedAt: new Date().toISOString() });
  const trimmed = pruned.slice(0, RECENT_LIMIT);
  try {
    await atomicWriteFile(recentFilePath(), JSON.stringify(trimmed, null, 2));
  } catch {
    /* recent list is best-effort */
  }
  return trimmed;
}

/** Read a project by absolute file path (used by recent-project reopen). */
export async function readProjectFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

// -------- Project library (library.json in userData) --------

function libraryFilePath(): string {
  return path.join(app.getPath("userData"), "library.json");
}

/** Read + normalize the workspace library index. Missing/invalid → empty. */
export async function readLibrary(): Promise<LibraryData> {
  try {
    const raw = await fs.readFile(libraryFilePath(), "utf8");
    return normalizeLibrary(JSON.parse(raw));
  } catch {
    return { folders: [], projects: [] };
  }
}

async function writeLibrary(lib: LibraryData): Promise<void> {
  const payload = {
    version: LIBRARY_DATA_VERSION,
    folders: lib.folders,
    projects: lib.projects,
  };
  await atomicWriteFile(libraryFilePath(), JSON.stringify(payload, null, 2));
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Register (or refresh) a project in the library after open/save. Best-effort:
 * library write failures never fail the underlying open/save operation.
 */
export async function libraryRegister(
  filePath: string,
  displayName: string,
  projectId: string,
  updatedAt?: string
): Promise<void> {
  try {
    const lib = await readLibrary();
    const next = upsertProject(lib, {
      filePath,
      displayName,
      projectId,
      updatedAt,
      exists: await pathExists(filePath),
    });
    await writeLibrary(next);
  } catch {
    /* library is advisory */
  }
}

export async function libraryGet(): Promise<LibraryData> {
  const lib = await readLibrary();
  // Refresh the exists flag cheaply; a project's file may have been deleted
  // outside the app. Missing entries stay listed so users can re-link/remove.
  const refreshed = await Promise.all(
    lib.projects.map(async (p) => {
      const exists = await pathExists(p.filePath);
      return exists === p.exists ? p : { ...p, exists };
    })
  );
  return { folders: lib.folders, projects: refreshed };
}

export async function libraryCreateFolder(name: string): Promise<LibraryFolder | null> {
  if (!String(name ?? "").trim()) return null;
  const lib = await readLibrary();
  const next = createFolder(lib, name);
  if (next.folders.length === lib.folders.length) return null;
  await writeLibrary(next);
  return next.folders[next.folders.length - 1];
}

export async function libraryRenameFolder(id: string, name: string): Promise<boolean> {
  if (!String(name ?? "").trim()) return false;
  const lib = await readLibrary();
  const next = renameFolder(lib, id, name);
  if (next === lib) return false;
  await writeLibrary(next);
  return true;
}

export async function libraryDeleteFolder(id: string): Promise<boolean> {
  if (!id) return false;
  const lib = await readLibrary();
  const next = removeFolder(lib, id);
  if (next === lib) return false;
  await writeLibrary(next);
  return true;
}

export async function librarySetFolder(filePath: string, folderId: string | null): Promise<boolean> {
  const lib = await readLibrary();
  const next = setProjectFolder(lib, filePath, folderId === "" ? null : folderId);
  if (next === lib) return false;
  await writeLibrary(next);
  return true;
}

export async function librarySetFavorite(filePath: string, favorite: boolean): Promise<boolean> {
  const lib = await readLibrary();
  const next = setProjectFavorite(lib, filePath, favorite);
  if (next === lib) return false;
  await writeLibrary(next);
  return true;
}

export async function librarySetTags(filePath: string, tags: string[]): Promise<boolean> {
  const lib = await readLibrary();
  const next = setProjectTags(lib, filePath, Array.isArray(tags) ? tags : []);
  if (next === lib) return false;
  await writeLibrary(next);
  return true;
}

/** Unregister a project from the library without touching its file. */
export async function libraryRemove(filePath: string): Promise<boolean> {
  const lib = await readLibrary();
  const next = removeProject(lib, filePath);
  if (next === lib) return false;
  await writeLibrary(next);
  return true;
}

/** Move a project file to the OS trash (safe delete), then unregister. */
export async function libraryTrash(filePath: string): Promise<boolean> {
  try {
    await shell.trashItem(filePath);
  } catch {
    return false;
  }
  await libraryRemove(filePath);
  return true;
}

/**
 * Rename a project file on disk (same folder, updated name) and update the
 * library + recent pointers so everything keeps resolving. Refuses paths that
 * would escape the file's own folder.
 */
export async function libraryRename(
  filePath: string,
  newName: string
): Promise<{ ok: boolean; filePath?: string; error?: string }> {
  const clean = String(newName ?? "").trim().replace(/\.spatia\.json$/i, "");
  if (!clean) return { ok: false, error: "Name cannot be empty." };
  if (/[\\/:*?"<>|]/.test(clean)) return { ok: false, error: "Name contains invalid characters." };
  const parent = path.dirname(filePath);
  const targetPath = path.join(parent, clean + ".spatia.json");
  if (path.dirname(targetPath) !== parent) return { ok: false, error: "Invalid target path." };
  if (targetPath === filePath) return { ok: true, filePath };
  try {
    await fs.rename(filePath, targetPath);
  } catch {
    return { ok: false, error: "Could not rename the file (is it open elsewhere?)." };
  }
  const lib = await readLibrary();
  const next = renameProject(lib, filePath, targetPath);
  if (next !== lib) await writeLibrary(next);
  await recordRecentProjectRename(filePath, targetPath, clean);
  return { ok: true, filePath: targetPath };
}

/** Update recent-project pointers after a file rename. */
async function recordRecentProjectRename(oldPath: string, newPath: string, name: string): Promise<void> {
  const list = await readRecentProjects();
  const next = list.map((r) => (r.filePath === oldPath ? { ...r, filePath: newPath, name: name || r.name } : r));
  try {
    await atomicWriteFile(recentFilePath(), JSON.stringify(next, null, 2));
  } catch {
    /* best-effort */
  }
}

export async function libraryMarkMissing(filePath: string, missing: boolean): Promise<void> {
  try {
    const lib = await readLibrary();
    const next = markProjectMissing(lib, filePath, missing);
    if (next !== lib) await writeLibrary(next);
  } catch {
    /* best-effort */
  }
}

// -------- Version history (userData/versions/<projectId>) --------

const MAX_VERSION_SNAPSHOTS = 20;

export interface VersionSnapshotMeta {
  projectId: string;
  token: string;
  label: string;
  createdAt: string;
}

function versionsDir(projectId: string): string {
  return path.join(app.getPath("userData"), "versions", sanitizeFileName(projectId));
}

async function readVersionIndex(projectId: string): Promise<VersionSnapshotMeta[]> {
  try {
    const raw = await fs.readFile(path.join(versionsDir(projectId), "index.json"), "utf8");
    const data = JSON.parse(raw) as { snapshots?: unknown };
    if (!Array.isArray(data.snapshots)) return [];
    return data.snapshots.filter(
      (s): s is VersionSnapshotMeta =>
        s !== null &&
        typeof s === "object" &&
        typeof (s as VersionSnapshotMeta).token === "string" &&
        typeof (s as VersionSnapshotMeta).createdAt === "string"
    );
  } catch {
    return [];
  }
}

async function writeVersionIndex(projectId: string, snapshots: VersionSnapshotMeta[]): Promise<void> {
  const dir = versionsDir(projectId);
  await fs.mkdir(dir, { recursive: true });
  await atomicWriteFile(path.join(dir, "index.json"), JSON.stringify({ version: 1, snapshots }, null, 2));
}

/** Snapshot the current serialized project into the version store (cap 20). */
export async function versionAdd(projectId: string, label: string, json: string): Promise<VersionSnapshotMeta | null> {
  const id = String(projectId ?? "").trim();
  if (!id) return null;
  const snapshot: VersionSnapshotMeta = {
    projectId: id,
    token: `v${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    label: String(label ?? "Snapshot").slice(0, 120),
    createdAt: new Date().toISOString(),
  };
  try {
    const dir = versionsDir(id);
    await fs.mkdir(dir, { recursive: true });
    await atomicWriteFile(path.join(dir, snapshot.token + ".json"), json);
    const prev = await readVersionIndex(id);
    const next = [snapshot, ...prev].slice(0, MAX_VERSION_SNAPSHOTS);
    await writeVersionIndex(id, next);
    // Drop snapshot files that rotated out of the cap.
    const kept = new Set(next.map((s) => s.token));
    const files = await fs.readdir(dir);
    for (const f of files) {
      if (f === "index.json") continue;
      const token = path.basename(f, ".json");
      if (!kept.has(token)) {
        await fs.rm(path.join(dir, f), { force: true }).catch(() => undefined);
      }
    }
    return snapshot;
  } catch {
    return null;
  }
}

export async function versionList(projectId: string): Promise<VersionSnapshotMeta[]> {
  return readVersionIndex(String(projectId ?? ""));
}

export async function versionRestore(projectId: string, token: string): Promise<string | null> {
  const t = String(token ?? "");
  if (!t || /[^a-zA-Z0-9_]/.test(t)) return null;
  try {
    return await fs.readFile(path.join(versionsDir(String(projectId ?? "")), t + ".json"), "utf8");
  } catch {
    return null;
  }
}

export async function versionDelete(projectId: string, token: string): Promise<boolean> {
  const t = String(token ?? "");
  if (!t || /[^a-zA-Z0-9_]/.test(t)) return false;
  try {
    const dir = versionsDir(String(projectId ?? ""));
    await fs.rm(path.join(dir, t + ".json"), { force: true });
    const snapshots = (await readVersionIndex(String(projectId ?? ""))).filter((s) => s.token !== t);
    await writeVersionIndex(String(projectId ?? ""), snapshots);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort parse of project identity from a serialized project file. */
export function parseProjectIdentity(
  contents: string,
  fallbackPath: string
): { id: string; name: string; updatedAt: string } {
  try {
    const d = JSON.parse(contents) as {
      project?: { id?: unknown; name?: unknown; updatedAt?: unknown };
    };
    const proj = d?.project;
    if (proj && typeof proj.id === "string" && proj.id) {
      return {
        id: proj.id,
        name: typeof proj.name === "string" && proj.name ? proj.name : path.basename(fallbackPath).replace(/\.spatia\.json$/i, ""),
        updatedAt: typeof proj.updatedAt === "string" ? proj.updatedAt : new Date().toISOString(),
      };
    }
  } catch {
    /* fall through */
  }
  return {
    id: "proj_" + Math.random().toString(36).slice(2, 10),
    name: path.basename(fallbackPath).replace(/\.spatia\.json$/i, ""),
    updatedAt: new Date().toISOString(),
  };
}

// -------- Export / import (asset bundling) --------

export interface ExportResult {
  canceled: boolean;
  filePath: string | null;
}

export interface ImportFromFolderResult {
  canceled: boolean;
  contents: string | null;
  assetFiles: Record<string, string>;
}

/**
 * Export the project and all of its project-local assets into a self-contained
 * folder (`<name>.spatia/`) containing the project JSON and an `assets/`
 * subdirectory with every asset binary. The recipient can open the folder to
 * restore the whole project including media.
 */
export async function exportProjectToFolder(
  projectId: string,
  json: string,
  suggestedName: string
): Promise<ExportResult> {
  const result = await dialog.showOpenDialog({
    title: "Choose export folder",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true, filePath: null };
  }
  const targetBase = path.join(result.filePaths[0], sanitizeFileName(suggestedName).replace(/\.json$/i, "") + ".spatia");
  const assetsOut = path.join(targetBase, "assets");
  await fs.mkdir(assetsOut, { recursive: true });
  const { readdir } = await import("fs/promises");
  const sourceDir = path.join(app.getPath("userData"), "spatia-assets", sanitizeFileName(projectId));
  try {
    const files = await readdir(sourceDir);
    for (const f of files) {
      await fs.copyFile(path.join(sourceDir, f), path.join(assetsOut, f));
    }
  } catch {
    /* assets dir may not exist; still export the project file */
  }
  const projectFile = path.join(targetBase, suggestedName.endsWith(".json") ? suggestedName : suggestedName + ".spatia.json");
  await atomicWriteFile(projectFile, json);
  return { canceled: false, filePath: targetBase };
}

/**
 * Save a standalone exported file (PNG / PDF / Markdown) through a save
 * dialog. Binary formats come in Base64 and are decoded here; Markdown is
 * plain text. Never touches the active project file on disk.
 */
export async function exportItem(kind: ExportFileKind, suggestedName: string, payload: string): Promise<ExportResult> {
  const filters: Record<ExportFileKind, Electron.FileFilter[]> = {
    png: [{ name: "PNG image", extensions: ["png"] }],
    pdf: [{ name: "PDF document", extensions: ["pdf"] }],
    md: [{ name: "Markdown", extensions: ["md"] }],
  };
  const result = await dialog.showSaveDialog({
    title: `Export ${kind.toUpperCase()}`,
    defaultPath: suggestedName,
    filters: filters[kind],
  });
  if (result.canceled || !result.filePath) {
    return { canceled: true, filePath: null };
  }
  const target = result.filePath.endsWith("." + kind) ? result.filePath : result.filePath + "." + kind;
  if (kind === "md") {
    await atomicWriteFile(target, payload);
  } else {
    const buffer = Buffer.from(payload, "base64");
    await fs.writeFile(target, buffer);
  }
  return { canceled: false, filePath: target };
}

/**
 * Import a project folder (`.spatia`) produced by exportProjectToFolder.
 * Copies its asset binaries into this machine's project-local store and
 * returns the project JSON contents. The caller is responsible for assigning a
 * project id consistent with the copied assets.
 */
export async function importProjectFromFolder(): Promise<ImportFromFolderResult> {
  const result = await dialog.showOpenDialog({
    title: "Import Spatia project",
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true, contents: null, assetFiles: {} };
  }
  const folder = result.filePaths[0];
  const readdir = (await import("fs/promises")).readdir;
  const entries = await readdir(folder);
  const jsonFile = entries.find((f) => f.toLowerCase().endsWith(".spatia.json") || f.toLowerCase().endsWith(".spatia"));
  if (!jsonFile) {
    return { canceled: true, contents: null, assetFiles: {} };
  }
  const jsonPath = path.join(folder, jsonFile);
  const contents = await fs.readFile(jsonPath, "utf8");
  const assetsIn = path.join(folder, "assets");
  const assetFiles: Record<string, string> = {};
  try {
    const files = await readdir(assetsIn);
    for (const f of files) {
      assetFiles[f] = path.join(assetsIn, f);
    }
  } catch {
    /* no bundled assets */
  }
  return { canceled: false, contents, assetFiles };
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9 _.-]/g, "_");
}
