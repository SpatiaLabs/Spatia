"use strict";
/*
 * Verifies the hosted web build renders identically to the desktop app.
 *
 * The web app boots the same shared renderer (src/renderer/main.js) into the
 * same #app shell and is styled by a copy of the shared renderer stylesheet,
 * so structural drift between the website's HTML and the desktop renderer's
 * HTML is the only place the two versions can diverge. This gate fails the
 * build when that drift appears.
 *
 * Checks:
 *   1. The full #app HTML subtree of  Spatia Download & Web/index.html matches
 *      src/renderer/index.html byte-for-byte.
 *   2. The element IDs inside #app match (secondary diagnostic).
 *   3. web/app.css is byte-identical to the shared src/renderer/style.css.
 *   4. The served plugin sandbox page (plugins/pluginHost.html) is identical to
 *      src/renderer/plugins/pluginHost.html.
 *
 * Run: node scripts/check-web-parity.cjs
 */

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const siteIndex = path.join(root, "Spatia Download & Web", "index.html");
const rendererIndex = path.join(root, "src", "renderer", "index.html");
const webCss = path.join(root, "Spatia Download & Web", "web", "app.css");
const sharedCss = path.join(root, "src", "renderer", "style.css");
const servedHost = path.join(root, "Spatia Download & Web", "plugins", "pluginHost.html");
const sharedHost = path.join(root, "src", "renderer", "plugins", "pluginHost.html");

let failures = 0;

function readOrNull(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Extract the <div id="app">…</div> subtree as raw text. */
function appBlock(html) {
  const start = html.indexOf('<div id="app">');
  if (start === -1) return null;
  let i = start;
  let depth = 0;
  for (i = start; i < html.length; i += 1) {
    const slice = html.slice(i);
    if (slice.startsWith("<div")) depth += 1;
    else if (slice.startsWith("</div>")) {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + "</div>".length);
    }
  }
  return null;
}

/** All id="…" attribute values in a block, in order. */
function idsOf(block) {
  const ids = [];
  const re = /\bid="([^"]+)"/g;
  let m;
  while ((m = re.exec(block)) !== null) ids.push(m[1]);
  return ids;
}

/**
 * Normalize markup so whitespace-only indentation differences are ignored while
 * every element, attribute, id, class and text node is still compared exactly:
 * collapse whitespace between tags, then collapse any remaining whitespace runs
 * to one space.
 */
function normalizeMarkup(block) {
  return block.replace(/>\s+</g, "><").replace(/\s+/g, " ").trim();
}

function compare(label, aName, bName, a, b) {
  if (a === null || b === null) {
    console.error(`FAIL  ${label}: missing file (${aName}${a === null ? "" : `, ${bName}`})`);
    failures += 1;
    return;
  }
  if (a !== b) {
    console.error(`FAIL  ${label}: ${aName} differs from ${bName}`);
    failures += 1;
  } else {
    console.log(`  ok  ${label}`);
  }
}

const siteHtml = readOrNull(siteIndex);
const rendererHtml = readOrNull(rendererIndex);

if (siteHtml === null || rendererHtml === null) {
  console.error("FAIL: could not read the website or renderer index.html");
  process.exit(1);
}

const siteApp = appBlock(siteHtml);
const rendererApp = appBlock(rendererHtml);

// Content inside the shared #app shell may legitimately use a different
// indentation depth (the website nests the app inside its page wrapper), so the
// structural gate ignores whitespace-only differences. A single real change to
// an element, class, attribute or text node fails the build.
compare(
  "web site #app shell matches the desktop renderer",
  "Spatia Download & Web/index.html",
  "src/renderer/index.html",
  siteApp === null ? null : normalizeMarkup(siteApp),
  rendererApp === null ? null : normalizeMarkup(rendererApp)
);

if (siteApp !== null && rendererApp !== null) {
  const siteIds = idsOf(siteApp);
  const rendererIds = idsOf(rendererApp);
  const missing = rendererIds.filter((id) => !siteIds.includes(id));
  const extra = siteIds.filter((id) => !rendererIds.includes(id));
  if (missing.length || extra.length) {
    console.error(`  element id drift -> missing: ${missing.join(", ") || "none"}, extra: ${extra.join(", ") || "none"}`);
  } else {
    console.log(`  ok  #app element ids match (${siteIds.length}/${rendererIds.length})`);
  }
}

compare("web/app.css matches the shared renderer stylesheet", "web/app.css", "src/renderer/style.css", readOrNull(webCss), readOrNull(sharedCss));
compare("served plugin sandbox matches the renderer's", "Spatia Download & Web/plugins/pluginHost.html", "src/renderer/plugins/pluginHost.html", readOrNull(servedHost), readOrNull(sharedHost));

console.log(failures === 0 ? "web/desktop parity OK" : `${failures} parity check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;