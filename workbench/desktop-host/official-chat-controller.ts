import type { WorkbenchClient } from "./client.ts";
import { HostOperationError } from "./client.ts";
import { CoreController } from "./core-controller.ts";
import { validateDesktopCommand } from "./ipc-contract.ts";
import type { DesktopView, DemoMessage } from "./demo-controller.ts";
const historyNotice = "只显示当前临时会话；刷新使用 thread/read。当前核心默认存储不支持 items 分页，未加载既有聊天。";
type Phase = "connecting" | "idle" | "starting" | "running" | "cancelling" | "reading" | "unknown";
/** One current ephemeral conversation; model turns are never replayed on reconnect. */
export class OfficialChatController {
  #client: WorkbenchClient; #core: CoreController; #cwd: string; #offline: boolean;
  #unsubscribe: () => void; #listeners = new Set<() => void>(); #disposed = false; #version = 0; #intent = 0;
  #phase: Phase = "idle"; #model: string | null = null; #thread: string | null = null; #generation = 0;
  #turn: string | null = null; #cancelWanted = false; #interruptSent = false; #interruptAcknowledged = false; #guarded = false;
  #draft = ""; #pending: string | null = null; #submitted = ""; #error: string | null = null; #cached: DemoMessage[] = [];
  #prompts = new Map<string, string>(); #created = 0; #cancelTimer: ReturnType<typeof setTimeout> | null = null; #cancelTimeout: number;
  constructor(client: WorkbenchClient, cwd: string, offline = false, cancelTimeoutMs = 15000) {
    if (!Number.isSafeInteger(cancelTimeoutMs) || cancelTimeoutMs < 1 || cancelTimeoutMs > 60000) throw new Error("invalid-cancel-timeout"); this.#cancelTimeout = cancelTimeoutMs;
    this.#client = client; this.#cwd = cwd; this.#offline = offline; this.#core = new CoreController(client, true);
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
        if (item.value?.type === "userMessage") messages.push({ id: turn.id+":"+item.id, role: "user", text: item.value.content.filter(value => value.type === "text").map(value => value.text).join("\n"), stale: thread?.stale });
        else if (item.value?.type === "agentMessage" || (!item.value && item.text)) messages.push({ id: turn.id+":"+item.id, role: "assistant", text: item.text, status, stale: turn.stale || host.state !== "ready" });
      }
      if (!turn.items.some(item => item.value?.type === "agentMessage" || (!item.value && item.text))) messages.push({ id: turn.id+":waiting", role: "assistant", text: status === "running" ? "等待官方模型回应…" : status === "unknown" ? "连接已断开，执行结果未知。" : status === "failed" ? "官方模型未完成本次请求。" : status === "cancelled" ? "官方核心已确认中断。" : "本轮已结束，没有文本输出。", status });
    }
    if (this.#phase === "starting" && !this.#turn && this.#submitted) messages.push({ id: "pending-user", role: "user", text: this.#submitted });
    return messages;
  }
  #sync(): void {
    const host = this.#client.getView();
    if (host.state !== "ready") {
      if (this.#phase === "reading") this.#phase = "idle";
      this.#clearCancelTimer(); this.#guarded = false; this.#pending = null;
      if (["starting", "running", "cancelling"].includes(this.#phase)) { this.#phase = "unknown"; this.#error = "连接已断开，执行结果未知；不会自动重发。重连将创建新临时会话。"; }
      return;
    }
    if (this.#turn && host.generation === this.#generation) {
      const turn = host.threads.find(thread => thread.id === this.#thread)?.turns.find(turn => turn.id === this.#turn);
      if (turn && turn.status !== "inProgress") {
        if (turn.status === "failed") this.#error = "官方服务报告本轮失败，未自动重试。";
        this.#clearCancelTimer(); this.#phase = "idle"; this.#turn = null; this.#cancelWanted = false; this.#interruptSent = false;
      }
    }
  }
  snapshot(): DesktopView {
    const base = this.#core.snapshot(), messages = this.#messages();
    return { ...base, mode: "official-chat", version: this.#version,
      chatStatus: { phase: this.#phase, model: this.#model, offline: this.#offline, ready: this.#guarded && !!this.#model && base.connection === "ready", interruptAcknowledged: this.#interruptAcknowledged, canRefresh: !!this.#thread && this.#generation === this.#client.getView().generation && this.#phase === "idle" && base.connection === "ready" },
      projects: [{ id: "official-chat", name: "官方临时聊天", threads: this.#thread ? [{ id: this.#thread, title: "当前临时会话" }] : [] }],
      route: { projectId: "official-chat", threadId: this.#thread }, title: "官方临时聊天", messages,
      draft: this.#draft, pending: this.#pending, running: ["starting", "running", "cancelling"].includes(this.#phase),
      loading: base.loading || this.#phase === "reading", error: this.#error ?? base.error,
      history: { ...base.history, turnCount: this.#prompts.size, itemCount: messages.length, hasMore: false, notice: historyNotice, stale: base.stale, loading: this.#phase === "reading", busy: this.#phase !== "idle" } };
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
    if (!this.#pending || this.#phase !== "idle" || !this.#guarded || !this.#model) return;
    const text = this.#pending, model = this.#model; this.#pending = null; this.#submitted = text;
    this.#phase = "starting"; this.#cancelWanted = false; this.#interruptSent = false; this.#interruptAcknowledged = false; this.#error = null;
    const intent = ++this.#intent, generation = this.#client.getView().generation; this.#publish();
    try {
      await this.#client.checkModelConfiguration(); if (!this.#current(intent, generation)) return;
      const account = await this.#client.getAccount({ refreshToken: false }); if (!this.#current(intent, generation)) return;
      if (account.account?.type !== "chatgpt") throw new HostOperationError("core-chatgpt-login-required");
      if (this.#cancelWanted) { this.#phase = "idle"; return; }
      if (!this.#thread) {
        if (this.#created >= 8) throw new HostOperationError("chat-session-limit");
        const started = await this.#client.startThread({ model, modelProvider: "openai", cwd: this.#cwd, approvalPolicy: "never", sandbox: "read-only", ephemeral: true,
          baseInstructions: "You are a text-only chat assistant. Answer the user's message. Do not use tools, inspect files, or access projects.", developerInstructions: "Only provide text responses. Never call any tool or access files, credentials or external services." });
        if (!this.#current(intent, generation)) return;
        this.#thread = started.thread.id; this.#generation = generation; this.#created++; this.#cached = []; this.#prompts.clear();
      }
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
        this.#phase = unknown ? "unknown" : "idle"; this.#error = unknown ? "请求结果未知；不会自动重发，需重连创建新会话。" : "消息未发送完成，请检查连接、账户或配置后再试。";
        if (unknown) await this.#client.stop();
      }
    } finally { if (intent === this.#intent) this.#submitted = ""; this.#publish(); }
  }
  async dispatch(value: unknown): Promise<DesktopView> {
    if (this.#disposed) throw new Error("controller-unavailable"); const command = validateDesktopCommand(value);
    switch (command.type) {
      case "connect": case "reconnect": {
        if (["connecting", "starting", "running", "cancelling", "reading"].includes(this.#phase)) throw new Error("chat-busy");
        const intent = ++this.#intent; this.#phase = "connecting"; this.#guarded = false; this.#cached = this.#messages(); this.#thread = null; this.#turn = null; this.#pending = null;
        await this.#core.dispatch(command);
        if (intent !== this.#intent || this.#disposed) break;
        try { await this.#client.checkModelConfiguration(); if (intent !== this.#intent || this.#disposed) break; this.#guarded = true; this.#phase = "idle"; this.#error = null;
          const models = this.#core.snapshot().coreStatus!.models; if (!this.#model || !models.includes(this.#model)) this.#model = this.#core.snapshot().coreStatus!.defaultModel;
        } catch { this.#phase = "idle"; this.#error = "官方聊天配置尚未确认，发送已禁用。"; }
        break;
      }
      case "disconnect": this.#clearCancelTimer(); this.#cached = this.#messages(); this.#intent++; if (["reading", "connecting"].includes(this.#phase)) this.#phase = "idle"; this.#guarded = false; this.#pending = null; await this.#core.dispatch(command); break;
      case "draft": if (command.routeId !== (this.#thread ?? "official-chat")) throw new Error("invalid-draft-route"); this.#draft = command.text; break;
      case "selectModel": if (this.#phase !== "idle" || this.#pending || !this.#core.snapshot().coreStatus?.models.includes(command.model)) throw new Error("model-unavailable"); this.#model = command.model; break;
      case "submit": if (this.#phase === "idle" && !this.#pending && this.#guarded && this.#model && this.#client.getView().state === "ready" && this.#draft.trim()) this.#pending = this.#draft.trim(); break;
      case "confirm": await this.#confirm(); break;
      case "cancel": if (this.#pending) this.#pending = null; else if (["starting", "running", "cancelling"].includes(this.#phase)) { this.#cancelWanted = true; await this.#interrupt(); } break;
      case "new": if (!["idle", "unknown"].includes(this.#phase)) throw new Error("chat-busy"); this.#intent++; this.#thread = null; this.#turn = null; this.#cached = []; this.#prompts.clear(); this.#draft = ""; this.#pending = null; this.#error = null; if (this.#guarded) this.#phase = "idle"; break;
      case "thread": if (command.id !== this.#thread) throw new Error("unknown-chat-thread"); break;
      case "history": {
        if (command.threadId !== this.#thread || this.#generation !== this.#client.getView().generation || this.#phase !== "idle") throw new Error("history-unavailable");
        const intent = this.#intent, generation = this.#generation; this.#phase = "reading"; this.#publish();
        try { await this.#client.readThread({ threadId: command.threadId, includeTurns: true }); }
        catch { if (this.#current(intent, generation)) this.#error = "当前会话刷新未完成，已保留显示缓存；分页不可用。"; }
        finally { if (intent === this.#intent) this.#phase = "idle"; this.#publish(); } break;
      }
      case "clearError": this.#error = null; break;
      default: throw new Error("official-chat-command-unavailable");
    }
    this.#publish(); return this.snapshot();
  }
  async dispose(): Promise<void> { if (this.#disposed) return; this.#intent++; this.#disposed = true; this.#clearCancelTimer(); this.#unsubscribe(); this.#listeners.clear(); await this.#core.dispose(); }
}
