import type { ThreadListParams, ThreadListResponse } from "../protocol-adapter/contracts.ts";
import type { ThreadStartParams, ThreadStartResponse, TurnStartParams, TurnStartResponse, TurnInterruptParams, TurnInterruptResponse } from "../protocol-adapter/contracts.ts";
import { assertOfficialRouteConfiguration, assertOfficialChatConfiguration, disableConfiguredMcp } from "./official-config.ts";
import type { GetAccountParams, GetAccountResponse, ModelListParams, ModelListResponse } from "../protocol-adapter/contracts.ts";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { ProtocolSession, ProtocolSessionError } from "../protocol-adapter/session.ts";
import type { ApprovalHandle, ApprovalDecision } from "../protocol-adapter/session.ts";
import type { InitializeResponse, ThreadReadParams, ThreadReadResponse, ThreadTurnsListParams, ThreadTurnsListResponse, ThreadItemsListParams, ThreadItemsListResponse } from "../protocol-adapter/contracts.ts";
import type { ProcessLauncher } from "./launch.ts";
import { HostOperationError } from "./client.ts";
import type { WorkbenchClient, HostView, HostState, HostDiagnostic } from "./client.ts";

type Context = {
  epoch: number; child: ChildProcessWithoutNullStreams | null; active: boolean;
  spawned: boolean; writing: boolean; waitingDrain: boolean; handshakeDone: boolean;
  stopRequested: boolean; failure: string | null; stdoutEnded: boolean;
  exitCode: number | null; signal: NodeJS.Signals | null;
  start: Promise<void>; resolveStart: () => void; rejectStart: (error: Error) => void;
  closed: Promise<void>; resolveClosed: () => void; rejectClosed: (error: Error) => void;
  unsubscribe: () => void; cleanup: (() => void)[]; timers: Set<ReturnType<typeof setTimeout>>;
  shutdownStarted: boolean;
  protocolQueued: boolean;
  exited: boolean;
};
export type HostOptions = { requestTimeoutMs?: number; shutdownGraceMs?: number; terminateGraceMs?: number; closeTimeoutMs?: number };

/** Owns exactly one child and one protocol generation; reconnection is explicit. */
export class StdioWorkbenchHost implements WorkbenchClient {
  #launch: ProcessLauncher;
  #session: ProtocolSession;
  #serverInfo: InitializeResponse | null = null;
  #state: HostState = "stopped";
  #context: Context | null = null;
  #listeners = new Set<() => void>();
  #notifyQueued = false;
  #diagnostics: HostDiagnostic[] = [];
  #grace: number; #termGrace: number; #closeTimeout: number;
  #disposePromise: Promise<void> | null = null;
  #disposeRequested = false;
  #intent = 0;
  #reconnectPromise: Promise<void> | null = null;
  #reconnectIntent = 0;

  constructor(launcher: ProcessLauncher, options: HostOptions = {}) {
    if (typeof launcher !== "function") throw new HostOperationError("invalid-launcher");
    for (const value of Object.values(options)) if (!Number.isSafeInteger(value) || value! < 1 || value! > 60000) throw new HostOperationError("invalid-host-limit");
    this.#launch = launcher;
    this.#session = new ProtocolSession({ timeoutMs: options.requestTimeoutMs ?? 30000 });
    this.#grace = options.shutdownGraceMs ?? 300;
    this.#termGrace = options.terminateGraceMs ?? 300;
    this.#closeTimeout = options.closeTimeoutMs ?? 2000;
  }
  client(): WorkbenchClient {
    return Object.freeze({ start: () => this.start(), reconnect: () => this.reconnect(), stop: () => this.stop(), dispose: () => this.dispose(),
      getView: () => this.getView(), takeDiagnostics: () => this.takeDiagnostics(), subscribe: (listener: () => void) => this.subscribe(listener),
      listThreads: (params: ThreadListParams) => this.listThreads(params),
      startThread: (params: ThreadStartParams) => this.startThread(params), startTurn: (params: TurnStartParams) => this.startTurn(params), interruptTurn: (params: TurnInterruptParams) => this.interruptTurn(params), checkModelConfiguration: () => this.checkModelConfiguration(),
      checkOfficialRoute: () => this.checkOfficialRoute(),
      getAccount: (params: GetAccountParams) => this.getAccount(params), listModels: (params: ModelListParams) => this.listModels(params),
      readThreadMetadata: (params: Pick<ThreadReadParams, "threadId">) => this.readThreadMetadata(params),
      readThread: (params: ThreadReadParams) => this.readThread(params),
      listTurns: (params: ThreadTurnsListParams) => this.listTurns(params), listItems: (params: ThreadItemsListParams) => this.listItems(params),
      respondApproval: (handle: ApprovalHandle, decision: ApprovalDecision) => this.respondApproval(handle, decision),
      acknowledgeRecovery: () => this.acknowledgeRecovery() });
  }
  getView(): HostView {
    return { serverInfo: structuredClone(this.#serverInfo), state: this.#state, generation: this.#session.epoch, processActive: this.#context !== null,
      protocolState: this.#session.state, threads: this.#session.snapshot(), approvals: this.#session.approvals(), recovery: this.#session.recoveryPlan() };
  }
  takeDiagnostics(): HostDiagnostic[] { const records = this.#diagnostics; this.#diagnostics = []; return records; }
  subscribe(listener: () => void): () => void {
    if (this.#disposeRequested || this.#state === "disposed") throw new HostOperationError("host-disposed");
    if (typeof listener !== "function" || this.#listeners.size >= 128) throw new HostOperationError("invalid-subscriber");
    this.#listeners.add(listener); return () => { this.#listeners.delete(listener); };
  }
  #publish(): void {
    if (this.#notifyQueued) return;
    this.#notifyQueued = true;
    queueMicrotask(() => {
      this.#notifyQueued = false;
      for (const listener of this.#listeners) { try { listener(); } catch { /* UI listeners are isolated. */ } }
    });
  }
  #stateTo(state: HostState): void { this.#state = state; this.#publish(); }
  #diagnostic(record: HostDiagnostic): void {
    if (this.#diagnostics.length === 128) this.#diagnostics.shift();
    this.#diagnostics.push(record);
  }
  #active(ctx: Context): boolean { return ctx.active && this.#context === ctx; }
  #error(error: unknown): HostOperationError {
    if (error instanceof ProtocolSessionError) return new HostOperationError(error.code, error.outcome);
    return new HostOperationError("invalid-client-operation");
  }
  start(): Promise<void> {
    if (this.#disposeRequested || this.#state === "disposed") return Promise.reject(new HostOperationError("host-disposed"));
    if (this.#reconnectPromise && this.#reconnectIntent === this.#intent) return this.#reconnectPromise;
    this.#intent++;
    return this.#startOwned();
  }
  #startOwned(): Promise<void> {
    if (this.#disposeRequested || this.#state === "disposed") return Promise.reject(new HostOperationError("host-disposed"));
    if (this.#context) {
      if (this.#state === "ready") return Promise.resolve();
      if (this.#state === "starting" || this.#state === "initializing") return this.#context.start;
      return Promise.reject(new HostOperationError("process-still-active"));
    }
    this.#serverInfo = null; this.#stateTo("starting");
    let connection: ReturnType<ProtocolSession["connect"]>;
    try { connection = this.#session.connect(); }
    catch { this.#stateTo("failed"); return Promise.reject(new HostOperationError("initialization-failed")); }
    let resolveStart!: () => void, rejectStart!: (error: Error) => void, resolveClosed!: () => void, rejectClosed!: (error: Error) => void;
    const start = new Promise<void>((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
    const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
    // A failure can happen before anyone asks to stop. Keep internal promises observed.
    void closed.catch(() => {});
    const ctx: Context = { epoch: connection.epoch, child: null, active: true, spawned: false, writing: false, waitingDrain: false,
      handshakeDone: false, stopRequested: false, failure: null, stdoutEnded: false, exitCode: null, signal: null,
      start, resolveStart, rejectStart, closed, resolveClosed, rejectClosed, unsubscribe: () => {}, cleanup: [], timers: new Set(), shutdownStarted: false, protocolQueued: false, exited: false };
    this.#context = ctx;
    ctx.unsubscribe = this.#session.subscribe(() => {
      if (ctx.protocolQueued) return;
      ctx.protocolQueued = true;
      queueMicrotask(() => { ctx.protocolQueued = false; this.#protocolChanged(ctx); });
    });
    void connection.initialized.then(info => { if (this.#active(ctx) && !ctx.stopRequested && !ctx.failure) this.#serverInfo = structuredClone(info); ctx.handshakeDone = true; this.#finishStart(ctx); }, () => {
      if (this.#active(ctx) && !ctx.stopRequested) this.#fail(ctx, "initialization-failed");
    });
    try { ctx.child = this.#launch(); this.#bind(ctx); }
    catch (error) { this.#fail(ctx, error instanceof HostOperationError && /^core-(preflight-failed|version-mismatch|version-or-provenance-mismatch|sandbox-unavailable|chatgpt-login-required)$/.test(error.code) ? error.code : "spawn-failed"); if (!ctx.child) this.#closed(ctx); }
    return start;
  }
  #bind(ctx: Context): void {
    const child = ctx.child!;
    const onSpawn = () => { if (!this.#active(ctx) || ctx.stopRequested || ctx.failure) return; ctx.spawned = true; this.#stateTo("initializing"); this.#pump(ctx); };
    const onError = () => this.#fail(ctx, "spawn-failed");
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      ctx.exitCode = code; ctx.signal = signal; ctx.exited = true;
      this.#diagnostic({ code: "process-exit", exitCode: code, signal });
      // Do not discard buffered stdout on exit; close/end run after it is drained.
      if (!ctx.stopRequested && !ctx.failure) this.#stateTo("draining");
      ctx.rejectStart(new HostOperationError("process-exited"));
      this.#timer(ctx, this.#closeTimeout, () => {
        this.#fail(ctx, "stdio-drain-timeout");
        // The owned process has exited. Close only our pipe ends if another
        // process still holds inherited descriptors; never signal a reused PID.
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      });
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => { ctx.exitCode = code; ctx.signal = signal; this.#closed(ctx); };
    const onData = (bytes: Buffer) => { if (!this.#active(ctx) || ctx.stopRequested) return; this.#session.receive(bytes, ctx.epoch); this.#protocolChanged(ctx); };
    const onEnd = () => {
      if (!this.#active(ctx)) return;
      ctx.stdoutEnded = true;
      this.#session.end(ctx.epoch);
      if (!ctx.stopRequested) {
        if (this.#session.state === "failed") this.#fail(ctx, "protocol-failed");
        else { this.#stateTo("disconnected"); ctx.rejectStart(new HostOperationError("stdout-closed")); this.#shutdown(ctx); }
      }
    };
    const onStdoutError = () => this.#fail(ctx, "stdout-error");
    const onStdinError = () => { if (!ctx.stopRequested) this.#fail(ctx, "stdin-error"); };
    const onStderrError = () => { if (!ctx.stopRequested) this.#fail(ctx, "stderr-error"); };
    const onStderr = (bytes: Buffer) => { if (this.#active(ctx)) this.#diagnostic({ code: "stderr-output", stderrBytes: bytes.length }); };
    const onDrain = () => { ctx.waitingDrain = false; this.#pump(ctx); };
    child.once("spawn", onSpawn); child.on("error", onError); child.on("exit", onExit); child.once("close", onClose);
    child.stdout.on("data", onData); child.stdout.once("end", onEnd); child.stdout.on("error", onStdoutError);
    child.stdin.on("error", onStdinError); child.stdin.on("drain", onDrain);
    child.stderr.on("data", onStderr); child.stderr.on("error", onStderrError);
    ctx.cleanup.push(() => { child.off("spawn", onSpawn); child.off("error", onError); child.off("exit", onExit); child.off("close", onClose);
      child.stdout.off("data", onData); child.stdout.off("end", onEnd); child.stdout.off("error", onStdoutError);
      child.stdin.off("error", onStdinError); child.stdin.off("drain", onDrain);
      child.stderr.off("data", onStderr); child.stderr.off("error", onStderrError); });
  }
  #protocolChanged(ctx: Context): void {
    if (!this.#active(ctx)) return;
    // Never forward raw protocol IDs/methods or payloads to diagnostic sinks.
    const notices = this.#session.takeEvents();
    if (notices.some(event => event.type === "diagnostic")) this.#diagnostic({ code: "protocol-notice" });
    if (this.#session.state === "failed" && !ctx.stopRequested) this.#fail(ctx, "protocol-failed");
    else this.#pump(ctx);
    this.#publish();
  }
  #pump(ctx: Context): void {
    if (!this.#active(ctx) || !ctx.spawned || ctx.exited || ctx.stopRequested || ctx.failure || ctx.writing || ctx.waitingDrain || !ctx.child) return;
    if (!this.#session.peekOutbound()) { this.#finishStart(ctx); return; }
    const frame = this.#session.takeNextOutbound()!;
    ctx.writing = true;
    try {
      const accepted = ctx.child.stdin.write(frame, "utf8", error => {
        if (!this.#active(ctx)) return;
        ctx.writing = false;
        if (error) this.#fail(ctx, "stdin-write-failed");
        else this.#pump(ctx);
      });
      if (!accepted) ctx.waitingDrain = true;
    } catch { ctx.writing = false; this.#fail(ctx, "stdin-write-failed"); }
  }
  #finishStart(ctx: Context): void {
    if (!this.#active(ctx) || ctx.exited || ctx.stopRequested || ctx.failure || !ctx.handshakeDone || ctx.writing || ctx.waitingDrain || this.#session.peekOutbound()) return;
    if (this.#state === "starting" || this.#state === "initializing") { this.#stateTo("ready"); ctx.resolveStart(); }
  }
  #fail(ctx: Context, code: string): void {
    if (!this.#active(ctx) || ctx.stopRequested || ctx.failure) return;
    ctx.failure = code; this.#diagnostic({ code });
    this.#session.disconnect(ctx.epoch, code, true); ctx.rejectStart(new HostOperationError(code));
    this.#stateTo("failed"); this.#shutdown(ctx);
  }
  #timer(ctx: Context, delay: number, action: () => void): void {
    const timer = setTimeout(() => { ctx.timers.delete(timer); if (this.#active(ctx)) action(); }, delay);
    ctx.timers.add(timer);
  }
  #shutdown(ctx: Context): void {
    if (ctx.shutdownStarted || !this.#active(ctx)) return;
    ctx.shutdownStarted = true;
    if (!ctx.child || ctx.exited) return;
    try { ctx.child.stdin.end(); } catch { /* Kill fallback is still available. */ }
    this.#timer(ctx, this.#grace, () => {
      if (ctx.exited) return;
      try { ctx.child!.kill("SIGTERM"); } catch { /* Escalate only this owned child. */ }
      this.#timer(ctx, this.#termGrace, () => {
        if (ctx.exited) return;
        try { ctx.child!.kill("SIGKILL"); } catch { /* Report a bounded shutdown failure. */ }
        this.#timer(ctx, this.#closeTimeout, () => {
          this.#diagnostic({ code: "shutdown-timeout" }); this.#stateTo("failed");
          ctx.rejectClosed(new HostOperationError("shutdown-timeout"));
          // Keep error listeners until actual close; do not claim cleanup or permit another child.
        });
      });
    });
  }
  #closed(ctx: Context): void {
    if (!this.#active(ctx)) return;
    if (!ctx.stdoutEnded && ctx.child) this.#session.end(ctx.epoch);
    if (!ctx.stopRequested && !ctx.failure && (ctx.exitCode !== 0 || ctx.signal !== null)) {
      ctx.failure = "process-exit-failed"; this.#diagnostic({ code: ctx.failure, exitCode: ctx.exitCode, signal: ctx.signal });
    }
    this.#session.disconnect(ctx.epoch, ctx.failure ?? "process-closed", !!ctx.failure);
    ctx.rejectStart(new HostOperationError(ctx.failure ?? "process-closed"));
    ctx.active = false; ctx.unsubscribe();
    for (const timer of ctx.timers) clearTimeout(timer); ctx.timers.clear();
    for (const cleanup of ctx.cleanup) cleanup(); ctx.cleanup = [];
    this.#context = null;
    if (this.#disposeRequested) this.#finalizeDispose();
    else this.#stateTo(ctx.stopRequested ? "stopped" : ctx.failure ? "failed" : "disconnected");
    ctx.resolveClosed();
  }
  stop(): Promise<void> { this.#intent++; return this.#stopOwned(); }
  async #stopOwned(): Promise<void> {
    const ctx = this.#context;
    if (!ctx) { if (this.#state !== "disposed") this.#stateTo("stopped"); return; }
    ctx.stopRequested = true; this.#stateTo("stopping");
    this.#session.disconnect(ctx.epoch, "host-stopped"); ctx.rejectStart(new HostOperationError("host-stopped"));
    this.#shutdown(ctx); await ctx.closed;
  }
  reconnect(): Promise<void> {
    if (this.#disposeRequested || this.#state === "disposed") return Promise.reject(new HostOperationError("host-disposed"));
    if (this.#reconnectPromise && this.#reconnectIntent === this.#intent) return this.#reconnectPromise;
    const intent = ++this.#intent;
    const result = (async () => {
      await this.#stopOwned();
      if (intent !== this.#intent || this.#disposeRequested) throw new HostOperationError("lifecycle-superseded");
      await this.#startOwned();
    })();
    this.#reconnectIntent = intent; this.#reconnectPromise = result;
    const clear = () => { if (this.#reconnectPromise === result) this.#reconnectPromise = null; };
    void result.then(clear, clear);
    return result;
  }
  #finalizeDispose(): void {
    if (this.#context) return;
    this.#listeners.clear(); this.#stateTo("disposed");
  }
  dispose(): Promise<void> {
    if (this.#state === "disposed") return Promise.resolve();
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposeRequested = true; this.#intent++;
    this.#disposePromise = this.#stopOwned().then(() => this.#finalizeDispose(), error => {
      this.#disposePromise = null; throw error;
    });
    return this.#disposePromise;
  }
  async configurationMcpOverrides(): Promise<string[]> {
    const config = await this.#readConfiguration(); assertOfficialRouteConfiguration(config); return disableConfiguredMcp(config);
  }
  async checkModelConfiguration(): Promise<void> { assertOfficialChatConfiguration(await this.#readConfiguration()); }
  async #readConfiguration(): Promise<Record<string, unknown>> {
    if (this.#state !== "ready" || !this.#context || this.#disposeRequested) throw new HostOperationError("not-ready");
    const response = this.#session.readConfiguration({ includeLayers: false }); this.#pump(this.#context); return (await response).config;
  }
  async listThreads(params: ThreadListParams): Promise<ThreadListResponse> {
    if (this.#state !== "ready" || !this.#context || this.#disposeRequested) throw new HostOperationError("not-ready");
    try { const response = this.#session.listThreads(params); this.#pump(this.#context); return await response; } catch (error) { throw this.#error(error); }
  }
  async startThread(params: ThreadStartParams): Promise<ThreadStartResponse> {
    if (this.#state !== "ready" || !this.#context || this.#disposeRequested) throw new HostOperationError("not-ready");
    try { const response = this.#session.startThread(params); this.#pump(this.#context); return await response; } catch (error) { throw this.#error(error); }
  }
  async startTurn(params: TurnStartParams): Promise<TurnStartResponse> {
    if (this.#state !== "ready" || !this.#context || this.#disposeRequested) throw new HostOperationError("not-ready");
    try { const response = this.#session.startTurn(params); this.#pump(this.#context); return await response; } catch (error) { throw this.#error(error); }
  }
  async interruptTurn(params: TurnInterruptParams): Promise<TurnInterruptResponse> {
    if (this.#state !== "ready" || !this.#context || this.#disposeRequested) throw new HostOperationError("not-ready");
    try { const response = this.#session.interruptTurn(params); this.#pump(this.#context); return await response; } catch (error) { throw this.#error(error); }
  }
  async checkOfficialRoute(): Promise<void> {
    if (this.#state !== "ready" || !this.#context || this.#disposeRequested) throw new HostOperationError("not-ready");
    try {
      const response = this.#session.readConfiguration({ includeLayers: false }); this.#pump(this.#context);
      assertOfficialRouteConfiguration((await response).config);
    } catch (error) {
      if (error instanceof Error && ["official-endpoint-not-confirmed", "lifecycle-callbacks-not-disabled"].includes(error.message)) throw new HostOperationError(error.message);
      throw this.#error(error);
    }
  }
  async getAccount(params: GetAccountParams): Promise<GetAccountResponse> {
    if (this.#state !== "ready" || !this.#context || this.#disposeRequested) throw new HostOperationError("not-ready");
    try { const result = this.#session.getAccount(params); this.#pump(this.#context); return await result; } catch (error) { throw this.#error(error); }
  }
  async listModels(params: ModelListParams): Promise<ModelListResponse> {
    if (this.#state !== "ready" || !this.#context || this.#disposeRequested) throw new HostOperationError("not-ready");
    try { const result = this.#session.listModels(params); this.#pump(this.#context); return await result; } catch (error) { throw this.#error(error); }
  }
  async readThreadMetadata(params: Pick<ThreadReadParams, "threadId">): Promise<ThreadReadResponse> {
    if (this.#state !== "ready" || !this.#context || this.#disposeRequested) throw new HostOperationError("not-ready");
    try { const result = this.#session.readThreadMetadata(params); this.#pump(this.#context); return await result; }
    catch (error) { throw this.#error(error); }
  }
  async readThread(params: ThreadReadParams): Promise<ThreadReadResponse> {
    if (this.#state !== "ready" || !this.#context || this.#disposeRequested) throw new HostOperationError("not-ready");
    try { const result = this.#session.readThread(params); this.#pump(this.#context); return await result; }
    catch (error) { throw this.#error(error); }
  }
  async listTurns(params: ThreadTurnsListParams): Promise<ThreadTurnsListResponse> {
    if (this.#state !== "ready" || !this.#context || this.#disposeRequested) throw new HostOperationError("not-ready");
    try { const result = this.#session.listTurns(params); this.#pump(this.#context); return await result; } catch (error) { throw this.#error(error); }
  }
  async listItems(params: ThreadItemsListParams): Promise<ThreadItemsListResponse> {
    if (this.#state !== "ready" || !this.#context || this.#disposeRequested) throw new HostOperationError("not-ready");
    try { const result = this.#session.listItems(params); this.#pump(this.#context); return await result; } catch (error) { throw this.#error(error); }
  }
  respondApproval(handle: ApprovalHandle, decision: ApprovalDecision): void {
    if (this.#state !== "ready" || !this.#context || this.#disposeRequested) throw new HostOperationError("not-ready");
    try { this.#session.respondApproval(handle, decision); this.#pump(this.#context); }
    catch (error) { throw this.#error(error); }
  }
  acknowledgeRecovery(): void { this.#session.acknowledgeRecovery(); this.#publish(); }
}
