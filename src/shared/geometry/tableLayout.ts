/**
 * Pure layout math shared by the table renderer and the inline cell editor so
 * the editor always positions an input over exactly the cell the canvas draws.
 * Coordinates are local to the object box: (0,0) is the object's center, +x
 * right, +y down — the same space `drawTable` uses after translating to the
 * object's midpoint.
 */
import type { TableData } from "../data/table.js";

export interface TableLayout {
  headerPx: number;
  pad: number;
  rowH: number;
  colW: number;
}

/** Cell rect expressed in local (centered) coordinates. */
export interface TableCellRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A hit test result: row is -1 for the header row, otherwise a body row. */
export interface TableCellHit {
  row: number;
  col: number;
}

/**
 * Compute the layout metrics drawTable renders with. Must stay numerically
 * identical to the renderer so the editor overlays line up at any zoom.
 */
export function tableLayout(data: TableData, width: number, height: number, zoom: number): TableLayout {
  const columns = data.columns.length;
  const rows = data.rows.length;
  const headerPx = Math.max(6, Math.min(18, 26 * zoom));
  const pad = Math.max(3, 5 * zoom);
  const rowH = Math.max(6, (height - headerPx - Math.max(4, 6 * zoom)) / Math.max(1, rows));
  const colW = columns > 0 ? width / columns : 0;
  return { headerPx, pad, rowH, colW };
}

/** Local (centered) rect of a cell. `row` < 0 addresses the header row. */
export function tableCellRect(
  data: TableData,
  layout: TableLayout,
  width: number,
  height: number,
  row: number,
  col: number
): TableCellRect {
  const columns = data.columns.length;
  const colIndex = Math.min(Math.max(0, col), Math.max(0, columns - 1));
  if (row < 0) {
    return { x: -width / 2 + colIndex * layout.colW, y: -height / 2, width: layout.colW, height: layout.headerPx };
  }
  const y = -height / 2 + layout.headerPx + row * layout.rowH;
  return { x: -width / 2 + colIndex * layout.colW, y, width: layout.colW, height: layout.rowH };
}

/**
 * Map a local (centered, rotation-independent) point to a cell, or null when
 * it lands outside the table or past the last row.
 */
export function tableCellAt(
  data: TableData,
  layout: TableLayout,
  width: number,
  height: number,
  point: { x: number; y: number }
): TableCellHit | null {
  const columns = data.columns.length;
  if (columns === 0) return null;
  const cx = point.x + width / 2;
  const cy = point.y + height / 2;
  if (cx < 0 || cx > width || cy < 0 || cy > height) return null;
  const col = Math.min(columns - 1, Math.floor(cx / layout.colW));
  if (cy < layout.headerPx) return { row: -1, col };
  const row = Math.floor((cy - layout.headerPx) / layout.rowH);
  if (row >= data.rows.length) return null;
  return { row, col };
}