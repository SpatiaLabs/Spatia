/**
 * One-off build-aid: appends `.js` to relative (./ ../) import specifiers in
 * all TypeScript sources. Needed because the renderer compiles to native ES
 * modules where the browser requires explicit file extensions, while the main
 * process uses CommonJS (which also resolves `./x.js` to the compiled file).
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "src");

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, acc);
    } else if (entry.name.endsWith(".ts")) {
      acc.push(full);
    }
  }
  return acc;
}

const re = /(from\s+["'])(\.\.?\/[^"']+)(["'])/g;

let changedFiles = 0;
for (const file of walk(root)) {
  const src = fs.readFileSync(file, "utf8");
  const out = src.replace(re, (_m, pre, spec, post) => {
    if (/\.(js|json|css)$/.test(spec)) return _m;
    return `${pre}${spec}.js${post}`;
  });
  if (out !== src) {
    fs.writeFileSync(file, out, "utf8");
    changedFiles++;
    console.log("updated", path.relative(root, file));
  }
}
console.log(`done; ${changedFiles} files updated`);
