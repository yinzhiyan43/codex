import { contextBridge, ipcRenderer } from "electron";
import type { DesktopCommand } from "../desktop-host/ipc-contract.ts";
import type { DesktopView } from "../desktop-host/demo-controller.ts";
import type { UiPreferences, UiPreferencesPatch } from "../desktop-host/ui-preferences-contract.ts";
let subscribers = 0;
contextBridge.exposeInMainWorld("workbench", Object.freeze({
  preferences: Object.freeze({
    read: (): Promise<UiPreferences> => ipcRenderer.invoke("workbench:preferences-read"),
    update: (patch: UiPreferencesPatch): Promise<UiPreferences> => ipcRenderer.invoke("workbench:preferences-update", patch),
  }),
  snapshot: (): Promise<DesktopView> => ipcRenderer.invoke("workbench:snapshot"),
  dispatch: (command: DesktopCommand): Promise<DesktopView> => ipcRenderer.invoke("workbench:command", command),
  subscribe: (listener: (value: DesktopView) => void): (() => void) => {
    if (typeof listener !== "function" || subscribers >= 8) throw new Error("invalid-subscriber");
    subscribers++; let removed = false;
    const handler = (_event: unknown, value: DesktopView) => { try { listener(value); } catch { /* Isolate renderer callbacks. */ } };
    ipcRenderer.on("workbench:view", handler);
    return () => { if (!removed) { removed = true; subscribers--; ipcRenderer.off("workbench:view", handler); } };
  },
}));
