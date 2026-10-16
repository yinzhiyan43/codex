import { createHash, randomBytes } from "node:crypto";
import { sessionGroups } from "../domain/session-groups.ts";
import { SessionStore, type ManagedSession } from "./session-store.ts";
import { FullTurnsWindow } from "../domain/full-turns-window.ts";
import type { WorkbenchClient } from "./client.ts";
import { HostOperationError } from "./client.ts";
import { SessionSearch } from "./session-search.ts";
import { HistoryBrowser } from "./history-browser.ts";
import { CoreController } from "./core-controller.ts";
import { validateDesktopCommand } from "./ipc-contract.ts";
import type { DesktopView, DemoMessage } from "./demo-controller.ts";
const historyNotice = "只显示当前临时会话；临时会话只核对元数据，正文保留已观察缓存。持久历史请打开历史会话；不使用 items 分页。";
type Phase = "disconnecting" | "connecting" | "idle" | "starting" | "running" | "cancelling" | "reading" | "restoring" | "managing" | "unknown";
export type ChatRuntimeOptions={fixedThreadId?:string;persistSelection?:boolean;canWriteDraft?:(key:string)=>boolean};
/** Durable official conversations; restart reads history and never replays model turns. */
export class OfficialChatController {
  #deliveryResolved:string|null=null;
  #options:ChatRuntimeOptions;
  #copying=false;#copyCancelled=false;#copyText:((text:string)=>void)|null;#copyStatus:NonNullable<DesktopView["copyStatus"]>={state:"idle",notice:""};
  #sectionObservation:{id:string;sectionId:string|null;generation:number}|undefined;
  #sectionOrder:NonNullable<DesktopView["sectionOrder"]>|undefined;
  #forking=false; #forkCancelled=false; #sections: NonNullable<DesktopView["sessionSections"]>={status:"unknown",rows:[],notice:"官方分区尚未读取。",canCreate:false}; #sectionCreateBlockedGeneration:number|null=null;
  #store: SessionStore; #persistenceReady = false; #currentWindow: FullTurnsWindow | null = null; #resumeNeeded = false; #legacyId: string | null = null; #asyncReads = 0; #archiveBlockedId: string | null = null;
  #search:SessionSearch; #searchUnsubscribe:()=>void;
  #browser: HistoryBrowser; #browserUnsubscribe: () => void; #browsing = false;
  #client: WorkbenchClient; #core: CoreController; #cwd: string; #offline: boolean;
  #unsubscribe: () => void; #listeners = new Set<() => void>(); #disposed = false; #version = 0; #intent = 0;
  #phase: Phase = "idle"; #model: string | null = null; #thread: string | null = null; #generation = 0;
  #turn: string | null = null; #cancelWanted = false; #interruptSent = false; #interruptAcknowledged = false; #guarded = false;
  #draft = ""; #pending: string | null = null; #submitted = ""; #error: string | null = null; #cached: DemoMessage[] = []; #cachedId: string | null = null;
  #prompts = new Map<string, string>(); #created = 0; #cancelTimer: ReturnType<typeof setTimeout> | null = null; #cancelTimeout: number;
  constructor(client: WorkbenchClient, cwd: string, offline = false, cancelTimeoutMs = 15000, store = new SessionStore(),copyText:((text:string)=>void)|null=null,options:ChatRuntimeOptions={}) {
    this.#options=options;
    this.#copyText=copyText;
    if (!Number.isSafeInteger(cancelTimeoutMs) || cancelTimeoutMs < 1 || cancelTimeoutMs > 60000) throw new Error("invalid-cancel-timeout"); this.#cancelTimeout = cancelTimeoutMs;
    this.#store = store; this.#client = client; this.#cwd = cwd; this.#offline = offline; this.#core = new CoreController(client, true);
    this.#search=new SessionSearch(client);this.#searchUnsubscribe=this.#search.subscribe(()=>this.#publish());
    this.#browser = new HistoryBrowser(client); this.#browserUnsubscribe = this.#browser.subscribe(() => this.#publish());
    this.#unsubscribe = this.#core.subscribe(() => { this.#sync(); this.#publish(); });
  }
  subscribe(listener: () => void): () => void { if (this.#disposed || this.#listeners.size >= 16) throw new Error("controller-unavailable"); this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  #publish(): void { this.#browser?.setManaged(this.#store.snapshot().sessions.filter(row=>!!row.forkedFromId&&!row.ephemeral).map(row=>({id:row.id,title:row.title,archived:row.archived}))); this.#version++; if (!this.#disposed) for (const listener of this.#listeners) { try { listener(); } catch {} } }
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
      if(this.#sectionOrder)this.#sectionOrder.ready=false;
      if(this.#copying){this.#copyCancelled=true;this.#copying=false;this.#copyStatus={state:"cancelled",notice:"连接已断开，复制停止；未写入剪贴板。"};}if(this.#forking){this.#forkCancelled=true;this.#forking=false;}
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
    const base = this.#core.snapshot(), messages = this.#messages(), saved = this.#browser.snapshot(),groups=sessionGroups(this.#store.snapshot().sessions);
    if (this.#browsing) return { ...base, sessionSearch:this.#search.snapshot(), copyAvailable:!!this.#copyText,copyStatus:{...this.#copyStatus},sectionOrder:structuredClone(this.#sectionOrder), forkTurns:this.#phase==="idle"&&this.#guarded&&base.connection==="ready"?saved.forkTurns:[], sessionSections:structuredClone(this.#sections), managedSessions:this.#store.snapshot().sessions, persistenceNotice:"历史只读；选择继续聊后，下一次确认发送才恢复官方线程。", mode: "official-chat", version: this.#version,
      chatStatus: { canCancelManagement:this.#forking&&!this.#forkCancelled||this.#copying&&!this.#copyCancelled,managementAction:this.#copying?"copy":this.#forking?"fork":null, phase: this.#phase, model: this.#model, offline: this.#offline, ready: this.#guarded && !this.#archiveBlockedId && !!this.#model && base.connection === "ready", interruptAcknowledged: false, canRefresh: !!saved.selectedId && !saved.loading && base.connection === "ready", historyMode: true },
      historyBrowser: saved, projects: [{ id: "official-history", name: "只读历史会话", threads: saved.rows.map(row => ({ id: row.id, title: row.title })) },...(saved.managedRows.length?[{id:"registered-forks",name:"已登记分叉 · 本地索引",threads:saved.managedRows.map(row=>({id:row.id,title:row.title}))}]:[])], route: { projectId: "official-history", threadId: saved.selectedId }, title: saved.title,
      messages: saved.messages, draft: "", pending: null, running: false, loading: saved.loading || base.loading || this.#asyncReads>0 || this.#phase==="managing",
      error: this.#error ?? base.error, history: { turnCount: saved.turnCount, itemCount: saved.messages.length, hasMore: saved.moreTurns, busy: saved.loading, loading: saved.loading, stale: saved.stale, notice: saved.notice } };
    return { ...base, sessionSearch:this.#search.snapshot(), copyAvailable:!!this.#copyText,copyStatus:{...this.#copyStatus},sectionOrder:structuredClone(this.#sectionOrder), forkTurns:this.#phase==="idle"&&this.#guarded&&base.connection==="ready"?(this.#currentWindow?.snapshot().forkTurns??[]):[], sessionSections:structuredClone(this.#sections), managedSessions:this.#store.snapshot().sessions, persistenceNotice:this.#legacyId ? "此前临时会话仅有观察缓存，不能恢复原上下文；发送会创建新的持久会话。" : "新会话默认由官方核心持久保存；重启保留记录与草稿，下一次确认发送才恢复线程。", mode: "official-chat", version: this.#version,
      chatStatus: { canCancelManagement:this.#forking&&!this.#forkCancelled||this.#copying&&!this.#copyCancelled,managementAction:this.#copying?"copy":this.#forking?"fork":null, phase: this.#phase, model: this.#model, offline: this.#offline, ready: this.#guarded && !this.#archiveBlockedId && !!this.#model && base.connection === "ready", persistent:!this.#legacyId, resumePending:this.#resumeNeeded, interruptAcknowledged: this.#interruptAcknowledged, canRefresh: !!this.#thread && this.#generation === this.#client.getView().generation && this.#phase === "idle" && base.connection === "ready" },
      projects: groups,
      route: { projectId: groups.find(group=>group.threads.some(row=>row.id===(this.#thread??this.#legacyId)))?.id??"official-chat", threadId: this.#thread ?? this.#legacyId }, title: this.#store.find(this.#thread??this.#legacyId??"")?.title ?? "官方持久会话", messages,
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
    if (this.#store.snapshot().delivery || this.#browsing || this.#archiveBlockedId || (this.#browser.snapshot().inflight || this.#asyncReads>0) || !this.#pending || this.#phase !== "idle" || !this.#guarded || !this.#model) return;
    const text = this.#pending, model = this.#model; this.#pending = null; this.#submitted = text;
    this.#phase = "starting"; this.#cancelWanted = false; this.#interruptSent = false; this.#interruptAcknowledged = false; this.#error = null;
    const intent = ++this.#intent, generation = this.#client.getView().generation; this.#publish();
    let journalToken:string|null=null,requestSent=false,accepted=false;
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
      const before=await this.#client.listTurns({threadId:this.#thread,limit:20,sortDirection:"desc",itemsView:"full"});
      if(!this.#current(intent,generation))return;
      if(before.data.some(turn=>turn.status==="inProgress"))throw new HostOperationError("unresolved-persisted-turn");
      journalToken=randomBytes(16).toString("hex");
      await this.#mutate(()=>{if(this.#store.snapshot().delivery)throw new Error("unresolved-delivery");this.#store.pendingDelivery({token:journalToken!,key:this.#thread!,text,beforeTurnId:before.data[0]?.id??null});});
      if(!this.#current(intent,generation)||this.#cancelWanted){this.#deliveryResolved=journalToken;await this.#save();this.#phase="idle";return;}
      requestSent=true;
      const response = await this.#client.startTurn({ threadId: this.#thread, model, input: [{ type: "text", text, text_elements: [] }], approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false } });
      accepted=true;this.#deliveryResolved=journalToken;
      if (this.#draft.trim() === text) this.#draft = "";
      await this.#save();
      if (!this.#current(intent, generation)) return;
      this.#turn = response.turn.id; this.#prompts.set(response.turn.id, text); this.#submitted = "";
      if (this.#draft.trim() === text) this.#draft = "";
      this.#phase = "running"; this.#sync();
      if (this.#cancelWanted) await this.#interrupt();
    } catch (error) {
      const notSent=!requestSent||!accepted&&error instanceof HostOperationError&&error.outcome==="not-sent";
      if(journalToken&&notSent){this.#deliveryResolved=journalToken;try{await this.#save();}catch{}}
      if (this.#current(intent, generation)) {
        const unknown = !!this.#store.snapshot().delivery || accepted || error instanceof HostOperationError && error.outcome === "unknown";
        this.#guarded = false;
        this.#phase = unknown ? "unknown" : "idle"; this.#error = unknown ? "请求结果未知；不会自动重发，需重连核对持久记录与上一轮状态。" : "消息未发送完成，请检查连接、账户或配置后再试。";
        if (unknown) await this.#client.stop();
      }
    } finally { if (intent === this.#intent) this.#submitted = ""; this.#publish(); }
  }
  #storageFailed(): void {this.#guarded=false;this.#error="会话元数据保存失败，发送已禁用；官方记录未删除。";this.#publish();}
  async #mutate(edit:()=>void,retainOnFailure=false):Promise<void>{try{await this.#store.transaction(edit,retainOnFailure);}catch(error){this.#storageFailed();throw error;}}
  async #flushStore():Promise<void>{await this.#mutate(()=>{});}
  async #save(update:Partial<Omit<ManagedSession,"id">>={}):Promise<void>{
    if(!this.#persistenceReady)return;
    const resolved=this.#deliveryResolved;
    const id=this.#thread??this.#legacyId,draft=this.#draft,model=this.#model,legacy=!!this.#legacyId,cache=structuredClone(this.#cached);
    await this.#mutate(()=>{const writable=this.#options.canWriteDraft?.(id??"official-chat")??true,selection=this.#options.persistSelection!==false;if(id){if(selection&&writable)this.#store.freshDraft("");this.#store.upsert(id,{...update,...(writable?{draft,model}:{}),ephemeral:legacy});if(selection)this.#store.select(id);if(legacy)this.#store.preserveTemporary(id,cache);if(writable&&resolved&&this.#store.snapshot().delivery?.token===resolved)this.#store.pendingDelivery(null);}else if(selection){this.#store.select(null);if(writable)this.#store.freshDraft(draft);}});
  }
  async flushDraftState():Promise<void>{await this.#save();}
  syncDraftFromStore(key:string):void{if((this.#thread??this.#legacyId??"official-chat")===key){this.#draft=this.#store.confirmedDraft(key);this.#publish();}}
  async #rememberRows():Promise<void>{const {rows,archived}=this.#browser.snapshot();await this.#mutate(()=>{for(const row of rows)if(this.#store.find(row.id))this.#store.upsert(row.id,{title:row.title,archived,ephemeral:false});});}
  #known(id:string): boolean {return id===this.#options.fixedThreadId||this.#store.find(id)!==undefined||this.#browser.snapshot().rows.some(row=>row.id===id)||id===this.#thread;}
  async #activateSaved(id:string, startup=false, cancelled:()=>boolean=()=>false,beforeCommit:()=>void=()=>{}): Promise<void> {
    if(!this.#known(id))throw new Error("unknown-managed-session");
    if(!["idle","restoring"].includes(this.#phase)||this.#pending||this.#browser.snapshot().inflight||this.#asyncReads>=4||!this.#guarded)throw new Error("session-switch-busy");
    const record=this.#store.find(id);if(record?.archiveUncertain){if(!startup){await this.#save();throw new Error("archive-outcome-unresolved");}this.#archiveBlockedId=id;this.#thread=id;this.#generation=this.#client.getView().generation;this.#currentWindow=null;this.#prompts.clear();this.#legacyId=null;if(this.#cachedId!==id)this.#cached=[];this.#resumeNeeded=true;this.#draft=record.draft;this.#browsing=false;this.#error="归档结果待核实；请显式恢复归档后再选择继续聊，当前不能发送。";return;}if(record?.archived)throw new Error("archived-session-read-only");
    if(!startup)await this.#save();
    if(record?.ephemeral){this.#legacyId=id;this.#thread=null;this.#currentWindow=null;this.#cached=this.#store.snapshot().temporary?.id===id?this.#store.snapshot().temporary!.messages:[];this.#draft=record.draft;this.#browsing=false;await this.#save();return;}
    const intent=++this.#intent,generation=this.#client.getView().generation;this.#phase="restoring";this.#asyncReads++;this.#publish();
    try{
      const metadata=await this.#client.readThreadMetadata({threadId:id});if(!this.#current(intent,generation)||cancelled())return;
      if(metadata.thread.ephemeral||metadata.thread.modelProvider!=="openai"||!["idle","notLoaded"].includes(metadata.thread.status.type))throw new Error("session-not-safe-to-resume");
      const page=await this.#client.listTurns({threadId:id,limit:20,sortDirection:"desc",itemsView:"full"});if(!this.#current(intent,generation)||cancelled())return;
      if(page.data.some(turn=>turn.status==="inProgress"))throw new Error("unresolved-persisted-turn");beforeCommit();const window=new FullTurnsWindow(id);window.commit(page,null);this.#currentWindow=window;this.#thread=id;this.#archiveBlockedId=null;this.#legacyId=null;this.#generation=generation;this.#resumeNeeded=true;this.#cached=[];this.#prompts.clear();this.#draft=record?.draft??"";
      if(record?.model&&this.#core.snapshot().coreStatus?.models.includes(record.model))this.#model=record.model;
      this.#browsing=false;this.#browser.cancel();this.#error=null;await this.#save({title:(metadata.thread.name||record?.title||metadata.thread.preview||"持久会话").replace(/\s+/g," ").slice(0,100),unread:false,sectionPosition:(record?.sectionId??null)===(metadata.thread.section?.id??null)?record?.sectionPosition:undefined,sectionId:metadata.thread.section?.id??null,sectionName:metadata.thread.section?.name.replace(/[\x00-\x1f]/g," ").slice(0,200)??null});
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
    const existing=this.#store.find(command.id);if(existing?.archiveUncertain&&!["unarchiveSession","pinSession","unreadSession"].includes(command.type))throw new Error("archive-outcome-unresolved");const catalogTitle=this.#browser.snapshot().rows.find(row=>row.id===command.id)?.title;if(command.type==="renameSession"&&(existing?.archived||(this.#browser.snapshot().archived&&this.#browser.snapshot().rows.some(row=>row.id===command.id))))throw new Error("restore-before-rename");if(command.type==="pinSession"||command.type==="unreadSession"){await this.#mutate(()=>{const latest=this.#store.find(command.id);this.#store.upsert(command.id,{title:latest?.title??catalogTitle??"持久会话",[command.type==="pinSession"?"pinned":"unread"]:!(command.type==="pinSession"?latest?.pinned:latest?.unread)});});return;}
    if(this.#client.getView().state!=="ready"||!this.#guarded||existing?.ephemeral)throw new Error("official-management-unavailable");
    const intent=++this.#intent,generation=this.#client.getView().generation;this.#phase="managing";this.#publish();let requested=false;
    try{
      if(command.type!=="unarchiveSession"){const meta=await this.#client.readThreadMetadata({threadId:command.id});if(!this.#current(intent,generation))return;if(meta.thread.ephemeral||!["idle","notLoaded"].includes(meta.thread.status.type))throw new Error("active-session-management-refused");
        if(command.type==="renameSession"){const title=(meta.thread.name||meta.thread.preview||"持久会话").replace(/\s+/g," ").slice(0,100),observed=existing?.title??catalogTitle;if(observed!==undefined&&meta.thread.name!==null&&title!==observed)throw new Error("thread-name-conflict");}}
      requested=true;
      if(command.type==="renameSession")await this.#client.renameThread({threadId:command.id,name:command.name!.trim()});
      else if(command.type==="archiveSession")await this.#client.archiveThread({threadId:command.id});
      else await this.#client.unarchiveThread({threadId:command.id});
      if(!this.#current(intent,generation))return;
      if(command.type==="renameSession"){const verified=await this.#client.readThreadMetadata({threadId:command.id});if(!this.#current(intent,generation))return;if(verified.thread.name!==command.name!.trim())throw new Error("thread-name-conflict");}
      await this.#mutate(()=>{if(!this.#current(intent,generation))return;if(command.type==="renameSession")this.#store.upsert(command.id,{title:command.name!.trim()});else this.#store.upsert(command.id,{title:existing?.title??catalogTitle??"持久会话",archived:command.type==="archiveSession",archiveUncertain:false});});if(!this.#current(intent,generation))return;if(this.#archiveBlockedId===command.id)this.#archiveBlockedId=null;
      if(command.type==="archiveSession"&&this.#thread===command.id){this.#thread=null;this.#currentWindow=null;this.#resumeNeeded=false;this.#cached=[];this.#draft="";await this.#mutate(()=>this.#store.select(null));}
      await this.#flushStore();if(this.#browsing){if(command.type==="renameSession")await this.#browser.list(true);else await this.#browser.setArchived(this.#browser.snapshot().archived);await this.#rememberRows();}
    }catch{if(!this.#disposed&&intent===this.#intent){if(command.type==="archiveSession"){if(this.#thread===command.id)this.#archiveBlockedId=command.id;try{await this.#mutate(()=>this.#store.upsert(command.id,{archiveUncertain:true}),true);}catch{}}this.#error=command.type==="renameSession"&&!requested?"会话名称已变化或无法核对，未发送重命名；请刷新后重新选择。":"会话操作未确认；不会自动重试，请刷新列表核对。";}}
    finally{if(intent===this.#intent)this.#phase="idle";this.#publish();}
  }
  #managementAvailable(id?:string):void {
    if(this.#phase!=="idle"||this.#pending||this.#asyncReads||this.#browser.snapshot().inflight||!this.#guarded||this.#client.getView().state!=="ready"||(id&&!this.#known(id)))throw new Error("session-management-unavailable");
  }
  async #fork(id:string,lastTurnId?:string):Promise<void>{
    this.#managementAvailable(id);const source=this.#store.find(id);
    if(source?.ephemeral||source?.archived||source?.archiveUncertain||source?.forkUncertain||(this.#browsing&&this.#browser.snapshot().archived)||!this.#model)throw new Error("fork-source-unavailable");
    if(lastTurnId&&((this.#browsing?this.#browser.snapshot().selectedId:this.#thread)!==id||!this.snapshot().forkTurns?.some(turn=>turn.id===lastTurnId)))throw new Error("fork-boundary-unavailable");
    if(this.#store.snapshot().sessions.length>(source?511:510))throw new Error("session-store-capacity");
    const intent=++this.#intent,generation=this.#client.getView().generation,model=this.#model;
    this.#phase="managing";this.#forking=true;this.#forkCancelled=false;this.#error=null;this.#publish();let requested=false,acknowledged=false;
    const cancelled=()=>!this.#current(intent,generation)||this.#forkCancelled;
    try{
      await this.#save();if(cancelled())return;
      await this.#client.checkModelConfiguration();if(cancelled())return;
      const meta=await this.#client.readThreadMetadata({threadId:id});if(cancelled())return;
      if(meta.thread.ephemeral||meta.thread.modelProvider!=="openai"||!["idle","notLoaded"].includes(meta.thread.status.type))throw new Error("fork-source-active");
      if(lastTurnId){
        // Revalidate the actual saved page at this generation before the creating RPC.
        const verified=new FullTurnsWindow(id);let found=false;
        for(let n=0;n<64;n++){const cursor=verified.cursor();const page=await this.#client.listTurns({threadId:id,cursor,limit:20,sortDirection:"desc",itemsView:"full"});if(cancelled())return;verified.commit(page,cursor);if(page.data.some(turn=>turn.id===lastTurnId)){found=page.data.some(turn=>turn.id===lastTurnId&&turn.status!=="inProgress");break;}if(!verified.hasMore())break;}
        if(!found)throw new Error("fork-boundary-unavailable");
      }
      const title=(meta.thread.name||source?.title||meta.thread.preview||"持久会话").replace(/\s+/g," ").slice(0,100);
      await this.#mutate(()=>this.#store.upsert(id,{title,forkUncertain:true}));if(cancelled()){await this.#mutate(()=>this.#store.upsert(id,{forkUncertain:false}));return;}
      requested=true;
      const result=await this.#client.forkThread({threadId:id,...(lastTurnId?{lastTurnId}:{}),model,modelProvider:"openai",cwd:this.#cwd,approvalPolicy:"never",sandbox:"read-only",ephemeral:false,excludeTurns:true,baseInstructions:"You are a text-only chat assistant. Do not use tools or access files.",developerInstructions:"Only provide text. Never call tools or access files, credentials or external services."});
      acknowledged=true;const childId=result.thread.id;
      if(childId===id||result.thread.forkedFromId!==id||this.#store.find(childId))throw new Error("fork-identity-conflict");
      await this.#mutate(()=>{this.#store.upsert(childId,{title:(result.thread.name||title+" · 分叉").slice(0,100),model,localProject:source?.localProject??null,sectionId:result.thread.section?.id??null,sectionName:result.thread.section?.name.replace(/[\x00-\x1f]/g," ").slice(0,200)??null,forkedFromId:id});this.#store.upsert(id,{forkUncertain:false});},true);
      if(cancelled())return;
      this.#phase="idle";await this.#activateSaved(childId,true,()=>this.#forkCancelled,()=>{this.#forking=false;this.#publish();});
    }catch(error){
      if(this.#current(intent,generation)){this.#error=requested&&!acknowledged?"分叉结果未知，已保留源会话；禁止自动重试，请重连核对记录。":acknowledged?"分叉已返回，但登记或打开未完成；原会话保留，请重连核对，勿重复分叉。":"分叉未创建，源会话和草稿保留。";}
    }finally{if(intent===this.#intent){this.#forking=false;this.#forkCancelled=false;this.#phase="idle";}this.#publish();}
  }
  async #collectSavedText(id:string,current:()=>boolean):Promise<{text:string;fingerprint:string}|undefined>{
    const window=new FullTurnsWindow(id);let complete=false;
    for(let n=0;n<64;n++){
      const cursor=window.cursor(),page=await this.#client.listTurns({threadId:id,cursor,limit:20,sortDirection:"desc",itemsView:"full"});if(!current())return;
      if(page.data.some(turn=>turn.status==="inProgress"))throw new Error("copy-source-in-progress");window.commit(page,cursor);
      if(page.nextCursor===null){complete=true;break;}if(window.limited())throw new Error("copy-display-limit");
    }
    if(!complete||!current())throw new Error("copy-incomplete");const saved=window.snapshot();
    const text=saved.messages.map(message=>(message.role==="user"?"用户":"助手")+":\n"+message.text).join("\n\n");if(!text||Buffer.byteLength(text)>2*1024*1024)throw new Error("copy-text-limit");
    return {text,fingerprint:createHash("sha256").update(JSON.stringify({ids:saved.turnIds,messages:saved.messages})).digest("hex")};
  }
  async #copySession(id:string):Promise<void>{
    this.#managementAvailable(id);if(!this.#copyText||this.#store.find(id)?.ephemeral)throw new Error("copy-unavailable");
    let writing=false;const intent=++this.#intent,generation=this.#client.getView().generation;this.#phase="managing";this.#copying=true;this.#copyCancelled=false;this.#error=null;this.#copyStatus={state:"reading",notice:"正在完整读取已保存文字；完成前不会写入剪贴板。"};this.#publish();
    const current=()=>this.#current(intent,generation)&&!this.#copyCancelled;
    const inspect=async()=>{const result=await this.#client.readThreadMetadata({threadId:id});if(!current())return false;if(result.thread.ephemeral||result.thread.modelProvider!=="openai"||!["idle","notLoaded"].includes(result.thread.status.type))throw new Error("copy-source-unavailable");return true;};
    try{if(!await inspect())return;const first=await this.#collectSavedText(id,current);if(!first||!current()||!await inspect())return;
      const verified=await this.#collectSavedText(id,current);if(!verified||!current()||!await inspect())return;if(first.fingerprint!==verified.fingerprint)throw new Error("copy-source-changed");
      if(!current())return;this.#copying=false;writing=true;this.#copyText(verified.text);this.#copyStatus={state:"copied",notice:"已复制完整读取并复核的保存文字；附件和工具内容未展开，未发送草稿不在其中。"};
    }catch{if(this.#current(intent,generation)&&!this.#copyCancelled)this.#copyStatus={state:"failed",notice:writing?"剪贴板写入未确认，请检查系统剪贴板；没有自动重试。":"复制未完成：记录变化、读取失败或超过文字上限；未写入剪贴板，可刷新后重试。"};}
    finally{if(intent===this.#intent){if(this.#copyStatus.state==="reading")this.#copyStatus={state:"cancelled",notice:"复制已停止，未写入剪贴板。"};this.#copying=false;this.#copyCancelled=false;this.#phase="idle";}this.#publish();}
  }
  async #assignProject(id:string,name:string):Promise<void>{
    this.#managementAvailable(id);const intent=++this.#intent;this.#phase="managing";this.#publish();
    try{await this.#mutate(()=>this.#store.upsert(id,{title:this.#store.find(id)?.title??this.#browser.snapshot().rows.find(row=>row.id===id)?.title??"持久会话",localProject:name.trim()||null}));}
    finally{if(intent===this.#intent)this.#phase="idle";this.#publish();}
  }
  async #renameProject(id:string,name:string):Promise<void>{
    this.#managementAvailable(id);const previous=this.#store.find(id)?.localProject,target=name.trim();
    if(!previous)throw new Error("project-label-required");
    if(this.#store.snapshot().sessions.some(row=>row.localProject===target&&row.localProject!==previous))throw new Error("project-label-conflict");
    const intent=++this.#intent;this.#phase="managing";this.#publish();
    try{await this.#mutate(()=>{const rows=this.#store.snapshot().sessions;if(rows.some(row=>row.localProject===target&&row.localProject!==previous))throw new Error("project-label-conflict");for(const row of rows)if(row.localProject===previous)this.#store.upsert(row.id,{localProject:target});});}
    finally{if(intent===this.#intent)this.#phase="idle";this.#publish();}
  }
  async #renameSection(sectionId:string,name:string):Promise<void>{
    this.#managementAvailable();if(this.#sections.status!=="ready"||!this.#sections.rows.some(row=>row.id===sectionId))throw new Error("sections-unavailable");
    const intent=++this.#intent,generation=this.#client.getView().generation;this.#phase="managing";this.#publish();
    const expected=this.#sections.rows.find(row=>row.id===sectionId)!.name;
    try{const before=await this.#fetchSections(intent,generation);if(!before||!this.#current(intent,generation))return;if(before.find(row=>row.id===sectionId)?.name!==expected)throw new Error("section-name-conflict");
      const result=await this.#client.updateSection({sectionId,name:name.trim()});if(!this.#current(intent,generation))return;
      const after=await this.#fetchSections(intent,generation);if(!after||!this.#current(intent,generation))return;if(after.find(row=>row.id===sectionId)?.name!==name.trim())throw new Error("section-name-conflict");
      await this.#mutate(()=>{if(!this.#current(intent,generation))return;for(const row of this.#store.snapshot().sessions)if(row.sectionId===sectionId)this.#store.upsert(row.id,{sectionName:result.section.name});});
      if(!this.#current(intent,generation))return;this.#sections.rows=this.#sections.rows.map(row=>row.id===sectionId?{id:sectionId,name:result.section.name}:row);this.#error=null;
    }catch{if(this.#current(intent,generation)){this.#sections.status="error";this.#error="分区重命名未确认；请刷新官方分区核对，不会自动重试。";}}
    finally{if(intent===this.#intent)this.#phase="idle";this.#publish();}
  }
  async #fetchSectionOrder(sectionId:string,intent:number,generation:number):Promise<{id:string;title:string}[]|undefined>{
    const rows=new Map<string,{id:string;title:string}>(),seen=new Set<string>();let cursor:string|null=null;
    for(let page=0;page<16;page++){
      const response=await this.#client.listThreads({sectionId,cursor,limit:20,archived:false,sortKey:"section_position",sortDirection:"asc",sourceKinds:["cli","vscode","exec","appServer","subAgent","subAgentReview","subAgentCompact","subAgentThreadSpawn","subAgentOther","unknown"]});if(!this.#current(intent,generation))return;
      for(const row of response.data){if(rows.has(row.id))throw new Error("section-order-duplicate");if(row.ephemeral||row.section?.id!==sectionId||!/^[a-z0-9-]{1,64}$/.test(row.id))throw new Error("section-list-mismatch");rows.set(row.id,{id:row.id,title:(row.name||row.preview||"持久会话").replace(/[\x00-\x1f]/g," ").slice(0,100)});}
      if(rows.size>200)throw new Error("section-list-capacity");if(response.nextCursor===null)return [...rows.values()];
      if(rows.size>=200)throw new Error("section-list-capacity");if(seen.has(response.nextCursor)||response.nextCursor===cursor)throw new Error("section-cursor-loop");seen.add(response.nextCursor);cursor=response.nextCursor;
    }throw new Error("section-list-capacity");
  }
  async #readSectionOrder(sectionId:string,intent:number,generation:number,target?:{id:string;title:string;beforeThreadId?:string;priorIds?:string[]}):Promise<void>{
    this.#sectionOrder={sectionId,rows:[],ready:false};const ordered=await this.#fetchSectionOrder(sectionId,intent,generation);if(!ordered||!this.#current(intent,generation))return;
    if(target){const position=ordered.findIndex(row=>row.id===target.id),anchor=target.beforeThreadId?ordered.findIndex(row=>row.id===target.beforeThreadId):ordered.length;
      if(position<0||(target.beforeThreadId?position+1!==anchor:position!==ordered.length-1)||target.priorIds&&JSON.stringify(ordered.filter(row=>row.id!==target.id).map(row=>row.id))!==JSON.stringify(target.priorIds.filter(id=>id!==target.id)))throw new Error("section-order-conflict");}
    await this.#mutate(()=>{if(!this.#current(intent,generation))return;if(target)this.#store.upsert(target.id,{title:target.title});for(const [position,row] of ordered.entries())if(this.#store.find(row.id))this.#store.upsert(row.id,{sectionId,sectionName:this.#sections.rows.find(section=>section.id===sectionId)?.name??null,sectionPosition:position});});if(this.#current(intent,generation))this.#sectionOrder={sectionId,rows:ordered,ready:true};
  }
  async #fetchSections(intent:number,generation:number):Promise<{id:string;name:string}[]|undefined>{
    const rows=new Map<string,{id:string;name:string}>(),seen=new Set<string>();let cursor:string|null=null;
    for(let page=0;page<4;page++){const response=await this.#client.listSections({cursor,limit:20});if(!this.#current(intent,generation))return;
      for(const row of response.data){if(rows.has(row.id))throw new Error("section-list-duplicate");rows.set(row.id,{id:row.id,name:row.name.replace(/[\x00-\x1f]/g," ")});}if(rows.size>64)throw new Error("section-capacity");if(response.nextCursor===null)return [...rows.values()];if(rows.size>=64||seen.has(response.nextCursor)||response.nextCursor===cursor)throw new Error("section-page-conflict");seen.add(response.nextCursor);cursor=response.nextCursor;
    }throw new Error("section-page-capacity");
  }
  async #loadSectionOrder(sectionId:string):Promise<void>{
    this.#managementAvailable();if(this.#sections.status!=="ready"||!this.#sections.rows.some(row=>row.id===sectionId))throw new Error("sections-unavailable");
    const intent=++this.#intent,generation=this.#client.getView().generation;this.#phase="managing";this.#publish();
    try{await this.#readSectionOrder(sectionId,intent,generation);if(this.#current(intent,generation))this.#error=null;}catch{if(this.#current(intent,generation))this.#error="分区顺序读取未完成，暂停指定位置移动；请刷新后核对。";}
    finally{if(intent===this.#intent)this.#phase="idle";this.#publish();}
  }
  async #loadSections(id?:string):Promise<void>{
    this.#managementAvailable(id);const intent=++this.#intent,generation=this.#client.getView().generation;this.#phase="managing";this.#publish();
    try{const rows=await this.#fetchSections(intent,generation);if(!rows||!this.#current(intent,generation))return;
      if(id){const metadata=await this.#client.readThreadMetadata({threadId:id});if(!this.#current(intent,generation))return;if(metadata.thread.ephemeral)throw new Error("persistent-source-required");this.#sectionObservation={id,sectionId:metadata.thread.section?.id??null,generation};}
      await this.#mutate(()=>{if(!this.#current(intent,generation))return;for(const row of this.#store.snapshot().sessions){const name=rows.find(section=>section.id===row.sectionId)?.name;if(name!==undefined)this.#store.upsert(row.id,{sectionName:name});}});if(!this.#current(intent,generation))return;this.#sections={status:"ready",rows,notice:"分区由官方核心保存；检测到外部变更时请刷新后重新选择。",canCreate:this.#sectionCreateBlockedGeneration!==generation,...(id?{targetId:id,currentSectionId:this.#sectionObservation!.sectionId}:{})};

    }catch(error){if(this.#current(intent,generation))this.#sections={...this.#sections,status:error instanceof HostOperationError&&error.code==="rpc-error:-32601"?"unsupported":"error",notice:"官方分区读取未完成或当前存储不支持，保留原归属；未切换到伪造接口。",canCreate:false};}
    finally{if(intent===this.#intent)this.#phase="idle";this.#publish();}
  }
  async #createSection(name:string):Promise<void>{
    this.#managementAvailable();if(this.#sections.status!=="ready"||!this.#sections.canCreate||this.#sections.rows.length>=64)throw new Error("sections-unavailable");
    const intent=++this.#intent,generation=this.#client.getView().generation;this.#phase="managing";this.#publish();
    try{const result=await this.#client.createSection({name:name.trim()});if(this.#current(intent,generation)){this.#sections.rows=[...this.#sections.rows.filter(row=>row.id!==result.section.id),{id:result.section.id,name:result.section.name}];this.#sections.lastCreatedId=result.section.id;this.#error=null;}}
    catch{if(this.#current(intent,generation)){this.#sectionCreateBlockedGeneration=generation;this.#sections.canCreate=false;this.#error="分区创建结果未确认，不能自动重试；请重连后刷新官方分区。";}}
    finally{if(intent===this.#intent)this.#phase="idle";this.#publish();}
  }
  async #assignSection(id:string,sectionId:string|null,beforeThreadId?:string):Promise<void>{
    this.#managementAvailable(id);const record=this.#store.find(id),section=this.#sections.rows.find(row=>row.id===sectionId);
    if(this.#sections.status!=="ready"||(sectionId!==null&&!section)||record?.ephemeral||record?.archived||record?.archiveUncertain||(this.#browsing&&this.#browser.snapshot().archived))throw new Error("section-target-unavailable");
    if(beforeThreadId&&(!this.#sectionOrder?.ready||this.#sectionOrder.sectionId!==sectionId||!this.#sectionOrder.rows.some(row=>row.id===beforeThreadId)||beforeThreadId===id))throw new Error("section-anchor-unavailable");
    const observed=this.#sectionObservation?.id===id&&this.#sectionObservation.generation===this.#client.getView().generation?this.#sectionObservation.sectionId:record?.sectionId;
    const expectedOrder=this.#sectionOrder?.ready&&this.#sectionOrder.sectionId===sectionId?this.#sectionOrder.rows.map(row=>row.id):undefined;
    const intent=++this.#intent,generation=this.#client.getView().generation;this.#phase="managing";this.#publish();let requested=false;
    try{const meta=await this.#client.readThreadMetadata({threadId:id});if(!this.#current(intent,generation))return;if(meta.thread.ephemeral||!["idle","notLoaded"].includes(meta.thread.status.type))throw new Error("active-session-management-refused");
      if(observed!==undefined&&(meta.thread.section?.id??null)!==observed)throw new Error("section-membership-conflict");
      const prior=sectionId?await this.#fetchSectionOrder(sectionId,intent,generation):[];if(!prior||!this.#current(intent,generation))return;
      if(expectedOrder&&JSON.stringify(prior.map(row=>row.id))!==JSON.stringify(expectedOrder))throw new Error("section-order-conflict");
      if(beforeThreadId&&!prior.some(row=>row.id===beforeThreadId))throw new Error("section-anchor-conflict");
      if(this.#sectionOrder)this.#sectionOrder.ready=false;requested=true;await this.#client.moveToSection({threadId:id,sectionId,...(beforeThreadId?{beforeThreadId}:{})});if(!this.#current(intent,generation))return;
      const verified=await this.#client.readThreadMetadata({threadId:id});if(!this.#current(intent,generation))return;if((verified.thread.section?.id??null)!==sectionId)throw new Error("section-move-not-verified");
      const title=(record?.title??meta.thread.name??meta.thread.preview??"持久会话").slice(0,100);
      if(sectionId){await this.#readSectionOrder(sectionId,intent,generation,{id,title,beforeThreadId,priorIds:prior.map(row=>row.id)});if(!this.#current(intent,generation))return;}
      else{await this.#mutate(()=>{if(this.#current(intent,generation))this.#store.upsert(id,{title,sectionId:null,sectionName:null,sectionPosition:undefined});});if(!this.#current(intent,generation))return;this.#sectionOrder=undefined;}if(this.#sectionObservation?.id===id)this.#sectionObservation={id,sectionId,generation};this.#error=null;
    }catch{if(this.#current(intent,generation)){if(this.#sectionOrder)this.#sectionOrder.ready=false;this.#error=requested?"分区移动未确认，保留本地原归属；官方结果可能已改变，请刷新核对。":"检测到外部更改或无法核对当前分区，未发送移动；请刷新分区和顺序后重新选择。";}}
    finally{if(intent===this.#intent)this.#phase="idle";this.#publish();}
  }
  searchPreviewSource(id:string):import("./session-preview.ts").PreviewSource {
    if(this.#phase!=="idle"||this.#pending||!this.#guarded)throw new Error("search-preview-unavailable");return this.#search.source(id);
  }
  previewSource(id:string):import("./session-preview.ts").PreviewSource {
    this.#managementAvailable(id);const record=this.#store.find(id),browser=this.#browser.snapshot();if(record?.ephemeral)throw new Error("preview-persistent-required");
    return {id,title:record?.title??browser.rows.find(row=>row.id===id)?.title??"持久会话",archived:record?.archived??(browser.archived&&browser.rows.some(row=>row.id===id)),archiveUncertain:!!record?.archiveUncertain};
  }
  async dispatch(value: unknown): Promise<DesktopView> {
    if (this.#disposed) throw new Error("controller-unavailable"); const command = validateDesktopCommand(value);
    if(this.#options.fixedThreadId&&(!["connect","draft","submit","confirm","cancel","refreshHistory","history","clearError"].includes(command.type)||(command.type==="draft"&&command.routeId!==this.#options.fixedThreadId)||(command.type==="history"&&command.threadId!==this.#options.fixedThreadId)))throw new Error("fixed-session-command-rejected");
    if(this.#phase==="managing"&&["thread","browseHistory","returnToChat","toggleArchived","refreshThreads","moreThreads","refreshHistory","history"].includes(command.type))throw new Error("session-management-busy");
    if (this.#browsing && ["draft", "submit", "confirm", "selectModel", ...(!this.#forking&&!this.#copying?["cancel"]:[])].includes(command.type)) throw new Error("saved-history-read-only");
    switch (command.type) {
      case "searchSessions": this.#search.search(command.text,command.archived,command.kind);break;
      case "moreSessionSearch": this.#search.more();break;
      case "cancelSessionSearch": this.#search.cancel();break;
      case "continueSession": if(this.#browsing && this.#browser.snapshot().archived)throw new Error("archived-session-read-only"); await this.#activateSaved(command.id); break;
      case "pinSession": case "unreadSession": case "renameSession": case "archiveSession": case "unarchiveSession": await this.#manage(command); break;
      case "copySession": await this.#copySession(command.id);break;
      case "forkSession": await this.#fork(command.id,command.lastTurnId); break;
      case "renameProject": await this.#renameProject(command.id,command.name);break;
      case "renameSection": await this.#renameSection(command.sectionId,command.name);break;
      case "loadSectionOrder": await this.#loadSectionOrder(command.sectionId);break;
      case "assignProject": await this.#assignProject(command.id,command.name); break;
      case "loadSections": await this.#loadSections(command.id);break;
      case "createSection": await this.#createSection(command.name);break;
      case "assignSection": await this.#assignSection(command.id,command.sectionId,command.beforeThreadId);break;
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
        try { await this.#store.load(); await this.#store.transaction(()=>{}); if(intent!==this.#intent||this.#disposed)break; this.#persistenceReady=true; } catch { if(intent===this.#intent&&!this.#disposed){this.#phase="idle";this.#error="工作台会话存储不可用，未覆盖旧文件，发送已禁用。";this.#guarded=false;}break;}
        const restoreId=this.#options.fixedThreadId??this.#store.snapshot().lastId;
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
      case "submit": if (!this.#store.snapshot().delivery && !this.#archiveBlockedId && !this.#browser.snapshot().inflight && this.#asyncReads===0 && this.#phase === "idle" && !this.#pending && this.#guarded && this.#model && this.#client.getView().state === "ready" && this.#draft.trim()) this.#pending = this.#draft.trim(); break;
      case "confirm": await this.#confirm(); break;
      case "cancel": if(this.#copying){this.#copyCancelled=true;this.#copyStatus={state:"cancelled",notice:"复制已取消，未写入剪贴板。"};break;} if(this.#forking){this.#forkCancelled=true;this.#error="已取消自动打开；已发送的官方分叉仍可能完成，将登记返回ID，不会重复请求。";break;} if (this.#pending) this.#pending = null; else if (["starting", "running", "cancelling"].includes(this.#phase)) { this.#cancelWanted = true; await this.#interrupt(); } break;
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
  /** Used only after the workspace has awaited durable drafts; never owns shared host teardown. */
  detach():void{if(this.#disposed)return;this.#intent++;this.#disposed=true;this.#searchUnsubscribe();this.#search.dispose();this.#browserUnsubscribe();this.#browser.dispose();this.#clearCancelTimer();this.#unsubscribe();this.#listeners.clear();this.#core.detach();}
  async disposeSaved():Promise<void>{if(this.#disposed)return;this.detach();await this.#client.dispose();}
  async dispose(): Promise<void> { if (this.#disposed) return; this.#intent++; this.#disposed = true; this.#searchUnsubscribe();this.#search.dispose();this.#browserUnsubscribe(); this.#browser.dispose(); this.#clearCancelTimer(); this.#unsubscribe(); this.#listeners.clear(); try {if(this.#persistenceReady)await this.#save();}finally{await this.#core.dispose();} }
}
