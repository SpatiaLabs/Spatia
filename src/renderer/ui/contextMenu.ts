export interface ContextMenuItem {
  label: string;
  shortcut?: string;
  enabled?: boolean;
  separatorBefore?: boolean;
  action: () => void;
}

let menuEl: HTMLDivElement | null = null;

/**
 * Lightweight custom context menu rendered as absolutely-positioned DOM inside
 * the document, replacing the native menu. Items are supplied by the caller;
 * the menu disappears on any outside interaction or Escape.
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
    const button = document.createElement("button");
    button.type = "button";
    button.className = "spatia-context-item";
    button.disabled = item.enabled === false;
    if (item.shortcut) {
      const lbl = document.createElement("span");
      lbl.className = "spatia-context-label";
      lbl.textContent = item.label;
      const sc = document.createElement("span");
      sc.className = "spatia-context-shortcut";
      sc.textContent = item.shortcut;
      button.appendChild(lbl);
      button.appendChild(sc);
    } else {
      button.textContent = item.label;
    }
    button.addEventListener("click", () => {
      hideContextMenu();
      item.action();
    });
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
    if (menuEl && !menuEl.contains(e.target as Node)) hideContextMenu();
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
  if (menuEl && menuEl.parentNode) {
    menuEl.parentNode.removeChild(menuEl);
  }
  menuEl = null;
}
