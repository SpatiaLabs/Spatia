import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize, normalizeTags, searchItems, type SearchableItem } from "../shared/search/search.js";

const note = (id: string, label: string, text: string, tags: string[] = []): SearchableItem => ({
  id,
  kind: "object",
  label,
  text,
  tags,
  typeLabel: "note",
});

test("tokenize lowercases and splits on punctuation", () => {
  assert.deepEqual(tokenize("Hello, World!"), ["hello", "world"]);
  assert.deepEqual(tokenize("  multi   space  "), ["multi", "space"]);
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize("café-ÜBER"), ["café", "über"]);
});

test("normalizeTags trims, de-dupes and drops empties", () => {
  assert.deepEqual(normalizeTags([" VIP ", "", "vip", " launch "]), ["VIP", "launch"]);
});

test("empty query returns no results", () => {
  assert.deepEqual(searchItems([note("1", "A", "text")], "  "), []);
});

test("multi-term query requires every term to match", () => {
  const items = [note("1", "Project roadmap", "plan"), note("2", "Team launch", "meeting")];
  const hits = searchItems(items, "roadmap plan");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, "1");
  const none = searchItems(items, "roadmap team");
  assert.equal(none.length, 0);
});

test("label prefix ranks above body-only matches", () => {
  const items = [note("body", "Meeting notes", "planning roadmap"), note("prefix", "Roadmap", "something")];
  const hits = searchItems(items, "roadmap");
  assert.equal(hits.length, 2);
  assert.equal(hits[0].id, "prefix");
  assert.ok(hits[0].score > hits[1].score);
});

test("tag matches rank high and qualify text-less items", () => {
  const items = [
    note("1", "Notes", "some text", ["vip"]),
    note("2", "Wallet", "authorization"),
  ];
  const hits = searchItems(items, "vip");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, "1");
});

test("project and object kinds flow through as-is", () => {
  const items: SearchableItem[] = [
    { id: "note:1", kind: "object", label: "Review pricing", text: "please review pricing", tags: [], typeLabel: "note" },
    { id: "__project__", kind: "project", label: "Q3 Launch", text: "Q3 Launch", tags: ["launch"], typeLabel: "project" },
  ];
  const hits = searchItems(items, "pricing");
  assert.equal(hits[0].kind, "object");
  const proj = searchItems(items, "launch");
  assert.equal(proj.length, 1);
  assert.equal(proj[0].kind, "project");
  // Terms must co-occur in a single item (AND semantics): "review launch"
  // appears across two different items, so neither matches.
  const both = searchItems(items, "review launch");
  assert.equal(both.length, 0);
});

test("results are capped at maxResults and snippet is populated", () => {
  const items = Array.from({ length: 20 }, (_, i) => note(`n${i}`, "X", "roadmap"));
  const hits = searchItems(items, "roadmap", 5);
  assert.equal(hits.length, 5);
  assert.ok(hits[0].snippet.length > 0);
});