import type { WorkbenchClient } from "./client.ts";
import { HostOperationError } from "./client.ts";
import type { DesktopView } from "./demo-controller.ts";
import { validateDesktopCommand } from "./ipc-contract.ts";
import { OFFICIAL_VERSION, PROBE_THREAD_ID } from "./isolated-core.ts";
export type CoreProbe = { method: "thread/read" | "thread/turns/list" | "thread/items/list"; code: string; status: "unavailable" | "error" };
export type CoreStatus = { version: string; generation: number; handshake: boolean; checking: boolean; authentication: { type: string; planType: string | null } | null; models: string[]; defaultModel: string | null; probes: CoreProbe[] };
/** Native process and sanitized account/catalog status; no thread creation or model turns. */
export class CoreController {
  #client: WorkbenchClient; #unsubscribe: () => void; #listeners = new Set<() => void>();
  #version = 0; #disposed = false; #error: string | null = null; #probes: CoreProbe[] = []; #checking = false; #intent = 0;
  #accountMode: boolean; #account: CoreStatus["authentication"] = null; #models: string[] = []; #defaultModel: string | null = null;
  constructor(client: WorkbenchClient, accountMode = false) {
    this.#accountMode = accountMode; this.#client = client; this.#unsubscribe = client.subscribe(() => { if (client.getView().state !== "ready") { this.#account = null; this.#models = []; this.#defaultModel = null; this.#checking = false; } this.#publish(); });
  }
  #publish(): void { this.#version++; if (!this.#disposed) for (const listener of this.#listeners) { try { listener(); } catch { /* Isolate renderer observers. */ } } }
  subscribe(listener: () => void): () => void { if (this.#disposed || this.#listeners.size >= 16) throw new Error("controller-unavailable"); this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  snapshot(): DesktopView {
    const host = this.#client.getView();
    return { mode: this.#accountMode ? "official-account" : "official-isolated", version: this.#version, connection: host.state, stale: host.state !== "ready",
      projects: [{ id: "core-check", name: "官方核心连接", threads: [] }], route: { projectId: "core-check", threadId: null }, title: "官方核心连接",
      messages: [], draft: "", search: "", loading: this.#checking, pending: null, running: false, error: this.#error,
      history: { turnCount: 0, itemCount: 0, hasMore: false, busy: false, loading: false, stale: false, notice: null }, approvals: [],
      coreStatus: { version: OFFICIAL_VERSION, generation: host.generation, handshake: host.state === "ready", checking: this.#checking, authentication: structuredClone(this.#account), models: [...this.#models], defaultModel: this.#defaultModel, probes: structuredClone(this.#probes) } };
  }
  async #readAccount(intent: number): Promise<void> {
    const generation = this.#client.getView().generation;
    const current = () => !this.#disposed && intent === this.#intent && generation === this.#client.getView().generation && this.#client.getView().state === "ready";
    this.#checking = true; this.#publish();
    try {
      await this.#client.checkOfficialRoute(); if (!current()) return;
      const response = await this.#client.getAccount({ refreshToken: false }); if (!current()) return;
      if (response.account?.type !== "chatgpt") throw new HostOperationError("core-chatgpt-login-required");
      this.#account = { type: "chatgpt", planType: response.account.planType };
      const catalog = await this.#client.listModels({ limit: 100, includeHidden: false }); if (!current()) return;
      const models = catalog.data.filter(model => !model.hidden && model.model.startsWith("gpt-") && model.inputModalities.includes("text"));
      this.#models = models.map(model => model.model); this.#defaultModel = models.find(model => model.isDefault)?.model ?? models[0]?.model ?? null;
    } finally { if (intent === this.#intent && !this.#disposed) this.#checking = false; this.#publish(); }
  }
  async #probe(): Promise<void> {
    if (this.#checking || this.#client.getView().state !== "ready") return;
    const intent = this.#intent, generation = this.#client.getView().generation;
    this.#checking = true; this.#probes = []; this.#error = null; this.#publish();
    try {
      const requests = [
        ["thread/read", () => this.#client.readThread({ threadId: PROBE_THREAD_ID, includeTurns: false })],
        ["thread/turns/list", () => this.#client.listTurns({ threadId: PROBE_THREAD_ID, limit: 1, itemsView: "summary" })],
        ["thread/items/list", () => this.#client.listItems({ threadId: PROBE_THREAD_ID, limit: 1 })],
      ] as const;
      for (const [method, request] of requests) {
        let code = "unexpected-success", status: CoreProbe["status"] = "error";
        try { await request(); } catch (error) {
          code = error instanceof HostOperationError ? error.code : "core-probe-failed";
          status = code === "rpc-error:-32601" || code === "rpc-error:-32600" ? "unavailable" : "error";
        }
        if (this.#disposed || intent !== this.#intent || generation !== this.#client.getView().generation || this.#client.getView().state !== "ready") return;
        this.#probes.push({ method, code, status }); this.#publish();
      }
    } finally { if (intent === this.#intent) this.#checking = false; this.#publish(); }
  }
  async dispatch(value: unknown): Promise<DesktopView> {
    if (this.#disposed) throw new Error("controller-unavailable");
    const command = validateDesktopCommand(value);
    switch (command.type) {
      case "connect": case "reconnect": {
        const intent = ++this.#intent; this.#checking = false; this.#probes = []; this.#error = null; this.#account = null; this.#models = []; this.#defaultModel = null;
        try { await (command.type === "connect" ? this.#client.start() : this.#client.reconnect()); if (this.#accountMode && intent === this.#intent && !this.#disposed) await this.#readAccount(intent); }
        catch (error) { if (intent === this.#intent && !this.#disposed) this.#error = (this.#client.getView().state === "ready" ? "官方账户/模型状态读取未完成 · " : "官方核心连接未就绪 · ") + (error instanceof HostOperationError ? error.code : "core-preflight-failed"); }
        break;
      }
      case "disconnect": this.#intent++; this.#checking = false; this.#probes = []; this.#error = null; this.#account = null; this.#models = []; this.#defaultModel = null; await this.#client.stop(); break;
      case "probeCore": await this.#probe(); break;
      case "clearError": this.#error = null; break;
      default: throw new Error("isolated-core-read-only");
    }
    this.#publish(); return this.snapshot();
  }
  async dispose(): Promise<void> { if (this.#disposed) return; this.#intent++; this.#disposed = true; this.#checking = false; this.#unsubscribe(); this.#listeners.clear(); await this.#client.dispose(); }
}
