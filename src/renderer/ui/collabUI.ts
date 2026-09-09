import type { CollabUser } from "../../shared/collab/protocol.js";
import type { CanvasObject } from "../../shared/types/object.js";
import type { Point } from "../../shared/geometry/viewport.js";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface CollabShareView {
  status: "offline" | "connecting" | "connected" | "error";
  error: string;
  serverUrl: string;
  roomId: string;
  role: string;
  ownerId: string;
  canConnect: boolean;
  canLeave: boolean;
  canCreate: boolean;
  inviteLink: string;
  selfName: string;
  peers: Array<{ user: CollabUser; role: string }>;
}

export interface CollabOverlayInputs {
  toScreen: (world: Point) => { x: number; y: number };
  zoom: number;
  objects: readonly CanvasObject[];
  presences: Array<{ user: CollabUser; x: number; y: number }>;
  selections: Map<string, readonly string[]>;
}

function roleLabel(role: string): string {
  if (role === "owner") return "Owner";
  if (role === "editor") return "Editor";
  return "Viewer";
}

/**
 * Thin DOM layer for everything collaboration-shaped: the Share dialog and the
 * presence/selection overlay rendered over the canvas. All state to display is
 * passed in from the App controller; this class only owns DOM + events.
 */
export class CollabUI {
  readonly shareDialog = el<HTMLElement>("share-dialog");
  readonly presenceLayer = el<HTMLElement>("presence-layer");

  readonly btnShare = el<HTMLButtonElement>("btn-share");

  private shareUrlInput = el<HTMLInputElement>("share-url");
  private shareConnect = el<HTMLButtonElement>("share-connect");
  private shareDisconnect = el<HTMLButtonElement>("share-disconnect");
  private shareStatus = el<HTMLDivElement>("share-status");
  private shareRoomLabel = el<HTMLDivElement>("share-room-label");
  private shareRoomInput = el<HTMLInputElement>("share-room-input");
  private shareJoin = el<HTMLButtonElement>("share-join");
  private shareCreate = el<HTMLButtonElement>("share-create");
  private shareCopy = el<HTMLButtonElement>("share-copy");
  private shareLeave = el<HTMLButtonElement>("share-leave");
  private shareRole = el<HTMLDivElement>("share-role");
  private shareUsers = el<HTMLDivElement>("share-users");
  private shareClose = el<HTMLButtonElement>("share-close");

  // -------- Callbacks wired by the App --------
  onConnect: ((url: string) => void) | null = null;
  onDisconnect: (() => void) | null = null;
  onJoinRoom: ((roomId: string) => void) | null = null;
  onLeaveRoom: (() => void) | null = null;
  onCreateRoom: (() => void) | null = null;
  onCopyLink: (() => void) | null = null;
  onPermSet: ((userId: string, role: "owner" | "editor" | "viewer") => void) | null = null;

  constructor() {
    this.bind();
  }

  private bind(): void {
    this.shareClose.addEventListener("click", () => this.closeShare());
    this.shareDialog.addEventListener("mousedown", (e) => {
      if (e.target === this.shareDialog) this.closeShare();
    });
    this.shareConnect.addEventListener("click", () => this.onConnect?.(this.shareUrlInput.value));
    this.shareDisconnect.addEventListener("click", () => this.onDisconnect?.());
    this.shareJoin.addEventListener("click", () => this.onJoinRoom?.(this.shareRoomInput.value));
    this.shareCreate.addEventListener("click", () => this.onCreateRoom?.());
    this.shareCopy.addEventListener("click", () => this.onCopyLink?.());
    this.shareLeave.addEventListener("click", () => this.onLeaveRoom?.());
    this.shareRoomInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.onJoinRoom?.(this.shareRoomInput.value);
      }
    });
    this.shareUsers.addEventListener("click", (e) => {
      const select = (e.target as HTMLElement).closest("select[data-user-id]") as HTMLSelectElement | null;
      if (select) this.onPermSet?.(select.dataset.userId ?? "", select.value as "owner" | "editor" | "viewer");
    });
    this.shareUrlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.onConnect?.(this.shareUrlInput.value);
      }
    });
  }

  openShare(): void {
    this.shareDialog.classList.add("open");
    this.shareDialog.setAttribute("aria-hidden", "false");
  }

  closeShare(): void {
    this.shareDialog.classList.remove("open");
    this.shareDialog.setAttribute("aria-hidden", "true");
  }

  getShareOpen(): boolean {
    return this.shareDialog.classList.contains("open");
  }

  // -------- Rendering --------

  renderShare(view: CollabShareView): void {
    this.shareUrlInput.value = view.serverUrl;
    const statusText =
      view.status === "connected"
        ? (view.roomId ? `Connected to ${view.roomId}` : "Connected to server")
        : view.status === "connecting"
          ? (view.error ? "Connecting… (can't reach the server — retrying)" : "Connecting…")
          : view.status === "error"
            ? `Error: ${view.error || "connection failed"}`
            : "Offline";
    this.shareStatus.textContent = statusText;
    this.shareStatus.className = `share-status share-status-${view.status}`;
    this.shareRole.textContent = view.roomId ? `Your role: ${roleLabel(view.role)}` : "Not in a room yet";
    this.shareRoomLabel.textContent = view.roomId || "No active room";
    this.shareRoomInput.placeholder = "Room id (join)";
    this.shareConnect.disabled = view.status === "connecting" || view.status === "connected";
    this.shareDisconnect.disabled = view.status !== "connected";
    this.shareLeave.hidden = !view.canLeave;
    this.shareCreate.hidden = !view.canCreate;
    this.shareCopy.hidden = !(view.canCreate && view.inviteLink);
    this.shareJoin.disabled = !view.canConnect;

    const rows = view.peers.map((p) => {
      const isOwner = p.user.id === view.ownerId;
      const roleKnown = isOwner ? "owner" : p.role;
      const options =
        view.role === "owner" && !isOwner
          ? ["viewer", "editor", "owner"].map(
              (r) => `<option value="${r}"${p.role === r ? " selected" : ""}>${roleLabel(r)}</option>`
            ).join("")
          : `<option selected>${roleLabel(roleKnown)}</option>`;
      return (
        `<div class="share-user">` +
        `<span class="share-user-dot" style="background:${escapeHtml(p.user.color)}"></span>` +
        `<span class="share-user-name">${escapeHtml(p.user.name)}${p.user.id === view.selfName ? " (you)" : ""}</span>` +
        `<select class="share-role-select" data-user-id="${escapeHtml(p.user.id)}"${view.role === "owner" && !isOwner ? "" : " disabled"}>${options}</select>` +
        `</div>`
      );
    }).join("");
    this.shareUsers.innerHTML =
      rows || `<span class="share-empty">No other participants yet — share the invite link with them.</span>`;
  }

  renderOverlay(inputs: CollabOverlayInputs): void {
    const { toScreen, zoom, objects, presences, selections } = inputs;
    const objectById = new Map<string, CanvasObject>();
    for (const o of objects) objectById.set(o.id, o);

    const dotHtml: string[] = [];
    for (const p of presences) {
      if (p.user.id === this.selfId) continue;
      const s = toScreen({ x: p.x, y: p.y });
      dotHtml.push(
        `<span class="co-dot" style="left:${s.x}px;top:${s.y}px;background:${escapeHtml(p.user.color)}" title="${escapeHtml(p.user.name)}"><i>${escapeHtml(p.user.name)}</i></span>`
      );
    }

    const selHtml: string[] = [];
    for (const [userId, ids] of selections) {
      if (userId === this.selfId) continue;
      const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
      for (const id of ids) {
        const o = objectById.get(id);
        if (o) rects.push({ x: o.x, y: o.y, w: o.width, h: o.height });
      }
      if (rects.length === 0) continue;
      const minX = Math.min(...rects.map((r) => r.x));
      const minY = Math.min(...rects.map((r) => r.y));
      const maxX = Math.max(...rects.map((r) => r.x + r.w));
      const maxY = Math.max(...rects.map((r) => r.y + r.h));
      const topLeft = toScreen({ x: minX, y: minY });
      selHtml.push(
        `<span class="co-sel" style="left:${topLeft.x}px;top:${topLeft.y}px;width:${(maxX - minX) * zoom}px;height:${(maxY - minY) * zoom}px"></span>`
      );
    }

    this.presenceLayer.innerHTML = dotHtml.join("") + selHtml.join("");
  }

  selfId = "";
}