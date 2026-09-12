"use strict";

/**
 * Generates the brand icon set (site/PWA) from the REAL Spatia icon PNG that
 * was exported from build/icon.ico (web/sample/spatia-icon.png).
 *
 * Run with:  node web/scripts/generate-icons.cjs
 * (requires the project's local `sharp`, which is already a dev dependency)
 */

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const BASE = path.resolve(__dirname, "..", ".."); // "Spatia Download & Web"
const INPUT = path.join(BASE, "web", "sample", "spatia-icon.png");
const OUT_DIR = path.join(BASE, "assets");

const SIZES = [
  { name: "icon-48.png", size: 48 },
  { name: "icon-180.png", size: 180 },
  { name: "icon-192.png", size: 192 },
  { name: "icon-512.png", size: 512 },
];

async function main() {
  if (!fs.existsSync(INPUT)) throw new Error(`missing source icon: ${INPUT}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const meta = await sharp(INPUT).metadata();
  console.log(`source icon: ${meta.width}x${meta.height}`);

  // Solid background color sampled from the icon's corner so the maskable
  // safe-zone visually continues the icon's own background.
  const corner = await sharp(INPUT)
    .extract({ left: 0, top: 0, width: 1, height: 1 })
    .ensureAlpha()
    .raw()
    .toBuffer();
  const bg = { r: corner[0], g: corner[1], b: corner[2], alpha: 255 };
  console.log(`maskable background sampled: rgb(${bg.r}, ${bg.g}, ${bg.b})`);

  for (const { name, size } of SIZES) {
    const out = path.join(OUT_DIR, name);
    await sharp(INPUT).resize(size, size).png().toFile(out);
    console.log(`  wrote ${name} (${size}x${size})`);
  }

  // Maskable: logo at 80% of the canvas so it clears the mask safe-zone.
  const maskSize = 512;
  const logoSize = Math.round(maskSize * 0.8);
  const offset = Math.round((maskSize - logoSize) / 2);
  const logo = await sharp(INPUT).resize(logoSize, logoSize).png().toBuffer();
  await sharp({ create: { width: maskSize, height: maskSize, channels: 4, background: bg } })
    .composite([{ input: logo, left: offset, top: offset }])
    .png()
    .toFile(path.join(OUT_DIR, "icon-maskable-512.png"));
  console.log(`  wrote icon-maskable-512.png (${maskSize}x${maskSize}, logo ${logoSize}px)`);

  console.log("icon set complete.");
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});