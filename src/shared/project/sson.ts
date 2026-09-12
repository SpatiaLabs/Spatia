/**
 * SSON — Spatia Structured Object Notation.
 *
 * The native serialization format for `.spatia` project files. It is a plain
 * text, JSON-free notation with blocks, keyword lists and raw numbers. The
 * intelligence lives in this module: repeated labels, default values and
 * structural punctuation are omitted so large projects (thousands of objects
 * and pen strokes with tens of thousands of points) stay dramatically smaller
 * than the equivalent pretty-printed JSON while remaining fully human
 * readable and diffable.
 *
 * The renderer keeps its long-standing JSON interchange for in-memory
 * snapshots (recovery, version history, collaboration). The main process
 * converts between that JSON form and SSON at the `.spatia` disk boundary:
 *
 *   save  : renderer JSON -> projectFileToSSON ->  .spatia (SSON text)
 *   open  : .spatia SSON  -> projectFileFromSSON -> JSON   (renderer)
 *   legacy: .spatia.json (JSON)                 ->  pass through
 *
 * Format version is `format 1` at the top of the document.
 */
import type { AssetMeta, CanvasObject, ObjectKind, FrameShape, ShapeKind, WorldPoint } from "../types/object.js";
import type { ViewportState, ShareInfo } from "../types/project.js";
import { SHAPE_DEFAULTS } from "../geometry/shapes.js";
import { createTableData, createChartTableData } from "../data/table.js";
import type { ProjectFile } from "./serialize.js";
import { ProjectFormatError, PROJECT_FORMAT_VERSION } from "./serialize.js";

/** The SSON file format version (independent of the JSON interchange version). */
export const SSON_FORMAT_VERSION = 1;

export function isSSON(text: string): boolean {
  return /^\s*project\b/.test(text);
}

// -------- defaults mirrored from the JSON validator (serialize.ts) --------

const DEFAULT_TEXT_SIZE = 24;
const DEFAULT_NOTE_COLOR = "#f0c33c";
const DEFAULT_CONNECTION_COLOR = "#91a3f0";
const DEFAULT_CONNECTION_STROKE = 2;
const DEFAULT_PEN_COLOR = "#e8eaed";
const DEFAULT_PEN_STROKE = 3;
const DEFAULT_FRAME_COLOR = "#2a6df5";

function num(n: number): string {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new ProjectFormatError("Cannot serialize a non-finite number in SSON.");
  }
  return String(n);
}

function str(s: string): string {
  return JSON.stringify(s);
}

// -------- generic value renderer (metadata, etc.) --------

function valueToSSON(v: unknown): string {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "string") return str(v as string);
  if (t === "number") return num(v as number);
  if (t === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return `[ ${v.map(valueToSSON).join(" ")} ]`;
  if (t === "object") {
    const rec = v as Record<string, unknown>;
    const entries = Object.entries(rec);
    if (entries.length === 0) return "{}";
    const parts: string[] = [];
    for (const [k, val] of entries) {
      const key = /^[A-Za-z_][A-Za-z0-9_-]*$/.test(k) ? k : str(k);
      parts.push(`${key} ${valueToSSON(val)}`);
    }
    return `{ ${parts.join(" ")} }`;
  }
  return "null";
}

function commonExtra(o: CanvasObject): string[] {
  const out: string[] = [];
  if (o.rotation !== 0) out.push(`rotation ${num(o.rotation)}`);
  if (o.zIndex !== 0) out.push(`z ${num(o.zIndex)}`);
  if (o.locked) out.push("locked");
  if (o.metadata && Object.keys(o.metadata).length > 0) out.push(`metadata ${valueToSSON(o.metadata)}`);
  return out;
}

/** Render one canvas object as `type "id" { ... }` at the given indentation. */
function objectToSSON(o: CanvasObject, ind: string): string {
  const lines: string[] = [];
  const push = (...f: string[]) => lines.push(f.join(" "));

  switch (o.type) {
    case "text": {
      push(`text ${str(o.text)}`);
      if (o.fontSize !== DEFAULT_TEXT_SIZE) push(`size ${num(o.fontSize)}`);
      if (o.align !== "left") push(`align ${o.align}`);
      if (o.bold) push("bold");
      if (o.italic) push("italic");
      if (o.fontFamily) push(`font ${str(o.fontFamily)}`);
      break;
    }
    case "note": {
      if (o.title) push(`title ${str(o.title)}`);
      push(`text ${str(o.text)}`);
      if (o.color !== DEFAULT_NOTE_COLOR) push(`color ${str(o.color)}`);
      break;
    }
    case "image":
    case "file":
      push(`asset ${str(o.assetId)}`);
      break;
    case "url": {
      push(`url ${str(o.url)}`);
      if (o.title) push(`title ${str(o.title)}`);
      break;
    }
    case "connection": {
      push(`from ${str(o.from)}`);
      push(`to ${str(o.to)}`);
      if (o.to === "" && o.endX !== undefined && o.endY !== undefined) {
        push(`end ${num(o.endX)} ${num(o.endY)}`);
      }
      if (o.color !== DEFAULT_CONNECTION_COLOR) push(`color ${str(o.color)}`);
      if (o.strokeWidth !== DEFAULT_CONNECTION_STROKE) push(`stroke ${num(o.strokeWidth)}`);
      if (!o.arrowhead) push("arrow false");
      break;
    }
    case "group": {
      push(`members [ ${o.memberIds.map(str).join(" ")} ]`);
      if (o.name) push(`name ${str(o.name)}`);
      break;
    }
    case "frame": {
      if (o.name) push(`name ${str(o.name)}`);
      if (o.color !== DEFAULT_FRAME_COLOR) push(`color ${str(o.color)}`);
      if (o.frameShape !== undefined && o.frameShape !== "rectangle") push(`shape ${o.frameShape}`);
      break;
    }
    case "shape": {
      const d = SHAPE_DEFAULTS[o.kind];
      if (o.kind !== "rectangle") push(`kind ${o.kind}`);
      if (o.fill !== d.fill) push(`fill ${str(o.fill)}`);
      if (o.stroke !== d.stroke) push(`outline ${str(o.stroke)}`);
      if (o.strokeWidth !== d.strokeWidth) push(`stroke ${num(o.strokeWidth)}`);
      break;
    }
    case "pen": {
      if (o.color !== DEFAULT_PEN_COLOR) push(`color ${str(o.color)}`);
      if (o.strokeWidth !== DEFAULT_PEN_STROKE) push(`stroke ${num(o.strokeWidth)}`);
      if (o.opacity !== undefined && o.opacity < 1) push(`opacity ${num(o.opacity)}`);
      break;
    }
    case "table": {
      if (o.comparison) push("comparison");
      break;
    }
    case "chart": {
      if (o.kind !== "bar") push(`kind ${o.kind}`);
      if (o.title) push(`title ${str(o.title)}`);
      break;
    }
    case "test-object":
      break;
  }

  push(`bounds ${num(o.x)} ${num(o.y)} ${num(o.width)} ${num(o.height)}`);
  push(...commonExtra(o));

  // List-valued fields go at the end (points / table grid).
  if (o.type === "pen") {
    const inner = ind + "        ";
    const pts = o.points.map(
      (p) => `${inner}${num(p.x)} ${num(p.y)}${p.width !== undefined ? " " + num(p.width) : ""}`
    );
    lines.push(`points [\n${pts.join("\n")}\n${ind + "    "}]`);
  }
  if (o.type === "table" || o.type === "chart") {
    lines.push(`columns [ ${o.data.columns.map(str).join(" ")} ]`);
    if (o.data.rows.length > 0) {
      const inner = ind + "        ";
      const rowLines = o.data.rows.map((r) => `${inner}[ ${r.map(str).join(" ")} ]`);
      lines.push(`rows [\n${rowLines.join("\n")}\n${ind + "    "}]`);
    } else {
      lines.push("rows [ ]");
    }
  }

  const body = lines.map((l) => ind + "    " + l).join("\n");
  return `${ind}${o.type} ${str(o.id)} {\n${body}\n${ind}}`;
}

function assetToSSON(a: AssetMeta, ind: string): string {
  const lines: string[] = [`${ind}    name ${str(a.name)}`, `${ind}    size ${num(a.size)}`];
  lines.push(`mime ${str(a.mime)}`, `ext ${a.ext}`);
  if (a.thumbnail) lines.push(`thumbnail ${str(a.thumbnail)}`);
  return `${ind}${a.kind} ${str(a.id)} {\n${lines.join("\n")}\n${ind}}`;
}

function infoToSSON(project: ProjectFile["project"]): string {
  const lines: string[] = [
    `id ${str(project.id)}`,
    `name ${str(project.name)}`,
    `created ${str(project.createdAt)}`,
    `updated ${str(project.updatedAt)}`,
  ];
  if (project.tags !== undefined && project.tags.length > 0) {
    lines.push(`tags [ ${project.tags.map(str).join(" ")} ]`);
  }
  if (project.shared !== undefined) {
    const s: string[] = [`roomId ${str(project.shared.roomId)}`, `serverUrl ${str(project.shared.serverUrl)}`];
    s.push(`role ${project.shared.role}`);
    if (project.shared.lastSyncedAt !== undefined) s.push(`lastSyncedAt ${str(project.shared.lastSyncedAt)}`);
    lines.push(`shared {\n${s.map((l) => "        " + l).join("\n")}\n    }`);
  }
  return lines.map((l) => "        " + l).join("\n");
}

/**
 * Serialize a validated project model to SSON text. The produced document uses
 * the canonical syntax (project/info/viewport/objects/assets blocks) with
 * default values omitted to keep large projects small.
 */
export function projectFileToSSON(file: ProjectFile): string {
  const parts: string[] = [`project {`, `    format ${SSON_FORMAT_VERSION}`, ``, `    info {`, infoToSSON(file.project), `    }`, ``, `    viewport {`, `        position ${num(file.viewport.x)} ${num(file.viewport.y)}`, `        zoom ${num(file.viewport.zoom)}`, `    }`, ``];

  if (file.objects.length > 0) {
    const objs = file.objects.map((o) => objectToSSON(o, "        "));
    parts.push(`    objects [`, objs.join("\n"), `    ]`);
  } else {
    parts.push(`    objects [ ]`);
  }

  if (file.assets.length > 0) {
    const as = file.assets.map((a) => assetToSSON(a, "        "));
    parts.push("", `    assets [`, as.join("\n"), `    ]`);
  }

  parts.push(`}`);
  return parts.join("\n");
}

/** Direct converter: SSON text -> renderer JSON project contents. */
export function ssonToJSON(raw: string): string {
  return JSON.stringify(projectFileFromSSON(raw));
}

// -------- tokenizer --------

type Tok = { k: "id" | "str" | "num" | "punct"; v: string; line: number };

const NUMBER_RE = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  const ws = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
  const punct = (c: string) => c === "{" || c === "}" || c === "[" || c === "]";

  while (i < n) {
    const c = src[i];
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (ws(c)) {
      i++;
      continue;
    }
    if (punct(c)) {
      toks.push({ k: "punct", v: c, line });
      i++;
      continue;
    }
    if (c === '"') {
      i++;
      let out = "";
      let closed = false;
      while (i < n) {
        const ch = src[i];
        if (ch === "\n") line++;
        if (ch === '"') {
          closed = true;
          i++;
          break;
        }
        if (ch === "\\") {
          i++;
          if (i >= n) throw new ProjectFormatError("Unterminated escape in SSON string.");
          const e = src[i];
          if (e === "n") out += "\n";
          else if (e === "t") out += "\t";
          else if (e === "r") out += "\r";
          else if (e === "b") out += "\b";
          else if (e === "f") out += "\f";
          else if (e === "/") out += "/";
          else if (e === '"') out += '"';
          else if (e === "\\") out += "\\";
          else if (e === "u") {
            const hex = src.slice(i + 1, i + 5);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new ProjectFormatError("Invalid \\u escape in SSON string.");
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
          } else {
            throw new ProjectFormatError(`Unknown SSON escape \\${e}.`);
          }
          i++;
          continue;
        }
        out += ch;
        i++;
      }
      if (!closed) throw new ProjectFormatError("Unterminated SSON string.");
      toks.push({ k: "str", v: out, line });
      continue;
    }
    const start = i;
    while (i < n && !ws(src[i]) && !punct(src[i]) && src[i] !== '"') i++;
    if (i === start) throw new ProjectFormatError(`Unexpected character '${src[i]}' in SSON.`);
    const raw = src.slice(start, i);
    toks.push({ k: NUMBER_RE.test(raw) ? "num" : "id", v: raw, line });
  }
  return toks;
}

class P {
  pos = 0;
  constructor(private toks: Tok[]) {}

  peek(): Tok | undefined {
    return this.toks[this.pos];
  }
  next(): Tok {
    const t = this.toks[this.pos];
    if (!t) throw new ProjectFormatError("Unexpected end of SSON.");
    this.pos++;
    return t;
  }
  eatPunct(ch: string): boolean {
    const t = this.peek();
    if (t && t.k === "punct" && t.v === ch) {
      this.pos++;
      return true;
    }
    return false;
  }
  expectPunct(ch: string): void {
    if (!this.eatPunct(ch)) throw new ProjectFormatError(`Expected '${ch}' in SSON.`);
  }
  eatId(name: string): boolean {
    const t = this.peek();
    if (t && t.k === "id" && t.v === name) {
      this.pos++;
      return true;
    }
    return false;
  }
  expectId(name: string): void {
    if (!this.eatId(name)) throw new ProjectFormatError(`Expected '${name}' in SSON.`);
  }
  /** A bare or quoted string token (accepts numeric tokens leniently). */
  strValue(): string {
    const t = this.next();
    if (t.k === "str" || t.k === "id" || t.k === "num") return t.v;
    throw new ProjectFormatError(`Expected a string value in SSON, got '${t.v}'.`);
  }
  numValue(): number {
    const t = this.next();
    if (t.k !== "num") throw new ProjectFormatError(`Expected a number in SSON, got '${t.v}'.`);
    const v = Number(t.v);
    if (!Number.isFinite(v)) throw new ProjectFormatError(`Non-finite number in SSON: ${t.v}.`);
    return v;
  }
  boolValue(): boolean {
    const t = this.next();
    if (t.k === "id" && (t.v === "true" || t.v === "false")) return t.v === "true";
    throw new ProjectFormatError(`Expected true/false in SSON, got '${t.v}'.`);
  }
  /** Parse any SSON value (used inside metadata). */
  value(): unknown {
    const t = this.peek();
    if (!t) throw new ProjectFormatError("Unexpected end of SSON value.");
    if (t.k === "str") return this.next().v;
    if (t.k === "num") return Number(this.next().v);
    if (t.k === "punct" && t.v === "[") {
      this.next();
      const out: unknown[] = [];
      while (!this.eatPunct("]")) out.push(this.value());
      return out;
    }
    if (t.k === "punct" && t.v === "{") {
      this.next();
      const out: Record<string, unknown> = {};
      while (!this.eatPunct("}")) {
        const keyTok = this.next();
        if (keyTok.k !== "id" && keyTok.k !== "str") {
          throw new ProjectFormatError(`Expected an object key in SSON, got '${keyTok.v}'.`);
        }
        out[keyTok.v] = this.value();
      }
      return out;
    }
    // bare identifier — true / false / null
    this.next();
    if (t.v === "true") return true;
    if (t.v === "false") return false;
    if (t.v === "null") return null;
    return t.v;
  }
  /** A string element list: `[ "a" "b" ]`. */
  strList(): string[] {
    this.expectPunct("[");
    const out: string[] = [];
    while (!this.eatPunct("]")) out.push(this.strValue());
    return out;
  }
}

// -------- parser --------

function parseInfo(p: P): ProjectFile["project"] {
  const out: { id?: string; name?: string; createdAt?: string; updatedAt?: string } = {};
  let tags: string[] | undefined;
  let shared: ShareInfo | undefined;
  while (p.peek() && !p.eatPunct("}")) {
    const name = p.next();
    if (name.k !== "id") throw new ProjectFormatError(`Expected an info field in SSON, got '${name.v}'.`);
    switch (name.v) {
      case "id":
        out.id = p.strValue();
        break;
      case "name":
        out.name = p.strValue();
        break;
      case "created":
      case "createdAt":
        out.createdAt = p.strValue();
        break;
      case "updated":
      case "updatedAt":
        out.updatedAt = p.strValue();
        break;
      case "tags":
        tags = p.strList();
        break;
      case "shared": {
        p.expectPunct("{");
        let roomId: string | undefined;
        let serverUrl: string | undefined;
        let role: ShareInfo["role"] | undefined;
        let lastSyncedAt: string | undefined;
        while (p.peek() && !p.eatPunct("}")) {
          const f = p.next();
          if (f.k !== "id") throw new ProjectFormatError(`Expected a shared field in SSON, got '${f.v}'.`);
          if (f.v === "roomId") roomId = p.strValue();
          else if (f.v === "serverUrl") serverUrl = p.strValue();
          else if (f.v === "role") {
            const r = p.strValue();
            if (r !== "owner" && r !== "editor" && r !== "viewer") {
              throw new ProjectFormatError(`Invalid shared.role '${r}'.`);
            }
            role = r;
          } else if (f.v === "lastSyncedAt") lastSyncedAt = p.strValue();
        }
        if (roomId === undefined || serverUrl === undefined || role === undefined) {
          throw new ProjectFormatError("Invalid project.shared in SSON.");
        }
        shared = { roomId, serverUrl, role, ...(lastSyncedAt !== undefined ? { lastSyncedAt } : {}) };
        break;
      }
      default:
        throw new ProjectFormatError(`Unknown info field '${name.v}' in SSON.`);
    }
  }
  if (!out.id || !out.name || !out.createdAt || !out.updatedAt) {
    throw new ProjectFormatError("SSON info block is missing id/name/created/updated.");
  }
  return { id: out.id, name: out.name, createdAt: out.createdAt, updatedAt: out.updatedAt, ...(tags !== undefined && tags.length > 0 ? { tags } : {}), ...(shared ? { shared } : {}) };
}

function parseViewport(p: P): ViewportState {
  let x = 0;
  let y = 0;
  let zoom = 1;
  let hasPos = false;
  let hasZoom = false;
  while (p.peek() && !p.eatPunct("}")) {
    const name = p.next();
    if (name.k !== "id") throw new ProjectFormatError(`Expected a viewport field in SSON, got '${name.v}'.`);
    if (name.v === "position") {
      x = p.numValue();
      y = p.numValue();
      hasPos = true;
    } else if (name.v === "zoom") {
      zoom = p.numValue();
      hasZoom = true;
    } else {
      throw new ProjectFormatError(`Unknown viewport field '${name.v}' in SSON.`);
    }
  }
  if (!hasPos || !hasZoom) throw new ProjectFormatError("SSON viewport is missing position/zoom.");
  return { x, y, zoom };
}

function parseRows(p: P): string[][] {
  p.expectPunct("[");
  const rows: string[][] = [];
  while (!p.eatPunct("]")) {
    p.expectPunct("[");
    const row: string[] = [];
    while (!p.eatPunct("]")) row.push(p.strValue());
    rows.push(row);
  }
  return rows;
}

function parsePoints(p: P): WorldPoint[] {
  p.expectPunct("[");
  const pts: WorldPoint[] = [];
  while (true) {
    const t0 = p.peek();
    if (t0 === undefined || (t0.k === "punct" && t0.v === "]")) {
      p.eatPunct("]");
      break;
    }
    // Each point lives on its own line: `x y` or `x y w`. Line info
    // disambiguates a two-number point from a three-number one.
    const line = t0.line;
    const x = p.numValue();
    const y = p.numValue();
    let width: number | undefined;
    const nxt = p.peek();
    if (nxt && nxt.k === "num" && nxt.line === line) {
      const w = p.numValue();
      if (w > 0 && Number.isFinite(w)) width = w;
    }
    pts.push(width === undefined ? { x, y } : { x, y, width });
  }
  if (pts.length === 0) throw new ProjectFormatError("Pen requires at least one point.");
  return pts;
}

function parseObject(p: P): CanvasObject {
  const typeTok = p.next();
  if (typeTok.k !== "id") throw new ProjectFormatError(`Expected an object type in SSON, got '${typeTok.v}'.`);
  const type = typeTok.v as ObjectKind;
  const id = p.strValue();
  p.expectPunct("{");

  const base = {
    type,
    id,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    rotation: 0,
    zIndex: 0,
    locked: false,
    metadata: {} as Record<string, unknown>,
  };

  // Shared across the whole object block; labeled by field.
  let bounds: number[] | null = null;
  let text: string | undefined;
  let title: string | undefined;
  let color: string | undefined;
  let assetId: string | undefined;
  let url: string | undefined;
  let from: string | undefined;
  let to: string | undefined;
  let endX: number | undefined;
  let endY: number | undefined;
  let strokeWidth: number | undefined;
  let arrowhead: boolean | undefined;
  let fontSize: number | undefined;
  let align: string | undefined;
  let bold: boolean | undefined;
  let italic: boolean | undefined;
  let fontFamily: string | undefined;
  let members: string[] | undefined;
  let name: string | undefined;
  let frameShape: FrameShape | undefined;
  let kind: string | undefined;
  let fill: string | undefined;
  let outline: string | undefined;
  let comparison: boolean | undefined;
  let opacity: number | undefined;
  let points: WorldPoint[] | undefined;
  let tableColumns: string[] | undefined;
  let tableRows: string[][] | undefined;

  while (p.peek() && !p.eatPunct("}")) {
    const f = p.next();
    if (f.k !== "id") throw new ProjectFormatError(`Expected an object field in SSON, got '${f.v}'.`);
    switch (f.v) {
      case "bounds":
        bounds = [p.numValue(), p.numValue(), p.numValue(), p.numValue()];
        break;
      case "rotation":
        base.rotation = p.numValue();
        break;
      case "z":
      case "zIndex":
        base.zIndex = p.numValue();
        break;
      case "locked": {
        const nxt = p.peek();
        if (nxt && nxt.k === "id" && (nxt.v === "true" || nxt.v === "false")) {
          base.locked = p.boolValue();
        } else {
          base.locked = true;
        }
        break;
      }
      case "metadata":
        base.metadata = (p.value() as Record<string, unknown>) ?? {};
        break;
      case "text":
        text = p.strValue();
        break;
      case "title":
        title = p.strValue();
        break;
      case "color":
        color = p.strValue();
        break;
      case "asset":
        assetId = p.strValue();
        break;
      case "url":
        url = p.strValue();
        break;
      case "from":
        from = p.strValue();
        break;
      case "to":
        to = p.strValue();
        break;
      case "end":
        endX = p.numValue();
        endY = p.numValue();
        break;
      case "stroke":
        strokeWidth = p.numValue();
        break;
      case "arrow":
        arrowhead = p.boolValue();
        break;
      case "size":
        fontSize = p.numValue();
        break;
      case "align":
        align = p.strValue();
        break;
      case "bold":
        bold = true;
        break;
      case "italic":
        italic = true;
        break;
      case "font":
        fontFamily = p.strValue();
        break;
      case "members":
        members = p.strList();
        break;
case "name":
        name = p.strValue();
        break;
      case "shape": {
        const sv = p.strValue();
        frameShape = sv === "rectangle" ? undefined : sv === "ellipse" ? "ellipse" : "rounded";
        break;
      }
      case "kind":
        kind = p.strValue();
        break;
      case "fill":
        fill = p.strValue();
        break;
      case "outline":
        outline = p.strValue();
        break;
      case "comparison":
        comparison = true;
        break;
      case "opacity":
        opacity = p.numValue();
        break;
      case "points":
        points = parsePoints(p);
        break;
      case "columns":
        tableColumns = p.strList();
        break;
      case "rows":
        tableRows = parseRows(p);
        break;
      default:
        throw new ProjectFormatError(`Unknown object field '${f.v}' in SSON.`);
    }
  }

  if (bounds === null) throw new ProjectFormatError(`Object '${id}' is missing its bounds.`);
  base.x = bounds[0];
  base.y = bounds[1];
  base.width = bounds[2];
  base.height = bounds[3];

  switch (type) {
    case "text": {
      if (text === undefined) throw new ProjectFormatError("Text object requires text.");
      const f = fontFamily !== undefined && fontFamily !== "" ? fontFamily : undefined;
      return {
        ...base,
        text,
        fontSize: fontSize ?? DEFAULT_TEXT_SIZE,
        align: (align === "center" || align === "right" ? align : "left") as "left" | "center" | "right",
        bold: bold ?? false,
        italic: italic ?? false,
        ...(f !== undefined ? { fontFamily: f } : {}),
      } as CanvasObject;
    }
    case "note":
      return { ...base, title: title ?? "", text: text ?? "", color: color ?? DEFAULT_NOTE_COLOR } as CanvasObject;
    case "image":
      if (assetId === undefined) throw new ProjectFormatError("Image object requires an asset.");
      return { ...base, assetId } as CanvasObject;
    case "file":
      if (assetId === undefined) throw new ProjectFormatError("File object requires an asset.");
      return { ...base, assetId } as CanvasObject;
    case "url": {
      if (url === undefined) throw new ProjectFormatError("URL object requires url.");
      return { ...base, url, title: title ?? "" } as CanvasObject;
    }
    case "connection": {
      if (from === undefined || to === undefined) throw new ProjectFormatError("Connection object requires from/to.");
      if (to === "" && (endX === undefined || endY === undefined)) {
        throw new ProjectFormatError("Free-endpoint connection requires an end position.");
      }
      const conn = {
        ...base,
        from,
        to,
        color: color ?? DEFAULT_CONNECTION_COLOR,
        strokeWidth: strokeWidth ?? DEFAULT_CONNECTION_STROKE,
        arrowhead: arrowhead ?? true,
        edgeFrom: "auto" as const,
        edgeTo: "auto" as const,
      };
      if (to === "" && endX !== undefined && endY !== undefined) {
        return { ...conn, endX, endY } as CanvasObject;
      }
      return conn as CanvasObject;
    }
    case "group": {
      if (members === undefined) throw new ProjectFormatError("Group object requires members.");
      return { ...base, memberIds: members, name: name ?? "" } as CanvasObject;
    }
    case "frame":
      return { ...base, name: name ?? "", color: color ?? DEFAULT_FRAME_COLOR, ...(frameShape !== undefined ? { frameShape } : {}) } as CanvasObject;
    case "shape": {
      const skind = kind ?? "rectangle";
      const shapeKind = (["rectangle", "rounded-rectangle", "ellipse", "diamond", "triangle", "line", "arrow"] as ShapeKind[]).includes(skind as ShapeKind) ? (skind as ShapeKind) : "rectangle";
      const d = SHAPE_DEFAULTS[shapeKind];
      return { ...base, kind: shapeKind, fill: fill ?? d.fill, stroke: outline ?? d.stroke, strokeWidth: strokeWidth ?? d.strokeWidth } as CanvasObject;
    }
    case "pen":
      if (points === undefined) throw new ProjectFormatError("Pen object requires points.");
      return {
        ...base,
        points,
        color: color ?? DEFAULT_PEN_COLOR,
        strokeWidth: strokeWidth ?? DEFAULT_PEN_STROKE,
        ...(opacity !== undefined && opacity > 0 && opacity < 1 ? { opacity } : {}),
      } as CanvasObject;
    case "table": {
      const data = tableColumns !== undefined || tableRows !== undefined ? { columns: tableColumns ?? [], rows: tableRows ?? [] } : createTableData();
      return { ...base, data, comparison: comparison ?? false } as CanvasObject;
    }
    case "chart": {
      const ckind = kind === "line" || kind === "pie" ? (kind as "line" | "pie") : "bar";
      const data = tableColumns !== undefined || tableRows !== undefined ? { columns: tableColumns ?? [], rows: tableRows ?? [] } : createChartTableData();
      return { ...base, kind: ckind, title: title ?? "", data } as CanvasObject;
    }
    case "test-object":
      return base as CanvasObject;
    default:
      throw new ProjectFormatError(`Unknown object type '${String(type)}' in SSON.`);
  }
}

function parseAsset(p: P): AssetMeta {
  const kindTok = p.next();
  if (kindTok.k !== "id") throw new ProjectFormatError(`Expected an asset kind in SSON, got '${kindTok.v}'.`);
  const kind = kindTok.v;
  if (kind !== "image" && kind !== "file" && kind !== "video" && kind !== "audio" && kind !== "pdf") {
    throw new ProjectFormatError(`Invalid asset kind '${kind}' in SSON.`);
  }
  const id = p.strValue();
  p.expectPunct("{");
  let name: string | undefined;
  let size: number | undefined;
  let mime: string | undefined;
  let ext: string | undefined;
  let thumbnail: string | undefined;
  while (p.peek() && !p.eatPunct("}")) {
    const f = p.next();
    if (f.k !== "id") throw new ProjectFormatError(`Expected an asset field in SSON, got '${f.v}'.`);
    if (f.v === "name") name = p.strValue();
    else if (f.v === "size") size = p.numValue();
    else if (f.v === "mime") mime = p.strValue();
    else if (f.v === "ext") ext = p.strValue();
    else if (f.v === "thumbnail") thumbnail = p.strValue();
    else throw new ProjectFormatError(`Unknown asset field '${f.v}' in SSON.`);
  }
  if (name === undefined || size === undefined || mime === undefined || ext === undefined) {
    throw new ProjectFormatError("Asset entry is missing name/size/mime/ext.");
  }
  return { id, kind: kind as AssetMeta["kind"], name, size, mime, ext, ...(thumbnail !== undefined && thumbnail !== "" ? { thumbnail } : {}) };
}

/**
 * Parse SSON text into the same Project model used by the JSON interchange.
 * Throws ProjectFormatError on malformed or future-version documents.
 */
export function projectFileFromSSON(raw: string): ProjectFile {
  const p = new P(tokenize(raw));
  p.expectId("project");
  p.expectPunct("{");

  let format = SSON_FORMAT_VERSION;
  let project: ProjectFile["project"] | undefined;
  let viewport: ViewportState | undefined;
  let objects: CanvasObject[] | undefined;
  const assets: AssetMeta[] = [];

  while (p.peek()) {
    const t = p.peek()!;
    if (t.k === "punct" && t.v === "}") {
      p.next();
      break;
    }
    if (t.k !== "id") throw new ProjectFormatError(`Unexpected token '${t.v}' in project block.`);
    if (t.v === "format") {
      p.next();
      format = p.numValue();
    } else if (t.v === "info") {
      p.next();
      p.expectPunct("{");
      project = parseInfo(p);
    } else if (t.v === "viewport") {
      p.next();
      p.expectPunct("{");
      viewport = parseViewport(p);
    } else if (t.v === "objects") {
      p.next();
      p.expectPunct("[");
      objects = [];
      while (!p.eatPunct("]")) objects.push(parseObject(p));
    } else if (t.v === "assets") {
      p.next();
      p.expectPunct("[");
      while (!p.eatPunct("]")) assets.push(parseAsset(p));
    } else {
      throw new ProjectFormatError(`Unknown SSON section '${t.v}'.`);
    }
  }

  if (!Number.isInteger(format) || format < 1) {
    throw new ProjectFormatError(`Unsupported SSON format version ${format}.`);
  }
  if (format > SSON_FORMAT_VERSION) {
    throw new ProjectFormatError(`Project was created by a newer version of Spatia (SSON format ${format}).`);
  }
  if (project === undefined || viewport === undefined || objects === undefined) {
    throw new ProjectFormatError("SSON project is missing a required section.");
  }

  return {
    formatVersion: PROJECT_FORMAT_VERSION,
    project,
    viewport,
    objects,
    assets,
  };
}