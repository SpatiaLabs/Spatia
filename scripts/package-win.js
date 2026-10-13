"use strict";

/**
 * Package the Windows desktop build (MSI by default) with opt-in code signing.
 *
 * Signing is enabled ONLY when a certificate is supplied through the
 * environment, so local and CI builds without secrets still succeed (unsigned):
 *
 *   WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD   (preferred, per-platform)
 *   CSC_LINK / CSC_KEY_PASSWORD           (electron-builder standard)
 *
 * An unsigned MSI installs and runs, but Windows SmartScreen warns users that
 * the publisher is unknown; supply a real EV/OV code-signing certificate to
 * remove that warning.
 *
 * Usage: node scripts/package-win.js [target] [extra electron-builder args]
 *   target defaults to "msi" (also: zip, nsis, portable, ...).
 */

const path = require("node:path");
const { spawnSync } = require("node:child_process");

function firstEnv() {
  for (let i = 0; i < arguments.length; i++) {
    const name = arguments[i];
    const value = process.env[name];
    if (value && value.trim()) return { name, value: value.trim() };
  }
  return null;
}

function main() {
  const argv = process.argv.slice(2);
  const target = argv.find((a) => !a.startsWith("-")) || "msi";
  const passthrough = argv.filter((a) => a.startsWith("-"));

  const link = firstEnv("WIN_CSC_LINK", "CSC_LINK");
  const password = firstEnv("WIN_CSC_KEY_PASSWORD", "CSC_KEY_PASSWORD");

  const env = Object.assign({}, process.env);
  if (link) {
    env.CSC_LINK = link.value;
    if (password) env.CSC_KEY_PASSWORD = password.value;
    console.log(`[package:win] Code signing enabled (certificate from ${link.name}).`);
  } else {
    console.warn("[package:win] No code-signing certificate found (set CSC_LINK / WIN_CSC_LINK).");
    console.warn("[package:win] Building an UNSIGNED installer - Windows will show an \"Unknown publisher\" warning.");
  }

  const bin = path.join(
    __dirname,
    "..",
    "node_modules",
    ".bin",
    process.platform === "win32" ? "electron-builder.cmd" : "electron-builder"
  );
  const result = spawnSync(bin, ["--win", target].concat(passthrough), {
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  });
  if (result.error) {
    console.error(`[package:win] Could not run electron-builder: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status == null ? 1 : result.status);
}

main();
