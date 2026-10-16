/**
 * Startup timing marks used by the `SPATIA_BENCH=1` diagnostic run.
 *
 * The flag is set by the preload bridge only when the main process was started
 * with `SPATIA_BENCH=1` (see src/main/window.ts), so this is completely inert in
 * normal builds. Marks are printed with `console.log`, which the main process
 * forwards to stdout when benchmarking is enabled.
 *
 * The main process stamps its own marks with `Date.now()` relative to its
 * module start; it passes that epoch to the renderer through
 * `additionalArguments`, so renderer marks use the same wall clock and the
 * whole timeline is directly comparable.
 */
type BenchGlobal = { __spatiaBench?: boolean; __spatiaBenchT0?: number };

function benchT0(): number {
  return (window as unknown as BenchGlobal).__spatiaBenchT0 ?? 0;
}

export function benchEnabled(): boolean {
  return (window as unknown as BenchGlobal).__spatiaBench === true;
}

export function bench(label: string): void {
  if (!benchEnabled()) return;
  const absolute = performance.timeOrigin + performance.now();
  console.log(`[bench] renderer:${label} +${Math.round(absolute - benchT0())}ms`);
}
