import { Emitter } from "../state/emitter.js";

export interface Command {
  label: string;
  /** Apply the change (and record inverse state). */
  redo(): void;
  /** Revert the change (move backward in history). */
  undo(): void;
}

/**
 * Linear undo/redo stack. Holds only document-affecting commands; viewport and
 * selection state are intentionally outside history. Emits `changed` after any
 * stack mutation so the UI can enable/disable Undo/Redo buttons and the app can
 * mark the document dirty.
 */
export class CommandManager {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private baseSavePoint = 0;
  readonly changed = new Emitter<void>();

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoLabel(): string | null {
    return this.undoStack.length ? this.undoStack[this.undoStack.length - 1].label : null;
  }

  get redoLabel(): string | null {
    return this.redoStack.length ? this.redoStack[this.redoStack.length - 1].label : null;
  }

  execute(cmd: Command): void {
    cmd.redo();
    this.undoStack.push(cmd);
    this.redoStack = [];
    this.changed.emit();
  }

  undo(): void {
    const cmd = this.undoStack.pop();
    if (!cmd) return;
    cmd.undo();
    this.redoStack.push(cmd);
    this.changed.emit();
  }

  redo(): void {
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    cmd.redo();
    this.undoStack.push(cmd);
    this.changed.emit();
  }

  /** Called after a document-changing action that isn't itself undoable. */
  clearRedo(): void {
    if (this.redoStack.length === 0) return;
    this.redoStack = [];
    this.changed.emit();
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.baseSavePoint = 0;
    this.changed.emit();
  }

  /**
   * Mark the current history length as the "saved" point. After a save, the
   * document is dirty iff the user has undone/redone away from this point.
   */
  markSaved(): void {
    this.baseSavePoint = this.undoStack.length;
  }

  /** True when the document is dirty relative to the last saved point. */
  isDirty(): boolean {
    return this.undoStack.length !== this.baseSavePoint;
  }
}
