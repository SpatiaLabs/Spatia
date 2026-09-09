import { Emitter } from "../state/emitter.js";
import {
  PLUGIN_PERMISSIONS,
  type PluginEntry,
  type PluginInstallResult,
  type PluginManifest,
  type PluginPermission,
} from "../../shared/plugins/manifest.js";

/**
 * Shared Plugin Manager — runs in the renderer on BOTH the desktop app and the
 * Web build (the renderer is one codebase). It loads plugin payloads through
 * the window.spatia bridge (desktop: secure IPC + folder store, web:
 * IndexedDB), executes each plugin's main.js inside a sandboxed, opaque-origin
 * iframe with a locked-down CSP, and mediates every plugin <-> app interaction
 * through the controlled Plugin API below.
 *
 * Desktop-specific / web-specific behaviour is confined to the bridge — the
 * manager itself is identical on both platforms.
 */

export type PluginObjectView = { type: string; id: string; [key: string]: unknown };

export interface PluginCommand {
  id: string;
  pluginId: string;
  pluginName: string;
  label: string;
}

/** The controllable surface plugins may touch. Implemented by the App. */
export interface PluginApiGateway {
  notify(text: string): void;
  selectionIds(): string[];
  projectMeta(): { id: string; name: string; createdAt: string; updatedAt: string } | null;
  viewportState(): { x: number; y: number; zoom: number };
  viewportCenter(): { x: number; y: number };
  objects(): PluginObjectView[];
  objectById(id: string): PluginObjectView | null;
  createObject(kind: string, x: number, y: number, props: Record<string, unknown>): PluginObjectView | null;
  updateObject(id: string, props: Record<string, unknown>): PluginObjectView | null;
  deleteObjects(ids: string[]): number;
  select(ids: string[]): void;
  selectAdd(ids: string[]): void;
  clearSelection(): void;
  focusSelection(): void;
  zoom(factor: number): void;
  undo(): boolean;
  redo(): boolean;
}

interface ApiMethodSpec {
  /** API v2: the capability that gates this method on the plugin's manifest. */
  perm: PluginPermission;
  invoke(gateway: PluginApiGateway, args: unknown[]): unknown;
}

// The complete, audited list of methods a plugin may call. Anything else is
// rejected before it reaches the app, and (API v2) a method is only served when
// the plugin's manifest declares the permission that gates it.
const API_METHODS: Record<string, ApiMethodSpec> = {
  notify: { perm: "notify", invoke: (g, a) => { g.notify(str(a[0], "")); return undefined; } },
  getSelection: { perm: "view", invoke: (g) => ({ ids: g.selectionIds() }) },
  getProject: { perm: "view", invoke: (g) => g.projectMeta() },
  getViewport: { perm: "view", invoke: (g) => g.viewportState() },
  viewportCenter: { perm: "view", invoke: (g) => g.viewportCenter() },
  getObjects: { perm: "view", invoke: (g) => g.objects() },
  getObject: { perm: "view", invoke: (g, a) => g.objectById(str(a[0], "")) },
  createObject: { perm: "documents", invoke: (g, a) => g.createObject(str(a[0], ""), num(a[1]), num(a[2]), props(a[3])) },
  updateObject: { perm: "documents", invoke: (g, a) => g.updateObject(str(a[0], ""), props(a[1])) },
  deleteObjects: { perm: "documents", invoke: (g, a) => ({ deleted: g.deleteObjects(strArray(a[0])) }) },
  select: { perm: "selection", invoke: (g, a) => { g.select(strArray(a[0])); return undefined; } },
  selectAdd: { perm: "selection", invoke: (g, a) => { g.selectAdd(strArray(a[0])); return undefined; } },
  clearSelection: { perm: "selection", invoke: (g) => { g.clearSelection(); return undefined; } },
  focusSelection: { perm: "navigation", invoke: (g) => { g.focusSelection(); return undefined; } },
  zoom: { perm: "navigation", invoke: (g, a) => { g.zoom(num(a[0], 1)); return undefined; } },
  undo: { perm: "navigation", invoke: (g) => g.undo() },
  redo: { perm: "navigation", invoke: (g) => g.redo() },
};

/** API v2 app events an enabled plugin can subscribe to (via api.on). */
export const PLUGIN_EVENTS = ["selection", "document", "viewport"] as const;
export type PluginEvent = (typeof PLUGIN_EVENTS)[number];

interface Runtime {
  iframe: HTMLIFrameElement;
  pluginId: string;
  manifest: PluginManifest;
  /** API v2: resolved capability set (full when the manifest declares none). */
  perms: ReadonlySet<string>;
  /** commandId -> label */
  commands: Map<string, string>;
  /** API v2: app event types this plugin subscribed to. */
  subs: Set<PluginEvent>;
  /** seq -> pending promise resolvers */
  pending: Map<number, { resolve(v: unknown): void; reject(e: Error): void }>;
}

function resolvePermissions(manifest: PluginManifest): ReadonlySet<string> {
  return manifest.permissions ? new Set(manifest.permissions) : new Set(PLUGIN_PERMISSIONS);
}

function computeHostUrl(): string {
  try {
    return new URL("plugins/pluginHost.html", document.baseURI).href;
  } catch {
    return "plugins/pluginHost.html";
  }
}

export class PluginManager {
  private entries: PluginEntry[] = [];
  private runtimes = new Map<string, Runtime>();
  private runtimeErrors = new Map<string, string>();
  private readonly hostUrl = computeHostUrl();
  readonly changed = new Emitter<void>();

  constructor(private readonly gateway: PluginApiGateway) {
    window.addEventListener("message", this.onMessage);
  }

  entriesList(): PluginEntry[] {
    return this.entries;
  }

  /** All commands currently offered by enabled plugins, sorted by plugin. */
  commandsList(): PluginCommand[] {
    const out: PluginCommand[] = [];
    for (const r of this.runtimes.values()) {
      for (const [commandId, label] of r.commands) {
        out.push({ id: commandId, pluginId: r.pluginId, pluginName: r.manifest.name || r.pluginId, label });
      }
    }
    out.sort((a, b) =>
      a.pluginName.localeCompare(b.pluginName) || a.label.localeCompare(b.label)
    );
    return out;
  }

  /** Error message a plugin reported at runtime (broken plugin detection). */
  runtimeErrorOf(pluginId: string): string | null {
    return this.runtimeErrors.get(pluginId) ?? null;
  }

  /** Load entries from the bridge and reconcile running sandboxes. */
  async reload(): Promise<void> {
    let list: PluginEntry[] = [];
    try {
      list = await window.spatia.pluginsList();
    } catch {
      this.gateway.notify("Could not load plugins.");
      return;
    }
    this.entries = [...list].sort((a, b) => a.id.localeCompare(b.id));

    // Boot enabled, valid plugins; tear down disabled / removed / broken ones.
    const wanted = new Map<string, PluginEntry>();
    for (const e of this.entries) {
      if (e.enabled && e.manifest) wanted.set(e.id, e);
    }
    for (const [id, runtime] of [...this.runtimes]) {
      const w = wanted.get(id);
      if (!w) {
        this.teardown(id);
      } else if (w.manifest !== runtime.manifest) {
        this.teardown(id);
      }
    }
    for (const e of wanted.values()) {
      if (!this.runtimes.has(e.id)) this.boot(e);
    }
    this.changed.emit();
  }

  async install(): Promise<PluginInstallResult> {
    try {
      const result = await window.spatia.pluginsInstall();
      if (result.ok) {
        await this.reload();
        this.gateway.notify(`Installed "${result.entry?.manifest?.name ?? result.entry?.id ?? "plugin"}".`);
      }
      return result;
    } catch {
      this.gateway.notify("Plugin install failed.");
      return { ok: false, error: "Plugin install failed." };
    }
  }

  async installFromUrl(url: string): Promise<PluginInstallResult> {
    try {
      const result = await window.spatia.pluginsInstallUrl(url);
      if (result.ok) {
        await this.reload();
        this.gateway.notify(`Installed "${result.entry?.manifest?.name ?? result.entry?.id ?? "plugin"}".`);
      } else {
        this.gateway.notify(`Could not install plugin: ${result.error}`);
      }
      return result;
    } catch {
      this.gateway.notify("Plugin install failed.");
      return { ok: false, error: "Plugin install failed." };
    }
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    try {
      await window.spatia.pluginsSetEnabled(id, enabled);
      await this.reload();
      this.gateway.notify(enabled ? "Plugin enabled." : "Plugin disabled.");
    } catch {
      this.gateway.notify("Could not update plugin.");
    }
  }

  async remove(id: string): Promise<void> {
    const entry = this.entries.find((e) => e.id === id);
    if (entry?.builtIn) {
      this.gateway.notify("Built-in plugins cannot be removed.");
      return;
    }
    try {
      await window.spatia.pluginsRemove(id);
      await this.reload();
      this.gateway.notify("Plugin removed.");
    } catch {
      this.gateway.notify("Could not remove plugin.");
    }
  }

  async dispatchCommand(commandId: string): Promise<void> {
    for (const r of this.runtimes.values()) {
      if (r.commands.has(commandId)) {
        this.post(r, "run-command", { commandId });
        return;
      }
    }
    this.gateway.notify("Plugin command is not available.");
  }

  /** Tear down every sandbox (used when the workspace is replaced). */
  dispose(): void {
    for (const id of [...this.runtimes.keys()]) this.teardown(id);
    window.removeEventListener("message", this.onMessage);
  }

  // ------------------------------------------------------------ internals

  private boot(entry: PluginEntry): void {
    void window.spatia
      .pluginsGetSource(entry.id)
      .then((source) => {
        if (!source || !this.entries.some((e) => e.id === entry.id && e.enabled)) {
          this.runtimeErrors.set(entry.id, "Plugin source is missing or was disabled.");
          this.changed.emit();
          return;
        }
        if (this.runtimes.has(entry.id)) return;
        const iframe = document.createElement("iframe");
        iframe.setAttribute("sandbox", "allow-scripts");
        iframe.setAttribute("aria-hidden", "true");
        iframe.className = "spatia-plugin-host";
        iframe.style.display = "none";
        iframe.title = entry.id;
        const runtime: Runtime = {
          iframe,
          pluginId: entry.id,
          manifest: source.manifest,
          perms: resolvePermissions(source.manifest),
          commands: new Map(),
          subs: new Set(),
          pending: new Map(),
        };
        this.runtimes.set(entry.id, runtime);
        iframe.addEventListener("load", () => {
          iframe.contentWindow?.postMessage(
            { __plugin: true, type: "init", payload: { manifest: source.manifest, main: source.main } },
            "*"
          );
        });
        iframe.src = this.hostUrl;
        document.body.appendChild(iframe);
      })
      .catch(() => {
        this.runtimeErrors.set(entry.id, "Could not read plugin source.");
        this.changed.emit();
      });
  }

  private teardown(id: string): void {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    runtime.iframe.remove();
    this.runtimes.delete(id);
    this.runtimeErrors.delete(id);
  }

  private post(runtime: Runtime, type: string, payload: Record<string, unknown>): void {
    runtime.iframe.contentWindow?.postMessage({ __plugin: true, type, payload }, "*");
  }

  private onMessage = (event: MessageEvent): void => {
    const data = event.data;
    if (!data || data.__plugin !== true) return;
    let runtime: Runtime | null = null;
    for (const r of this.runtimes.values()) {
      if (event.source === r.iframe.contentWindow) {
        runtime = r;
        break;
      }
    }
    if (!runtime) return;
    const payload = data.payload !== undefined && typeof data.payload === "object" ? data.payload : {};

    switch (data.type) {
      case "ready":
        this.runtimeErrors.delete(runtime.pluginId);
        this.changed.emit();
        return;
      case "error": {
        const msg = String(payload.message || "Plugin reported an error.");
        this.runtimeErrors.set(runtime.pluginId, msg);
        this.gateway.notify(`Plugin "${runtime.manifest.name || runtime.pluginId}" error: ${msg}`);
        this.changed.emit();
        return;
      }
      case "command-registered": {
        // API v2: registering menu commands requires the "commands" permission.
        if (!runtime.perms.has("commands")) {
          runtime.commands.delete(String(payload.commandId || ""));
          this.runtimeErrors.set(
            runtime.pluginId,
            'Plugin lacks the "commands" permission; its command was not registered.'
          );
          this.gateway.notify(`Plugin "${runtime.manifest.name || runtime.pluginId}" needs the "commands" permission to register actions.`);
          this.changed.emit();
          return;
        }
        runtime.commands.set(String(payload.commandId || ""), String(payload.label || "Action"));
        this.changed.emit();
        return;
      }
      case "event-subscribe": {
        const evt = String(payload.event || "") as PluginEvent;
        if (PLUGIN_EVENTS.includes(evt)) runtime.subs.add(evt);
        return;
      }
      case "event-unsubscribe": {
        const evt = String(payload.event || "") as PluginEvent;
        runtime.subs.delete(evt);
        return;
      }
      case "api-call":
        void this.handleApiCall(runtime, payload);
        return;
      default:
        return;
    }
  };

  /** Push an app event to every plugin that subscribed to it (API v2). */
  publish(event: PluginEvent, data: Record<string, unknown>): void {
    for (const runtime of this.runtimes.values()) {
      if (runtime.subs.has(event)) this.post(runtime, "event", { type: event, data });
    }
  }

  private async handleApiCall(runtime: Runtime, payload: Record<string, unknown>): Promise<void> {
    const method = String(payload.method || "");
    const args = Array.isArray(payload.args) ? payload.args : [];
    const seq = typeof payload.seq === "number" ? payload.seq : undefined;
    const spec = API_METHODS[method];
    if (!spec) {
      if (seq !== undefined) this.post(runtime, "api-error", { seq, error: `Unknown API method "${method}".` });
      return;
    }
    if (!runtime.perms.has(spec.perm)) {
      if (seq !== undefined) {
        this.post(runtime, "api-error", {
          seq,
          error: `Plugin lacks the "${spec.perm}" permission (add it to manifest.json "permissions").`,
        });
      }
      return;
    }
    try {
      const value = spec.invoke(this.gateway, args);
      if (seq !== undefined) this.post(runtime, "api-result", { seq, value: value === undefined ? null : value });
    } catch (err) {
      if (seq !== undefined) {
        this.post(runtime, "api-error", { seq, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/** Copy only primitives; drop anything that could smuggle an object/function. */
function props(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[key] = v;
  }
  return out;
}