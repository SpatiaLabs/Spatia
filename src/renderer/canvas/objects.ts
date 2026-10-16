import type { CanvasObject, TextObject, PenObject, UrlObject, AssetMeta, ShapeObject, WorldPoint } from "../../shared/types/object.js";
import type { ViewportFrame, Point, Rect } from "../../shared/geometry/viewport.js";
import { worldToScreen, isRectVisible, screenToWorld } from "../../shared/geometry/viewport.js";
import { selectionBounds, HANDLES, handleWorld, rotateKnobWorld } from "../../shared/geometry/selection.js";
import {
  connectionEndpoints,
  groupBounds,
} from "../../shared/geometry/workspace.js";
import { isStrokeOnly } from "../../shared/geometry/shapes.js";
import { tableLayout } from "../../shared/geometry/tableLayout.js";
import { isRtlLine, strokeOutline } from "../../shared/geometry/ink.js";
import { brushProfile, penBrushKind, type BrushKind } from "../../shared/input/brushes.js";
import { parseMarkup, type MarkupLine, type MarkupRun } from "../../shared/text/markup.js";

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
  drawCtx: ObjectDrawContext,
  coarse = false
): void {
  for (const obj of objects) {
    if (!isRectVisible({ x: obj.x, y: obj.y, width: obj.width, height: obj.height }, frame)) {
      continue;
    }
    drawObject(ctx, frame, obj, drawCtx);
  }
  if (selected.size > 0) {
    drawSelection(ctx, frame, objects, selected, drawCtx, coarse);
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
    case "shape":
      drawShape(ctx, frame, obj);
      break;
    case "table":
      drawTable(ctx, frame, obj);
      break;
    case "chart":
      drawChart(ctx, frame, obj);
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

/** Draw a diagram shape / line-arrow, accounting for rotation and zoom. */
function drawShape(ctx: CanvasRenderingContext2D, frame: ViewportFrame, obj: ShapeObject): void {
  const { p, w, h } = drawObjectFrame(ctx, frame, obj);
  ctx.save();
  ctx.translate(p.x + w / 2, p.y + h / 2);
  ctx.rotate(obj.rotation);
  ctx.strokeStyle = obj.stroke;
  ctx.lineWidth = Math.max(1, (obj.strokeWidth || 2) * frame.zoom);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (isStrokeOnly(obj.kind)) {
    // Line / arrow: a horizontal baseline from left-center to right-center.
    ctx.beginPath();
    ctx.moveTo(-w / 2, 0);
    ctx.lineTo(w / 2, 0);
    ctx.stroke();
    if (obj.kind === "arrow") {
      const arrowLen = Math.max(10, Math.min(w * 0.25, 14 * frame.zoom));
      const spread = Math.PI / 6;
      ctx.fillStyle = obj.stroke;
      ctx.beginPath();
      ctx.moveTo(w / 2, 0);
      ctx.lineTo(w / 2 - arrowLen * Math.cos(spread), -arrowLen * Math.sin(spread));
      ctx.lineTo(w / 2 - arrowLen * Math.cos(spread), arrowLen * Math.sin(spread));
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    return;
  }

  ctx.beginPath();
  switch (obj.kind) {
    case "rectangle":
      roundRect(ctx, -w / 2, -h / 2, w, h, corner(w, h));
      break;
    case "rounded-rectangle":
      roundRect(ctx, -w / 2, -h / 2, w, h, Math.min(w, h) * 0.22);
      break;
    case "ellipse":
      ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
      break;
    case "diamond":
      ctx.moveTo(0, -h / 2);
      ctx.lineTo(w / 2, 0);
      ctx.lineTo(0, h / 2);
      ctx.lineTo(-w / 2, 0);
      ctx.closePath();
      break;
    case "triangle":
      ctx.moveTo(0, -h / 2);
      ctx.lineTo(w / 2, h / 2);
      ctx.lineTo(-w / 2, h / 2);
      ctx.closePath();
      break;
    case "line":
    case "arrow":
      break;
  }
  if (obj.fill) {
    ctx.fillStyle = obj.fill;
    ctx.fill();
  }
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
  const family = obj.fontFamily ? `"${obj.fontFamily}"` : FONT;
  ctx.font = `${style}${weight}${fontPx}px ${family}`;
  ctx.textBaseline = "top";
  ctx.fillStyle = TEXT_FILL;
  const textAlign = obj.align;
  const pad = 6;
  const maxWidth = Math.max(0, w - pad * 2);
  const lineHeight = fontPx * 1.25;
  let cursorY = -h / 2 + pad;
  const alignMap = { left: "left", center: "center", right: "right" } as const;
  const a = alignMap[textAlign] ?? "left";
  if (obj.metadata?.richText === true) {
    drawMarkup(ctx, obj.text || "", -w / 2 + pad, cursorY, maxWidth, h - pad * 2, fontPx, family, TEXT_FILL, a);
    ctx.restore();
    return;
  }
  const lines = wrapText(ctx, obj.text || "", maxWidth);
  for (let i = 0; i < lines.length; i++) {
    // RTL (Arabic / Hebrew) lines grow leftward and read from the right edge;
    // mirror the align per line so they never overflow the opposite padding.
    const lineAlign = isRtlLine(lines[i]) ? "right" : a;
    ctx.textAlign = lineAlign;
    const x = lineAlign === "left" ? -w / 2 + pad : lineAlign === "right" ? w / 2 - pad : 0;
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
  if (obj.metadata?.richText === true) {
    drawMarkup(ctx, obj.text || "", -w / 2 + pad, startY, w - pad * 2, h - pad * 2 - (startY + h / 2), bodyPx, FONT, NOTE_BODY);
    ctx.restore();
    return;
  }
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
  drawBrushStroke(ctx, frame, pen.points, {
    color: pen.color || "#e8eaed",
    width: pen.strokeWidth || 3,
    opacity: pen.opacity ?? 1,
    brush: penBrushKind(pen),
  });
}

/** Style for painting a freehand stroke with a specific brush character. */
export interface BrushStrokeStyle {
  color: string;
  /** Stored width in world units (already includes the brush's width scale). */
  width: number;
  opacity: number;
  brush: BrushKind;
}

/**
 * Paint a freehand stroke with its brush's real character. This is the single
 * entry point shared by committed pen objects and the live draft preview, so a
 * stroke never changes appearance when it is committed.
 *
 * The differences are structural, not cosmetic: an angled nib sets its own
 * per-vertex widths (computed upstream), a highlighter multiplies a wide band
 * into the canvas, a marker/brush lay a soft halo under a crisp core, and a
 * pencil scatters a deterministic grain over a thin ribbon.
 */
export function drawBrushStroke(
  ctx: CanvasRenderingContext2D,
  frame: ViewportFrame,
  pts: readonly WorldPoint[],
  style: BrushStrokeStyle
): void {
  const n = pts.length;
  if (n === 0) return;
  const profile = brushProfile(style.brush);
  const uniform = Math.max(1, style.width * frame.zoom);
  const cap: CanvasLineCap = profile.cap === "square" ? "square" : profile.cap === "butt" ? "butt" : "round";

  ctx.save();
  ctx.strokeStyle = style.color;
  ctx.fillStyle = style.color;
  ctx.globalAlpha = style.opacity;
  ctx.lineCap = cap;
  ctx.lineJoin = "round";
  if (profile.blend === "multiply") ctx.globalCompositeOperation = "multiply";

  if (n < 2) {
    // A single tap: paint one dot so a click leaves a mark for every brush.
    if (style.brush === "calligraphy") return;
    const s = worldToScreen(pts[0], frame);
    const r = uniform / 2;
    ctx.beginPath();
    ctx.arc(s.x, s.y, Math.max(0.5, r), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  if (profile.softness > 0) {
    // Soft-edge media: a wider, faint pass under the solid core reads as a
    // spread/bleed edge without a per-pixel blur.
    ctx.globalAlpha = style.opacity * 0.4;
    strokeWorldPath(ctx, pts, frame, uniform * (1 + profile.softness * 1.4));
    ctx.globalAlpha = style.opacity;
  }

  // Calligraphy gets flat (butt) terminals from the ribbon itself: skip the
  // round cap stamps so the nib's angled ends stay sharp.
  strokeWorldPath(ctx, pts, frame, uniform, style.brush === "calligraphy" ? "none" : "round");

  if (profile.grain > 0) {
    ctx.globalAlpha = style.opacity;
    drawGrain(ctx, frame, pts, uniform, profile.grain);
  }

  ctx.restore();
}

/**
 * Deterministic graphite grain: short faint specks scattered along the path,
 * seeded from the vertex index so the pattern is identical on every repaint
 * (transform/pan/zoom) and never shimmers. Capped in count so a very long
 * stroke stays cheap.
 */
function drawGrain(
  ctx: CanvasRenderingContext2D,
  frame: ViewportFrame,
  pts: readonly WorldPoint[],
  screenWidth: number,
  amount: number
): void {
  const spacing = Math.max(3, screenWidth * 0.7);
  const jitter = screenWidth * 0.55;
  let dots = 0;
  const maxDots = 900;
  ctx.beginPath();
  let seed = 0x9e3779b1;
  for (let i = 0; i < pts.length - 1 && dots < maxDots; i++) {
    const a = worldToScreen(pts[i], frame);
    const b = worldToScreen(pts[i + 1], frame);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-3) continue;
    const nx = -dy / len;
    const ny = dx / len;
    for (let d = 0; d < len && dots < maxDots; d += spacing) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const t = d / len;
      const off = (((seed >> 8) & 0xff) / 255 - 0.5) * 2 * jitter;
      const x = a.x + dx * t + nx * off;
      const y = a.y + dy * t + ny * off;
      const r = 0.4 + (((seed >> 16) & 0xff) / 255) * amount * 1.1;
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
      dots++;
    }
  }
  ctx.globalAlpha = Math.min(0.5, 0.18 + amount * 0.3);
  ctx.fill();
}

/** Stroke a polyline whose per-vertex `width` (world units) may vary. */
export function strokeWorldPath(
  ctx: CanvasRenderingContext2D,
  pts: readonly WorldPoint[],
  frame: ViewportFrame,
  uniformScreenWidth: number,
  caps: "round" | "none" = "round"
): void {
  const n = pts.length;
  if (n < 2) return;
  let variable = false;
  for (const p of pts) {
    if (p.width !== undefined) {
      variable = true;
      break;
    }
  }
  if (!variable) {
    ctx.lineWidth = uniformScreenWidth;
    ctx.beginPath();
    const s0 = worldToScreen(pts[0], frame);
    ctx.moveTo(s0.x, s0.y);
    for (let i = 1; i < n; i++) {
      const s = worldToScreen(pts[i], frame);
      ctx.lineTo(s.x, s.y);
    }
    ctx.stroke();
    return;
  }
  // Variable width: fill one continuous ribbon instead of stroking each segment
  // separately. Per-segment strokes step their width at every sample, which
  // shows as banding when pressure ramps quickly; a single filled outline (with
  // round end caps) keeps the taper smooth. The outline is built in world units
  // (falling back to the uniform width for any vertex without one) and scaled by
  // the viewport, so it stays crisp at any zoom.
  const outline = strokeOutline(pts, uniformScreenWidth / frame.zoom);
  if (!outline) return;
  const toScreen = (p: Point): Point => worldToScreen(p, frame);
  ctx.beginPath();
  const first = toScreen(outline.left[0]);
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < n; i++) {
    const s = toScreen(outline.left[i]);
    ctx.lineTo(s.x, s.y);
  }
  for (let i = n - 1; i >= 0; i--) {
    const s = toScreen(outline.right[i]);
    ctx.lineTo(s.x, s.y);
  }
  ctx.closePath();
  ctx.fillStyle = ctx.strokeStyle;
  ctx.fill();
  if (caps === "none") return;
  // Round caps at both ends (the flat polygon edge alone would look chopped).
  const capStart = toScreen(pts[0]);
  const capEnd = toScreen(pts[n - 1]);
  const startR = Math.max(1, (pts[0].width ?? uniformScreenWidth / frame.zoom) * frame.zoom) / 2;
  const endR = Math.max(1, (pts[n - 1].width ?? uniformScreenWidth / frame.zoom) * frame.zoom) / 2;
  ctx.beginPath();
  ctx.arc(capStart.x, capStart.y, startR, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(capEnd.x, capEnd.y, endR, 0, Math.PI * 2);
  ctx.fill();
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
  const shape = f.frameShape ?? "rectangle";
  ctx.save();
  ctx.fillStyle = f.color ?? "rgba(42,109,245,0.08)";
  ctx.strokeStyle = f.color ?? "#2a6df5";
  ctx.lineWidth = Math.max(1, 2 * frame.zoom);
  ctx.beginPath();
  if (shape === "ellipse") {
    ctx.ellipse(p.x + w / 2, p.y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  } else if (shape === "rounded") {
    roundRect(ctx, p.x, p.y, w, h, Math.max(4, Math.min(w, h) * 0.2));
  } else {
    roundRect(ctx, p.x, p.y, w, h, 10);
  }
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

// -------- Table / Chart drawing --------

const CHART_COLORS = ["#5b7cfa", "#3ddc84", "#f0c33c", "#f2685c", "#c07cf2", "#4fd5d0", "#8c8cf5"];

function drawTable(
  ctx: CanvasRenderingContext2D,
  frame: ViewportFrame,
  obj: Extract<CanvasObject, { type: "table" }>
): void {
  const { p, w, h } = drawObjectFrame(ctx, frame, obj);
  const data = obj.data;
  const columns = data.columns.length;
  const rows = data.rows.length;

  ctx.save();
  ctx.translate(p.x + w / 2, p.y + h / 2);
  ctx.rotate(obj.rotation);

  ctx.beginPath();
  roundRect(ctx, -w / 2, -h / 2, w, h, corner(w, h));
  ctx.fillStyle = "#15181c";
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = 1;
  ctx.stroke();

  if (columns === 0) {
    ctx.fillStyle = "rgba(232,234,237,0.5)";
    ctx.font = `400 ${Math.max(10, 12 * frame.zoom)}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Empty table", 0, 0);
    ctx.restore();
    return;
  }

  const layout = tableLayout(data, w, h, frame.zoom);
  const headerPx = layout.headerPx;
  const pad = layout.pad;
  const rowH = layout.rowH;
  const colW = layout.colW;

  const accent = obj.comparison ? "#7a5cf0" : "#3d5be8";
  // Header.
  ctx.fillStyle = accent;
  ctx.fillRect(-w / 2, -h / 2, w, headerPx);
  ctx.fillStyle = "#ffffff";
  ctx.font = `600 ${Math.max(8, headerPx * 0.5)}px ${FONT}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (let c = 0; c < columns; c++) {
    const cx = -w / 2 + c * colW;
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx + pad, -h / 2, colW - pad * 2, headerPx);
    ctx.clip();
    ctx.fillText(clipText(ctx, data.columns[c] || "", Math.max(4, colW - pad * 2)), cx + pad, -h / 2 + headerPx / 2);
    ctx.restore();
  }

  // Body rows.
  for (let r = 0; r < rows; r++) {
    const y = -h / 2 + headerPx + r * rowH;
    const row = data.rows[r];
    if (r % 2 === 1) {
      ctx.fillStyle = "rgba(255,255,255,0.035)";
      ctx.fillRect(-w / 2, y, w, rowH);
    }
    const cellPx = Math.max(7, Math.min(11, headerPx * 0.58));
    ctx.font = `400 ${cellPx}px ${FONT}`;
    ctx.fillStyle = "rgba(232,234,237,0.85)";
    for (let c = 0; c < columns; c++) {
      const cx = -w / 2 + c * colW;
      ctx.save();
      ctx.beginPath();
      ctx.rect(cx + pad, y, colW - pad * 2, rowH);
      ctx.clip();
      ctx.fillText(clipText(ctx, row[c] ?? "", Math.max(4, colW - pad * 2)), cx + pad, y + rowH / 2);
      ctx.restore();
    }
  }

  // Grid lines.
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let c = 1; c < columns; c++) {
    const x = -w / 2 + c * colW;
    ctx.moveTo(x, -h / 2);
    ctx.lineTo(x, h / 2);
  }
  for (let r = 0; r <= rows; r++) {
    const y = -h / 2 + headerPx + r * rowH;
    ctx.moveTo(-w / 2, y);
    ctx.lineTo(w / 2, y);
  }
  ctx.stroke();
  if (obj.comparison) {
    ctx.strokeStyle = "rgba(255,255,255,0.28)";
    ctx.lineWidth = Math.max(1, 2 * frame.zoom);
    ctx.strokeRect(-w / 2, -h / 2, w, headerPx);
  }
  ctx.restore();
}

function drawChart(
  ctx: CanvasRenderingContext2D,
  frame: ViewportFrame,
  obj: Extract<CanvasObject, { type: "chart" }>
): void {
  const { p, w, h } = drawObjectFrame(ctx, frame, obj);

  ctx.save();
  ctx.translate(p.x + w / 2, p.y + h / 2);
  ctx.rotate(obj.rotation);

  ctx.beginPath();
  roundRect(ctx, -w / 2, -h / 2, w, h, corner(w, h));
  ctx.fillStyle = "#15181c";
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = 1;
  ctx.stroke();

  const titlePx = obj.title ? Math.max(10, Math.min(15, h * 0.09)) : 0;
  if (obj.title) {
    ctx.fillStyle = "#e8eaed";
    ctx.font = `600 ${titlePx}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(clipText(ctx, obj.title, w - Math.max(8, 12 * frame.zoom)), 0, -h / 2 + Math.max(5, 7 * frame.zoom));
  }
  const plotPad = Math.max(4, 8 * frame.zoom);
  const plotY = -h / 2 + (obj.title ? titlePx + plotPad : plotPad);
  const plotH = h - (obj.title ? titlePx : 0) - plotPad * 2;

  if (obj.kind === "pie") {
    drawPie(ctx, obj, w, plotY, plotH, frame.zoom);
  } else {
    drawCartesianChart(ctx, obj, w, h, plotY, plotH, frame.zoom);
  }
  ctx.restore();
}

function drawCartesianChart(
  ctx: CanvasRenderingContext2D,
  obj: Extract<CanvasObject, { type: "chart" }>,
  w: number,
  h: number,
  plotY: number,
  plotH: number,
  zoom: number
): void {
  const data = obj.data;
  const seriesCols = Math.max(1, Math.min(data.columns.length, data.columns.length - 1));
  const valueCols: number[] = [];
  for (let c = 1; c <= seriesCols; c++) valueCols.push(c);
  if (valueCols.length === 0) valueCols.push(0);

  const all: number[] = [];
  for (const row of data.rows) {
    for (const c of valueCols) {
      const n = Number(row[c]);
      if (Number.isFinite(n) && row[c].trim() !== "") all.push(Math.abs(n));
    }
  }
  const maxVal = Math.max(1, ...all);
  const categories = data.rows.length > 0 ? data.rows.length : 1;
  const pad = Math.max(4, 6 * zoom);
  const labelSpace = Math.max(6, Math.min(18, h * 0.1)); // x category labels
  const axisSpace = Math.max(10, Math.min(26, w * 0.12)); // y value labels
  const plotW = Math.max(30, w - axisSpace - pad * 2);
  const plotH2 = Math.max(20, plotH - labelSpace - pad - 8 * zoom);
  const left = -w / 2 + axisSpace + pad;
  const bottom = plotY + plotH2 + pad;
  const top = plotY + pad;

  // Gridlines + y labels.
  ctx.font = `400 ${Math.max(7, 9 * zoom)}px ${FONT}`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const v = (maxVal / steps) * i;
    if (i > 0 && i < steps) {
      const y = bottom - (plotH2 * i) / steps;
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(left + plotW, y);
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(232,234,237,0.45)";
    ctx.fillText(formatNumber(v), left - 3, bottom - (plotH2 * i) / steps);
  }
  ctx.strokeStyle = "rgba(232,234,237,0.7)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left, bottom);
  ctx.lineTo(left + plotW, bottom);
  ctx.moveTo(left, top);
  ctx.lineTo(left, bottom);
  ctx.stroke();

  const colW = plotW / categories;
  const catW = viewableWidth(ctx, (obj.data.columns[0] || "Category"), Math.max(4, colW - 4));
  const seriesCount = valueCols.length;

  if (obj.kind === "bar") {
    const barGap = Math.max(1, colW * 0.1);
    const barW = Math.max(2, (colW - barGap * 2 - (seriesCount - 1) * 2) / seriesCount);
    for (const row of data.rows) {
      for (let s = 0; s < seriesCount; s++) {
        const c = valueCols[s];
        const n = Number(row[c]);
        const val = Number.isFinite(n) && row[c].trim() !== "" ? n : 0;
        const bh = (Math.abs(val) / maxVal) * plotH2;
        const x = left + colW * 0 + rowIndex(row, data.rows) * colW + barGap + s * (barW + 2);
        const y = val >= 0 ? bottom - bh : bottom;
        ctx.fillStyle = CHART_COLORS[s % CHART_COLORS.length];
        ctx.fillRect(x, y, barW, Math.max(1, bh));
      }
    }
  } else {
    for (let s = 0; s < seriesCount; s++) {
      const c = valueCols[s];
      ctx.strokeStyle = CHART_COLORS[s % CHART_COLORS.length];
      ctx.lineWidth = Math.max(1, 2 * zoom);
      ctx.beginPath();
      data.rows.forEach((row, i) => {
        const n = Number(row[c]);
        const val = Number.isFinite(n) && row[c].trim() !== "" ? n : 0;
        const x = left + colW * (i + 0.5);
        const y = bottom - (val / maxVal) * plotH2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.fillStyle = CHART_COLORS[s % CHART_COLORS.length];
      data.rows.forEach((row, i) => {
        const n = Number(row[c]);
        const val = Number.isFinite(n) && row[c].trim() !== "" ? n : 0;
        const x = left + colW * (i + 0.5);
        const y = bottom - (val / maxVal) * plotH2;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(1.5, 3 * zoom), 0, Math.PI * 2);
        ctx.fill();
      });
    }
  }

  // Category labels.
  ctx.font = `400 ${Math.max(7, 9 * zoom)}px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle = "rgba(232,234,237,0.6)";
  data.rows.forEach((row, i) => {
    const x = left + colW * (i + 0.5);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x - catW / 2, bottom + 2, catW, labelSpace);
    ctx.clip();
    ctx.fillText(row[0] || "", x, bottom + 4);
    ctx.restore();
  });
}

function rowIndex(row: readonly string[], rows: readonly (readonly string[])[]): number {
  for (let i = 0; i < rows.length; i++) if (rows[i] === row) return i;
  return 0;
}

function viewableWidth(ctx: CanvasRenderingContext2D, label: string, maxW: number): number {
  return Math.min(maxW, ctx.measureText(label).width + 2);
}

function formatNumber(v: number): string {
  if (Math.abs(v) >= 10000) return v.toExponential(1).replace(".0", "");
  if (Math.abs(v) >= 100) return Math.round(v).toString();
  return String(Math.round(v * 10) / 10);
}

function drawPie(
  ctx: CanvasRenderingContext2D,
  obj: Extract<CanvasObject, { type: "chart" }>,
  w: number,
  plotY: number,
  plotH: number,
  zoom: number
): void {
  const slices: { label: string; value: number }[] = obj.data.rows
    .map((row) => ({ label: row[0] || "", value: Number(row[1]) }))
    .filter((s) => Number.isFinite(s.value) && s.value > 0);
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  if (slices.length === 0 || total <= 0) {
    ctx.fillStyle = "rgba(232,234,237,0.5)";
    ctx.font = `400 ${Math.max(10, 12 * zoom)}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("No data", 0, plotY + plotH / 2);
    return;
  }
  const legendW = Math.min(w * 0.34, 160 * zoom);
  const pad = Math.max(4, 8 * zoom);
  const size = Math.min(w - legendW - pad * 2, plotH - pad * 2);
  const cx = -w / 2 + pad + size / 2;
  const cy = plotY + (plotH - size) / 2 + size / 2;
  const r = size / 2;

  let angle = -Math.PI / 2;
  for (let i = 0; i < slices.length; i++) {
    const sweep = (slices[i].value / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, angle, angle + sweep);
    ctx.closePath();
    ctx.fillStyle = CHART_COLORS[i % CHART_COLORS.length];
    ctx.fill();
    ctx.strokeStyle = "#15181c";
    ctx.lineWidth = Math.max(1, 1.5 * zoom);
    ctx.stroke();
    if (sweep > Math.PI / 8) {
      const mid = angle + sweep / 2;
      ctx.fillStyle = "#ffffff";
      ctx.font = `600 ${Math.max(8, 10 * zoom)}px ${FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(Math.round((slices[i].value / total) * 100) + "%", cx + Math.cos(mid) * r * 0.6, cy + Math.sin(mid) * r * 0.6);
    }
    angle += sweep;
  }

  // Legend.
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = `400 ${Math.max(8, 10 * zoom)}px ${FONT}`;
  const lx = cx + r + pad + Math.max(4, 8 * zoom);
  const rowH = Math.max(10, 14 * zoom);
  let ly = plotY + pad;
  for (let i = 0; i < slices.length; i++) {
    if (ly + rowH > plotY + plotH) break;
    ctx.fillStyle = CHART_COLORS[i % CHART_COLORS.length];
    ctx.fillRect(lx, ly, Math.max(5, 8 * zoom), Math.max(5, 8 * zoom));
    ctx.fillStyle = "rgba(232,234,237,0.85)";
    ctx.fillText(clipText(ctx, slices[i].label, Math.max(10, w - (lx + w / 2) - 6)), lx + Math.max(7, 11 * zoom), ly + rowH / 2);
    ly += rowH;
  }
}

// -------- Selection overlay --------

function drawSelection(
  ctx: CanvasRenderingContext2D,
  frame: ViewportFrame,
  _objects: readonly CanvasObject[],
  selected: ReadonlySet<string>,
  drawCtx: ObjectDrawContext,
  coarse: boolean
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

  // Handles. Touch hosts get larger targets so the corners are easy to grab the
  // edges are far apart — desktop keeps the original 7px squares.
  const handleSize = coarse ? 12 : 7;
  ctx.fillStyle = HANDLE;
  for (const h of HANDLES) {
    const hw = handleWorld(bounds, h);
    const hp = worldToScreen(hw, frame);
    ctx.beginPath();
    ctx.fillRect(hp.x - handleSize / 2, hp.y - handleSize / 2, handleSize, handleSize);
  }

  // Rotation knob: only on touch hosts, drawn above the selection box.
  if (coarse) {
    const knob = rotateKnobWorld(bounds, frame.zoom);
    const kp = worldToScreen(knob, frame);
    const r = 13 / zoomLine(frame.zoom) + 4;
    ctx.beginPath();
    ctx.strokeStyle = SELECTION;
    ctx.lineWidth = 1.5 / zoomLine(frame.zoom);
    ctx.moveTo(kp.x, kp.y + Math.max(10, 8 / frame.zoom));
    ctx.lineTo(kp.x, kp.y - r);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(kp.x, kp.y, r, 0, Math.PI * 2);
    ctx.fillStyle = HANDLE;
    ctx.fill();
    ctx.strokeStyle = "#0f1113";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.restore();
}

// -------- Helpers --------

const FONT = `"Segoe UI", system-ui, sans-serif`;

/**
 * Estimate the height a text object needs for its content at the current font
 * size / width, so the editor can auto-grow the object on commit instead of
 * clipping the last line. `measure` (optional) widths come from a preconfigured
 * 2D context; without one a per-character heuristic is used, which is exact for
 * whitespace-free content and approximate elsewhere. Height never shrinks below
 * a usable editor minimum.
 */
export function estimateTextHeight(
  text: string,
  fontSize: number,
  width: number,
  measure?: (s: string) => number
): number {
  const lineHeight = Math.max(1, fontSize) * 1.25;
  const pad = 12;
  const min = Math.max(40, lineHeight + pad * 2);
  if (!text) return min;
  const maxWidth = Math.max(10, width - pad * 2);
  const lines: string[] = [];
  const paragraphs = String(text).split("\n");
  if (measure) {
    for (const para of paragraphs) {
      if (!para) {
        lines.push("");
        continue;
      }
      const words = para.split(/\s+/);
      let line = "";
      for (const word of words) {
        const test = line ? `${line} ${word}` : word;
        if (measure(test) > maxWidth && line !== "") {
          lines.push(line);
          line = word;
        } else {
          line = test;
        }
      }
      if (line) lines.push(line);
    }
  } else {
    const perLine = Math.max(1, Math.floor(maxWidth / Math.max(1, fontSize * 0.55)));
    for (const para of paragraphs) {
      if (!para) {
        lines.push("");
        continue;
      }
      for (let i = 0; i < para.length; i += perLine) lines.push(para.slice(i, i + perLine));
    }
  }
  return Math.max(min, lines.length * lineHeight + pad * 2);
}

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

// -------- Rich text (note/text markup) --------

const LINK_FILL = "#5b7cfa";
const CODE_BG = "rgba(91,124,250,0.16)";

interface RichToken {
  text: string;
  run: MarkupRun;
}

interface RichLine {
  tokens: RichToken[];
  width: number;
}

/** Inline tokens for a markup line (preserves whitespace for wrapping). */
function richTokens(runs: MarkupRun[]): RichToken[] {
  const tokens: RichToken[] = [];
  for (const run of runs) {
    for (const part of String(run.text).split(/(\s+)/)) {
      if (part) tokens.push({ text: part, run });
    }
  }
  return tokens;
}

function richFont(run: MarkupRun, size: number, family: string): string {
  const fam = run.code ? '"Cascadia Code", Consolas, monospace' : family;
  const style = run.italic ? "italic " : "";
  const weight = run.bold ? "bold " : "";
  return `${style}${weight}${size}px ${fam}`;
}

/** Prefix used for bullet/numbered lines (nested lists indent by level). */
function richPrefix(line: MarkupLine, numberCount: number): string {
  if (line.kind === "bullet") return `${"    ".repeat(Math.max(0, line.level - 1))}• `;
  if (line.kind === "numbered") return `${numberCount}. `;
  return "";
}

/**
 * Wrap one parsed markup line into visual lines whose tokens fit `maxWidth`,
 * then draw them at (x, y) with the given base size. Headings are scaled and
 * bolded; bullet/numbered lines get their marker and hanging indents. Returns
 * the drawn height so callers can stack following lines.
 */
function drawRichLine(
  ctx: CanvasRenderingContext2D,
  line: MarkupLine,
  x: number,
  y: number,
  baseSize: number,
  family: string,
  maxWidth: number,
  numberCount: number,
  baseColor: string,
  align: "left" | "center" | "right"
): { height: number; usedNumber: number } {
  const isHeading = line.kind === "heading";
  const scale = isHeading ? (line.level === 1 ? 1.5 : line.level === 2 ? 1.25 : 1.1) : 1;
  const size = Math.max(1, baseSize * scale);
  const lineHeight = size * 1.25;
  const prefix = richPrefix(line, numberCount);
  const usedNumber = line.kind === "numbered" ? numberCount + 1 : numberCount;
  const headingRun: MarkupRun = { text: "", bold: true };

  const ctxFont = (run: MarkupRun): void => {
    ctx.font = richFont(run, size, family);
  };
  // Measure prefix width at the heading font weight.
  ctx.font = richFont(headingRun, size, family);
  const prefixWidth = isHeading ? 0 : prefix ? ctx.measureText(prefix).width : 0;

  let tokens = richTokens(line.runs);
  if (isHeading) {
    tokens = tokens.map((t) => ({ text: t.text, run: { text: t.text, bold: true, ...(t.run.italic ? { italic: true } : {}) } }));
  } else if (prefix) {
    tokens = [{ text: prefix, run: { text: prefix } }, ...tokens];
  }

  // Greedy wrap into visual lines (never measure per-char more than needed).
  const lines: RichLine[] = [];
  let cur: RichLine = { tokens: [], width: prefixWidth };
  for (const token of tokens) {
    ctxFont(token.run);
    const w = ctx.measureText(token.text).width;
    if (cur.tokens.length > 0 && cur.width + w > maxWidth) {
      lines.push(cur);
      cur = { tokens: [], width: prefixWidth };
    }
    cur.tokens.push(token);
    cur.width += w;
  }
  if (cur.tokens.length > 0) lines.push(cur);

  // Draw each visual line, honoring alignment and RTL per line.
  for (const vis of lines) {
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const full = vis.tokens.map((t) => t.text).join("");
    const isRtl = isRtlLine(full);
    let drawX = x;
    if (isRtl) drawX = x + maxWidth - vis.width;
    else if (align === "center") drawX = x + (maxWidth - vis.width) / 2;
    else if (align === "right") drawX = x + maxWidth - vis.width;
    for (const token of vis.tokens) {
      ctxFont(token.run);
      const w = ctx.measureText(token.text).width;
      ctx.fillStyle = token.run.link ? LINK_FILL : baseColor;
      if (token.run.code && !token.run.link) {
        ctx.fillStyle = CODE_BG;
        ctx.fillRect(drawX, y + size * 0.08, w, size * 0.96);
        ctx.fillStyle = baseColor;
      }
      ctx.fillText(token.text, drawX, y);
      if (token.run.underline || token.run.link) {
        ctx.fillStyle = token.run.link ? LINK_FILL : baseColor;
        ctx.fillRect(drawX, y + size * 1.08, w, Math.max(1, size * 0.08));
      }
      drawX += w;
    }
    y += lineHeight;
  }
  return { height: lines.length * lineHeight, usedNumber };
}

/** Render the full markup of a note/text body into the given box. */
function drawMarkup(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  maxHeight: number,
  baseSize: number,
  family: string,
  baseColor: string,
  align: "left" | "center" | "right" = "left"
): void {
  let numberCount = 0;
  for (const line of parseMarkup(text)) {
    const res = drawRichLine(ctx, line, x, y, baseSize, family, maxWidth, numberCount, baseColor, align);
    numberCount = res.usedNumber;
    y += res.height;
    if (y >= maxHeight) break;
  }
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
