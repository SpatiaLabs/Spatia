import type { AssetMeta } from "../../shared/types/object.js";
import type { PluginEntry, PluginInstallResult, PluginSource } from "../../shared/plugins/manifest.js";
import type { LibraryData, LibraryFolder } from "../../shared/library/library.js";

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

export type ExportFileKind = "png" | "pdf" | "md";

export interface ImportProjectResult {
  canceled: boolean;
  contents: string | null;
}

/** Metadata about a stored version snapshot (contents live outside the doc). */
export interface VersionSnapshotMeta {
  projectId: string;
  token: string;
  label: string;
  createdAt: string;
}

export interface RenameProjectResult {
  ok: boolean;
  filePath?: string;
  error?: string;
}

/** Persisted collaboration identity (desktop: main-process settings file). */
export interface CollabIdentity {
  id: string;
  name: string;
}

/** Typed surface of the preload bridge (window.spatia). */
export interface SpatiaApi {
  openProject(): Promise<OpenProjectResult>;
  openProjectPath(filePath: string): Promise<OpenProjectResult>;
  saveProject(json: string): Promise<SaveProjectResult>;
  saveAsProject(json: string, suggestedName: string): Promise<SaveProjectResult>;
  getRecentProjects(): Promise<RecentProject[]>;
  exportProject(projectId: string, json: string, suggestedName: string): Promise<ExportResult>;
  exportFile(kind: ExportFileKind, suggestedName: string, payload: string): Promise<ExportResult>;
  importProject(): Promise<ImportProjectResult>;
  pickAsset(projectId: string): Promise<AssetImportResult>;
  importAssetFromPath(projectId: string, sourcePath: string, sourceName?: string): Promise<AssetImportResult>;
  readAssetDataUrl(projectId: string, assetId: string): Promise<string | null>;
  openAsset(projectId: string, assetId: string): Promise<boolean>;
  assetExists(projectId: string, assetId: string): Promise<boolean>;
  relinkAsset(projectId: string, assetId: string): Promise<AssetImportResult>;
  /** Permanently delete an asset's stored binary (web: its IndexedDB record). */
  deleteAsset(projectId: string, assetId: string): Promise<boolean>;
  openExternal(url: string): Promise<boolean>;
  getDroppedFilePath(file: File): string | null;
  /** Read another project's raw JSON by path/key (search indexing). */
  readProjectContents(filePath: string): Promise<string | null>;
  /** Full library index (folders + registered projects). */
  libraryGet(): Promise<LibraryData>;
  libraryCreateFolder(name: string): Promise<LibraryFolder | null>;
  libraryRenameFolder(id: string, name: string): Promise<boolean>;
  libraryDeleteFolder(id: string): Promise<boolean>;
  librarySetFolder(filePath: string, folderId: string | null): Promise<boolean>;
  librarySetFavorite(filePath: string, favorite: boolean): Promise<boolean>;
  librarySetTags(filePath: string, tags: string[]): Promise<boolean>;
  /** Unregister a project from the library index (file untouched on desktop). */
  libraryRemove(filePath: string): Promise<boolean>;
  /** Desktop: move the project file to the OS trash. Web: hard delete. */
  libraryTrash(filePath: string): Promise<boolean>;
  /** Desktop: rename the file on disk. Web: rename the stored document key. */
  libraryRename(filePath: string, newName: string): Promise<RenameProjectResult>;
  /** Version history snapshots for a project. */
  versionsList(projectId: string): Promise<VersionSnapshotMeta[]>;
  /** Capture a snapshot of the current serialized project. */
  versionsAdd(projectId: string, label: string, json: string): Promise<VersionSnapshotMeta | null>;
  /** Return the serialized JSON of a stored snapshot. */
  versionsRestore(projectId: string, token: string): Promise<string | null>;
  versionsDelete(projectId: string, token: string): Promise<boolean>;
  pluginsList(): Promise<PluginEntry[]>;
  pluginsGetSource(id: string): Promise<PluginSource | null>;
  pluginsInstall(): Promise<PluginInstallResult>;
  pluginsInstallUrl(url: string): Promise<PluginInstallResult>;
  pluginsSetEnabled(id: string, enabled: boolean): Promise<boolean>;
  pluginsRemove(id: string): Promise<boolean>;
  /** Stable per-machine collaboration identity (persisted by the main process). */
  collabGetIdentity(): Promise<CollabIdentity>;
  /** Subscribe to deep-link ("spatia://join?room=…") join requests. */
  onJoinRequest(cb: (roomId: string) => void): (() => void);
  /** Desktop-only: read a model/asset file via IPC, returns base64 data-URL. */
  aiGetAsset?(path: string): Promise<string | null>;
}

declare global {
  interface Window {
    spatia: SpatiaApi;
  }
}
