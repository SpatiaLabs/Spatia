export interface TextEditorOptions {
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
  value: string;
  multiline: boolean;
  onCommit: (value: string) => void;
  onCancel?: () => void;
}

let active: HTMLTextAreaElement | null = null;

/**
 * Inline text editor for editing text/note objects directly on the canvas.
 * Rendered as a DOM textarea positioned over the object; commits on blur (and
 * Enter for single-line text), cancels on Escape.
 */
export function openTextEditor(opts: TextEditorOptions): void {
  closeTextEditor();

  const ta = document.createElement("textarea");
  ta.className = "spatia-text-editor";
  ta.value = opts.value;
  ta.style.left = `${opts.left}px`;
  ta.style.top = `${opts.top}px`;
  ta.style.width = `${Math.max(40, opts.width)}px`;
  ta.style.height = `${Math.max(40, opts.height)}px`;
  ta.style.fontSize = `${Math.max(8, opts.fontSize)}px`;
  if (!opts.multiline) ta.style.whiteSpace = "nowrap";

  active = ta;
  document.body.appendChild(ta);
  ta.focus();
  ta.select();

  let committed = false;
  const commit = (): void => {
    if (committed) return;
    committed = true;
    closeTextEditor();
    opts.onCommit(ta.value);
  };
  const cancel = (): void => {
    if (committed) return;
    committed = true;
    closeTextEditor();
    opts.onCancel?.();
  };

  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    } else if (!opts.multiline && e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Enter" && opts.multiline && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      commit();
    }
  });
  ta.addEventListener("blur", commit);
}

export function closeTextEditor(): void {
  if (active && active.parentNode) {
    active.parentNode.removeChild(active);
  }
  active = null;
}

export function isEditingText(): boolean {
  return active !== null;
}
