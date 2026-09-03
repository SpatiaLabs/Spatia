import type { AssetMeta } from "../../shared/types/object.js";

export interface OpenProjectOk {
  canceled: false;
  filePath: string;
  contents: string;
}

export interface OpenProjectCanceled {
  canceled: true;
  filePath: null;
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

/** Typed surface of the preload bridge (window.spatia). */
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

declare global {
  interface Window {
    spatia: SpatiaApi;
  }
}
