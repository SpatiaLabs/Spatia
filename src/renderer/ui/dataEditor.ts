/**
 * Modal data grid editor for table / chart objects. Renders an editable grid
 * over the document; commits the normalized TableData back on Done, or discards
 * on Cancel / Escape / backdrop click. Kept in a separate module (like the text
 * editor) so app.ts stays focused on wiring.
 */
import type { TableData } from "../../shared/data/table.js";
import {
  addColumn,
  addRow,
  removeLastColumn,
  removeLastRow,
  setCell,
  renameColumn,
} from "../../shared/data/table.js";

export interface DataEditorOptions {
  title: string;
  data: TableData;
  onCommit: (data: TableData) => void;
}

let host: HTMLDivElement | null = null;

export function openDataEditor(opts: DataEditorOptions): void {
  closeDataEditor();

  let state: TableData = {
    columns: opts.data.columns.map((c) => c),
    rows: opts.data.rows.map((r) => r.map((c) => c)),
  };

  const root = document.createElement("div");
  root.className = "data-editor-backdrop";

  const panel = document.createElement("div");
  panel.className = "data-editor";
  root.appendChild(panel);

  const header = document.createElement("div");
  header.className = "data-editor-header";
  header.textContent = opts.title;
  panel.appendChild(header);

  const toolbar = document.createElement("div");
  toolbar.className = "data-editor-toolbar";
  const addColBtn = button("Add column", () => {
    state = addColumn(state);
    render();
  });
  const addRowBtn = button("Add row", () => {
    state = addRow(state);
    render();
  });
  const rmColBtn = button("Remove column", () => {
    state = removeLastColumn(state);
    render();
  });
  const rmRowBtn = button("Remove row", () => {
    state = removeLastRow(state);
    render();
  });
  toolbar.append(addColBtn, addRowBtn, rmColBtn, rmRowBtn);
  panel.appendChild(toolbar);

  const tableWrap = document.createElement("div");
  tableWrap.className = "data-editor-body";
  const table = document.createElement("table");
  table.className = "data-editor-grid";
  tableWrap.appendChild(table);
  panel.appendChild(tableWrap);

  const footer = document.createElement("div");
  footer.className = "data-editor-footer";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";
  cancelBtn.className = "data-editor-btn";
  const doneBtn = document.createElement("button");
  doneBtn.type = "button";
  doneBtn.textContent = "Done";
  doneBtn.className = "data-editor-btn data-editor-btn--primary";
  footer.append(cancelBtn, doneBtn);
  panel.appendChild(footer);

  const buildInput = (value: string, onChange: (v: string) => void): HTMLInputElement => {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "data-editor-cell";
    input.value = value;
    input.addEventListener("input", () => onChange(input.value));
    return input;
  };

  const render = (): void => {
    table.innerHTML = "";
    const headRow = document.createElement("tr");
    const corner = document.createElement("th");
    corner.className = "data-editor-head data-editor-corner";
    corner.textContent = "#";
    headRow.appendChild(corner);
    state.columns.forEach((col, c) => {
      const th = document.createElement("th");
      th.className = "data-editor-head";
      th.appendChild(buildInput(col, (v) => {
        state = renameColumn(state, c, v);
      }));
      headRow.appendChild(th);
    });
    table.appendChild(headRow);
    state.rows.forEach((row, r) => {
      const tr = document.createElement("tr");
      const ri = document.createElement("th");
      ri.className = "data-editor-rowhead";
      ri.textContent = String(r + 1);
      tr.appendChild(ri);
      row.forEach((cellValue, c) => {
        const td = document.createElement("td");
        td.appendChild(buildInput(cellValue, (v) => {
          state = setCell(state, r, c, v);
        }));
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });
  };
  render();

  let committed = false;
  const close = (commit: boolean): void => {
    if (committed) return;
    committed = true;
    window.removeEventListener("mousedown", onBackdrop, true);
    root.remove();
    host = null;
    if (commit) opts.onCommit(state);
  };
  const onBackdrop = (e: MouseEvent): void => {
    if (e.target === root) close(false);
  };

  doneBtn.addEventListener("click", () => close(true));
  cancelBtn.addEventListener("click", () => close(false));
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(false);
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    }
  });
  window.addEventListener("mousedown", onBackdrop, true);

  document.body.appendChild(root);
  host = root;
  const firstInput = table.querySelector<HTMLInputElement>("th .data-editor-cell");
  firstInput?.focus();
  firstInput?.select();
}

export function closeDataEditor(): void {
  if (host && host.parentNode) host.parentNode.removeChild(host);
  host = null;
}

export function isEditingData(): boolean {
  return host !== null;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.className = "data-editor-btn";
  b.addEventListener("click", onClick);
  return b;
}