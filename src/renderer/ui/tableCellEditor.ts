/**
 * Inline single-line cell editor for table objects. Rendered as a DOM input
 * positioned over the cell being edited; commits on Enter / blur, cancels on
 * Escape. Kept in its own module (like the text editor) so app.ts stays
 * focused on wiring. All normal editing — typing, spaces, backspace, delete,
 * text selection/cursor movement — is native to the input element.
 */
export interface TableCellEditorOptions {
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
  value: string;
  placeholder?: string;
  onCommit: (value: string) => void;
  onCancel?: () => void;
}

let active: HTMLInputElement | null = null;

export function openTableCellEditor(opts: TableCellEditorOptions): void {
  closeTableCellEditor();

  const input = document.createElement("input");
  input.type = "text";
  input.className = "spatia-cell-editor";
  input.value = opts.value;
  input.placeholder = opts.placeholder ?? "";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.style.left = `${opts.left}px`;
  input.style.top = `${opts.top}px`;
  input.style.width = `${Math.max(30, opts.width)}px`;
  input.style.height = `${Math.max(16, opts.height)}px`;
  input.style.fontSize = `${Math.max(8, opts.fontSize)}px`;

  active = input;
  document.body.appendChild(input);
  input.focus();
  input.select();

  let committed = false;
  const commit = (): void => {
    if (committed) return;
    committed = true;
    closeTableCellEditor();
    opts.onCommit(input.value);
  };
  const cancel = (): void => {
    if (committed) return;
    committed = true;
    closeTableCellEditor();
    opts.onCancel?.();
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      commit();
    }
  });
  input.addEventListener("blur", commit);
}

export function closeTableCellEditor(): void {
  if (active && active.parentNode) {
    active.parentNode.removeChild(active);
  }
  active = null;
}

export function isEditingTableCell(): boolean {
  return active !== null;
}