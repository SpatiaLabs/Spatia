/**
 * Spatia Plugin Manifest — the contract every plugin package declares.
 *
 * A plugin is a folder containing at least:
 *
 *   manifest.json     (this schema)
 *   main.js           (the plugin entry script, run inside the sandbox)
 *   assets/           (optional — reserved for future capabilities)
 *
 * Validation lives here in shared code so the desktop main process (install
 * path), the Web bridge (browser install path) and the renderer all agree on
 * what a valid plugin looks like. Unknown extra manifest fields are preserved
 * so the format can grow without breaking existing plugins.
 */

export const PLUGIN_API_VERSION = 2;

/**
 * Capabilities a plugin may declare. Each maps to a group of API methods in
 * the sandbox bridge: a plugin may only touch the API surface it declares.
 * Plugins that ship without a `permissions` field keep full v1-era access, so
 * existing plugins never break when Spatia graduates to v2.
 */
export const PLUGIN_PERMISSIONS = [
  "notify", // show a transient toast
  "commands", // register menu commands (addCommand)
  "view", // read objects, the project and the viewport
  "documents", // create / update / delete canvas objects
  "selection", // read and change the selection
  "navigation", // zoom, undo, redo, focus the selection
] as const;

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  main: string;
  /** Which revision of the plugin API this plugin targets (default current). */
  apiVersion?: number;
  /** API v2: explicit capability set. Absent = full (v1-compatible) access. */
  permissions?: PluginPermission[];
  [key: string]: unknown;
}

export type PluginValidation =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; error: string };

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+/;
const MAIN_PATTERN = /^[\w.-]+\.js$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strField(
  obj: Record<string, unknown>,
  key: string,
  maxLen: number,
  optional: boolean
): { ok: true; value?: string } | { ok: false; error: string } {
  const raw = obj[key];
  if (raw === undefined || raw === null || raw === "") {
    if (optional) return { ok: true };
    return { ok: false, error: `manifest: "${key}" is required.` };
  }
  if (typeof raw !== "string") {
    return { ok: false, error: `manifest: "${key}" must be a string.` };
  }
  if (raw.length > maxLen) {
    return { ok: false, error: `manifest: "${key}" is too long (max ${maxLen} chars).` };
  }
  return { ok: true, value: raw };
}

/**
 * Validate (and normalize) a raw manifest object. The returned manifest is a
 * fresh object with the known fields typed and any unknown fields preserved.
 */
export function validatePluginManifest(input: unknown): PluginValidation {
  if (!isPlainObject(input)) {
    return { ok: false, error: "manifest must be a JSON object." };
  }

  const idResult = strField(input, "id", 64, false);
  if (!idResult.ok) return idResult;
  const id = idResult.value as string;
  if (!ID_PATTERN.test(id)) {
    return {
      ok: false,
      error: `manifest: id "${id}" is invalid. Use only letters, digits, ".", "_" and "-" (start with a letter or digit).`,
    };
  }

  const nameResult = strField(input, "name", 120, false);
  if (!nameResult.ok) return nameResult;
  const name = nameResult.value as string;

  const versionResult = strField(input, "version", 32, false);
  if (!versionResult.ok) return versionResult;
  const version = versionResult.value as string;
  if (!VERSION_PATTERN.test(version)) {
    return { ok: false, error: `manifest: version "${version}" must look like "1.0.0".` };
  }

  const mainResult = strField(input, "main", 160, false);
  if (!mainResult.ok) return mainResult;
  const main = mainResult.value as string;
  if (!MAIN_PATTERN.test(main) || main.startsWith(".")) {
    return { ok: false, error: `manifest: main "${main}" must be a plain relative .js file name.` };
  }

  const descriptionResult = strField(input, "description", 500, true);
  if (!descriptionResult.ok) return descriptionResult;
  const authorResult = strField(input, "author", 120, true);
  if (!authorResult.ok) return authorResult;

  let apiVersion = PLUGIN_API_VERSION;
  if (input.apiVersion !== undefined) {
    if (typeof input.apiVersion !== "number" || !Number.isInteger(input.apiVersion) || input.apiVersion < 1) {
      return { ok: false, error: `manifest: apiVersion must be a positive integer.` };
    }
    apiVersion = input.apiVersion;
  }
  if (apiVersion > PLUGIN_API_VERSION) {
    return {
      ok: false,
      error: `manifest: requires plugin API v${apiVersion}, but this Spatia only supports up to v${PLUGIN_API_VERSION}.`,
    };
  }

  // API v2: an optional explicit capability set. Unknown names are rejected so
  // a plugin can never silently ask for more than Spatia understands.
  let permissions: PluginPermission[] | undefined;
  if (input.permissions !== undefined) {
    if (!Array.isArray(input.permissions) || input.permissions.length === 0) {
      return { ok: false, error: `manifest: "permissions" must list at least one permission.` };
    }
    const seen = new Set<string>();
    const normalized: PluginPermission[] = [];
    for (const p of input.permissions) {
      if (typeof p !== "string") {
        return { ok: false, error: `manifest: "permissions" entries must be strings.` };
      }
      if (!PLUGIN_PERMISSIONS.includes(p as PluginPermission)) {
        return {
          ok: false,
          error: `manifest: unknown permission "${p}" (allowed: ${PLUGIN_PERMISSIONS.join(", ")}).`,
        };
      }
      if (!seen.has(p)) {
        seen.add(p);
        normalized.push(p as PluginPermission);
      }
    }
    permissions = normalized;
  }

  const manifest: PluginManifest = { ...input, id, name, version, main, apiVersion };
  if (descriptionResult.value !== undefined) manifest.description = descriptionResult.value;
  if (authorResult.value !== undefined) manifest.author = authorResult.value;
  if (permissions !== undefined) manifest.permissions = permissions;

  return { ok: true, manifest };
}

/** A loaded plugin's runnable payload. */
export interface PluginSource {
  manifest: PluginManifest;
  main: string;
}

/** A plugin as known to the UI/stores. `manifest` is null when it failed validation. */
export interface PluginEntry {
  id: string;
  manifest: PluginManifest | null;
  enabled: boolean;
  builtIn: boolean;
  error?: string;
}

export interface PluginInstallResult {
  ok: boolean;
  entry?: PluginEntry;
  error?: string;
}