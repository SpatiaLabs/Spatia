"use strict";

import { validatePluginManifest } from "./js/shared/plugins/manifest.js";
import { BUILTIN_PLUGINS, BUILTIN_PLUGIN_IDS } from "./js/shared/plugins/builtin.js";
import {
  normalizeLibrary,
  upsertProject,
  setProjectFolder,
  setProjectFavorite,
  setProjectTags,
  removeProject,
  renameProject,
  createFolder,
  renameFolder,
  removeFolder,
  LIBRARY_DATA_VERSION,
} from "./js/shared/library/library.js";

/**
 * Browser implementation of the `window.spatia` bridge (the typed surface lives
 * in src/renderer/types/bridge.d.ts). It lets the unmodified Spatia renderer
 * run in the browser:
 *
 *   - Projects   → IndexedDB store "documents"    (key: file path)
 *   - Recents    → IndexedDB store "recents"      (key: file path)
 *   - Assets     → IndexedDB store "assets"       (key: "<projectId>/<assetId>")
 *   - Plugins    → IndexedDB store "plugins"      (key: plugin id)
 *   - Library    → IndexedDB store "library"      (key: "data")
 *   - Versions   → IndexedDB store "versions"     (key: "<projectId>/<token>")
 *
 * "Save" stores the project in the browser. "Save As" and "Export" also drop a
 * real `.spatia.json` file on the machine so work is never trapped in the
 * browser. No Node, no dependencies — pure Web Platform.
 */

const DB_NAME = "spatia-web";
const DB_VERSION = 4;
const STORES = {
  documents: "documents",
  recents: "recents",
  assets: "assets",
  plugins: "plugins",
  library: "library",
  versions: "versions",
  settings: "settings",
};

const dataUrlCache = new Map();
const pendingDrops = new Map();

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of Object.values(STORES)) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
  });
  return dbPromise;
}

async function idb(mode, store, op) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const s = tx.objectStore(store);
    const req = op(s);
    req.onsuccess = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    tx.oncomplete = () => resolve(req.result);
  });
}

const idbGet = (store, key) => idb("readonly", store, (s) => s.get(key));
const idbPut = (store, key, value) => idb("readwrite", store, (s) => s.put(value, key));
const idbDel = (store, key) => idb("readwrite", store, (s) => s.delete(key));
const idbGetAll = (store) => idb("readonly", store, (s) => s.getAll());

function newUuid() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : "id" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || "");
  return m ? "." + m[1].toLowerCase() : "";
}

function kindOf(mime, name) {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  return "file";
}

function fileToBlob(file) {
  return file.arrayBuffer().then((buf) => new Blob([buf], { type: file.type || "application/octet-stream" }));
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error("read failed"));
    r.readAsDataURL(blob);
  });
}

/** 256px-wide thumbnail data URL for an image blob; null when undecodable. */
async function imageThumb(blob, mime) {
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, 288 / Math.max(1, bitmap.width));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, w, h);
    const usePng = typeof mime === "string" && mime.includes("png");
    return usePng
      ? canvas.toDataURL("image/png")
      : canvas.toDataURL("image/jpeg", 0.82) || null;
  } catch {
    return null;
  } finally {
    if (bitmap) bitmap.close();
  }
}

function nameFromJson(json) {
  try {
    const d = JSON.parse(json);
    const n = d && d.project && d.project.name;
    return typeof n === "string" && n ? n : "Untitled";
  } catch {
    return "Untitled";
  }
}

function displayNameFromPath(filePath) {
  // "launch-plan.spatia.json" -> "launch-plan"
  return String(filePath).replace(/\.spatia\.json$/i, "").replace(/\.[a-z0-9]+$/i, "");
}

/** Build a file-path that does not collide with an existing stored document. */
async function uniquePath(name) {
  let candidate = String(name || "untitled.spatia.json");
  const m = /^(.*?)(\.[a-z0-9]+)$/i.exec(candidate);
  const stem = m ? m[1] : candidate;
  const ext = m ? m[2] : "";
  let i = 2;
  while (await idbGet(STORES.documents, candidate)) {
    candidate = `${stem} (${i})${ext}`;
    i += 1;
  }
  return candidate;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Import an arbitrary File as a project asset. Shared by picker, dnd and tools. */
async function importFile(file, projectId) {
  const blob = await fileToBlob(file);
  const mime = file.type || "application/octet-stream";
  const kind = kindOf(mime, file.name);
  const thumbnail = kind === "image" ? await imageThumb(blob, mime) : null;
  const meta = {
    id: "asset_" + newUuid(),
    kind,
    name: file.name,
    size: file.size,
    mime,
    ext: extOf(file.name),
    ...(thumbnail ? { thumbnail } : {}),
  };
  await idbPut(STORES.assets, `${projectId}/${meta.id}`, { meta, blob });
  dataUrlCache.delete(`${projectId}/${meta.id}`);
  return meta;
}

/**
 * Open a file via the File System Access API when available, otherwise fall
 * back to a hidden <input type=file>. Returns null when the user cancels.
 */
function pickFile(label, acceptItems) {
  if (typeof window.showOpenFilePicker === "function") {
    return window
      .showOpenFilePicker({
        multiple: false,
        types: acceptItems,
        excludeAcceptAllOption: false,
      })
      .then((handles) => (handles.length ? handles[0].getFile() : null))
      .catch((err) => {
        if (err && (err.name === "AbortError" || err.code === 20)) return null;
        throw err;
      });
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = (acceptItems || [])
      .map((item) => Object.keys(item.accept).join(","))
      .filter(Boolean)
      .join(",");
    input.addEventListener("change", () => {
      resolve(input.files && input.files[0] ? input.files[0] : null);
    });
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

// ---------------- Persistence helpers ----------------

async function persistDocument(filePath, projectId, name, json) {
  await idbPut(STORES.documents, filePath, { filePath, projectId, name, json });
  await libraryRegister({ filePath, projectId, displayName: name, updatedAt: new Date().toISOString() });
}

// ---------------- Library (workspace index) ----------------

async function libraryRead() {
  const data = await idbGet(STORES.library, "data");
  return normalizeLibrary(data);
}

async function libraryWrite(lib) {
  await idbPut(STORES.library, "data", {
    version: LIBRARY_DATA_VERSION,
    folders: lib.folders,
    projects: lib.projects,
  });
}

async function libraryRegister(entry) {
  const lib = await libraryRead();
  await libraryWrite(upsertProject(lib, entry));
}

function folderOrNull(candidate) {
  if (candidate === null || candidate === undefined || candidate === "") return null;
  return String(candidate);
}

// ---------------- Version history ----------------

const MAX_VERSION_SNAPSHOTS = 20;

function versionToken() {
  return "v" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
}

async function versionsListWeb(projectId) {
  const all = await idbGetAll(STORES.versions);
  return all
    .filter((r) => r && r.projectId === projectId)
    .map(({ projectId: p, token, label, createdAt }) => ({ projectId: p, token, label, createdAt }));
}

async function versionsAddWeb(projectId, label, json) {
  const id = String(projectId || "").trim();
  if (!id) return null;
  const token = versionToken();
  const createdAt = new Date().toISOString();
  await idbPut(STORES.versions, `${id}/${token}`, { projectId: id, token, label: String(label || "Snapshot").slice(0, 120), createdAt, json });
  // Keep the newest MAX_VERSION_SNAPSHOTS (list is ascending by token/date).
  const list = await versionsListWeb(id);
  const kept = new Set([token, ...list.slice(-(MAX_VERSION_SNAPSHOTS - 1))].map((s) => s.token));
  const all = await idbGetAll(STORES.versions);
  for (const r of all) {
    if (r && r.projectId === id && !kept.has(r.token)) {
      await idbDel(STORES.versions, `${id}/${r.token}`);
    }
  }
  return { projectId: id, token, label: String(label || "Snapshot").slice(0, 120), createdAt };
}

async function versionsRestoreWeb(projectId, token) {
  const r = await idbGet(STORES.versions, `${projectId}/${token}`);
  return r && typeof r.json === "string" ? r.json : null;
}

async function versionsDeleteWeb(projectId, token) {
  await idbDel(STORES.versions, `${projectId}/${token}`);
  return true;
}

async function touchRecent(filePath, name, projectId) {
  await idbPut(STORES.recents, filePath, {
    filePath,
    name,
    openedAt: new Date().toISOString(),
    projectId,
  });
}

async function getRecents() {
  const all = await idbGetAll(STORES.recents);
  return [...all]
    .sort((a, b) => String(b.openedAt || "").localeCompare(String(a.openedAt || "")))
    .slice(0, 20);
}

// ---------------- Plugins ----------------

/** Seed the built-in plugins on first boot (they behave like normal entries).
 * Built-ins ship with the app, so whenever a stored copy drifts from the app's
 * current manifest/main it is refreshed (an explicit user "disabled" state is
 * preserved). */
async function seedBuiltinsIfNeeded() {
  const all = await idbGetAll(STORES.plugins);
  const current = new Map(all.map((r) => [r && r.id, r]));
  for (const b of BUILTIN_PLUGINS) {
    const existing = current.get(b.manifest.id);
    if (existing && existing.builtIn === true) {
      const manifestSame = JSON.stringify(existing.manifest || null) === JSON.stringify(b.manifest);
      if (!manifestSame || existing.main !== b.main) {
        await idbPut(STORES.plugins, b.manifest.id, {
          id: b.manifest.id,
          manifest: b.manifest,
          main: b.main,
          enabled: existing.enabled !== false,
          builtIn: true,
          files: existing.files || {},
        });
      }
      continue;
    }
    if (existing) continue; // a user plugin holds this id — leave it alone
    await idbPut(STORES.plugins, b.manifest.id, {
      id: b.manifest.id,
      manifest: b.manifest,
      main: b.main,
      enabled: true,
      builtIn: true,
      files: {},
    });
  }
  // Prune built-in entries from older versions that are no longer shipped
  // (e.g. the retired "example-plugin"). Only built-in-flagged records are
  // removed; a user plugin that happens to share a retired id is left alone.
  for (const r of all) {
    if (r && r.builtIn === true && !BUILTIN_PLUGIN_IDS.includes(r.id)) {
      await idbDel(STORES.plugins, r.id);
    }
  }
}

/** Install a validated plugin payload under a given id. */
async function installPluginSource(id, manifestInput, main) {
  const validation = validatePluginManifest(manifestInput);
  if (!validation.ok) return { ok: false, error: validation.error };
  const manifest = validation.manifest;
  if (manifest.id !== id) return { ok: false, error: "id does not match the manifest id." };
  if (await idbGet(STORES.plugins, id)) {
    return { ok: false, error: `A plugin with the id "${id}" is already installed.` };
  }
  if (typeof main !== "string") return { ok: false, error: "main is missing." };
  await idbPut(STORES.plugins, id, { id, manifest, main, enabled: true, builtIn: false, files: {} });
  return { ok: true };
}

async function removePluginForTest(id) {
  await idbDel(STORES.plugins, id);
}

/** Install via the OS "pick a folder" picker (browsers without support fall back to webkitdirectory). */
function pickPluginFolder() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");
    input.addEventListener("change", async () => {
      const files = Array.from(input.files || []);
      if (files.length === 0) {
        resolve({ ok: false, error: "No folder was selected." });
        return;
      }
      const relPath = (f) => (f.webkitRelativePath || f.name).split("/").slice(1).join("/") || f.name;
      const manifestFile = files.find((f) => f.name === "manifest.json");
      if (!manifestFile) {
        resolve({ ok: false, error: "The selected folder does not contain a manifest.json." });
        return;
      }
      let raw;
      try {
        raw = await manifestFile.text();
      } catch {
        resolve({ ok: false, error: "Could not read manifest.json." });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        resolve({ ok: false, error: "manifest.json is not valid JSON." });
        return;
      }
      const validation = validatePluginManifest(parsed);
      if (!validation.ok) {
        resolve({ ok: false, error: validation.error });
        return;
      }
      const manifest = validation.manifest;
      if (await idbGet(STORES.plugins, manifest.id)) {
        resolve({ ok: false, error: `A plugin with the id "${manifest.id}" is already installed.` });
        return;
      }
      const mainFile = files.find((f) => relPath(f) === manifest.main);
      if (!mainFile) {
        resolve({ ok: false, error: `${manifest.main} is missing in the plugin folder.` });
        return;
      }
      const main = await mainFile.text();
      await idbPut(STORES.plugins, manifest.id, {
        id: manifest.id,
        manifest,
        main,
        enabled: true,
        builtIn: false,
        files: {},
      });
      resolve({ ok: true });
    });
    input.click();
  });
}

/** Install a plugin from a manifest.json URL. Same-origin fetch satisfies the
 *  app CSP (connect-src 'self'); cross-origin hosts must send CORS headers. */
async function installPluginFromUrl(rawUrl) {
  let manifestUrl;
  try {
    manifestUrl = new URL(String(rawUrl), document.baseURI);
  } catch {
    return { ok: false, error: "That URL is not valid." };
  }
  if (manifestUrl.protocol !== "https:" && manifestUrl.protocol !== "http:") {
    return { ok: false, error: "Only http(s) plugin URLs are allowed." };
  }
  let manifestText;
  try {
    const res = await fetch(manifestUrl.href);
    if (!res.ok) return { ok: false, error: `Could not fetch the manifest (HTTP ${res.status}).` };
    manifestText = await res.text();
  } catch {
    return { ok: false, error: "Could not reach that URL." };
  }
  let parsed;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    return { ok: false, error: "That URL does not point to a JSON manifest." };
  }
  const validation = validatePluginManifest(parsed);
  if (!validation.ok) return { ok: false, error: validation.error };
  const manifest = validation.manifest;
  if (await idbGet(STORES.plugins, manifest.id)) {
    return { ok: false, error: `A plugin with the id "${manifest.id}" is already installed.` };
  }
  const mainUrl = new URL(manifest.main, manifestUrl.href);
  let main;
  try {
    const res = await fetch(mainUrl.href);
    if (!res.ok) return { ok: false, error: `Could not fetch ${manifest.main} (HTTP ${res.status}).` };
    main = await res.text();
  } catch {
    return { ok: false, error: `Could not reach ${manifest.main}.` };
  }
  if (typeof main !== "string" || main.length === 0) {
    return { ok: false, error: `${manifest.main} is empty or unreadable.` };
  }
  await idbPut(STORES.plugins, manifest.id, {
    id: manifest.id,
    manifest,
    main,
    enabled: true,
    builtIn: false,
    files: {},
  });
  return { ok: true, entry: { id: manifest.id, manifest, builtIn: false, enabled: true } };
}

// ---------------- Session state ----------------

let currentPath = null;
let currentProjectId = null;

function rememberCurrent(filePath, projectId) {
  currentPath = filePath;
  currentProjectId = projectId;
  try {
    localStorage.setItem("spatia.web.current", JSON.stringify({ filePath, projectId }));
  } catch {
    /* private browsing — fine */
  }
}

function loadCurrent() {
  try {
    const raw = localStorage.getItem("spatia.web.current");
    if (!raw) return;
    const c = JSON.parse(raw);
    if (c && typeof c.filePath === "string") {
      currentPath = c.filePath;
      currentProjectId = c.projectId || null;
    }
  } catch {
    /* ignore corrupted state */
  }
}
loadCurrent();

// ---------------- The bridge ----------------

window.spatia = {
  async openProject() {
    const file = await pickFile("Open Spatia project", [
      {
        description: "Spatia project",
        accept: {
          "application/json": [".spatia.json", ".json", ".spatia"],
          "text/plain": [".spatia.json", ".json"],
        },
      },
    ]);
    if (!file) return { canceled: true, filePath: null };
    const contents = await file.text();
    let projectId = null;
    let name = file.name;
    try {
      const d = JSON.parse(contents);
      projectId = (d && d.project && d.project.id) || null;
      name = (d && d.project && d.project.name) || file.name;
    } catch {
      /* keep defaults */
    }
    if (!projectId) projectId = "proj_" + newUuid();
    const filePath = await uniquePath(file.name);
    await persistDocument(filePath, projectId, name, contents);
    await touchRecent(filePath, name, projectId);
    rememberCurrent(filePath, projectId);
    return { canceled: false, filePath, contents };
  },

  async openProjectPath(filePath) {
    const doc = await idbGet(STORES.documents, filePath);
    if (!doc) return { canceled: true, filePath: null };
    await touchRecent(doc.filePath, doc.name, doc.projectId);
    rememberCurrent(doc.filePath, doc.projectId);
    return { canceled: false, filePath: doc.filePath, contents: doc.json };
  },

  async saveProject(json) {
    const name = nameFromJson(json);
    if (!currentProjectId) currentProjectId = "proj_" + newUuid();
    const filePath = currentPath || (await uniquePath(`${name}.spatia.json`));
    await persistDocument(filePath, currentProjectId, name, json);
    await touchRecent(filePath, name, currentProjectId);
    rememberCurrent(filePath, currentProjectId);
    return { canceled: false, filePath };
  },

  async saveAsProject(json, suggestedName) {
    const name = nameFromJson(json);
    const filePath = await uniquePath(suggestedName || `${name}.spatia.json`);
    if (!currentProjectId) currentProjectId = "proj_" + newUuid();
    await persistDocument(filePath, currentProjectId, name, json);
    await touchRecent(filePath, name, currentProjectId);
    downloadBlob(new Blob([json], { type: "application/json" }), filePath);
    rememberCurrent(filePath, currentProjectId);
    return { canceled: false, filePath };
  },

  async exportProject(projectId, json, suggestedName) {
    const name = nameFromJson(json);
    const fileName = suggestedName || `${name}.spatia.json`;
    downloadBlob(new Blob([json], { type: "application/json" }), fileName);
    const filePath = await uniquePath(fileName);
    await persistDocument(filePath, projectId || "proj_" + newUuid(), name, json);
    return { canceled: false, filePath: fileName };
  },

  async exportFile(kind, suggestedName, payload) {
    const fileName = suggestedName || `spatia-export.${kind}`;
    if (kind === "md") {
      downloadBlob(new Blob([payload], { type: "text/markdown;charset=utf-8" }), fileName);
    } else {
      const binary = atob(payload);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const mime = kind === "png" ? "image/png" : "application/pdf";
      downloadBlob(new Blob([bytes], { type: mime }), fileName);
    }
    return { canceled: false, filePath: fileName };
  },

  async importProject() {
    const file = await pickFile("Import Spatia project", [
      {
        description: "Spatia project",
        accept: {
          "application/json": [".spatia.json", ".json", ".spatia"],
          "text/plain": [".spatia.json", ".json"],
        },
      },
    ]);
    if (!file) return { canceled: true, contents: null };
    const contents = await file.text();
    if (!contents) return { canceled: true, contents: null };
    let projectId = null;
    let name = file.name;
    try {
      const d = JSON.parse(contents);
      projectId = (d && d.project && d.project.id) || null;
      name = (d && d.project && d.project.name) || file.name;
    } catch {
      /* keep defaults */
    }
    if (!projectId) projectId = "proj_" + newUuid();
    const filePath = await uniquePath(file.name);
    await persistDocument(filePath, projectId, name, contents);
    await touchRecent(filePath, name, projectId);
    rememberCurrent(filePath, projectId);
    return { canceled: false, contents };
  },

  async getRecentProjects() {
    const recents = await getRecents();
    return recents.map(({ filePath, name, openedAt }) => ({ filePath, name, openedAt }));
  },

  async readProjectContents(filePath) {
    const doc = await idbGet(STORES.documents, filePath);
    return doc && typeof doc.json === "string" ? doc.json : null;
  },

  async libraryGet() {
    return libraryRead();
  },

  async libraryCreateFolder(name) {
    const lib = await libraryRead();
    const next = createFolder(lib, String(name || ""));
    if (next.folders.length === lib.folders.length) return null;
    await libraryWrite(next);
    return next.folders[next.folders.length - 1];
  },

  async libraryRenameFolder(id, name) {
    const lib = await libraryRead();
    const next = renameFolder(lib, id, String(name || ""));
    if (next === lib) return false;
    await libraryWrite(next);
    return true;
  },

  async libraryDeleteFolder(id) {
    const lib = await libraryRead();
    const next = removeFolder(lib, id);
    if (next === lib) return false;
    await libraryWrite(next);
    return true;
  },

  async librarySetFolder(filePath, folderId) {
    const lib = await libraryRead();
    const next = setProjectFolder(lib, filePath, folderOrNull(folderId));
    if (next === lib) return false;
    await libraryWrite(next);
    return true;
  },

  async librarySetFavorite(filePath, favorite) {
    const lib = await libraryRead();
    const next = setProjectFavorite(lib, filePath, favorite === true);
    if (next === lib) return false;
    await libraryWrite(next);
    return true;
  },

  async librarySetTags(filePath, tags) {
    const lib = await libraryRead();
    const next = setProjectTags(lib, filePath, Array.isArray(tags) ? tags : []);
    if (next === lib) return false;
    await libraryWrite(next);
    return true;
  },

  async libraryRemove(filePath) {
    const lib = await libraryRead();
    const next = removeProject(lib, filePath);
    if (next === lib) return false;
    await libraryWrite(next);
    return true;
  },

  // Web has no OS trash; deleting a project removes its document + recents +
  // library entries for good (confirm in UI before calling).
  async libraryTrash(filePath) {
    const existing = await idbGet(STORES.documents, filePath);
    if (!existing) {
      await libraryRemove(filePath);
      return true;
    }
    await idbDel(STORES.documents, filePath);
    await idbDel(STORES.recents, filePath);
    const lib = await libraryRead();
    await libraryWrite(removeProject(lib, filePath));
    if (currentPath === filePath) rememberCurrent(null, null);
    return true;
  },

  async libraryRename(filePath, newName) {
    const cleanName = String(newName || "").trim().replace(/\.spatia\.json$/i, "");
    if (!cleanName) return { ok: false, error: "Name cannot be empty." };
    const doc = await idbGet(STORES.documents, filePath);
    if (!doc) return { ok: false, error: "Project not found." };
    const newPath = await uniquePath(cleanName + ".spatia.json");
    const renamed = { ...doc, filePath: newPath, name: cleanName };
    await idbPut(STORES.documents, newPath, renamed);
    await idbDel(STORES.documents, filePath);
    const rec = await idbGet(STORES.recents, filePath);
    if (rec) {
      await idbPut(STORES.recents, newPath, { ...rec, filePath: newPath });
      await idbDel(STORES.recents, filePath);
    }
    const lib = await libraryRead();
    await libraryWrite(upsertProject(lib, { filePath: newPath, displayName: cleanName, projectId: doc.projectId }));
    if (currentPath === filePath) rememberCurrent(newPath, doc.projectId);
    return { ok: true, filePath: newPath };
  },

  async versionsList(projectId) {
    return versionsListWeb(projectId);
  },

  async versionsAdd(projectId, label, json) {
    return versionsAddWeb(projectId, label, json);
  },

  async versionsRestore(projectId, token) {
    return versionsRestoreWeb(projectId, token);
  },

  async versionsDelete(projectId, token) {
    return versionsDeleteWeb(projectId, token);
  },

  async pickAsset(projectId) {
    const file = await pickFile("Choose a file to add", [
      { description: "Any file", accept: { "*/*": [] } },
    ]);
    if (!file) return { canceled: true, asset: null };
    const asset = await importFile(file, projectId);
    return { canceled: false, asset };
  },

  async importAssetFromPath(projectId, sourcePath, sourceName) {
    const file = pendingDrops.get(sourcePath) || null;
    if (file) pendingDrops.delete(sourcePath);
    if (!file) return { canceled: true, asset: null };
    const asset = await importFile(file, projectId);
    return { canceled: false, asset };
  },

  async readAssetDataUrl(projectId, assetId) {
    const key = `${projectId}/${assetId}`;
    if (!dataUrlCache.has(key)) {
      const rec = await idbGet(STORES.assets, key);
      if (!rec || !rec.blob) return null;
      const url = await blobToDataUrl(rec.blob);
      dataUrlCache.set(key, url);
      return url;
    }
    return dataUrlCache.get(key);
  },

  async openAsset(projectId, assetId) {
    const rec = await idbGet(STORES.assets, `${projectId}/${assetId}`);
    if (!rec || !rec.blob) return false;
    downloadBlob(rec.blob, rec.meta.name);
    return true;
  },

  async assetExists(projectId, assetId) {
    const rec = await idbGet(STORES.assets, `${projectId}/${assetId}`);
    return rec !== undefined;
  },

  async relinkAsset(projectId, assetId) {
    const file = await pickFile("Relink file", [
      { description: "Any file", accept: { "*/*": [] } },
    ]);
    if (!file) return { canceled: true, asset: null };
    const key = `${projectId}/${assetId}`;
    const blob = await fileToBlob(file);
    const mime = file.type || "application/octet-stream";
    const kind = kindOf(mime, file.name);
    const thumbnail = kind === "image" ? await imageThumb(blob, mime) : null;
    const meta = {
      id: assetId,
      kind,
      name: file.name,
      size: file.size,
      mime,
      ext: extOf(file.name),
      ...(thumbnail ? { thumbnail } : {}),
    };
    await idbPut(STORES.assets, key, { meta, blob });
    dataUrlCache.delete(key);
    return { canceled: false, asset: meta };
  },

  async deleteAsset(projectId, assetId) {
    const key = `${projectId}/${assetId}`;
    dataUrlCache.delete(key);
    await idbDel(STORES.assets, key);
    return true;
  },

  async openExternal(url) {
    const w = window.open(url, "_blank", "noopener,noreferrer");
    return w !== null && w !== undefined;
  },

  getDroppedFilePath(file) {
    if (!file || !(file instanceof File)) return null;
    const path = `web-drop:${Date.now()}:${file.name}`;
    pendingDrops.set(path, file);
    return path;
  },

  async pluginsList() {
    await seedBuiltinsIfNeeded();
    const all = await idbGetAll(STORES.plugins);
    return all
      .filter((r) => r && r.id)
      .map((r) => ({
        id: r.id,
        manifest: r.manifest || null,
        builtIn: r.builtIn === true,
        enabled: r.enabled !== false,
        error: r.manifest ? undefined : "Its manifest is missing or invalid.",
      }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  },

  async pluginsGetSource(id) {
    const r = await idbGet(STORES.plugins, id);
    if (!r) return null;
    const validated = r.manifest ? validatePluginManifest(r.manifest) : { ok: false, error: "" };
    if (!validated.ok) return null;
    if (typeof r.main !== "string") return null;
    return { manifest: validated.manifest, main: r.main };
  },

  async pluginsInstall() {
    return pickPluginFolder();
  },

  async pluginsInstallUrl(url) {
    return installPluginFromUrl(url);
  },

  async pluginsSetEnabled(id, enabled) {
    const r = await idbGet(STORES.plugins, id);
    if (!r || !r.manifest) return false;
    await idbPut(STORES.plugins, id, { ...r, enabled: enabled === true });
    return true;
  },

  async pluginsRemove(id) {
    const r = await idbGet(STORES.plugins, id);
    if (!r || r.builtIn === true) return false;
    await idbDel(STORES.plugins, id);
    return true;
  },

  async collabGetIdentity() {
    const raw = await idbGet(STORES.settings, "collab.identity");
    if (raw && typeof raw.id === "string" && raw.id && typeof raw.name === "string") {
      return { id: raw.id, name: raw.name };
    }
    const fresh = { id: "user_" + crypto.randomUUID(), name: "Guest" };
    await idbPut(STORES.settings, "collab.identity", fresh);
    return fresh;
  },

  onJoinRequest(cb) {
    const handler = (e) => {
      if (e && e.detail && typeof e.detail.room === "string") cb(e.detail.room);
    };
    document.addEventListener("spatia:join", handler);
    return () => document.removeEventListener("spatia:join", handler);
  },
};

// Small internal hook used by build scripts / tools; not part of the app API.
window.__spatiaBridge = {
  importFile,
  installPluginSource,
  removePluginForTest,
  builtInIds: BUILTIN_PLUGIN_IDS.slice(),
};