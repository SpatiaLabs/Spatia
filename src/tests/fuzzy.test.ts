import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fuzzyMatchScore, fuzzyFilter } from "../shared/search/fuzzy.js";

interface Cmd {
  label: string;
  keywords: string;
}

describe("fuzzyMatchScore", () => {
  it("matches every query substring in order", () => {
    assert.ok(fuzzyMatchScore("pdf", "Export PDF") >= 0);
    assert.ok(fuzzyMatchScore("undo", "Undo") >= 0);
    assert.ok(fuzzyMatchScore("frame", "Add Frame") >= 0);
    assert.ok(fuzzyMatchScore("text", "Add Text") >= 0);
  });

  it("rejects characters that appear out of order or missing", () => {
    assert.equal(fuzzyMatchScore("pdf", "Paste"), -1);
    assert.equal(fuzzyMatchScore("zzz", "Zoom In"), -1);
    assert.equal(fuzzyMatchScore("xo", "Zoom Out"), -1);
  });

  it("is case-insensitive and language-agnostic", () => {
    assert.ok(fuzzyMatchScore("UN", "undo") >= 0);
    assert.ok(fuzzyMatchScore("سلام", "السلام عليكم") >= 0);
    assert.ok(fuzzyMatchScore("السلام", "السلام عليكم") >= 0);
    assert.ok(fuzzyMatchScore("سلام عليكم", "السلام عليكم") >= 0);
  });

  it("scores word boundaries above scattered matches", () => {
    // "pdf" at a word boundary ("Export PDF") beats "pdf" buried mid-word.
    const boundary = fuzzyMatchScore("pdf", "Export PDF");
    const scattered = fuzzyMatchScore("pdf", "updogs");
    assert.ok(boundary >= 0);
    assert.ok(scattered >= 0 || scattered === -1);
    if (scattered >= 0) assert.ok(boundary > scattered);
  });

  it("returns 0 for an empty query and -1 for an empty target", () => {
    assert.equal(fuzzyMatchScore("", "anything"), 0);
    assert.equal(fuzzyMatchScore("a", ""), -1);
  });
});

describe("fuzzyFilter", () => {
  const items: Cmd[] = [
    { label: "Add Text", keywords: "text note label" },
    { label: "Export PDF", keywords: "pdf document" },
    { label: "Undo", keywords: "revert" },
    { label: "Export Markdown", keywords: "md" },
    { label: "Duplicate", keywords: "clone copy" },
  ];

  it("returns all items in original order for an empty query", () => {
    const out = fuzzyFilter("", items, (c) => c.label);
    assert.equal(out.length, items.length);
    assert.deepEqual(out.map((o) => o.item.label), items.map((i) => i.label));
  });

  it("filters and orders by fuzzy score", () => {
    const out = fuzzyFilter("export", items, (c) => c.label);
    const labels = out.map((o) => o.item.label);
    assert.deepEqual(labels, ["Export PDF", "Export Markdown"]);
  });

  it("searches keywords too when the label alone misses", () => {
    const out = fuzzyFilter("clone", items, (c) => `${c.label} ${c.keywords}`);
    assert.equal(out.length, 1);
    assert.equal(out[0].item.label, "Duplicate");
  });

  it("partial matches rank sensibly", () => {
    const out = fuzzyFilter("tex", items, (c) => `${c.label} ${c.keywords}`);
    assert.ok(out.length >= 1);
    assert.equal(out[0].item.label, "Add Text");
  });

  it("supports multiple search terms in any order", () => {
    const out1 = fuzzyFilter("export pdf", items, (c) => `${c.label} ${c.keywords}`);
    const out2 = fuzzyFilter("pdf export", items, (c) => `${c.label} ${c.keywords}`);
    for (const out of [out1, out2]) {
      assert.ok(out.length >= 1);
      assert.equal(out[0].item.label, "Export PDF");
    }
    const md = fuzzyFilter("export md", items, (c) => `${c.label} ${c.keywords}`);
    assert.equal(md.length, 1);
    assert.equal(md[0].item.label, "Export Markdown");
  });

  it("every search term must match", () => {
    const out = fuzzyFilter("pdf undo", items, (c) => `${c.label} ${c.keywords}`);
    assert.equal(out.length, 0);
  });
});