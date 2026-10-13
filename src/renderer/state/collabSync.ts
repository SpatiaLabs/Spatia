import { deserialize, type ProjectFile } from "../../shared/project/serialize.js";
import type { ProjectDocument, ProjectMeta } from "../../shared/types/project.js";
import type { CanvasObject, AssetMeta } from "../../shared/types/object.js";
import type { CollabUser } from "../../shared/collab/protocol.js";
import type { CollabOp, CollabOpsState } from "../../shared/collab/ops.js";
import { applyOps, diffOps } from "../../shared/collab/ops.js";
import type { CollaborationStore } from "./collaborationStore.js";
import type { ProjectStore } from "../project/projectStore.js";

/** A linearized ops batch as delivered by the collaboration store. */
export interface CollabOpsEvent {
  user: CollabUser;
  seq: number;
  baseSeq: number;
  ops: CollabOp[];
}

function emptyDoc(): ProjectDocument {
  return {
    meta: { id: "", name: "", createdAt: "", updatedAt: "" },
    viewport: { x: 0, y: 0, zoom: 1 },
    objects: [],
    assets: [],
  };
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Targeted sync engine for the collaboration room (0.5.1).
 *
 * The engine keeps a private `baseline` — a clone of the last state the server
 * acknowledges — and turns local document changes into `ops` diffs against it.
 * Every server message is applied to the baseline FIRST (in server order) and
 * then reflected into the store, so `project.changed` re-diffs can never
 * re-emit what the server already has. Reconnects reset to the authoritative
 * room file and merge: locally-touched objects/assets/meta are kept, clean
 * ones are adopted, and the surviving local diff is re-emitted against the
 * fresh baseline. Targeted applies never wipe the undo history.
 */
export class CollabSync {
  private baseline: ProjectDocument | null = null;
  private baselineSeq = 0;
  private enabled = false;
  private inFlight = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly collab: CollaborationStore,
    private readonly project: ProjectStore,
  ) {}

  /** Reflects join/leave: sending is only legal while joined with write roles. */
  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    if (!on) {
      this.clearTimers();
      this.baseline = null;
      this.baselineSeq = 0;
      this.inFlight = false;
    }
  }

  /**
   * (Re)join: reset the baseline to the server's authoritative state and merge
   * the local document against it (keep locally-touched, adopt the rest), then
   * re-emit whatever local diff remains so the server converges.
   */
  onJoined(file: Record<string, unknown> | null, seq: number): void {
    this.clearTimers();
    const remote = this.fileToDoc(file);
    this.enabled = this.collab.isJoined && this.collab.canEdit;
    const merged = this.mergeLocalWithRemote(this.project.get(), remote);
    this.baseline = this.cloneDoc(remote);
    this.baselineSeq = typeof seq === "number" && Number.isFinite(seq) && seq >= 0 ? seq : 0;
    this.inFlight = false;
    this.project.applyMerged(merged.objects, merged.assets, merged.meta);
    this.ensureSent();
  }

  /** A linearized ops batch (own acknowledgement or a peer's change). */
  onOps(event: CollabOpsEvent): void {
    if (!this.enabled || !this.baseline) return;
    const fromSelf = this.collab.user?.id != null && this.collab.user.id === event.user.id;
    // Advance the baseline BEFORE the store apply so the resulting re-diff
    // never re-emits ops the server already accepted.
    applyOps(this.shim(this.baseline), event.ops);
    if (event.seq > this.baselineSeq) this.baselineSeq = event.seq;
    if (fromSelf) {
      this.inFlight = false;
    } else {
      this.project.applyRemoteOps(event.ops);
    }
    this.ensureSent();
  }

  /** Called on every local `project.changed`: coarsely schedule a send. */
  pushState(): void {
    if (!this.enabled || !this.baseline) return;
    if (this.inFlight) return;
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.ensureSent();
    }, 80);
  }

  // -------- Internals --------

  private ensureSent(): void {
    if (!this.enabled || !this.baseline) return;
    if (this.inFlight) return;
    const ops = diffOps(this.shim(this.baseline), this.shim(this.project.get()));
    if (ops.length === 0) return;
    this.inFlight = true;
    this.collab.sendOps(this.baselineSeq, ops);
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.enabled || !this.baseline) return;
      if (this.inFlight) {
        // Acknowledgement never came (dead link / dropped batch): reset the
        // flag and re-send the diff against the current baseline.
        this.inFlight = false;
        this.ensureSent();
      }
    }, 10000);
  }

  private clearTimers(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private shim(doc: ProjectDocument): CollabOpsState {
    return {
      objects: doc.objects as unknown as Record<string, unknown>[],
      assets: doc.assets as unknown as Record<string, unknown>[],
      meta: doc.meta,
    };
  }

  private cloneDoc(doc: ProjectDocument): ProjectDocument {
    return JSON.parse(JSON.stringify(doc)) as ProjectDocument;
  }

  private fileToDoc(file: Record<string, unknown> | null): ProjectDocument {
    if (!file) return emptyDoc();
    try {
      const parsed = deserialize(JSON.stringify(file)) as ProjectFile;
      return { meta: parsed.project, viewport: parsed.viewport, objects: parsed.objects, assets: parsed.assets };
    } catch {
      return emptyDoc();
    }
  }

  /**
   * Merge the live local document with the server's authoritative state.
   * Per object/asset id: if the local copy differs from the remote one the
   * user has touched it — keep the local version; otherwise adopt the remote.
   * Meta name/tags follow the same rule; the remote document id is adopted
   * when present (it is the room's identity) and the viewport is never synced.
   */
  private mergeLocalWithRemote(
    local: ProjectDocument,
    remote: ProjectDocument,
  ): { objects: CanvasObject[]; assets: AssetMeta[]; meta: ProjectMeta } {
    const localById = new Map<string, CanvasObject>();
    for (const o of local.objects) localById.set(o.id, o);
    const localAssetById = new Map<string, AssetMeta>();
    for (const a of local.assets) localAssetById.set(a.id, a);

    const objects: CanvasObject[] = [];
    const seen = new Set<string>();
    for (const ro of remote.objects) {
      const lo = localById.get(ro.id);
      objects.push(lo && !jsonEqual(lo, ro) ? lo : ro);
      seen.add(ro.id);
    }
    for (const lo of local.objects) if (!seen.has(lo.id)) objects.push(lo);

    const assets: AssetMeta[] = [];
    const seenA = new Set<string>();
    for (const ra of remote.assets) {
      const la = localAssetById.get(ra.id);
      assets.push(la && !jsonEqual(la, ra) ? la : ra);
      seenA.add(ra.id);
    }
    for (const la of local.assets) if (!seenA.has(la.id)) assets.push(la);

    const remoteHasId = remote.meta.id !== "";
    const name = !remoteHasId || local.meta.name !== remote.meta.name ? local.meta.name : remote.meta.name;
    const tags = !remoteHasId || !jsonEqual(local.meta.tags ?? [], remote.meta.tags ?? []) ? local.meta.tags : remote.meta.tags;
    const meta: ProjectMeta = {
      id: remoteHasId ? remote.meta.id : local.meta.id,
      name,
      createdAt: remoteHasId && remote.meta.createdAt !== "" ? remote.meta.createdAt : local.meta.createdAt,
      updatedAt: new Date().toISOString(),
    };
    if (tags !== undefined) meta.tags = [...tags];
    return { objects, assets, meta };
  }
}