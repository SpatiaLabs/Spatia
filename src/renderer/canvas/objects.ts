import type { CanvasObject, TextObject, PenObject, UrlObject, AssetMeta } from "../../shared/types/object.js";
import type { ViewportFrame, Point, Rect } from "../../shared/geometry/viewport.js";
import { worldToScreen, isRectVisible, screenToWorld } from "../../shared/geometry/viewport.js";
import { selectionBounds, HANDLES, handleWorld } from "../../shared/geometry/selection.js";
import {
  connectionEndpoints,
  groupBounds,
} from "../../shared/geometry/workspace.js";

const STROKE = "rgba(91,124,250,0.5)";
const SELECTION = "#5b7cfa";
const HANDLE = "#5b7cfa";
const TEXT_FILL = "#e8eaed";
const NOTE_TITLE = "#23272d";
const NOTE_BODY = "#2b2f36";

/** Draw callbacks the renderer can use to resolve per-type resources. */
export interface ObjectDrawContext {
  /** Resolve an image element for an image asset id (null if not loaded). */
  imageOf(assetId: string): HTMLImageElement | null;
  objLabel(assetId: string): string;
  assetKindOf(assetId: string): AssetMeta["kind"] | undefined;
  assetExtOf(assetId: string): string | undefined;
  objectById(id: string): CanvasObject | undefined;
}

/**
 * Draw all objects that intersect the visible viewport, culling the rest, along
 * with a selection overlay for the selected set. The selected set is passed in
 * so the overlay can draw a union bounding box with resize handles.
 *
 * `objects` must already be sorted in ascending z-order (bottom-most first);
 * the caller supplies `ProjectStore.getObjectsSorted()` so we never re-sort
 * the whole array per frame.
 */
export function drawObjects(
  ctx: CanvasRenderingContext2D,
  frame: ViewportFrame,
  objects: readonly CanvasObject[],
  selected: ReadonlySet<string>,
  drawCtx: ObjectDrawContext
): void {
  for (const obj of objects) {
    if (!isRectVisible({ x: obj.x, y: obj.y, width: obj.width, height: obj.height }, frame)) {
      continue;
    }
    drawObject(ctx, frame, obj, drawCtx);
  }
  if (selected.size > 0) {
    drawSelection(ctx, frame, objects, selected, drawCtx);
  }
}

function drawObject(
  ctx: CanvasRenderingContext2D,
  frame: ViewportFrame,
  obj: CanvasObject,
  drawCtx: ObjectDrawContext
): void {
  switch (obj.type) {
    case "text":
      drawText(ctx, frame, obj);
      break;
    case "note":
      drawNote(ctx, frame, obj);
      break;
    case "image":
      drawImageObj(ctx, frame, obj, drawCtx.imageOf(obj.assetId));
      break;
    case "file":
      drawFile(ctx, frame, obj, drawCtx.objLabel(obj.assetId), drawCtx.assetKindOf(obj.assetId), drawCtx.assetExtOf(obj.assetId));
      break;
    case "url":
      drawUrl(ctx, frame, obj);
      break;
    case "connection":
      drawConnection(ctx, frame, obj, drawCtx);
      break;
    case "group":
      drawGroup(ctx, frame, obj, drawCtx);
      break;
    case "frame":
      drawFrame(ctx, frame, obj);
      break;
    case "pen":
      drawPen(ctx, frame, obj);
      break;
    default:
      drawTestObject(ctx, frame, obj);
      break;
  }
}

function drawObjectFrame(
  _ctx: CanvasRenderingContext2D,
  frame: ViewportFrame,
  obj: { x: number; y: number; width: number; height: number; rotation: number }
): { p: Point; w: number; h: number } {
  const p = worldToScreen({ x: obj.x, y: obj.y }, frame);
  const w = obj.width * frame.zoom;
  const h = obj.height * frame.zoom;
  return { p, w, h };
}

function drawTestObject(ctx: CanvasRenderingContext2D, frame: ViewportFrame, obj: CanvasObject): void {
  const { p, w, h } = drawObjectFrame(ctx, frame, obj);
  ctx.save();
  ctx.translate(p.x + w / 2, p.y + h / 2);
  ctx.rotate(obj.rotation);
  ctx.beginPath();
  roundRect(ctx, -w / 2, -h / 2, w, h, corner(w, h));
  ctx.fillStyle = "rgba(91,124,250,0.14)";
  ctx.fill();
  ctx.strokeStyle = STROKE;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

function drawText(ctx: CanvasRenderingContext2D, frame: ViewportFrame, obj: TextObject): void {
  const { p, w, h } = drawObjectFrame(ctx, frame, obj);
  ctx.save();
  ctx.translate(p.x + w / 2, p.y + h / 2);
  ctx.rotate(obj.rotation);
  const fontPx = Math.max(1, obj.fontSize * frame.zoom);
  const weight = obj.bold ? "bold " : "";
  const style = obj.italic ? "italic " : "";
  ctx.font = `${style}${weight}${fontPx}px ${FONT}`;
  ctx.textBaseline = "top";
  ctx.fillStyle = TEXT_FILL;
  const textAlign = obj.align;
  const pad = 6;
  const maxWidth = Math.max(0, w - pad * 2);
  const lines = wrapText(ctx, obj.text || "", maxWidth);
  const lineHeight = fontPx * 1.25;
  let cursorY = -h / 2 + pad;
  const alignMap = { left: "left", center: "center", right: "right" } as const;
  const a = alignMap[textAlign] ?? "left";
  ctx.textAlign = a;
  for (let i = 0; i < lines.length; i++) {
    const x = a === "left" ? -w / 2 + pad : a === "right" ? w / 2 - pad : 0;
    if (cursorY + lineHeight > h / 2 - pad) break;
    ctx.fillText(lines[i], x, cursorY);
    cursorY += lineHeight;
  }
  ctx.restore();
}

function drawNote(ctx: CanvasRenderingContext2D, frame: ViewportFrame, obj: Extract<CanvasObject, { type: "note" }>): void {
  const { p, w, h } = drawObjectFrame(ctx, frame, obj);
  ctx.save();
  ctx.translate(p.x + w / 2, p.y + h / 2);
  ctx.rotate(obj.rotation);
  ctx.beginPath();
  roundRect(ctx, -w / 2, -h / 2, w, h, corner(w, h));
  ctx.fillStyle = obj.color;
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.25)";
  ctx.lineWidth = 1;
  ctx.stroke();
  const pad = Math.max(4, w * 0.06);
  const titlePx = Math.max(8, w * 0.09);
  const bodyPx = Math.max(8, w * 0.07);
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  if (obj.title) {
    ctx.fillStyle = NOTE_TITLE;
    ctx.font = `600 ${titlePx}px ${FONT}`;
    ctx.fillText(clipText(ctx, obj.title, w - pad * 2), -w / 2 + pad, -h / 2 + pad);
  }
  ctx.fillStyle = NOTE_BODY;
  ctx.font = `${bodyPx}px ${FONT}`;
  const startY = -h / 2 + pad + (obj.title ? titlePx * 1.3 : 0);
  const lines = wrapText(ctx, obj.text || "", w - pad * 2);
  const lineH = bodyPx * 1.25;
  let y = startY;
  for (const line of lines) {
    if (y + lineH > h / 2 - pad) break;
    ctx.fillText(line, -w / 2 + pad, y);
    y += lineH;
  }
  ctx.restore();
}

function drawImageObj(
  ctx: CanvasRenderingContext2D,
  frame: ViewportFrame,
  obj: Extract<CanvasObject, { type: "image" }>,
  img: HTMLImageElement | null
): void {
  const { p, w, h } = drawObjectFrame(ctx, frame, obj);
  ctx.save();
  ctx.translate(p.x + w / 2, p.y + h / 2);
  ctx.rotate(obj.rotation);
  ctx.beginPath();
  roundRect(ctx, -w / 2, -h / 2, w, h, corner(w, h));
  ctx.clip();
  if (img && img.complete && img.naturalWidth > 0) {
    const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
    const dw = img.naturalWidth * scale;
    const dh = img.naturalHeight * scale;
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
  } else {
    ctx.fillStyle = "rgba(91,124,250,0.12)";
    ctx.fill();
  }
  ctx.restore();
  // Border so unloaded/placeholder images are still visible.
  ctx.save();
  ctx.translate(p.x + w / 2, p.y + h / 2);
  ctx.rotate(obj.rotation);
  ctx.beginPath();
  roundRect(ctx, -w / 2, -h / 2, w, h, corner(w, h));
  ctx.strokeStyle = "rgba(91,124,250,0.4)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

function drawFile(
  ctx: CanvasRenderingContext2D,
  frame: ViewportFrame,
  obj: Extract<CanvasObject, { type: "file" }>,
  label: string,
  kind: AssetMeta["kind"] | undefined,
  ext: string | undefined
): void {
  const { p, w, h } = drawObjectFrame(ctx, frame, obj);
  ctx.save();
  ctx.translate(p.x + w / 2, p.y + h / 2);
  ctx.rotate(obj.rotation);
  ctx.beginPath();
  roundRect(ctx, -w / 2, -h / 2, w, h, corner(w, h));
  ctx.fillStyle = "rgba(91,124,250,0.10)";
  ctx.fill();
  ctx.strokeStyle = "rgba(91,124,250,0.45)";
  ctx.lineWidth = 1;
  ctx.stroke();

  const kindColor = fileKindColor(kind);
  const iconGlyph = fileKindGlyph(kind);
  const pad = Math.max(6, w * 0.05);

  // Type-tinted icon box pinned to the top of the card.
  const iconW = Math.max(26, Math.min(w * 0.42, 44 * frame.zoom));
  const iconH = iconW;
  const iconX = -iconW / 2;
  const iconY = -h / 2 + pad;
  ctx.beginPath();
  roundRect(ctx, iconX, iconY, iconW, iconH, corner(iconW, iconH) * 0.45);
  ctx.fillStyle = kindColor + "2e";
  ctx.fill();
  ctx.strokeStyle = kindColor;
  ctx.lineWidth = 1.4;
  ctx.stroke();
  if (iconGlyph) {
    const glyphPx = Math.max(11, iconW * 0.45);
    ctx.fillStyle = "#e8eaed";
    ctx.font = `600 ${glyphPx}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(iconGlyph, 0, iconY + iconH / 2);
  }

  // Text block below the icon: filename (primary) + file type (secondary).
  const textTop = iconY + iconH + pad;
  const textW = Math.max(10, w - pad * 2);
  const fontSize = Math.max(6, Math.min(13, w * 0.1)) * frame.zoom;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  ctx.fillStyle = TEXT_FILL;
  ctx.font = `600 ${fontSize}px ${FONT}`;
  ctx.fillText(clipText(ctx, baseName(label || "File"), textW), 0, textTop);

  const typeLabel = fileTypeLabel(kind, ext);
  ctx.fillStyle = "rgba(232,234,237,0.55)";
  ctx.font = `400 ${Math.max(5, fontSize * 0.72)}px ${FONT}`;
  ctx.fillText(clipText(ctx, typeLabel, textW), 0, textTop + fontSize * 1.3);
  ctx.restore();
}

/** Reduce a label to its file name, defensively stripping any path. */
function baseName(label: string): string {
  const parts = label.split(/[\\/]/);
  return parts[parts.length - 1] || label;
}

/** Short human-friendly type label for a local file card. */
function fileTypeLabel(kind: AssetMeta["kind"] | undefined, ext: string | undefined): string {
  const e = ext ? ext.toUpperCase() : "";
  switch (kind) {
    case "pdf":
      return "PDF Document";
    case "video":
      return "Video";
    case "audio":
      return "Audio";
    case "image":
      return "Image";
    default:
      return e ? `${e} File` : "File";
  }
}

function drawUrl(ctx: CanvasRenderingContext2D, frame: ViewportFrame, obj: UrlObject): void {
  const { p, w, h } = drawObjectFrame(ctx, frame, obj);
  ctx.save();
  ctx.translate(p.x + w / 2, p.y + h / 2);
  ctx.rotate(obj.rotation);
  ctx.beginPath();
  roundRect(ctx, -w / 2, -h / 2, w, h, corner(w, h));
  ctx.fillStyle = "rgba(45,150,90,0.12)";
  ctx.fill();
  ctx.strokeStyle = "rgba(61,220,132,0.6)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const pad = Math.max(6, w * 0.06);
  const iconPx = Math.max(16, Math.min(26, w * 0.16)) * frame.zoom;
  const titlePx = Math.max(10, Math.min(15, w * 0.1)) * frame.zoom;
  const urlPx = Math.max(8, Math.min(11, w * 0.07)) * frame.zoom;
  const leftX = -w / 2 + pad;

  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  // Link glyph (simple chain circle).
  ctx.beginPath();
  ctx.arc(leftX + iconPx * 0.5, -h / 2 + pad + iconPx * 0.5, iconPx * 0.4, 0, Math.PI * 2);
  ctx.fillStyle = "#3ddc84";
  ctx.fill();
  ctx.fillStyle = "#121417";
  ctx.font = `700 ${iconPx * 0.5}px ${FONT}`;
  ctx.textAlign = "center";
  ctx.fillText("⇱", leftX + iconPx * 0.5, -h / 2 + pad + iconPx * 0.5 - iconPx * 0.3);

  const textLeft = leftX + iconPx + pad;
  const maxTextW = Math.max(10, w - pad * 3 - iconPx);
  ctx.textAlign = "left";
  if (obj.title) {
    ctx.fillStyle = TEXT_FILL;
    ctx.font = `600 ${titlePx}px ${FONT}`;
    ctx.fillText(clipText(ctx, obj.title, maxTextW), textLeft, -h / 2 + pad);
  }
  ctx.fillStyle = "rgba(232,234,237,0.55)";
  ctx.font = `400 ${urlPx}px ${FONT}`;
  ctx.fillText(clipText(ctx, obj.url || "", maxTextW, true), textLeft, -h / 2 + pad + titlePx * 1.3);
  ctx.restore();
}

function fileKindColor(kind: AssetMeta["kind"] | undefined): string {
  switch (kind) {
    case "pdf":
      return "#f2685c";
    case "video":
      return "#9b6cf0";
    case "audio":
      return "#3ddc84";
    case "image":
      return "#5b7cfa";
    default:
      return "#91a3f0";
  }
}

function fileKindGlyph(kind: AssetMeta["kind"] | undefined): string {
  switch (kind) {
    case "pdf":
      return "PDF";
    case "video":
      return "▶";
    case "audio":
      return "♪";
    case "image":
      return "▨";
    default:
      return "▤";
  }
}

// -------- Connection / Group / Frame drawing --------

function drawConnection(
  ctx: CanvasRenderingContext2D,
  frame: ViewportFrame,
  conn: Extract<CanvasObject, { type: "connection" }>,
  drawCtx: ObjectDrawContext
): void {
  const fromObj = drawCtx.objectById(conn.from);
  const toObj = drawCtx.objectById(conn.to);
  const { start, end } = connectionEndpoints(conn, fromObj, toObj);
  const sp = worldToScreen(start, frame);
  const ep = worldToScreen(end, frame);
  const color = conn.color || "#91a3f0";

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, (conn.strokeWidth || 2) * frame.zoom);
  ctx.setLineDash([6, 4]);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(sp.x, sp.y);
  ctx.lineTo(ep.x, ep.y);
  ctx.stroke();
  ctx.setLineDash([]);

  if (conn.arrowhead) {
    const angle = Math.atan2(ep.y - sp.y, ep.x - sp.x);
    const arrowLen = Math.max(10, 12 * frame.zoom);
    const arrowAngle = Math.PI / 6;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(ep.x, ep.y);
    ctx.lineTo(ep.x - arrowLen * Math.cos(angle - arrowAngle), ep.y - arrowLen * Math.sin(angle - arrowAngle));
    ctx.lineTo(ep.x - arrowLen * Math.cos(angle + arrowAngle), ep.y - arrowLen * Math.sin(angle + arrowAngle));
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** Control point for a subtle hand-drawn quadratic between two screen points. */
export function handDrawnControl(a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  if (len < 1) return { x: mx, y: my };
  // Perpendicular unit vector, nudged toward -x by a fixed ratio of y so the
  // bend leans consistently one way (sign of dy picks the side).
  const px = -dy / len;
  const py = dx / len;
  const bend = Math.min(0.18 * len, 24);
  return { x: mx + px * bend, y: my + py * bend };
}

function drawPen(
  ctx: CanvasRenderingContext2D,
  frame: ViewportFrame,
  pen: PenObject
): void {
  if (!pen.points || pen.points.length === 0) return;
  const pts = pen.points.map((p) => worldToScreen(p, frame));
  ctx.save();
  ctx.strokeStyle = pen.color || "#e8eaed";
  ctx.lineWidth = Math.max(1, (pen.strokeWidth || 3) * frame.zoom);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
  ctx.restore();
}

function drawGroup(
  ctx: CanvasRenderingContext2D,
  frame: ViewportFrame,
  group: Extract<CanvasObject, { type: "group" }>,
  drawCtx: ObjectDrawContext
): void {
  const b = groupBounds(group, group.memberIds.map((id) => drawCtx.objectById(id)).filter((o): o is CanvasObject => o !== undefined));
  const p = worldToScreen({ x: b.x, y: b.y }, frame);
  const w = b.width * frame.zoom;
  const h = b.height * frame.zoom;
  ctx.save();
  ctx.strokeStyle = "rgba(91,212,250,0.35)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  roundRect(ctx, p.x, p.y, w, h, 8);
  ctx.stroke();
  ctx.setLineDash([]);
  if (group.name) {
    const fontSize = Math.max(8, 11 * frame.zoom);
    ctx.font = `500 ${fontSize}px ${FONT}`;
    ctx.fillStyle = "rgba(91,212,250,0.7)";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(group.name, p.x + 6, p.y - 4);
  }
  ctx.restore();
}

function drawFrame(
  ctx: CanvasRenderingContext2D,
  frame: ViewportFrame,
  f: Extract<CanvasObject, { type: "frame" }>
): void {
  const p = worldToScreen({ x: f.x, y: f.y }, frame);
  const w = f.width * frame.zoom;
  const h = f.height * frame.zoom;
  ctx.save();
  ctx.fillStyle = f.color ?? "rgba(42,109,245,0.08)";
  ctx.strokeStyle = f.color ?? "#2a6df5";
  ctx.lineWidth = Math.max(1, 2 * frame.zoom);
  ctx.beginPath();
  roundRect(ctx, p.x, p.y, w, h, 10);
  ctx.fill();
  ctx.stroke();
  if (f.name) {
    const fontSize = Math.max(8, 13 * frame.zoom);
    ctx.font = `600 ${fontSize}px ${FONT}`;
    ctx.fillStyle = f.color ?? "#2a6df5";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(f.name, p.x + 8, p.y - 4);
  }
  ctx.restore();
}

// -------- Selection overlay --------

function drawSelection(
  ctx: CanvasRenderingContext2D,
  frame: ViewportFrame,
  _objects: readonly CanvasObject[],
  selected: ReadonlySet<string>,
  drawCtx: ObjectDrawContext
): void {
  const rects: Rect[] = [];
  // Iterate the (small) selected set and resolve each object by id rather than
  // scanning every canvas object, which keeps selection O(|selected|).
  for (const id of selected) {
    const o = drawCtx.objectById(id);
    if (o) rects.push({ x: o.x, y: o.y, width: o.width, height: o.height });
  }
  const bounds = selectionBounds(rects);
  if (!bounds) return;

  const topLeft = worldToScreen({ x: bounds.x, y: bounds.y }, frame);
  const bw = bounds.width * frame.zoom;
  const bh = bounds.height * frame.zoom;

  ctx.save();
  ctx.strokeStyle = SELECTION;
  ctx.lineWidth = 1.5 / zoomLine(frame.zoom);
  ctx.strokeRect(topLeft.x, topLeft.y, bw, bh);

  // Handles.
  const handleSize = 7;
  ctx.fillStyle = HANDLE;
  for (const h of HANDLES) {
    const hw = handleWorld(bounds, h);
    const hp = worldToScreen(hw, frame);
    ctx.beginPath();
    ctx.fillRect(hp.x - handleSize / 2, hp.y - handleSize / 2, handleSize, handleSize);
  }
  ctx.restore();
}

// -------- Helpers --------

const FONT = `"Segoe UI", system-ui, sans-serif`;

function corner(w: number, h: number): number {
  return Math.min(10, Math.max(2, w * 0.08), Math.max(2, h * 0.08));
}

function zoomLine(zoom: number): number {
  return Math.max(1, zoom);
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const paragraphs = text.split("\n");
  const out: string[] = [];
  for (const para of paragraphs) {
    if (para.length === 0) {
      out.push("");
      continue;
    }
    const words = para.split(/\s+/);
    let line = "";
    for (const word of words) {
      const test = line ? line + " " + word : word;
      if (ctx.measureText(test).width <= maxWidth || line === "") {
        line = test;
      } else {
        out.push(line);
        line = word;
      }
    }
    if (line !== "") out.push(line);
  }
  return out;
}

function clipText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, prefix = false): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const head = prefix && text.length > 8 ? text.slice(0, Math.min(12, text.length)) + "…" : "";
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > maxWidth) {
    t = t.slice(0, -1);
  }
  return head || t + "…";
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

export function screenPointInObj(screen: Point, obj: CanvasObject, frame: ViewportFrame): boolean {
  const world = screenToWorld(screen, frame);
  const cx = obj.x + obj.width / 2;
  const cy = obj.y + obj.height / 2;
  if (obj.rotation !== 0) {
    const cos = Math.cos(-obj.rotation);
    const sin = Math.sin(-obj.rotation);
    const lx = (world.x - cx) * cos - (world.y - cy) * sin;
    const ly = (world.x - cx) * sin + (world.y - cy) * cos;
    return Math.abs(lx) <= obj.width / 2 && Math.abs(ly) <= obj.height / 2;
  }
  return (
    world.x >= obj.x && world.x <= obj.x + obj.width && world.y >= obj.y && world.y <= obj.y + obj.height
  );
}
