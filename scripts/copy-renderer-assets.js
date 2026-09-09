/**
 * Copies static renderer assets (index.html, style.css, the plugin sandbox
 * host, and any other static files) from src/renderer into the compiled output
 * directory dist/renderer. Static assets are mirrored verbatim; the plugin host
 * page ships as-is on both platforms.
 *
 * It also stages the Local-AI runtime (wllama library + its local compat build)
 * into dist/renderer/ai for the desktop app only. The web workspace is
 * intentionally kept free of the AI module.
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

// -------- Local AI runtime (desktop only) --------
const wllama = path.join(root, "node_modules", "@wllama");
const aiVendor = [
  { from: path.join(wllama, "wllama", "esm", "index.min.js"), name: "wllama.min.js" },
  { from: path.join(wllama, "wllama-compat", "wasm", "wllama.js"), name: "compat.js" },
  { from: path.join(wllama, "wllama-compat", "wasm", "wllama.wasm"), name: "compat.wasm" },
];
const aiTarget = path.join(outDir, "ai");

fs.mkdirSync(path.join(aiTarget, "vendor"), { recursive: true });
const runtime = path.join(srcDir, "ai", "ai.js");
const runtimeTo = path.join(aiTarget, "ai.js");
fs.copyFileSync(runtime, runtimeTo);
console.log(`copied ${path.relative(root, runtime)} -> ${path.relative(root, runtimeTo)}`);
for (const f of aiVendor) {
  const to = path.join(aiTarget, "vendor", f.name);
  fs.copyFileSync(f.from, to);
  console.log(`copied ${path.relative(root, f.from)} -> ${path.relative(root, to)}`);
}