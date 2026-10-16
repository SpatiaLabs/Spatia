/**
 * Brush types — the *rendering* character of a freehand stroke, as opposed to
 * its colour/size/opacity. A brush kind changes what the mark actually looks
 * like when it is painted: a pencil is thin and grainy, a marker has a broad
 * square-edged body, a highlighter lays down a wide translucent band that
 * multiplies with what is underneath, and a calligraphy nib turns with the
 * direction of travel so the stroke is thick across the nib and thin along it.
 *
 * This module is deliberately environment-free (no DOM, no Node) so the same
 * profiles and geometry drive the canvas renderer, the web build, persistence
 * and the unit tests. The brush kind for a stroke is stored in the pen object's
 * `metadata.brush` field, which every serializer already round-trips, so older
 * documents keep opening unchanged and simply default to `pen`.
 */
import type { WorldPoint } from "../types/object.js";

export type BrushKind =
  | "pen"
  | "pencil"
  | "ballpoint"
  | "marker"
  | "brush"
  | "highlighter"
  | "calligraphy";

/** Where the brush kind is parked on a pen object (kept in generic metadata). */
export const BRUSH_METADATA_KEY = "brush";

export interface BrushProfile {
  id: BrushKind;
  label: string;
  description: string;
  /** Multiplies the configured base size (world units). */
  widthScale: number;
  /** Multiplies the configured opacity. */
  opacityScale: number;
  /** End-cap shape for uniform strokes. */
  cap: "round" | "butt" | "square";
  /** Compositing mode used while painting the mark. */
  blend: "source-over" | "multiply";
  /** Whether captured stylus pressure modulates the width. */
  pressure: boolean;
  /** 0 = crisp edge, >0 = softened/spread edge (draws a wider low-alpha pass). */
  softness: number;
  /** 0 = smooth, >0 = grainy tooth overlay (pencil-like). */
  grain: number;
  /** Degrees of the flat nib edge for an angled nib (calligraphy only). */
  nibAngleDeg?: number;
  /** Minimum width ratio of an angled nib in its thin direction (0..1). */
  minRatio?: number;
}

export const BRUSH_PROFILES: Readonly<Record<BrushKind, BrushProfile>> = {
  pen: {
    id: "pen",
    label: "Pen",
    description: "Smooth variable-width ink that follows stylus pressure.",
    widthScale: 1,
    opacityScale: 1,
    cap: "round",
    blend: "source-over",
    pressure: true,
    softness: 0,
    grain: 0,
  },
  pencil: {
    id: "pencil",
    label: "Pencil",
    description: "Thin dry graphite with a grainy, slightly uneven edge.",
    widthScale: 0.8,
    opacityScale: 0.9,
    cap: "round",
    blend: "source-over",
    pressure: true,
    softness: 0,
    grain: 0.65,
  },
  ballpoint: {
    id: "ballpoint",
    label: "Ballpoint",
    description: "Uniform, fully opaque line with a crisp edge.",
    widthScale: 1,
    opacityScale: 1,
    cap: "round",
    blend: "source-over",
    pressure: false,
    softness: 0,
    grain: 0,
  },
  marker: {
    id: "marker",
    label: "Marker",
    description: "Broad square-tipped felt pen with a solid body.",
    widthScale: 1.7,
    opacityScale: 1,
    cap: "square",
    blend: "source-over",
    pressure: false,
    softness: 0.25,
    grain: 0,
  },
  brush: {
    id: "brush",
    label: "Brush",
    description: "Soft round bristle that swells with pressure and tapers at the ends.",
    widthScale: 1.8,
    opacityScale: 1,
    cap: "round",
    blend: "source-over",
    pressure: true,
    softness: 0.6,
    grain: 0,
  },
  highlighter: {
    id: "highlighter",
    label: "Highlighter",
    description: "Wide translucent band that multiplies over the canvas.",
    widthScale: 3,
    opacityScale: 0.5,
    cap: "butt",
    blend: "multiply",
    pressure: false,
    softness: 0,
    grain: 0,
  },
  calligraphy: {
    id: "calligraphy",
    label: "Calligraphy nib",
    description: "Angled chisel nib: thick across the flat edge, thin along it.",
    widthScale: 1,
    opacityScale: 1,
    cap: "butt",
    blend: "source-over",
    pressure: false,
    softness: 0,
    grain: 0,
    nibAngleDeg: -35,
    minRatio: 0.18,
  },
};

/** Stable ordered list (drives the brush picker in the UI). */
export const BRUSH_KINDS: readonly BrushKind[] = [
  "pen",
  "pencil",
  "ballpoint",
  "marker",
  "brush",
  "highlighter",
  "calligraphy",
];

export function isBrushKind(value: unknown): value is BrushKind {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(BRUSH_PROFILES, value);
}

export function brushProfile(kind: BrushKind): BrushProfile {
  return BRUSH_PROFILES[kind] ?? BRUSH_PROFILES.pen;
}

/** Read the brush kind stored on a pen object, defaulting to `pen`. */
export function penBrushKind(pen: { metadata?: Record<string, unknown> }): BrushKind {
  const raw = pen.metadata?.[BRUSH_METADATA_KEY];
  return isBrushKind(raw) ? raw : "pen";
}

/**
 * Store a brush kind on a (mutable) pen object's metadata. `pen` is the default
 * and is dropped so pre-brush documents and new plain strokes serialise
 * identically.
 */
export function setPenBrush(pen: { metadata: Record<string, unknown> }, kind: BrushKind): void {
  if (kind === "pen") delete pen.metadata[BRUSH_METADATA_KEY];
  else pen.metadata[BRUSH_METADATA_KEY] = kind;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * Per-vertex widths for an angled chisel nib.
 *
 * A flat nib is a straight edge of length `fullWidth` held at a fixed angle
 * `nibAngleDeg`. Dragging it in direction θ sweeps a band whose width measured
 * perpendicular to travel is `fullWidth * |sin(nibAngle − θ)|` — full width
 * when moving across the edge, a thin sliver when moving along it. That single
 * fact produces the whole calligraphy look (thick downstrokes, hairline
 * diagonals) while the existing variable-width ribbon in the renderer turns the
 * per-vertex widths into a real filled outline.
 *
 * Directions are averaged across the adjacent segments at every interior vertex
 * so corners bend the nib naturally; endpoints borrow their single adjacent
 * segment. The ratio is floored at `minRatio` so the thin direction never
 * collapses to an invisible zero-width line.
 */
export function calligraphyWidths(
  points: readonly WorldPoint[],
  fullWidth: number,
  nibAngleDeg: number,
  minRatio = 0.18
): WorldPoint[] {
  const n = points.length;
  if (n === 0) return [];
  const nib = (nibAngleDeg * Math.PI) / 180;
  const floor = clamp01(minRatio);
  const width = Math.max(0.01, fullWidth);
  const out: WorldPoint[] = new Array(n);

  for (let i = 0; i < n; i++) {
    // Direction of travel at this vertex, averaged from the segments touching
    // it (more stable than a single noisy sample).
    let dx = 0;
    let dy = 0;
    if (i > 0) {
      dx += points[i].x - points[i - 1].x;
      dy += points[i].y - points[i - 1].y;
    }
    if (i < n - 1) {
      dx += points[i + 1].x - points[i].x;
      dy += points[i + 1].y - points[i].y;
    }
    const len = Math.hypot(dx, dy);
    // A degenerate direction (all points coincident) reads as "along the nib".
    const theta = len > 1e-9 ? Math.atan2(dy, dx) : nib;
    const ratio = Math.max(floor, Math.abs(Math.sin(nib - theta)));
    out[i] = { x: points[i].x, y: points[i].y, width: width * ratio };
  }
  return out;
}

/**
 * Shape a stroke's stored points for a brush kind, returning fresh points.
 *
 * `points` arrives from the capture pipeline (already smoothed/resampled) and
 * may carry pressure widths. The result:
 *  - calligraphy: angle-derived widths over every vertex (pressure ignored, as
 *    a real nib's breadth is set by orientation, not force);
 *  - uniform brushes (ballpoint/marker/highlighter): widths stripped so the
 *    renderer strokes one crisp constant-width line;
 *  - pressure brushes (pen/pencil/brush): existing pressure widths scaled up by
 *    the profile, or left uniform when the input had no pressure at all.
 */
export function applyBrushGeometry(
  points: readonly WorldPoint[],
  kind: BrushKind,
  nominalWidth: number
): WorldPoint[] {
  const profile = brushProfile(kind);
  if (kind === "calligraphy") {
    return calligraphyWidths(points, nominalWidth * profile.widthScale, profile.nibAngleDeg ?? -35, profile.minRatio ?? 0.18);
  }
  const hasPressure = points.some((p) => p.width !== undefined);
  if (!profile.pressure || !hasPressure) {
    return points.map((p) => ({ x: p.x, y: p.y }));
  }
  return points.map((p) => ({
    x: p.x,
    y: p.y,
    ...(p.width !== undefined ? { width: p.width * profile.widthScale } : {}),
  }));
}
