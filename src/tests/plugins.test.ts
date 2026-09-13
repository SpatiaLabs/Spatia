import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePluginManifest, PLUGIN_API_VERSION } from "../shared/plugins/manifest.js";
import { BUILTIN_PLUGINS, BUILTIN_PLUGIN_IDS } from "../shared/plugins/builtin.js";
import type { PluginManifest } from "../shared/plugins/manifest.js";
import { browserUrlOf, normalizeBrowserUrl } from "../shared/plugins/browserFrame.js";

/**
 * The manifest contract is shared by the desktop main process (folder install),
 * the Web bridge (IndexedDB install) and the renderer. If validation is wrong,
 * plugins can break the app on every one of those surfaces — so it gets its own
 * suite before any integration testing happens.
 */

const VALID: PluginManifest = {
  id: "my-plugin",
  name: "My Plugin",
  version: "1.2.3",
  main: "main.js",
};

test("validatePluginManifest accepts a minimal valid manifest", () => {
  const r = validatePluginManifest(VALID);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.manifest.id, "my-plugin");
    assert.equal(r.manifest.apiVersion, PLUGIN_API_VERSION, "apiVersion defaults to current");
    assert.equal(r.manifest.permissions, undefined, "no permissions field means full v1-compatible access");
  }
});

test("validatePluginManifest preserves unknown fields but types the known ones", () => {
  const r = validatePluginManifest({ ...VALID, homepage: "https://example.com" });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.manifest.homepage, "https://example.com");
  }
});

test("validatePluginManifest rejects a missing id", () => {
  const { name, version, main } = VALID;
  const r = validatePluginManifest({ name, version, main });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /"id" is required/);
});

test("validatePluginManifest rejects path traversal in main", () => {
  const r = validatePluginManifest({ ...VALID, main: "../evil.js" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /must be a plain relative \.js/);
});

test("validatePluginManifest rejects non-semantic versions", () => {
  const r = validatePluginManifest({ ...VALID, version: "banana" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /must look like "1\.0\.0"/);
});

test("validatePluginManifest rejects a future apiVersion", () => {
  const r = validatePluginManifest({ ...VALID, apiVersion: PLUGIN_API_VERSION + 1 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /requires plugin API v/);
});

test("validatePluginManifest rejects non-object input", () => {
  const r = validatePluginManifest("nope");
  assert.equal(r.ok, false);
});

test("validatePluginManifest accepts an explicit permissions set and de-dupes it", () => {
  const r = validatePluginManifest({ ...VALID, apiVersion: 2, permissions: ["view", "documents", "view"] });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.manifest.permissions, ["view", "documents"]);
  }
});

test("validatePluginManifest rejects unknown permissions", () => {
  const r = validatePluginManifest({ ...VALID, apiVersion: 2, permissions: ["view", "sudo"] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /unknown permission "sudo"/);
});

test("validatePluginManifest rejects an empty permissions array", () => {
  const r = validatePluginManifest({ ...VALID, apiVersion: 2, permissions: [] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /at least one permission/);
});

test("validatePluginManifest rejects non-string permissions entries", () => {
  const r = validatePluginManifest({ ...VALID, apiVersion: 2, permissions: ["view", 42] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /must be strings/);
});

test("built-in plugins all validate", () => {
  for (const b of BUILTIN_PLUGINS) {
    const r = validatePluginManifest(b.manifest);
    assert.equal(r.ok, true, `${b.manifest.id} manifest must validate`);
    if (r.ok) assert.ok(r.manifest.main.length > 0, "main file name present");
    assert.equal(typeof b.main, "string", `${b.manifest.id} must have main source`);
    assert.ok(b.main.length > 0, `${b.manifest.id} main source not empty`);
  }
  assert.deepEqual(
    BUILTIN_PLUGIN_IDS,
    BUILTIN_PLUGINS.map((b) => b.manifest.id),
    "ids derive from manifests"
  );
});

test("browserFrame normalizeBrowserUrl produces loadable http(s) addresses", () => {
  assert.equal(normalizeBrowserUrl("example.com"), "https://example.com/");
  assert.equal(normalizeBrowserUrl("https://www.google.com"), "https://www.google.com/");
  assert.equal(normalizeBrowserUrl("why is the sky blue").startsWith("https://www.google.com/search?q="), true);
  assert.equal(normalizeBrowserUrl("ftp://example.com"), "", "non-http schemes are rejected");
  assert.equal(normalizeBrowserUrl("https://user:pw@example.com"), "", "credentials in URLs are rejected");
  assert.equal(normalizeBrowserUrl("   "), "", "blank input yields no URL");
  assert.equal(normalizeBrowserUrl("not a host"), "https://www.google.com/search?q=not%20a%20host");
});

test("browserFrame browserUrlOf reads the metadata key", () => {
  assert.equal(browserUrlOf(undefined), "");
  assert.equal(browserUrlOf({ metadata: { browserUrl: "https://example.com/" } }), "https://example.com/");
  assert.equal(browserUrlOf({ metadata: { browserUrl: 42 } }), "");
  assert.equal(browserUrlOf({ metadata: {} }), "");
});