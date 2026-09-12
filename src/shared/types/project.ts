import type { CanvasObject, AssetMeta } from "./object.js";

export interface ViewportState {
  x: number;
  y: number;
  zoom: number;
}

/** Collaboration (Phase 2): which room this document is shared to, where, and
 *  the current user's role. Kept out of sync logic — the renderer's live
 *  connection state is authoritative. Omitted entirely for local-only files. */
export interface ShareInfo {
  /** Server room id; empty when never shared. */
  roomId: string;
  /** Base URL the room lives on (used to reconnect later). */
  serverUrl: string;
  /** This user's role in the room (server-enforced). */
  role: "owner" | "editor" | "viewer";
  /** ISO timestamp of the last successful sync (informational). */
  lastSyncedAt?: string;
}

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Project-level tags (Phase 2). Omitted/absent in older files. */
  tags?: string[];
  /** Collaboration share metadata (Phase 2). Absent when not shared. */
  shared?: ShareInfo;
}

/**
 * The in-memory document model. `objects` are the canvas objects and `assets`
 * hold metadata for the project-local asset store (image/file source files).
 */
export interface ProjectDocument {
  meta: ProjectMeta;
  viewport: ViewportState;
  objects: CanvasObject[];
  assets: AssetMeta[];
}
