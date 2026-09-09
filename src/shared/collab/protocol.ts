/**
 * Real-time collaboration wire protocol (Phase 2, M4).
 *
 * Pure, dependency-free message types and validators shared by the Electron
 * renderer, the web build and the local collaboration server (which imports
 * this module from the compiled `dist/` output). The protocol is JSON over
 * a single WebSocket per client; the server is authoritative for permissions
 * and persists rooms under `server-data/`.
 */

export type CollabRole = "owner" | "editor" | "viewer";

export interface CollabUser {
  /** Stable per-machine identity (persisted in settings). */
  id: string;
  /** Display name, chosen by the user. */
  name: string;
  /** Assigned color (hex) used for presence markers. */
  color: string;
}

/** Client -> server. */
export type ClientMessage =
  | { t: "join"; room: string; user: CollabUser }
  | { t: "presence"; x: number; y: number }
  | { t: "selection"; ids: string[] }
  | { t: "snapshot"; file: Record<string, unknown> }
  | { t: "perm:set"; userId: string; role: CollabRole };

/** Server -> client. */
export type ServerMessage =
  | { t: "joined"; room: string; role: CollabRole; ownerId: string; users: CollabUser[]; permissions: Record<string, CollabRole>; file: Record<string, unknown> | null }
  | { t: "peer:join"; user: CollabUser }
  | { t: "peer:leave"; user: CollabUser }
  | { t: "presence"; user: CollabUser; x: number; y: number }
  | { t: "selection"; user: CollabUser; ids: string[] }
  | { t: "snapshot"; user: CollabUser; file: Record<string, unknown> }
  | { t: "perm:changed"; user: CollabUser; userId: string; role: CollabRole }
  | { t: "error"; reason: string }
  | { t: "denied"; action: string };

export const MAX_MESSAGE_BYTES = 1024 * 1024;
export const MAX_TAGS = 100;
export const ROOM_ID_PATTERN = /^[a-zA-Z0-9_-]{4,64}$/;
export const DEFAULT_COLLAB_URL = "ws://localhost:8787";

/**
 * Normalize a user-supplied collaboration server URL to a usable WebSocket
 * URL: `http://` → `ws://`, `https://` → `wss://`, and bare hostnames get the
 * default port. Invalid/missing input falls back to the default URL.
 */
export function normalizeCollabUrl(raw: string): string {
  let input = (raw ?? "").trim();
  if (!input) input = DEFAULT_COLLAB_URL;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input)) {
    input = `${DEFAULT_COLLAB_URL.replace("ws://", "").split(":")[0]}://${input}`;
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return DEFAULT_COLLAB_URL;
  }
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") return DEFAULT_COLLAB_URL;
  if (!url.port) url.port = url.protocol === "wss:" ? "443" : "8787";
  return url.toString().replace(/\/$/, "");
}

const ROLES: readonly CollabRole[] = ["owner", "editor", "viewer"];

const PRESENCE_COLORS = [
  "#4f8cff",
  "#f06595",
  "#12b886",
  "#e8590c",
  "#7048e8",
  "#f59f00",
  "#0c8599",
  "#94d82d",
  "#d6336c",
  "#3bc9db",
  "#e64980",
  "#74b816",
];

/** Deterministically pick a presence color for a display name. */
export function colorForName(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return PRESENCE_COLORS[Math.abs(h) % PRESENCE_COLORS.length];
}

export function isCollabRole(v: unknown): v is CollabRole {
  return typeof v === "string" && (ROLES as readonly string[]).includes(v);
}

export function sanitizeRoomId(room: unknown): string | null {
  if (typeof room !== "string") return null;
  const id = room.trim();
  if (!ROOM_ID_PATTERN.test(id)) return null;
  return id;
}

export function isCollabUser(v: unknown): v is CollabUser {
  if (typeof v !== "object" || v === null) return false;
  const u = v as Record<string, unknown>;
  return (
    typeof u.id === "string" &&
    u.id.length > 0 &&
    u.id.length <= 64 &&
    typeof u.name === "string" &&
    u.name.length > 0 &&
    u.name.length <= 80 &&
    typeof u.color === "string" &&
    /^#[0-9a-fA-F]{6}$/.test(u.color)
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Approximate JSON byte size (uppercase/escape-agnostic; fine for caps). */
export function jsonBytes(msg: unknown): number {
  return JSON.stringify(msg).length;
}

/**
 * Validate an incoming client message. Returns a human-readable reason or
 * null when the message is well-formed (permission checks are not performed
 * here — the server enforces capabilities separately).
 */
export function validateClientMessage(raw: unknown): { message: ClientMessage } | { reason: string } {
  if (!isPlainObject(raw)) return { reason: "not an object" };
  const m = raw as Record<string, unknown>;
  if (typeof m.t !== "string" || m.t.length === 0) return { reason: "missing type" };
  switch (m.t) {
    case "join": {
      const room = sanitizeRoomId(m.room);
      if (room === null) return { reason: "invalid room id" };
      if (!isCollabUser(m.user)) return { reason: "invalid user" };
      const user = m.user as CollabUser;
      return { message: { t: "join", room, user } };
    }
    case "presence": {
      if (typeof m.x !== "number" || typeof m.y !== "number" || !Number.isFinite(m.x) || !Number.isFinite(m.y)) {
        return { reason: "invalid presence point" };
      }
      return { message: { t: "presence", x: m.x, y: m.y } };
    }
    case "selection": {
      if (!Array.isArray(m.ids) || m.ids.some((id) => typeof id !== "string")) {
        return { reason: "invalid selection" };
      }
      return { message: { t: "selection", ids: m.ids as string[] } };
    }
    case "snapshot": {
      if (!isPlainObject(m.file)) return { reason: "invalid snapshot" };
      const file = m.file as Record<string, unknown>;
      if (file.formatVersion !== 5) return { reason: "unsupported format version" };
      return { message: { t: "snapshot", file } };
    }
    case "perm:set": {
      if (typeof m.userId !== "string" || m.userId.length === 0) return { reason: "invalid user id" };
      if (!isCollabRole(m.role)) return { reason: "invalid role" };
      return { message: { t: "perm:set", userId: m.userId as string, role: m.role } };
    }
    default:
      return { reason: `unknown message type "${m.t}"` };
  }
}