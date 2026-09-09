/* Spatia Local AI — fully on-device assistant.
 *
 * Loads a GGUF model the user picks from disk and runs it locally in a Web
 * Worker via wllama (WASM). No cloud, no accounts, no network: the model,
 * the wllama library, and its compat runtime are all shipped with the app
 * (desktop) or served same-origin (web).
 *
 * This is a plain ESM module (no TS) because it is loaded by the TypeScript
 * renderer OR the vanilla web-mobile layer, and it builds its own UI DOM.
 * Importing the module auto-mounts the assistant bubble + panel.
 *
 * Runtime sources are resolved relative to this module so they work both
 * from the packaged desktop app (file:// dist/renderer/ai/ai.js) and from the
 * site root (https://host/ai/ai.js).
 */
"use strict";

const VENDOR = "./vendor/";

function css() {
  const style = document.createElement("style");
  style.textContent = `
.ai-root{position:fixed;top:0;left:0;width:0;height:0;z-index:96}
.ai-bubble{
  position:fixed;width:44px;height:44px;border-radius:50%;
  display:flex;align-items:center;justify-content:center;cursor:pointer;user-select:none;touch-action:none;
  background:rgba(255,255,255,.12);color:#e8eaf0;border:1px solid rgba(255,255,255,.22);
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  box-shadow:0 4px 18px rgba(0,0,0,.25),inset 0 0 0 1px rgba(255,255,255,.06);
  transition:transform .15s ease,box-shadow .15s ease
}
.ai-bubble:hover{transform:scale(1.05);box-shadow:0 6px 24px rgba(0,0,0,.35),inset 0 0 0 1px rgba(255,255,255,.08)}
.ai-bubble:active:not(.ai-dragging){transform:scale(0.97)}
.ai-bubble:focus-visible{outline:2px solid #a9b8ff;outline-offset:2px}
.ai-bubble svg{width:20px;height:20px;pointer-events:none}
.ai-dragging{cursor:grabbing!important}
.ai-panel{
  position:fixed;width:330px;max-width:calc(100vw - 24px);
  max-height:min(68vh,540px);display:flex;flex-direction:column;overflow:hidden;
  background:rgba(28,30,40,.96);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);
  border:1px solid rgba(255,255,255,.12);border-radius:14px;
  box-shadow:0 10px 40px rgba(0,0,0,.45),inset 0 0 0 1px rgba(255,255,255,.06);
  color:#e8eaf0;font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif
}
.ai-panel[hidden]{display:none}
.ai-panel-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.02);border-radius:14px 14px 0 0}
.ai-panel-head strong{font-size:13px;font-weight:600;flex:1}
.ai-panel-head button{background:none;border:none;color:#9aa0ab;cursor:pointer;font-size:15px;padding:2px 6px;border-radius:6px}
.ai-panel-head button:hover{color:#fff;background:rgba(255,255,255,.08)}
.ai-model{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.08)}
.ai-model .btn{
  background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);color:#e8eaf0;
  padding:5px 10px;border-radius:7px;font-size:12px;font-weight:550;cursor:pointer;white-space:nowrap
}
.ai-model .btn:hover{background:rgba(255,255,255,.14)}
.ai-model .btn:disabled{opacity:.55;cursor:default}
.ai-status{flex:1;min-width:0;font-size:11px;color:#9aa0ab;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ai-status.ai-error{color:#ff8d8d}
.ai-log{flex:1;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:8px;min-height:120px;max-height:280px}
.ai-empty{color:#69707c;font-size:12px;text-align:center;margin:auto}
.ai-step{align-self:flex-start;max-width:100%;font-size:11px;color:#9aa0ab;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.06);border-radius:8px;padding:5px 9px;white-space:pre-wrap;word-break:break-word}
.ai-step-err{color:#ff8d8d;background:rgba(255,120,120,.08)}
.ai-msg{max-width:92%;padding:7px 10px;border-radius:10px;white-space:pre-wrap;word-break:break-word;font-size:12.5px}
.ai-user{align-self:flex-end;background:#4a5ef0;color:#fff;border-bottom-right-radius:3px}
.ai-assistant{align-self:flex-start;background:rgba(255,255,255,.09);color:#dde1e8;border-bottom-left-radius:3px}
.ai-msg.ai-stream::after{content:"\\258b";animation:ai-blink 1s steps(2) infinite;color:#8d9bff}
@keyframes ai-blink{50%{opacity:0}}
.ai-form{display:flex;align-items:flex-end;gap:8px;padding:10px 12px;border-top:1px solid rgba(255,255,255,.08)}
.ai-form textarea{
  flex:1;resize:none;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);
  border-radius:8px;color:#e8eaf0;font:inherit;padding:7px 9px;min-height:34px;max-height:96px;outline:none
}
.ai-form textarea:focus{border-color:#6d7df6}
#ai-send{background:#4a5ef0;border:none;color:#fff;padding:8px 13px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer}
#ai-send:disabled{opacity:.5;cursor:default}
`;
  document.head.appendChild(style);
}

const state = {
  engine: null,
  modelName: null,
  ready: false,
  busy: false,
  history: [],
};

let ui = null;

function mount() {
  if (ui) return;
  css();
  const root = document.createElement("div");
  root.className = "ai-root";
  root.innerHTML =
    '<button id="ai-bubble" class="ai-bubble" type="button" aria-haspopup="dialog" aria-expanded="false" aria-label="AI Assistant">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 4.9L18.8 9l-4.9 1.9L12 15.8l-1.9-4.9L5.2 9l4.9-1.1z"/><circle cx="18.5" cy="5.5" r=".9" fill="currentColor"/><circle cx="6" cy="17" r=".9" fill="currentColor"/></svg></button>' +
    '<section id="ai-panel" class="ai-panel" role="dialog" aria-label="AI Assistant" aria-hidden="true" hidden>' +
    '<div class="ai-panel-head"><strong>AI Assistant</strong><button id="ai-clear" type="button" title="Clear conversation">Clear</button><button id="ai-close" type="button" title="Close">&#215;</button></div>' +
    '<div class="ai-model"><button id="ai-pick" class="btn" type="button">Load model…</button><div id="ai-status" class="ai-status">No model loaded — pick a .gguf file</div></div>' +
    '<div id="ai-log" class="ai-log"><div class="ai-empty">Load a GGUF model and ask anything. Everything runs on this device.</div></div>' +
    '<form id="ai-form" class="ai-form" autocomplete="off"><textarea id="ai-input" rows="1" placeholder="Ask the local model…"></textarea><button id="ai-send" type="submit">Send</button></form>' +
    "</section>" +
    '<input id="ai-file" type="file" accept=".gguf,.GGUF" hidden>';
  document.body.appendChild(root);

  const form = root.querySelector("#ai-form");
  const sendBtn = root.querySelector("#ai-send");
  ui = {
    root,
    bubble: root.querySelector("#ai-bubble"),
    panel: root.querySelector("#ai-panel"),
    close: root.querySelector("#ai-close"),
    clear: root.querySelector("#ai-clear"),
    pick: root.querySelector("#ai-pick"),
    status: root.querySelector("#ai-status"),
    log: root.querySelector("#ai-log"),
    input: root.querySelector("#ai-input"),
    file: root.querySelector("#ai-file"),
  };

  // ------ Bubble drag + position persistence ----------------------------------

  const POS_KEY = "spatia.aiBubblePos";
  const BUBBLE_SIZE = 44;

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  function moveBubble(l, t) {
    ui.bubble.style.left = clamp(l, 8, window.innerWidth - BUBBLE_SIZE - 8) + "px";
    ui.bubble.style.top  = clamp(t, 8, window.innerHeight - BUBBLE_SIZE - 8) + "px";
  }

  function saveBubblePos() {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify({
        left: parseFloat(ui.bubble.style.left),
        top:  parseFloat(ui.bubble.style.top),
      }));
    } catch { /* quota / private-browsing best-effort */ }
  }

  function positionPanel() {
    if (ui.panel.hidden) return;
    const bx = parseFloat(ui.bubble.style.left || 0);
    const by = parseFloat(ui.bubble.style.top || 0);
    const pw = ui.panel.offsetWidth;
    const ph = ui.panel.offsetHeight;
    let left = bx - (pw - BUBBLE_SIZE) / 2;
    left = clamp(left, 8, window.innerWidth - pw - 8);
    let top = by - ph - 14;
    if (top < 8) top = by + BUBBLE_SIZE + 14;
    ui.panel.style.left = left + "px";
    ui.panel.style.top  = top + "px";
  }

  // Restore persisted position or apply default.
  (function restorePos() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(POS_KEY)); } catch { /* */ }
    if (saved && typeof saved.left === "number" && typeof saved.top === "number") {
      moveBubble(saved.left, saved.top);
    } else {
      moveBubble(window.innerWidth - BUBBLE_SIZE - 24, 102);
    }
  })();

  window.addEventListener("resize", function () {
    moveBubble(parseFloat(ui.bubble.style.left), parseFloat(ui.bubble.style.top));
    positionPanel();
  }, { passive: true });

  // ------ Safe drag (threshold before movement counts as a drag) ----------

  var dragPt = null;
  var dragging = false;

  ui.bubble.addEventListener("pointerdown", function (e) {
    if (e.button !== 0) return;
    e.preventDefault();
    dragPt = { x: e.clientX, y: e.clientY };
    dragging = false;
    ui.bubble.setPointerCapture(e.pointerId);
  });

  ui.bubble.addEventListener("pointermove", function (e) {
    if (dragPt === null) return;
    var dx = e.clientX - dragPt.x;
    var dy = e.clientY - dragPt.y;
    if (!dragging && Math.abs(dx) + Math.abs(dy) > 6) dragging = true;
    if (dragging) {
      e.preventDefault();
      ui.bubble.classList.add("ai-dragging");
      moveBubble(
        parseFloat(ui.bubble.style.left) + dx,
        parseFloat(ui.bubble.style.top)  + dy,
      );
      dragPt = { x: e.clientX, y: e.clientY };
      positionPanel();
    }
  });

  ui.bubble.addEventListener("pointerup", function () {
    if (dragPt !== null) {
      ui.bubble.classList.remove("ai-dragging");
      var wasDrag = dragging;
      dragging = false;
      dragPt = null;
      if (wasDrag) { saveBubblePos(); return; }
    }
    togglePanel();
  });

    ui.close.addEventListener("click", () => setOpen(false));
  ui.clear.addEventListener("click", () => {
    state.history = [];
    ui.log.innerHTML = '<div class="ai-empty">Conversation cleared.</div>';
  });
  ui.pick.addEventListener("click", () => ui.file.click());
  ui.file.addEventListener("change", () => {
    const file = ui.file.files && ui.file.files[0];
    if (file) {
      ui.file.value = "";
      void loadModel(file);
    }
  });
  ui.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!e.repeat) void send();
    }
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void send();
  });

  // ------ Panel toggle / open helpers --------------------------------------

  function togglePanel() {
    setOpen(ui.panel.hidden);
  }
  function setOpen(open) {
    ui.panel.hidden = !open;
    ui.panel.setAttribute("aria-hidden", String(!open));
    ui.bubble.setAttribute("aria-expanded", String(open));
    if (open) {
      positionPanel();
      ui.input.focus();
    }
  }
}

function setStatus(text, isError) {
  if (!ui) return;
  ui.status.textContent = text;
  ui.status.classList.toggle("ai-error", Boolean(isError));
}

function appendMessage(role, text) {
  if (!ui) return;
  const empty = ui.log.querySelector(".ai-empty");
  if (empty) empty.remove();
  const el = document.createElement("div");
  el.className = "ai-msg " + (role === "user" ? "ai-user" : "ai-assistant");
  el.textContent = text;
  ui.log.appendChild(el);
  el.scrollIntoView({ block: "end" });
  return el;
}

function lastAssistantEl() {
  if (!ui) return null;
  let node = ui.log.lastElementChild;
  while (node && node.classList.contains("ai-user")) node = node.previousElementSibling;
  if (node && node.classList.contains("ai-assistant")) return node;
  return null;
}

function notify(msg) {
  try {
    const app = window.__spatia;
    if (app && typeof app.ui?.notify === "function") app.ui.notify(msg);
  } catch {
    /* ignore */
  }
}

async function importWllama() {
  const pkg = await import(new URL(VENDOR + "wllama.min.js", import.meta.url).href);
  if (typeof pkg.Wllama !== "function") {
    throw new Error("The bundled AI engine could not be found.");
  }
  return pkg.Wllama;
}

function decodeBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Load wllama + its local compat runtime. Desktop reads payloads via IPC
 *  (file:// fetch is blocked by CORS); the web fetches them same-origin. */
async function loadCompat(WllamaClass) {
  const hasIpc = !!(window.spatia && typeof window.spatia.aiGetAsset === "function");
  let code;
  let wasmBytes;
  if (hasIpc) {
    const js = await window.spatia.aiGetAsset("compat.js");
    const wasm = await window.spatia.aiGetAsset("compat.wasm");
    if (!js || !wasm) throw new Error("The AI runtime is missing — reinstall Spatia.");
    code = atob(js.data);
    wasmBytes = decodeBase64(wasm.data);
  } else {
    const codeUrl = new URL(VENDOR + "compat.js", import.meta.url).href;
    const wasmUrl = new URL(VENDOR + "compat.wasm", import.meta.url).href;
    const [codeRes, wasmRes] = await Promise.all([fetch(codeUrl), fetch(wasmUrl)]);
    if (!codeRes.ok || !wasmRes.ok) throw new Error("Could not load the AI runtime.");
    code = await codeRes.text();
    wasmBytes = new Uint8Array(await wasmRes.arrayBuffer());
  }
  const wasmUrl = URL.createObjectURL(new Blob([wasmBytes], { type: "application/wasm" }));
  return { code, wasmUrl };
}

let enginePromise = null;

async function ensureEngine() {
  if (state.engine) return state.engine;
  if (!enginePromise) {
    enginePromise = (async () => {
      const WllamaClass = await importWllama();
      setStatus("Preparing local engine…");
      const engine = new WllamaClass({ default: "wllama.wasm" });
      const compat = await loadCompat(WllamaClass);
      engine.setCompat(
        { worker: { code: compat.code }, wasm: compat.wasmUrl },
        "firefox_safari"
      );
      state.engine = engine;
      return engine;
    })().catch((err) => {
      enginePromise = null;
      throw err;
    });
  }
  return enginePromise;
}

/** Load a GGUF model file chosen by the user. Fully on-device. */
async function loadModel(file) {
  setStatus("Loading model…");
  ui.pick.disabled = true;
  ui.input.placeholder = "Loading…";
  try {
    const engine = await ensureEngine();
    setStatus("Loading model (large files take time)…");
    await engine.loadModel([file], {
      n_ctx: 2048,
      n_threads: 1,
      n_gpu_layers: 0,
      log_level: 4,
    });
    state.modelName = file.name;
    state.ready = true;
    state.history = [];
    setStatus("Ready — " + file.name);
    notify("Local AI is ready.");
  } catch (err) {
    setStatus("Model failed to load: " + (err && err.message ? err.message : "unknown error"), true);
    notify("Local AI could not load that model.");
    await unload();
  } finally {
    ui.pick.disabled = false;
    ui.input.placeholder = "Ask the local model…";
  }
}

/** Run a conversational turn. Caller passes the full history. */
async function chat(messages, onToken) {
  const engine = state.engine;
  if (!engine || !state.ready) {
    throw new Error("No model is loaded yet.");
  }
  await engine.createChatCompletion({
    messages,
    stream: true,
    n_predict: 256,
    temperature: 0.7,
    top_p: 0.95,
    top_k: 40,
    onData(chunk) {
      const delta = chunk && chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
      if (delta && typeof delta.content === "string" && delta.content) {
        onToken(delta.content);
      }
    },
  });
}

function unload() {
  const engine = state.engine;
  state.engine = null;
  state.ready = false;
  state.modelName = null;
  state.history = [];
  enginePromise = null;
  if (engine) {
    try {
      engine.exit();
    } catch {
      /* ignore */
    }
  }
  setStatus("No model loaded");
}

async function send() {
  const text = ui.input.value.trim();
  if (!text || state.busy) return;
  if (!state.ready) {
    setStatus("Load a .gguf model first.", true);
    notify("Load a model first — click the AI bubble.");
    return;
  }
  state.busy = true;
  ui.input.value = "";
  state.history.push({ role: "user", content: text });
  appendMessage("user", text);
  try {
    if (agentHost && typeof agentHost.runTool === "function") {
      await agentSend(text);
    } else {
      setStatus("Thinking…");
      const bubble = appendMessage("assistant", "");
      bubble.classList.add("ai-stream");
      await chat(state.history, (token) => {
        bubble.classList.add("ai-stream");
        bubble.textContent += token;
        bubble.scrollIntoView({ block: "end" });
      });
      bubble.classList.remove("ai-stream");
      state.history.push({ role: "assistant", content: bubble.textContent });
    }
    setStatus("Ready — " + state.modelName);
  } catch (err) {
    appendMessage("assistant", "(error) " + (err && err.message ? err.message : "unknown error"));
    setStatus("Generation failed.", true);
  } finally {
    state.busy = false;
  }
}

// ---------------------------------------------------------------- agent loop

let agentHost = null;

/** Attach the validated, command-backed Spatia tool layer to this module. */
export function attachHost(host) {
  agentHost = host || null;
}

function buildSystemPrompt(tools) {
  const lines = (tools || []).map((t) => {
    const params = (t.params || [])
      .map((p) => (p.required ? "" : "?") + p.name + ":" + p.type)
      .join(", ");
    return "- " + t.name + (params ? "(" + params + ")" : "") + " — " + t.description;
  });
  return [
    "You are the Spatia canvas assistant. You can inspect and modify the user's canvas using the tools below.",
    "When you need to act on the canvas, respond with EXACTLY ONE line, nothing else, in this format:",
    'TOOL:{"name":"<tool_name>","args":{...}}',
    'Example: TOOL:{"name":"add_text","args":{"text":"Hello","x":0,"y":0}}',
    "After a tool runs you will see its result, then you can continue or answer normally.",
    "Never invent object ids — run get_canvas_state or get_selection and use ids from the result.",
    "The workspace already shown to you is current; you may still re-check with a tool.",
    "Keep your final answer short.",
    "",
    "Tools:",
    ...lines,
  ].join("\n");
}

function extractToolCall(text) {
  const m = String(text || "").match(/TOOL\s*:\s*(\{[\s\S]*?\})\s*(?:\n|$)/m);
  if (!m) return null;
  try {
    const call = JSON.parse(m[1]);
    if (call && typeof call.name === "string") {
      call.fullLine = m[0].trim();
      return call;
    }
  } catch {
    /* malformed tool call — treat as ordinary text */
  }
  return null;
}

function appendStep(label) {
  if (!ui) return null;
  const empty = ui.log.querySelector(".ai-empty");
  if (empty) empty.remove();
  const el = document.createElement("div");
  el.className = "ai-step";
  el.textContent = label;
  ui.log.appendChild(el);
  el.scrollIntoView({ block: "end" });
  return el;
}

function stepResult(el, ok, text) {
  if (!el) return;
  el.textContent = (ok ? "✓ " : "! ") + text;
  el.classList.toggle("ai-step-err", !ok);
  el.scrollIntoView({ block: "end" });
}

/** One complete (accumulated) model pass — used to detect tool calls. */
async function chatOnce(messages) {
  const engine = state.engine;
  if (!engine || !state.ready) throw new Error("No model is loaded yet.");
  let out = "";
  await engine.createChatCompletion({
    messages,
    stream: true,
    n_predict: 256,
    temperature: 0.5,
    top_p: 0.95,
    top_k: 40,
    onData(chunk) {
      const delta = chunk && chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
      if (delta && typeof delta.content === "string") out += delta.content;
    },
  });
  return out;
}

/** Agent turn: gather workspace context, then run a tool-call loop. */
async function agentSend(text) {
  setStatus("Inspecting workspace…");
  let msgs = [{ role: "system", content: buildSystemPrompt(agentHost.toolsMeta()) }];

  const s1 = appendStep("Inspecting workspace…");
  let stateText = "(workspace unavailable)";
  let selText = "(no selection)";
  try {
    const stateRes = await agentHost.runTool("get_canvas_state", {});
    if (stateRes && stateRes.text) stateText = stateRes.text;
  } catch {
    /* tool layer errors are surfaced below */
  }
  try {
    const selRes = await agentHost.runTool("get_selection", {});
    if (selRes && selRes.text) selText = selRes.text;
  } catch {
    /* ignore */
  }
  stepResult(s1, true, "workspace read ready");
  msgs[0].content += "\n\nWorkspace:\n" + stateText + "\n\nSelection:\n" + selText;
  msgs.push({ role: "user", content: text });

  const maxSteps = 6;
  for (let step = 0; step < maxSteps; step++) {
    setStatus(step === 0 ? "Thinking…" : "Continuing…");
    const full = await chatOnce(msgs);
    const call = extractToolCall(full);
    if (!call) {
      appendMessage("assistant", full.trim() || "(no reply)");
      state.history.push({ role: "assistant", content: full.trim() });
      setStatus("Finished");
      return;
    }
    const known = (agentHost.toolsMeta() || []).some((t) => t.name === call.name);
    if (!known) {
      appendMessage("assistant", "I tried to use an unknown tool (" + call.name + "). Please try again.");
      return;
    }
    const stepEl = appendStep("Executing " + call.name + "…");
    setStatus("Executing " + call.name + "…");
    let res;
    try {
      res = await agentHost.runTool(call.name, call.args);
    } catch (err) {
      res = { ok: false, text: "Tool execution failed: " + (err && err.message ? err.message : "unknown error") };
    }
    const ok = !!(res && res.ok);
    stepResult(stepEl, ok, ok ? res.text : (res && res.text) || "failed");
    msgs.push({ role: "assistant", content: call.fullLine });
    msgs.push({ role: "system", content: "Tool " + call.name + " result: " + (ok ? res.text : "ERROR: " + res.text) });
  }
  appendMessage("assistant", "I've done as much as I can in one turn — ask me to continue for more.");
  setStatus("Finished");
}

export const SpatiaAI = {
  get modelName() {
    return state.modelName;
  },
  get ready() {
    return state.ready;
  },
  loadModel,
  chat,
  unload,
  attachHost,
};

if (typeof window !== "undefined") {
  window.SpatiaAI = SpatiaAI;
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
}