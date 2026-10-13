export interface TextEditorOptions {
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
  value: string;
  multiline: boolean;
  fontFamily?: string;
  /** Show the inline formatting toolbar (rich text notes/text). */
  markup?: boolean;
  /** Called the first time the user applies a formatting action. */
  onFormatUsed?: () => void;
  onCommit: (value: string) => void;
  onCancel?: () => void;
}

let active: HTMLTextAreaElement | null = null;
let activeToolbar: HTMLDivElement | null = null;
let formatFired = false;

// Marker pairs applied around the current selection.
interface Fmt { open: string; close: string; label: string }

const FMTS: Fmt[] = [
  { open: "**", close: "**", label: "B" },
  { open: "*", close: "*", label: "I" },
  { open: "_", close: "_", label: "U" },
  { open: "`", close: "`", label: "</>" },
];

function noteFormat(ta: HTMLTextAreaElement, fmt: Fmt, link?: string): void {
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const sel = ta.value.slice(start, end) || "text";
  let wrapped: string;
  if (link !== undefined) {
    wrapped = `[${sel}](${link})`;
  } else {
    wrapped = fmt.open + sel + fmt.close;
  }
  ta.value = ta.value.slice(0, start) + wrapped + ta.value.slice(end);
  ta.selectionStart = start + fmt.open.length;
  ta.selectionEnd = start + fmt.open.length + sel.length;
  ta.dispatchEvent(new Event("input"));
}

function buildToolbar(opts: TextEditorOptions, ta: HTMLTextAreaElement): HTMLDivElement {
  const bar = document.createElement("div");
  bar.className = "spatia-text-toolbar";
  bar.style.left = `${Math.max(0, opts.left)}px`;
  bar.style.top = `${Math.max(0, opts.top)}px`;
  bar.style.width = `${Math.max(120, Math.min(300, opts.width))}px`;

  const btn = (html: string, title: string, fn: () => void): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "spatia-text-toolbar-btn";
    b.innerHTML = html;
    b.title = title;
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => {
      fn();
      if (!formatFired) {
        formatFired = true;
        opts.onFormatUsed?.();
      }
    });
    return b;
  };

  for (const fmt of FMTS) {
    bar.appendChild(btn(fmt.label, `${fmt.open}${fmt.close}`, () => noteFormat(ta, fmt)));
  }
  bar.appendChild(btn("Link", "Insert link", () => {
    const target = window.prompt("Link URL (https://…)", "https://");
    if (target) noteFormat(ta, { open: "[", close: "]", label: "[]" }, target);
  }));

  return bar;
}

/**
 * Inline text editor for editing text/note objects directly on the canvas.
 * Rendered as a DOM textarea positioned over the object; commits on blur (and
 * Enter for single-line text), cancels on Escape. The box grows with its
 * content so long text is never clipped while editing, and RTL text (Arabic /
 * Hebrew) is handled natively via direction auto-detection.
 */
export function openTextEditor(opts: TextEditorOptions): void {
  closeTextEditor();

  formatFired = false;

  const ta = document.createElement("textarea");
  ta.className = "spatia-text-editor";
  ta.value = opts.value;
  ta.style.left = `${Math.max(0, opts.left)}px`;
  ta.style.top = opts.markup ? `${Math.max(0, opts.top + 34)}px` : `${Math.max(0, opts.top)}px`;
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

  if (opts.markup) {
    activeToolbar = buildToolbar(opts, ta);
    document.body.appendChild(activeToolbar);
  }

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
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === "b" && opts.markup) {
      e.preventDefault();
      const mark = () => noteFormat(ta, FMTS[0]);
      mark();
      if (!formatFired) {
        formatFired = true;
        opts.onFormatUsed?.();
      }
      return;
    }
    if (mod && key === "i" && opts.markup) {
      e.preventDefault();
      const mark = () => noteFormat(ta, FMTS[1]);
      mark();
      if (!formatFired) {
        formatFired = true;
        opts.onFormatUsed?.();
      }
      return;
    }
    if (mod && key === "u" && opts.markup) {
      e.preventDefault();
      const mark = () => noteFormat(ta, FMTS[2]);
      mark();
      if (!formatFired) {
        formatFired = true;
        opts.onFormatUsed?.();
      }
      return;
    }
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
  if (activeToolbar && activeToolbar.parentNode) {
    activeToolbar.parentNode.removeChild(activeToolbar);
  }
  active = null;
  activeToolbar = null;
}

export function isEditingText(): boolean {
  return active !== null;
}