"use strict";

/**
 * Converts the raw PNG captures into performance-tuned WebP screenshots for the
 * site (resized to a reasonable max width, metadata stripped).
 *
 * Run with:  node ../../../../node_modules/sharp/...
 * or simply: node optimize.cjs   (it resolves sharp from the project's node_modules)
 */

const fs = require("fs");
const path = require("path");

const BASE = path.resolve(__dirname, "..", "..");
const RAW = path.join(BASE, "assets", "raw");
const OUT = path.join(BASE, "assets", "screenshots");
const MAX_WIDTH = 1280;
const QUALITY = 82;

function resolveSharp() {
  const candidates = [
    path.resolve(__dirname, "..", "..", "..", "..", "node_modules", "sharp"),
    path.resolve(__dirname, "..", "..", "..", "node_modules", "sharp"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "package.json"))) return require(c);
  }
  throw new Error("sharp not found — install it or run from the repo root");
}

async function main() {
  const sharp = resolveSharp();
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(RAW)) {
    process.stdout.write("no raw captures found — run screenshot.cjs first\n");
    process.exit(1);
  }
  const files = fs.readdirSync(RAW).filter((f) => f.endsWith(".png"));
  if (files.length === 0) {
    process.stdout.write("no raw captures found — run screenshot.cjs first\n");
    process.exit(1);
  }
  for (const f of files) {
    const src = path.join(RAW, f);
    const out = path.join(OUT, f.replace(/\.png$/, ".webp"));
    const info = await sharp(src).metadata();
    let builder = sharp(src);
    if (info.width && info.width > MAX_WIDTH) {
      builder = builder.resize({ width: MAX_WIDTH, withoutEnlargement: true });
    }
    await builder
      .webp({ quality: QUALITY, effort: 4 })
      .toFile(out);
    const before = fs.statSync(src).size;
    const after = fs.statSync(out).size;
    process.stdout.write(`  ${f} -> ${path.basename(out)} (${(before / 1024).toFixed(0)}KB -> ${(after / 1024).toFixed(0)}KB)\n`);
  }
  fs.rmSync(RAW, { recursive: true, force: true });
  process.stdout.write("done\n");
}

main().catch((err) => {
  process.stderr.write("optimize failed: " + (err && err.stack ? err.stack : err) + "\n");
  process.exit(1);
});