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

export type ExportFileKind = "png" | "jpeg" | "pdf" | "md";

/** A crash-recovery draft stored by the main process. */
export interface RecoveryEntry {
  projectId: string;
  name: string;
  updatedAt: string;
  contents: string;
}

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
  /** Start the local collaboration server (desktop). Returns started/reason. */
  collabStartServer(port?: number): Promise<{ started: boolean; reason?: string }>;
  /** Subscribe to deep-link ("spatia://join?room=…") join requests. */
  onJoinRequest(cb: (roomId: string) => void): (() => void);
}

declare global {
  interface Window {
    spatia: SpatiaApi;
  }
}
