"use strict";

/**
 * Spatia — Windows release download host (Cloudflare Worker + R2).
 *
 * Serves the Spatia 0.5.0 Windows ZIP from an R2 public-access bucket so the
 * website's "Download" buttons can point at a permanent, no-account URL that
 * is never deployed to Surge (the target archive is far larger than Surge's
 * per-file limit).
 *
 * Route: GET /Spatia-0.5.0-win-x64.zip  -> R2 object
 *        GET /                          -> simple listing of known artifacts
 */

const ARTIFACTS = new Map([["Spatia-0.5.0-win-x64.zip", { contentType: "application/zip" }]]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "") {
      const body =
        "Spatia releases\n" +
        "---------------\n" +
        Array.from(ARTIFACTS.keys()).map((k) => url.origin + "/" + encodeURIComponent(k)).join("\n") +
        "\n";
      return new Response(body, {
        headers: { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" },
      });
    }

    const name = decodeURIComponent(url.pathname.slice(1));
    const meta = ARTIFACTS.get(name);
    if (!meta) {
      return new Response("not found", { status: 404 });
    }

    const obj = await env.SPATIA_RELEASES.get(name);
    if (!obj) {
      return new Response("artifact missing", { status: 404 });
    }

    return new Response(obj.body, {
      headers: {
        "Content-Type": meta.contentType,
        "Content-Length": obj.size,
        "Content-Disposition": 'attachment; filename="' + name + '"',
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  },
};