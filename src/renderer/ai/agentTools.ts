/**
 * Validated tool layer for the Local AI agent.
 *
 * The agent NEVER touches app internals directly. It only sees this closed set
 * of declarative tools, each of which validates its arguments and executes
 * through the existing Spatia command system (undo/redo, persistence and
 * selection integration come for free). No arbitrary JS, shell, filesystem or
 * Electron access is reachable from here — the only operations are reads of
 * project/selection state and the documented mutations, all through
 * `CommandManager.execute`.
 */

import type { ProjectStore } from "../project/projectStore.js";
import type { CommandManager } from "../command/commandManager.js";
import type { SelectionStore } from "../state/selectionStore.js";
import type {
  CanvasObject,
  NoteObject,
  ShapeKind,
  ShapeObject,
  TextObject,
} from "../../shared/types/object.js";
import { screenToWorld, type ViewportFrame } from "../../shared/geometry/viewport.js";
import {
  addObjectCommand,
  deleteObjectsCommand,
  moveObjectsCommand,
  resizeObjectsCommand,
  setPropsCommand,
  type PropChange,
} from "../command/commands.js";

export type ToolArgType = "string" | "number" | "boolean";

export interface ToolParamSpec {
  name: string;
  type: ToolArgType;
  required?: boolean;
  description: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  params: ToolParamSpec[];
}

export interface ToolResult {
  ok: boolean;
  text: string;
}

const HEX_FIELD = "a hex color like #ff8800 or a CSS color name like red";

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "get_canvas_state",
    description: "Read the canvas: every object's id, type, position and size, plus the viewport. Use before acting.",
    params: [],
  },
  {
    name: "get_selection",
    description: "Read which objects are currently selected.",
    params: [],
  },
  {
    name: "get_object",
    description: "Read one object's full details by id.",
    params: [{ name: "id", type: "string", required: true, description: "object id" }],
  },
  {
    name: "create_object",
    description:
      "Create a new object at a position. type is text, note or shape. For shape, kind is rectangle, rounded-rectangle, ellipse, diamond, triangle, line or arrow.",
    params: [
      { name: "type", type: "string", required: true, description: "text | note | shape" },
      { name: "kind", type: "string", description: "shape kind (for type=shape)" },
      { name: "x", type: "number", description: "left (world units; default viewport center)" },
      { name: "y", type: "number", description: "top (world units; default viewport center)" },
      { name: "width", type: "number", description: "box width (default per type)" },
      { name: "height", type: "number", description: "box height (default per type)" },
      { name: "text", type: "string", description: "text content (for text/note)" },
      { name: "color", type: "string", description: HEX_FIELD },
    ],
  },
  {
    name: "update_object",
    description:
      "Update one property of an object: x, y, width, height, rotation, zIndex, locked, text, title, url, fontSize, color, fill, stroke, strokeWidth, align.",
    params: [
      { name: "id", type: "string", required: true, description: "object id" },
      { name: "key", type: "string", required: true, description: "property name" },
      { name: "value", type: "string", required: true, description: "new value (as number for geometry)" },
    ],
  },
  {
    name: "move_object",
    description: "Move an object to an absolute world position (top-left corner).",
    params: [
      { name: "id", type: "string", required: true, description: "object id" },
      { name: "x", type: "number", required: true, description: "new left" },
      { name: "y", type: "number", required: true, description: "new top" },
    ],
  },
  {
    name: "delete_object",
    description: "Delete an object.",
    params: [{ name: "id", type: "string", required: true, description: "object id" }],
  },
  {
    name: "add_text",
    description: "Add a text object with the given content at a position.",
    params: [
      { name: "text", type: "string", required: true, description: "text content" },
      { name: "x", type: "number", description: "left (world units; default viewport center)" },
      { name: "y", type: "number", description: "top (world units; default viewport center)" },
      { name: "fontSize", type: "number", description: "font size in px (default 24)" },
    ],
  },
  {
    name: "set_color",
    description: "Set the color of an object (fill for shapes, stroke color for pen, card color for notes). Text has no color. Uses the current selection when id is omitted.",
    params: [
      { name: "color", type: "string", required: true, description: HEX_FIELD },
      { name: "id", type: "string", description: "object id (default: selected object)" },
    ],
  },
  {
    name: "set_size",
    description: "Resize an object (minimum 4 units). Uses the current selection when id is omitted. Pen strokes cannot be resized.",
    params: [
      { name: "id", type: "string", description: "object id (default: selected object)" },
      { name: "width", type: "number", description: "new width" },
      { name: "height", type: "number", description: "new height" },
    ],
  },
  {
    name: "select_object",
    description: "Select an object by id.",
    params: [{ name: "id", type: "string", required: true, description: "object id" }],
  },
  {
    name: "clear_selection",
    description: "Clear the current selection.",
    params: [],
  },
];

const TEXT_KEYS = new Set(["text", "title", "url", "color", "fill", "stroke", "align"]);
const NUM_KEYS = new Set([
  "x",
  "y",
  "width",
  "height",
  "rotation",
  "zIndex",
  "strokeWidth",
  "fontSize",
]);
const BOOL_KEYS = new Set(["locked", "bold", "italic"]);
const SHAPE_KINDS: ShapeKind[] = [
  "rectangle",
  "rounded-rectangle",
  "ellipse",
  "diamond",
  "triangle",
  "line",
  "arrow",
];

function parseBool(v: unknown): boolean | null {
  if (v === true) return true;
  if (v === false) return false;
  if (v === 1 || v === "1" || v === "true") return true;
  if (v === 0 || v === "0" || v === "false") return false;
  return null;
}

function parseNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function isValidColor(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const probe = new Option().style;
  probe.color = v;
  return !!probe.color;
}

function fail(text: string): ToolResult {
  return { ok: false, text };
}

function firstLine(s: string): string {
  const line = String(s || "").split("\n")[0] ?? "";
  return line.length > 40 ? line.slice(0, 40) + "…" : line;
}

export class AgentTools {
  constructor(
    private readonly project: ProjectStore,
    private readonly commands: CommandManager,
    private readonly selection: SelectionStore,
    private readonly getFrame: () => ViewportFrame
  ) {}

  toolsMeta(): ToolSpec[] {
    return TOOL_SPECS;
  }

  /** Execute a validated tool. Never executes anything not in TOOL_SPECS. */
  async run(name: string, args: Record<string, unknown> | null | undefined): Promise<ToolResult> {
    const spec = TOOL_SPECS.find((t) => t.name === name);
    if (!spec) return fail(`Unknown tool "${name}".`);
    const raw: Record<string, unknown> = args && typeof args === "object" ? args : {};
    for (const p of spec.params) {
      if (p.required && (raw[p.name] === undefined || raw[p.name] === null || raw[p.name] === "")) {
        return fail(`Tool "${name}" is missing required argument "${p.name}".`);
      }
    }
    try {
      switch (name) {
        case "get_canvas_state":
          return this.getCanvasState();
        case "get_selection":
          return this.getSelection();
        case "get_object":
          return this.getObject(String(raw.id));
        case "create_object":
          return this.createObject(raw);
        case "update_object":
          return this.updateObject(raw);
        case "move_object":
          return this.moveObject(raw);
        case "delete_object":
          return this.deleteObject(raw);
        case "add_text":
          return this.addText(raw);
        case "set_color":
          return this.setColor(raw);
        case "set_size":
          return this.setSize(raw);
        case "select_object":
          return this.selectObject(raw);
        case "clear_selection":
          this.selection.clear();
          return { ok: true, text: "Selection cleared." };
        default:
          return fail(`Unknown tool "${name}".`);
      }
    } catch (err) {
      return fail("Tool error: " + (err instanceof Error ? err.message : String(err)));
    }
  }

  // ------------------------------------------------------------ helpers

  private centerWorld(): { x: number; y: number } {
    const f = this.getFrame();
    return screenToWorld({ x: f.originWidth / 2, y: f.originHeight / 2 }, f);
  }

  private requireObject(id: string): CanvasObject | null {
    const obj = this.project.getObject(String(id));
    return obj ?? null;
  }

  private objInfo(obj: CanvasObject): string {
    const tags = Array.isArray(obj.metadata?.tags) ? (obj.metadata.tags as string[]).join(",") : "";
    const extra: string[] = [];
    switch (obj.type) {
      case "text":
        extra.push(`"${firstLine(obj.text)}"`, `font size ${obj.fontSize}`);
        break;
      case "note":
        extra.push(`"${firstLine(obj.text)}"`);
        extra.push(obj.color ? `color ${obj.color}` : "");
        break;
      case "shape":
        extra.push(obj.kind, obj.fill, `stroke ${obj.stroke} ${obj.strokeWidth}`);
        break;
      case "url":
        extra.push(obj.url);
        break;
      case "pen":
        extra.push(`color ${obj.color}`, `width ${obj.strokeWidth}`);
        break;
      default:
        break;
    }
    const parts = [
      `${obj.id}`,
      `type ${obj.type}`,
      `pos (${round(obj.x)}, ${round(obj.y)})`,
      `${round(obj.width)}x${round(obj.height)}`,
      ...extra.filter(Boolean),
    ];
    if (tags) parts.push(`tags ${tags}`);
    if (obj.locked) parts.push("locked");
    return parts.join(" | ");
  }

  private getCanvasState(): ToolResult {
    const meta = this.project.getMeta();
    const objs = this.project.getObjectsSorted();
    if (objs.length === 0) {
      return {
        ok: true,
        text: `Project "${meta.name || "Untitled"}" has no objects yet.`,
      };
    }
    const rows = objs.map((o) => this.objInfo(o));
    return {
      ok: true,
      text: `Project "${meta.name || "Untitled"}" — ${objs.length} object(s):\n` + rows.join("\n"),
    };
  }

  private getSelection(): ToolResult {
    const ids = this.selection.get();
    if (ids.length === 0) return { ok: true, text: "Nothing is selected." };
    const rows = ids
      .map((id) => this.project.getObject(id))
      .filter((o): o is CanvasObject => !!o)
      .map((o) => this.objInfo(o));
    return {
      ok: true,
      text: `Selection (${ids.length}):\n` + rows.join("\n") || "Selection exists but objects are missing.",
    };
  }

  private getObject(id: string): ToolResult {
    if (!id) return fail("get_object requires an id.");
    const obj = this.requireObject(id);
    if (!obj) return fail(`No object with id "${id}". Run get_canvas_state to see valid ids.`);
    return { ok: true, text: this.objInfo(obj) };
  }

  private createObject(raw: Record<string, unknown>): ToolResult {
    const type = String(raw.type || "");
    if (type !== "text" && type !== "note" && type !== "shape") {
      return fail('create_object type must be "text", "note" or "shape".');
    }
    const center = this.centerWorld();
    const x = parseNumber(raw.x) ?? center.x;
    const y = parseNumber(raw.y) ?? center.y;
    const width = Math.max(4, parseNumber(raw.width) ?? 0);
    const height = Math.max(4, parseNumber(raw.height) ?? 0);
    const color = typeof raw.color === "string" && isValidColor(raw.color) ? raw.color : undefined;
    if (raw.color !== undefined && !color) return fail(`Invalid color "${raw.color}".`);

    let obj: CanvasObject;
    if (type === "text") {
      obj = this.makeText(x, y, String(raw.text ?? ""), width || 200, height || 120, parseNumber(raw.fontSize) ?? 24);
    } else if (type === "note") {
      obj = this.makeNote(x, y, String(raw.text ?? ""), color, width || 180, height || 140);
    } else {
      const kind = raw.kind ? String(raw.kind) : "rectangle";
      if (!SHAPE_KINDS.includes(kind as ShapeKind)) {
        return fail(`Unknown shape kind "${kind}".`);
      }
      obj = this.makeShape(kind as ShapeKind, x, y, width || 160, height || 100, color);
    }
    this.commands.execute(addObjectCommand(this.project, obj));
    this.selection.setIds([obj.id]);
    return { ok: true, text: `Created ${obj.type} object "${obj.id}".` };
  }

  private updateObject(raw: Record<string, unknown>): ToolResult {
    const id = String(raw.id || "");
    const key = String(raw.key || "");
    const obj = id ? this.requireObject(id) : (this.selection.get().length === 1 ? this.requireObject(this.selection.get()[0]) : null);
    if (!obj) return fail(`Object "${id || "(selection)"}" not found.`);
    if (obj.locked && key !== "locked") return fail(`Object "${obj.id}" is locked.`);
    if (!TEXT_KEYS.has(key) && !NUM_KEYS.has(key) && !BOOL_KEYS.has(key)) {
      return fail(`Key "${key}" is not editable.`);
    }
    let next: unknown;
    if (NUM_KEYS.has(key)) {
      const n = parseNumber(raw.value);
      if (n === null) return fail(`Value for "${key}" must be a number.`);
      next = key === "rotation" ? n % 360 : n;
    } else if (BOOL_KEYS.has(key)) {
      const b = parseBool(raw.value);
      if (b === null) return fail(`Value for "${key}" must be true or false.`);
      next = b;
    } else {
      const s = String(raw.value ?? "");
      if (key === "align" && s !== "left" && s !== "center" && s !== "right") {
        return fail('align must be "left", "center" or "right".');
      }
      if ((key === "fill" || key === "stroke" || key === "color") && !isValidColor(s)) {
        return fail(`Invalid color "${s}".`);
      }
      next = s;
    }
    const before = (obj as unknown as Record<string, unknown>)[key];
    if (before === next) return { ok: true, text: `"${key}" already ${next}.` };
    if (key === "width" || key === "height") {
      const b = { id: obj.id, x: obj.x, y: obj.y, width: obj.width, height: obj.height };
      const a = {
        id: obj.id,
        x: obj.x,
        y: obj.y,
        width: key === "width" ? Math.max(4, next as number) : obj.width,
        height: key === "height" ? Math.max(4, next as number) : obj.height,
      };
      this.commands.execute(resizeObjectsCommand(this.project, [b], [a]));
      return { ok: true, text: `Set ${obj.id} ${key} to ${next}.` };
    }
    const change: PropChange = { id: obj.id, key, before, after: next };
    this.commands.execute(setPropsCommand(this.project, [change]));
    return { ok: true, text: `Set ${obj.id} ${key} to ${String(next)}.` };
  }

  private moveObject(raw: Record<string, unknown>): ToolResult {
    const id = String(raw.id || "");
    const x = parseNumber(raw.x);
    const y = parseNumber(raw.y);
    if (x === null || y === null) return fail("move_object needs numeric x and y.");
    const obj = this.requireObject(id);
    if (!obj) return fail(`Object "${id}" not found.`);
    if (obj.locked) return fail(`Object "${id}" is locked.`);
    if (obj.type === "pen") return fail("Pen strokes cannot be moved.");
    if (obj.type === "connection") return fail("Connections move with their endpoints.");
    if (obj.x === x && obj.y === y) return { ok: true, text: `${id} is already at (${x}, ${y}).` };
    this.commands.execute(
      moveObjectsCommand(
        this.project,
        [{ id, x: obj.x, y: obj.y }],
        [{ id, x, y }]
      )
    );
    this.selection.setIds([id]);
    return { ok: true, text: `Moved ${id} to (${x}, ${y}).` };
  }

  private deleteObject(raw: Record<string, unknown>): ToolResult {
    const id = String(raw.id || "");
    const obj = this.requireObject(id);
    if (!obj) return fail(`Object "${id}" not found.`);
    if (obj.locked) return fail(`Object "${id}" is locked.`);
    this.commands.execute(deleteObjectsCommand(this.project, [id]));
    return { ok: true, text: `Deleted object ${id} (${obj.type}).` };
  }

  private addText(raw: Record<string, unknown>): ToolResult {
    const text = String(raw.text ?? "");
    if (!text.trim()) return fail("add_text needs some text content.");
    const center = this.centerWorld();
    const x = parseNumber(raw.x) ?? center.x;
    const y = parseNumber(raw.y) ?? center.y;
    const fontSize = Math.max(8, Math.min(300, parseNumber(raw.fontSize) ?? 24));
    const obj = this.makeText(x, y, text, 200, 120, fontSize);
    this.commands.execute(addObjectCommand(this.project, obj));
    this.selection.setIds([obj.id]);
    return { ok: true, text: `Added text "${text.replace(/\n/g, " ")}".` };
  }

  private setColor(raw: Record<string, unknown>): ToolResult {
    const color = String(raw.color ?? "");
    if (!isValidColor(color)) return fail(`Invalid color "${color}".`);
    const id = raw.id !== undefined && raw.id !== null && raw.id !== "" ? String(raw.id) : this.targetSelectedId();
    if (!id) return fail("No object selected — pass an id.");
    const obj = this.requireObject(id);
    if (!obj) return fail(`Object "${id}" not found.`);
    if (obj.locked) return fail(`Object "${id}" is locked.`);
    let key: string;
    switch (obj.type) {
      case "shape":
        key = "fill";
        break;
      case "pen":
      case "frame":
      case "connection":
        key = "color";
        break;
      case "note":
        key = "color";
        break;
      default:
        return fail(`"${obj.type}" objects have no color field.`);
    }
    const before = (obj as unknown as Record<string, unknown>)[key];
    if (before === color) return { ok: true, text: `${id} is already ${color}.` };
    this.commands.execute(setPropsCommand(this.project, [{ id, key, before, after: color }]));
    return { ok: true, text: `Set ${id} ${key} to ${color}.` };
  }

  private setSize(raw: Record<string, unknown>): ToolResult {
    const w = raw.width !== undefined ? parseNumber(raw.width) : null;
    const h = raw.height !== undefined ? parseNumber(raw.height) : null;
    if (w === null && h === null) return fail("set_size needs width and/or height.");
    const id = raw.id !== undefined && raw.id !== null && raw.id !== "" ? String(raw.id) : this.targetSelectedId();
    if (!id) return fail("No object selected — pass an id.");
    const obj = this.requireObject(id);
    if (!obj) return fail(`Object "${id}" not found.`);
    if (obj.locked) return fail(`Object "${id}" is locked.`);
    if (obj.type === "pen") return fail("Pen strokes cannot be resized.");
    const before = { id, x: obj.x, y: obj.y, width: obj.width, height: obj.height };
    const after = {
      id,
      x: obj.x,
      y: obj.y,
      width: w === null ? obj.width : Math.max(4, w),
      height: h === null ? obj.height : Math.max(4, h),
    };
    this.commands.execute(resizeObjectsCommand(this.project, [before], [after]));
    return { ok: true, text: `Resized ${id} to ${after.width}x${after.height}.` };
  }

  private selectObject(raw: Record<string, unknown>): ToolResult {
    const id = String(raw.id || "");
    const obj = this.requireObject(id);
    if (!obj) return fail(`Object "${id}" not found.`);
    this.selection.setIds([id]);
    return { ok: true, text: `Selected ${id} (${obj.type}).` };
  }

  private targetSelectedId(): string {
    const ids = this.selection.get();
    return ids.length === 1 ? ids[0] : "";
  }

  // ------------------------------------------------------------ builders

  private makeText(x: number, y: number, text: string, width: number, height: number, fontSize: number): TextObject {
    return {
      type: "text",
      id: "obj_" + crypto.randomUUID(),
      x,
      y,
      width,
      height,
      rotation: 0,
      zIndex: this.project.nextZIndex(),
      locked: false,
      metadata: {},
      text,
      fontSize,
      bold: false,
      italic: false,
      align: "left",
    };
  }

  private makeNote(x: number, y: number, text: string, color: string | undefined, width: number, height: number): NoteObject {
    return {
      type: "note",
      id: "obj_" + crypto.randomUUID(),
      x,
      y,
      width,
      height,
      rotation: 0,
      zIndex: this.project.nextZIndex(),
      locked: false,
      metadata: {},
      title: "",
      text,
      color: color ?? "#f0c33c",
    };
  }

  private makeShape(kind: ShapeKind, x: number, y: number, width: number, height: number, color: string | undefined): ShapeObject {
    const isLine = kind === "line" || kind === "arrow";
    return {
      type: "shape",
      id: "obj_" + crypto.randomUUID(),
      x,
      y,
      width,
      height,
      rotation: 0,
      zIndex: this.project.nextZIndex(),
      locked: false,
      metadata: {},
      kind,
      fill: isLine ? "" : color ?? "#ffffff",
      stroke: color ?? "#000000",
      strokeWidth: 2,
    };
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}