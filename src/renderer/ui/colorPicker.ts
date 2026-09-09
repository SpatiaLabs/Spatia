/**
 * Custom continuous color picker for the object inspector.
 *
 * The native `<input type="color">` opens a modal OS dialog — there is no
 * press-and-drag interaction and no live preview. This module upgrades every
 * `input[type="color"]` in the inspector (data-prop fields and the pen palette)
 * to a lightweight in-place picker: a swatch chip, plus a popover with a
 * saturation/value field and a hue strip. Inside the field you press, drag and
 * hold with mouse, touch or Apple Pencil — the preview updates continuously —
 * and the color is committed on release. The hidden native input still carries
 * the value and a `change` event is dispatched on commit, so the rest of the
 * app (command-based property commits, pen style) works exactly as before.
 */

interface Hsv {
  h: number;
  s: number;
  v: number;
}

interface CpState {
  color: Hsv;
  dragging: "sv" | "hue" | null;
}

const HEX_RE = /^#?([0-9a-f]{6})$/i;

let popover: HTMLElement | null = null;
let activeNative: HTMLInputElement | null = null;

function stateOf(pop: HTMLElement): CpState {
  const key = "__cpState" as never;
  const existing = (pop as unknown as Record<string, CpState>)[key];
  if (existing) return existing;
  const fresh: CpState = { color: { h: 0, s: 0, v: 100 }, dragging: null };
  (pop as unknown as Record<string, CpState>)[key] = fresh;
  return fresh;
}

function injectStyles(): void {
  if (document.getElementById("cp-styles")) return;
  const css = `
    .cp-chip{position:relative;width:24px;height:24px;flex:0 0 auto;border-radius:6px;border:1px solid rgba(255,255,255,.28);cursor:pointer;padding:0;background:var(--cp-color,#000);box-shadow:inset 0 0 0 1px rgba(0,0,0,.25)}
    .cp-native{position:absolute;opacity:0;width:0;height:0;pointer-events:none}
    .cp-pop{position:fixed;z-index:3000;width:218px;padding:10px;border-radius:12px;background:rgba(30,32,40,.97);border:1px solid rgba(255,255,255,.14);box-shadow:0 10px 32px rgba(0,0,0,.5);backdrop-filter:blur(10px)}
    .cp-pop[hidden]{display:none}
    .cp-sv{position:relative;height:126px;border-radius:7px;touch-action:none;cursor:crosshair;border:1px solid rgba(255,255,255,.16);overflow:hidden}
    .cp-sv-overlay{position:absolute;inset:0;background:linear-gradient(to top,#000,rgba(0,0,0,0));pointer-events:none}
    .cp-hue{position:relative;height:14px;margin-top:10px;border-radius:8px;touch-action:none;cursor:pointer;background:linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)}
    .cp-knob{position:absolute;width:15px;height:15px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.55),0 1px 3px rgba(0,0,0,.5);transform:translate(-50%,-50%);pointer-events:none;top:0;left:0}
    .cp-preview{display:flex;align-items:center;gap:8px;margin-top:10px}
    .cp-swatch{width:22px;height:22px;border-radius:6px;border:1px solid rgba(255,255,255,.2);flex:0 0 auto}
    .cp-swatch.before{opacity:.55;border-style:dashed}
    .cp-hex{flex:1;min-width:0;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.14);color:#e8eaf0;border-radius:7px;padding:5px 8px;font:inherit;font-size:12px;outline:none}
    .cp-hex:focus{border-color:#6d7df6}
  `;
  const style = document.createElement("style");
  style.id = "cp-styles";
  style.textContent = css;
  document.head.appendChild(style);
}

function hsvToHex(hue: number, sat: number, val: number): string {
  const h = ((hue % 360) + 360) % 360;
  const s = Math.max(0, Math.min(100, sat)) / 100;
  const v = Math.max(0, Math.min(100, val)) / 100;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) {
    r = c;
    g = x;
  } else if (h < 120) {
    r = x;
    g = c;
  } else if (h < 180) {
    g = c;
    b = x;
  } else if (h < 240) {
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  const to = (n: number): string => Math.round((n + m) * 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

function hexToHsv(hex: string): Hsv {
  const m = HEX_RE.exec(hex || "");
  if (!m) return { h: 0, s: 0, v: 100 };
  const num = parseInt(m[1], 16);
  const r = ((num >> 16) & 255) / 255;
  const g = ((num >> 8) & 255) / 255;
  const b = (num & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : (d / max) * 100, v: max * 100 };
}

function normalizeHex(value: string): string {
  const m = HEX_RE.exec((value || "").trim());
  return m ? `#${m[1].toLowerCase()}` : "";
}

function closePopover(): void {
  if (popover) popover.hidden = true;
  activeNative = null;
}

function commitColor(native: HTMLInputElement, hex: string): void {
  if (native.value.toLowerCase() !== hex.toLowerCase()) {
    native.value = hex;
    native.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function updateSVBackground(sv: HTMLElement, hue: number): void {
  sv.style.background = `linear-gradient(to right, #fff, hsl(${hue} 100% 50%))`;
}

function ensurePopover(): HTMLElement {
  if (popover) return popover;
  const root = document.createElement("div");
  root.className = "cp-pop";
  root.id = "cp-popover";
  root.hidden = true;
  root.innerHTML =
    '<div class="cp-sv" id="cp-sv"><div class="cp-sv-overlay"></div><div class="cp-knob"></div></div>' +
    '<div class="cp-hue" id="cp-hue"><div class="cp-knob"></div></div>' +
    '<div class="cp-preview"><div class="cp-swatch before" id="cp-before" title="Previous color"></div>' +
    '<div class="cp-swatch" id="cp-after" title="New color"></div>' +
    '<input class="cp-hex" id="cp-hex" type="text" spellcheck="false" aria-label="Hex color"></div>';
  document.body.appendChild(root);

  const sv = root.querySelector<HTMLElement>("#cp-sv")!;
  const hue = root.querySelector<HTMLElement>("#cp-hue")!;
  const after = root.querySelector<HTMLElement>("#cp-after")!;
  const hex = root.querySelector<HTMLInputElement>("#cp-hex")!;
  const svKnob = sv.querySelector<HTMLElement>(".cp-knob")!;
  const hueKnob = hue.querySelector<HTMLElement>(".cp-knob")!;
  let held: "sv" | "hue" | null = null;
  let heldEl: HTMLElement | null = null;

  const refresh = (): void => {
    const color = stateOf(root).color;
    const hexVal = hsvToHex(color.h, color.s, color.v);
    svKnob.style.left = `${color.s}%`;
    svKnob.style.top = `${100 - color.v}%`;
    hueKnob.style.left = `${(color.h / 360) * 100}%`;
    after.style.background = hexVal;
    if (document.activeElement !== hex) hex.value = hexVal;
  };

  const bound = (e: PointerEvent, el: HTMLElement): { x: number; y: number } => {
    const rect = el.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    };
  };

  const onMove = (e: PointerEvent): void => {
    if (!held || !heldEl || !activeNative) return;
    e.preventDefault();
    const color = stateOf(root).color;
    if (held === "hue") {
      const { x } = bound(e, heldEl);
      color.h = x * 360;
      updateSVBackground(sv, color.h);
    } else {
      const { x, y } = bound(e, heldEl);
      color.s = x * 100;
      color.v = (1 - y) * 100;
    }
    refresh();
  };
  const onStart = (e: PointerEvent, which: "sv" | "hue"): void => {
    if (!activeNative) return;
    e.preventDefault();
    held = which;
    heldEl = which === "sv" ? sv : hue;
    heldEl.setPointerCapture(e.pointerId);
    onMove(e);
  };
  const onEnd = (e: PointerEvent): void => {
    if (!held || !heldEl) return;
    e.preventDefault();
    if (heldEl.hasPointerCapture(e.pointerId)) heldEl.releasePointerCapture(e.pointerId);
    held = null;
    heldEl = null;
    if (!activeNative) return;
    const color = stateOf(root).color;
    commitColor(activeNative, hsvToHex(color.h, color.s, color.v));
    closePopover();
  };

  sv.addEventListener("pointerdown", (e) => onStart(e, "sv"));
  hue.addEventListener("pointerdown", (e) => onStart(e, "hue"));
  sv.addEventListener("pointermove", onMove);
  hue.addEventListener("pointermove", onMove);
  sv.addEventListener("pointerup", onEnd);
  hue.addEventListener("pointerup", onEnd);

  hex.addEventListener("change", () => {
    if (!activeNative) return;
    const hexVal = normalizeHex(hex.value);
    if (!hexVal) {
      const color = stateOf(root).color;
      hex.value = hsvToHex(color.h, color.s, color.v);
      return;
    }
    stateOf(root).color = hexToHsv(hexVal);
    const color = stateOf(root).color;
    updateSVBackground(sv, color.h);
    refresh();
    commitColor(activeNative, hexVal);
    closePopover();
  });

  const onOutside = (e: Event): void => {
    if (root.hidden) return;
    const t = e.target as HTMLElement | null;
    if (t && (root.contains(t) || t.classList.contains("cp-chip"))) return;
    closePopover();
  };
  document.addEventListener("pointerdown", onOutside, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePopover();
  });
  window.addEventListener("resize", closePopover, { passive: true });

  popover = root;
  return root;
}

/** Upgrade every inspector color input into the interactive picker. */
export function initInspectorColorPickers(container: HTMLElement): void {
  injectStyles();
  closePopover();
  const picker = ensurePopover();
  const sv = picker.querySelector<HTMLElement>("#cp-sv")!;
  const before = picker.querySelector<HTMLElement>("#cp-before")!;
  const svKnob = sv.querySelector<HTMLElement>(".cp-knob")!;

  for (const input of Array.from(container.querySelectorAll<HTMLInputElement>('input[type="color"]'))) {
    if (!input.dataset.prop && !input.dataset.pen) continue;
    input.classList.add("cp-native");

    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "cp-chip";
    chip.setAttribute("aria-label", `Color ${input.value}`);
    chip.style.setProperty("--cp-color", input.value);

    const row = input.closest(".inspector-row") ?? input.parentElement;
    (row ?? input.parentElement)?.appendChild(chip);

    chip.addEventListener("click", () => {
      if (!picker.hidden && activeNative === input) {
        closePopover();
        return;
      }
      closePopover();
      activeNative = input;
      const color = hexToHsv(input.value);
      stateOf(picker).color = color;
      updateSVBackground(sv, color.h);
      before.style.background = input.value;
      const knob = svKnob;
      knob.style.left = `${color.s}%`;
      knob.style.top = `${100 - color.v}%`;
      picker.hidden = false;
      const force = (): void => {
        const native = activeNative;
        const chipEl = native?.parentElement?.querySelector<HTMLElement>(".cp-chip");
        const rect = chipEl ? chipEl.getBoundingClientRect() : native?.getBoundingClientRect();
        if (!rect) return;
        const pw = picker.offsetWidth;
        const ph = picker.offsetHeight;
        let left = rect.right - pw;
        left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
        let top = rect.bottom + 8;
        if (top + ph > window.innerHeight - 8) top = rect.top - ph - 8;
        picker.style.left = `${Math.round(left)}px`;
        picker.style.top = `${Math.max(8, Math.round(top))}px`;
      };
      force();
      requestAnimationFrame(force);
    });
  }
}