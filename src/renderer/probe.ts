/**
 * Startup probe — inert except during a `SPATIA_BENCH=1` run.
 *
 * Loaded as the first module in index.html, before the application graph, so
 * its mark isolates HTML parsing / process setup from the app's module
 * evaluation. It also records the browser's first paint, which is when the
 * window becomes visibly useful.
 */
interface BenchGlobal {
  __spatiaBench?: boolean;
  __spatiaBenchT0?: number;
}

const g = window as unknown as BenchGlobal;

function mark(label: string): void {
  const absolute = performance.timeOrigin + performance.now();
  console.log(`[bench] renderer:${label} +${Math.round(absolute - (g.__spatiaBenchT0 ?? 0))}ms`);
}

if (g.__spatiaBench === true) {
  mark("probe");
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === "first-paint") mark("first-paint");
        if (entry.name === "first-contentful-paint") mark("first-contentful-paint");
      }
    }).observe({ type: "paint", buffered: true });
  } catch {
    /* the paint timing API is optional */
  }
}
