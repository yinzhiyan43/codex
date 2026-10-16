import {createCloseBridge} from "./close-preload.ts";
import { createThemeBridge } from "./theme-preload.ts";
import { contextBridge, ipcRenderer } from "electron";
import type { DesktopCommand } from "../desktop-host/ipc-contract.ts";
import type { DesktopView } from "../desktop-host/demo-controller.ts";
let subscribers = 0;
contextBridge.exposeInMainWorld("workbench", Object.freeze({
  theme:createThemeBridge(),
  close:createCloseBridge(),
  snapshot: (): Promise<DesktopView> => ipcRenderer.invoke("preview:snapshot"),
  dispatch: (command: DesktopCommand): Promise<DesktopView> => ipcRenderer.invoke("preview:command", command),
  subscribe: (listener: (value: DesktopView) => void): (() => void) => {
    if (typeof listener !== "function" || subscribers >= 8) throw new Error("invalid-subscriber");
    subscribers++; let removed = false;
    const handler = (_event: unknown, value: DesktopView) => { try { listener(value); } catch { /* Isolate renderer callbacks. */ } };
    ipcRenderer.on("preview:view", handler);
    return () => { if (!removed) { removed = true; subscribers--; ipcRenderer.off("preview:view", handler); } };
  },
}));
