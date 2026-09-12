export interface ContextMenuItem {
  label: string;
  shortcut?: string;
  enabled?: boolean;
  separatorBefore?: boolean;
  action?: () => void;
  /** Optional one-level-deep submenu. */
  items?: ContextMenuItem[];
}

let menuEl: HTMLDivElement | null = null;
let nestedMenuEl: HTMLDivElement | null = null;
let hideNestedTimer: number | null = null;

/**
 * Lightweight custom context menu rendered as absolutely-positioned DOM inside
 * the document, replacing the native menu. Items are supplied by the caller;
 * the menu disappears on any outside interaction or Escape. Items may carry an
 * `items` array to render a one-level-deep submenu shown on hover.
 */
export function showContextMenu(items: ContextMenuItem[], screenX: number, screenY: number): void {
  hideContextMenu();

  const menu = document.createElement("div");
  menu.className = "spatia-context-menu";
  menu.id = "spatia-context-menu";

  for (const item of items) {
    if (item.separatorBefore) {
      const sep = document.createElement("div");
      sep.className = "spatia-context-separator";
      menu.appendChild(sep);
    }
    const hasSub = Array.isArray(item.items) && item.items.length > 0;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `spatia-context-item${hasSub ? " spatia-context-item--sub" : ""}`;
    button.disabled = item.enabled === false;

    const lbl = document.createElement("span");
    lbl.className = "spatia-context-label";
    lbl.textContent = item.label;
    button.appendChild(lbl);

    if (item.shortcut) {
      const sc = document.createElement("span");
      sc.className = "spatia-context-shortcut";
      sc.textContent = item.shortcut;
      button.appendChild(sc);
    } else if (hasSub) {
      const arrow = document.createElement("span");
      arrow.className = "spatia-context-shortcut";
      arrow.textContent = "\u25B6";
      button.appendChild(arrow);
    }

    if (hasSub) {
      button.addEventListener("mouseenter", () => {
        clearHideNested();
        showNested(item.items!, button);
      });
      button.addEventListener("mouseleave", () => scheduleHideNested());
      // A parent with both a default action and a submenu keeps the primary
      // click fast (instant default) while hovering exposes the variants.
      if (item.action) {
        button.addEventListener("click", () => {
          hideContextMenu();
          item.action?.();
        });
      }
    } else {
      button.addEventListener("click", () => {
        hideContextMenu();
        item.action?.();
      });
    }

    menu.appendChild(button);
  }

  menuEl = menu;
  document.body.appendChild(menu);

  // Keep within the viewport.
  const rect = menu.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = screenX + rect.width > vw ? Math.max(0, vw - rect.width - 4) : screenX;
  const top = screenY + rect.height > vh ? Math.max(0, vh - rect.height - 4) : screenY;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const close = (e: MouseEvent): void => {
    if (menuEl && !menuEl.contains(e.target as Node) && !nestedMenuEl?.contains(e.target as Node)) {
      hideContextMenu();
    }
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") hideContextMenu();
  };
  window.addEventListener("mousedown", close, { once: true });
  window.addEventListener("keydown", onKey, { once: true });
  menu.addEventListener(
    "contextmenu",
    (e) => {
      e.preventDefault();
      hideContextMenu();
    },
    { once: true }
  );
}

export function hideContextMenu(): void {
  destroyNested();
  if (menuEl && menuEl.parentNode) {
    menuEl.parentNode.removeChild(menuEl);
  }
  menuEl = null;
}

// ---- Nested submenu helpers ----

function showNested(items: ContextMenuItem[], anchor: HTMLElement): void {
  destroyNested();
  const sub = document.createElement("div");
  sub.className = "spatia-context-menu";
  for (const item of items) {
    if (item.separatorBefore) {
      const sep = document.createElement("div");
      sep.className = "spatia-context-separator";
      sub.appendChild(sep);
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "spatia-context-item";
    btn.disabled = item.enabled === false;
    const lbl = document.createElement("span");
    lbl.className = "spatia-context-label";
    lbl.textContent = item.label;
    btn.appendChild(lbl);
    if (item.shortcut) {
      const sc = document.createElement("span");
      sc.className = "spatia-context-shortcut";
      sc.textContent = item.shortcut;
      btn.appendChild(sc);
    }
    btn.addEventListener("click", () => {
      hideContextMenu();
      item.action?.();
    });
    sub.appendChild(btn);
  }
  sub.addEventListener("mouseenter", clearHideNested);
  sub.addEventListener("mouseleave", () => scheduleHideNested());
  document.body.appendChild(sub);
  nestedMenuEl = sub;

  const anchorRect = anchor.getBoundingClientRect();
  const subRect = sub.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = anchorRect.right + subRect.width > vw ? Math.max(0, anchorRect.left - subRect.width - 2) : anchorRect.right - 1;
  const top = anchorRect.top + subRect.height > vh ? Math.max(0, vh - subRect.height - 4) : anchorRect.top;
  sub.style.left = `${left}px`;
  sub.style.top = `${top}px`;
}

function scheduleHideNested(): void {
  hideNestedTimer = window.setTimeout(destroyNested, 120);
}

function clearHideNested(): void {
  if (hideNestedTimer !== null) {
    window.clearTimeout(hideNestedTimer);
    hideNestedTimer = null;
  }
}

function destroyNested(): void {
  if (nestedMenuEl && nestedMenuEl.parentNode) {
    nestedMenuEl.parentNode.removeChild(nestedMenuEl);
  }
  nestedMenuEl = null;
}
