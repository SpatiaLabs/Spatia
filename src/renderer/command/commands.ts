import type { ProjectStore } from "../project/projectStore.js";
import type { CanvasObject } from "../../shared/types/object.js";
import type { Command } from "./commandManager.js";

/**
 * Concrete document commands. Each captures enough before/after state to
 * invert itself, so undo/redo is exact regardless of intervening edits. All
 * commands operate on document state only (ProjectStore), never viewport or
 * selection. Commands are constructed with both the "before" and "after"
 * snapshots; the drag/resize gestures compute these during the gesture and
 * hand them in once on completion.
 */

export function addObjectCommand(project: ProjectStore, obj: CanvasObject): Command {
  return {
    label: "Add object",
    redo() {
      project.addObject(obj);
    },
    undo() {
      project.removeObjects([obj.id]);
    },
  };
}

export function deleteObjectsCommand(
  project: ProjectStore,
  ids: readonly string[]
): Command {
  let removed: { obj: CanvasObject; index: number }[] = [];
  return {
    label: ids.length > 1 ? `Delete ${ids.length} objects` : "Delete object",
    redo() {
      removed = project.removeObjects(ids);
    },
    undo() {
      for (const r of removed) project.insertObjectAt(r.index, r.obj);
      removed = [];
    },
  };
}

export function moveObjectsCommand(
  project: ProjectStore,
  before: { id: string; x: number; y: number }[],
  after: { id: string; x: number; y: number }[]
): Command {
  return {
    label: before.length > 1 ? `Move ${before.length} objects` : "Move object",
    redo() {
      project.moveObjectsTo(after);
    },
    undo() {
      project.moveObjectsTo(before);
    },
  };
}

export function resizeObjectsCommand(
  project: ProjectStore,
  before: { id: string; x: number; y: number; width: number; height: number }[],
  after: { id: string; x: number; y: number; width: number; height: number }[]
): Command {
  const apply = (list: typeof before): void => {
    for (const r of list) project.resizeObject(r.id, r.x, r.y, r.width, r.height);
  };
  return {
    label: after.length > 1 ? `Resize ${after.length} objects` : "Resize object",
    redo() {
      apply(after);
    },
    undo() {
      apply(before);
    },
  };
}

export interface PropChange {
  id: string;
  key: string;
  before: unknown;
  after: unknown;
}

/** Apply a set of property changes (style/config edits) in one step. */
export function setPropsCommand(project: ProjectStore, changes: PropChange[]): Command {
  const apply = (list: PropChange[], valueOf: (c: PropChange) => unknown): void => {
    for (const c of list) {
      project.setObjectProp(c.id, c.key, valueOf(c));
    }
  };
  return {
    label: "Edit property",
    redo() {
      apply(changes, (c) => c.after);
    },
    undo() {
      apply(changes, (c) => c.before);
    },
  };
}

/** Set z-index values for multiple objects in one undoable step. */
export function zOrderCommand(
  project: ProjectStore,
  before: { id: string; zIndex: number }[],
  after: { id: string; zIndex: number }[]
): Command {
  return {
    label: "Reorder objects",
    redo() {
      project.setZOrder(after);
    },
    undo() {
      project.setZOrder(before);
    },
  };
}
