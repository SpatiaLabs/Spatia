import { promises as fs } from "fs";
import * as path from "path";
import { app, dialog } from "electron";

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
