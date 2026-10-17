import {runWorkflowSmoke} from "./workflow-smoke.ts";
import {runRepositorySmoke} from "./repository-smoke.ts";
import {repositoryActiveReads} from "../desktop-host/repository-reader.ts";
import {runEditableSmoke} from "./editable-smoke.ts";
import {randomBytes} from "node:crypto";
import {EditableWorkspace,type EditableSessionSurface} from "../desktop-host/editable-workspace.ts";
import { runKeyboardSmoke } from "./keyboard-smoke.ts";
import { runThemeSmoke } from "./theme-smoke.ts";
import { ThemeController,type SystemAppearance } from "../desktop-host/theme-controller.ts";
import { themeBackground,type ThemeMode } from "../desktop-host/theme-contract.ts";
import { runSearchSmoke } from "./search-smoke.ts";
import { runSettingsSmoke } from "./settings-smoke.ts";
import { UiPreferencesStore } from "../desktop-host/ui-preferences-store.ts";
import { runWindowSmoke } from "./window-smoke.ts";
import { SessionPreview, PreviewReadBudget } from "../desktop-host/session-preview.ts";
import { validateDesktopCommand } from "../desktop-host/ipc-contract.ts";
import { runCopySmoke } from "./copy-smoke.ts";
import { runEditingSmoke } from "./editing-smoke.ts";
import { runManagementSmoke } from "./management-smoke.ts";
import { runPersistenceSmoke } from "./persistence-smoke.ts";
import { SessionStore } from "../desktop-host/session-store.ts";
import { app, BrowserWindow, ipcMain, protocol, session, nativeImage, clipboard, nativeTheme, dialog } from "electron";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
const workflowIndex=process.argv.indexOf("--workflow-smoke"),workflowPhase=workflowIndex<0?null:process.argv[workflowIndex+1];
if(workflowIndex>=0&&(!offlineChat||!process.argv.includes("--smoke-output")||!process.argv.includes("--persistence-root")||!["write","restart","disconnect"].includes(workflowPhase??"")))throw new Error("workflow-smoke-is-offline-fixture-only");
const repositoryIndex=process.argv.indexOf("--repository-smoke"),repositoryPhase=repositoryIndex<0?null:process.argv[repositoryIndex+1];
if(repositoryIndex>=0&&(!offlineChat||!process.argv.includes("--smoke-output")||!process.argv.includes("--persistence-root")||!["write","restart"].includes(repositoryPhase??"")))throw new Error("repository-smoke-is-offline-fixture-only");
const editableIndex=process.argv.indexOf("--editable-smoke"),editablePhase=editableIndex<0?null:process.argv[editableIndex+1];
if(editableIndex>=0&&(!offlineChat||!process.argv.includes("--smoke-output")||!process.argv.includes("--persistence-root")||!["write","restart","failure","long","delivery","delivered"].includes(editablePhase??"")))throw new Error("editable-smoke-is-offline-fixture-only");
const keyboardSmoke=process.argv.includes("--keyboard-smoke");
if(keyboardSmoke&&(!offlineChat||!process.argv.includes("--smoke-output")))throw new Error("keyboard-smoke-is-offline-only");
const themeSmokeIndex=process.argv.indexOf("--theme-smoke"),themePhase=themeSmokeIndex<0?null:process.argv[themeSmokeIndex+1];
if(themeSmokeIndex>=0&&(!offlineChat||!process.argv.includes("--smoke-output")||!["write","restart","invalid","corrupt"].includes(themePhase??"")))throw new Error("theme-smoke-is-offline-only");
const searchSmoke=process.argv.includes("--search-smoke");
if(searchSmoke&&(!offlineChat||!process.argv.includes("--smoke-output")))throw new Error("search-smoke-is-offline-only");
const historySmoke = process.argv.includes("--history-smoke");
if (historySmoke && !offlineChat) throw new Error("history-smoke-requires-offline-mode");
const offlineFrames: OfflineFrame[] = [];
const chatMode = process.argv.includes("--official-chat") || offlineChat;
const durableProfile = chatMode && !offlineChat;
const profile = durableProfile ? join(app.getPath("appData"),"Codex Workbench") : mkdtempSync(join(tmpdir(),"codex-workbench-synthetic-"));
if(durableProfile){mkdirSync(profile,{recursive:true,mode:0o700});if(!app.requestSingleInstanceLock())app.exit(0);}
const settingsSmoke=process.argv.includes("--settings-smoke");if(settingsSmoke&&(!offlineChat||!process.argv.includes("--smoke-output")||!process.argv.includes("--persistence-smoke")))throw new Error("settings-smoke-is-offline-only");
const windowSmoke=process.argv.includes("--window-smoke");if(windowSmoke&&(!offlineChat||!process.argv.includes("--smoke-output")))throw new Error("window-smoke-is-offline-only");
const copySmoke=process.argv.includes("--copy-smoke");if(copySmoke&&(!offlineChat||!process.argv.includes("--smoke-output")))throw new Error("copy-smoke-is-offline-only");
const editingSmoke=process.argv.includes("--editing-smoke");if(editingSmoke&&(!offlineChat||!process.argv.includes("--smoke-output")))throw new Error("editing-smoke-is-offline-only");
const managementSmoke=process.argv.includes("--management-smoke");if(managementSmoke&&(!offlineChat||!process.argv.includes("--smoke-output")))throw new Error("management-smoke-is-offline-only");
const persistenceIndex=process.argv.indexOf("--persistence-root");
if(persistenceIndex>=0&&(!offlineChat||!process.argv.includes("--smoke-output")))throw new Error("persistence-fixture-is-offline-smoke-only");
const fixtureRoot=persistenceIndex>=0?process.argv[persistenceIndex+1]:null;
if(fixtureRoot&&(!fixtureRoot.startsWith("/")||fixtureRoot.includes("\0")))throw new Error("invalid-offline-fixture-root");
if(fixtureRoot)mkdirSync(fixtureRoot,{recursive:true,mode:0o700});
if(themePhase&&!fixtureRoot)throw new Error("theme-smoke-requires-private-fixture");
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
let controller: DemoController | CoreController | EditableWorkspace | null = null;
let closing = false;const copyProbe={writes:0,text:""};
const cleanupProfiles = () => { if(!durableProfile)rmSync(profile, { recursive: true, force: true }); if (isolatedDirectory) rmSync(isolatedDirectory, { recursive: true, force: true }); };
app.on("will-quit", cleanupProfiles);
const startupTimeout = setTimeout(() => { console.error("Desktop startup timed out"); app.exit(1); }, 15000);
void app.whenReady().then(async () => {
clearTimeout(startupTimeout);
const applicationIcon = nativeImage.createFromPath(join(directory, "workbench-icon.png"));
if (applicationIcon.isEmpty()) throw new Error("Selected application icon is unreadable");
app.dock?.setIcon(applicationIcon);
const assets = new Map([
  ["/tool-workflow.css",["tool-workflow.css","text/css; charset=utf-8"]],
  ["/repository.css",["repository.css","text/css; charset=utf-8"]],
  ["/theme.js",["theme.js","text/javascript; charset=utf-8"]],
  ["/theme.css",["theme.css","text/css; charset=utf-8"]],
  ["/preview.html", ["preview.html", "text/html; charset=utf-8"]],
  ["/preview.js", ["preview.js", "text/javascript; charset=utf-8"]],
  ["/preview.css", ["preview.css", "text/css; charset=utf-8"]],
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
  const child = spawn(process.execPath, [join(directory, "chat-peer.cjs"), workflowPhase?"workflow":repositoryPhase?"repository":editablePhase==="long"?"editable-long":(searchSmoke||keyboardSmoke)?"search-history":windowSmoke?"preview-history":copySmoke?"shared-management":historySmoke ? "slow-history" : "normal", join(stateRoot,"offline-core.json")], { cwd: directory, env: { ELECTRON_RUN_AS_NODE: "1" }, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  if (workflowPhase || repositoryPhase || editablePhase || keyboardSmoke || themePhase || searchSmoke || historySmoke || persistencePhase) {
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
const preferences = new UiPreferencesStore(join(stateRoot,"ui-preferences.json"));
let initialMode:ThemeMode="system";try{initialMode=(await preferences.read()).theme;}catch{/* Original preferences remain untouched; use system appearance until retry. */}
let simulatedDark=false;const systemObservers=new Set<()=>void>();
const appearance:SystemAppearance=themePhase?{isDark:()=>simulatedDark,subscribe:fn=>{systemObservers.add(fn);return()=>{systemObservers.delete(fn);};}}:{isDark:()=>nativeTheme.shouldUseDarkColors,subscribe:fn=>{nativeTheme.on("updated",fn);return()=>{nativeTheme.off("updated",fn);};}};
const themes=new ThemeController(initialMode,appearance);
const simulateAppearance=(dark:boolean)=>{if(!themePhase||typeof dark!=="boolean")throw new Error("theme-simulation-unavailable");simulatedDark=dark;for(const fn of systemObservers)fn();};
const host = new StdioWorkbenchHost(launch, { searchApi:chatMode, requestTimeoutMs: chatMode ? 30000 : 5000, shutdownGraceMs: 1000, closeTimeoutMs: 3000 });
controller = chatMode ? new EditableWorkspace(host.client(), chatCwd, offlineChat,new SessionStore(join(stateRoot,"sessions.json")),text=>{if(isSmoke){copyProbe.writes++;copyProbe.text=text;}else clipboard.writeText(text);},join(directory,"repository-reader")) : official ? new CoreController(host.client(), accountMode) : new DemoController(host.client());
const window = new BrowserWindow({ width: 1536, height: 894, minWidth: 900, minHeight: 650,
  icon: applicationIcon,
  backgroundColor: themeBackground(themes.snapshot().resolved), title: chatMode ? "Codex Workbench — " + (offlineChat ? "官方聊天协议离线验证" : "官方ChatGPT聊天") : official ? (accountMode ? "Codex Workbench — 官方核心原生账户状态" : "Codex Workbench — 官方核心隔离连接") : "Codex Workbench — 合成演示", titleBarStyle: "hiddenInset",
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
ipcMain.handle("workbench:preferences-read", async event => {
  verify(event); const release = budget.acquire();
  try { const value=await preferences.read();themes.setMode(value.theme);return value; } catch { throw new Error("ui-preferences-unavailable"); } finally { release(); }
});
ipcMain.handle("workbench:preferences-update", async (event, patch: unknown) => {
  verify(event); const release = budget.acquire();
  try { const value=await preferences.update(patch);themes.setMode(value.theme);return value; } catch { throw new Error("ui-preferences-update-failed"); } finally { release(); }
});
ipcMain.handle("workbench:snapshot", event => { verify(event); const release = budget.acquire(); try { return controller!.snapshot(); } finally { release(); } });
ipcMain.handle("workbench:command", async (event, value: unknown) => {
  verify(event); const release = budget.acquire();
  try { const command=validateDesktopCommand(value);if(command.type==="chooseDirectory")return await chooseDirectory("main",window);if(offlineChat&&isSmoke&&controller instanceof EditableWorkspace&&command.type==="draft"){const editor=controller.snapshot().editor!;return await controller.dispatch({type:"editDraft",routeId:command.routeId,text:command.text,revision:editor.revision,lease:editor.lease!});}if(command.type==="openSessionWindow"||command.type==="openSearchResult"){await openPreview(command.id,command.type==="openSearchResult");return controller!.snapshot();}return await controller!.dispatch(command); }
  catch { throw new Error("workbench-command-rejected"); }
  finally { release(); }
});
type PreviewEntry={window:BrowserWindow;controller:EditableSessionSurface;owner:string;allowClose:boolean;closePending:boolean;budget:IpcBudget;off:()=>void};
const previews=new Map<string,PreviewEntry>(),readBudget=new PreviewReadBudget(),previewAudit={opened:0,closed:0};
const themeBootstrap=(event:Electron.IpcMainEvent)=>{
  let release:(()=>void)|undefined;
  try{const preview=[...previews.values()].find(entry=>entry.window.webContents===event.sender),main=event.sender===window.webContents;
    validateDesktopSender({owner:main||!!preview,mainFrame:event.senderFrame===event.sender.mainFrame,url:event.senderFrame?.url??"",surface:main?"main":"preview"});
    release=(preview?.budget??budget).acquire();event.returnValue=themes.snapshot();
  }catch{event.returnValue=null;}finally{release?.();}
};
ipcMain.on("workbench:theme-bootstrap",themeBootstrap);
const broadcastTheme=()=>{const state=themes.snapshot();for(const pane of [window,...[...previews.values()].map(entry=>entry.window)]){if(!pane.isDestroyed()&&!pane.webContents.isDestroyed()){pane.setBackgroundColor(themeBackground(state.resolved));pane.webContents.send("workbench:theme",state);}}};
const offTheme=themes.subscribe(broadcastTheme);
const previewBinding=(event:Electron.IpcMainInvokeEvent)=>{const entry=[...previews.values()].find(row=>row.window.webContents===event.sender);if(!entry)throw new Error("untrusted-sender");validateDesktopSender({owner:true,mainFrame:event.senderFrame===entry.window.webContents.mainFrame,url:event.senderFrame?.url??"",surface:"preview"});return entry;};
ipcMain.handle("preview:snapshot",event=>{const entry=previewBinding(event),release=entry.budget.acquire();try{return entry.controller.snapshot();}finally{release();}});
ipcMain.handle("preview:command",async(event,value:unknown)=>{const entry=previewBinding(event),release=entry.budget.acquire();try{const command=validateDesktopCommand(value);if(command.type==="chooseDirectory")return await chooseDirectory(entry.owner,entry.window);return await entry.controller.dispatch(command);}catch{throw new Error("preview-command-rejected");}finally{release();}});
let directoryChoosing=false,repositoryPick:string|null|undefined,repositoryPickDone:(()=>void)|undefined;
const queueRepositoryPick=(path:string|null)=>{if(!repositoryPhase||!fixtureRoot||repositoryPick!==undefined||path!==null&&![join(fixtureRoot,"roots","a"),join(fixtureRoot,"roots","b"),join(fixtureRoot,"roots","a","nested")].includes(path))throw new Error("invalid-synthetic-picker");repositoryPick=path;return new Promise<void>(resolve=>{repositoryPickDone=resolve;});};
async function chooseDirectory(owner:string,pane:BrowserWindow){
 if(!(controller instanceof EditableWorkspace)||closing||directoryChoosing)throw new Error("directory-picker-unavailable");
 const workspace=controller,capture=workspace.captureDirectory(owner);directoryChoosing=true;
 try{const queued=repositoryPick;repositoryPick=undefined;if(repositoryPhase&&queued===undefined)throw new Error("synthetic-picker-empty");const picked=repositoryPhase?{canceled:queued===null,filePaths:queued?[queued]:[]}:await dialog.showOpenDialog(pane,{title:"选择会话工作目录（只读浏览）",properties:["openDirectory"]});if(picked.canceled||picked.filePaths.length!==1)return workspace.snapshotOwner(owner);return await workspace.selectDirectory(owner,capture,picked.filePaths[0]!);}
 catch(error){return workspace.directoryFailure(owner,capture,error instanceof Error?error.message:"");}
 finally{directoryChoosing=false;repositoryPickDone?.();repositoryPickDone=undefined;}
}
async function openPreview(id:string,fromSearch=false):Promise<void>{
  if(closing||!(controller instanceof EditableWorkspace))throw new Error("preview-unavailable");const source=fromSearch?controller.searchPreviewSource(id):controller.previewSource(id),existing=previews.get(id);if(existing&&!existing.window.isDestroyed()){if(!isSmoke){existing.window.show();existing.window.focus();}return;}
  if(previews.size>=4)throw new Error("preview-window-limit");
  const pane=new BrowserWindow({width:1040,height:760,minWidth:600,minHeight:420,show:false,icon:applicationIcon,backgroundColor:themeBackground(themes.snapshot().resolved),title:"Codex Workbench — 只读副窗口",titleBarStyle:"hiddenInset",webPreferences:{preload:join(directory,"preview-preload.cjs"),session:isolated,offscreen:isSmoke,backgroundThrottling:!isSmoke,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,webviewTag:false}});
  if(isSmoke)pane.webContents.setFrameRate(30);pane.webContents.setWindowOpenHandler(()=>({action:"deny"}));pane.webContents.on("will-navigate",event=>event.preventDefault());pane.webContents.on("will-attach-webview",event=>event.preventDefault());pane.webContents.on("console-message",details=>{if(details.level==="error")consoleErrors.push(details.message);});
  const owner="pane-"+pane.webContents.id,preview=controller.registerPreview(owner,source,readBudget),entry:PreviewEntry={window:pane,controller:preview,owner,allowClose:false,closePending:false,budget:new IpcBudget(),off:()=>{}};previews.set(id,entry);previewAudit.opened++;
  entry.off=preview.subscribe(()=>{if(!closing&&!pane.isDestroyed()&&!pane.webContents.isDestroyed())pane.webContents.send("preview:view",preview.snapshot());});
  pane.on("close",event=>{if(closing||entry.allowClose)return;event.preventDefault();if(entry.closePending)return;entry.closePending=true;void requestFlush(pane).then(()=>preview.close()).then(()=>{entry.allowClose=true;pane.close();}).catch(()=>{entry.closePending=false;if(!pane.isDestroyed())pane.webContents.send("workbench:close-failed");});});
  pane.once("closed",()=>{previewAudit.closed++;entry.off();if(!closing)preview.dispose();if(previews.get(id)===entry)previews.delete(id);});
  try{await pane.loadURL("workbench://app/preview.html");if(closing||pane.isDestroyed())return;void preview.dispatch({type:"refreshHistory"}).catch(()=>{});if(!isSmoke)pane.show();}
  catch(error){entry.off();preview.dispose();if(!pane.isDestroyed())pane.destroy();if(previews.get(id)===entry)previews.delete(id);throw error;}
}
let updateQueued = false;
const unsubscribe = controller.subscribe(() => {
  if(!closing){const rows=controller!.snapshot().managedSessions??[];for(const [id,entry]of previews){const row=rows.find(row=>row.id===id);if(row)entry.controller.sync({id,title:row.title,archived:row.archived,archiveUncertain:!!row.archiveUncertain});}}

  if (updateQueued) return; updateQueued = true;
  queueMicrotask(() => { updateQueued = false; if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send("workbench:view", controller!.snapshot()); });
});
type CloseRequest={nonce:string;promise:Promise<void>;resolve:()=>void;reject:()=>void;timer:ReturnType<typeof setTimeout>};
const closeRequests=new Map<number,CloseRequest>();
function requestFlush(pane:BrowserWindow):Promise<void>{
  if(pane.isDestroyed()||pane.webContents.isDestroyed())return Promise.resolve();const id=pane.webContents.id,existing=closeRequests.get(id);if(existing)return existing.promise;
  const nonce="close-"+randomBytes(16).toString("hex");let resolve!:()=>void,reject!:()=>void;const promise=new Promise<void>((yes,no)=>{resolve=yes;reject=()=>no(new Error("close-save-unconfirmed"));});
  const timer=setTimeout(()=>{closeRequests.delete(id);reject();},6000);closeRequests.set(id,{nonce,promise,resolve,reject,timer});pane.webContents.send("workbench:close-request",nonce);return promise;
}
ipcMain.handle("workbench:close-ready",async(event,value:unknown)=>{
  let release:(()=>void)|undefined;
  try{let owner="main";if(event.sender===window.webContents){verify(event);release=budget.acquire();}else{const entry=previewBinding(event);owner=entry.owner;release=entry.budget.acquire();}
    if(!value||typeof value!=="object"||Array.isArray(value))return false;const payload=value as {nonce:unknown;ok:unknown;proof:unknown};if(Object.keys(payload).sort().join(",")!=="nonce,ok,proof"||typeof payload.nonce!=="string"||typeof payload.ok!=="boolean")return false;
    const request=closeRequests.get(event.sender.id);if(!request||request.nonce!==payload.nonce)return false;
    try{if(!payload.ok)throw new Error("renderer-save-unconfirmed");if(controller instanceof EditableWorkspace)await controller.verifyClose(owner,payload.proof);else if(payload.proof!==null)throw new Error("unexpected-close-proof");clearTimeout(request.timer);closeRequests.delete(event.sender.id);request.resolve();return true;}
    catch{clearTimeout(request.timer);closeRequests.delete(event.sender.id);request.reject();return false;}
  }catch{return false;}finally{release?.();}
});
let preparingClose=false;
window.on("close",event=>{
  event.preventDefault();if(closing||preparingClose)return;preparingClose=true;
  void(async()=>{
    await Promise.all([requestFlush(window),...[...previews.values()].map(entry=>requestFlush(entry.window))]);
    if(controller instanceof EditableWorkspace)await controller.settled();
    closing=true;offTheme();themes.dispose();ipcMain.off("workbench:theme-bootstrap",themeBootstrap);
    unsubscribe();ipcMain.removeHandler("preview:snapshot");ipcMain.removeHandler("preview:command");for(const entry of previews.values()){entry.off();if(!entry.window.isDestroyed())entry.window.destroy();}previews.clear();ipcMain.removeHandler("workbench:command");ipcMain.removeHandler("workbench:snapshot");ipcMain.removeHandler("workbench:preferences-read");ipcMain.removeHandler("workbench:preferences-update");ipcMain.removeHandler("workbench:close-ready");
    await Promise.all([controller!.dispose(),preferences.settled()]);
    if(workflowPhase||repositoryPhase||windowSmoke||searchSmoke||themePhase||keyboardSmoke||editablePhase){const output=process.argv[process.argv.indexOf("--smoke-output")+1];if(output?.startsWith("/"))writeFileSync(join(output,"windows-close-results.json"),JSON.stringify({...previewAudit,activeWindows:previews.size,activeReads:readBudget.active(),repositoryReads:repositoryActiveReads(),coreActive:host.getView().processActive,coreState:host.getView().state})+"\n");}
    window.destroy();app.quit();
  })().catch(()=>{preparingClose=false;if(closing){console.error("Owned host shutdown failed");app.exit(1);return;}for(const pane of [window,...[...previews.values()].map(entry=>entry.window)])if(!pane.isDestroyed())pane.webContents.send("workbench:close-failed");});
});
await window.loadURL("workbench://app/index.html");
await controller.dispatch({ type: "connect" });
if (!isSmoke) window.show();
const smokeIndex = process.argv.indexOf("--smoke-output");
if (smokeIndex >= 0) {
  const output = process.argv[smokeIndex + 1];
  if (!output?.startsWith("/")) throw new Error("smoke-output-must-be-absolute");
  mkdirSync(output, { recursive: true });
  const externalHost=copySmoke?new StdioWorkbenchHost(launch,{requestTimeoutMs:5000}):null;
  const smokeTimeout = setTimeout(() => {console.error("Desktop smoke timed out");void Promise.allSettled([controller!.dispose(),externalHost?.dispose()]).finally(()=>app.exit(1));},30000);
  let smokeFailure:unknown=null;
  try {if(externalHost)await externalHost.start();await (workflowPhase ? runWorkflowSmoke(window,output,consoleErrors,workflowPhase as "write"|"restart"|"disconnect",()=>offlineFrames,()=>[...previews.values()].map(row=>row.window),join(stateRoot,"sessions.json")) : repositoryPhase ? runRepositorySmoke(window,output,consoleErrors,repositoryPhase as "write"|"restart",()=>offlineFrames,()=>[...previews.values()].map(row=>row.window),queueRepositoryPick,fixtureRoot!) : editablePhase ? runEditableSmoke(window,output,consoleErrors,editablePhase as "write"|"restart"|"failure"|"long"|"delivery"|"delivered",()=>offlineFrames,()=>[...previews.values()].map(row=>row.window),join(stateRoot,"sessions.json")) : keyboardSmoke ? runKeyboardSmoke(window,output,consoleErrors,()=>offlineFrames,()=>[...previews.values()].map(row=>row.window)) : themePhase ? runThemeSmoke(window,output,consoleErrors,themePhase as "write"|"restart"|"invalid"|"corrupt",()=>offlineFrames,()=>[...previews.values()].map(row=>row.window),simulateAppearance,join(stateRoot,"ui-preferences.json")) : searchSmoke ? runSearchSmoke(window,output,consoleErrors,()=>offlineFrames,()=>[...previews.values()].map(row=>row.window)) : settingsSmoke&&persistencePhase ? runSettingsSmoke(window,output,consoleErrors,persistencePhase as "write"|"restart",()=>offlineFrames,()=>[...previews.values()].map(row=>row.window),join(stateRoot,"ui-preferences.json")) : windowSmoke&&persistencePhase ? runWindowSmoke(window,output,consoleErrors,persistencePhase as "write"|"restart",()=>offlineFrames,()=>[...previews.values()].map(row=>row.window)) : copySmoke&&persistencePhase&&externalHost ? runCopySmoke(window,output,consoleErrors,persistencePhase as "write"|"restart",()=>offlineFrames,()=>({...copyProbe}),externalHost.client()) : editingSmoke&&persistencePhase ? runEditingSmoke(window,output,consoleErrors,persistencePhase as "write"|"restart",()=>offlineFrames) : managementSmoke&&persistencePhase ? runManagementSmoke(window,output,consoleErrors,persistencePhase as "write"|"restart",()=>offlineFrames) : persistencePhase ? runPersistenceSmoke(window,output,consoleErrors,persistencePhase as "write"|"restart",()=>offlineFrames) : historySmoke ? runHistorySmoke(window, output, consoleErrors, () => offlineFrames) : chatMode ? runChatSmoke(window, output, consoleErrors) : official ? runCoreSmoke(window, output, consoleErrors, process.argv.includes("--expected-core-failure"), accountMode) : runDesktopSmoke(window, output, consoleErrors, applicationIcon.getSize()));console.log("Desktop smoke passed");}
  catch(error){smokeFailure=error;}
  finally{clearTimeout(smokeTimeout);try{await externalHost?.dispose();}catch(error){smokeFailure??=error;}}
  if(smokeFailure){console.error(smokeFailure);await controller.dispose();cleanupProfiles();app.exit(1);}else window.close();

}
}).catch(error => { clearTimeout(startupTimeout); console.error(error); cleanupProfiles(); app.exit(1); });
