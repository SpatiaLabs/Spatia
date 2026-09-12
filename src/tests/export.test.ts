import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToBase64, base64ToBytes } from "../shared/export/base64.js";
import { exportBounds } from "../shared/export/bounds.js";
import { buildMarkdown } from "../shared/export/markdown.js";
import { buildPdfFromJpeg, buildPdfFromJpegs } from "../shared/export/pdf.js";
import type { CanvasObject } from "../shared/types/object.js";

test("base64 round trips arbitrary bytes", () => {
  const bytes = Uint8Array.from([0, 1, 2, 254, 255, 3, 128]);
  const encoded = bytesToBase64(bytes);
  const decoded = base64ToBytes(encoded);
  assert.deepEqual(decoded, bytes);
});

test("bytesToBase64 matches a known value", () => {
  assert.equal(bytesToBase64(Uint8Array.from([0x68, 0x69])), "aGk=");
  assert.equal(bytesToBase64(Uint8Array.from([])), "");
});

function sampleObjects(): CanvasObject[] {
  const base = {
    rotation: 0,
    zIndex: 1,
    locked: false,
    metadata: {},
  };
  return [
    { ...base, type: "shape", kind: "rectangle", id: "s1", x: -80, y: -50, width: 160, height: 100, fill: "#fff", stroke: "#000", strokeWidth: 2 },
    { ...base, type: "note", id: "n1", x: 0, y: 0, width: 100, height: 60, title: "Note title", text: "Note body", color: "#f0c33c" },
    { ...base, type: "text", id: "t1", x: 10, y: 10, width: 120, height: 50, text: "A paragraph.", fontSize: 20, bold: false, italic: false, align: "left" },
    { ...base, type: "url", id: "u1", url: "https://example.com", title: "Example", x: 0, y: 0, width: 200, height: 80 },
    { ...base, type: "frame", id: "f1", name: "Frame", color: "#2a6df5", x: -200, y: -200, width: 400, height: 400 },
    { ...base, type: "test-object", id: "x1", x: -30, y: -30, width: 60, height: 60 },
  ];
}

test("exportBounds covers all objects with padding", () => {
  const b = exportBounds(sampleObjects());
  assert.ok(b.width >= 400 + 80);
  assert.ok(b.height >= 400 + 80);
  assert.ok(b.x <= -200 - 40 + 0.0001);
  assert.ok(b.y <= -200 - 40 + 0.0001);
});

test("exportBounds accounts for rotated objects", () => {
  const objs: CanvasObject[] = [
    {
      type: "shape", kind: "rectangle", id: "s",
      x: -50, y: -250, width: 100, height: 20, rotation: Math.PI / 2,
      zIndex: 1, locked: false, metadata: {},
      fill: "#fff", stroke: "#000", strokeWidth: 2,
    },
  ];
  const b = exportBounds(objs, 0);
  assert.ok(b.height >= 100, "rotated bounding box grows along its spread axis");
});

test("exportBounds returns a default rect for an empty canvas", () => {
  const b = exportBounds([]);
  assert.equal(b.width, 800);
  assert.equal(b.height, 600);
  assert.equal(b.x, -400);
  assert.equal(b.y, -300);
});

test("buildMarkdown renders notes, text and links; counts visual kinds", () => {
  const md = buildMarkdown("Demo", sampleObjects());
assert.ok(md.includes("# Demo"));
  assert.ok(md.includes("## Note title"));
  assert.ok(md.includes("Note body"));
  assert.ok(md.includes("A paragraph."));
  assert.ok(md.includes("[Example](https://example.com)"));
  assert.ok(md.includes("1 shape"));
  assert.ok(!md.includes("undefined"));
});

test("buildPdfFromJpeg produces a minimal valid single-page PDF", () => {
  const fakeJpeg = base64ToBytes("AAECAwQFBgc="); // not a real JPEG, but DCTDecode just references the stream
  const pdf = buildPdfFromJpeg(bytesToBase64(fakeJpeg), 200, 100);
  const ascii = new TextDecoder().decode(pdf);
  assert.ok(ascii.includes("%PDF-1.4"));
  assert.ok(ascii.includes("/Type /Page"));
  assert.ok(ascii.includes("/DCTDecode"));
  assert.ok(ascii.includes("/MediaBox"));
  const pageEnd = ascii.lastIndexOf("%%EOF");
  assert.ok(pageEnd > 0, "PDF has an EOF marker");
});

test("buildPdfFromJpegs assembles a valid xref for multiple pages", () => {
  const jpeg = bytesToBase64(base64ToBytes("AAECAwQFBgc="));
  const pdf = buildPdfFromJpegs([
    { jpegBase64: jpeg, pixelWidth: 200, pixelHeight: 100, dpi: 144 },
    { jpegBase64: jpeg, pixelWidth: 400, pixelHeight: 200, dpi: 96 },
  ]);
  const ascii = new TextDecoder().decode(pdf);

  // One catalog + one pages tree + two page/image/content object triples.
  assert.ok(ascii.includes("<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>"));
  assert.equal((ascii.split("/Type /Page /Parent").length - 1), 2, "two page objects");

  // Each page media box equals its physical size in points (pixels * 72 / dpi).
  assert.ok(ascii.includes("/MediaBox [0 0 100 50]"), "dpi=144 page sizes to logical units");
  assert.ok(ascii.includes("/MediaBox [0 0 300 150]"), "dpi=96 page sizes to points");

  // xref must resolve every object it claims; end offsets equal the trailer's
  // startxref so a compliant reader can walk the table.
  const xrefSection = ascii.slice(ascii.indexOf("xref"));
  const startxref = Number(ascii.match(/startxref\n(\d+)/)?.[1]);
  const size = Number(xrefSection.match(/0 (\d+)/)?.[1]);
  // Everything from "xref" onward is ASCII, so its byte length re-anchors the
  // table's address in the raw byte stream (offsets are byte-based, the decoded
  // string is UTF-16).
  const tailBytes = new TextEncoder().encode(xrefSection).length;
  const prefixBytes = pdf.length - tailBytes;
  assert.equal(size, 9, "xref size covers the free entry plus objects 1..8");
  assert.equal(startxref, prefixBytes, "startxref points at the xref table");
  assert.ok(ascii.endsWith("%%EOF\n"), "PDF ends cleanly");
  assert.ok(ascii.indexOf("%%EOF") > 0);
});