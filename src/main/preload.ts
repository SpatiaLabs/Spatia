import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { AssetMeta } from "../shared/types/object.js";
import type { ExportFileKind } from "../renderer/types/bridge.js";
import type { PluginEntry, PluginInstallResult, PluginSource } from "../shared/plugins/manifest.js";
import type { LibraryData, LibraryFolder } from "../shared/library/library.js";
import type { VersionSnapshotMeta, RenameProjectResult, CollabIdentity } from "../renderer/types/bridge.js";

/**
 * Bridge exposing a minimal, typed API to the renderer. Node integration is
 * disabled and context isolation is enabled; the renderer can only reach the
 * filesystem and dialogs through these IPC calls.
 */

export interface OpenProjectOk {
  canceled: false;
  filePath: string;
  contents: string;
}

export interface OpenProjectCanceled {
  canceled: true;
  filePath: null;
  contents?: never;
}

export type OpenProjectResult = OpenProjectOk | OpenProjectCanceled;

export interface SaveProjectResult {
  canceled: boolean;
  filePath: string | null;
}

/** Result of saving a project to its default per-project folder. */
export interface SaveDefaultProjectResult {
  ok: boolean;
  filePath: string | null;
  folder: string | null;
  error?: string;
}

export interface AssetImportResult {
  canceled: boolean;
  asset: AssetMeta | null;
}

export interface RecentProject {
  filePath: string;
  name: string;
  openedAt: string;
}

export interface ExportResult {
  canceled: boolean;
  filePath: string | null;
}

export interface ImportProjectResult {
  canceled: boolean;
  contents: string | null;
}

/** A crash-recovery draft stored by the main process. */
export interface RecoveryEntry {
  projectId: string;
  name: string;
  updatedAt: string;
  contents: string;
}

export interface SpatiaApi {
  openProject(): Promise<OpenProjectResult>;
  openProjectPath(filePath: string): Promise<OpenProjectResult>;
  saveProject(json: string): Promise<SaveProjectResult>;
  saveAsProject(json: string, suggestedName: string): Promise<SaveProjectResult>;
  /** First save: store the project in its default per-project folder. */
  projectSaveDefault(projectId: string, name: string, json: string): Promise<SaveDefaultProjectResult>;
  /** Write a silent crash-recovery copy of the document. */
  recoveryWrite(projectId: string, json: string): Promise<boolean>;
  /** List crash-recovery drafts (newest first). */
  recoveryList(): Promise<RecoveryEntry[]>;
  /** Remove the crash-recovery draft for a project. */
  recoveryClear(projectId: string): Promise<boolean>;
  /** Write an exported image into the project's exports/ folder (no dialog). */
  exportToExports(projectId: string, fileName: string, payload: string): Promise<ExportResult>;
  getRecentProjects(): Promise<RecentProject[]>;
  exportProject(projectId: string, json: string, suggestedName: string): Promise<ExportResult>;
  exportFile(kind: ExportFileKind, suggestedName: string, payload: string): Promise<ExportResult>;
  importProject(): Promise<ImportProjectResult>;
  /** Pick a text/JSON/XML file and return its contents without opening it. */
  pickImportText(title: string, extensions?: string[]): Promise<{ canceled: boolean; name: string; contents: string }>;
  pickAsset(projectId: string): Promise<AssetImportResult>;
  importAssetFromPath(projectId: string, sourcePath: string, sourceName?: string): Promise<AssetImportResult>;
  readAssetDataUrl(projectId: string, assetId: string): Promise<string | null>;
  openAsset(projectId: string, assetId: string): Promise<boolean>;
  assetExists(projectId: string, assetId: string): Promise<boolean>;
  relinkAsset(projectId: string, assetId: string): Promise<AssetImportResult>;
  deleteAsset(projectId: string, assetId: string): Promise<boolean>;
  openExternal(url: string): Promise<boolean>;
  getDroppedFilePath(file: File): string | null;
  readProjectContents(filePath: string): Promise<string | null>;
  libraryGet(): Promise<LibraryData>;
  libraryCreateFolder(name: string): Promise<LibraryFolder | null>;
  libraryRenameFolder(id: string, name: string): Promise<boolean>;
  libraryDeleteFolder(id: string): Promise<boolean>;
  librarySetFolder(filePath: string, folderId: string | null): Promise<boolean>;
  librarySetFavorite(filePath: string, favorite: boolean): Promise<boolean>;
  librarySetTags(filePath: string, tags: string[]): Promise<boolean>;
  libraryRemove(filePath: string): Promise<boolean>;
  libraryTrash(filePath: string): Promise<boolean>;
  libraryRename(filePath: string, newName: string): Promise<RenameProjectResult>;
  versionsList(projectId: string): Promise<VersionSnapshotMeta[]>;
  versionsAdd(projectId: string, label: string, json: string): Promise<VersionSnapshotMeta | null>;
  versionsRestore(projectId: string, token: string): Promise<string | null>;
  versionsDelete(projectId: string, token: string): Promise<boolean>;
  pluginsList(): Promise<PluginEntry[]>;
  pluginsGetSource(id: string): Promise<PluginSource | null>;
  pluginsInstall(): Promise<PluginInstallResult>;
  pluginsInstallUrl(url: string): Promise<PluginInstallResult>;
  pluginsSetEnabled(id: string, enabled: boolean): Promise<boolean>;
  pluginsRemove(id: string): Promise<boolean>;
  collabGetIdentity(): Promise<CollabIdentity>;
  /** Start the local collaboration server (desktop). Returns started/reason. */
  collabStartServer(port?: number): Promise<{ started: boolean; reason?: string }>;
  onJoinRequest(cb: (roomId: string) => void): () => void;
}

const api: SpatiaApi = {
  openProject(): Promise<OpenProjectResult> {
    return ipcRenderer.invoke("project:open");
  },
  openProjectPath(filePath: string): Promise<OpenProjectResult> {
    return ipcRenderer.invoke("project:openPath", filePath);
  },
  saveProject(json: string): Promise<SaveProjectResult> {
    return ipcRenderer.invoke("project:save", json);
  },
  saveAsProject(json: string, suggestedName: string): Promise<SaveProjectResult> {
    return ipcRenderer.invoke("project:saveAs", json, suggestedName);
  },
  projectSaveDefault(projectId: string, name: string, json: string): Promise<SaveDefaultProjectResult> {
    return ipcRenderer.invoke("project:saveDefault", projectId, name, json);
  },
  recoveryWrite(projectId: string, json: string): Promise<boolean> {
    return ipcRenderer.invoke("project:recoveryWrite", projectId, json);
  },
  recoveryList(): Promise<RecoveryEntry[]> {
    return ipcRenderer.invoke("project:recoveryList");
  },
  recoveryClear(projectId: string): Promise<boolean> {
    return ipcRenderer.invoke("project:recoveryClear", projectId);
  },
  exportToExports(projectId: string, fileName: string, payload: string): Promise<ExportResult> {
    return ipcRenderer.invoke("project:exportToExports", projectId, fileName, payload);
  },
  getRecentProjects(): Promise<RecentProject[]> {
    return ipcRenderer.invoke("project:recent");
  },
  readProjectContents(filePath: string): Promise<string | null> {
    return ipcRenderer.invoke("project:readContents", filePath);
  },
  libraryGet(): Promise<LibraryData> {
    return ipcRenderer.invoke("library:get");
  },
  libraryCreateFolder(name: string): Promise<LibraryFolder | null> {
    return ipcRenderer.invoke("library:createFolder", name);
  },
  libraryRenameFolder(id: string, name: string): Promise<boolean> {
    return ipcRenderer.invoke("library:renameFolder", id, name);
  },
  libraryDeleteFolder(id: string): Promise<boolean> {
    return ipcRenderer.invoke("library:deleteFolder", id);
  },
  librarySetFolder(filePath: string, folderId: string | null): Promise<boolean> {
    return ipcRenderer.invoke("library:setFolder", filePath, folderId);
  },
  librarySetFavorite(filePath: string, favorite: boolean): Promise<boolean> {
    return ipcRenderer.invoke("library:setFavorite", filePath, favorite);
  },
  librarySetTags(filePath: string, tags: string[]): Promise<boolean> {
    return ipcRenderer.invoke("library:setTags", filePath, tags);
  },
  libraryRemove(filePath: string): Promise<boolean> {
    return ipcRenderer.invoke("library:remove", filePath);
  },
  libraryTrash(filePath: string): Promise<boolean> {
    return ipcRenderer.invoke("library:trash", filePath);
  },
  libraryRename(filePath: string, newName: string): Promise<RenameProjectResult> {
    return ipcRenderer.invoke("library:rename", filePath, newName);
  },
  versionsList(projectId: string): Promise<VersionSnapshotMeta[]> {
    return ipcRenderer.invoke("versions:list", projectId);
  },
  versionsAdd(projectId: string, label: string, json: string): Promise<VersionSnapshotMeta | null> {
    return ipcRenderer.invoke("versions:add", projectId, label, json);
  },
  versionsRestore(projectId: string, token: string): Promise<string | null> {
    return ipcRenderer.invoke("versions:restore", projectId, token);
  },
  versionsDelete(projectId: string, token: string): Promise<boolean> {
    return ipcRenderer.invoke("versions:delete", projectId, token);
  },
  exportProject(projectId: string, json: string, suggestedName: string): Promise<ExportResult> {
    return ipcRenderer.invoke("project:export", projectId, json, suggestedName);
  },
  exportFile(kind: ExportFileKind, suggestedName: string, payload: string): Promise<ExportResult> {
    return ipcRenderer.invoke("project:exportFile", kind, suggestedName, payload);
  },
  importProject(): Promise<ImportProjectResult> {
    return ipcRenderer.invoke("project:import");
  },
  pickImportText(title: string, extensions?: string[]): Promise<{ canceled: boolean; name: string; contents: string }> {
    return ipcRenderer.invoke("import:text", title, extensions);
  },
  pickAsset(projectId: string): Promise<AssetImportResult> {
    return ipcRenderer.invoke("asset:pick", projectId);
  },
  importAssetFromPath(projectId: string, sourcePath: string, sourceName?: string): Promise<AssetImportResult> {
    return ipcRenderer.invoke("asset:importFromPath", projectId, sourcePath, sourceName);
  },
  readAssetDataUrl(projectId: string, assetId: string): Promise<string | null> {
    return ipcRenderer.invoke("asset:read", projectId, assetId);
  },
  openAsset(projectId: string, assetId: string): Promise<boolean> {
    return ipcRenderer.invoke("asset:open", projectId, assetId);
  },
  assetExists(projectId: string, assetId: string): Promise<boolean> {
    return ipcRenderer.invoke("asset:exists", projectId, assetId);
  },
  relinkAsset(projectId: string, assetId: string): Promise<AssetImportResult> {
    return ipcRenderer.invoke("asset:relink", projectId, assetId);
  },
  deleteAsset(projectId: string, assetId: string): Promise<boolean> {
    return ipcRenderer.invoke("asset:delete", projectId, assetId);
  },
  openExternal(url: string): Promise<boolean> {
    return ipcRenderer.invoke("shell:openExternal", url);
  },
  getDroppedFilePath(file: File): string | null {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
  pluginsList(): Promise<PluginEntry[]> {
    return ipcRenderer.invoke("plugins:list");
  },
  pluginsGetSource(id: string): Promise<PluginSource | null> {
    return ipcRenderer.invoke("plugins:getSource", id);
  },
  pluginsInstall(): Promise<PluginInstallResult> {
    return ipcRenderer.invoke("plugins:install");
  },
  pluginsInstallUrl(url: string): Promise<PluginInstallResult> {
    return ipcRenderer.invoke("plugins:installUrl", url);
  },
  pluginsSetEnabled(id: string, enabled: boolean): Promise<boolean> {
    return ipcRenderer.invoke("plugins:setEnabled", id, enabled);
  },
  pluginsRemove(id: string): Promise<boolean> {
    return ipcRenderer.invoke("plugins:remove", id);
  },
  collabGetIdentity(): Promise<CollabIdentity> {
    return ipcRenderer.invoke("collab:getIdentity");
  },
  collabStartServer(port?: number): Promise<{ started: boolean; reason?: string }> {
    return ipcRenderer.invoke("collab:startServer", port);
  },
  onJoinRequest(cb: (roomId: string) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, roomId: string): void => cb(String(roomId));
    ipcRenderer.on("collab:join", listener);
    return () => ipcRenderer.removeListener("collab:join", listener);
  },
};

contextBridge.exposeInMainWorld("spatia", api);

export type { AssetMeta };
