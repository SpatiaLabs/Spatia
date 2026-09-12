/**
 * Copies static renderer assets (index.html, style.css, the plugin sandbox
 * host, and any other static files) from src/renderer into the compiled output
 * directory dist/renderer. Static assets are mirrored verbatim; the plugin host
 * page ships as-is on both platforms.
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const srcDir = path.join(root, "src", "renderer");
const outDir = path.join(root, "dist", "renderer");

const assets = ["index.html", "style.css", path.join("plugins", "pluginHost.html")];

fs.mkdirSync(outDir, { recursive: true });

for (const file of assets) {
  const from = path.join(srcDir, file);
  const to = path.join(outDir, file);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.log(`copied ${path.relative(root, from)} -> ${path.relative(root, to)}`);
}