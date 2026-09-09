/**
 * Minimal, dependency-free PDF writer. Embeds a single JPEG page via
 * `/DCTDecode` (the image the renderer produces with `canvas.toDataURL`).
 * Valid for both main and renderer contexts — pure byte assembly, no DOM/Node.
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

/** Build a single-page PDF embedding `jpegBase64` scaled to `dpi` points. */
export function buildPdfFromJpeg(
  jpegBase64: string,
  pixelWidth: number,
  pixelHeight: number,
  dpi = 96
): Uint8Array {
  const pageW = Math.max(1, Math.round((pixelWidth * 72) / dpi));
  const pageH = Math.max(1, Math.round((pixelHeight * 72) / dpi));
  const img = base64ToBytes(jpegBase64);

  const header = text("%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n");
  const o1 = text("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  const o2 = text("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  const o3 = text(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] ` +
      `/Resources << /XObject << /Im0 4 0 R >> /ProcSet [/PDF /ImageC] >> /Contents 5 0 R >>\nendobj\n`
  );
  const o4a = text(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${Math.max(1, Math.round(pixelWidth))} ` +
      `/Height ${Math.max(1, Math.round(pixelHeight))} /ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
      `/Filter /DCTDecode /Length ${img.length} >>\nstream\n`
  );
  const o4b = img;
  const o4c = text("\nendstream\nendobj\n");
  const content = text(`q ${pageW} 0 0 ${pageH} 0 0 cm /Im0 Do Q\n`);
  const o5a = text(`5 0 obj\n<< /Length ${content.length} >>\nstream\n`);
  const o5b = content;
  const o5c = text("endstream\nendobj\n");

  const off1 = header.length;
  const off2 = off1 + o1.length;
  const off3 = off2 + o2.length;
  const off4 = off3 + o3.length;
  const off5 = off4 + o4a.length + o4b.length + o4c.length;
  const xrefStart = off5 + o5a.length + o5b.length + o5c.length;

  const xref = text(
    "xref\n0 6\n" +
      "0000000000 65535 f \n" +
      `${padOffset(off1)} 00000 n \n` +
      `${padOffset(off2)} 00000 n \n` +
      `${padOffset(off3)} 00000 n \n` +
      `${padOffset(off4)} 00000 n \n` +
      `${padOffset(off5)} 00000 n \n` +
      "trailer\n<< /Size 6 /Root 1 0 R >>\n" +
      `startxref\n${xrefStart}\n%%EOF\n`
  );

  return concat([header, o1, o2, o3, o4a, o4b, o4c, o5a, o5b, o5c, xref]);
}