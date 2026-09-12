export interface TextEditorOptions {
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
  value: string;
  multiline: boolean;
  fontFamily?: string;
  onCommit: (value: string) => void;
  onCancel?: () => void;
}

let active: HTMLTextAreaElement | null = null;

/**
 * Inline text editor for editing text/note objects directly on the canvas.
 * Rendered as a DOM textarea positioned over the object; commits on blur (and
 * Enter for single-line text), cancels on Escape. The box grows with its
 * content so long text is never clipped while editing, and RTL text (Arabic /
 * Hebrew) is handled natively via direction auto-detection.
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
  ta.style.fontFamily = opts.fontFamily ? `"${opts.fontFamily}"` : "";
  ta.dir = "auto";
  ta.spellcheck = false;
  ta.autocapitalize = "off";
  if (!opts.multiline) ta.style.whiteSpace = "nowrap";

  const grow = (): void => {
    // Let trailing newlines count by measuring content + padding instead of
    // scrollHeight alone, so the box tracks long wrapped text exactly.
    ta.style.height = "auto";
    ta.style.height = `${Math.max(opts.height, ta.scrollHeight + 2)}px`;
  };
  ta.addEventListener("input", grow);

  active = ta;
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  grow();

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
