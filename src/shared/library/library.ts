/**
 * Pure, framework-free library model shared by the Desktop (library.json in
 * userData) and Web (IndexedDB) bridges. The library is a workspace-level
 * index of all known projects: folders (virtual organization, never moves
 * files), favorites and tags. It never stores document contents — only the
 * pointer (filePath) and organizational metadata, so a desktop library keeps
 * working when files move on disk or are deleted.
 *
 * These functions are side-effect free: every mutation takes the current
 * LibraryData and returns a new one. The bridges (main process / web) are
 * responsible for persistence.
 */

export type LibrarySort = "name" | "updated" | "created";

export interface LibraryFolder {
  id: string;
  name: string;
  createdAt: string;
}

export interface LibraryProject {
  /** App-level key: absolute file path on desktop; document path on web. */
  filePath: string;
  /** Display name (from the project file, may drift from the filename). */
  displayName: string;
  /** The project document id (for version history and asset lookup). */
  projectId: string;
  /** Owning folder id, or null for "uncategorized". */
  folderId: string | null;
  favorite: boolean;
  /** ISO timestamp of the last open/save (used for "recent" style sorts). */
  updatedAt: string;
  /** Whether the underlying file still exists (desktop). */
  exists: boolean;
  /** Project-level tags (kept in sync with the document). */
  tags: string[];
}

export interface LibraryData {
  folders: LibraryFolder[];
  projects: LibraryProject[];
}

export interface LibraryProjectInput {
  filePath: string;
  displayName: string;
  projectId: string;
  favorite?: boolean;
  folderId?: string | null;
  updatedAt?: string;
  tags?: readonly string[];
  /** Explicit existence flag (desktop). Defaults to existing/true. */
  exists?: boolean;
}

export const LIBRARY_EMPTY: LibraryData = { folders: [], projects: [] };

/** Safely coerce an unknown persisted payload into a LibraryData. */
export function normalizeLibrary(raw: unknown): LibraryData {
  if (typeof raw !== "object" || raw === null) return { folders: [], projects: [] };
  const rec = raw as Record<string, unknown>;
  const folders: LibraryFolder[] = [];
  if (Array.isArray(rec.folders)) {
    for (const f of rec.folders) {
      if (typeof f !== "object" || f === null) continue;
      const fr = f as Record<string, unknown>;
      if (typeof fr.id !== "string" || typeof fr.name !== "string") continue;
      const createdAt = typeof fr.createdAt === "string" ? fr.createdAt : new Date().toISOString();
      folders.push({ id: fr.id, name: fr.name, createdAt });
    }
  }
  const projects: LibraryProject[] = [];
  if (Array.isArray(rec.projects)) {
    for (const p of rec.projects) {
      if (typeof p !== "object" || p === null) continue;
      const pr = p as Record<string, unknown>;
      if (typeof pr.filePath !== "string" || typeof pr.projectId !== "string") continue;
      projects.push({
        filePath: pr.filePath,
        displayName: typeof pr.displayName === "string" ? pr.displayName : pr.filePath,
        projectId: pr.projectId,
        folderId: typeof pr.folderId === "string" ? pr.folderId : null,
        favorite: pr.favorite === true,
        updatedAt: typeof pr.updatedAt === "string" ? pr.updatedAt : new Date().toISOString(),
        exists: pr.exists !== false,
        tags: Array.isArray(pr.tags) ? pr.tags.filter((t): t is string => typeof t === "string") : [],
      });
    }
  }
  return { folders, projects };
}

/** Merge a project into the library (upsert by filePath), preserving fields
 *  the caller does not supply (folder, favorite, tags survive re-registration). */
export function upsertProject(lib: LibraryData, input: LibraryProjectInput): LibraryData {
  const existing = lib.projects.find((p) => p.filePath === input.filePath);
  const entry: LibraryProject = {
    filePath: input.filePath,
    displayName: input.displayName,
    projectId: input.projectId,
    folderId: existing?.folderId !== undefined ? existing.folderId : (input.folderId ?? null),
    favorite: existing?.favorite ?? input.favorite ?? false,
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    // A registration with exists:false is a tombstone; otherwise default true
    // except when the previous record explicitly recorded a missing file.
    exists: input.exists !== undefined ? input.exists : (existing?.exists ?? true),
    tags: existing ? [...existing.tags] : [...(input.tags ?? [])],
  };
  const projects = lib.projects.filter((p) => p.filePath !== input.filePath);
  projects.push(entry);
  return { folders: lib.folders, projects };
}

export function setProjectFolder(lib: LibraryData, filePath: string, folderId: string | null): LibraryData {
  const entry = lib.projects.find((p) => p.filePath === filePath);
  if (!entry) return lib;
  return {
    folders: lib.folders,
    projects: lib.projects.map((p) => (p.filePath === filePath ? { ...p, folderId } : p)),
  };
}

export function setProjectFavorite(lib: LibraryData, filePath: string, favorite: boolean): LibraryData {
  if (!lib.projects.some((p) => p.filePath === filePath)) return lib;
  return {
    folders: lib.folders,
    projects: lib.projects.map((p) => (p.filePath === filePath ? { ...p, favorite } : p)),
  };
}

export function setProjectTags(lib: LibraryData, filePath: string, tags: readonly string[]): LibraryData {
  if (!lib.projects.some((p) => p.filePath === filePath)) return lib;
  return {
    folders: lib.folders,
    projects: lib.projects.map((p) =>
      p.filePath === filePath ? { ...p, tags: [...new Set(tags)].slice(0, 100) } : p
    ),
  };
}

/** Mark a project missing (file deleted/missing on disk). */
export function markProjectMissing(lib: LibraryData, filePath: string, missing: boolean): LibraryData {
  return {
    folders: lib.folders,
    projects: lib.projects.map((p) => (p.filePath === filePath ? { ...p, exists: !missing } : p)),
  };
}

/** Remove a project from the library index (file untouched). */
export function removeProject(lib: LibraryData, filePath: string): LibraryData {
  return { folders: lib.folders, projects: lib.projects.filter((p) => p.filePath !== filePath) };
}

/** Rename a project: update the pointer (filePath changes on desktop). */
export function renameProject(lib: LibraryData, oldPath: string, newPath: string): LibraryData {
  return {
    folders: lib.folders,
    projects: lib.projects.map((p) => (p.filePath === oldPath ? { ...p, filePath: newPath } : p)),
  };
}

export function createFolder(lib: LibraryData, name: string, id = createFolderId()): LibraryData {
  const clean = name.trim();
  if (!clean) return lib;
  return {
    folders: [...lib.folders, { id, name: clean.slice(0, 80), createdAt: new Date().toISOString() }],
    projects: lib.projects,
  };
}

export function renameFolder(lib: LibraryData, id: string, name: string): LibraryData {
  const clean = name.trim();
  if (!clean) return lib;
  return {
    folders: lib.folders.map((f) => (f.id === id ? { ...f, name: clean.slice(0, 80) } : f)),
    projects: lib.projects,
  };
}

/** Delete a folder and move its projects to "uncategorized". */
export function removeFolder(lib: LibraryData, id: string): LibraryData {
  const folders = lib.folders.filter((f) => f.id !== id);
  if (folders.length === lib.folders.length) return lib;
  return {
    folders,
    projects: lib.projects.map((p) => (p.folderId === id ? { ...p, folderId: null } : p)),
  };
}

/** Case-insensitive filter over name/tags/filePath; empty query matches all. */
export function filterProjects(projects: readonly LibraryProject[], query: string, tag?: string): LibraryProject[] {
  const q = query.trim().toLowerCase();
  return projects.filter((p) => {
    if (tag && !p.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return false;
    if (!q) return true;
    return (
      p.displayName.toLowerCase().includes(q) ||
      p.filePath.toLowerCase().includes(q) ||
      p.tags.some((t) => t.toLowerCase().includes(q))
    );
  });
}

export function sortProjects(projects: readonly LibraryProject[], sort: LibrarySort): LibraryProject[] {
  const list = [...projects];
  list.sort((a, b) => {
    if (sort === "name") {
      const cmp = a.displayName.localeCompare(b.displayName);
      if (cmp !== 0) return cmp;
    } else if (sort === "created") {
      const cmp = String(a.projectId).localeCompare(String(b.projectId));
      if (cmp !== 0) return cmp;
    }
    return String(b.updatedAt).localeCompare(String(a.updatedAt));
  });
  return list;
}

/** All distinct tags across a project list, sorted by frequency then name. */
export function allTags(projects: readonly LibraryProject[]): string[] {
  const counts = new Map<string, number>();
  for (const p of projects) {
    for (const t of p.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t]) => t);
}

/** Library data version written with desktop library.json. */
export const LIBRARY_DATA_VERSION = 1;

function createFolderId(): string {
  if (typeof globalThis !== "undefined") {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c && typeof c.randomUUID === "function") return "fld_" + c.randomUUID();
  }
  return "fld_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}