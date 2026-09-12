"use strict";

/**
 * Spatia — "Report a problem" endpoint (Cloudflare Worker).
 *
 * The site's in-page report dialog POSTs a JSON problem report here and it is
 * forwarded to the RESEND_API_KEY inbox as an email. No secrets live in the
 * client.
 *
 * Required secrets (set via `wrangler secret put RESEND_API_KEY`):
 *   RESEND_API_KEY  - Resend API key used to send the email
 * Required vars (wrangler.toml [vars]):
 *   REPORT_FROM     - verified sender address ("Spatia Website <no-reply@...>")
 * Optional vars:
 *   REPORT_TO       - receiver (default: spatiacanvas@gmail.com)
 *   REPORT_SUBJECT  - default: "Spatia — Problem Report"
 */

const RESEND_API = "https://api.resend.com/emails";
const DEFAULT_TO = "spatiacanvas@gmail.com";
const DEFAULT_SUBJECT = "Spatia \u2014 Problem Report";
const MAX_MESSAGE = 6000;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
}

function okJson(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: corsHeaders() });
}

function buildEmail(payload) {
  const message = String(payload.message || "").trim().slice(0, MAX_MESSAGE);
  const page = String(payload.page || "Home").trim();
  const browser = String(payload.browser || "unknown").trim();
  const platform = String(payload.platform || "unknown").trim();
  const version = String(payload.version || "unknown").trim();
  const source = String(payload.source || "Spatia Website").trim();

  const lines = [
    source + " problem report \u2014 " + new Date().toISOString(),
    "----------------------------------------",
    "Problem description:",
    message,
    "",
    "Page: " + page,
    "Source: " + source,
    "Browser: " + browser,
    "Platform: " + platform,
    "Version: " + version,
  ];

  return {
    to: String(process.env.REPORT_TO || DEFAULT_TO).trim(),
    from: String(process.env.REPORT_FROM || "").trim(),
    subject: String(process.env.REPORT_SUBJECT || DEFAULT_SUBJECT).trim(),
    text: lines.join("\n"),
  };
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return okJson({}, 204);
    }
    if (request.method !== "POST") {
      return okJson({ ok: false, error: "method not allowed" }, 405);
    }

    let payload = null;
    try {
      payload = await request.json();
    } catch (err) {
      return okJson({ ok: false, error: "invalid JSON body" }, 400);
    }

    payload = payload || {};
    if (!payload.message || !String(payload.message).trim()) {
      return okJson({ ok: false, error: "message is required" }, 400);
    }

    const apiKey = String(process.env.RESEND_API_KEY || "").trim();
    if (!apiKey) {
      return okJson({ ok: false, error: "sending not configured" }, 500);
    }

    const email = buildEmail(payload);
    if (!email.from) {
      return okJson({ ok: false, error: "sender not configured" }, 500);
    }

    try {
      const res = await fetch(RESEND_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + apiKey,
          "User-Agent": "spatia-report-worker",
        },
        body: JSON.stringify({
          from: email.from,
          to: [email.to],
          subject: email.subject,
          text: email.text,
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(function () {
          return "";
        });
        console.error("spatia-report: resend error", res.status, detail);
        return okJson({ ok: false, error: "delivery failed" }, 502);
      }
      return okJson({ ok: true });
    } catch (err) {
      console.error("spatia-report: delivery exception", String(err && err.stack || err));
      return okJson({ ok: false, error: "delivery failed" }, 502);
    }
  },
};