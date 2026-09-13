import { promises as fs } from "node:fs";
import path from "node:path";
import {
  validatePluginManifest,
  type PluginEntry,
  type PluginInstallResult,
  type PluginManifest,
  type PluginSource,
} from "../shared/plugins/manifest.js";
import { BUILTIN_PLUGINS, BUILTIN_PLUGIN_IDS } from "../shared/plugins/builtin.js";

/**
 * Built-in ids that shipped in older versions but are no longer built in.
 * Installs that were seeded by a previous version still carry the directory
 * and its _state.json flag; `ensure()` prunes them so a retired built-in can
 * never be seen or loaded again. A user plugin that happens to share one of
 * these ids is intentionally left untouched.
 */
const LEGACY_BUILTIN_IDS = ["example-plugin"];

/**
 * Desktop plugin store — PURE NODE (no electron import) so it can be
 * unit-tested with plain `node`. Layout under `baseDir` (typical value:
 * `app.getPath("userData")/plugins`):
 *
 *   <baseDir>/
 *     _state.json        { "<plugin-id>": enabled }
 *     <plugin-id>/manifest.json
 *     <plugin-id>/main.js
 *     <plugin-id>/assets/   (optional, copied on install)
 *
 * Built-ins are seeded from shared BUILTIN_PLUGINS on first run. They behave
 * like normal installable entries but cannot be removed. All writes are atomic
 * (temp file + rename) so a crash cannot corrupt state.
 */

export class PluginStore {
  private readonly stateFile: string;

  constructor(readonly baseDir: string) {
    this.stateFile = path.join(baseDir, "_state.json");
  }

  /** Create the plugins directory, seed the built-in plugins, and prune retired
   * built-in seeds left behind by previous versions. */
  async ensure(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    for (const b of BUILTIN_PLUGINS) {
      const dir = path.join(this.baseDir, b.manifest.id);
      await fs.mkdir(dir, { recursive: true });
      await writeIfDifferent(path.join(dir, "manifest.json"), JSON.stringify(b.manifest, null, 2));
      await writeIfDifferent(path.join(dir, "main.js"), b.main);
    }
    let state = await this.readState();
    let changed = false;
    for (const id of LEGACY_BUILTIN_IDS) {
      if (await dirExists(path.join(this.baseDir, id))) {
        await fs.rm(path.join(this.baseDir, id), { recursive: true, force: true });
        changed = true;
      }
      if (id in state) {
        delete state[id];
        changed = true;
      }
    }
    if (changed) await this.writeState(state);
  }

  async list(): Promise<PluginEntry[]> {
    await this.ensure();
    const state = await this.readState();
    const dirents = await fs.readdir(this.baseDir, { withFileTypes: true });
    const entries: PluginEntry[] = [];
    for (const dirent of dirents) {
      if (!dirent.isDirectory() || dirent.name.startsWith(".")) continue;
      const dir = path.join(this.baseDir, dirent.name);
      const manifest = await this.readManifest(dir);
      entries.push({
        id: dirent.name,
        manifest,
        builtIn: BUILTIN_PLUGIN_IDS.includes(dirent.name),
        enabled: state[dirent.name] !== undefined ? state[dirent.name] === true : true,
        error: manifest === null ? "Its manifest.json is missing or invalid." : undefined,
      });
    }
    entries.sort((a, b) => a.id.localeCompare(b.id));
    return entries;
  }

  async getSource(id: string): Promise<PluginSource | null> {
    await this.ensure();
    const dir = path.join(this.baseDir, id);
    const manifest = await this.readManifest(dir);
    if (!manifest) return null;
    try {
      const main = await fs.readFile(path.join(dir, manifest.main), "utf8");
      if (typeof main !== "string") return null;
      return { manifest, main };
    } catch {
      return null;
    }
  }

  async setEnabled(id: string, enabled: boolean): Promise<boolean> {
    await this.ensure();
    const dir = path.join(this.baseDir, id);
    const manifest = await this.readManifest(dir);
    if (!manifest) return false;
    const state = await this.readState();
    state[id] = enabled === true;
    await this.writeState(state);
    return true;
  }

  /** Copy a folder (containing manifest.json + main.js [+ assets/]) in. */
  async installFromFolder(folder: string): Promise<PluginInstallResult> {
    await this.ensure();
    const manifestPath = path.join(folder, "manifest.json");
    let raw: string;
    try {
      raw = await fs.readFile(manifestPath, "utf8");
    } catch {
      return { ok: false, error: "The selected folder does not contain a manifest.json." };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return { ok: false, error: "manifest.json is not valid JSON." };
    }
    const validation = validatePluginManifest(parsed);
    if (!validation.ok) return { ok: false, error: validation.error };
    const manifest = validation.manifest;

    const targetDir = path.join(this.baseDir, manifest.id);
    if (await dirExists(targetDir)) {
      return { ok: false, error: `A plugin with the id "${manifest.id}" is already installed.` };
    }

    const mainSource = path.join(folder, manifest.main);
    let main: string;
    try {
      main = await fs.readFile(mainSource, "utf8");
    } catch {
      return { ok: false, error: `${manifest.main} is missing in the plugin folder.` };
    }

    await fs.mkdir(targetDir, { recursive: true });
    try {
      await atomicWrite(path.join(targetDir, "manifest.json"), JSON.stringify(manifest, null, 2));
      await atomicWrite(path.join(targetDir, "main.js"), main);
      const assetsSource = path.join(folder, "assets");
      if (await dirExists(assetsSource)) {
        await fs.cp(assetsSource, path.join(targetDir, "assets"), { recursive: true });
      }
    } catch {
      await fs.rm(targetDir, { recursive: true, force: true });
      return { ok: false, error: "Could not copy the plugin folder." };
    }
    const state = await this.readState();
    state[manifest.id] = true;
    await this.writeState(state);
    return {
      ok: true,
      entry: { id: manifest.id, manifest, enabled: true, builtIn: false },
    };
  }

  /** Install a validated manifest + main fetched from a remote URL. */
  async installFromSource(id: string, manifest: PluginManifest, main: string): Promise<PluginInstallResult> {
    await this.ensure();
    if (id !== manifest.id) return { ok: false, error: "Plugin id mismatch." };
    const targetDir = path.join(this.baseDir, manifest.id);
    if (await dirExists(targetDir)) {
      return { ok: false, error: `A plugin with the id "${manifest.id}" is already installed.` };
    }
    await fs.mkdir(targetDir, { recursive: true });
    try {
      await atomicWrite(path.join(targetDir, "manifest.json"), JSON.stringify(manifest, null, 2));
      await atomicWrite(path.join(targetDir, manifest.main), main);
    } catch {
      await fs.rm(targetDir, { recursive: true, force: true });
      return { ok: false, error: "Could not write the plugin." };
    }
    const state = await this.readState();
    state[manifest.id] = true;
    await this.writeState(state);
    return {
      ok: true,
      entry: { id: manifest.id, manifest, enabled: true, builtIn: false },
    };
  }

  async remove(id: string): Promise<boolean> {
    if (BUILTIN_PLUGIN_IDS.includes(id)) return false;
    await fs.rm(path.join(this.baseDir, id), { recursive: true, force: true });
    const state = await this.readState();
    delete state[id];
    await this.writeState(state);
    return true;
  }

  // ------------------------------------------------------------ internals

  private async readManifest(dir: string): Promise<PluginManifest | null> {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(dir, "manifest.json"), "utf8");
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
    const validation = validatePluginManifest(parsed);
    return validation.ok ? validation.manifest : null;
  }

  private async readState(): Promise<Record<string, boolean>> {
    try {
      const raw = await fs.readFile(this.stateFile, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
      const out: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "boolean") out[key] = value;
      }
      return out;
    } catch {
      return {};
    }
  }

  private async writeState(state: Record<string, boolean>): Promise<void> {
    await atomicWrite(this.stateFile, JSON.stringify(state, null, 2));
  }
}

/** Overwrite a built-in file only when its content drifted from the app's copy. */
async function writeIfDifferent(file: string, contents: string): Promise<void> {
  let current = "";
  try {
    current = await fs.readFile(file, "utf8");
  } catch {
    /* not present yet */
  }
  if (current !== contents) await atomicWrite(file, contents);
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function atomicWrite(file: string, contents: string): Promise<void> {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, contents, "utf8");
  await fs.rename(tmp, file);
}

export type { PluginEntry, PluginInstallResult, PluginSource };