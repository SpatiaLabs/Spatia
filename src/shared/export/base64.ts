/**
 * Dependency-free base64 encode/decode for bytes. Avoids `atob`/`btoa` so the
 * module compiles for both the main and renderer contexts under the umbrella
 * tsconfig (no DOM lib dependency).
 */

const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const REV: Record<string, number> = {};
for (let i = 0; i < CHARS.length; i++) {
  REV[CHARS[i]] = i;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += CHARS[(n >> 18) & 63] + CHARS[(n >> 12) & 63] + CHARS[(n >> 6) & 63] + CHARS[n & 63];
  }
  const rem = bytes.length % 3;
  if (rem === 1) out = out.slice(0, -2) + "==";
  else if (rem === 2) out = out.slice(0, -1) + "=";
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, "");
  const len = clean.length;
  // Strip the trailing padding to know how many real bytes to return.
  let pad = 0;
  if (clean.endsWith("==")) pad = 2;
  else if (clean.endsWith("=")) pad = 1;
  const byteLen = Math.floor((len * 3) / 4) - pad;
  const out = new Uint8Array(byteLen);
  let acc = 0;
  let bits = 0;
  let idx = 0;
  for (let i = 0; i < len; i++) {
    const c = clean[i];
    if (c === "=") break;
    const v = REV[c];
    if (v === undefined) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (idx < byteLen) out[idx++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}