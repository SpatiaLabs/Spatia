import type { PluginManifest } from "./manifest.js";

/**
 * Plugins that ship with Spatia. They exist on both platforms as regular,
 * installable plugin entries (seeded by the desktop main process and the Web
 * bridge) so enable/disable semantics and the plugin UI work identically for
 * built-ins and user-installed plugins. The only difference is that built-ins
 * cannot be removed.
 *
 * The example plugin demos the shared Plugin API: it registers a command that
 * creates an object on the canvas through the sandboxed api surface.
 *
 * The Browser Frame plugin adds a live, interactive website inside a canvas
 * frame object. It is a normal built-in: no manifest URL, no manual install —
 * it is seeded with the example plugin on both platforms.
 */

export interface BuiltinPlugin {
  manifest: PluginManifest;
  main: string;
}

const EXAMPLE_MANIFEST: PluginManifest = {
  id: "example-plugin",
  name: "Example Plugin",
  version: "1.0.0",
  description: "A tiny demo plugin that shows how Spatia plugins work.",
  author: "Spatia",
  main: "main.js",
  apiVersion: 2,
  permissions: ["notify", "commands", "view", "documents", "selection", "navigation"],
};

const EXAMPLE_MAIN = `// Example Spatia plugin — runs inside the plugin sandbox, where a global
// "api" object is provided by Spatia. No access to the app DOM, Node,
// Electron, the filesystem or the network.
//
// api is promise-based the whole way down; every method returns a Promise
// except addCommand(), notify(), on() and off() which fire and forget.
// This plugin declares permissions in its manifest (API v2): the sandbox only
// serves the methods those permissions gate, so a plugin can never touch more
// than it asked for.

var selectionPing = null;
api.on("selection", function (sel) {
  if (sel && sel.ids && sel.ids.length > 0) {
    selectionPing = sel;
    api.notify("Example Plugin sees " + sel.ids.length + " selected object(s).");
  }
});

api.addCommand({
  id: "example.add-note",
  label: "Add example note",
  run: async function () {
    const center = await api.viewportCenter();
    const note = await api.createObject("note", center.x - 90, center.y - 70, {
      title: "Plugin note",
      text: "Hello from the Example Plugin!",
      color: "#7dd3a3",
    });
    if (note) await api.select([note.id]);
    api.notify("Added an example note.");
  },
});
`;

const BROWSER_FRAME_MANIFEST: PluginManifest = {
  id: "browser-frame",
  name: "Browser Frame",
  version: "1.0.0",
  description:
    "Adds a live, interactive browser frame to the canvas. Fully functional on the desktop app; sites that refuse iframe embedding cannot appear in the browser build.",
  author: "Spatia",
  main: "main.js",
  apiVersion: 2,
  permissions: ["commands", "notify", "view", "documents", "selection"],
};

const BROWSER_FRAME_MAIN = `// Browser Frame plugin — ships built in with Spatia. Adds a live, interactive
// website inside a canvas "frame" object.
//
// The plugin sandbox has no DOM and no network access, so the plugin cannot
// draw a website by itself. Instead it asks the app to create a "frame"
// object carrying the address it should show (a "url" prop the app stores on
// the object's metadata). The app owns rendering:
//
//   - Desktop (Electron): a real Chromium <webview> guest. Any site loads,
//     video/audio plays, and back/forward/reload/search all work.
//   - Web (browser build): a plain <iframe>. Sites that refuse embedding
//     (X-Frame-Options / CSP) will not render — a genuine browser restriction.
//
// Only the current URL is stored on the object; the page never gains
// Node/Electron access.

var BROWSER_DEFAULT_URL = "https://www.google.com";
var FRAME_WIDTH = 720;
var FRAME_HEIGHT = 460;

api.addCommand({
  id: "browser-frame.add",
  label: "Add Browser Frame",
  run: async function () {
    var center = await api.viewportCenter();
    var frame = await api.createObject("frame", center.x, center.y, {
      name: "Browser Frame",
      url: BROWSER_DEFAULT_URL,
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
    });
    if (frame && frame.id) {
      await api.select([frame.id]);
      api.notify("Browser Frame added \u2014 type a web address or search from its toolbar.");
    } else {
      api.notify("Could not add a Browser Frame here.");
    }
  },
});
`;

export const BUILTIN_PLUGINS: BuiltinPlugin[] = [
  { manifest: EXAMPLE_MANIFEST, main: EXAMPLE_MAIN },
  { manifest: BROWSER_FRAME_MANIFEST, main: BROWSER_FRAME_MAIN },
];

export const BUILTIN_PLUGIN_IDS: string[] = BUILTIN_PLUGINS.map((b) => b.manifest.id);