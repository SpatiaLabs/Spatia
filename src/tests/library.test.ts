import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LIBRARY_EMPTY,
  normalizeLibrary,
  upsertProject,
  setProjectFolder,
  setProjectFavorite,
  setProjectTags,
  markProjectMissing,
  removeProject,
  renameProject,
  createFolder,
  renameFolder,
  removeFolder,
  filterProjects,
  sortProjects,
  allTags,
  type LibraryData,
} from "../shared/library/library.js";

const entry = (filePath: string, displayName: string, projectId: string, extra: Partial<Parameters<typeof upsertProject>[1]> = {}) =>
  ({ filePath, displayName, projectId, ...extra });

test("normalizeLibrary coerces a garbage payload to an empty library", () => {
  assert.deepEqual(normalizeLibrary(null), LIBRARY_EMPTY);
  assert.deepEqual(normalizeLibrary(42), LIBRARY_EMPTY);
  assert.deepEqual(normalizeLibrary("x"), LIBRARY_EMPTY);
  assert.deepEqual(normalizeLibrary({}), LIBRARY_EMPTY);
});

test("normalizeLibrary keeps well-formed folders and projects", () => {
  const lib = normalizeLibrary({
    folders: [{ id: "fld_1", name: "Design", createdAt: "2026-01-01T00:00:00.000Z" }, { id: "broken", createdAt: "x" }],
    projects: [
      {
        filePath: "C:\\a.spatia.json",
        projectId: "proj_1",
        displayName: "A",
        folderId: "fld_1",
        favorite: true,
        updatedAt: "2026-01-02T00:00:00.000Z",
        tags: ["roadmap"],
      },
      { filePath: "nosuchproject", projectId: "proj_2", displayName: "B" },
    ],
  });
  assert.equal(lib.folders.length, 1);
  assert.equal(lib.folders[0].name, "Design");
  assert.equal(lib.projects.length, 2);
  assert.equal(lib.projects[0].favorite, true);
  assert.deepEqual(lib.projects[0].tags, ["roadmap"]);
  assert.equal(lib.projects[1].exists, true);
});

test("upsertProject registers a new project and preserves folder/favorite/tags on refresh", () => {
  let lib: LibraryData = LIBRARY_EMPTY;
  lib = upsertProject(lib, entry("p1.spatia.json", "Plan", "proj_1"));
  lib = setProjectFolder(lib, "p1.spatia.json", "fld_9");
  lib = setProjectFavorite(lib, "p1.spatia.json", true);
  lib = setProjectTags(lib, "p1.spatia.json", ["launch"]);
  assert.equal(lib.projects.length, 1);
  // Re-registering (e.g. a later save) must not reset organization metadata.
  lib = upsertProject(lib, { filePath: "p1.spatia.json", displayName: "Plan", projectId: "proj_1", updatedAt: "2026-02-01T00:00:00.000Z" });
  assert.equal(lib.projects.length, 1);
  assert.equal(lib.projects[0].folderId, "fld_9");
  assert.equal(lib.projects[0].favorite, true);
  assert.deepEqual(lib.projects[0].tags, ["launch"]);
  assert.equal(lib.projects[0].updatedAt, "2026-02-01T00:00:00.000Z");
});

test("folder ops create/rename/delete and move contained projects to uncategorized", () => {
  let lib = createFolder(LIBRARY_EMPTY, "Work");
  const folderId = lib.folders[0].id;
  assert.equal(lib.folders.length, 1);
  lib = upsertProject(lib, entry("w.spatia.json", "W", "proj_w", { folderId }));
  lib = renameFolder(lib, folderId, "Work 2");
  assert.equal(lib.folders[0].name, "Work 2");
  lib = removeFolder(lib, folderId);
  assert.equal(lib.folders.length, 0);
  assert.equal(lib.projects[0].folderId, null);
});

test("empty folder name is rejected and delete of unknown folder is a no-op reference-safe", () => {
  assert.deepEqual(createFolder(LIBRARY_EMPTY, "   "), LIBRARY_EMPTY);
  const lib = removeFolder(LIBRARY_EMPTY, "nope");
  assert.equal(lib, LIBRARY_EMPTY);
});

test("setProjectFolder/favorite/tags return the same reference for no-op calls", () => {
  const lib = upsertProject(LIBRARY_EMPTY, entry("p.spatia.json", "P", "proj_p"));
  assert.equal(setProjectFavorite(lib, "missing-path", true), lib);
  assert.equal(setProjectFolder(lib, "missing-path", "x"), lib);
  assert.equal(setProjectTags(lib, "missing-path", ["x"]), lib);
});

test("removeProject and renameProject update pointers only for the target", () => {
  let lib = upsertProject(LIBRARY_EMPTY, entry("a.spatia.json", "A", "proj_a"));
  lib = upsertProject(lib, entry("b.spatia.json", "B", "proj_b"));
  lib = renameProject(lib, "a.spatia.json", "a2.spatia.json");
  assert.ok(lib.projects.some((p) => p.filePath === "a2.spatia.json"));
  assert.ok(!lib.projects.some((p) => p.filePath === "a.spatia.json"));
  assert.equal(lib.projects.find((p) => p.filePath === "b.spatia.json")?.displayName, "B");
  lib = removeProject(lib, "a2.spatia.json");
  assert.equal(lib.projects.length, 1);
});

test("markProjectMissing toggles the exists flag", () => {
  let lib = upsertProject(LIBRARY_EMPTY, entry("m.spatia.json", "M", "proj_m"));
  lib = markProjectMissing(lib, "m.spatia.json", true);
  assert.equal(lib.projects[0].exists, false);
  lib = upsertProject(lib, { filePath: "m.spatia.json", displayName: "M", projectId: "proj_m", exists: false });
  assert.equal(lib.projects[0].exists, false);
});

test("filterProjects matches name, path and tags case-insensitively plus tag filter", () => {
  let lib = upsertProject(LIBRARY_EMPTY, entry("Roadmap.spatia.json", "Roadmap", "proj_1", { tags: ["launch", "planning"] }));
  lib = upsertProject(lib, entry("notes.spatia.json", "Meeting Notes", "proj_2", { tags: ["team"] }));
  assert.equal(filterProjects(lib.projects, "roadmap").length, 1);
  assert.equal(filterProjects(lib.projects, "notes").length, 1);
  assert.equal(filterProjects(lib.projects, "PLANNING").length, 1);
  assert.equal(filterProjects(lib.projects, "", "team").length, 1);
  assert.equal(filterProjects(lib.projects, "", "missing").length, 0);
  assert.equal(filterProjects(lib.projects, "").length, 2);
});

test("sortProjects orders by name, updated and created", () => {
  let lib = upsertProject(LIBRARY_EMPTY, entry("a.spatia.json", "Alpha", "proj_1", { updatedAt: "2026-01-01T00:00:00.000Z" }));
  lib = upsertProject(lib, entry("b.spatia.json", "Beta", "proj_2", { updatedAt: "2026-03-01T00:00:00.000Z" }));
  lib = upsertProject(lib, entry("c.spatia.json", "Gamma", "proj_3", { updatedAt: "2026-02-01T00:00:00.000Z" }));
  const names = (list: ReturnType<typeof sortProjects>) => list.map((p) => p.displayName);
  assert.deepEqual(names(sortProjects(lib.projects, "name")), ["Alpha", "Beta", "Gamma"]);
  assert.deepEqual(names(sortProjects(lib.projects, "updated")), ["Beta", "Gamma", "Alpha"]);
});

test("allTags aggregates distinct tags across projects", () => {
  let lib = upsertProject(LIBRARY_EMPTY, entry("p1.spatia.json", "P1", "proj_1", { tags: ["x", "y"] }));
  lib = upsertProject(lib, entry("p2.spatia.json", "P2", "proj_2", { tags: ["y", "z"] }));
  assert.deepEqual(allTags(lib.projects).sort(), ["x", "y", "z"]);
});