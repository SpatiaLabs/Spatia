"use strict";

/**
 * End-to-end tests for the collaboration server. Spins up a real server on an
 * ephemeral port and drives it with real WebSocket clients (the `ws` package
 * installed for the server) to prove permission enforcement, snapshot sync and
 * persistence.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { WebSocket } = require("ws");
const protocol = require("../dist/test/shared/collab/protocol.js");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "spatia-room-test-"));
let port = 0;
let child = null;

const CLOSED_STATE = 3; // ws.CLOSED

function nextMessage(ws, filter = () => true, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("timed out waiting for message"));
    }, timeoutMs);
    function onMessage(data) {
      const msg = JSON.parse(String(data));
      if (!filter(msg)) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(msg);
    }
    ws.on("message", onMessage);
  });
}

function connectAndJoin(user, room = "room-e2e-test") {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on("open", () => {
      ws.send(JSON.stringify({ t: "join", room, user }));
    });
    ws.on("error", reject);
    nextMessage(ws, (m) => m.t === "joined").then((joined) => resolve({ ws, joined })).catch(reject);
  });
}

function send(ws, msg) {
  ws.send(JSON.stringify(msg));
}

before(async () => {
  port = 20000 + Math.floor(Math.random() * 30000);
  child = spawn(process.execPath, [path.join(__dirname, "server.js"), "--port", String(port), "--data", dataDir]);
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  await new Promise((resolve) => {
    let attempts = 0;
    const tryConnect = setInterval(async () => {
      attempts += 1;
      if (attempts > 20) {
        clearInterval(tryConnect);
        return resolve();
      }
      try {
        const ws = new WebSocket(`ws://localhost:${port}`);
        ws.on("open", () => {
          clearInterval(tryConnect);
          ws.close();
          resolve();
        });
        ws.on("error", () => {});
      } catch {
        /* not up yet */
      }
    }, 100);
  });
});

after(() => {
  if (child) child.kill("SIGINT");
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("owner is created for the first joiner and can persist a snapshot", async () => {
  const { ws, joined } = await connectAndJoin({ id: "u-owner", name: "Owner", color: "#ff0000" });
  assert.equal(joined.role, "owner");
  assert.equal(joined.ownerId, "u-owner");

  const file = { formatVersion: 5, project: { id: "p1", name: "Shared doc", createdAt: "", updatedAt: "", tags: [] }, viewport: { x: 0, y: 0, zoom: 1 }, objects: [], assets: [], comments: [] };
  send(ws, { t: "snapshot", file });
  ws.close();
});

test("viewers are denied writes but can observe presence", async () => {
  const owner = await connectAndJoin({ id: "u-owner2", name: "Owner", color: "#ff0000" }, "room-perm");
  const viewer = await connectAndJoin({ id: "u-viewer", name: "Viewer", color: "#00ff00" }, "room-perm");

  const denied = nextMessage(viewer.ws, (m) => m.t === "denied");
  send(viewer.ws, { t: "snapshot", file: { formatVersion: 5, project: {}, viewport: {}, objects: [], assets: [], comments: [] } });
  const d = await denied;
  assert.match(d.action, /viewer/);

  const seenPresence = nextMessage(owner.ws, (m) => m.t === "presence" && m.user.id === "u-viewer");
  send(viewer.ws, { t: "presence", x: 12, y: 34 });
  const p = await seenPresence;
  assert.equal(p.x, 12);
  assert.equal(p.y, 34);

  owner.ws.close();
  viewer.ws.close();
});

test("owner can promote an editor who then syncs a snapshot to a second peer", async () => {
  const owner = await connectAndJoin({ id: "u-o", name: "Owner", color: "#ff0000" }, "room-editor");
  const editor = await connectAndJoin({ id: "u-e", name: "Editor", color: "#00ff00" }, "room-editor");
  const peer = await connectAndJoin({ id: "u-p", name: "Peer", color: "#0000ff" }, "room-editor");

  // Editor starts as viewer; owner promotes.
  assert.equal(editor.joined.role, "viewer");
  const roleChanged = nextMessage(editor.ws, (m) => m.t === "perm:changed" && m.userId === "u-e");
  send(owner.ws, { t: "perm:set", userId: "u-e", role: "editor" });
  await roleChanged;

  const file = {
    formatVersion: 5,
    project: { id: "p-e", name: "Editor doc", createdAt: "", updatedAt: "" },
    viewport: { x: 0, y: 0, zoom: 1 },
    objects: [{ type: "note", id: "obj-e-1", x: 1, y: 2, width: 100, height: 80, rotation: 0, zIndex: 1, locked: false, metadata: {}, title: "Hi", text: "from the editor", color: "#f0c33c" }],
    assets: [],
  };
  const seenAdd = Promise.all([
    nextMessage(owner.ws, (m) => m.t === "snapshot" && m.user.id === "u-e"),
    nextMessage(peer.ws, (m) => m.t === "snapshot" && m.user.id === "u-e"),
  ]);
  send(editor.ws, { t: "snapshot", file });
  const [toOwner, toPeer] = await seenAdd;
  assert.equal(toOwner.file.objects[0].id, "obj-e-1");
  assert.equal(toPeer.file.project.name, "Editor doc");

  // A viewer peer still cannot write, even after the room has an editor.
  const denied = nextMessage(peer.ws, (m) => m.t === "denied");
  send(peer.ws, { t: "snapshot", file: { ...file, project: { id: "p-e", name: "hacked", createdAt: "", updatedAt: "" } } });
  const d = await denied;
  assert.match(d.action, /viewer/);

  owner.ws.close();
  editor.ws.close();
  peer.ws.close();
});

test("room state survives server restart (persistence)", async () => {
  const ROOM = "room-persist";
  const first = await connectAndJoin({ id: "u-1", name: "A", color: "#123456" }, ROOM);
  send(first.ws, { t: "snapshot", file: { formatVersion: 5, project: { id: "p9", name: "persisted", createdAt: "", updatedAt: "", tags: ["x"] }, viewport: { x: 0, y: 0, zoom: 1 }, objects: [], assets: [], comments: [] } });
  await new Promise((r) => setTimeout(r, 150));
  first.ws.close();
  child.kill("SIGINT");
  await new Promise((r) => setTimeout(r, 300));
  child = spawn(process.execPath, [path.join(__dirname, "server.js"), "--port", String(port), "--data", dataDir]);
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  await new Promise((resolve) => {
    const tryConnect = setInterval(() => {
      const ws = new WebSocket(`ws://localhost:${port}`);
      ws.on("open", () => {
        clearInterval(tryConnect);
        ws.close();
        resolve();
      });
      ws.on("error", () => {});
    }, 100);
  });

  const second = await connectAndJoin({ id: "u-2", name: "B", color: "#654321" }, ROOM);
  assert.equal(second.joined.ownerId, "u-1");
  assert.equal(second.joined.role, "viewer");
  assert.equal(second.joined.file.project.name, "persisted");
  second.ws.close();
});

test("protocol rejects malformed messages", () => {
  assert.equal(protocol.sanitizeRoomId("  ok_room-1  "), "ok_room-1");
  assert.equal(protocol.sanitizeRoomId("ab"), null);
  assert.equal(protocol.sanitizeRoomId("bad room!"), null);
  const v = protocol.validateClientMessage({ t: "snapshot", file: { formatVersion: 4 } });
  assert.ok("reason" in v);
  const ok = protocol.validateClientMessage({ t: "snapshot", file: { formatVersion: 5 } });
  assert.ok("message" in ok);
  assert.equal(protocol.MAX_MESSAGE_BYTES, 1024 * 1024);
  assert.equal(CLOSED_STATE, 3);
});