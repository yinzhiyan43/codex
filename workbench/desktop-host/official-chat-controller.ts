import { SessionStore } from "./session-store.ts";
import { FullTurnsWindow } from "../domain/full-turns-window.ts";
import type { WorkbenchClient } from "./client.ts";
import { HostOperationError } from "./client.ts";
import { HistoryBrowser } from "./history-browser.ts";
import { CoreController } from "./core-controller.ts";
import { validateDesktopCommand } from "./ipc-contract.ts";
import type { DesktopView, DemoMessage } from "./demo-controller.ts";
const historyNotice = "只显示当前临时会话；临时会话只核对元数据，正文保留已观察缓存。持久历史请打开历史会话；不使用 items 分页。";
type Phase = "disconnecting" | "connecting" | "idle" | "starting" | "running" | "cancelling" | "reading" | "restoring" | "managing" | "unknown";
/** Durable official conversations; restart reads history and never replays model turns. */
export class OfficialChatController {
  #store: SessionStore; #persistenceReady = false; #currentWindow: FullTurnsWindow | null = null; #resumeNeeded = false; #legacyId: string | null = null; #asyncReads = 0; #archiveBlockedId: string | null = null;
  #browser: HistoryBrowser; #browserUnsubscribe: () => void; #browsing = false;
  #client: WorkbenchClient; #core: CoreController; #cwd: string; #offline: boolean;
  #unsubscribe: () => void; #listeners = new Set<() => void>(); #disposed = false; #version = 0; #intent = 0;
  #phase: Phase = "idle"; #model: string | null = null; #thread: string | null = null; #generation = 0;
  #turn: string | null = null; #cancelWanted = false; #interruptSent = false; #interruptAcknowledged = false; #guarded = false;
  #draft = ""; #pending: string | null = null; #submitted = ""; #error: string | null = null; #cached: DemoMessage[] = []; #cachedId: string | null = null;
  #prompts = new Map<string, string>(); #created = 0; #cancelTimer: ReturnType<typeof setTimeout> | null = null; #cancelTimeout: number;
  constructor(client: WorkbenchClient, cwd: string, offline = false, cancelTimeoutMs = 15000, store = new SessionStore()) {
    if (!Number.isSafeInteger(cancelTimeoutMs) || cancelTimeoutMs < 1 || cancelTimeoutMs > 60000) throw new Error("invalid-cancel-timeout"); this.#cancelTimeout = cancelTimeoutMs;
    this.#store = store; this.#client = client; this.#cwd = cwd; this.#offline = offline; this.#core = new CoreController(client, true);
    this.#browser = new HistoryBrowser(client); this.#browserUnsubscribe = this.#browser.subscribe(() => this.#publish());
    this.#unsubscribe = this.#core.subscribe(() => { this.#sync(); this.#publish(); });
  }
  subscribe(listener: () => void): () => void { if (this.#disposed || this.#listeners.size >= 16) throw new Error("controller-unavailable"); this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  #publish(): void { this.#version++; if (!this.#disposed) for (const listener of this.#listeners) { try { listener(); } catch {} } }
  #messages(): DemoMessage[] {
    const host = this.#client.getView();
    if (!this.#thread || host.generation !== this.#generation) return [...this.#cached.map(message => ({ ...message, stale: true })), ...(this.#phase === "starting" && this.#submitted ? [{ id: "pending-user", role: "user" as const, text: this.#submitted }] : [])];
    const thread = host.threads.find(thread => thread.id === this.#thread);
    const messages: DemoMessage[] = [];
    for (const turn of thread?.turns ?? []) {
      const status = host.state !== "ready" && turn.status === "inProgress" ? "unknown" : turn.status === "inProgress" ? "running" : turn.status === "interrupted" ? "cancelled" : turn.status;
      if (!turn.items.some(item => item.value?.type === "userMessage") && this.#prompts.has(turn.id)) messages.push({ id: turn.id + ":prompt", role: "user", text: this.#prompts.get(turn.id)! });
      for (const item of turn.items) {
        if (item.value?.type === "userMessage") messages.push({ id: JSON.stringify([this.#thread,turn.id,item.id]), role: "user", text: item.value.content.filter(value => value.type === "text").map(value => value.text).join("\n"), stale: thread?.stale });
        else if (item.value?.type === "agentMessage" || (!item.value && item.text)) messages.push({ id: JSON.stringify([this.#thread,turn.id,item.id]), role: "assistant", text: item.text, status, stale: turn.stale || host.state !== "ready" });
      }
      if (!turn.items.some(item => item.value?.type === "agentMessage" || (!item.value && item.text))) messages.push({ id: turn.id+":waiting", role: "assistant", text: status === "running" ? "等待官方模型回应…" : status === "unknown" ? "连接已断开，执行结果未知。" : status === "failed" ? "官方模型未完成本次请求。" : status === "cancelled" ? "官方核心已确认中断。" : "本轮已结束，没有文本输出。", status });
    }
    if (this.#phase === "starting" && !this.#turn && this.#submitted) messages.push({ id: "pending-user", role: "user", text: this.#submitted });
    const historical = this.#currentWindow?.snapshot().messages ?? [];
    const merged = new Map<string,DemoMessage>(historical.map(m=>[m.id,m]));
    for(const message of messages) if(!message.stale || !merged.has(message.id)) merged.set(message.id,message);
    return [...merged.values()];
  }
  #sync(): void {
    const host = this.#client.getView();
    if (host.state !== "ready") {
      if (["reading","restoring","managing"].includes(this.#phase)) this.#phase = "idle";
      this.#clearCancelTimer(); this.#guarded = false; this.#pending = null;
      if (["starting", "running", "cancelling"].includes(this.#phase)) { this.#phase = "unknown"; this.#error = "连接已断开，执行结果未知；不会自动重发。重连先核对同一持久记录与上一轮状态。"; }
      return;
    }
    if (this.#turn && host.generation === this.#generation) {
      const turn = host.threads.find(thread => thread.id === this.#thread)?.turns.find(turn => turn.id === this.#turn);
      if (turn && turn.status !== "inProgress") {
        if (turn.status === "failed") this.#error = "官方服务报告本轮失败，未自动重试。";
        this.#clearCancelTimer(); this.#phase = "idle"; this.#turn = null; this.#cancelWanted = false; this.#interruptSent = false; void this.#save().catch(()=>this.#storageFailed());
      }
    }
  }
  snapshot(): DesktopView {
    const base = this.#core.snapshot(), messages = this.#messages(), saved = this.#browser.snapshot();
    if (this.#browsing) return { ...base, managedSessions:this.#store.snapshot().sessions, persistenceNotice:"历史只读；选择继续聊后，下一次确认发送才恢复官方线程。", mode: "official-chat", version: this.#version,
      chatStatus: { phase: this.#phase, model: this.#model, offline: this.#offline, ready: this.#guarded && !this.#archiveBlockedId && !!this.#model && base.connection === "ready", interruptAcknowledged: false, canRefresh: !!saved.selectedId && !saved.loading && base.connection === "ready", historyMode: true },
      historyBrowser: saved, projects: [{ id: "official-history", name: "只读历史会话", threads: saved.rows.map(row => ({ id: row.id, title: row.title })) }], route: { projectId: "official-history", threadId: saved.selectedId }, title: saved.title,
      messages: saved.messages, draft: "", pending: null, running: false, loading: saved.loading || base.loading || this.#asyncReads>0 || this.#phase==="managing",
      error: this.#error ?? base.error, history: { turnCount: saved.turnCount, itemCount: saved.messages.length, hasMore: saved.moreTurns, busy: saved.loading, loading: saved.loading, stale: saved.stale, notice: saved.notice } };
    return { ...base, managedSessions:this.#store.snapshot().sessions, persistenceNotice:this.#legacyId ? "此前临时会话仅有观察缓存，不能恢复原上下文；发送会创建新的持久会话。" : "新会话默认由官方核心持久保存；重启保留记录与草稿，下一次确认发送才恢复线程。", mode: "official-chat", version: this.#version,
      chatStatus: { phase: this.#phase, model: this.#model, offline: this.#offline, ready: this.#guarded && !this.#archiveBlockedId && !!this.#model && base.connection === "ready", persistent:!this.#legacyId, resumePending:this.#resumeNeeded, interruptAcknowledged: this.#interruptAcknowledged, canRefresh: !!this.#thread && this.#generation === this.#client.getView().generation && this.#phase === "idle" && base.connection === "ready" },
      projects: [{ id: "official-chat", name: "官方持久会话", threads: this.#store.snapshot().sessions.filter(row=>!row.archived).sort((a,b)=>Number(b.pinned)-Number(a.pinned)).slice(0,200).map(row=>({id:row.id,title:(row.pinned?"📌 ":"")+(row.unread?"● ":"")+row.title})) }],
      route: { projectId: "official-chat", threadId: this.#thread ?? this.#legacyId }, title: this.#store.find(this.#thread??this.#legacyId??"")?.title ?? "官方持久会话", messages,
      draft: this.#draft, pending: this.#pending, running: ["starting", "running", "cancelling"].includes(this.#phase),
      loading: base.loading || ["reading","restoring","managing"].includes(this.#phase) || saved.inflight || this.#asyncReads>0, error: this.#error ?? base.error,
      history: { ...base.history, turnCount: new Set([...(this.#currentWindow?.snapshot().turnIds ?? []),...this.#prompts.keys()]).size, itemCount: messages.length, hasMore: this.#currentWindow?.hasMore() ?? false, notice: this.#legacyId ? historyNotice : "官方持久会话；正文使用完整轮次服务端分页，可刷新或继续聊。", stale: base.stale || !!this.#currentWindow?.snapshot().stale, loading: this.#phase === "reading", busy: this.#phase !== "idle" } };
  }
  #current(intent: number, generation: number): boolean { return !this.#disposed && intent === this.#intent && generation === this.#client.getView().generation && this.#client.getView().state === "ready"; }
  #clearCancelTimer(): void { if (this.#cancelTimer) clearTimeout(this.#cancelTimer); this.#cancelTimer = null; this.#interruptAcknowledged = false; }
  async #interrupt(): Promise<void> {
    if (!this.#turn || this.#interruptSent || !this.#thread || this.#phase === "idle") return;
    this.#interruptSent = true; this.#phase = "cancelling"; this.#publish();
    const intent = this.#intent, generation = this.#generation, turnId = this.#turn;
    this.#clearCancelTimer();
    this.#cancelTimer = setTimeout(() => {
      if (!this.#current(intent, generation) || this.#turn !== turnId || this.#phase !== "cancelling") return;
      this.#guarded = false; this.#phase = "unknown"; this.#error = "未收到官方中断终态，结果未知；连接已停止，不会自动重发。";
      void this.#client.stop().catch(() => { this.#error = "中断终态和连接退出均未确认，请关闭此窗口。"; this.#publish(); }); this.#publish();
    }, this.#cancelTimeout); this.#cancelTimer.unref();
    try { await this.#client.interruptTurn({ threadId: this.#thread, turnId: this.#turn }); if (this.#current(intent, generation) && this.#turn === turnId) this.#interruptAcknowledged = true; }
    catch (error) { if (this.#current(intent, generation) && this.#turn === turnId && this.#client.getView().threads.find(thread => thread.id === this.#thread)?.turns.find(turn => turn.id === turnId)?.status === "inProgress") { this.#guarded = false; this.#error = "中断请求未确认，执行结果未知；请断开连接，勿重复发送。"; this.#phase = "unknown"; await this.#client.stop(); } }
    this.#publish();
  }
  async #confirm(): Promise<void> {
    if (this.#browsing || this.#archiveBlockedId || (this.#browser.snapshot().inflight || this.#asyncReads>0) || !this.#pending || this.#phase !== "idle" || !this.#guarded || !this.#model) return;
    const text = this.#pending, model = this.#model; this.#pending = null; this.#submitted = text;
    this.#phase = "starting"; this.#cancelWanted = false; this.#interruptSent = false; this.#interruptAcknowledged = false; this.#error = null;
    const intent = ++this.#intent, generation = this.#client.getView().generation; this.#publish();
    try {
      await this.#client.checkModelConfiguration(); if (!this.#current(intent, generation)) return;
      const account = await this.#client.getAccount({ refreshToken: false }); if (!this.#current(intent, generation)) return;
      if (account.account?.type !== "chatgpt") throw new HostOperationError("core-chatgpt-login-required");
      if (this.#cancelWanted) { this.#phase = "idle"; return; }
      if (this.#thread && this.#resumeNeeded) {
        const metadata = await this.#client.readThreadMetadata({threadId:this.#thread}); if(!this.#current(intent,generation))return;
        if(metadata.thread.ephemeral || metadata.thread.modelProvider!=="openai" || !["idle","notLoaded"].includes(metadata.thread.status.type)) throw new HostOperationError("session-not-safe-to-resume");
        const resumed = await this.#client.resumeThread({threadId:this.#thread,model,modelProvider:"openai",cwd:this.#cwd,approvalPolicy:"never",sandbox:"read-only",excludeTurns:true,baseInstructions:"You are a text-only chat assistant. Do not use tools or access files.",developerInstructions:"Only provide text. Never call tools, inspect credentials, or external services."});
        if(!this.#current(intent,generation))return;if(resumed.thread.id!==this.#thread)throw new HostOperationError("resume-thread-mismatch");this.#generation=generation;this.#resumeNeeded=false;
      }
      if (!this.#thread) {
        if (this.#created >= 8) throw new HostOperationError("chat-session-limit");
        const started = await this.#client.startThread({ model, modelProvider: "openai", cwd: this.#cwd, approvalPolicy: "never", sandbox: "read-only", ephemeral: false,
          baseInstructions: "You are a text-only chat assistant. Answer the user's message. Do not use tools, inspect files, or access projects.", developerInstructions: "Only provide text responses. Never call any tool or access files, credentials or external services." });
        if (!this.#current(intent, generation)) return;
        this.#thread = started.thread.id; this.#generation = generation; this.#created++; this.#cached = []; this.#legacyId=null; this.#currentWindow=null; this.#resumeNeeded=false; this.#prompts.clear(); await this.#save();
      }
      if (!this.#current(intent,generation)) return;
      if (this.#cancelWanted) { this.#phase = "idle"; return; }
      if (this.#prompts.size >= 64) throw new HostOperationError("chat-turn-limit");
      const response = await this.#client.startTurn({ threadId: this.#thread, model, input: [{ type: "text", text, text_elements: [] }], approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false } });
      if (!this.#current(intent, generation)) return;
      this.#turn = response.turn.id; this.#prompts.set(response.turn.id, text); this.#submitted = "";
      if (this.#draft.trim() === text) this.#draft = "";
      this.#phase = "running"; this.#sync();
      if (this.#cancelWanted) await this.#interrupt();
    } catch (error) {
      if (this.#current(intent, generation)) {
        const unknown = error instanceof HostOperationError && error.outcome === "unknown";
        this.#guarded = false;
        this.#phase = unknown ? "unknown" : "idle"; this.#error = unknown ? "请求结果未知；不会自动重发，需重连核对持久记录与上一轮状态。" : "消息未发送完成，请检查连接、账户或配置后再试。";
        if (unknown) await this.#client.stop();
      }
    } finally { if (intent === this.#intent) this.#submitted = ""; this.#publish(); }
  }
  #storageFailed(): void {this.#guarded=false;this.#error="会话元数据保存失败，发送已禁用；官方记录未删除。";this.#publish();}
  async #flushStore(): Promise<void> {try{await this.#store.flush();}catch(error){this.#storageFailed();throw error;}}
  async #save(): Promise<void> {
    if(!this.#persistenceReady)return;
    try { const id=this.#thread??this.#legacyId;
    if(id){this.#store.freshDraft("");this.#store.upsert(id,{draft:this.#draft,model:this.#model,ephemeral:!!this.#legacyId});this.#store.select(id);if(this.#legacyId)this.#store.preserveTemporary(id,this.#cached);}
    else{this.#store.select(null);this.#store.freshDraft(this.#draft);}
    await this.#flushStore(); } catch(error) {this.#storageFailed();throw error;}
  }
  async #rememberRows(): Promise<void> {try{for(const row of this.#browser.snapshot().rows)if(this.#store.find(row.id)){const archived=this.#browser.snapshot().archived;this.#store.upsert(row.id,{title:row.title,archived,ephemeral:false});}await this.#flushStore();}catch(error){this.#storageFailed();throw error;}}
  #known(id:string): boolean {return this.#store.find(id)!==undefined||this.#browser.snapshot().rows.some(row=>row.id===id)||id===this.#thread;}
  async #activateSaved(id:string, startup=false): Promise<void> {
    if(!this.#known(id))throw new Error("unknown-managed-session");
    if(!["idle","restoring"].includes(this.#phase)||this.#pending||this.#browser.snapshot().inflight||this.#asyncReads>=4||!this.#guarded)throw new Error("session-switch-busy");
    const record=this.#store.find(id);if(record?.archiveUncertain){if(!startup){await this.#save();throw new Error("archive-outcome-unresolved");}this.#archiveBlockedId=id;this.#thread=id;this.#generation=this.#client.getView().generation;this.#currentWindow=null;this.#prompts.clear();this.#legacyId=null;if(this.#cachedId!==id)this.#cached=[];this.#resumeNeeded=true;this.#draft=record.draft;this.#browsing=false;this.#error="归档结果待核实；请显式恢复归档后再选择继续聊，当前不能发送。";return;}if(record?.archived)throw new Error("archived-session-read-only");
    if(!startup)await this.#save();
    if(record?.ephemeral){this.#legacyId=id;this.#thread=null;this.#currentWindow=null;this.#cached=this.#store.snapshot().temporary?.id===id?this.#store.snapshot().temporary!.messages:[];this.#draft=record.draft;this.#browsing=false;await this.#save();return;}
    const intent=++this.#intent,generation=this.#client.getView().generation;this.#phase="restoring";this.#asyncReads++;this.#publish();
    try{
      const metadata=await this.#client.readThreadMetadata({threadId:id});if(!this.#current(intent,generation))return;
      if(metadata.thread.ephemeral||metadata.thread.modelProvider!=="openai"||!["idle","notLoaded"].includes(metadata.thread.status.type))throw new Error("session-not-safe-to-resume");
      const page=await this.#client.listTurns({threadId:id,limit:20,sortDirection:"desc",itemsView:"full"});if(!this.#current(intent,generation))return;
      if(page.data.some(turn=>turn.status==="inProgress"))throw new Error("unresolved-persisted-turn");const window=new FullTurnsWindow(id);window.commit(page,null);this.#currentWindow=window;this.#thread=id;this.#archiveBlockedId=null;this.#legacyId=null;this.#generation=generation;this.#resumeNeeded=true;this.#cached=[];this.#prompts.clear();this.#draft=record?.draft??"";
      if(record?.model&&this.#core.snapshot().coreStatus?.models.includes(record.model))this.#model=record.model;
      this.#store.upsert(id,{title:(metadata.thread.name??metadata.thread.preview??"持久会话").replace(/\s+/g," ").slice(0,100),unread:false,ephemeral:false});this.#browsing=false;this.#browser.cancel();this.#error=null;await this.#save();
    }catch{if(this.#current(intent,generation)){this.#error="持久记录读取未完成，已保留原聊天与草稿；未恢复执行或重发。";if(startup&&record)this.#draft=record.draft;}}
    finally{this.#asyncReads--;if(intent===this.#intent)this.#phase="idle";this.#publish();}
  }
  async #readCurrent(refresh:boolean): Promise<void> {
    if(!this.#thread||this.#generation!==this.#client.getView().generation||this.#phase!=="idle"||this.#browser.snapshot().inflight)throw new Error("history-unavailable");
    const intent=++this.#intent,generation=this.#generation,id=this.#thread;this.#phase="reading";this.#asyncReads++;this.#publish();
    try{await this.#client.readThreadMetadata({threadId:id});if(!this.#current(intent,generation))return;
      let window=this.#currentWindow;if(!window){window=new FullTurnsWindow(id);this.#currentWindow=window;}if(refresh||!window.hasMore())window.restart();const cursor=window.cursor();const page=await this.#client.listTurns({threadId:id,cursor,limit:20,sortDirection:"desc",itemsView:"full"});if(this.#current(intent,generation))window.commit(page,cursor);
    }catch{if(this.#current(intent,generation))this.#error="当前记录读取未完成，缓存保留；长轮次可能超过返回或展示上限。";}
    finally{this.#asyncReads--;if(intent===this.#intent)this.#phase="idle";this.#publish();}
  }
  async #manage(command: {type:string;id:string;name?:string}): Promise<void> {
    if(!this.#known(command.id)||this.#phase!=="idle"||this.#pending||this.#browser.snapshot().inflight||this.#asyncReads>0)throw new Error("session-management-unavailable");
    const existing=this.#store.find(command.id);if(existing?.archiveUncertain&&!["unarchiveSession","pinSession","unreadSession"].includes(command.type))throw new Error("archive-outcome-unresolved");const catalogTitle=this.#browser.snapshot().rows.find(row=>row.id===command.id)?.title;if(command.type==="renameSession"&&(existing?.archived||(this.#browser.snapshot().archived&&this.#browser.snapshot().rows.some(row=>row.id===command.id))))throw new Error("restore-before-rename");if(command.type==="pinSession"||command.type==="unreadSession"){this.#store.upsert(command.id,{title:existing?.title??catalogTitle??"持久会话",[command.type==="pinSession"?"pinned":"unread"]:!(command.type==="pinSession"?existing?.pinned:existing?.unread)});await this.#flushStore();return;}
    if(this.#client.getView().state!=="ready"||!this.#guarded||existing?.ephemeral)throw new Error("official-management-unavailable");
    const intent=++this.#intent,generation=this.#client.getView().generation;this.#phase="managing";this.#publish();
    try{
      if(command.type!=="unarchiveSession"){const meta=await this.#client.readThreadMetadata({threadId:command.id});if(!this.#current(intent,generation))return;if(meta.thread.ephemeral||!["idle","notLoaded"].includes(meta.thread.status.type))throw new Error("active-session-management-refused");}
      if(command.type==="renameSession")await this.#client.renameThread({threadId:command.id,name:command.name!.trim()});
      else if(command.type==="archiveSession")await this.#client.archiveThread({threadId:command.id});
      else await this.#client.unarchiveThread({threadId:command.id});
      if(!this.#current(intent,generation))return;
      if(command.type==="renameSession")this.#store.upsert(command.id,{title:command.name!.trim()});else this.#store.upsert(command.id,{title:existing?.title??catalogTitle??"持久会话",archived:command.type==="archiveSession",archiveUncertain:false});if(this.#archiveBlockedId===command.id)this.#archiveBlockedId=null;
      if(command.type==="archiveSession"&&this.#thread===command.id){this.#thread=null;this.#currentWindow=null;this.#resumeNeeded=false;this.#cached=[];this.#draft="";this.#store.select(null);}
      await this.#flushStore();if(this.#browsing){if(command.type==="renameSession")await this.#browser.list(true);else await this.#browser.setArchived(this.#browser.snapshot().archived);await this.#rememberRows();}
    }catch{if(!this.#disposed&&intent===this.#intent){if(command.type==="archiveSession"){if(this.#thread===command.id)this.#archiveBlockedId=command.id;this.#store.upsert(command.id,{archiveUncertain:true});try{await this.#flushStore();}catch{}}this.#error="会话操作未确认；不会自动重试，请刷新列表核对。";}}
    finally{if(intent===this.#intent)this.#phase="idle";this.#publish();}
  }
  async dispatch(value: unknown): Promise<DesktopView> {
    if (this.#disposed) throw new Error("controller-unavailable"); const command = validateDesktopCommand(value);
    if (this.#browsing && ["draft", "submit", "confirm", "selectModel", "cancel"].includes(command.type)) throw new Error("saved-history-read-only");
    switch (command.type) {
      case "continueSession": if(this.#browsing && this.#browser.snapshot().archived)throw new Error("archived-session-read-only"); await this.#activateSaved(command.id); break;
      case "pinSession": case "unreadSession": case "renameSession": case "archiveSession": case "unarchiveSession": await this.#manage(command); break;
      case "forkSession": throw new Error("fork-menu-submenu-not-yet-verified");
      case "toggleArchived": if(!this.#browsing)throw new Error("history-view-required"); await this.#browser.setArchived(!this.#browser.snapshot().archived); await this.#rememberRows(); break;
      case "browseHistory": {
        if (this.#phase !== "idle" || this.#pending || !this.#guarded || this.#client.getView().state !== "ready") throw new Error("history-unavailable");
        this.#browsing = true; this.#publish(); await this.#browser.list(true); await this.#rememberRows(); break;
      }
      case "returnToChat": this.#browser.cancel(); this.#browsing = false; break;
      case "refreshThreads": case "moreThreads": if (!this.#browsing) throw new Error("history-view-required"); await this.#browser.list(command.type === "refreshThreads"); await this.#rememberRows(); break;
      case "refreshHistory": if(!this.#browsing){await this.#readCurrent(true);break;} if (!this.#browsing || !this.#browser.snapshot().selectedId) throw new Error("history-view-required"); await this.#browser.select(this.#browser.snapshot().selectedId!, true); break;
      case "cancelHistory": if (!this.#browsing) throw new Error("history-view-required"); this.#browser.cancel(); break;
      case "connect": case "reconnect": {
        if (["disconnecting", "connecting", "starting", "running", "cancelling", "reading", "restoring", "managing"].includes(this.#phase)) throw new Error("chat-busy");
        const intent=++this.#intent;this.#phase="connecting";this.#guarded=false;this.#pending=null;
        try { await this.#store.load(); await this.#store.flush(); if(intent!==this.#intent||this.#disposed)break; this.#persistenceReady=true; } catch { if(intent===this.#intent&&!this.#disposed){this.#phase="idle";this.#error="工作台会话存储不可用，未覆盖旧文件，发送已禁用。";this.#guarded=false;}break;}
        const restoreId=this.#store.snapshot().lastId;
        this.#phase = "connecting"; this.#guarded = false; this.#cached = this.#messages(); this.#cachedId=this.#thread??this.#legacyId; this.#thread = null; this.#turn = null; this.#pending = null;
        await this.#core.dispatch(command);
        if (intent !== this.#intent || this.#disposed) break;
        const generation=this.#client.getView().generation;
        try { await this.#client.checkModelConfiguration(); if (!this.#current(intent,generation)) break; this.#guarded = true; this.#phase = "idle"; this.#error = null;
          const models = this.#core.snapshot().coreStatus!.models; if (!this.#model || !models.includes(this.#model)) this.#model = this.#core.snapshot().coreStatus!.defaultModel;
        } catch { if(intent===this.#intent&&!this.#disposed&&generation===this.#client.getView().generation){this.#phase = "idle"; this.#guarded=false;this.#error = "官方聊天配置尚未确认，发送已禁用。";} }
        if(!this.#current(intent,generation))break;
        if(this.#guarded&&restoreId)await this.#activateSaved(restoreId,true);else if(this.#guarded)this.#draft=this.#store.snapshot().freshDraft;
        break;
      }
      case "disconnect": {if(this.#phase==="disconnecting")throw new Error("chat-busy");const interrupted=["starting","running","cancelling"].includes(this.#phase),intent=++this.#intent;this.#guarded=false;this.#pending=null;this.#browser.cancel();this.#clearCancelTimer();this.#cached=this.#messages();this.#cachedId=this.#thread??this.#legacyId;this.#phase="disconnecting";this.#publish();try{await this.#core.dispatch(command);}finally{try{await this.#save();}catch{}if(intent===this.#intent&&!this.#disposed){this.#phase=interrupted?"unknown":"idle";if(interrupted&&!this.#error)this.#error="连接已断开，执行结果未知；不会自动重发。";}}break;}
      case "draft": if (command.routeId !== (this.#thread ?? this.#legacyId ?? "official-chat")) throw new Error("invalid-draft-route"); this.#draft = command.text; await this.#save(); break;
      case "selectModel": if (this.#phase !== "idle" || this.#pending || !this.#core.snapshot().coreStatus?.models.includes(command.model)) throw new Error("model-unavailable"); this.#model = command.model; await this.#save(); break;
      case "submit": if (!this.#archiveBlockedId && !this.#browser.snapshot().inflight && this.#asyncReads===0 && this.#phase === "idle" && !this.#pending && this.#guarded && this.#model && this.#client.getView().state === "ready" && this.#draft.trim()) this.#pending = this.#draft.trim(); break;
      case "confirm": await this.#confirm(); break;
      case "cancel": if (this.#pending) this.#pending = null; else if (["starting", "running", "cancelling"].includes(this.#phase)) { this.#cancelWanted = true; await this.#interrupt(); } break;
      case "new": if (!["idle", "unknown"].includes(this.#phase)) throw new Error("chat-busy"); await this.#save(); this.#archiveBlockedId=null; this.#legacyId=null;this.#currentWindow=null;this.#resumeNeeded=false; this.#browser.cancel(); this.#browsing = false; this.#intent++; this.#thread = null; this.#turn = null; this.#cached = []; this.#prompts.clear(); this.#draft = ""; this.#pending = null; this.#error = null; if (this.#guarded) this.#phase = "idle"; await this.#save(); break;
      case "thread": if (this.#browsing) await this.#browser.select(command.id, true); else if (command.id !== (this.#thread??this.#legacyId)) await this.#activateSaved(command.id); break;
      case "history": {
        if (this.#browsing) { if (command.threadId !== this.#browser.snapshot().selectedId) throw new Error("invalid-history-route"); await this.#browser.select(command.threadId, false); break; }
        if (command.threadId !== this.#thread || this.#generation !== this.#client.getView().generation || this.#phase !== "idle") throw new Error("history-unavailable");
        await this.#readCurrent(false); break;
      }
      case "clearError": this.#error = null; break;
      default: throw new Error("official-chat-command-unavailable");
    }
    this.#publish(); return this.snapshot();
  }
  async dispose(): Promise<void> { if (this.#disposed) return; this.#intent++; this.#disposed = true; this.#browserUnsubscribe(); this.#browser.dispose(); this.#clearCancelTimer(); this.#unsubscribe(); this.#listeners.clear(); try {if(this.#persistenceReady)await this.#save();}finally{await this.#core.dispose();} }
}
