import { colorForName } from "../../shared/collab/protocol.js";
import type { CollabUser } from "../../shared/collab/protocol.js";
import { createId } from "../../shared/core/id.js";

/**
 * A stable per-machine collaboration identity. The desktop app persists it in
 * the main process (settings file) through the bridge; the web app keeps it in
 * localStorage. Either way the renderer gets a `CollabUser` with a stable id
 * and the user's chosen display name so room memberships survive restarts.
 */
export async function loadCollabIdentity(): Promise<CollabUser> {
  if (window.spatia?.collabGetIdentity) {
    try {
      const stored = await window.spatia.collabGetIdentity();
      return { id: stored.id, name: stored.name, color: colorForName(stored.name) };
    } catch {
      /* bridge unavailable — fall through to local identity */
    }
  }
  const KEY = "spatia.collab.identity";
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as { id?: string; name?: string } | null;
    if (raw && typeof raw.id === "string" && raw.id && typeof raw.name === "string") {
      return { id: raw.id, name: raw.name, color: colorForName(raw.name) };
    }
  } catch {
    /* fall through to fresh identity */
  }
  const fresh: CollabUser = { id: createId("user"), name: "Guest", color: colorForName("Guest") };
  try {
    localStorage.setItem(KEY, JSON.stringify({ id: fresh.id, name: fresh.name }));
  } catch {
    /* storage unavailable — memory-only identity is fine */
  }
  return fresh;
}