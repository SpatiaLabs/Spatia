import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { AssetMeta } from "../shared/types/object.js";

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

export interface SpatiaApi {
  openProject(): Promise<OpenProjectResult>;
  openProjectPath(filePath: string): Promise<OpenProjectResult>;
  saveProject(json: string): Promise<SaveProjectResult>;
  saveAsProject(json: string, suggestedName: string): Promise<SaveProjectResult>;
  getRecentProjects(): Promise<RecentProject[]>;
  exportProject(projectId: string, json: string, suggestedName: string): Promise<ExportResult>;
  importProject(): Promise<ImportProjectResult>;
  pickAsset(projectId: string): Promise<AssetImportResult>;
  importAssetFromPath(projectId: string, sourcePath: string, sourceName?: string): Promise<AssetImportResult>;
  readAssetDataUrl(projectId: string, assetId: string): Promise<string | null>;
  openAsset(projectId: string, assetId: string): Promise<boolean>;
  assetExists(projectId: string, assetId: string): Promise<boolean>;
  relinkAsset(projectId: string, assetId: string): Promise<AssetImportResult>;
  openExternal(url: string): Promise<boolean>;
  getDroppedFilePath(file: File): string | null;
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
  getRecentProjects(): Promise<RecentProject[]> {
    return ipcRenderer.invoke("project:recent");
  },
  exportProject(projectId: string, json: string, suggestedName: string): Promise<ExportResult> {
    return ipcRenderer.invoke("project:export", projectId, json, suggestedName);
  },
  importProject(): Promise<ImportProjectResult> {
    return ipcRenderer.invoke("project:import");
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
};

contextBridge.exposeInMainWorld("spatia", api);

export type { AssetMeta };
