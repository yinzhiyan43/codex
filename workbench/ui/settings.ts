// UI layout adapted from solrizon-ai/open-codex (Apache-2.0), commit 3362b6bb.
// Modified: plain DOM, workbench-only preferences, one modal, no core/config writes.
// See ../vendor/open-codex/NOTICE.md and LICENSE.
import { defaultUiPreferences, type UiPreferences, type UiPreferencesPatch } from "../desktop-host/ui-preferences-contract.ts";
export type PreferencesBridge = { read(): Promise<UiPreferences>; update(patch: UiPreferencesPatch): Promise<UiPreferences> };
export function setupSettings(bridge: PreferencesBridge, flushDraft: () => Promise<void>, sidebarChanged: () => void) {
  const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const dialog = el<HTMLDialogElement>("settings-dialog");
  const controls = ["pref-theme","pref-sidebar-visible", "pref-sidebar-width", "pref-density", "pref-font-size", "pref-expand-groups"];
  let preferences = defaultUiPreferences(), ready = false, busy = false, opener: HTMLElement | null = null;
  function refresh() {
    document.documentElement.style.setProperty("--sidebar-width", preferences.sidebarWidth + "px");
    document.documentElement.style.setProperty("--reading-size", preferences.fontSize + "px");
    document.documentElement.dataset.density = preferences.density;
    el("app").classList.toggle("sidebar-hidden", !preferences.sidebarVisible);
    el("toggle-sidebar").setAttribute("aria-expanded", String(preferences.sidebarVisible));
    el<HTMLSelectElement>("pref-theme").value = preferences.theme;
    el<HTMLInputElement>("pref-sidebar-visible").checked = preferences.sidebarVisible;
    el<HTMLSelectElement>("pref-sidebar-width").value = String(preferences.sidebarWidth);
    el<HTMLSelectElement>("pref-density").value = preferences.density;
    el<HTMLSelectElement>("pref-font-size").value = String(preferences.fontSize);
    for (const id of [...controls, "toggle-sidebar"]) el<HTMLButtonElement>(id).disabled = !ready || busy;
    el<HTMLButtonElement>("pref-expand-groups").disabled ||= preferences.collapsedGroups.length === 0;
    el("settings-dialog").setAttribute("aria-busy", String(busy));
    el<HTMLButtonElement>("preferences-retry").disabled = busy;
    sidebarChanged();
  }
  async function read() {
    if (busy) return;
    busy = true; refresh();
    el("preferences-status").textContent = "正在读取界面偏好…";
    try {
      preferences = await bridge.read(); ready = true;
      el("preferences-status").textContent = "界面偏好保存在此工作台，修改后自动保存。";
      el("preferences-retry").hidden = true;
    } catch {
      ready = false;
      el("preferences-status").textContent = "界面偏好读取失败。原文件保留；修复后可重新读取。";
      el("preferences-retry").hidden = false;
    } finally { busy = false; refresh(); }
  }
  async function update(patch: UiPreferencesPatch) {
    if (!ready || busy) return;
    const focused=document.activeElement as HTMLElement|null;
    busy = true; refresh();
    el("preferences-status").textContent = "正在保存…";
    try {
      preferences = await bridge.update(patch);
      el("preferences-status").textContent = "已保存界面偏好。";
    } catch { el("preferences-status").textContent = "保存失败，仍使用上次已保存的值；可再次尝试。"; }
    finally { busy = false; refresh();if(dialog.open&&focused&&controls.includes(focused.id)&&(document.activeElement===document.body||document.activeElement===dialog))focused.focus(); }
  }
  async function open(source: HTMLElement) {
    if (dialog.open) return;
    opener = source;
    await flushDraft();
    if (!dialog.open) dialog.showModal();
  }
  for (const id of ["open-settings", "open-settings-toolbar"]) el(id).addEventListener("click", event => void open(event.currentTarget as HTMLElement));
  el("settings-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => { if (opener && opener.getClientRects().length) opener.focus(); else el("open-settings-toolbar").focus(); });
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-settings-section]")) button.addEventListener("click", () => {
    for (const nav of document.querySelectorAll<HTMLButtonElement>("[data-settings-section]")) nav.setAttribute("aria-pressed", String(nav === button));
    for (const panel of document.querySelectorAll<HTMLElement>("[data-settings-panel]")) panel.hidden = panel.dataset.settingsPanel !== button.dataset.settingsSection;
  });
  el("preferences-retry").addEventListener("click", () => void read());
  el("pref-theme").addEventListener("change",()=>void update({theme:el<HTMLSelectElement>("pref-theme").value as UiPreferences["theme"]}));
  el("pref-sidebar-visible").addEventListener("change", () => void update({ sidebarVisible: el<HTMLInputElement>("pref-sidebar-visible").checked }));
  el("pref-sidebar-width").addEventListener("change", () => void update({ sidebarWidth: Number(el<HTMLSelectElement>("pref-sidebar-width").value) as UiPreferences["sidebarWidth"] }));
  el("pref-density").addEventListener("change", () => void update({ density: el<HTMLSelectElement>("pref-density").value as UiPreferences["density"] }));
  el("pref-font-size").addEventListener("change", () => void update({ fontSize: Number(el<HTMLSelectElement>("pref-font-size").value) as UiPreferences["fontSize"] }));
  el("pref-expand-groups").addEventListener("click", () => void update({ collapsedGroups: [] }));
  el("toggle-sidebar").addEventListener("click", () => void update({ sidebarVisible: !preferences.sidebarVisible }));
  void read();
  return {
    collapsed: (id: string) => preferences.collapsedGroups.includes(id),
    canUpdate: () => ready && !busy,
    toggleGroup: (id: string) => update({ collapsedGroups: preferences.collapsedGroups.includes(id) ? preferences.collapsedGroups.filter(key => key !== id) : [...preferences.collapsedGroups, id] }),
  };
}
