import type { ThreadSectionUpdateParams, ThreadSectionUpdateResponse, ThreadSectionListParams, ThreadSectionListResponse, ThreadSectionCreateParams, ThreadSectionCreateResponse, ThreadSectionMoveParams, ThreadSectionMoveResponse } from "./contracts.ts";
import type { ThreadResumeParams, ThreadResumeResponse, ThreadForkParams, ThreadForkResponse, ThreadSetNameParams, ThreadSetNameResponse, ThreadArchiveParams, ThreadArchiveResponse, ThreadUnarchiveParams, ThreadUnarchiveResponse } from "./contracts.ts";
import type { ThreadSearchParams, ThreadSearchResponse, ThreadListParams, ThreadListResponse } from "./contracts.ts";
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
  method: string; params: Record<string, unknown>; revision: number; projectRead: boolean;
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
  #searchApi: boolean;
  #maxPending: number;
  #maxServerRequests: number;
  #maxFrameBytes: number;
  #maxOutboundBytes: number;
  #maxServerRequestBytes: number;
  #maxRecoveryBytes: number;
  #maxRecoveryEntries: number;
  #serverBytes = 0;
  #observers = new Set<() => void>();

  constructor(options: { searchApi?:boolean; timeoutMs?: number; maxPending?: number; maxServerRequests?: number; maxFrameBytes?: number; maxOutboundBytes?: number; maxProjectionBytes?: number; maxServerRequestBytes?: number; maxRecoveryBytes?: number; maxRecoveryEntries?: number } = {}) {
    this.#searchApi=options.searchApi===true;
    if(options.searchApi!==undefined&&typeof options.searchApi!=="boolean")throw new Error("Invalid search capability");
    for (const [name,limit] of Object.entries(options)) {
      if(name==="searchApi")continue;
      if (typeof limit!=="number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 2147483647) throw new Error("Invalid session limit");
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
    const params = { clientInfo: manifest.client, capabilities: { experimentalApi: this.#searchApi, requestAttestation: false } };
    validate("initializeParams", params);
    try { return { epoch: this.#epoch, initialized: this.#send("initialize", params) as Promise<InitializeResponse> }; }
    catch (error) { this.disconnect(this.#epoch, "initialize-send-failed", true); throw error; }
  }
  readThread(params: ThreadReadParams): Promise<ThreadReadResponse> {
    return this.request("thread/read", params) as Promise<ThreadReadResponse>;
  }
  /** Validated metadata only, without retaining unrelated saved threads in the live projection. */
  readThreadMetadata(params: Pick<ThreadReadParams, "threadId">): Promise<ThreadReadResponse> {
    if (!object(params) || Object.keys(params).join() !== "threadId") throw new ProtocolSessionError("unsupported-field");
    return this.#request("thread/read", { ...params, includeTurns: false }, false) as Promise<ThreadReadResponse>;
  }
  listTurns(params: ThreadTurnsListParams): Promise<ThreadTurnsListResponse> { return this.request("thread/turns/list", params) as Promise<ThreadTurnsListResponse>; }
  listItems(params: ThreadItemsListParams): Promise<ThreadItemsListResponse> { return this.request("thread/items/list", params) as Promise<ThreadItemsListResponse>; }
  resumeThread(params: ThreadResumeParams): Promise<ThreadResumeResponse> { return this.request("thread/resume", params) as Promise<ThreadResumeResponse>; }
  forkThread(params: ThreadForkParams): Promise<ThreadForkResponse> { return this.request("thread/fork", params) as Promise<ThreadForkResponse>; }
  renameThread(params: ThreadSetNameParams): Promise<ThreadSetNameResponse> { return this.request("thread/name/set", params) as Promise<ThreadSetNameResponse>; }
  archiveThread(params: ThreadArchiveParams): Promise<ThreadArchiveResponse> { return this.request("thread/archive", params) as Promise<ThreadArchiveResponse>; }
  unarchiveThread(params: ThreadUnarchiveParams): Promise<ThreadUnarchiveResponse> { return this.request("thread/unarchive", params) as Promise<ThreadUnarchiveResponse>; }
  startThread(params: ThreadStartParams): Promise<ThreadStartResponse> { return this.request("thread/start", params) as Promise<ThreadStartResponse>; }
  startTurn(params: TurnStartParams): Promise<TurnStartResponse> { return this.request("turn/start", params) as Promise<TurnStartResponse>; }
  interruptTurn(params: TurnInterruptParams): Promise<TurnInterruptResponse> { return this.request("turn/interrupt", params) as Promise<TurnInterruptResponse>; }
  updateSection(params: ThreadSectionUpdateParams): Promise<ThreadSectionUpdateResponse> { return this.request("threadSection/update",params) as Promise<ThreadSectionUpdateResponse>; }
  listSections(params: ThreadSectionListParams): Promise<ThreadSectionListResponse> { return this.request("threadSection/list",params) as Promise<ThreadSectionListResponse>; }
  createSection(params: ThreadSectionCreateParams): Promise<ThreadSectionCreateResponse> { return this.request("threadSection/create",params) as Promise<ThreadSectionCreateResponse>; }
  moveToSection(params: ThreadSectionMoveParams): Promise<ThreadSectionMoveResponse> { return this.request("thread/section/move",params) as Promise<ThreadSectionMoveResponse>; }
  searchThreads(params:ThreadSearchParams):Promise<ThreadSearchResponse>{return this.request("thread/search",params) as Promise<ThreadSearchResponse>;}
  listThreads(params: ThreadListParams): Promise<ThreadListResponse> { return this.request("thread/list", params) as Promise<ThreadListResponse>; }
  readConfiguration(params: ConfigReadParams): Promise<ConfigReadResponse> { return this.request("config/read", params) as Promise<ConfigReadResponse>; }
  getAccount(params: GetAccountParams): Promise<GetAccountResponse> { return this.request("account/read", params) as Promise<GetAccountResponse>; }
  listModels(params: ModelListParams): Promise<ModelListResponse> { return this.request("model/list", params) as Promise<ModelListResponse>; }
  request(method: string, params: unknown): Promise<unknown> { return this.#request(method, params); }
  #request(method: string, params: unknown, projectRead = true): Promise<unknown> {
    if (this.#state !== "ready") throw new ProtocolSessionError("not-ready");
    const spec = Object.hasOwn(manifest.requests, method) ? manifest.requests[method] : undefined;
    if (!spec) {
      const experimental = manifest.experimental.deferredFamilies.some(prefix => method.startsWith(prefix));
      throw new ProtocolSessionError(experimental ? "experimental-disabled" : "unsupported-method");
    }
    if (spec.experimental && !(method==="thread/search"&&this.#searchApi&&manifest.experimental.implementedMethods.includes(method))) throw new ProtocolSessionError("experimental-disabled");
    validate(spec.params, params);
    const values = params as Record<string, unknown>;
    // The narrow M1 allowlist also rejects fields not yet reviewed, including experimental ones.
    const fields: Record<string, string[]> = { "threadSection/update":["sectionId","name"],"threadSection/list":["cursor","limit"],"threadSection/create":["name"],"thread/section/move":["threadId","sectionId","beforeThreadId"], "thread/resume": ["threadId","model","modelProvider","cwd","approvalPolicy","sandbox","baseInstructions","developerInstructions","excludeTurns"], "thread/fork": ["lastTurnId","threadId","model","modelProvider","cwd","approvalPolicy","sandbox","baseInstructions","developerInstructions","ephemeral","excludeTurns"], "thread/name/set": ["threadId","name"], "thread/archive": ["threadId"], "thread/unarchive": ["threadId"], "thread/search":["cursor","limit","sortKey","sortDirection","sourceKinds","archived","searchTerm"], "thread/list": ["searchTerm","sectionId","cursor", "limit", "sortKey", "sortDirection", "modelProviders", "sourceKinds", "archived"], "thread/start": ["model", "modelProvider", "cwd", "approvalPolicy", "sandbox", "ephemeral", "baseInstructions", "developerInstructions"], "turn/start": ["threadId", "input", "model", "approvalPolicy", "sandboxPolicy"], "turn/interrupt": ["threadId", "turnId"], "config/read": ["includeLayers"], "account/read": ["refreshToken"], "model/list": ["cursor", "limit", "includeHidden"], "thread/read": ["threadId", "includeTurns"], "thread/turns/list": ["threadId", "cursor", "limit", "sortDirection", "itemsView"], "thread/items/list": ["threadId", "turnId", "cursor", "limit", "sortDirection"] };
    if (Object.keys(values).some(field => !fields[method]!.includes(field))) throw new ProtocolSessionError("unsupported-field");
    const validId=(value:unknown)=>typeof value==="string"&&/^[a-z0-9-]{1,64}$/.test(value);
    if(method==="thread/fork"&&values.lastTurnId!==undefined&&!validId(values.lastTurnId))throw new ProtocolSessionError("invalid-fork-boundary");
    if(method==="threadSection/update"&&(!validId(values.sectionId)||typeof values.name!=="string"||!values.name.trim()||values.name.length>80||/[\x00-\x1f]/.test(values.name)))throw new ProtocolSessionError("invalid-section-update");
    if(method==="thread/section/move"&&values.beforeThreadId!==undefined&&(!validId(values.beforeThreadId)||values.beforeThreadId===values.threadId||values.sectionId===null))throw new ProtocolSessionError("invalid-section-anchor");
    if(method==="threadSection/list" && (values.limit!==20 || !(values.cursor===undefined||values.cursor===null||typeof values.cursor==="string"&&values.cursor.length<=4096)))throw new ProtocolSessionError("invalid-section-page");
    if(method==="threadSection/create" && (typeof values.name!=="string"||!values.name.trim()||values.name.length>80||/[\x00-\x1f]/.test(values.name)))throw new ProtocolSessionError("invalid-section-name");
    if(method==="thread/section/move" && (typeof values.threadId!=="string"||!/^[a-z0-9-]{1,64}$/.test(values.threadId)||!(values.sectionId===null||typeof values.sectionId==="string"&&/^[a-z0-9-]{1,64}$/.test(values.sectionId))))throw new ProtocolSessionError("invalid-section-scope");

    if (["turn/start", "turn/interrupt"].includes(method) && (typeof values.threadId !== "string" || !values.threadId.length || values.threadId.length > 64)) throw new ProtocolSessionError("invalid-turn-scope");
    if (method === "thread/start" && (values.modelProvider !== "openai" || typeof values.ephemeral !== "boolean" || values.sandbox !== "read-only" || values.approvalPolicy !== "never" || typeof values.cwd !== "string" || !values.cwd.startsWith("/") || values.cwd.length > 4096 || typeof values.model !== "string" || !/^gpt-[a-z0-9.-]{1,100}$/.test(values.model))) throw new ProtocolSessionError("invalid-chat-thread");
    if (["thread/resume","thread/fork","thread/name/set","thread/archive","thread/unarchive"].includes(method) && (typeof values.threadId !== "string" || !/^[a-z0-9-]{1,64}$/.test(values.threadId))) throw new ProtocolSessionError("invalid-session-scope");
    if (["thread/resume","thread/fork"].includes(method) && (values.modelProvider !== "openai" || values.sandbox !== "read-only" || values.approvalPolicy !== "never" || values.excludeTurns !== true || typeof values.cwd !== "string" || !values.cwd.startsWith("/") || values.cwd.length > 4096 || typeof values.model !== "string" || !/^gpt-[a-z0-9.-]{1,100}$/.test(values.model) || (method === "thread/fork" && values.ephemeral !== false))) throw new ProtocolSessionError("invalid-session-resume");
    if (method === "thread/name/set" && (typeof values.name !== "string" || !values.name.trim() || values.name.length > 100 || /[\x00-\x1f]/.test(values.name))) throw new ProtocolSessionError("invalid-session-name");
    if (method === "turn/start") {
      const policy = values.sandboxPolicy as Record<string, unknown> | undefined;
      const input = values.input as { type?: string; text?: string; text_elements?: unknown[] }[];
      if (values.approvalPolicy !== "never" || policy?.type !== "readOnly" || policy.networkAccess !== false || Object.keys(policy).sort().join() !== "networkAccess,type" || typeof values.model !== "string" || !/^gpt-[a-z0-9.-]{1,100}$/.test(values.model) || input.length !== 1 || input[0]?.type !== "text" || typeof input[0].text !== "string" || !input[0].text.trim() || input[0].text.length > 4000 || input[0].text.includes("\0") || Object.keys(input[0]).sort().join() !== "text,text_elements,type" || input[0].text_elements?.length !== 0) throw new ProtocolSessionError("invalid-chat-input");
    }
    if (method === "turn/interrupt" && (typeof values.turnId !== "string" || !values.turnId.length || values.turnId.length > 64)) throw new ProtocolSessionError("invalid-turn-scope");
    if (method === "config/read" && values.includeLayers !== false) throw new ProtocolSessionError("config-layers-disabled");
    if (method === "account/read" && values.refreshToken !== undefined && values.refreshToken !== false) throw new ProtocolSessionError("explicit-refresh-disabled");
    if(["thread/list","thread/search"].includes(method)&&values.searchTerm!==undefined&&(typeof values.searchTerm!=="string"||!values.searchTerm.trim()||values.searchTerm.length>128||/[\x00-\x1f]/.test(values.searchTerm)))throw new ProtocolSessionError("invalid-search-term");
    if (method === "thread/list" || method === "thread/search") {
      if(values.sectionId!==undefined&&values.sectionId!==null&&!validId(values.sectionId))throw new ProtocolSessionError("invalid-section-filter");
      if(values.sortKey==="section_position"&&!validId(values.sectionId))throw new ProtocolSessionError("section-sort-requires-filter");
      if(values.sourceKinds!==undefined && (!Array.isArray(values.sourceKinds)||values.sourceKinds.length>10||values.sourceKinds.some(kind=>!["cli","vscode","exec","appServer","subAgent","subAgentReview","subAgentCompact","subAgentThreadSpawn","subAgentOther","unknown"].includes(kind as string))))throw new ProtocolSessionError("invalid-source-filter");
      if (values.modelProviders !== undefined && (!Array.isArray(values.modelProviders) || values.modelProviders.length > 16 || values.modelProviders.some(value => typeof value !== "string" || value.length > 64))) throw new ProtocolSessionError("invalid-provider-filter");
    }
    if (method === "model/list" || method === "thread/list" || method === "thread/search") {
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
    return this.#send(method, values, projectRead);
  }
  #send(method: string, params: Record<string, unknown>, projectRead = true): Promise<unknown> {
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
      this.#pending.set(key(id), { method, projectRead, params: structuredClone(params), revision: this.#projection.revision(params.threadId as string), resolve, reject, timer });
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
      const applied = pending.projectRead && this.#projection.hydrate(result.thread, pending.params.includeTurns === true, pending.revision);
      if (applied || !pending.projectRead) this.#uncertain = this.#uncertain.filter(record => record.method !== "thread/read" || record.threadId !== result.thread.id);
      this.#event({ type: !pending.projectRead ? "metadata-read" : applied ? "snapshot-applied" : "snapshot-obsolete", method: pending.method, id });
    }
    if (pending.method === "thread/unarchive" && (message.result as ThreadUnarchiveResponse).thread.id !== pending.params.threadId) throw new Error("Thread unarchive response mismatch");
    if (pending.method === "thread/turns/list" || pending.method === "thread/items/list") {
      const result = message.result as ThreadTurnsListResponse | ThreadItemsListResponse;
      if (result.data.length > (typeof pending.params.limit === "number" ? pending.params.limit : 100) || [result.nextCursor, result.backwardsCursor].some(cursor => cursor !== null && cursor.length > 4096)) throw new Error("Invalid bounded history page");
      if (pending.method === "thread/items/list" && typeof pending.params.turnId === "string" && (result as ThreadItemsListResponse).data.some(entry => entry.turnId !== pending.params.turnId)) throw new Error("Item page turn mismatch");
      this.#event({ type: "history-page", method: pending.method, id });
    }
    if (pending.method === "thread/start") {
      const result = message.result as ThreadStartResponse;
      if (result.modelProvider !== "openai" || result.model !== pending.params.model || result.cwd !== pending.params.cwd || result.thread.cwd !== pending.params.cwd || result.sandbox.type !== "readOnly" || result.sandbox.networkAccess !== false || result.thread.modelProvider !== "openai" || result.approvalPolicy !== "never" || result.thread.ephemeral !== pending.params.ephemeral) throw new Error("Thread start configuration mismatch");
      this.#projection.apply("thread/started", { thread: result.thread }); this.#event({ type: "notification", method: pending.method });
    }
    if(pending.method==="thread/fork"){const thread=(message.result as ThreadForkResponse).thread;if(thread.id===pending.params.threadId||thread.forkedFromId!==pending.params.threadId||!/^[a-z0-9-]{1,64}$/.test(thread.id))throw new Error("Fork identity mismatch");}
    if (pending.method === "thread/resume" || pending.method === "thread/fork") {
      const result = message.result as ThreadResumeResponse | ThreadForkResponse;
      if (result.modelProvider !== "openai" || result.thread.modelProvider !== "openai" || result.model !== pending.params.model || result.cwd !== pending.params.cwd || result.thread.cwd !== pending.params.cwd || result.sandbox.type !== "readOnly" || result.sandbox.networkAccess !== false || result.approvalPolicy !== "never" || result.thread.ephemeral || result.thread.turns.length || result.thread.status.type === "active" || (pending.method === "thread/resume" && result.thread.id !== pending.params.threadId)) throw new Error("Resume configuration mismatch");
      this.#projection.replaceMetadata(result.thread); this.#event({type:"snapshot-applied",method:pending.method,id});
    }

    if(pending.method==="threadSection/list"){const page=message.result as ThreadSectionListResponse;if(page.data.length>20||(page.nextCursor!==null&&page.nextCursor.length>4096)||page.data.some(section=>!/^[a-z0-9-]{1,64}$/.test(section.id)||section.name.length>200))throw new Error("Unbounded section page");}
    if(pending.method==="threadSection/update"){const section=(message.result as ThreadSectionUpdateResponse).section;if(section.id!==pending.params.sectionId||section.name!==String(pending.params.name).trim())throw new Error("Section update mismatch");}
    if(pending.method==="threadSection/create"){const section=(message.result as ThreadSectionCreateResponse).section;if(!/^[a-z0-9-]{1,64}$/.test(section.id)||section.name!==String(pending.params.name).trim())throw new Error("Section create mismatch");}
    if (pending.method === "turn/start") {
      const result = message.result as TurnStartResponse;
      this.#projection.apply(result.turn.status === "inProgress" ? "turn/started" : "turn/completed", { threadId: pending.params.threadId, turn: result.turn }); this.#event({ type: "notification", method: pending.method });
    }
    if (pending.method === "thread/list" || pending.method === "thread/search") { const result = message.result as ThreadListResponse; if (result.data.length > (typeof pending.params.limit === "number" ? pending.params.limit : 100) || [result.nextCursor, result.backwardsCursor].some(cursor => cursor !== null && (typeof cursor !== "string" || cursor.length > 4096))) throw new Error("Invalid bounded thread page"); }
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
