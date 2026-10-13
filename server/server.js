"use strict";

/**
 * Spatia collaboration server.
 *
 * A small, local WebSocket server that brokers shared rooms for Spatia. Rooms
 * are stored as versioned JSON files under `server-data/` (one file per room)
 * and are rehydrated on restart, so collaboration sessions survive server
 * restarts. The server is the single authority for permissions:
 *
 *   - the first joiner of a room becomes its owner (can promote/demote);
 *   - everyone else joins as a viewer and cannot write anything;
 *   - users promoted to "editor" by the owner may push snapshots.
 *
 * Wire format lives in `src/shared/collab/protocol.ts` and is imported from the
 * compiled `dist/` output so the server and clients never drift. Run with:
 *
 *   npm run server [-- --port 8787 --data ./server-data]
 *
 * Since 0.5.1 the server also accepts targeted `ops` batches: each admitted
 * batch bumps the room's monotonic `seq` and is broadcast to every member
 * (including the sender, which treats its copy as an acknowledgement). Ops are
 * last-writer-wins per object, so concurrent editors converge — a stale
 * `baseSeq` is only rejected when it is ahead of the room (impossible after a
 * fresh join, which always ships the full authoritative file + seq).
 */

const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const { WebSocketServer } = require("ws");

// The shared protocol is compiled by the test build (`npm run build:test`),
// so the server imports it from the same compiled tree the tests use.
const protocol = require("../dist/test/shared/collab/protocol.js");
const opsModule = require("../dist/test/shared/collab/ops.js");

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return fallback;
  const v = Number(args[idx + 1]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const PORT = argValue("--port", 8787);
const dataIdx = args.indexOf("--data");
const DATA_DIR = dataIdx !== -1 && args[dataIdx + 1] ? path.resolve(args[dataIdx + 1]) : path.join(__dirname, "server-data");
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Room store (persistent, JSON files, atomic writes).
// ---------------------------------------------------------------------------

/**
 * @typedef {object} RoomState
 * @property {string} roomId
 * @property {string} ownerId
 * @property {Record<string, import("./protocol").CollabRole>} permissions
 * @property {Record<string, unknown> | null} file
 *        Last authoritative ProjectFile snapshot.
 * @property {number} seq
 *        Monotonic linearization counter — bumped once per file-changing batch
 *        (ops or a legacy snapshot). Clients derive their `baseSeq` from it.
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/** @type {Map<string, RoomState>} */
const rooms = new Map();

function roomFile(roomId) {
  return path.join(DATA_DIR, `${roomId}.json`);
}

function loadRoom(roomId) {
  let state = rooms.get(roomId);
  if (state) return state;
  let persisted = null;
  try {
    persisted = JSON.parse(fs.readFileSync(roomFile(roomId), "utf8"));
  } catch {
    persisted = null;
  }
  state = rooms.get(roomId) || {
    roomId,
    ownerId: persisted && typeof persisted.ownerId === "string" ? persisted.ownerId : "",
    permissions: sanitizePermissions(persisted ? persisted.permissions : undefined),
    file: persisted && persisted.file ? persisted.file : null,
    seq: persisted && typeof persisted.seq === "number" ? persisted.seq : 0,
    createdAt: (persisted && persisted.createdAt) || new Date().toISOString(),
    updatedAt: (persisted && persisted.updatedAt) || new Date().toISOString(),
  };
  rooms.set(roomId, state);
  return state;
}

function sanitizePermissions(p) {
  const out = {};
  if (typeof p === "object" && p !== null) {
    for (const [key, role] of Object.entries(p)) {
      if (protocol.isCollabRole(role) && typeof key === "string" && key.length <= 64) out[key] = role;
    }
  }
  return out;
}

function persistRoom(room) {
  room.updatedAt = new Date().toISOString();
  const tmp = `${roomFile(room.roomId)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(room, null, 2));
  fs.renameSync(tmp, roomFile(room.roomId));
}

/** An empty v5 file used as the on-disk baseline for ops-only rooms. */
function emptyRoomFile() {
  const now = new Date().toISOString();
  return {
    formatVersion: 5,
    project: { id: "", name: "Shared room", createdAt: now, updatedAt: now },
    viewport: { x: 0, y: 0, zoom: 1 },
    objects: [],
    assets: [],
  };
}

// ---------------------------------------------------------------------------
// Connections.
// ---------------------------------------------------------------------------

/** @type {Map<import("ws").WebSocket, { user: import("./protocol").CollabUser; roomId: string; lastSnapshotAt: number }>} */
const clients = new Map();

const PLUGINS_DIR = path.join(__dirname, "..", "Spatia Download & Web", "plugins");

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method !== "GET" || !url.pathname.startsWith("/plugins/")) {
    res.writeHead(404).end("Not found");
    return;
  }
  const rel = url.pathname.slice("/plugins/".length);
  const file = path.resolve(PLUGINS_DIR, rel);
  if (!file.startsWith(PLUGINS_DIR + path.sep)) {
    res.writeHead(404).end("Not found");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end("Not found");
      return;
    }
    const type = file.endsWith(".json") ? "application/json" : file.endsWith(".js") ? "text/javascript" : "application/octet-stream";
    res.writeHead(200, { "Content-Type": type }).end(data);
  });
});

const wss = new WebSocketServer({ server });

// Surface bind failures (port already in use) as a clear error instead of an
// uncaught exception, then exit so callers know the server did not start.
wss.on("error", (err) => {
  console.error(`Spatia collaboration server failed to start on port ${PORT}:`, err.message);
  process.exit(1);
});

wss.on("listening", () => {
  console.log(`Spatia collaboration server listening on ws://localhost:${PORT}`);
  console.log(`Room data lives in ${DATA_DIR}`);
});

server.listen(PORT, () => {
  console.log(`Plugins served from http://localhost:${PORT}/plugins/browser-frame/manifest.json`);
});

wss.on("connection", (socket) => {
  socket.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(String(raw));
    } catch {
      return deny(socket, "malformed JSON");
    }
    if (protocol.jsonBytes(data) > protocol.MAX_MESSAGE_BYTES) {
      return deny(socket, "message too large");
    }
    const parsed = protocol.validateClientMessage(data);
    if ("reason" in parsed) {
      return deny(socket, parsed.reason);
    }

    const msg = parsed.message;
    const joined = clients.get(socket);
    if (msg.t !== "join" && !joined) {
      return deny(socket, "join first");
    }
    handle(socket, msg, joined);
  });

  socket.on("close", () => {
    const joined = clients.get(socket);
    if (!joined) return;
    clients.delete(socket);
    const room = rooms.get(joined.roomId);
    if (room) broadcast(room, joined.user, { t: "peer:leave", user: joined.user });
  });

  socket.on("error", () => {
    /* socket-level errors are handled by close/deny paths */
  });
});

function deny(socket, reason) {
  send(socket, { t: "denied", action: reason });
}

function send(socket, message) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function broadcast(room, _from, message) {
  for (const [socket, joined] of clients) {
    if (joined.roomId !== room.roomId) continue;
    send(socket, message);
  }
}

/** Send to everyone in the room except `except`. */
function broadcastOthers(room, except, message) {
  for (const [socket, joined] of clients) {
    if (joined.roomId !== room.roomId || socket === except) continue;
    send(socket, message);
  }
}

function roleFor(room, userId) {
  if (room.ownerId === userId) return "owner";
  return room.permissions[userId] || "viewer";
}

/** @returns {boolean} true when the user may mutate document state. */
function canEdit(role) {
  return role === "owner" || role === "editor";
}

function handle(socket, msg, joined) {
  switch (msg.t) {
    case "join": {
      const room = loadRoom(msg.room);
      if (!room.ownerId) {
        room.ownerId = msg.user.id;
      }
      clients.set(socket, { user: msg.user, roomId: room.roomId, lastSnapshotAt: 0 });
      const users = [...clients.entries()].filter(([, j]) => j.roomId === room.roomId).map(([, j]) => j.user);
      send(socket, {
        t: "joined",
        room: room.roomId,
        role: roleFor(room, msg.user.id),
        ownerId: room.ownerId,
        users,
        permissions: { ...room.permissions },
        file: room.file,
        seq: room.seq,
      });
      broadcastOthers(room, socket, { t: "peer:join", user: msg.user });
      break;
    }

    case "presence": {
      const room = rooms.get(joined.roomId);
      broadcastOthers(room, socket, { t: "presence", user: joined.user, x: msg.x, y: msg.y });
      break;
    }

    case "selection": {
      const room = rooms.get(joined.roomId);
      broadcastOthers(room, socket, { t: "selection", user: joined.user, ids: msg.ids });
      break;
    }

    case "snapshot": {
      const room = rooms.get(joined.roomId);
      if (!canEdit(roleFor(room, joined.user.id))) {
        return send(socket, { t: "denied", action: "read-only viewer — ask the owner for editing access" });
      }
      // Coarse rate limit: at most one authoritative snapshot per client/second.
      const now = Date.now();
      if (now - joined.lastSnapshotAt < 1000) {
        return send(socket, { t: "denied", action: "snapshot rate limit" });
      }
      joined.lastSnapshotAt = now;
      room.file = msg.file;
      room.seq += 1;
      persistRoom(room);
      broadcastOthers(room, socket, { t: "snapshot", user: joined.user, file: msg.file });
      break;
    }

    case "ops": {
      const room = rooms.get(joined.roomId);
      if (!canEdit(roleFor(room, joined.user.id))) {
        return send(socket, { t: "denied", action: "read-only viewer — ask the owner for editing access" });
      }
      // A baseSeq beyond the room's counter is impossible after a fresh join
      // (which ships file + seq); treat it as a resync request instead of
      // accepting ungrounded edits.
      if (msg.baseSeq > room.seq) {
        return send(socket, { t: "denied", action: "sequence out of date — reconnect and rejoin to resync" });
      }
      if (!room.file) room.file = emptyRoomFile();
      const applied = opsModule.applyOps(
        { objects: room.file.objects, assets: room.file.assets, meta: room.file.project },
        msg.ops
      );
      if (applied === 0) {
        // The batch changed nothing (e.g. a re-sent, already-applied diff).
        // Ack only the sender so its sync engine advances its baseline; do NOT
        // bump seq or rebroadcast, since the room state is untouched.
        return send(socket, { t: "ops", user: joined.user, seq: room.seq, baseSeq: msg.baseSeq, ops: msg.ops });
      }
      room.seq += 1;
      persistRoom(room);
      // Broadcast to the whole room INCLUDING the sender, whose copy this is —
      // it doubles as the acknowledgement the sync engine flushes on.
      broadcast(room, null, { t: "ops", user: joined.user, seq: room.seq, baseSeq: msg.baseSeq, ops: msg.ops });
      break;
    }

    case "ping": {
      send(socket, { t: "pong" });
      break;
    }

    case "perm:set": {
      const room = rooms.get(joined.roomId);
      if (roleFor(room, joined.user.id) !== "owner") {
        return send(socket, { t: "denied", action: "only the room owner can change permissions" });
      }
      if (msg.userId === room.ownerId) {
        return send(socket, { t: "denied", action: "the owner's role cannot be changed" });
      }
      room.permissions[msg.userId] = msg.role;
      persistRoom(room);
      broadcast(room, joined.user, { t: "perm:changed", user: joined.user, userId: msg.userId, role: msg.role });
      break;
    }
  }
}

function shutdown() {
  for (const socket of clients.keys()) {
    socket.close();
  }
  wss.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);