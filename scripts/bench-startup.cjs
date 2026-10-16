/**
 * Startup benchmark harness.
 *
 * Spawns the built desktop app with SPATIA_BENCH=1, which makes the main and
 * renderer processes emit `[bench] <phase> +<ms>` lines to stdout. The run ends
 * itself once the renderer reports its first interactive frame.
 *
 * Usage:  node scripts/bench-startup.cjs [iterations]
 *
 * Reports wall-clock time from spawn to exit, plus every parsed phase mark
 * (median across iterations).
 */

"use strict";

const { spawn } = require("child_process");
const path = require("path");

const ELE_BIN = path.join(__dirname, "..", "node_modules", "electron", "dist", "electron.exe");
const ROOT = path.join(__dirname, "..");
const ITERATIONS = Math.max(1, parseInt(process.argv[2] || "5", 10));
const TIMEOUT_MS = 30000;

function runOnce() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(ELE_BIN, ["."], {
      cwd: ROOT,
      env: { ...process.env, SPATIA_BENCH: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const marks = new Map();
    const arrivals = new Map();
    let out = "";
    const feed = (chunk) => {
      const text = chunk.toString();
      out += text;
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        const m = /^\[bench\]\s+(\S+)\s+\+(\d+)ms/.exec(line.trim());
        if (m) {
          marks.set(m[1], Number(m[2]));
          if (!arrivals.has(m[1])) arrivals.set(m[1], Date.now() - started);
        }
      }
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timeout after ${TIMEOUT_MS}ms\n${out}`));
    }, TIMEOUT_MS);

    child.on("exit", () => {
      clearTimeout(timer);
      const wall = Date.now() - started;
      resolve({ wall, marks, arrivals });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

(async () => {
  console.log(`Running ${ITERATIONS} startup iteration(s)...`);
  const runs = [];
  for (let i = 0; i < ITERATIONS; i++) {
    try {
      const r = await runOnce();
      runs.push(r);
      console.log(
        `  #${i + 1}  wall=${r.wall}ms  ` +
          `interactive=${r.marks.get("renderer:interactive")}ms  ` +
          `dom-ready=${r.marks.get("renderer:dom-ready")}ms`
      );
    } catch (err) {
      console.error(`  #${i + 1}  FAILED: ${err.message}`);
    }
  }

  if (!runs.length) {
    console.error("No successful runs.");
    process.exit(1);
  }

  const keys = new Set();
  runs.forEach((r) => r.marks.forEach((_, k) => keys.add(k)));

  console.log("\nPhase (median ms from process start):");
  for (const key of [...keys].sort()) {
    const vals = runs.map((r) => r.marks.get(key)).filter((v) => typeof v === "number");
    if (vals.length) console.log(`  ${key.padEnd(34)} ${median(vals)}`);
  }
  console.log(`  ${"WALL (spawn -> exit)".padEnd(34)} ${median(runs.map((r) => r.wall))}`);

  // Arrival times are measured directly by the harness from spawn, so they
  // need no cross-process clock reconciliation.
  const arrKeys = new Set();
  runs.forEach((r) => r.arrivals.forEach((_, k) => arrKeys.add(k)));
  console.log("\nArrival from spawn (median ms, harness clock):");
  for (const key of [...arrKeys].sort()) {
    const vals = runs.map((r) => r.arrivals.get(key)).filter((v) => typeof v === "number");
    if (vals.length) console.log(`  ${key.padEnd(34)} ${median(vals)}`);
  }
})();
