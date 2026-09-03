/**
 * Extensible object system. A concrete object type is identified by `type` and
 * carries its own structured fields in addition to the common base. New phase
 * types (video, audio, pdf, group, frame, ...) can be added by extending this
 * union without changing existing shape consumers — renderers and commands key
 * off the shared base fields and switch on `type` only where behaviour differs.
 */

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
  | "url";

export type TextAlign = "left" | "center" | "right";

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
}

/**
 * A freehand pen stroke. `points` holds world-space polyline vertices so the
 * stroke stays glued to the world while panning/zooming. Its stored x/y/width/
 * height is the derived bounding box of all points (kept for culling and
 * persistence); the live geometry comes from `points`. Pen strokes are
 * decorative: they are drawn but not hit-testable or selectable.
 */
export interface PenObject extends BaseObject {
  type: "pen";
  points: WorldPoint[];
  color: string;
  strokeWidth: number;
}

export interface WorldPoint {
  x: number;
  y: number;
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
  | PenObject;

/** Metadata about a project local asset (never stores binary data). */
export interface AssetMeta {
  id: string;
  kind: "image" | "file" | "video" | "audio" | "pdf";
  name: string;
  size: number;
  mime: string;
  ext: string;
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
