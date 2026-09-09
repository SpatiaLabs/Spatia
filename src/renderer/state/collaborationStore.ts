import { Emitter } from "./emitter.js";
import { normalizeCollabUrl, DEFAULT_COLLAB_URL, type CollabUser, type CollabRole, type ClientMessage, type ServerMessage } from "../../shared/collab/protocol.js";

export type CollabStatus = "offline" | "connecting" | "connected" | "error";

/** Live state about one remote participant. */
export interface RemotePeer {
  user: CollabUser;
  role: CollabRole;
  presence: { x: number; y: number } | null;
  selection: readonly string[];
}

/**
 * Collaboration store. Owns the WebSocket connection, the room identity and the
 * live view of peers (presence + selection). Pure state + transport — the App
 * controller and the presence overlay react to `changed`. The store never
 * mutates document state itself; incoming document data is passed to the
 * callback the App wires up.
 */
export class CollaborationStore {
  readonly changed = new Emitter<void>();

  status: CollabStatus = "offline";
  error = "";
  serverUrl = "ws://localhost:8787";
  roomId = "";
  role: CollabRole = "viewer";
  ownerId = "";
  user: CollabUser | null = null;
  readonly peers = new Map<string, RemotePeer>();
  readonly permissions = new Map<string, CollabRole>();

  /** Remote peers with a live presence point. */
  get activePeers(): Array<{ user: CollabUser; presence: { x: number; y: number } }> {
    const out: Array<{ user: CollabUser; presence: { x: number; y: number } }> = [];
    for (const peer of this.peers.values()) {
      if (peer.presence) out.push({ user: peer.user, presence: peer.presence });
    }
    return out;
  }

  get canEdit(): boolean {
    return this.role === "owner" || this.role === "editor";
  }

  get isJoined(): boolean {
    return this.status === "connected" && this.roomId !== "";
  }

  /** Wired by the App: a full document snapshot arrived from the room. */
  onRemoteFile: ((file: Record<string, unknown>) => void) | null = null;

  private socket: WebSocket | null = null;
  private pendingJoin = "";
  private lastPresenceSent = 0;
  private manualDisconnect = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Persistent writes (snapshots) queued while offline. */
  private backlog: ClientMessage[] = [];

  // -------- Transport --------

  connect(serverUrl: string): void {
    this.serverUrl = normalizeCollabUrl(serverUrl) || DEFAULT_COLLAB_URL;
    this.manualDisconnect = false;
    this.reconnectAttempts = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.onclose = null;
      try {
        this.socket.close();
      } catch {
        /* already closed */
      }
      this.socket = null;
    }
    this.status = "connecting";
    this.error = "";
    this.peers.clear();
    this.permissions.clear();
    this.changed.emit();
    this.openSocket();
  }

  private openSocket(): void {
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.serverUrl);
    } catch {
      this.status = "error";
      this.error = "Invalid server URL";
      this.changed.emit();
      return;
    }
    this.socket = socket;
    socket.onopen = (): void => {
      this.status = "connected";
      this.error = "";
      this.reconnectAttempts = 0;
      this.changed.emit();
      if (this.pendingJoin) this.sendRaw({ t: "join", room: this.pendingJoin, user: this.requireUser() });
    };
    socket.onmessage = (event: MessageEvent): void => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      this.handleMessage(msg);
    };
    socket.onclose = (): void => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.peers.clear();
      this.permissions.clear();
      if (this.manualDisconnect) {
        this.roomId = "";
        this.role = "viewer";
        this.status = "offline";
        this.error = "";
        this.backlog = [];
        this.changed.emit();
        return;
      }
      // Unexpected drop: schedule a rejoin with capped exponential backoff so a
      // room member comes back without user action.
      if (this.pendingJoin && this.reconnectAttempts < 5) {
        this.status = "connecting";
        this.roomId = "";
        this.changed.emit();
        const delay = Math.min(800 * Math.pow(2, this.reconnectAttempts), 10000);
        this.reconnectAttempts++;
        this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
      } else {
        // Give up with an accurate, actionable state — the join is still
        // pending, so a later connect() re-attempts the same join.
        this.status = "error";
        this.roomId = "";
        this.error = `Could not reach the collaboration server at ${this.serverUrl}. Start it with "npm run server" and reconnect.`;
        this.changed.emit();
      }
    };
    socket.onerror = (): void => {
      // A socket error while (re)connecting must not be reported as a terminal
      // failure — the retry loop above may still land a connection. Keep the
      // connecting state surfaced and only surface `error` when the budget is
      // exhausted.
      if (this.socket !== socket) return;
      this.status = "connecting";
      this.error = "Can't reach the server — retrying…";
      this.changed.emit();
    };
  }

  disconnect(): void {
    this.manualDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    if (this.socket) {
      this.socket.onclose = null;
      try {
        this.socket.close();
      } catch {
        /* already closed */
      }
      this.socket = null;
    }
    this.status = "offline";
    this.roomId = "";
    this.role = "viewer";
    this.pendingJoin = "";
    this.peers.clear();
    this.permissions.clear();
    this.backlog = [];
    this.changed.emit();
  }

  /** Connect (if needed) and join a room as soon as the socket is open. */
  join(roomId: string, user: CollabUser): void {
    this.manualDisconnect = false;
    this.user = user;
    this.pendingJoin = roomId;
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.roomId = roomId;
      this.sendRaw({ t: "join", room: roomId, user: this.requireUser() });
    } else {
      this.connect(this.serverUrl);
    }
  }

  private sendRaw(msg: ClientMessage): void {
    this.socket?.send(JSON.stringify(msg));
  }

  private send(msg: ClientMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      // Snapshot writes survive a reconnect; transient signals are dropped.
      if (msg.t === "snapshot") {
        if (this.backlog.length < 50) this.backlog.push(msg);
      }
      return;
    }
    this.sendRaw(msg);
  }

  private flushBacklog(): void {
    if (this.backlog.length === 0) return;
    const queued = this.backlog;
    this.backlog = [];
    for (const msg of queued) this.sendRaw(msg);
  }

  private requireUser(): CollabUser {
    if (!this.user) throw new Error("No collab user assigned");
    return this.user;
  }

  // -------- Outgoing signals --------

  sendPresence(x: number, y: number): void {
    if (!this.isJoined) return;
    const now = Date.now();
    if (now - this.lastPresenceSent < 120) return;
    this.lastPresenceSent = now;
    this.send({ t: "presence", x, y });
  }

  sendSelection(ids: readonly string[]): void {
    if (!this.isJoined) return;
    this.send({ t: "selection", ids: [...ids] });
  }

  sendSnapshot(file: Record<string, unknown>): void {
    if (!this.isJoined || !this.canEdit) return;
    this.send({ t: "snapshot", file });
  }

  sendPermSet(userId: string, role: CollabRole): void {
    if (!this.isJoined || this.role !== "owner") return;
    this.send({ t: "perm:set", userId, role });
  }

  // -------- Incoming messages --------

  private handleMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case "joined": {
        this.roomId = msg.room;
        this.role = msg.role;
        this.ownerId = msg.ownerId;
        this.permissions.clear();
        for (const [id, role] of Object.entries(msg.permissions)) this.permissions.set(id, role);
        const prev = new Set(this.peers.keys());
        this.peers.clear();
        for (const u of msg.users) {
          const role = u.id === msg.ownerId ? "owner" : msg.permissions[u.id] || "viewer";
          this.peers.set(u.id, { user: u, role, presence: prev.has(u.id) ? this.peers.get(u.id)!.presence ?? null : null, selection: [] });
        }
        if (msg.file) this.onRemoteFile?.(msg.file as Record<string, unknown>);
        this.flushBacklog();
        this.changed.emit();
        break;
      }
      case "peer:join": {
        if (msg.user.id !== this.user?.id) {
          this.peers.set(msg.user.id, { user: msg.user, role: "viewer", presence: null, selection: [] });
          this.changed.emit();
        }
        break;
      }
      case "peer:leave": {
        this.peers.delete(msg.user.id);
        this.changed.emit();
        break;
      }
      case "presence": {
        const peer = this.peers.get(msg.user.id);
        if (peer) {
          peer.presence = { x: msg.x, y: msg.y };
          this.changed.emit();
        }
        break;
      }
      case "selection": {
        const peer = this.peers.get(msg.user.id);
        if (peer) {
          peer.selection = msg.ids;
          this.changed.emit();
        }
        break;
      }
      case "snapshot": {
        if (msg.user.id !== this.user?.id) this.onRemoteFile?.(msg.file);
        break;
      }
      case "perm:changed": {
        this.permissions.set(msg.userId, msg.role);
        if (msg.userId === this.user?.id) this.role = msg.role;
        const peer = this.peers.get(msg.userId);
        if (peer) peer.role = msg.role;
        this.changed.emit();
        break;
      }
      case "denied": {
        this.error = msg.action;
        this.changed.emit();
        break;
      }
      case "error": {
        this.error = msg.reason;
        this.changed.emit();
        break;
      }
    }
  }
}