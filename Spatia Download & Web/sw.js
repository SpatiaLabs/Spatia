/* Spatia site service worker.
 *
 * Installs the app shell so the site + Spatia Web keep working offline.
 *  - navigation (HTML) requests: network-first, fall back to cached shell
 *  - same-origin static assets: stale-while-revalidate
 * Large downloads (installers/archives) are intentionally NOT cached.
 */
"use strict";

var CACHE = "spatia-site-v9";
var CORE = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/site.css",
  "./js/site.js",
  "./css/web-mobile.css",
  "./js/web-mobile.js",
  "./plugins/pluginHost.html",
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(CORE).then(function () {
        return self.skipWaiting();
      });
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (key) {
            return key !== CACHE;
          })
          .map(function (key) {
            return caches.delete(key);
          })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf("/downloads/") !== -1 || /\.(msi|zip)$/i.test(url.pathname)) return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then(function (res) {
          if (res.ok) {
            var clone = res.clone();
            caches.open(CACHE).then(function (cache) {
              cache.put(req, clone);
            });
          }
          return res;
        })
        .catch(function () {
          return caches.match(req).then(function (hit) {
            return hit || caches.match("./");
          });
        })
    );
    return;
  }

  if (/\.(js|css|webp|png|jpg|jpeg|svg|webmanifest|woff2?)$/i.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then(function (hit) {
        var network = fetch(req)
          .then(function (res) {
            if (res.ok) {
              var clone = res.clone();
              caches.open(CACHE).then(function (cache) {
                cache.put(req, clone);
              });
            }
            return res;
          })
          .catch(function () {
            return hit;
          });
        return hit || network;
      })
    );
  }
});