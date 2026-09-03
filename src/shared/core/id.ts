/**
 * Generate unique identifiers. Uses the platform's crypto API when available
 * (browser `globalThis.crypto` or Node's bundled `globalThis.crypto`), falling
 * back to a random fallback. Safe for offline, local-first use.
 */

function uuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function createId(prefix = "id"): string {
  return `${prefix}_${uuid()}`;
}

export function createProjectId(): string {
  return `proj_${uuid()}`;
}
