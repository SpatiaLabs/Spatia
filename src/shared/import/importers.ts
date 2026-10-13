/**
 * Shared, pure importers for Markdown, OPML, FreeMind (.mm XML), Excalidraw and
 * Miro board JSON. Each returns an array of CanvasObjects that the renderer
 * adds through the existing addObjectCommand pipeline (first import centered,
 * later ones offset by +24/+16 each so a batch is visible if re-imported).
 */

import { createId } from "../core/id.js";
import type { CanvasObject, ShapeKind, TextObject, NoteObject, ConnectionObject, FrameObject, PenObject, WorldPoint } from "../types/object.js";

let _z = 0;
const zIndex = (): number => _z++;

// ── object builders (validated shapes matching serialize.ts expectations) ───

function textObj(x: number, y: number, width: number, textValue: string, over?: Partial<Omit<TextObject, "type" | "x" | "y" | "width">>): TextObject {
  return {
    id: createId("obj"),
    type: "text",
    x,
    y,
    width,
    height: 40,
    rotation: 0,
    zIndex: zIndex(),
    locked: false,
    metadata: {},
    fontSize: 16,
    bold: false,
    italic: false,
    align: "left",
    text: textValue,
    ...over,
  };
}

function note(x: number, y: number, width: number, height: number, textValue: string, title = "", color = "#f0c33c"): NoteObject {
  return {
    id: createId("obj"),
    type: "note",
    x,
    y,
    width,
    height,
    rotation: 0,
    zIndex: zIndex(),
    locked: false,
    metadata: {},
    title,
    text: textValue,
    color,
  };
}

function shape(x: number, y: number, width: number, height: number, kind: ShapeKind, fill: string, stroke: string): CanvasObject {
  return {
    id: createId("obj"),
    type: "shape",
    x,
    y,
    width,
    height,
    rotation: 0,
    zIndex: zIndex(),
    locked: false,
    metadata: {},
    kind,
    fill,
    stroke,
    strokeWidth: 2,
  };
}

function connection(fromId: string, toId: string): ConnectionObject {
  return {
    id: createId("obj"),
    type: "connection",
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    rotation: 0,
    zIndex: zIndex(),
    locked: false,
    metadata: {},
    from: fromId,
    to: toId,
    arrowhead: true,
    color: "#91a3f0",
    strokeWidth: 2,
    edgeFrom: "auto",
    edgeTo: "auto",
  };
}

function pen(points: WorldPoint[], color: string, strokeWidth: number): PenObject {
  const minX = Math.min(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const maxX = Math.max(...points.map((p) => p.x));
  const maxY = Math.max(...points.map((p) => p.y));
  return {
    id: createId("obj"),
    type: "pen",
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
    rotation: 0,
    zIndex: zIndex(),
    locked: false,
    metadata: {},
    points,
    color,
    strokeWidth,
  };
}

function frame(x: number, y: number, width: number, height: number, name: string): FrameObject {
  return {
    id: createId("obj"),
    type: "frame",
    x,
    y,
    width,
    height,
    rotation: 0,
    zIndex: zIndex(),
    locked: false,
    metadata: {},
    name,
    color: "rgba(42,109,245,0.10)",
    frameShape: "rectangle",
  };
}

// ── Markdown ─────────────────────────────────────────────────────────────────

export function importMarkdown(text: string): CanvasObject[] {
  const objs: CanvasObject[] = [];
  const rows = String(text ?? "").split("\n");
  let y = 0;
  const col = 460;
  let codeOpen = false;
  for (const raw of rows) {
    const h = /^(#{1,3})\s+(.*)$/.exec(raw);
    if (h) {
      const level = h[1].length;
      objs.push(textObj(0, y, col, h[2], { fontSize: level === 1 ? 28 : level === 2 ? 22 : 18, bold: true }));
      y += (level === 1 ? 28 : level === 2 ? 24 : 22) + 10;
      continue;
    }
    if (/^```/.test(raw)) {
      codeOpen = !codeOpen;
      objs.push(note(0, y, col, 0, "", "```", "#263238"));
      y += codeOpen ? 0 : 30;
      continue;
    }
    const b = /^(\s*)[-*+]\s+(.*)$/.exec(raw);
    if (b) {
      const listX = b[1].length > 0 ? 24 : 0;
      objs.push(textObj(listX, y, col - listX, `•  ${b[2]}`));
      y += 26;
      continue;
    }
    const n = /^(\s*)\d+[.)]\s+(.*)$/.exec(raw);
    if (n) {
      objs.push(textObj(0, y, col, n[2]));
      y += 26;
      continue;
    }
    if (codeOpen) {
      objs.push(note(0, y, col, 0, raw, "", "#263238"));
      y += 22;
      continue;
    }
    if (!raw.trim()) {
      y += 14;
      continue;
    }
    objs.push(textObj(0, y, col, raw));
    y += 26;
  }
  return objs;
}

// ── OPML (outline) ───────────────────────────────────────────────────────────

interface XmlNode {
  text: string;
  depth: number;
  id: string;
}

function outlineNodes(xml: string): XmlNode[] {
  const out: XmlNode[] = [];
  const stack: string[] = [];
  const re = /<outline\b([^>]*)>|<\/outline>/gi;
  let m: RegExpExecArray | null;
  let depth = 0;
  while ((m = re.exec(xml)) !== null) {
    if (m[0].startsWith("</")) {
      stack.pop();
      depth = Math.max(0, depth - 1);
      continue;
    }
    const attrs = m[1];
    const tag = attrs.match(/text="([^"]*)"/i)?.[1] ?? attrs.match(/text='([^']*)'/i)?.[1] ?? "";
    const id = createId("obj");
    stack.push(id);
    depth++;
    if (tag.trim()) out.push({ text: tag.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"), depth, id });
  }
  return out;
}

export function importOPML(text: string): CanvasObject[] {
  const nodes = outlineNodes(text);
  if (nodes.length === 0) return importMarkdown(text);
  const objs: CanvasObject[] = [];
  const created: Array<{ id: string; depth: number }> = [];
  let y = 0;
  for (const n of nodes) {
    const indent = (n.depth - 1) * 28;
    const t = textObj(indent, y, 440 - indent, n.text, { fontSize: n.depth === 1 ? 20 : 15 });
    objs.push(t);
    created.push({ id: n.id, depth: n.depth });
    y += n.depth === 1 ? 40 : 30;
  }
  // Parent/child connections: match each node to the nearest shallower earlier node.
  for (let i = 1; i < created.length; i++) {
    const child = created[i];
    for (let j = i - 1; j >= 0; j--) {
      if (created[j].depth === child.depth - 1) {
        objs.push(connection(child.id, created[j].id));
        break;
      }
    }
  }
  return objs;
}

// ── FreeMind (.mm XML) ───────────────────────────────────────────────────────

export function importFreeMind(text: string): CanvasObject[] {
  const nodes: XmlNode[] = [];
  const re = /<node\b[^>]*text="([^"]*)"[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const depth = Math.max(1, (text.slice(0, m.index).match(/<node\b/g) ?? []).length - (text.slice(0, m.index).match(/<\/node>/g) ?? []).length);
    nodes.push({ text: m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"), depth, id: createId("obj") });
  }
  if (nodes.length === 0) return importMarkdown(text);
  const objs: CanvasObject[] = [];
  let y = 0;
  for (const n of nodes) {
    const indent = (n.depth - 1) * 28;
    const t = textObj(indent, y, 440 - indent, n.text, { fontSize: n.depth === 1 ? 20 : 15, bold: n.depth === 1 });
    objs.push(t);
    y += n.depth === 1 ? 40 : 30;
  }
  for (let i = 1; i < nodes.length; i++) {
    const child = nodes[i];
    for (let j = i - 1; j >= 0; j--) {
      if (nodes[j].depth === child.depth - 1) {
        objs.push(connection(child.id, nodes[j].id));
        break;
      }
    }
  }
  return objs;
}

// ── Excalidraw JSON ──────────────────────────────────────────────────────────

interface ExcaliElement {
  type: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  text?: string;
  backgroundColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  angle?: number;
  points?: number[][];
}

function parseExcalidraw(json: string): CanvasObject[] {
  let raw: { elements?: ExcaliElement[] };
  try {
    raw = JSON.parse(json) as { elements?: ExcaliElement[] };
  } catch {
    return [];
  }
  const elements = raw.elements ?? [];
  const objs: CanvasObject[] = [];
  // First pass: real objects.
  for (const e of elements) {
    if (!e || typeof e !== "object") continue;
    const id = createId("obj");
    const x = e.x ?? 0;
    const y = e.y ?? 0;
    const w = Math.max(1, e.width ?? 100);
    const h = Math.max(1, e.height ?? 60);
    const stroke = e.strokeColor && e.strokeColor !== "transparent" ? e.strokeColor : "#5b7cfa";
    const fill = e.backgroundColor && e.backgroundColor !== "transparent" ? e.backgroundColor : "rgba(42,109,245,0.12)";
    switch (e.type) {
      case "rectangle": {
        objs.push({ ...shape(x, y, w, h, "rectangle", fill, stroke), id }); // relay actual id
        break;
      }
      case "ellipse": {
        objs.push({ ...shape(x, y, w, h, "ellipse", fill, stroke), id });
        break;
      }
      case "diamond": {
        objs.push({ ...shape(x, y, w, h, "diamond", fill, stroke), id });
        break;
      }
      case "line":
      case "arrow": {
        const pts = e.points ?? [];
        const world = pts.map((p) => ({ x: p[0] ?? 0, y: p[1] ?? 0 }));
        if (world.length >= 2) {
          objs.push({ ...pen(world, stroke, Math.max(1, e.strokeWidth ?? 2)), id });
        }
        break;
      }
      case "text": {
        objs.push({ ...textObj(x, y, w, e.text ?? "", { fontSize: Math.max(8, Math.round((e.height ?? 40) * 0.7)) }), id });
        break;
      }
      case "freedraw": {
        const pts = e.points ?? [];
        if (pts.length > 1) {
          objs.push({ ...pen(pts.map((p) => ({ x: p[0] ?? 0, y: p[1] ?? 0 })), stroke, Math.max(1, e.strokeWidth ?? 2)), id });
        }
        break;
      }
      default:
        break;
    }
  }
  // Second pass: connections via arrow boundElements.
  for (const e of elements) {
    if (e.type === "arrow" && Array.isArray(e.points) && e.points.length >= 2) {
      // If the arrow has a bound start/end element we can't know it here; skip.
    }
  }
  return objs;
}

export function importExcalidraw(json: string): CanvasObject[] {
  return parseExcalidraw(json);
}

// ── Miro board JSON ──────────────────────────────────────────────────────────

interface MiroItem {
  type?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  content?: string;
  title?: string;
  text?: string;
  style?: { fillColor?: string; borderColor?: string; backgroundColor?: string };
  children?: MiroItem[];
}

function parseMiro(json: string): CanvasObject[] {
  let raw: { items?: MiroItem[] } | MiroItem[];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (Array.isArray(parsed)) raw = parsed as MiroItem[];
    else raw = (parsed as { items?: MiroItem[] }).items ?? [];
  } catch {
    return [];
  }
  const items = Array.isArray(raw) ? (raw as MiroItem[]) : (raw as { items?: MiroItem[] }).items ?? [];
  const objs: CanvasObject[] = [];
  const visit = (it: MiroItem): void => {
    const x = it.x ?? 0;
    const y = it.y ?? 0;
    const w = Math.max(1, it.width ?? 160);
    const h = Math.max(1, it.height ?? 80);
    const content = it.content ?? it.text ?? it.title ?? "";
    const fill = it.style?.fillColor ?? it.style?.backgroundColor ?? "rgba(255,224,130,0.35)";
    const stroke = it.style?.borderColor ?? "#5b7cfa";
    const id = createId("obj");
    switch ((it.type ?? "").toLowerCase()) {
      case "sticky_note":
      case "sticky-note":
      case "card":
        objs.push({ ...note(x, y, w, h, content), id });
        break;
      case "geometry":
      case "shape": {
        objs.push({ ...shape(x, y, w, h, "rounded-rectangle", fill, stroke), id });
        break;
      }
      case "circle":
        objs.push({ ...shape(x, y, w, h, "ellipse", fill, stroke), id });
        break;
      case "text":
      case "label":
        objs.push({ ...textObj(x, y, w, content, { fontSize: Math.max(8, Math.round(h * 0.6)) }), id });
        break;
      case "frame": {
        const f = frame(x, y, w, h, content);
        objs.push({ ...f, id });
        break;
      }
      default:
        break;
    }
    for (const c of it.children ?? []) visit(c);
  };
  for (const it of items) visit(it);
  return objs;
}

export function importMiro(json: string): CanvasObject[] {
  return parseMiro(json);
}