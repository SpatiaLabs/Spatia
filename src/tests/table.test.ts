import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isTableData,
  createTableData,
  createComparisonTableData,
  createChartTableData,
  normalizeTableData,
  cellAt,
  setCell,
  addColumn,
  addRow,
  renameColumn,
  removeLastColumn,
  removeLastRow,
  numericSeries,
  TABLE_ROWS_MAX,
  TABLE_COLUMNS_MAX,
} from "../shared/data/table.js";
import { tableLayout, tableCellRect, tableCellAt } from "../shared/geometry/tableLayout.js";

test("starter tables are well-formed rectangular grids", () => {
  for (const d of [createTableData(), createComparisonTableData(), createChartTableData()]) {
    assert.ok(isTableData(d));
    assert.ok(d.columns.length >= 2);
    assert.ok(d.rows.length >= 1);
    for (const r of d.rows) assert.equal(r.length, d.columns.length);
  }
  assert.deepEqual(createTableData().columns, ["Item", "Value"]);
  assert.equal(createComparisonTableData().columns.length, 3);
  assert.deepEqual(createChartTableData().columns, ["Label", "Value"]);
});

test("isTableData rejects non-rectangular or oversized grids", () => {
  assert.equal(isTableData({ columns: ["a"], rows: [["x", "y"]] }), false);
  assert.equal(isTableData({ columns: 3, rows: [] }), false);
  assert.equal(isTableData({ columns: ["a", "b"], rows: [["x"]] }), false);
  const bigRows = Array(TABLE_ROWS_MAX).fill(["a"]);
  bigRows.push(["b"]);
  assert.equal(isTableData({ columns: ["a"], rows: bigRows }), false);
  const manyCols = Array(TABLE_COLUMNS_MAX + 1).fill("c");
  assert.equal(isTableData({ columns: manyCols, rows: [] }), false);
});

test("normalizeTableData degrades malformed payloads to the fallback", () => {
  const fallback = createTableData();
  assert.equal(normalizeTableData(null, fallback), fallback);
  const clean = normalizeTableData({ columns: ["a", "b"], rows: [["1", "2"]] }, fallback);
  assert.deepEqual(clean, { columns: ["a", "b"], rows: [["1", "2"]] });
});

test("setCell returns a new table without mutating the input", () => {
  const d = { columns: ["a", "b"], rows: [["1", "2"]] };
  const next = setCell(d, 0, 1, "9");
  assert.equal(cellAt(next, 0, 1), "9");
  assert.equal(cellAt(d, 0, 1), "2");
  assert.equal(cellAt(next, 5, 5), "");
});

test("addColumn/addRow extend the grid rectangularly", () => {
  let d = createTableData();
  d = addColumn(d, "Extra");
  assert.deepEqual(d.columns, ["Item", "Value", "Extra"]);
  for (const r of d.rows) assert.equal(r.length, 3);
  const rows = d.rows.length;
  d = addRow(d, ["a", "b", "c"]);
  assert.equal(d.rows.length, rows + 1);
  assert.deepEqual(d.rows[d.rows.length - 1], ["a", "b", "c"]);
  assert.ok(isTableData(d));
});

test("rename/remove helpers are safe at their boundaries", () => {
  let d = createTableData();
  d = renameColumn(d, 0, "Thing");
  assert.equal(d.columns[0], "Thing");
  d = renameColumn(d, 99, "nope");
  assert.equal(d.columns[0], "Thing");
  const single = { columns: ["a"], rows: [["x"]] };
  assert.equal(removeLastColumn(single), single);
  assert.equal(removeLastRow(single), single);
});

test("numericSeries extracts only parseable numeric cells", () => {
  const d = {
    columns: ["L", "A", "B"],
    rows: [
      ["x", "1", "2.5"],
      ["y", "zzz", "4"],
    ],
  };
  const series = numericSeries(d);
  assert.deepEqual(series[1], [1]);
  assert.deepEqual(series[2], [2.5, 4]);
});

test("tableLayout matches the renderer's metric formulas", () => {
  const d = { columns: ["a", "b"], rows: [["1", "2"]] };
  const l = tableLayout(d, 200, 100, 1);
  assert.equal(l.headerPx, Math.min(18, 26));
  assert.equal(l.pad, Math.max(3, 5));
  assert.equal(l.colW, 100);
  assert.equal(l.rowH, (100 - 18 - Math.max(4, 6)) / 1);
  const zoomed = tableLayout(d, 200, 100, 0.1);
  assert.equal(zoomed.headerPx, 6);
  assert.equal(zoomed.pad, 3);
  assert.equal(zoomed.rowH, Math.max(6, (100 - 6 - Math.max(4, 6 * 0.1)) / 1));
});

test("tableCellRect returns full cells from the header down", () => {
  const d = { columns: ["a", "b"], rows: [["1", "2"]] };
  const l = tableLayout(d, 200, 100, 1);
  const header = tableCellRect(d, l, 200, 100, -1, 1);
  assert.equal(header.x, 0);
  assert.equal(header.y, -50);
  assert.equal(header.width, 100);
  assert.equal(header.height, l.headerPx);
  const firstRow = tableCellRect(d, l, 200, 100, 0, 0);
  assert.equal(firstRow.x, -100);
  assert.equal(firstRow.y, -50 + l.headerPx);
  assert.equal(firstRow.width, 100);
  assert.equal(firstRow.height, l.rowH);
});

test("tableCellAt maps local points to cells and rejects misses", () => {
  const d = { columns: ["a", "b"], rows: [["1", "2"]] };
  const l = tableLayout(d, 200, 100, 1);
  assert.deepEqual(tableCellAt(d, l, 200, 100, { x: -50, y: -40 }), { row: -1, col: 0 });
  assert.deepEqual(tableCellAt(d, l, 200, 100, { x: 50, y: 0 }), { row: 0, col: 1 });
  assert.deepEqual(tableCellAt(d, l, 200, 100, { x: -50, y: 40 }), { row: 0, col: 0 });
  assert.equal(tableCellAt(d, l, 200, 100, { x: 101, y: 0 }), null);
  assert.deepEqual(tableCellAt(d, l, 200, 100, { x: -100, y: -50 }), { row: -1, col: 0 });
});

test("tableCellAt rejects clicks past the last row and on empty tables", () => {
  const d = { columns: ["a", "b"], rows: [["1", "2"]] };
  const l = tableLayout(d, 200, 100, 1);
  assert.equal(tableCellAt(d, l, 200, 100, { x: -50, y: 46 }), null);
  const empty = { columns: [], rows: [] };
  const le = tableLayout(empty, 200, 100, 1);
  assert.equal(tableCellAt(empty, le, 200, 100, { x: 0, y: 0 }), null);
});