import type { ThreadStartParams, ThreadStartResponse, TurnStartParams, TurnStartResponse, TurnInterruptParams, TurnInterruptResponse } from "./contracts.ts";
import type { ConfigReadParams, ConfigReadResponse, GetAccountParams, GetAccountResponse, ModelListParams, ModelListResponse } from "./contracts.ts";
import { JsonlDecoder } from "./jsonl.ts";
import { validate, contractManifest } from "./contracts.ts";
import type { InitializeResponse, ThreadReadParams, ThreadReadResponse, ThreadTurnsListParams, ThreadTurnsListResponse, ThreadItemsListParams, ThreadItemsListResponse } from "./contracts.ts";
import { Projection } from "./projection.ts";
import { createHash } from "node:crypto";

export type RequestId = string | number;
export type ConnectionState = "stopped" | "initializing" | "ready" | "disconnected" | "failed";
export type ApprovalDecision = "accept" | "decline" | "cancel";
export type ApprovalHandle = { epoch: number; id: RequestId; threadId: string };
export type ApprovalView = ApprovalHandle & { method: string; params: Record<string, unknown>; status: "pending" | "responded" | "resolved" };
export type SessionEvent = { type: string; method?: string; id?: RequestId; code?: string; state?: ConnectionState };
export class ProtocolSessionError extends Error {
  readonly code: string;
  readonly outcome: "not-sent" | "unknown";
  constructor(code: string, outcome: "not-sent" | "unknown" = "not-sent") {
    super(code); this.name = "ProtocolSessionError"; this.code = code; this.outcome = outcome;
  }
}
type Pending = {
  method: string; params: Record<string, unknown>; revision: number;
  resolve: (value: unknown) => void; reject: (reason: unknown) => void; timer: ReturnType<typeof setTimeout>;
};
type ServerEntry = { signature: string | null; view: ApprovalView | null; threadId: string | null; bytes: number };
type Outbound = { frame: string; bytes: number; id?: RequestId; kind: "request" | "response" | "notification" };
type Envelope = Record<string, unknown>;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value: object, key: string) => Object.hasOwn(value, key);
const validId = (id: unknown): id is RequestId => typeof id === "string" || (typeof id === "number" && Number.isSafeInteger(id));
const key = (id: RequestId) => `${typeof id}:${id}`;
const manifest = contractManifest();

/** Pure protocol engine: no process spawn, credentials, network, or automatic replay. */
export class ProtocolSession {
  #state: ConnectionState = "stopped";
  #epoch = 0;
  #counter = 0;
  #decoder: JsonlDecoder;
  #pending = new Map<string, Pending>();
  #server = new Map<string, ServerEntry>();
  #projection: Projection;
  #outbound: Outbound[] = [];
  #outboundBytes = 0;
  #events: SessionEvent[] = [];
  #eventsDropped = 0;
  #uncertain: { id: RequestId; method: string; threadId: string | null }[] = [];
  #staleApprovals: ApprovalView[] = [];
  #timeoutMs: number;
  #maxPending: number;
  #maxServerRequests: number;
  #maxFrameBytes: number;
  #maxOutboundBytes: number;
  #maxServerRequestBytes: number;
  #maxRecoveryBytes: number;
  #maxRecoveryEntries: number;
  #serverBytes = 0;
  #observers = new Set<() => void>();

  constructor(options: { timeoutMs?: number; maxPending?: number; maxServerRequests?: number; maxFrameBytes?: number; maxOutboundBytes?: number; maxProjectionBytes?: number; maxServerRequestBytes?: number; maxRecoveryBytes?: number; maxRecoveryEntries?: number } = {}) {
    for (const limit of Object.values(options)) {
      if (!Number.isSafeInteger(limit) || limit! < 1 || limit! > 2147483647) throw new Error("Invalid session limit");
    }
    this.#timeoutMs = options.timeoutMs ?? 30000;
    this.#maxPending = options.maxPending ?? 128;
    this.#maxServerRequests = options.maxServerRequests ?? 4096;
    this.#maxFrameBytes = options.maxFrameBytes ?? 1024 * 1024;
    this.#maxOutboundBytes = options.maxOutboundBytes ?? 4 * 1024 * 1024;
    this.#maxServerRequestBytes = options.maxServerRequestBytes ?? 8 * 1024 * 1024;
    this.#maxRecoveryBytes = options.maxRecoveryBytes ?? 8 * 1024 * 1024;
    this.#maxRecoveryEntries = options.maxRecoveryEntries ?? 4096;
    this.#decoder = new JsonlDecoder(this.#maxFrameBytes);
    this.#projection = new Projection(options.maxProjectionBytes);
  }
  get state(): ConnectionState { return this.#state; }
  get epoch(): number { return this.#epoch; }
  get pendingCount(): number { return this.#pending.size; }
  get eventsDropped(): number { return this.#eventsDropped; }
  snapshot() { return this.#projection.snapshot(); }
  approvals(): ApprovalView[] { return structuredClone([...this.#server.values()].flatMap(entry => entry.view ? [entry.view] : [])); }
  recoveryPlan() {
    const threadIds = new Set(this.snapshot().filter(thread => thread.stale).map(thread => thread.id));
    for (const pending of this.#uncertain) if (pending.threadId) threadIds.add(pending.threadId);
    for (const approval of this.#staleApprovals) threadIds.add(approval.threadId);
    return structuredClone({ threadIds: [...threadIds],
      uncertainRequests: this.#uncertain, staleApprovals: this.#staleApprovals, automaticReplay: false });
  }
  takeEvents(): SessionEvent[] { const events = this.#events; this.#events = []; return events; }
  takeOutbound(): string[] { const frames = this.#outbound.map(entry => entry.frame); this.#outbound = []; this.#outboundBytes = 0; return frames; }
  peekOutbound(): string | undefined { return this.#outbound[0]?.frame; }
  /** The transport calls this immediately before handing one frame to stdin. */
  takeNextOutbound(): string | undefined {
    const entry = this.#outbound.shift();
    if (entry) this.#outboundBytes -= entry.bytes;
    return entry?.frame;
  }
  subscribe(observer: () => void): () => void {
    if (this.#observers.size >= 128) throw new ProtocolSessionError("observer-limit");
    this.#observers.add(observer);
    return () => { this.#observers.delete(observer); };
  }
  /** Dismiss only old local recovery notices; does not approve, replay, or mark facts fresh. */
  acknowledgeRecovery(): void { this.#uncertain = []; this.#staleApprovals = []; }
  #event(event: SessionEvent): void {
    if (this.#events.length === 256) { this.#events.shift(); this.#eventsDropped++; }
    this.#events.push(event);
    for (const observer of this.#observers) {
      // Observers cannot change protocol correctness by throwing.
      try { observer(); } catch { /* Diagnostic consumers are isolated. */ }
    }
  }
  #setState(state: ConnectionState): void { this.#state = state; this.#event({ type: "state", state }); }
  #enqueue(message: object): void {
    const frame = JSON.stringify(message) + "\n";
    const bytes = Buffer.byteLength(frame);
    if (bytes > this.#maxFrameBytes || this.#outbound.length >= 512 || this.#outboundBytes + bytes > this.#maxOutboundBytes) {
      throw new ProtocolSessionError("outbound-limit");
    }
    const envelope = message as Envelope;
    const kind = own(envelope, "method") ? (own(envelope, "id") ? "request" : "notification") : "response";
    this.#outbound.push({ frame, bytes, kind, ...(own(envelope, "id") ? { id: envelope.id as RequestId } : {}) });
    this.#outboundBytes += bytes;
  }
  #dropQueued(id: RequestId, kind: "request" | "response"): boolean {
    let removed = false;
    this.#outbound = this.#outbound.filter(entry => {
      if (entry.kind === kind && entry.id !== undefined && key(entry.id) === key(id)) {
        this.#outboundBytes -= entry.bytes; removed = true; return false;
      }
      return true;
    });
    return removed;
  }
  #recoveryRecord(id: RequestId, pending: Pick<Pending, "method" | "params">) {
    return { id, method: pending.method, threadId: typeof pending.params.threadId === "string" ? pending.params.threadId : null };
  }
  #reserveRecovery(extra: unknown): void {
    const records: unknown[] = [...this.#uncertain, ...this.#staleApprovals,
      ...[...this.#pending.entries()].map(([id, pending]) => this.#recoveryRecord(id.slice("string:".length), pending)),
      ...this.approvals().filter(view => view.status !== "resolved"), extra];
    if (records.length > this.#maxRecoveryEntries || Buffer.byteLength(JSON.stringify(records)) + records.length * 256 > this.#maxRecoveryBytes) {
      throw new ProtocolSessionError("recovery-limit");
    }
  }
  connect(): { epoch: number; initialized: Promise<InitializeResponse> } {
    if (this.#state === "ready" || this.#state === "initializing") throw new ProtocolSessionError("already-connected");
    this.#epoch++; this.#counter = 0; this.#server.clear(); this.#serverBytes = 0;
    this.#decoder = new JsonlDecoder(this.#maxFrameBytes);
    this.#outbound = []; this.#outboundBytes = 0;
    this.#setState("initializing");
    const params = { clientInfo: manifest.client, capabilities: { experimentalApi: false, requestAttestation: false } };
    validate("initializeParams", params);
    try { return { epoch: this.#epoch, initialized: this.#send("initialize", params) as Promise<InitializeResponse> }; }
    catch (error) { this.disconnect(this.#epoch, "initialize-send-failed", true); throw error; }
  }
  readThread(params: ThreadReadParams): Promise<ThreadReadResponse> {
    return this.request("thread/read", params) as Promise<ThreadReadResponse>;
  }
  listTurns(params: ThreadTurnsListParams): Promise<ThreadTurnsListResponse> { return this.request("thread/turns/list", params) as Promise<ThreadTurnsListResponse>; }
  listItems(params: ThreadItemsListParams): Promise<ThreadItemsListResponse> { return this.request("thread/items/list", params) as Promise<ThreadItemsListResponse>; }
  startThread(params: ThreadStartParams): Promise<ThreadStartResponse> { return this.request("thread/start", params) as Promise<ThreadStartResponse>; }
  startTurn(params: TurnStartParams): Promise<TurnStartResponse> { return this.request("turn/start", params) as Promise<TurnStartResponse>; }
  interruptTurn(params: TurnInterruptParams): Promise<TurnInterruptResponse> { return this.request("turn/interrupt", params) as Promise<TurnInterruptResponse>; }
  readConfiguration(params: ConfigReadParams): Promise<ConfigReadResponse> { return this.request("config/read", params) as Promise<ConfigReadResponse>; }
  getAccount(params: GetAccountParams): Promise<GetAccountResponse> { return this.request("account/read", params) as Promise<GetAccountResponse>; }
  listModels(params: ModelListParams): Promise<ModelListResponse> { return this.request("model/list", params) as Promise<ModelListResponse>; }
  request(method: string, params: unknown): Promise<unknown> {
    if (this.#state !== "ready") throw new ProtocolSessionError("not-ready");
    const spec = Object.hasOwn(manifest.requests, method) ? manifest.requests[method] : undefined;
    if (!spec) {
      const experimental = manifest.experimental.deferredFamilies.some(prefix => method.startsWith(prefix));
      throw new ProtocolSessionError(experimental ? "experimental-disabled" : "unsupported-method");
    }
    if (spec.experimental) throw new ProtocolSessionError("experimental-disabled");
    validate(spec.params, params);
    const values = params as Record<string, unknown>;
    // The narrow M1 allowlist also rejects fields not yet reviewed, including experimental ones.
    const fields: Record<string, string[]> = { "thread/start": ["model", "modelProvider", "cwd", "approvalPolicy", "sandbox", "ephemeral", "baseInstructions", "developerInstructions"], "turn/start": ["threadId", "input", "model", "approvalPolicy", "sandboxPolicy"], "turn/interrupt": ["threadId", "turnId"], "config/read": ["includeLayers"], "account/read": ["refreshToken"], "model/list": ["cursor", "limit", "includeHidden"], "thread/read": ["threadId", "includeTurns"], "thread/turns/list": ["threadId", "cursor", "limit", "sortDirection", "itemsView"], "thread/items/list": ["threadId", "turnId", "cursor", "limit", "sortDirection"] };
    if (Object.keys(values).some(field => !fields[method]!.includes(field))) throw new ProtocolSessionError("unsupported-field");
    if (["turn/start", "turn/interrupt"].includes(method) && (typeof values.threadId !== "string" || !values.threadId.length || values.threadId.length > 64)) throw new ProtocolSessionError("invalid-turn-scope");
    if (method === "thread/start" && (values.modelProvider !== "openai" || values.ephemeral !== true || values.sandbox !== "read-only" || values.approvalPolicy !== "never" || typeof values.cwd !== "string" || !values.cwd.startsWith("/") || values.cwd.length > 4096 || typeof values.model !== "string" || !/^gpt-[a-z0-9.-]{1,100}$/.test(values.model))) throw new ProtocolSessionError("invalid-chat-thread");
    if (method === "turn/start") {
      const policy = values.sandboxPolicy as Record<string, unknown> | undefined;
      const input = values.input as { type?: string; text?: string; text_elements?: unknown[] }[];
      if (values.approvalPolicy !== "never" || policy?.type !== "readOnly" || policy.networkAccess !== false || Object.keys(policy).sort().join() !== "networkAccess,type" || typeof values.model !== "string" || !/^gpt-[a-z0-9.-]{1,100}$/.test(values.model) || input.length !== 1 || input[0]?.type !== "text" || typeof input[0].text !== "string" || !input[0].text.trim() || input[0].text.length > 4000 || input[0].text.includes("\0") || Object.keys(input[0]).sort().join() !== "text,text_elements,type" || input[0].text_elements?.length !== 0) throw new ProtocolSessionError("invalid-chat-input");
    }
    if (method === "turn/interrupt" && (typeof values.turnId !== "string" || !values.turnId.length || values.turnId.length > 64)) throw new ProtocolSessionError("invalid-turn-scope");
    if (method === "config/read" && values.includeLayers !== false) throw new ProtocolSessionError("config-layers-disabled");
    if (method === "account/read" && values.refreshToken !== undefined && values.refreshToken !== false) throw new ProtocolSessionError("explicit-refresh-disabled");
    if (method === "model/list") {
      if (values.limit !== undefined && values.limit !== null && (!Number.isSafeInteger(values.limit) || (values.limit as number) < 1 || (values.limit as number) > 100)) throw new ProtocolSessionError("invalid-page-limit");
      if (typeof values.cursor === "string" && values.cursor.length > 4096) throw new ProtocolSessionError("invalid-page-cursor");
    }
    if (method === "thread/turns/list" || method === "thread/items/list") {
      if (typeof values.threadId !== "string" || !values.threadId.length || values.threadId.length > 4096) throw new ProtocolSessionError("invalid-history-scope");
      if (values.limit !== undefined && values.limit !== null && (!Number.isSafeInteger(values.limit) || (values.limit as number) < 1 || (values.limit as number) > 100)) throw new ProtocolSessionError("invalid-page-limit");
      if (typeof values.cursor === "string" && values.cursor.length > 4096) throw new ProtocolSessionError("invalid-page-cursor");
      if (object(values.cursor)) {
        if (method !== "thread/items/list" || Object.keys(values.cursor).sort().join() !== "itemId,type" || values.cursor.type !== "item" || typeof values.cursor.itemId !== "string" || !values.cursor.itemId.length || values.cursor.itemId.length > 4096 || typeof values.turnId !== "string" || !values.turnId.length) throw new ProtocolSessionError("invalid-item-anchor");
      }
      if (values.turnId !== undefined && values.turnId !== null && (typeof values.turnId !== "string" || !values.turnId.length || values.turnId.length > 4096)) throw new ProtocolSessionError("invalid-history-scope");
    }
    return this.#send(method, values);
  }
  #send(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.#pending.size >= this.#maxPending) throw new ProtocolSessionError("pending-limit");
    const id = `wb:${this.#epoch}:${++this.#counter}`;
    this.#reserveRecovery(this.#recoveryRecord(id, { method, params }));
    this.#enqueue({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.#pending.get(key(id))!;
        this.#pending.delete(key(id));
        const removed = this.#dropQueued(id, "request");
        if (!removed) this.#uncertain.push(this.#recoveryRecord(id, pending));
        reject(new ProtocolSessionError("request-timeout", removed ? "not-sent" : "unknown"));
        this.#event({ type: "diagnostic", code: "request-timeout", id, method });
        if (method === "initialize") this.disconnect(this.#epoch, "initialize-timeout", true);
      }, this.#timeoutMs);
      timer.unref();
      this.#pending.set(key(id), { method, params: structuredClone(params), revision: this.#projection.revision(params.threadId as string), resolve, reject, timer });
    });
  }
  receive(bytes: Uint8Array, epoch: number): void {
    if (epoch !== this.#epoch || (this.#state !== "initializing" && this.#state !== "ready")) {
      this.#event({ type: "diagnostic", code: "stale-transport" }); return;
    }
    try {
      // Bound intermediate decoding allocations without treating host chunk
      // boundaries as protocol limits: a large batch may contain valid frames.
      for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024) {
        for (const message of this.#decoder.push(bytes.subarray(offset, offset + 64 * 1024))) {
          this.#dispatch(message);
          if (this.state !== "ready" && this.state !== "initializing") return;
        }
      }
    } catch {
      this.disconnect(epoch, "invalid-protocol", true);
    }
  }
  end(epoch: number): void {
    if (epoch !== this.#epoch || (this.#state !== "initializing" && this.#state !== "ready")) return;
    try { this.#decoder.end(); this.disconnect(epoch); }
    catch { this.disconnect(epoch, "truncated-jsonl", true); }
  }
  disconnect(epoch: number, code = "transport-closed", failed = false): void {
    if (epoch !== this.#epoch || (this.#state !== "initializing" && this.#state !== "ready")) return;
    for (const [id, pending] of this.#pending) {
      const requestId = id.slice("string:".length);
      const removed = this.#dropQueued(requestId, "request");
      if (!removed) this.#uncertain.push(this.#recoveryRecord(requestId, pending));
      clearTimeout(pending.timer);
      pending.reject(new ProtocolSessionError(code, removed ? "not-sent" : "unknown"));
    }
    this.#staleApprovals.push(...this.approvals().filter(view => view.status !== "resolved"));
    this.#pending.clear(); this.#server.clear(); this.#serverBytes = 0; this.#outbound = []; this.#outboundBytes = 0;
    this.#projection.markStale();
    this.#setState(failed ? "failed" : "disconnected");
    this.#event({ type: "diagnostic", code });
  }
  #dispatch(value: unknown): void {
    if (!object(value)) throw new Error("Invalid envelope");
    const hasId = own(value, "id"), hasMethod = own(value, "method"), hasResult = own(value, "result"), hasError = own(value, "error");
    if (hasId && !validId(value.id)) throw new Error("Invalid request id");
    if (hasMethod) {
      if (typeof value.method !== "string" || hasResult || hasError) throw new Error("Invalid method envelope");
      if (this.#state !== "ready") throw new Error("Method received before initialization");
      if (hasId) this.#serverRequest(value.id as RequestId, value.method, value.params);
      else this.#notification(value.method, value.params);
    } else {
      if (!hasId || hasResult === hasError) throw new Error("Invalid response envelope");
      if (hasError && (!object(value.error) || !Number.isSafeInteger(value.error.code) || typeof value.error.message !== "string")) throw new Error("Invalid RPC error");
      this.#response(value);
    }
  }
  #response(message: Envelope): void {
    const id = message.id as RequestId;
    const pending = this.#pending.get(key(id));
    if (!pending) { this.#event({ type: "diagnostic", code: "unmatched-response", id }); return; }
    if (own(message, "error")) {
      this.#pending.delete(key(id)); clearTimeout(pending.timer);
      pending.reject(new ProtocolSessionError(`rpc-error:${(message.error as Envelope).code}`, "unknown"));
      if (pending.method === "initialize") this.disconnect(this.#epoch, "initialize-rejected", true);
      return;
    }
    const schema = pending.method === "initialize" ? "initializeResult" : manifest.requests[pending.method]!.result;
    validate(schema, message.result);
    if (pending.method === "initialize") {
      this.#enqueue({ method: "initialized" });
      this.#setState("ready");
    } else if (pending.method === "thread/read") {
      const result = message.result as ThreadReadResponse;
      if (result.thread.id !== pending.params.threadId) throw new Error("Thread read response mismatch");
      const applied = this.#projection.hydrate(result.thread, pending.params.includeTurns === true, pending.revision);
      if (applied) this.#uncertain = this.#uncertain.filter(record => record.method !== "thread/read" || record.threadId !== result.thread.id);
      this.#event({ type: applied ? "snapshot-applied" : "snapshot-obsolete", method: pending.method, id });
    }
    if (pending.method === "thread/turns/list" || pending.method === "thread/items/list") {
      const result = message.result as ThreadTurnsListResponse | ThreadItemsListResponse;
      if (result.data.length > (typeof pending.params.limit === "number" ? pending.params.limit : 100) || [result.nextCursor, result.backwardsCursor].some(cursor => cursor !== null && cursor.length > 4096)) throw new Error("Invalid bounded history page");
      if (pending.method === "thread/items/list" && typeof pending.params.turnId === "string" && (result as ThreadItemsListResponse).data.some(entry => entry.turnId !== pending.params.turnId)) throw new Error("Item page turn mismatch");
      this.#event({ type: "history-page", method: pending.method, id });
    }
    if (pending.method === "thread/start") {
      const result = message.result as ThreadStartResponse;
      if (result.modelProvider !== "openai" || result.model !== pending.params.model || result.cwd !== pending.params.cwd || result.thread.cwd !== pending.params.cwd || result.sandbox.type !== "readOnly" || result.sandbox.networkAccess !== false || result.thread.modelProvider !== "openai" || result.approvalPolicy !== "never" || result.thread.ephemeral !== true) throw new Error("Thread start configuration mismatch");
      this.#projection.apply("thread/started", { thread: result.thread }); this.#event({ type: "notification", method: pending.method });
    }
    if (pending.method === "turn/start") {
      const result = message.result as TurnStartResponse;
      this.#projection.apply(result.turn.status === "inProgress" ? "turn/started" : "turn/completed", { threadId: pending.params.threadId, turn: result.turn }); this.#event({ type: "notification", method: pending.method });
    }
    if (pending.method === "model/list") { const result = message.result as ModelListResponse; if (result.data.length > (typeof pending.params.limit === "number" ? pending.params.limit : 100) || (result.nextCursor !== null && result.nextCursor.length > 4096)) throw new Error("Invalid bounded model page"); }
    this.#pending.delete(key(id)); clearTimeout(pending.timer); pending.resolve(structuredClone(message.result));
  }
  #notification(method: string, params: unknown): void {
    const schema = Object.hasOwn(manifest.notifications, method) ? manifest.notifications[method] : undefined;
    if (!schema) { this.#event({ type: "diagnostic", code: "unknown-notification", method }); return; }
    validate(schema, params);
    const values = params as Record<string, unknown>;
    if (method === "serverRequest/resolved") {
      const id = values.requestId as RequestId;
      if (!validId(id)) throw new Error("Invalid resolved request id");
      const entry = this.#server.get(key(id));
      if (entry && entry.threadId !== values.threadId) { this.#event({ type: "diagnostic", code: "resolved-thread-mismatch", id }); return; }
      this.#dropQueued(id, "response");
      if (entry?.view) {
        entry.view.status = "resolved"; entry.view.params = {};
        this.#refreshServerBytes(id, entry);
      }
      if (!entry) this.#storeServer(id, { signature: null, view: null, threadId: values.threadId as string });
      this.#event({ type: "approval-resolved", id });
    } else {
      const applied = this.#projection.apply(method, values);
      this.#event({ type: applied ? "notification" : "notification-obsolete", method });
    }
  }
  #refreshServerBytes(id: RequestId, entry: ServerEntry): void {
    // Reserve the longest status label up front so a decision cannot exceed the
    // budget after its response has already been queued.
    const view = entry.view ? { ...entry.view, status: "responded" } : null;
    const bytes = Buffer.byteLength(key(id)) + Buffer.byteLength(JSON.stringify({ signature: entry.signature, view, threadId: entry.threadId }));
    this.#serverBytes += bytes - entry.bytes; entry.bytes = bytes;
    if (this.#serverBytes > this.#maxServerRequestBytes) throw new Error("Server request byte limit exceeded");
  }
  #storeServer(id: RequestId, values: Omit<ServerEntry, "bytes">): void {
    if (this.#server.size >= this.#maxServerRequests) throw new Error("Server request limit exceeded");
    const entry = { ...values, bytes: 0 };
    this.#refreshServerBytes(id, entry);
    this.#server.set(key(id), entry);
  }
  #serverRequest(id: RequestId, method: string, params: unknown): void {
    const signature = createHash("sha256").update(JSON.stringify({ method, params })).digest("hex");
    const previous = this.#server.get(key(id));
    if (previous) {
      if (previous.signature === null) { this.#event({ type: "diagnostic", code: "resolved-request-reissued", id }); return; }
      if (previous.signature !== signature) throw new Error("Conflicting server request id");
      this.#event({ type: "diagnostic", code: "duplicate-server-request", id }); return;
    }
    const spec = Object.hasOwn(manifest.serverRequests, method) ? manifest.serverRequests[method] : undefined;
    if (!spec) {
      this.#storeServer(id, { signature, view: null, threadId: null });
      this.#enqueue({ id, error: { code: -32601, message: "Client method not implemented" } });
      this.#event({ type: "diagnostic", code: "unsupported-server-request", method, id }); return;
    }
    validate(spec.params, params);
    const values = params as Record<string, unknown>;
    // These fields are gated in 0.162.1; this client does not opt into them.
    if (own(values, "additionalPermissions") || own(values, "availableDecisions")) throw new Error("Unexpected experimental approval field");
    const view: ApprovalView = { epoch: this.#epoch, id, threadId: values.threadId as string, method,
      params: structuredClone(values), status: "pending" };
    this.#reserveRecovery(view);
    this.#storeServer(id, { signature, view, threadId: view.threadId });
    this.#event({ type: "approval-pending", method, id });
  }
  respondApproval(handle: ApprovalHandle, decision: ApprovalDecision): void {
    if (this.#state !== "ready" || handle.epoch !== this.#epoch) throw new ProtocolSessionError("stale-approval");
    const view = this.#server.get(key(handle.id))?.view;
    if (!view || view.threadId !== handle.threadId || view.status !== "pending") throw new ProtocolSessionError("approval-not-pending");
    if (decision !== "accept" && decision !== "decline" && decision !== "cancel") throw new ProtocolSessionError("unsupported-approval-decision");
    const result = { decision };
    validate(manifest.serverRequests[view.method]!.result, result);
    this.#enqueue({ id: handle.id, result });
    // Sending is not server acknowledgement; await serverRequest/resolved.
    view.status = "responded";
    this.#refreshServerBytes(handle.id, this.#server.get(key(handle.id))!);
    this.#event({ type: "approval-responded", id: handle.id });
  }
}
