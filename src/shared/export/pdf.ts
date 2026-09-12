/**
 * Minimal, dependency-free PDF writer. Embeds JPEG pages via `/DCTDecode`
 * (the image the renderer produces with `canvas.toDataURL`). Valid for both
 * main and renderer contexts — pure byte assembly, no DOM/Node.
 *
 * Multi-page support lets "all frames" exports produce one page per frame
 * while keeping the interactive viewport untouched.
 */
import { base64ToBytes } from "./base64.js";

const enc = new TextEncoder();

function text(s: string): Uint8Array {
  return enc.encode(s);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function padOffset(n: number): string {
  return String(n).padStart(10, "0");
}

export interface PdfPage {
  /** Base64-encoded JPEG for the page. */
  jpegBase64: string;
  pixelWidth: number;
  pixelHeight: number;
  /** Raster DPI; physical page size = pixels * 72 / dpi. */
  dpi: number;
}

/**
 * Build a PDF with one page per entry. Each page is sized to the image's
 * physical size at its own DPI, so a frame rasterized at 2× with dpi=144 lands
 * on a page of exactly the frame's logical dimensions in points.
 */
export function buildPdfFromJpegs(pages: readonly PdfPage[]): Uint8Array {
  if (pages.length === 0) {
    throw new Error("buildPdfFromJpegs requires at least one page.");
  }
  const list = pages;

  const pageSize = (p: PdfPage): { w: number; h: number } => ({
    w: Math.max(1, Math.round((p.pixelWidth * 72) / (p.dpi || 96))),
    h: Math.max(1, Math.round((p.pixelHeight * 72) / (p.dpi || 96))),
  });

  // Object numbering: 1 catalog, 2 pages tree, then per page i:
  //   3 + 3i  page, 4 + 3i  image XObject, 5 + 3i  content stream.
  const kids = list.map((_, i) => `${3 + i * 3} 0 R`).join(" ");

  // Three object bodies are concatenated immediately (no offsets needed for
  // them because we assemble in order), but we track every object offset for
  // the xref table.
  const header = text("%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n");
  const o1 = text("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  const o2 = text(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${list.length} >>\nendobj\n`);

  const chunks: Uint8Array[] = [header, o1, o2];
  // xref offsets, one entry per object; object N sits at offsets[N-1].
  const offsets: number[] = [header.length, header.length + o1.length];

  let running = header.length + o1.length + o2.length;
  // Each page contributes exactly three objects (page, image, content); the
  // image and content objects include their streams inline.
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const { w, h } = pageSize(p);
    const img = base64ToBytes(p.jpegBase64);
    const pageObj = 3 + i * 3;
    const imgObj = 4 + i * 3;
    const contentObj = 5 + i * 3;
    const pageBody = text(
      `${pageObj} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] ` +
        `/Resources << /XObject << /Im0 ${imgObj} 0 R >> /ProcSet [/PDF /ImageC] >> /Contents ${contentObj} 0 R >>\nendobj\n`
    );
    const imgHead = text(
      `${imgObj} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${Math.max(1, Math.round(p.pixelWidth))} ` +
        `/Height ${Math.max(1, Math.round(p.pixelHeight))} /ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
        `/Filter /DCTDecode /Length ${img.length} >>\nstream\n`
    );
    const imgTail = text("\nendstream\nendobj\n");
    const content = text(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q\n`);
    const contentHead = text(`${contentObj} 0 obj\n<< /Length ${content.length} >>\nstream\n`);
    const contentTail = text("endstream\nendobj\n");

    const objHeads = [pageBody, imgHead, contentHead];
    const parts = [pageBody, imgHead, img, imgTail, contentHead, content, contentTail];
    for (const part of parts) {
      chunks.push(part);
      if (objHeads.includes(part)) offsets.push(running);
      running += part.length;
    }
  }

  const xrefEntries = offsets;
  const xrefStart = running;
  const xref = text(
    "xref\n" +
      `0 ${xrefEntries.length + 1}\n` +
      "0000000000 65535 f \n" +
      xrefEntries.map((off) => `${padOffset(off)} 00000 n \n`).join("") +
      `trailer\n<< /Size ${xrefEntries.length + 1} /Root 1 0 R >>\n` +
      `startxref\n${xrefStart}\n%%EOF\n`
  );
  chunks.push(xref);

  return concat(chunks);
}

/** Build a single-page PDF embedding `jpegBase64` scaled to `dpi` points. */
export function buildPdfFromJpeg(
  jpegBase64: string,
  pixelWidth: number,
  pixelHeight: number,
  dpi = 96
): Uint8Array {
  return buildPdfFromJpegs([{ jpegBase64, pixelWidth, pixelHeight, dpi }]);
}