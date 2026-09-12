/**
 * Builds the website's embedded Spatia web app from the shared renderer and
 * shared sources. The website (Spatia Download & Web/) loads the app from:
 *
 *   web/js/renderer/main.js                 - compiled renderer entry (ES modules)
 *   web/js/renderer/plugins/pluginHost.html - plugin sandbox page (copied from src)
 *   web/app.css                            - shared renderer stylesheet (copied)
 *
 * web/bridge.js and web/tsconfig.json are hand-written and committed alongside
 * the site; the `web/js/` output and regenerated `web/app.css` are build
 * artifacts and ignored.
 *
 * Run with `npm run build:web` after `npm install`.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const site = path.join(root, "Spatia Download & Web");
const webJsOut = path.join(site, "web", "js");

const tsc = path.join(root, "node_modules", ".bin", "tsc.cmd");
const result = spawnSync(tsc, ["-p", path.join(site, "web", "tsconfig.json")], { stdio: "inherit" });
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const copies = [
  ["src/renderer/style.css", "Spatia Download & Web/web/app.css"],
  ["src/renderer/plugins/pluginHost.html", "Spatia Download & Web/web/js/renderer/plugins/pluginHost.html"],
];

for (const [fromRel, toRel] of copies) {
  const to = path.join(root, toRel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(root, fromRel), to);
  console.log(`copied ${fromRel} -> ${toRel}`);
}

console.log("Web build complete.");