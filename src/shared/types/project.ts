import type { CanvasObject, AssetMeta } from "./object.js";

export interface ViewportState {
  x: number;
  y: number;
  zoom: number;
}

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The in-memory document model. `objects` are the canvas objects and `assets`
 * hold metadata for the project-local asset store (image/file source files).
 * Asset binaries are never stored in the document JSON — only their metadata
 * and a stable id, which the app resolves to a stored file at open/save time.
 */
export interface ProjectDocument {
  meta: ProjectMeta;
  viewport: ViewportState;
  objects: CanvasObject[];
  assets: AssetMeta[];
}
