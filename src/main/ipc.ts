import { app, dialog, ipcMain, shell } from "electron";
import type { SpatiaApi } from "./preload.js";
import type { ExportFileKind } from "../renderer/types/bridge.js";
import type { CollabIdentity } from "../renderer/types/bridge.js";
import path from "node:path";
import type { PluginEntry, PluginInstallResult, PluginSource } from "../shared/plugins/manifest.js";

/**
 * Registers all renderer-facing IPC handlers. The main process is the single
 * owner of the currently-open project file path so that "Save" can write in
 * place while "Save As" / "Open" change that path.
 */

export function registerIpc(): void {
  let activeFilePath: string | null = null;

  ipcMain.handle("project:open", async (): Promise<ReturnType<SpatiaApi["openProject"]>> => {
    const {
      openProjectDialog,
      recordRecentProject,
      libraryRegister,
      parseProjectIdentity,
      setActiveProject,
      projectFolderFor,
    } = await import("./storage");
    const result = await openProjectDialog();
    if (result.filePath && result.contents !== undefined) {
      activeFilePath = result.filePath;
      const identity = parseProjectIdentity(result.contents, result.filePath);
      setActiveProject(identity.id, projectFolderFor(result.filePath));
      void recordRecentProject(result.filePath, identity.name);
      void libraryRegister(result.filePath, identity.name, identity.id, identity.updatedAt);
      return { canceled: false, filePath: result.filePath, contents: result.contents };
    }
    return { canceled: true, filePath: null };
  });

  ipcMain.handle(
    "project:openPath",
    async (_event, filePath: string): Promise<ReturnType<SpatiaApi["openProjectPath"]>> => {
      const {
        readProjectFile,
        recordRecentProject,
        libraryRegister,
        parseProjectIdentity,
        setActiveProject,
        projectFolderFor,
      } = await import("./storage");
      const contents = await readProjectFile(filePath);
      if (contents === null) return { canceled: true, filePath: null };
      activeFilePath = filePath;
      const identity = parseProjectIdentity(contents, filePath);
      setActiveProject(identity.id, projectFolderFor(filePath));
      void recordRecentProject(filePath, identity.name);
      void libraryRegister(filePath, identity.name, identity.id, identity.updatedAt);
      return { canceled: false, filePath, contents };
    }
  );

  ipcMain.handle(
    "project:save",
    async (_event, json: string): Promise<ReturnType<SpatiaApi["saveProject"]>> => {
      const { writeToPath, libraryRegister, parseProjectIdentity } = await import("./storage");
      if (activeFilePath) {
        await writeToPath(activeFilePath, json);
        const identity = parseProjectIdentity(json, activeFilePath);
        void libraryRegister(activeFilePath, identity.name, identity.id, identity.updatedAt);
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
    "project:readContents",
    async (_event, filePath: string): Promise<string | null> => {
      const { readProjectFile } = await import("./storage");
      return readProjectFile(filePath);
    }
  );

  ipcMain.handle(
    "project:saveDefault",
    async (
      _event,
      projectId: string,
      name: string,
      json: string
    ): Promise<ReturnType<SpatiaApi["projectSaveDefault"]>> => {
      const {
        saveProjectToDefaultFolder,
        recordRecentProject,
        libraryRegister,
        parseProjectIdentity,
        setActiveProject,
      } = await import("./storage");
      const result = await saveProjectToDefaultFolder(projectId, name, json);
      if (result.ok && result.filePath) {
        activeFilePath = result.filePath;
        setActiveProject(projectId, result.folder ?? null);
        const identity = parseProjectIdentity(json, result.filePath);
        void recordRecentProject(result.filePath, identity.name);
        void libraryRegister(result.filePath, identity.name, identity.id, identity.updatedAt);
        return { ok: true, filePath: result.filePath, folder: result.folder, error: undefined };
      }
      return { ok: false, filePath: null, folder: null, error: result.error ?? "Could not save the project." };
    }
  );

  ipcMain.handle(
    "project:recoveryWrite",
    async (_event, projectId: string, json: string): Promise<boolean> => {
      const { writeRecovery } = await import("./storage");
      return writeRecovery(projectId, json);
    }
  );

  ipcMain.handle("project:recoveryList", async (): Promise<ReturnType<SpatiaApi["recoveryList"]>> => {
    const { listRecovery } = await import("./storage");
    return listRecovery();
  });

  ipcMain.handle(
    "project:recoveryClear",
    async (_event, projectId: string): Promise<boolean> => {
      const { clearRecovery } = await import("./storage");
      return clearRecovery(projectId);
    }
  );

  ipcMain.handle(
    "project:exportToExports",
    async (
      _event,
      projectId: string,
      fileName: string,
      payload: string
    ): Promise<ReturnType<SpatiaApi["exportToExports"]>> => {
      const { exportToProjectExports } = await import("./storage");
      return exportToProjectExports(projectId, fileName, payload);
    }
  );

  // -------- Library (workspace project index) --------

  ipcMain.handle("library:get", async (): Promise<ReturnType<SpatiaApi["libraryGet"]>> => {
    const { libraryGet } = await import("./storage");
    return libraryGet();
  });

  ipcMain.handle(
    "library:createFolder",
    async (_event, name: string): Promise<ReturnType<SpatiaApi["libraryCreateFolder"]>> => {
      const { libraryCreateFolder } = await import("./storage");
      return libraryCreateFolder(name);
    }
  );

  ipcMain.handle(
    "library:renameFolder",
    async (_event, id: string, name: string): Promise<ReturnType<SpatiaApi["libraryRenameFolder"]>> => {
      const { libraryRenameFolder } = await import("./storage");
      return libraryRenameFolder(id, name);
    }
  );

  ipcMain.handle(
    "library:deleteFolder",
    async (_event, id: string): Promise<ReturnType<SpatiaApi["libraryDeleteFolder"]>> => {
      const { libraryDeleteFolder } = await import("./storage");
      return libraryDeleteFolder(id);
    }
  );

  ipcMain.handle(
    "library:setFolder",
    async (_event, filePath: string, folderId: string | null): Promise<ReturnType<SpatiaApi["librarySetFolder"]>> => {
      const { librarySetFolder } = await import("./storage");
      return librarySetFolder(filePath, folderId);
    }
  );

  ipcMain.handle(
    "library:setFavorite",
    async (_event, filePath: string, favorite: boolean): Promise<ReturnType<SpatiaApi["librarySetFavorite"]>> => {
      const { librarySetFavorite } = await import("./storage");
      return librarySetFavorite(filePath, favorite);
    }
  );

  ipcMain.handle(
    "library:setTags",
    async (_event, filePath: string, tags: string[]): Promise<ReturnType<SpatiaApi["librarySetTags"]>> => {
      const { librarySetTags } = await import("./storage");
      return librarySetTags(filePath, tags);
    }
  );

  ipcMain.handle(
    "library:remove",
    async (_event, filePath: string): Promise<ReturnType<SpatiaApi["libraryRemove"]>> => {
      const { libraryRemove } = await import("./storage");
      return libraryRemove(filePath);
    }
  );

  ipcMain.handle(
    "library:trash",
    async (_event, filePath: string): Promise<ReturnType<SpatiaApi["libraryTrash"]>> => {
      const { libraryTrash } = await import("./storage");
      return libraryTrash(filePath);
    }
  );

  ipcMain.handle(
    "library:rename",
    async (_event, filePath: string, newName: string): Promise<ReturnType<SpatiaApi["libraryRename"]>> => {
      const { libraryRename } = await import("./storage");
      return libraryRename(filePath, newName);
    }
  );

  // -------- Version history --------

  ipcMain.handle(
    "versions:list",
    async (_event, projectId: string): Promise<ReturnType<SpatiaApi["versionsList"]>> => {
      const { versionList } = await import("./storage");
      return versionList(projectId);
    }
  );

  ipcMain.handle(
    "versions:add",
    async (_event, projectId: string, label: string, json: string): Promise<ReturnType<SpatiaApi["versionsAdd"]>> => {
      const { versionAdd } = await import("./storage");
      return versionAdd(projectId, label, json);
    }
  );

  ipcMain.handle(
    "versions:restore",
    async (_event, projectId: string, token: string): Promise<ReturnType<SpatiaApi["versionsRestore"]>> => {
      const { versionRestore } = await import("./storage");
      return versionRestore(projectId, token);
    }
  );

  ipcMain.handle(
    "versions:delete",
    async (_event, projectId: string, token: string): Promise<ReturnType<SpatiaApi["versionsDelete"]>> => {
      const { versionDelete } = await import("./storage");
      return versionDelete(projectId, token);
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
    "project:exportFile",
    async (
      _event,
      kind: string,
      suggestedName: string,
      payload: string
    ): Promise<ReturnType<SpatiaApi["exportFile"]>> => {
      const { exportItem } = await import("./storage");
      return exportItem(kind as ExportFileKind, suggestedName, payload);
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
    "asset:delete",
    async (_event, projectId: string, assetId: string): Promise<boolean> => {
      const { deleteAsset } = await import("./assets");
      return deleteAsset(projectId, assetId);
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

  ipcMain.handle("plugins:list", async (): Promise<PluginEntry[]> => {
    const { PluginStore } = await import("./plugins");
    const store = new PluginStore(path.join(app.getPath("userData"), "plugins"));
    return store.list();
  });

  ipcMain.handle(
    "plugins:getSource",
    async (_event, id: string): Promise<PluginSource | null> => {
      const { PluginStore } = await import("./plugins");
      const store = new PluginStore(path.join(app.getPath("userData"), "plugins"));
      return store.getSource(id);
    }
  );

  ipcMain.handle("plugins:install", async (): Promise<PluginInstallResult> => {
    const { PluginStore } = await import("./plugins");
    const result = await dialog.showOpenDialog({
      title: "Select a plugin folder",
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) {
      return { ok: false, error: "No folder was selected." };
    }
    const store = new PluginStore(path.join(app.getPath("userData"), "plugins"));
    return store.installFromFolder(result.filePaths[0]);
  });

  ipcMain.handle("plugins:installUrl", async (_event, rawUrl: string): Promise<PluginInstallResult> => {
    const { PluginStore } = await import("./plugins");
    const { validatePluginManifest } = await import("../shared/plugins/manifest");
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(String(rawUrl ?? ""));
    } catch {
      return { ok: false, error: "That URL is not valid." };
    }
    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
      return { ok: false, error: "Only http(s) plugin URLs are allowed." };
    }
    let manifestText: string;
    try {
      const res = await fetch(parsedUrl.href);
      if (!res.ok) return { ok: false, error: `Could not fetch the manifest (HTTP ${res.status}).` };
      manifestText = await res.text();
    } catch {
      return { ok: false, error: "Could not reach that URL." };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestText) as unknown;
    } catch {
      return { ok: false, error: "That URL does not point to a JSON manifest." };
    }
    const validation = validatePluginManifest(parsed);
    if (!validation.ok) return { ok: false, error: validation.error };
    const manifest = validation.manifest;
    let main: string;
    try {
      const mainUrl = new URL(manifest.main, parsedUrl.href);
      const res = await fetch(mainUrl.href);
      if (!res.ok) return { ok: false, error: `Could not fetch ${manifest.main} (HTTP ${res.status}).` };
      main = await res.text();
    } catch {
      return { ok: false, error: `Could not reach ${manifest.main}.` };
    }
    if (typeof main !== "string" || main.length === 0) {
      return { ok: false, error: `${manifest.main} is empty or unreadable.` };
    }
    const store = new PluginStore(path.join(app.getPath("userData"), "plugins"));
    return store.installFromSource(manifest.id, manifest, main);
  });

  ipcMain.handle(
    "plugins:setEnabled",
    async (_event, id: string, enabled: boolean): Promise<boolean> => {
      const { PluginStore } = await import("./plugins");
      const store = new PluginStore(path.join(app.getPath("userData"), "plugins"));
      return store.setEnabled(id, enabled);
    }
  );

  ipcMain.handle(
    "plugins:remove",
    async (_event, id: string): Promise<boolean> => {
      const { PluginStore } = await import("./plugins");
      const store = new PluginStore(path.join(app.getPath("userData"), "plugins"));
      return store.remove(id);
    }
  );

  ipcMain.handle("collab:getIdentity", async (): Promise<CollabIdentity> => {
    const { getCollabIdentity } = await import("./storage");
    return getCollabIdentity();
  });

  async function handleSaveAs(json: string, suggestedName?: string): Promise<{ canceled: boolean; filePath: string | null }> {
    const {
      saveWithDialog,
      recordRecentProject,
      libraryRegister,
      parseProjectIdentity,
      setActiveProject,
      projectFolderFor,
    } = await import("./storage");
    const name = suggestedName ?? "Untitled Project.spatia.json";
    const result = await saveWithDialog(name, json);
    if (result.filePath) {
      activeFilePath = result.filePath;
      const identity = parseProjectIdentity(json, result.filePath);
      setActiveProject(identity.id, projectFolderFor(result.filePath));
      void recordRecentProject(result.filePath, identity.name);
      void libraryRegister(result.filePath, identity.name, identity.id, identity.updatedAt);
      return { canceled: false, filePath: result.filePath };
    }
    return { canceled: true, filePath: null };
  }
}
