// Counter plugin — a small real Spatia plugin.
//
// It runs inside Spatia's sandboxed plugin iframe, where a global "api"
// object exposes the public Spatia Plugin API. No DOM, Node, Electron,
// filesystem or network access is available to the plugin.
//
// `api` is promise-based: every method returns a Promise except addCommand()
// and notify(), which fire and forget.
//
// Install: open the Plugins dialog and paste the URL of the manifest.json
// that ships next to this file, or install the folder that contains both.
//
// https://spatiaweb.surge.sh/plugins/counter-plugin/manifest.json

api.addCommand({
  id: "counter-plugin.count-objects",
  label: "Count objects by type",
  run: async function () {
    const objects = await api.getObjects();
    const counts = {};
    for (const obj of objects) {
      counts[obj.type] = (counts[obj.type] || 0) + 1;
    }
    const parts = Object.keys(counts)
      .map((type) => type + ": " + counts[type])
      .join(", ");
    api.notify(parts ? "Canvas contents — " + parts : "The canvas is empty.");
  },
});