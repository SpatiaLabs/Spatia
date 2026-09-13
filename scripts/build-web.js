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

// Spawn the TypeScript compiler as plain node code instead of going through the
// `node_modules/.bin/tsc.cmd` shim. On Windows, spawning a `.cmd` through
// spawnSync without a shell fails with EINVAL and a null status, which made the
// build exit silently and leave web/js + web/app.css stale. Running tsc.js
// directly works on every platform and avoids shell quoting of the space in
// "Spatia Download & Web".
const tscJs = require.resolve("typescript/lib/tsc.js");
const result = spawnSync(process.execPath, [tscJs, "-p", path.join(site, "web", "tsconfig.json")], { stdio: "inherit" });
if (result.error) {
  console.error(`Web build failed: could not run tsc (${result.error.message}).`);
  process.exit(1);
}
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

// The web build must render exactly like the desktop app. The #app shell and
// the shared stylesheet are copied from the same sources, so fail the build if
// the website's HTML shell ever drifts from the renderer's.
const checkParity = path.join(__dirname, "check-web-parity.cjs");
const gate = spawnSync(process.execPath, [checkParity], { stdio: "inherit" });
if (gate.error || gate.status !== 0) {
  console.error("Web build failed: web/desktop parity check did not pass.");
  process.exit(gate.error ? 1 : (gate.status ?? 1));
}

console.log("Web build complete.");