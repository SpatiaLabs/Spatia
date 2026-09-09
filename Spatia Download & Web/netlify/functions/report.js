"use strict";

/**
 * Spatia — "Report a problem" endpoint.
 *
 * Receives a JSON problem report from the site's in-page report dialog and
 * forwards it to the RESEND_API_KEY inbox as an email. No secrets live in the
 * client: the API key is read from the Netlify function environment only.
 *
 * Required environment variables:
 *   RESEND_API_KEY  - Resend API key used to send the email
 *   REPORT_FROM     - verified sender address ("Spatia Website <no-reply@...>")
 * Optional:
 *   REPORT_TO       - receiver (default: spatiacanvas@gmail.com)
 *   REPORT_SUBJECT  - default: "Spatia — Problem Report"
 */

const RESEND_API = "https://api.resend.com/emails";
const DEFAULT_TO = "spatiacanvas@gmail.com";
const DEFAULT_SUBJECT = "Spatia \u2014 Problem Report";
const MAX_MESSAGE = 6000;

function readBody(event) {
  if (event.isBase64Encoded) {
    return Buffer.from(event.body || "", "base64").toString("utf8");
  }
  return event.body || "";
}

function respond(statusCode, body, extraHeaders) {
  return {
    statusCode,
    headers: Object.assign(
      {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Content-Type": "application/json",
      },
      extraHeaders || {}
    ),
    body: JSON.stringify(body),
  };
}

function buildEmail(payload) {
  const message = (payload.message || "").trim().slice(0, MAX_MESSAGE);
  const page = (payload.page || "Home").trim();
  const browser = (payload.browser || "unknown").trim();
  const platform = (payload.platform || "unknown").trim();
  const version = (payload.version || "unknown").trim();
  const source = (payload.source || "Spatia Website").trim();

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
    to: (process.env.REPORT_TO || DEFAULT_TO).trim(),
    from: (process.env.REPORT_FROM || "").trim(),
    subject: (process.env.REPORT_SUBJECT || DEFAULT_SUBJECT).trim(),
    text: lines.join("\n"),
  };
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return respond(204, {});
  }
  if (event.httpMethod !== "POST") {
    return respond(405, { ok: false, error: "method not allowed" });
  }

  let payload = null;
  try {
    const raw = readBody(event);
    if (raw) payload = JSON.parse(raw);
  } catch (err) {
    return respond(400, { ok: false, error: "invalid JSON body" });
  }

  payload = payload || {};
  if (!payload.message || !String(payload.message).trim()) {
    return respond(400, { ok: false, error: "message is required" });
  }

  const apiKey = (process.env.RESEND_API_KEY || "").trim();
  if (!apiKey) {
    return respond(500, { ok: false, error: "sending not configured" });
  }

  const email = buildEmail(payload);
  if (!email.from) {
    return respond(500, { ok: false, error: "sender not configured" });
  }

  try {
    const res = await fetch(RESEND_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
      },
      body: JSON.stringify({
        from: email.from,
        to: [email.to],
        subject: email.subject,
        text: email.text,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(function () { return ""; });
      console.error("report: resend error", res.status, detail);
      return respond(502, { ok: false, error: "delivery failed" });
    }
    return respond(200, { ok: true });
  } catch (err) {
    console.error("report: delivery exception", err);
    return respond(502, { ok: false, error: "delivery failed" });
  }
};