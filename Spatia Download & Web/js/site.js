"use strict";

/**
 * Spatia site router.
 *
 *   #            -> landing page (spatiacanvas.netlify.app/#)
 *   #/web        -> the actual functional Spatia Web workspace
 *   #/wiki       -> the static user documentation (Spatia Wiki)
 *
 * The web route boots the same TypeScript renderer used by the desktop app
 * (compiled to ES modules in ./web/js). Only the web route pulls in the app
 * stylesheet and ESM bundles, so the landing page and wiki stay fast.
 *
 * Navigation is a true single-page experience:
 *  - entering #/web appends the app stylesheet and re-attaches the app's
 *    window-level handlers,
 *  - leaving #/web REMOVES that stylesheet (its `overflow: hidden` on
 *    html/body would otherwise freeze and restyle the landing page) and
 *    detaches the app handlers. Nothing is reloaded.
 *
 * On coarse-pointer / mobile devices the web route additionally loads a
 * touch-optimized layer (css/web-mobile.css + js/web-mobile.js).
 */
(function () {
  var host = document.getElementById("web-host");
  var wikiHost = document.getElementById("wiki-host");
  var LANDING_TITLE = "Spatia — Think in space.";
  var WEB_TITLE = "Spatia — Web";
  var WIKI_TITLE = "Spatia — Wiki";
  var WEB_CSS = "./web/app.css";
  var MOBILE_CSS = "./css/web-mobile.css";
  var MOBILE_JS = "./js/web-mobile.js";

  var webReady = false;
  var loading = null;
  var appStyle = null; // <link href="web/app.css">
  var mobileStyle = null; // <link href="css/web-mobile.css">
  var appHandlersOn = false;
  var mobileMode = false;
  var mobileAssetsLoading = false;
  var splash = null;

  // Installed PWA (display-mode: standalone) — lets the CSS drop anything that
  // only makes sense inside a browser tab.
  function applyStandalone() {
    var stat = false;
    try { stat = navigator.standalone === true; } catch (e) { /* old mobile Safari */ }
    if (!stat && typeof window.matchMedia === "function") {
      try { stat = window.matchMedia("(display-mode: standalone)").matches; } catch (e) { /* ignore */ }
    }
    document.documentElement.classList.toggle("ps-standalone", stat);
  }

  /** Branded splash shown while the app bundle boots (mobile, first visit). */
  function injectSplash() {
    if (!mobileMode || splash) return;
    var el = document.createElement("div");
    el.id = "mb-splash";
    el.innerHTML =
      '<div class="mb-splash-inner">' +
      '<img class="mb-splash-logo" src="./assets/icon-192.png" alt="" width="64" height="64" draggable="false">' +
      '<div class="mb-splash-name">Spatia</div>' +
      '<div class="mb-splash-bar"><i></i></div>' +
      "</div>";
    host.appendChild(el);
    splash = el;
    document.documentElement.setAttribute("data-mb-splash", "shown");
  }

  function finishSplash() {
    if (!splash) return;
    document.documentElement.setAttribute("data-mb-splash", "done");
    splash.classList.add("mb-splash-hide");
    setTimeout(function () {
      if (splash && splash.parentNode) splash.parentNode.removeChild(splash);
      splash = null;
      document.documentElement.removeAttribute("data-mb-splash");
    }, 520);
  }

  function isWebHash() {
    return window.location.hash.indexOf("#/web") === 0;
  }

  function isWikiHash() {
    return window.location.hash.indexOf("#/wiki") === 0;
  }

  // Tablets (iPad/Android, incl. iPadOS reporting as Mac) get the dedicated
  // tablet UI from the renderer — never the phone layer. Width >= 768 keeps a
  // large landscape phone from being classified as a tablet.
  function isTablet() {
    if (window.__spatiaSite && window.__spatiaSite._forceTablet) return true;
    var ua = navigator.userAgent || "";
    var wide = typeof window.matchMedia === "function" && window.matchMedia("(min-width: 768px)").matches;
    var coarse = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
    if (/iPad/.test(ua)) return true;
    if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1 && wide) return true;
    return coarse && wide;
  }

  function detectMobile() {
    if (window.__spatiaSite && window.__spatiaSite._forceMobile) return true;
    if (isTablet()) return false;
    if (typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches) return true;
    var ua = navigator.userAgent || "";
    return /Android|iPhone|iPod|Mobile|Opera Mini|IEMobile|BlackBerry|Windows Phone/i.test(ua);
  }

  // Small hooks used by tests/console to force a layer on a desktop UA.
  window.__spatiaSite = {
    isMobile: detectMobile,
    isTablet: isTablet,
    setForceMobile: function (v) {
      window.__spatiaSite._forceMobile = !!v;
    },
    setForceTablet: function (v) {
      window.__spatiaSite._forceTablet = !!v;
    },
  };

  // ---------------------------------------------------------------- stylesheet

  function attachStylesheet() {
    if (appStyle && appStyle.isConnected) return Promise.resolve();
    var link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = WEB_CSS;
    appStyle = link;
    return new Promise(function (resolve) {
      link.onload = function () { resolve(); };
      link.onerror = function () { resolve(); };
      // Keep app.css BEFORE the mobile stylesheet so its generic rules cannot
      // override the mobile layer when assets are re-attached on re-entry.
      document.head.insertBefore(link, mobileStyle && mobileStyle.isConnected ? mobileStyle : null);
    });
  }

  function detachStylesheet() {
    if (appStyle && appStyle.isConnected && appStyle.parentNode) {
      appStyle.parentNode.removeChild(appStyle);
    }
  }

  // -------------------------------------------- app window-level event toggles
  // The App stores these handlers as instance properties on window.__spatia,
  // so they can be detached while the single app instance stays alive. The
  // anonymous window dragover/dragenter listeners from bindDragDrop are not
  // removable, but they are harmless on the landing page.

  function attachAppHandlers() {
    var app = window.__spatia;
    if (!app || appHandlersOn) return;
    window.addEventListener("keydown", app.onKeyDown);
    window.addEventListener("paste", app.onPaste);
    window.addEventListener("drop", app.onDrop);
    appHandlersOn = true;
  }

  function detachAppHandlers() {
    var app = window.__spatia;
    if (!app || !appHandlersOn) return;
    window.removeEventListener("keydown", app.onKeyDown);
    window.removeEventListener("paste", app.onPaste);
    window.removeEventListener("drop", app.onDrop);
    appHandlersOn = false;
  }

  // ------------------------------------------------------------- mobile layer

  function enterMobileMode() {
    mobileMode = detectMobile();
    if (mobileMode) document.documentElement.classList.add("mb-active");
    else document.documentElement.classList.remove("mb-active");
    return mobileMode;
  }

  function leaveMobileMode() {
    document.documentElement.classList.remove("mb-active");
  }

  /** Load the mobile layer assets once. Runs after the app has booted. */
  function injectMobileAssets() {
    if (!mobileMode || mobileAssetsLoading) return Promise.resolve();
    mobileAssetsLoading = true;
    var css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = MOBILE_CSS;
    mobileStyle = css;
    document.head.appendChild(css);
    return new Promise(function (resolve) {
      var script = document.createElement("script");
      script.src = MOBILE_JS;
      script.onload = function () { resolve(); };
      script.onerror = function () { resolve(); };
      document.head.appendChild(script);
    });
  }

  // ------------------------------------------------------------ enter / leave

  function enterWeb() {
    document.documentElement.dataset.web = "1";
    host.hidden = false;
    document.title = WEB_TITLE;
    enterMobileMode();
    applyStandalone();

    if (webReady) {
      attachStylesheet();
      attachAppHandlers();
      injectMobileAssets();
      // A mobile visit can happen repeatedly (Back button etc.). The mobile
      // layer is loaded only once, so ask it to re-apply whatever its
      // leave() tore down (URL prompt / toast hooks, live tool state).
      if (mobileMode && window.__spatiaMobile && typeof window.__spatiaMobile.resume === "function") {
        try { window.__spatiaMobile.resume(); } catch (err) { /* ignore */ }
      }
      return;
    }
    if (loading) return; // already booting

    injectSplash();
    loading = Promise.resolve()
      .then(attachStylesheet)
      .then(function () {
        // NOTE: dynamic import() inside a classic script resolves relative to
        // the script URL, so use document-root paths here.
        return import("/web/bridge.js");
      })
      .then(function () {
        return import("/web/js/renderer/main.js");
      })
      .then(injectMobileAssets)
      .then(function () {
        webReady = true;
      })
      .catch(function (err) {
        // Surface the failure inside the app shell instead of a blank screen.
        var status = document.getElementById("status-text");
        if (status) status.textContent = "Web workspace failed to load — " + err.message;
        window.__webBootError = err && err.stack ? err.stack : String(err);
        console.error("spatia web boot failed:", err);
        loading = null;
        document.title = LANDING_TITLE;
      })
      .then(finishSplash);
  }

  function leaveWeb() {
    document.documentElement.removeAttribute("data-web");
    host.hidden = true;
    document.title = LANDING_TITLE;
    leaveMobileMode();
    detachAppHandlers();
    detachStylesheet();
    // Let the mobile layer drop any in-progress interaction (e.g. a pending
    // connection draft) so it cannot linger into the next visit.
    if (window.__spatiaMobile && typeof window.__spatiaMobile.leave === "function") {
      window.__spatiaMobile.leave();
    }
  }

  // --------------------------------------------------------------- wiki route
  // #/wiki renders the static documentation inside #wiki-host (same document,
  // same base route as the landing page and #/web). Anchors use #/wiki/<slug>
  // so every wiki section is a hash-route of its own without colliding with
  // the landing page's plain #section anchors.

  var wikiActive = false;
  var wikiTocObserver = null;

  function wikiElements() {
    var searchEl = document.getElementById("wiki-search");
    var countEl = document.getElementById("wiki-result-count");
    return { searchEl: searchEl, countEl: countEl };
  }

  function applyWikiFilter() {
    if (!wikiHost) return;
    var el = wikiElements();
    var q = (el.searchEl ? el.searchEl.value : "").trim().toLowerCase();
    var groups = wikiHost.querySelectorAll("#wiki-toc .wiki-toc-group");
    var matched = 0;
    for (var g = 0; g < groups.length; g++) {
      var links = groups[g].querySelectorAll("a[data-wiki-search]");
      var visible = 0;
      for (var i = 0; i < links.length; i++) {
        var text = (links[i].getAttribute("data-wiki-search") || "").toLowerCase();
        var show = q === "" || text.indexOf(q) !== -1;
        links[i].classList.toggle("toc-hit", show);
        var cell = links[i].closest("li");
        if (cell) cell.style.display = show ? "" : "none";
        if (show) visible++;
      }
      var title = groups[g].querySelector(".wiki-toc-title");
      var hasHits = visible > 0;
      if (title) title.style.display = hasHits ? "" : "none";
      groups[g].style.display = hasHits ? "" : "none";
      matched += visible;
    }
    if (el.countEl) {
      el.countEl.style.display = q === "" ? "none" : "";
      el.countEl.textContent = q === "" ? "" : matched + (matched === 1 ? " result" : " results");
    }
  }

  function resetWikiFilter() {
    var el = wikiElements();
    if (el.searchEl) el.searchEl.value = "";
    applyWikiFilter();
  }

  function wikiSectionSlug(hash) {
    var m = /^#\/wiki\/([\w-]+)/.exec(hash || "");
    return m ? m[1] : null;
  }

  function scrollWikiToSlug() {
    var slug = wikiSectionSlug(window.location.hash);
    if (slug) {
      var el = document.getElementById("wiki-" + slug);
      if (el) {
        try { el.scrollIntoView({ behavior: "smooth", block: "start" }); } catch (err) { el.scrollIntoView(); }
        markWikiActive(slug);
        return;
      }
    }
    window.scrollTo(0, 0);
  }

  function markWikiActive(slug) {
    if (!wikiHost) return;
    var links = wikiHost.querySelectorAll("#wiki-toc a[href]");
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute("href");
      var hit = href === "#/wiki/" + slug || href === "#/wiki";
      links[i].classList.toggle("toc-active", hit);
    }
  }

  function startWikiObserver() {
    if (typeof IntersectionObserver === "undefined" || wikiTocObserver) return;
    var headings = wikiHost.querySelectorAll(".wiki-section");
    var links = wikiHost.querySelectorAll("#wiki-toc a[href]");
    wikiTocObserver = new IntersectionObserver(
      function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].isIntersecting) {
            var id = entries[i].target.id || "";
            var slug = id.indexOf("wiki-") === 0 ? id.slice(5) : id;
            for (var j = 0; j < links.length; j++) {
              links[j].classList.toggle("toc-active", links[j].getAttribute("href") === "#/wiki/" + slug);
            }
            break;
          }
        }
      },
      { rootMargin: "-96px 0px -72% 0px" }
    );
    for (var k = 0; k < headings.length; k++) wikiTocObserver.observe(headings[k]);
  }

  function detachWikiObserver() {
    if (wikiTocObserver) {
      wikiTocObserver.disconnect();
      wikiTocObserver = null;
    }
  }

  function enterWiki() {
    document.documentElement.dataset.wiki = "1";
    wikiHost.hidden = false;
    document.title = WIKI_TITLE;
    if (!wikiActive) {
      resetWikiFilter();
      startWikiObserver();
    }
    wikiActive = true;
    // Wait until the section is visible so anchor placement is correct.
    window.requestAnimationFrame(scrollWikiToSlug);
  }

  function leaveWiki() {
    document.documentElement.removeAttribute("data-wiki");
    wikiHost.hidden = true;
    if (document.title === WIKI_TITLE) document.title = LANDING_TITLE;
    detachWikiObserver();
    wikiActive = false;
  }

  function navigate() {
    if (isWebHash()) {
      leaveWiki();
      enterWeb();
    } else if (isWikiHash()) {
      leaveWeb();
      enterWiki();
    } else {
      leaveWeb();
      leaveWiki();
    }
  }

  var wikiSearchBox = document.getElementById("wiki-search");
  if (wikiSearchBox) wikiSearchBox.addEventListener("input", applyWikiFilter);

  // ------------------------------------------------ report a problem dialog
  // Opens a small in-page form (landing page + wiki, never the web route) and
  // submits the report in the background to a server-side endpoint — the user
  // stays on the site, nothing navigates away.

  var APP_VERSION = "0.4.9";
  var REPORT_ENDPOINT = "/.netlify/functions/report";

  var reportDialog = document.getElementById("report-dialog");
  var reportForm = document.getElementById("report-form");
  var reportMessage = document.getElementById("report-message");
  var reportStatus = document.getElementById("report-status");
  var reportSend = document.getElementById("report-send");
  var lastReportFocus = null;
  var reportSending = false;

  function reportPageName() {
    var hash = window.location.hash || "";
    if (hash.indexOf("#/wiki") === 0) return hash;
    if (hash.indexOf("#/web") === 0) return hash;
    return "Home";
  }

  function openReportDialog() {
    if (!reportDialog) return;
    if (!reportDialog.hidden) return;
    lastReportFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    reportDialog.hidden = false;
    document.documentElement.setAttribute("data-report-dialog", "open");
    clearReportStatus();
    if (reportMessage) {
      window.requestAnimationFrame(function () {
        try { reportMessage.focus(); } catch (err) { /* ignore */ }
      });
    }
  }

  function closeReportDialog() {
    if (!reportDialog || reportDialog.hidden) return;
    reportDialog.hidden = true;
    document.documentElement.removeAttribute("data-report-dialog");
    if (reportSending) return; // keep the status/focus as-is; submit already finished
    clearReportStatus();
    if (lastReportFocus && lastReportFocus.focus) {
      try { lastReportFocus.focus(); } catch (err) { /* ignore */ }
    }
    lastReportFocus = null;
  }

  function setReportStatus(type, text) {
    if (!reportStatus) return;
    reportStatus.textContent = text;
    reportStatus.hidden = !text;
    reportStatus.classList.toggle("report-status-error", type === "error");
    reportStatus.classList.toggle("report-status-ok", type === "ok");
  }

  function clearReportStatus() {
    if (reportStatus) {
      reportStatus.hidden = true;
      reportStatus.textContent = "";
      reportStatus.classList.remove("report-status-error", "report-status-ok");
    }
  }

  function submitReport(e) {
    if (!reportForm) return;
    e.preventDefault();
    if (reportSending) return; // prevent duplicate submits
    var text = reportMessage ? reportMessage.value.trim() : "";
    if (!text) {
      setReportStatus("error", "Please describe the problem before sending.");
      if (reportMessage) reportMessage.focus();
      return;
    }
    reportSending = true;
    if (reportSend) {
      reportSend.disabled = true;
      reportSend.textContent = "Sending…";
    }
    var payload = {
      message: text,
      source: "Spatia Website",
      page: reportPageName(),
      browser: navigator.userAgent || "unknown",
      platform: navigator.platform || "unknown",
      version: APP_VERSION,
    };
    fetch(REPORT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json().catch(function () {
          return {};
        });
      })
      .then(function () {
        reportSending = false;
        if (reportSend) {
          reportSend.disabled = false;
          reportSend.textContent = "Send report";
        }
        if (reportMessage) reportMessage.value = "";
        setReportStatus("ok", "Report sent. Thank you!");
      })
      .catch(function () {
        reportSending = false;
        if (reportSend) {
          reportSend.disabled = false;
          reportSend.textContent = "Send report";
        }
        setReportStatus("error", "Couldn't send the report. Please try again.");
      });
  }

  if (reportDialog) {
    document.addEventListener("click", function (ev) {
      var openBtn = ev.target && ev.target.closest
        ? ev.target.closest("[data-report-open]")
        : null;
      if (openBtn) {
        ev.preventDefault();
        openReportDialog();
        return;
      }
      var closeBtn = ev.target && ev.target.closest
        ? ev.target.closest("[data-report-close]")
        : null;
      if (closeBtn) {
        ev.preventDefault();
        closeReportDialog();
      }
    });

    document.addEventListener("keydown", function (ev) {
      if (reportDialog.hidden) return;
      if (ev.key === "Escape" || ev.key === "Esc") {
        ev.preventDefault();
        closeReportDialog();
      }
    });

    if (reportForm) reportForm.addEventListener("submit", submitReport);
  }

  // ---------------------------------------------------------- service worker

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    // ?no-sw=1 is used by the local verification harness to keep caches clean.
    if (window.location.search.indexOf("no-sw=1") !== -1) return;
    window.addEventListener("load", function () {
      navigator.serviceWorker
        .register("./sw.js", { scope: "./" })
        .catch(function (err) {
          console.warn("service worker registration failed:", err);
        });
    });
  }

  registerServiceWorker();
  applyStandalone();
  window.addEventListener("hashchange", navigate);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", navigate);
  } else {
    navigate();
  }
})();