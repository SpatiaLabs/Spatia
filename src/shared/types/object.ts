/**
 * Extensible object system. A concrete object type is identified by `type` and
 * carries its own structured fields in addition to the common base. New phase
 * types (video, audio, pdf, group, frame, ...) can be added by extending this
 * union without changing existing shape consumers — renderers and commands key
 * off the shared base fields and switch on `type` only where behaviour differs.
 */
import type { TableData } from "../data/table.js";

export type ObjectKind =
  | "test-object"
  | "text"
  | "note"
  | "image"
  | "file"
  | "connection"
  | "group"
  | "frame"
  | "pen"
  | "url"
  | "shape"
  | "table"
  | "chart";

export type TextAlign = "left" | "center" | "right";

/** Frame shell shape (Phase 0.5: rounded/ellipse variants of the default box). */
export type FrameShape = "rectangle" | "rounded" | "ellipse";

/**
 * Concrete diagram shape kind carried by `ShapeObject`. Lines and arrows are
 * drawn horizontally from the box left-center to the box right-center in local
 * space; the arrowhead sits at the end. All shapes (including lines/arrows)
 * share the BaseObject bounding box, so move/resize/rotate/snap/connect all
 * work through the common `x/y/width/height/rotation` fields.
 */
export type ShapeKind =
  | "rectangle"
  | "rounded-rectangle"
  | "ellipse"
  | "diamond"
  | "triangle"
  | "line"
  | "arrow";

/** Shared geometry/common fields present on every object. */
export interface BaseObject {
  readonly id: string;
  readonly type: ObjectKind;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  zIndex: number;
  locked: boolean;
  /** Arbitrary per-object extension data (future phases). */
  metadata: Record<string, unknown>;
}

export interface TestObject extends BaseObject {
  type: "test-object";
}

export interface TextObject extends BaseObject {
  type: "text";
  text: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  align: TextAlign;
  /** Optional font family override (defaults to the canvas UI font). */
  fontFamily?: string;
}

export interface NoteObject extends BaseObject {
  type: "note";
  title: string;
  text: string;
  color: string;
}

export interface ImageObject extends BaseObject {
  type: "image";
  assetId: string;
}

export interface FileObject extends BaseObject {
  type: "file";
  assetId: string;
}

/**
 * A web link / bookmark displayed as a card. `url` is the (possibly
 * https-less) target and `title` is the display label (derived from the URL on
 * creation but editable). Opening the card in the UI opens the link externally.
 */
export interface UrlObject extends BaseObject {
  type: "url";
  url: string;
  title: string;
}

/**
 * A world-space connection (optionally an arrow) drawn between two canvas
 * objects. It references the endpoint objects by id, so the line follows them
 * automatically whenever either endpoint is moved or resized. Its stored
 * x/y/width/height is a derived bounding box kept for culling/persistence; the
 * live geometry is recomputed from the endpoints at render time.
 */
export interface ConnectionObject extends BaseObject {
  type: "connection";
  /** Id of the source (arrow-tail) object. */
  from: string;
  /**
   * Id of the target (arrow-head) object, or an empty string when the
   * connection ends at a free world-space point (see `endX`/`endY`).
   */
  to: string;
  /** World-space position of a free endpoint (when `to` is empty). */
  endX?: number;
  endY?: number;
  /** Draw arrow-head at the `to` end. */
  arrowhead: boolean;
  color: string;
  strokeWidth: number;
  /** Attachment point on the source edge: "auto" snaps to the facing edge. */
  edgeFrom: "auto";
  edgeTo: "auto";
}

/**
 * A grouping of existing objects. The group box is derived from its members;
 * moving the group moves every member together. Selecting the group selects
 * all members (and the wrapper) so delete/duplicate/z-order behave uniformly.
 */
export interface GroupObject extends BaseObject {
  type: "group";
  memberIds: string[];
  name: string;
}

/** A spatial container (workspace element, not a document page). */
export interface FrameObject extends BaseObject {
  type: "frame";
  name: string;
  color: string;
  /** Optional shell variant; defaults to "rectangle" in the renderer. */
  frameShape?: FrameShape;
}

/**
 * A freehand pen stroke. `points` holds world-space polyline vertices so the
 * stroke stays glued to the world while panning/zooming. Its stored x/y/width/
 * height is the derived bounding box of all points (kept for culling and
 * persistence); the live geometry comes from `points`. Pen strokes are
 * selectable so their color / stroke width can be edited, but moving, resizing
 * and rotating them is intentionally not supported.
 */
export interface PenObject extends BaseObject {
  type: "pen";
  points: WorldPoint[];
  color: string;
  strokeWidth: number;
  /** Ink opacity (0..1); absent means fully opaque. */
  opacity?: number;
}

export interface WorldPoint {
  x: number;
  y: number;
  /** Optional stroke width at this vertex (world units). Absent = uniform pen. */
  width?: number;
}

/**
 * A diagram shape / annotations element (rectangle, ellipse, diamond, triangle,
 * line or arrow). `kind` distinguishes the drawing primitive while every shape
 * shares the same property schema so persistence, the inspector and selection
 * handle them uniformly.
 */
export interface ShapeObject extends BaseObject {
  type: "shape";
  kind: ShapeKind;
  /** Interior fill color ("" draws no fill, e.g. for lines). */
  fill: string;
  /** Outline / stroke color. */
  stroke: string;
  strokeWidth: number;
}

/**
 * A structured data grid rendered on the canvas. Editing happens through the
 * inspector's table editor; the shared `TableData` model keeps the grid
 * rectangular and bounded. `comparison` toggles the side-by-side variant
 * (styling + starter template) without forking the data schema.
 */
export interface TableObject extends BaseObject {
  type: "table";
  data: TableData;
  comparison: boolean;
}

export type ChartKind = "bar" | "line" | "pie";

/**
 * A data-driven chart. `data` reuses the table grid (first column = category
 * label, following columns = series) so a user can switch between chart kinds
 * without re-entering numbers.
 */
export interface ChartObject extends BaseObject {
  type: "chart";
  kind: ChartKind;
  /** Optional title drawn above the plot. */
  title: string;
  data: TableData;
}

export type CanvasObject =
  | TestObject
  | TextObject
  | NoteObject
  | ImageObject
  | FileObject
  | UrlObject
  | ConnectionObject
  | GroupObject
  | FrameObject
  | PenObject
  | ShapeObject
  | TableObject
  | ChartObject;

/** Metadata about a project local asset (never stores binary data). */
export interface AssetMeta {
  id: string;
  kind: "image" | "file" | "video" | "audio" | "pdf";
  name: string;
  size: number;
  mime: string;
  ext: string;
  /**
   * Optional compact thumbnail (small data URL) captured at import time.
   * Generated for image assets so galleries/asset chips render instantly
   * without decoding the full binary. Additive: may be absent in older documents.
   */
  thumbnail?: string;
}

/**
 * True when an asset is missing/relinkable — i.e. the object references an
 * asset id whose binary the main process can no longer find on disk. The
 * renderer uses this to surface "missing asset" and offer relinking.
 */
export function isAssetKind(kind: AssetMeta["kind"]): boolean {
  return kind === "image" || kind === "file" || kind === "video" || kind === "audio" || kind === "pdf";
}

export function isLocked(o: CanvasObject): boolean {
  return o.locked;
}

/** Read the tags stored on an object via its reserved metadata field. */
export function objectTags(o: Pick<BaseObject, "metadata">): string[] {
  const raw = o.metadata?.tags;
  return Array.isArray(raw) ? raw.filter((t): t is string => typeof t === "string") : [];
}

/** Compare tags for equality (order-insensitive). */
export function sameTags(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  for (const t of b) if (!setA.has(t)) return false;
  return true;
}
