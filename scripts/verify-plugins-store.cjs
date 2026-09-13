/* eslint-disable */
/*
 * Plain-Node verification of the desktop plugin store (src/main/plugins.ts →
 * dist/main/main/plugins.js). Node, not Electron, so it runs fast and headless.
 * Requires `npm run build:main` first (the CJS bundle lives in dist/main).
 *
 * Run: node scripts/verify-plugins-store.cjs
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const storeModule = require(path.join(__dirname, "..", "dist", "main", "main", "plugins.js"));
const { PluginStore } = storeModule;

async function makeTmpDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `spatia-plugins-${tag}-`));
  return dir;
}

function writeFile(dir, name, contents) {
  const dest = path.join(dir, name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, contents, "utf8");
  return dest;
}

const VALID_MANIFEST = {
  id: "verify-tool",
  name: "Verify Tool",
  version: "1.0.0",
  description: "Used by the store verification script.",
  author: "Spatia QA",
  main: "main.js",
  apiVersion: 1,
};

const VALID_MAIN = `api.addCommand({
  id: "verify.tool",
  label: "Verify tool",
  run: function () { api.notify("verify ran"); },
});
`;

let failures = 0;
async function check(label, fn) {
  try {
    await fn();
    console.log(`  ok  ${label}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${label}: ${err && err.message ? err.message : err}`);
  }
}

(async function main() {
  const log = console.log;
  log("verifying desktop plugin store...");

  await check("creates base dir and seeds the built-in plugin", async () => {
    const base = await makeTmpDir("seed");
    const store = new PluginStore(base);
    const entries = await store.list();
    const bf = entries.find((e) => e.id === "browser-frame");
    assert.ok(bf, "browser-frame exists after first list()");
    assert.equal(bf.builtIn, true);
    assert.equal(bf.enabled, true);
    assert.ok(bf.manifest, "manifest is valid");
    assert.equal(bf.manifest.main, "main.js");
    assert.ok(fs.existsSync(path.join(base, "browser-frame", "main.js")), "main.js written");
    assert.ok(fs.existsSync(path.join(base, "browser-frame", "manifest.json")), "manifest.json written");
    assert.equal(entries.some((e) => e.id === "example-plugin"), false, "retired built-in is never seeded");
  });

  await check("seeding is idempotent", async () => {
    const base = await makeTmpDir("idem");
    const a = await new PluginStore(base).list();
    const b = await new PluginStore(base).list();
    assert.equal(a.length, b.length);
    assert.deepEqual(a.map((e) => e.id), b.map((e) => e.id));
  });

  await check("getSource returns manifest + main", async () => {
    const base = await makeTmpDir("source");
    const store = new PluginStore(base);
    const src = await store.getSource("browser-frame");
    assert.ok(src, "source found");
    assert.equal(src.manifest.id, "browser-frame");
    assert.ok(typeof src.main === "string" && src.main.length > 0, "main source non-empty");
    assert.equal(await store.getSource("does-not-exist"), null);
  });

  await check("setEnabled persists to _state.json", async () => {
    const base = await makeTmpDir("toggle");
    const store = new PluginStore(base);
    assert.equal(await store.setEnabled("browser-frame", false), true);
    const after = await new PluginStore(base).list();
    const bf = after.find((e) => e.id === "browser-frame");
    assert.equal(bf.enabled, false);
    const state = JSON.parse(fs.readFileSync(path.join(base, "_state.json"), "utf8"));
    assert.equal(state["browser-frame"], false);
    assert.equal(await store.setEnabled("nope", true), false, "unknown plugin rejected");
  });

  await check("installFromFolder installs a valid plugin", async () => {
    const base = await makeTmpDir("install");
    const store = new PluginStore(base);
    const pkg = await makeTmpDir("pkg");
    writeFile(pkg, "manifest.json", JSON.stringify(VALID_MANIFEST, null, 2));
    writeFile(pkg, "main.js", VALID_MAIN);
    const result = await store.installFromFolder(pkg);
    assert.equal(result.ok, true);
    assert.ok(result.entry, "entry returned");
    assert.equal(result.entry.id, "verify-tool");
    assert.equal(result.entry.enabled, true);
    const list = await store.list();
    assert.ok(list.find((e) => e.id === "verify-tool"), "installed plugin listed");
  });

  await check("installFromFolder rejects a duplicate id", async () => {
    const base = await makeTmpDir("dup");
    const store = new PluginStore(base);
    const pkg = await makeTmpDir("pkgdup");
    writeFile(pkg, "manifest.json", JSON.stringify(VALID_MANIFEST, null, 2));
    writeFile(pkg, "main.js", VALID_MAIN);
    assert.equal((await store.installFromFolder(pkg)).ok, true);
    const again = await store.installFromFolder(pkg);
    assert.equal(again.ok, false);
    assert.match(again.error || "", /already installed/);
  });

  await check("installFromFolder rejects a folder without manifest.json", async () => {
    const base = await makeTmpDir("nomanifest");
    const pkg = await makeTmpDir("emptypkg");
    writeFile(pkg, "main.js", VALID_MAIN);
    const result = await new PluginStore(base).installFromFolder(pkg);
    assert.equal(result.ok, false);
    assert.match(result.error || "", /does not contain a manifest\.json/);
  });

  await check("installFromFolder rejects an invalid manifest", async () => {
    const base = await makeTmpDir("badmanifest");
    const pkg = await makeTmpDir("badpkg");
    writeFile(pkg, "manifest.json", JSON.stringify({ id: "broken", version: "1", main: "../../etc/passwd" }));
    writeFile(pkg, "main.js", "api.notify('x');");
    const result = await new PluginStore(base).installFromFolder(pkg);
    assert.equal(result.ok, false);
    assert.ok(result.error, "error message present");
  });

  await check("installFromSource installs a validated manifest + main", async () => {
    const base = await makeTmpDir("remote");
    const store = new PluginStore(base);
    const result = await store.installFromSource("verify-tool", VALID_MANIFEST, VALID_MAIN);
    assert.equal(result.ok, true);
    assert.ok(result.entry, "entry returned");
    assert.equal(result.entry.id, "verify-tool");
    assert.equal(result.entry.enabled, true);
    const src = await store.getSource("verify-tool");
    assert.ok(src, "source readable");
    assert.equal(src.main, VALID_MAIN);
    assert.ok(fs.existsSync(path.join(base, "verify-tool", "main.js")), "main.js written");
    assert.ok(fs.existsSync(path.join(base, "verify-tool", "manifest.json")), "manifest.json written");
  });

  await check("installFromSource rejects a duplicate id", async () => {
    const base = await makeTmpDir("remotedup");
    const store = new PluginStore(base);
    assert.equal((await store.installFromSource("verify-tool", VALID_MANIFEST, VALID_MAIN)).ok, true);
    const again = await store.installFromSource("verify-tool", VALID_MANIFEST, VALID_MAIN);
    assert.equal(again.ok, false);
    assert.match(again.error || "", /already installed/);
  });

  await check("installFromSource rejects an id/manifest mismatch", async () => {
    const base = await makeTmpDir("remotemis");
    const store = new PluginStore(base);
    const result = await store.installFromSource("other-id", VALID_MANIFEST, VALID_MAIN);
    assert.equal(result.ok, false);
    assert.match(result.error || "", /mismatch/);
  });

  await check("remove deletes user plugins but refuses built-ins", async () => {
    const base = await makeTmpDir("remove");
    const store = new PluginStore(base);
    const pkg = await makeTmpDir("pkgrm");
    writeFile(pkg, "manifest.json", JSON.stringify(VALID_MANIFEST, null, 2));
    writeFile(pkg, "main.js", VALID_MAIN);
    await store.installFromFolder(pkg);
    assert.equal(await store.remove("verify-tool"), true);
    assert.equal(await new PluginStore(base).getSource("verify-tool"), null);
    assert.equal(await store.remove("browser-frame"), false, "built-ins are protected");
    assert.ok(await new PluginStore(base).getSource("browser-frame"), "built-in still seeded");
  });

  await check("a retired built-in seed is pruned from existing installs", async () => {
    const base = await makeTmpDir("legacy");
    const dir = path.join(base, "example-plugin");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ id: "example-plugin", main: "main.js" }), "utf8");
    fs.writeFileSync(path.join(dir, "main.js"), "api.notify('stale');", "utf8");
    const state = path.join(base, "_state.json");
    fs.writeFileSync(state, JSON.stringify({ "example-plugin": true }, null, 2), "utf8");
    const entries = await new PluginStore(base).list();
    assert.equal(entries.some((e) => e.id === "example-plugin"), false, "legacy entry gone from list");
    assert.ok(!fs.existsSync(dir), "legacy directory removed");
    const stateAfter = JSON.parse(fs.readFileSync(state, "utf8"));
    assert.equal("example-plugin" in stateAfter, false, "legacy flag removed from state");
    assert.equal(await new PluginStore(base).getSource("example-plugin"), null, "legacy plugin can no longer load");
  });

  await check("a broken plugin entry does not crash list()", async () => {
    const base = await makeTmpDir("broken");
    const store = new PluginStore(base);
    const dir = path.join(base, "broken-plugin");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), "not json", "utf8");
    const entries = await store.list();
    const broken = entries.find((e) => e.id === "broken-plugin");
    assert.ok(broken, "broken entry listed");
    assert.equal(broken.manifest, null);
    assert.ok(broken.error, "has an error message");
    assert.equal(await store.getSource("broken-plugin"), null, "no source for broken plugin");
  });

  console.log(failures === 0 ? "plugin store OK" : `${failures} plugin store check(s) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});