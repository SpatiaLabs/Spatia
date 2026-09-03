import { ipcMain, shell } from "electron";
import type { SpatiaApi } from "./preload.js";

/**
 * Registers all renderer-facing IPC handlers. The main process is the single
 * owner of the currently-open project file path so that "Save" can write in
 * place while "Save As" / "Open" change that path.
 */

export function registerIpc(): void {
  let activeFilePath: string | null = null;

  ipcMain.handle("project:open", async (): Promise<ReturnType<SpatiaApi["openProject"]>> => {
    const { openProjectDialog, recordRecentProject } = await import("./storage");
    const result = await openProjectDialog();
    if (result.filePath && result.contents !== undefined) {
      activeFilePath = result.filePath;
      void recordRecentProject(result.filePath, "Project");
      return { canceled: false, filePath: result.filePath, contents: result.contents };
    }
    return { canceled: true, filePath: null };
  });

  ipcMain.handle(
    "project:openPath",
    async (_event, filePath: string): Promise<ReturnType<SpatiaApi["openProjectPath"]>> => {
      const { readProjectFile, recordRecentProject } = await import("./storage");
      const contents = await readProjectFile(filePath);
      if (contents === null) return { canceled: true, filePath: null };
      activeFilePath = filePath;
      void recordRecentProject(filePath, "Project");
      return { canceled: false, filePath, contents };
    }
  );

  ipcMain.handle(
    "project:save",
    async (_event, json: string): Promise<ReturnType<SpatiaApi["saveProject"]>> => {
      const { writeToPath } = await import("./storage");
      if (activeFilePath) {
        await writeToPath(activeFilePath, json);
        return { canceled: false, filePath: activeFilePath };
      }
      return handleSaveAs(json);
    }
  );

  ipcMain.handle(
    "project:saveAs",
    async (_event, json: string, suggestedName: string): Promise<ReturnType<SpatiaApi["saveAsProject"]>> => {
      return handleSaveAs(json, suggestedName);
    }
  );

  ipcMain.handle(
    "project:recent",
    async (): Promise<ReturnType<SpatiaApi["getRecentProjects"]>> => {
      const { readRecentProjects } = await import("./storage");
      return readRecentProjects();
    }
  );

  ipcMain.handle(
    "project:export",
    async (
      _event,
      projectId: string,
      json: string,
      suggestedName: string
    ): Promise<ReturnType<SpatiaApi["exportProject"]>> => {
      const { exportProjectToFolder } = await import("./storage");
      return exportProjectToFolder(projectId, json, suggestedName);
    }
  );

  ipcMain.handle(
    "project:import",
    async (): Promise<ReturnType<SpatiaApi["importProject"]>> => {
      const { importProjectFromFolder } = await import("./storage");
      const { importAssetBinaries } = await import("./assets");
      const result = await importProjectFromFolder();
      if (result.canceled || result.contents === null) {
        return { canceled: true, contents: null };
      }
      // Parse to learn the project id so we can stage the bundled assets in
      // the right project-local directory. If parsing fails we still hand the
      // contents back; the renderer decides how to treat them.
      try {
        const parsed = JSON.parse(result.contents) as { project?: { id?: string } };
        const projectId = parsed?.project?.id ?? "imported";
        await importAssetBinaries(projectId, result.assetFiles);
      } catch {
        /* ignore staging errors; contents are still returned */
      }
      return { canceled: false, contents: result.contents };
    }
  );

  ipcMain.handle(
    "asset:pick",
    async (_event, projectId: string): Promise<ReturnType<SpatiaApi["pickAsset"]>> => {
      const { pickAndImport } = await import("./assets");
      return pickAndImport(projectId);
    }
  );

  ipcMain.handle(
    "asset:importFromPath",
    async (
      _event,
      projectId: string,
      sourcePath: string,
      sourceName?: string
    ): Promise<ReturnType<SpatiaApi["importAssetFromPath"]>> => {
      const { importFromPath } = await import("./assets");
      return importFromPath(projectId, sourcePath, sourceName);
    }
  );

  ipcMain.handle(
    "asset:read",
    async (_event, projectId: string, assetId: string): Promise<string | null> => {
      const { readAssetDataUrl } = await import("./assets");
      return readAssetDataUrl(projectId, assetId);
    }
  );

  ipcMain.handle(
    "asset:open",
    async (_event, projectId: string, assetId: string): Promise<boolean> => {
      const { openAsset } = await import("./assets");
      return openAsset(projectId, assetId);
    }
  );

  ipcMain.handle(
    "asset:relink",
    async (
      _event,
      projectId: string,
      assetId: string
    ): Promise<ReturnType<SpatiaApi["relinkAsset"]>> => {
      const { pickRelinkSource, relinkAsset } = await import("./assets");
      const source = await pickRelinkSource();
      if (!source) return { canceled: true, asset: null };
      const meta = await relinkAsset(projectId, assetId, source);
      return { canceled: meta === null, asset: meta };
    }
  );

  ipcMain.handle(
    "asset:exists",
    async (_event, projectId: string, assetId: string): Promise<boolean> => {
      const { assetExists } = await import("./assets");
      return assetExists(projectId, assetId);
    }
  );

  ipcMain.handle(
    "shell:openExternal",
    async (_event, url: string): Promise<boolean> => {
      try {
        await shell.openExternal(url);
        return true;
      } catch {
        return false;
      }
    }
  );

  async function handleSaveAs(json: string, suggestedName?: string): Promise<{ canceled: boolean; filePath: string | null }> {
    const { saveWithDialog, recordRecentProject } = await import("./storage");
    const name = suggestedName ?? "Untitled Project.spatia.json";
    const result = await saveWithDialog(name, json);
    if (result.filePath) {
      activeFilePath = result.filePath;
      void recordRecentProject(result.filePath, name.replace(/\.spatia\.json$/i, ""));
      return { canceled: false, filePath: result.filePath };
    }
    return { canceled: true, filePath: null };
  }
}
