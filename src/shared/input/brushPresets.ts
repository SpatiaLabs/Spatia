/**
 * Brush presets — named bundles of the live pen settings (size, colour,
 * opacity, curve smoothing, stabilizer, pressure) that a user can pick in one
 * click and save their own combinations of.
 *
 * This module is deliberately environment-free: it validates and transforms
 * plain data, and persistence is injected through a tiny `PresetStorage`
 * interface. That keeps it unit-testable in Node (no DOM, no localStorage
 * global) while the renderer wires it to `window.localStorage` and the engine.
 */

import { isBrushKind, type BrushKind } from "./brushes.js";

/** The subset of `InkSettings` a preset captures. */
export interface PenStyleValues {
  width: number;
  opacity: number;
  color: string;
  smoothing: 0 | 1 | 2;
  stabilizer: "off" | "mild" | "strong";
  pressure: boolean;
  /** Rendering character (pen/pencil/marker/calligraphy…). */
  brush: BrushKind;
}

export interface BrushPreset extends PenStyleValues {
  id: string;
  /** Built-in presets cannot be deleted; custom ones can. */
  builtin?: boolean;
  name: string;
}

/** Minimal storage surface so callers can pass `localStorage` or a stub. */
export interface PresetStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const CUSTOM_BRUSH_PRESETS_KEY = "spatia.brushPresets.v1";
export const MAX_CUSTOM_PRESETS = 50;

function bi(
  id: string,
  name: string,
  width: number,
  opacity: number,
  color: string,
  smoothing: 0 | 1 | 2,
  stabilizer: "off" | "mild" | "strong",
  pressure: boolean,
  brush: BrushKind
): BrushPreset {
  return { id, name, width, opacity, color, smoothing, stabilizer, pressure, brush, builtin: true };
}

/** Curated starting set — each entry is a genuinely distinct brush. */
export const BUILTIN_BRUSH_PRESETS: readonly BrushPreset[] = [
  bi("builtin:fine", "Fine pen", 1.5, 1, "#e8eaed", 1, "mild", true, "pen"),
  bi("builtin:pencil", "Pencil", 2, 0.85, "#c9ced6", 0, "off", true, "pencil"),
  bi("builtin:ballpoint", "Ballpoint", 3, 1, "#e8eaed", 1, "off", false, "ballpoint"),
  bi("builtin:marker", "Marker", 8, 0.9, "#4ea1ff", 1, "off", false, "marker"),
  bi("builtin:brush", "Brush", 12, 1, "#ff7a59", 2, "mild", true, "brush"),
  bi("builtin:highlighter", "Highlighter", 16, 0.4, "#ffe066", 2, "off", false, "highlighter"),
  bi("builtin:calligraphy", "Calligraphy nib", 10, 1, "#e8eaed", 1, "off", false, "calligraphy"),
];

export function isBuiltinPresetId(id: string): boolean {
  return id.startsWith("builtin:");
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function isHexColor(v: unknown): v is string {
  return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
}

/**
 * Coerce arbitrary parsed JSON into a valid preset, or `null` when the payload
 * is too broken to be imported. Numbers are clamped into the engine's accepted
 * ranges so a hand-edited value can never wedge a later stroke.
 */
export function normalizeBrushPreset(raw: unknown): BrushPreset | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r["id"] === "string" ? r["id"].trim() : "";
  const name = typeof r["name"] === "string" ? r["name"].trim().slice(0, 40) : "";
  if (!id || !name) return null;
  if (isBuiltinPresetId(id)) return null;
  const width = Number(r["width"]);
  const opacity = Number(r["opacity"]);
  if (!Number.isFinite(width) || !Number.isFinite(opacity)) return null;
  const color = isHexColor(r["color"]) ? r["color"].toLowerCase() : null;
  if (!color) return null;
  const smoothRaw = Number(r["smoothing"]);
  const smoothing = (Number.isFinite(smoothRaw) ? clamp(Math.round(smoothRaw), 0, 2) : 1) as 0 | 1 | 2;
  const stabRaw = r["stabilizer"];
  const stabilizer: PenStyleValues["stabilizer"] =
    stabRaw === "mild" || stabRaw === "strong" ? stabRaw : "off";
  const pressure = r["pressure"] === true;
  const brush: BrushKind = isBrushKind(r["brush"]) ? r["brush"] : "pen";
  return { id, name, width: clamp(width, 0.5, 128), opacity: clamp(opacity, 0.05, 1), color, smoothing, stabilizer, pressure, brush };
}

/** Parse persisted custom presets, dropping malformed entries and duplicates. */
export function loadCustomPresets(storage: Pick<PresetStorage, "getItem"> | null | undefined): BrushPreset[] {
  if (!storage) return [];
  let parsed: unknown;
  try {
    const text = storage.getItem(CUSTOM_BRUSH_PRESETS_KEY);
    if (!text) return [];
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: BrushPreset[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    const preset = normalizeBrushPreset(entry);
    if (!preset || seen.has(preset.id)) continue;
    seen.add(preset.id);
    out.push(preset);
    if (out.length >= MAX_CUSTOM_PRESETS) break;
  }
  return out;
}

/** Persist custom presets. Returns false when storage is unavailable/full. */
export function saveCustomPresets(
  presets: readonly BrushPreset[],
  storage: Pick<PresetStorage, "setItem"> | null | undefined
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(CUSTOM_BRUSH_PRESETS_KEY, JSON.stringify(presets.slice(0, MAX_CUSTOM_PRESETS)));
    return true;
  } catch {
    return false;
  }
}

/** Upsert a preset by id (kept in insertion order), capped at the maximum. */
export function upsertCustomPreset(list: readonly BrushPreset[], preset: BrushPreset): BrushPreset[] {
  const next = list.filter((p) => p.id !== preset.id);
  next.push(preset);
  return next.slice(-MAX_CUSTOM_PRESETS);
}

export function removeCustomPreset(list: readonly BrushPreset[], id: string): BrushPreset[] {
  return list.filter((p) => p.id !== id);
}

/** Built-ins first, then the user's saved presets. */
export function allBrushPresets(custom: readonly BrushPreset[]): BrushPreset[] {
  return [...BUILTIN_BRUSH_PRESETS, ...custom];
}

/** Extract the engine-patchable settings a preset applies. */
export function presetToPenSettings(preset: BrushPreset): PenStyleValues {
  return {
    width: preset.width,
    opacity: preset.opacity,
    color: preset.color,
    smoothing: preset.smoothing,
    stabilizer: preset.stabilizer,
    pressure: preset.pressure,
    brush: preset.brush,
  };
}

function near(a: number, b: number, eps: number): boolean {
  return Math.abs(a - b) <= eps;
}

/** True when the live settings equal a preset (so the UI can highlight it). */
export function settingsMatchPreset(preset: BrushPreset, settings: PenStyleValues): boolean {
  return (
    near(preset.width, settings.width, 1e-6) &&
    near(preset.opacity, settings.opacity, 1e-6) &&
    preset.color.toLowerCase() === settings.color.toLowerCase() &&
    preset.smoothing === settings.smoothing &&
    preset.stabilizer === settings.stabilizer &&
    preset.pressure === settings.pressure &&
    preset.brush === settings.brush
  );
}

/** Id of the first preset matching the live settings, or null for "Custom". */
export function matchPresetId(presets: readonly BrushPreset[], settings: PenStyleValues): string | null {
  for (const p of presets) if (settingsMatchPreset(p, settings)) return p.id;
  return null;
}
