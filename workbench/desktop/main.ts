import { runPersistenceSmoke } from "./persistence-smoke.ts";
import { SessionStore } from "../desktop-host/session-store.ts";
import { app, BrowserWindow, ipcMain, protocol, session, nativeImage } from "electron";
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { StdioWorkbenchHost } from "../desktop-host/stdio-host.ts";
import { DemoController } from "../desktop-host/demo-controller.ts";
import { CoreController } from "../desktop-host/core-controller.ts";
import { prepareIsolatedCore, prepareOfficialAccountCore, prepareOfficialChatCore } from "../desktop-host/isolated-core.ts";
import { HostOperationError } from "../desktop-host/client.ts";
import { OfficialChatController } from "../desktop-host/official-chat-controller.ts";
import { runHistorySmoke, type OfflineFrame } from "./history-smoke.ts";
import { runChatSmoke } from "./chat-smoke.ts";
import { runCoreSmoke } from "./core-smoke.ts";
import { IpcBudget, validateDesktopSender } from "../desktop-host/ipc-contract.ts";
import { runDesktopSmoke } from "./smoke.ts";
const directory = dirname(fileURLToPath(import.meta.url));
const offlineChat = process.argv.includes("--official-chat-offline");
const historySmoke = process.argv.includes("--history-smoke");
if (historySmoke && !offlineChat) throw new Error("history-smoke-requires-offline-mode");
const offlineFrames: OfflineFrame[] = [];
const chatMode = process.argv.includes("--official-chat") || offlineChat;
const durableProfile = chatMode && !offlineChat;
const profile = durableProfile ? join(app.getPath("appData"),"Codex Workbench") : mkdtempSync(join(tmpdir(),"codex-workbench-synthetic-"));
if(durableProfile){mkdirSync(profile,{recursive:true,mode:0o700});if(!app.requestSingleInstanceLock())app.exit(0);}
const persistenceIndex=process.argv.indexOf("--persistence-root");
if(persistenceIndex>=0&&(!offlineChat||!process.argv.includes("--smoke-output")))throw new Error("persistence-fixture-is-offline-smoke-only");
const fixtureRoot=persistenceIndex>=0?process.argv[persistenceIndex+1]:null;
if(fixtureRoot&&(!fixtureRoot.startsWith("/")||fixtureRoot.includes("\0")))throw new Error("invalid-offline-fixture-root");
if(fixtureRoot)mkdirSync(fixtureRoot,{recursive:true,mode:0o700});
const stateRoot=fixtureRoot??profile;
const persistencePhaseIndex=process.argv.indexOf("--persistence-smoke"), persistencePhase=persistencePhaseIndex>=0?process.argv[persistencePhaseIndex+1]:null;
if(persistencePhase&&(!offlineChat||!fixtureRoot||!["write","restart"].includes(persistencePhase)||!process.argv.includes("--smoke-output")))throw new Error("persistent-smoke-is-offline-only");
app.setPath("userData", profile); app.setName(chatMode ? "Codex Workbench — " + (offlineChat ? "官方聊天协议离线验证" : "官方ChatGPT聊天") : process.argv.includes("--official-account") ? "Codex Workbench — 官方核心原生账户状态" : process.argv.includes("--official-core") ? "Codex Workbench — 官方核心隔离连接" : "Codex Workbench — 合成演示");
const accountMode = process.argv.includes("--official-account");
const official = process.argv.includes("--official-core") || accountMode || chatMode;
let chatCwd = "/synthetic/chat";
const isSmoke = process.argv.includes("--smoke-output");
if (chatMode && process.argv.includes("--core-binary")) throw new Error("official-chat-binary-is-fixed");
if (isSmoke && chatMode && !offlineChat) throw new Error("chat-smoke-requires-explicit-offline-mode");
let isolatedDirectory: string | null = null;
if (isSmoke) { app.setActivationPolicy("accessory"); void app.dock?.hide(); }
protocol.registerSchemesAsPrivileged([{ scheme: "workbench", privileges: { standard: true, secure: true, supportFetchAPI: false } }]);
let controller: DemoController | CoreController | OfficialChatController | null = null;
let closing = false;
const cleanupProfiles = () => { if(!durableProfile)rmSync(profile, { recursive: true, force: true }); if (isolatedDirectory) rmSync(isolatedDirectory, { recursive: true, force: true }); };
app.on("will-quit", cleanupProfiles);
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
let launch = () => spawn(process.execPath, [join(directory, "peer.cjs")], {
  cwd: directory, env: { ELECTRON_RUN_AS_NODE: "1" }, shell: false, stdio: ["pipe", "pipe", "pipe"],
});
if (offlineChat) launch = () => {
  const child = spawn(process.execPath, [join(directory, "chat-peer.cjs"), historySmoke ? "slow-history" : "normal", join(stateRoot,"offline-core.json")], { cwd: directory, env: { ELECTRON_RUN_AS_NODE: "1" }, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  if (historySmoke || persistencePhase) {
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = ((data: string | Uint8Array, ...args: unknown[]) => { for (const line of String(data).trim().split("\n")) { if (offlineFrames.length >= 512) throw new Error("offline-frame-budget"); offlineFrames.push(JSON.parse(line)); } return Reflect.apply(write, child.stdin, [data, ...args]); }) as typeof child.stdin.write;
  }
  return child;
};
if (official && !offlineChat) {
  try {
    const binaryIndex = process.argv.indexOf("--core-binary");
    const runs = join(dirname(directory), "tests", "real-core", ".runs");
    const prepared = chatMode ? await prepareOfficialChatCore(runs,join(profile,"core")) : await (accountMode ? prepareOfficialAccountCore : prepareIsolatedCore)(runs, binaryIndex < 0 ? undefined : process.argv[binaryIndex + 1]);
    isolatedDirectory = prepared.directory; launch = prepared.launcher; chatCwd = prepared.cwd;
  } catch (error) { const code = error instanceof Error && ["core-version-mismatch", "core-version-or-provenance-mismatch", "core-chatgpt-login-required"].includes(error.message) ? error.message : "core-preflight-failed"; launch = () => { throw new HostOperationError(code); }; }
}
const host = new StdioWorkbenchHost(launch, { requestTimeoutMs: chatMode ? 30000 : 5000, shutdownGraceMs: 1000, closeTimeoutMs: 3000 });
controller = chatMode ? new OfficialChatController(host.client(), chatCwd, offlineChat,15000,new SessionStore(join(stateRoot,"sessions.json"))) : official ? new CoreController(host.client(), accountMode) : new DemoController(host.client());
const window = new BrowserWindow({ width: 1536, height: 894, minWidth: 900, minHeight: 650,
  icon: applicationIcon,
  backgroundColor: "#181818", title: chatMode ? "Codex Workbench — " + (offlineChat ? "官方聊天协议离线验证" : "官方ChatGPT聊天") : official ? (accountMode ? "Codex Workbench — 官方核心原生账户状态" : "Codex Workbench — 官方核心隔离连接") : "Codex Workbench — 合成演示", titleBarStyle: "hiddenInset",
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
  try { await (persistencePhase ? runPersistenceSmoke(window,output,consoleErrors,persistencePhase as "write"|"restart",()=>offlineFrames) : historySmoke ? runHistorySmoke(window, output, consoleErrors, () => offlineFrames) : chatMode ? runChatSmoke(window, output, consoleErrors) : official ? runCoreSmoke(window, output, consoleErrors, process.argv.includes("--expected-core-failure"), accountMode) : runDesktopSmoke(window, output, consoleErrors, applicationIcon.getSize())); console.log("Desktop smoke passed"); window.close(); }
  catch (error) { console.error(error); await controller.dispose(); cleanupProfiles(); app.exit(1); }
  finally { clearTimeout(smokeTimeout); }
}
}).catch(error => { clearTimeout(startupTimeout); console.error(error); cleanupProfiles(); app.exit(1); });
