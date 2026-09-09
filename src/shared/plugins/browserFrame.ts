/**
 * Pure helpers for the Browser Frame plugin. A browser frame keeps only the
 * address it is showing on its object metadata (`browserUrl`) — never page
 * contents or credentials. This module is shared by the desktop and web
 * builds, so it must not import Node or DOM APIs.
 */

/** Metadata key holding the frame's current address. */
export const BROWSER_URL_KEY = "browserUrl";

/** Read the stored address off a canvas object (empty string when absent). */
export function browserUrlOf(obj: { metadata?: Record<string, unknown> } | null | undefined): string {
  const value = obj?.metadata?.[BROWSER_URL_KEY];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

/**
 * Turn user-entered text into a loadable http(s) URL.
 *  - `example.com`     -> `https://example.com/`  (scheme added)
 *  - `https://x/y`     -> unchanged               (scheme + host kept)
 *  - `why is the sky`  -> Google search           (no host name)
 * Returns "" for anything that is not a usable web address (including URLs
 * carrying userinfo, which look like embedded credentials).
 */
export function normalizeBrowserUrl(input: string): string {
  const raw = String(input ?? "").trim();
  if (!raw) return "";
  let candidate = raw;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
    // No scheme. Bare hosts (with a dot) become https; anything else is a
    // search query that goes through Google.
    const looksLikeQuery = /\s/.test(candidate) || (candidate.startsWith(".") || candidate.endsWith("."));
    const looksLikeHost = !looksLikeQuery && /^[a-zA-Z0-9.-]+(\.[a-zA-Z]{2,})?([/?#].*)?$/.test(candidate);
    if (looksLikeQuery || !looksLikeHost || !candidate.includes(".")) {
      candidate = "https://www.google.com/search?q=" + encodeURIComponent(raw);
    } else {
      candidate = "https://" + candidate;
    }
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return "";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "";
  if (!url.hostname) return "";
  if (url.username || url.password) return "";
  return url.href;
}