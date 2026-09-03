import type { ViewportState } from "../types/project.js";
import type {
  CanvasObject,
  AssetMeta,
  ObjectKind,
  TextAlign,
  TextObject,
  NoteObject,
  ImageObject,
  FileObject,
  UrlObject,
  TestObject,
  ConnectionObject,
  GroupObject,
  FrameObject,
  PenObject,
  WorldPoint,
} from "../types/object.js";

export const PROJECT_FORMAT_VERSION = 5;

/**
 * Serialized form of a project that is safe to write to disk. The top-level
 * `formatVersion` allows the app to migrate (or reject) older/newer files in
 * the future. Plain JSON-serializable data only — asset *metadata* is stored
 * here while asset binaries live in a project-local assets directory managed
 * by the main process.
 */
export interface ProjectFile {
  formatVersion: number;
  project: {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
  };
  viewport: ViewportState;
  objects: CanvasObject[];
  assets: AssetMeta[];
}

export function serialize(
  viewport: ViewportState,
  objects: readonly CanvasObject[],
  project: {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
  },
  assets: readonly AssetMeta[] = []
): string {
  const file: ProjectFile = {
    formatVersion: PROJECT_FORMAT_VERSION,
    project,
    viewport: { ...viewport },
    objects: objects.map((o) => ({ ...o })),
    assets: assets.map((a) => ({ ...a })),
  };
  return JSON.stringify(file, null, 2);
}

export class ProjectFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectFormatError";
  }
}

/**
 * Parse and validate a serialized project file. Throws ProjectFormatError on
 * any structural/version problem rather than silently producing corrupt state.
 * Also migrates older formats (v1 -> v2) so Phase 1 projects still load.
 */
export function deserialize(raw: string): ProjectFile {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new ProjectFormatError("Project file is not valid JSON.");
  }

  if (typeof data !== "object" || data === null) {
    throw new ProjectFormatError("Project file must be a JSON object.");
  }

  const file = data as Partial<ProjectFile>;

  if (typeof file.formatVersion !== "number") {
    throw new ProjectFormatError("Project file is missing formatVersion.");
  }

  if (file.formatVersion > PROJECT_FORMAT_VERSION) {
    throw new ProjectFormatError(
      `Project was created by a newer version of Spatia (format ${file.formatVersion}).`
    );
  }
  if (file.formatVersion < 1) {
    throw new ProjectFormatError(`Unsupported project format version ${file.formatVersion}.`);
  }

  // v1 files predate the asset store and the `locked`/`metadata` object fields.
  // Migrate them in memory so Phase 1 projects open unchanged. Later versions
  // (v2–v5) add object kinds and asset categories additively, so their files
  // validate as-is without further migration.
  if (file.formatVersion === 1) {
    migrateV1(file);
  }

  if (file.project === undefined || file.viewport === undefined || !Array.isArray(file.objects)) {
    throw new ProjectFormatError("Project file is missing required sections.");
  }

  validateProjectMeta(file.project);
  validateViewport(file.viewport);

  const objects: CanvasObject[] = [];
  for (const o of file.objects) {
    objects.push(validateObject(o));
  }

  const assets: AssetMeta[] = [];
  if (Array.isArray(file.assets)) {
    for (const a of file.assets) {
      assets.push(validateAsset(a));
    }
  }

  return {
    formatVersion: PROJECT_FORMAT_VERSION,
    project: file.project,
    viewport: file.viewport,
    objects,
    assets,
  };
}

/** Normalize a v1 file in place into the shape expected by v2 validation. */
function migrateV1(file: Partial<ProjectFile>): void {
  if (!Array.isArray(file.objects)) return;
  for (const o of file.objects) {
    const rec = o as unknown as Record<string, unknown>;
    if (rec === null || typeof rec !== "object") continue;
    if (rec.locked === undefined) rec.locked = false;
    if (rec.metadata === undefined) rec.metadata = {};
  }
  if (!Array.isArray(file.assets)) file.assets = [];
  file.formatVersion = PROJECT_FORMAT_VERSION;
}

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProjectFormatError(`Invalid ${label}: expected a finite number.`);
  }
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") {
    throw new ProjectFormatError(`Invalid ${label}: expected a string.`);
  }
}

function assertBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new ProjectFormatError(`Invalid ${label}: expected a boolean.`);
  }
}

function validateProjectMeta(meta: unknown): void {
  if (typeof meta !== "object" || meta === null) {
    throw new ProjectFormatError("Invalid project metadata.");
  }
  const m = meta as Record<string, unknown>;
  assertString(m.id, "project.id");
  assertString(m.name, "project.name");
}

function validateViewport(vp: unknown): void {
  if (typeof vp !== "object" || vp === null) {
    throw new ProjectFormatError("Invalid viewport.");
  }
  const v = vp as Record<string, unknown>;
  assertFiniteNumber(v.x, "viewport.x");
  assertFiniteNumber(v.y, "viewport.y");
  assertFiniteNumber(v.zoom, "viewport.zoom");
}

function validateAsset(a: unknown): AssetMeta {
  if (typeof a !== "object" || a === null) {
    throw new ProjectFormatError("Invalid asset entry.");
  }
  const rec = a as Record<string, unknown>;
  assertString(rec.id, "asset.id");
  if (
    rec.kind !== "image" &&
    rec.kind !== "file" &&
    rec.kind !== "video" &&
    rec.kind !== "audio" &&
    rec.kind !== "pdf"
  ) {
    throw new ProjectFormatError(`Invalid asset kind: ${String(rec.kind)}`);
  }
  assertString(rec.name, "asset.name");
  assertFiniteNumber(rec.size, "asset.size");
  assertString(rec.mime, "asset.mime");
  assertString(rec.ext, "asset.ext");
  return {
    id: rec.id,
    kind: rec.kind as AssetMeta["kind"],
    name: rec.name,
    size: rec.size,
    mime: rec.mime,
    ext: rec.ext,
  };
}

interface BaseLike<K extends ObjectKind> {
  type: K;
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  zIndex: number;
  locked: boolean;
  metadata: Record<string, unknown>;
}

function commonBase<K extends ObjectKind>(o: Record<string, unknown>, kind: K, id: string): BaseLike<K> {
  assertFiniteNumber(o.x, "object.x");
  assertFiniteNumber(o.y, "object.y");
  assertFiniteNumber(o.width, "object.width");
  assertFiniteNumber(o.height, "object.height");
  assertFiniteNumber(o.rotation, "object.rotation");
  assertFiniteNumber(o.zIndex, "object.zIndex");
  const locked = o.locked === undefined ? false : o.locked;
  assertBoolean(locked, "object.locked");
  if (o.metadata !== undefined && (typeof o.metadata !== "object" || o.metadata === null)) {
    throw new ProjectFormatError("Invalid object.metadata.");
  }
  return {
    type: kind,
    id,
    x: o.x,
    y: o.y,
    width: o.width,
    height: o.height,
    rotation: o.rotation,
    zIndex: o.zIndex,
    locked,
    metadata: (o.metadata as Record<string, unknown>) ?? {},
  };
}

function validateObject(o: unknown): CanvasObject {
  if (typeof o !== "object" || o === null) {
    throw new ProjectFormatError("Invalid object entry.");
  }
  const obj = o as Record<string, unknown>;
  if (typeof obj.id !== "string") {
    throw new ProjectFormatError("Object requires string id.");
  }

  switch (obj.type) {
    case "test-object": {
      const base = commonBase(obj, "test-object", obj.id);
      return base as TestObject;
    }
    case "text": {
      const base = commonBase(obj, "text", obj.id);
      assertString(obj.text, "text.text");
      const align = obj.align ?? "left";
      if (align !== "left" && align !== "center" && align !== "right") {
        throw new ProjectFormatError("Invalid text.align.");
      }
      const fontSize = obj.fontSize === undefined ? 24 : obj.fontSize;
      assertFiniteNumber(fontSize, "text.fontSize");
      const bold = obj.bold === undefined ? false : obj.bold;
      assertBoolean(bold, "text.bold");
      const italic = obj.italic === undefined ? false : obj.italic;
      assertBoolean(italic, "text.italic");
      const textObj: TextObject = {
        ...base,
        text: obj.text,
        fontSize,
        align: align as TextAlign,
        bold,
        italic,
      };
      return textObj;
    }
    case "note": {
      const base = commonBase(obj, "note", obj.id);
      const title = obj.title === undefined ? "" : obj.title;
      const text = obj.text === undefined ? "" : obj.text;
      const color = obj.color === undefined ? "#f0c33c" : obj.color;
      assertString(title, "note.title");
      assertString(text, "note.text");
      assertString(color, "note.color");
      const noteObj: NoteObject = { ...base, title, text, color };
      return noteObj;
    }
    case "image": {
      const base = commonBase(obj, "image", obj.id);
      assertString(obj.assetId, "image.assetId");
      const imageObj: ImageObject = { ...base, assetId: obj.assetId };
      return imageObj;
    }
    case "file": {
      const base = commonBase(obj, "file", obj.id);
      assertString(obj.assetId, "file.assetId");
      const fileObj: FileObject = { ...base, assetId: obj.assetId };
      return fileObj;
    }
    case "url": {
      const base = commonBase(obj, "url", obj.id);
      assertString(obj.url, "url.url");
      const title = obj.title === undefined ? "" : obj.title;
      assertString(title, "url.title");
      const urlObj: UrlObject = { ...base, url: obj.url, title };
      return urlObj;
    }
    case "connection": {
      const base = commonBase(obj, "connection", obj.id);
      assertString(obj.from, "connection.from");
      assertString(obj.to, "connection.to");
      const color = obj.color ?? "#91a3f0";
      assertString(color, "connection.color");
      const strokeWidth = obj.strokeWidth ?? 2;
      assertFiniteNumber(strokeWidth, "connection.strokeWidth");
      const arrowhead = obj.arrowhead ?? true;
      assertBoolean(arrowhead, "connection.arrowhead");
      const edgeFrom = obj.edgeFrom ?? "auto";
      const edgeTo = obj.edgeTo ?? "auto";
      // Free-endpoint connections store the world position of the free end.
      let endX: number | undefined;
      let endY: number | undefined;
      if (obj.to === "") {
        assertFiniteNumber(obj.endX, "connection.endX");
        assertFiniteNumber(obj.endY, "connection.endY");
        endX = obj.endX;
        endY = obj.endY;
      }
      const conn: ConnectionObject = {
        ...base,
        from: obj.from,
        to: obj.to,
        ...(endX !== undefined && { endX }),
        ...(endY !== undefined && { endY }),
        color,
        strokeWidth,
        arrowhead,
        edgeFrom: edgeFrom === "auto" ? "auto" : "auto",
        edgeTo: edgeTo === "auto" ? "auto" : "auto",
      };
      return conn;
    }
    case "pen": {
      const base = commonBase(obj, "pen", obj.id);
      if (!Array.isArray(obj.points) || obj.points.length === 0) {
        throw new ProjectFormatError("Invalid pen.points.");
      }
      const points: WorldPoint[] = [];
      for (const raw of obj.points) {
        if (typeof raw !== "object" || raw === null) {
          throw new ProjectFormatError("Invalid pen.point.");
        }
        const p = raw as Record<string, unknown>;
        assertFiniteNumber(p.x, "pen.point.x");
        assertFiniteNumber(p.y, "pen.point.y");
        points.push({ x: p.x, y: p.y });
      }
      const color = obj.color === undefined ? "#e8eaed" : obj.color;
      assertString(color, "pen.color");
      const strokeWidth = obj.strokeWidth ?? 3;
      assertFiniteNumber(strokeWidth, "pen.strokeWidth");
      const pen: PenObject = { ...base, points, color, strokeWidth };
      return pen;
    }
    case "group": {
      const base = commonBase(obj, "group", obj.id);
      if (!Array.isArray(obj.memberIds) || obj.memberIds.some((m) => typeof m !== "string")) {
        throw new ProjectFormatError("Invalid group.memberIds.");
      }
      const name = obj.name ?? "";
      assertString(name, "group.name");
      const group: GroupObject = { ...base, memberIds: obj.memberIds as string[], name };
      return group;
    }
    case "frame": {
      const base = commonBase(obj, "frame", obj.id);
      const name = obj.name ?? "";
      const color = obj.color ?? "#2a6df5";
      assertString(name, "frame.name");
      assertString(color, "frame.color");
      const frame: FrameObject = { ...base, name, color };
      return frame;
    }
    default:
      throw new ProjectFormatError(`Unknown object type: ${String(obj.type)}`);
  }
}
