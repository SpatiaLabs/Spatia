/**
 * Generates a proper multi-resolution Windows .ico for the electron-builder
 * MSI/EXE packaging to use as the application icon.
 *
 * Windows icon resources must be square and the artwork should fill the icon
 * canvas (otherwise the logo renders as a tiny object surrounded by huge
 * transparent padding, which looks wrong next to normal Windows apps). This
 * script:
 *
 *   1. Reads the source artwork. It may be a PNG, or a .ico whose PNG frames
 *      are parsed (the largest PNG frame is used as the artwork source).
 *   2. Trims any transparent margins from the artwork.
 *   3. Normalizes the trimmed artwork to a square via a centre-crop
 *      (fit: "cover") so the logo fills the whole canvas with no padding.
 *   4. Renders it at every standard Windows icon size and assembles the
 *      results into a single .ico (ICONDIR + PNG-encoded entries).
 *
 * This runs automatically as part of `npm run package:msi` — there is no need
 * to convert the icon by hand.
 */
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const root = path.resolve(__dirname, "..");

// Source icon supplied by the user. May be a .png or a .ico.
const SOURCE = process.env.SPATIA_ICON_PNG || "C:\\Users\\hakm\\Downloads\\ChatGPT Image 4 \u0633\u0628\u062a\u0645\u0628\u0631 2026\u060c 06_37_15 \u0635.png";
// Size (in pixels) of the square normalized artwork. Every icon size below is
// rendered as a (down/up) scale of this square.
const BASE = 256;
// Standard Windows icon sizes to embed.
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const OUT_DIR = path.join(root, "build");
const OUT_ICO = path.join(OUT_DIR, "icon.ico");

/**
 * Extract the largest PNG frame from a .ico file (ICONDIR + PNG-encoded
 * entries). Returns a Buffer, or null if no PNG frame is present.
 */
function largestPngFrameFromIco(fileBytes) {
  if (fileBytes.length < 6) return null;
  const isIco = fileBytes[0] === 0 && fileBytes[1] === 0 && fileBytes[2] === 1 && fileBytes[3] === 0;
  if (!isIco) return null;
  const count = fileBytes.readUInt16LE(4);
  let best = null;
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16;
    const width = fileBytes[off] === 0 ? 256 : fileBytes[off];
    const imgOff = fileBytes.readUInt32LE(off + 12);
    const size = fileBytes.readUInt32LE(off + 8);
    const isPng = fileBytes[imgOff] === 0x89 && fileBytes[imgOff + 1] === 0x50;
    if (isPng && (!best || width > best.width)) {
      best = { width, buf: fileBytes.slice(imgOff, imgOff + size) };
    }
  }
  return best ? best.buf : null;
}

/** Read source artwork bytes as a PNG-compatible buffer sharp can process. */
async function resolveSource(sourcePath) {
  const bytes = fs.readFileSync(sourcePath);
  const png = largestPngFrameFromIco(bytes);
  return png ?? bytes;
}

/** Assemble a multi-image ICO file from PNG-compressed image buffers. */
function buildIco(sizePngs) {
  const count = sizePngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const entries = [];
  const pngData = [];
  let offset = 6 + count * 16;

  for (const { size, buf } of sizePngs) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 == 256)
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height (0 == 256)
    entry.writeUInt8(0, 2); // color count
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(buf.length, 8); // bytes in resource
    entry.writeUInt32LE(offset, 12); // image offset
    entries.push(entry);
    pngData.push(buf);
    offset += buf.length;
  }

  return Buffer.concat([header, ...entries, ...pngData]);
}

async function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error(`[make-ico] Source icon not found: ${SOURCE}`);
    process.exit(1);
  }

  console.log(`[make-ico] Reading source icon: ${SOURCE}`);

  const artwork = await resolveSource(SOURCE);

  // Remove any surrounding transparent margins so the logo fills the canvas.
  const trimmed = await sharp(artwork).trim().png().toBuffer();

  // Normalize to a square via centre-crop, filling every pixel (no padding).
  const square = await sharp(trimmed)
    .resize(BASE, BASE, { fit: "cover", position: "centre" })
    .png()
    .toBuffer();

  // Render every icon size from the square artwork.
  const sizePngs = [];
  for (const size of SIZES) {
    const png = await sharp(square).resize(size, size).png().toBuffer();
    sizePngs.push({ size, buf: png });
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_ICO, buildIco(sizePngs));
  console.log(`[make-ico] Wrote ${OUT_ICO} (${sizePngs.length} resolutions: ${SIZES.join(", ")})`);
}

main().catch((err) => {
  console.error("[make-ico] Failed:", err);
  process.exit(1);
});
