import { CompositionGuard, menuIndex, searchShortcut } from "./keyboard-policy.ts";
export const composition = new CompositionGuard();
const focusable = 'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])';
const available = (element: HTMLElement | null): element is HTMLElement => !!element?.isConnected && element!==document.body && !element.matches(":disabled") && !!element.getClientRects().length && !element.closest("[hidden], [inert]");
export function focusHandle(source: HTMLElement | null = document.activeElement as HTMLElement | null): () => HTMLElement | null {
  const menu=source?.closest<HTMLElement>('[role="menu"]');
  if(menu?.id){const trigger=document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(menu.id)}"][aria-expanded="true"]`);if(trigger)source=trigger;}
  const id = source?.id;
  const key = ["thread", "group", "project", "fork-turn"].find(key => source?.getAttribute("data-" + key));
  const value = key ? source?.getAttribute("data-" + key) : undefined;
  return () => {
    const replacement = id ? document.getElementById(id) : key && value ? document.querySelector<HTMLElement>(`[data-${key}="${CSS.escape(value)}"]`) : source;
    return available(replacement) ? replacement : null;
  };
}
export function restoreFocus(resolve: () => HTMLElement | null, fallback = "main-content"): void {
  if (document.querySelector("dialog[open]")) return;
  (resolve() ?? document.getElementById(fallback))?.focus({ preventScroll: true });
}
export function openModal(dialog: HTMLDialogElement, source = focusHandle(), initial?: HTMLElement): void {
  if (dialog.open || document.querySelector("dialog[open]")) return;
  const nativeSource=focusHandle();
  dialog.addEventListener("close", () => queueMicrotask(() => {
    const active=document.activeElement;
    // Native dialog close is queued. Do not steal focus from a later user action.
    if(active===document.body||dialog.contains(active)||active===nativeSource()||active===source())restoreFocus(source);
  }), { once: true });
  dialog.showModal();
  if (available(initial ?? null)) initial!.focus();
}
export function setText(element: HTMLElement, text: string): void { if (element.textContent !== text) element.textContent = text; }
export function installInteractions(): void {
  let pointerSubmit: HTMLElement | null = null;
  document.addEventListener("click", event => {
    const button=event.target instanceof Element ? event.target.closest<HTMLButtonElement | HTMLInputElement>("button,input") : null;
    if(event.detail>0&&button?.type==="submit"&&button.form){pointerSubmit=button;queueMicrotask(()=>{pointerSubmit=null;});}
  },true);
  // Keep the exact trusted IPC page URL while supporting keyboard skip links.
  for (const link of document.querySelectorAll<HTMLAnchorElement>(".skip-link")) link.addEventListener("click", event => { event.preventDefault(); document.getElementById(link.hash.slice(1))?.focus(); });
  document.addEventListener("compositionstart", () => composition.start(), true);
  document.addEventListener("compositionend", () => composition.end(), true);
  document.addEventListener("keydown", event => {
    const blocked = composition.blocked(event);
    if (blocked && (event.key === "Enter" || event.key === "Escape" || searchShortcut(event) || event.key === "ContextMenu" || event.key === "F10")) {
      // A native composing key belongs to the IME. A trailing non-composing
      // Escape must also suppress Chromium's default dialog dismissal.
      if ((event.key === "Escape" || event.key === "Enter") && !event.isComposing) event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (event.key !== "Tab" || blocked) return;
    const dialog = document.querySelector<HTMLDialogElement>("dialog[open]");
    if (!dialog) return;
    const nodes = [...dialog.querySelectorAll<HTMLElement>(focusable)].filter(available);
    const first = nodes[0], last = nodes.at(-1), active = document.activeElement;
    if (!first) { event.preventDefault(); dialog.focus(); }
    else if (event.shiftKey && (active === first || active === dialog || !dialog.contains(active))) { event.preventDefault(); last!.focus(); }
    else if (!event.shiftKey && (active === last || active === dialog || !dialog.contains(active))) { event.preventDefault(); first.focus(); }
  }, true);
  for (const type of ["cancel", "submit"]) document.addEventListener(type, event => {
    if (composition.blocked() && !(event instanceof SubmitEvent && event.submitter === pointerSubmit && pointerSubmit)) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
}
export function setupMenu(menu: HTMLElement) {
  let source = focusHandle(null);
  const items = () => [...menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')].filter(available);
  const select = (button: HTMLButtonElement) => { for (const item of items()) item.tabIndex = item === button ? 0 : -1; button.focus(); };
  const close = (restore = true) => {
    if (menu.hidden) return;
    menu.hidden = true;
    source()?.setAttribute("aria-expanded", "false");
    if (restore) restoreFocus(source);
  };
  menu.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === "Tab") { close(); return; }
    const rows = items(), index = menuIndex(event.key, rows.indexOf(document.activeElement as HTMLButtonElement), rows.length);
    if (index !== null) { event.preventDefault(); select(rows[index]!); }
  });
  document.addEventListener("click", event => { if (!menu.contains(event.target as Node)) close(false); });
  document.addEventListener("focusin", event => { if (!menu.hidden && !menu.contains(event.target as Node) && event.target !== source()) close(false); });
  return {
    source: () => source,
    close,
    open(button: HTMLButtonElement, x: number, y: number) {
      close(false); source = focusHandle(button); button.setAttribute("aria-expanded", "true"); menu.hidden = false;
      menu.style.left = Math.max(0, Math.min(x, innerWidth - menu.offsetWidth)) + "px";
      menu.style.top = Math.max(0, Math.min(y, innerHeight - menu.offsetHeight)) + "px";
      const first = items()[0]; if (first) select(first);
    },
  };
}
