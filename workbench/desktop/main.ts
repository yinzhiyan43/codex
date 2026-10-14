import { app, BrowserWindow, ipcMain, protocol, session, nativeImage } from "electron";
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { StdioWorkbenchHost } from "../desktop-host/stdio-host.ts";
import { DemoController } from "../desktop-host/demo-controller.ts";
import { IpcBudget, validateDesktopSender } from "../desktop-host/ipc-contract.ts";
import { runDesktopSmoke } from "./smoke.ts";
const directory = dirname(fileURLToPath(import.meta.url));
const profile = mkdtempSync(join(tmpdir(), "codex-workbench-synthetic-"));
app.setPath("userData", profile); app.setName("Codex Workbench — 合成演示");
const isSmoke = process.argv.includes("--smoke-output");
if (isSmoke) { app.setActivationPolicy("accessory"); void app.dock?.hide(); }
protocol.registerSchemesAsPrivileged([{ scheme: "workbench", privileges: { standard: true, secure: true, supportFetchAPI: false } }]);
let controller: DemoController | null = null;
let closing = false;
app.on("will-quit", () => rmSync(profile, { recursive: true, force: true }));
const startupTimeout = setTimeout(() => { console.error("Desktop startup timed out"); app.exit(1); }, 15000);
void app.whenReady().then(async () => {
clearTimeout(startupTimeout);
const applicationIcon = nativeImage.createFromPath(join(directory, "workbench-icon.png"));
if (applicationIcon.isEmpty()) throw new Error("Selected application icon is unreadable");
app.dock?.setIcon(applicationIcon);
const assets = new Map([
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/renderer.js", ["renderer.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ["/icons.css", ["icons.css", "text/css; charset=utf-8"]],
  ["/Phosphor.woff2", ["Phosphor.woff2", "font/woff2"]],
]);
const isolated = session.fromPartition("workbench-synthetic");
isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
isolated.setPermissionCheckHandler(() => false);
isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith("workbench://app/") }));
isolated.protocol.handle("workbench", request => {
  const url = new URL(request.url); const asset = assets.get(url.pathname);
  if (url.hostname !== "app" || url.search || !asset) return new Response("Not found", { status: 404 });
  return new Response(readFileSync(join(directory, asset[0]!)), { headers: { "Content-Type": asset[1]! } });
});
const host = new StdioWorkbenchHost(() => spawn(process.execPath, [join(directory, "peer.cjs")], {
  cwd: directory, env: { ELECTRON_RUN_AS_NODE: "1" }, shell: false, stdio: ["pipe", "pipe", "pipe"],
}));
controller = new DemoController(host.client());
const window = new BrowserWindow({ width: 1536, height: 894, minWidth: 900, minHeight: 650,
  icon: applicationIcon,
  backgroundColor: "#181818", title: "Codex Workbench — 合成演示", titleBarStyle: "hiddenInset",
  trafficLightPosition: { x: 14, y: 12 }, show: false,
  webPreferences: { preload: join(directory, "preload.cjs"), session: isolated,
    offscreen: isSmoke, backgroundThrottling: !isSmoke,
    nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false },
});
if (isSmoke) window.webContents.setFrameRate(30);
const consoleErrors: string[] = [];
window.webContents.on("console-message", details => { if (details.level === "error") consoleErrors.push(details.message); });
window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
window.webContents.on("will-navigate", event => event.preventDefault());
window.webContents.on("will-attach-webview", event => event.preventDefault());
const budget = new IpcBudget();
const verify = (event: Electron.IpcMainInvokeEvent) => validateDesktopSender({
  owner: event.sender === window.webContents,
  mainFrame: event.senderFrame === window.webContents.mainFrame,
  url: event.senderFrame?.url ?? "",
});
ipcMain.handle("workbench:snapshot", event => { verify(event); const release = budget.acquire(); try { return controller!.snapshot(); } finally { release(); } });
ipcMain.handle("workbench:command", async (event, value: unknown) => {
  verify(event); const release = budget.acquire();
  try { return await controller!.dispatch(value); }
  catch { throw new Error("workbench-command-rejected"); }
  finally { release(); }
});
let updateQueued = false;
const unsubscribe = controller.subscribe(() => {
  if (updateQueued) return; updateQueued = true;
  queueMicrotask(() => { updateQueued = false; if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send("workbench:view", controller!.snapshot()); });
});
window.on("close", event => {
  if (closing) return; event.preventDefault(); closing = true;
  unsubscribe(); ipcMain.removeHandler("workbench:command"); ipcMain.removeHandler("workbench:snapshot");
  void controller!.dispose().then(() => { window.destroy(); app.quit(); }, () => { console.error("Owned host shutdown failed"); app.exit(1); });
});
await window.loadURL("workbench://app/index.html");
await controller.dispatch({ type: "connect" });
if (!isSmoke) window.show();
const smokeIndex = process.argv.indexOf("--smoke-output");
if (smokeIndex >= 0) {
  const output = process.argv[smokeIndex + 1];
  if (!output?.startsWith("/")) throw new Error("smoke-output-must-be-absolute");
  mkdirSync(output, { recursive: true });
  const smokeTimeout = setTimeout(() => { console.error("Desktop smoke timed out"); void controller!.dispose().finally(() => app.exit(1)); }, 30000);
  try { await runDesktopSmoke(window, output, consoleErrors, applicationIcon.getSize()); console.log("Desktop smoke passed"); window.close(); }
  catch (error) { console.error(error); await controller.dispose(); app.exit(1); }
  finally { clearTimeout(smokeTimeout); }
}
}).catch(error => { clearTimeout(startupTimeout); console.error(error); app.exit(1); });
