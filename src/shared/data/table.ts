/**
 * Pure, framework-free data model for table-style objects (data tables and
 * basic charts). Shared by both the canvas objects and the editing UI so the
 * same validation/normalization runs everywhere it is persisted.
 */

/** A rectangular grid of strings. `columns` are the header cells; each
 *  `rows[i]` must have exactly `columns.length` entries (enforced at write
 *  time through the pure helpers below). */
export interface TableData {
  columns: string[];
  rows: string[][];
}

/** True when the payload is a well-formed table (rectangular, capped). */
export function isTableData(value: unknown): value is TableData {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  if (!Array.isArray(t.columns) || t.columns.some((c) => typeof c !== "string")) return false;
  if (!Array.isArray(t.rows) || t.rows.length > 2000) return false;
  const width = t.columns.length;
  if (width > 100) return false;
  for (const row of t.rows) {
    if (!Array.isArray(row)) return false;
    if (row.length !== width) return false;
    if (row.some((c) => typeof c !== "string")) return false;
  }
  return true;
}

/** Default starter table: a small two-column grid with one blank row. */
export function createTableData(): TableData {
  return { columns: ["Item", "Value"], rows: [["", ""]] };
}

/** Comparison-styled starter table with a side-by-side layout. */
export function createComparisonTableData(): TableData {
  return {
    columns: ["Feature", "Option A", "Option B"],
    rows: [
      ["", "", ""],
      ["", "", ""],
      ["", "", ""],
    ],
  };
}

/** Chart starter data: one category with a single numeric series. */
export function createChartTableData(): TableData {
  return { columns: ["Label", "Value"], rows: [["", "0"]] };
}

/** Cap applied when untrusted files are validated (defense against bloat). */
export const TABLE_ROWS_MAX = 2000;
export const TABLE_COLUMNS_MAX = 100;

/**
 * Clamp a raw payload into a valid TableData. Malformed input degrades to the
 * supplied default rather than corrupting the document — used when loading
 * older/foreign files that carry a partial or broken table.
 */
export function normalizeTableData(value: unknown, fallback: TableData = createTableData()): TableData {
  if (!isTableData(value)) return fallback;
  const columns = value.columns.slice(0, TABLE_COLUMNS_MAX);
  const rows = value.rows.slice(0, TABLE_ROWS_MAX).map((row) => row.slice(0, columns.length));
  return { columns, rows };
}

/** Read a cell safely; out-of-range reads return "". */
export function cellAt(data: TableData, row: number, col: number): string {
  const r = data.rows[row];
  if (!r) return "";
  const c = r[col];
  return typeof c === "string" ? c : "";
}

/** Set a cell, extending the grid when `col` is out of range (rows grow). */
export function setCell(data: TableData, row: number, col: number, value: string): TableData {
  const rows = data.rows.map((r) => [...r]);
  while (rows.length <= row) rows.push(Array(data.columns.length).fill(""));
  rows[row][col] = value;
  return { columns: [...data.columns], rows };
}

/** Append a column, backfilling every existing row with "". */
export function addColumn(data: TableData, label = ""): TableData {
  const columns = [...data.columns, label];
  const rows = data.rows.map((r) => [...r, ""]);
  return { columns, rows };
}

/** Append a row padded with "". */
export function addRow(data: TableData, values: string[] = []): TableData {
  const rows = [...data.rows.map((r) => [...r])];
  rows.push(Array(data.columns.length).fill("").map((_, i) => values[i] ?? ""));
  return { columns: [...data.columns], rows };
}

/** Rename a header cell. */
export function renameColumn(data: TableData, col: number, label: string): TableData {
  if (col < 0 || col >= data.columns.length) return data;
  const columns = [...data.columns];
  columns[col] = label;
  return { columns, rows: data.rows.map((r) => [...r]) };
}

/** Drop the trailing column. Returns the same reference when there is only one. */
export function removeLastColumn(data: TableData): TableData {
  if (data.columns.length <= 1) return data;
  const columns = data.columns.slice(0, -1);
  const rows = data.rows.map((r) => r.slice(0, -1));
  return { columns, rows };
}

/** Drop the trailing row. Returns the same reference when there is only one. */
export function removeLastRow(data: TableData): TableData {
  if (data.rows.length <= 1) return data;
  return { columns: [...data.columns], rows: data.rows.slice(0, -1).map((r) => [...r]) };
}

/** First row-count of numeric values per column, for chart auto-scaling. */
export function numericSeries(data: TableData): number[][] {
  const width = data.columns.length;
  const series: number[][] = [];
  for (let c = 0; c < width; c++) {
    series.push([]);
    for (const row of data.rows) {
      const n = Number(row[c]);
      if (Number.isFinite(n) && row[c].trim() !== "") series[c].push(n);
    }
  }
  return series;
}