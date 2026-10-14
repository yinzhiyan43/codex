import type { Thread, Turn, ThreadItem } from "./contracts.ts";

export type ItemView = { id: string; value: ThreadItem | null; text: string; completed: boolean };
export type TurnView = { id: string; status: Turn["status"]; stale: boolean; items: ItemView[] };
export type ThreadView = { id: string; metadata: Thread | null; stale: boolean; revision: number; turns: TurnView[] };
type StoredTurn = Omit<TurnView, "items"> & { items: Map<string, ItemView> };
type StoredThread = Omit<ThreadView, "turns"> & { turns: Map<string, StoredTurn>; bytes: number };
const terminal = (status: Turn["status"]) => status !== "inProgress";

/** A bounded display projection. It is never an execution or history authority. */
export class Projection {
  #threads = new Map<string, StoredThread>();
  #totalBytes = 0;
  #limit: number;
  constructor(maxBytes = 16 * 1024 * 1024) { this.#limit = maxBytes; }
  revision(threadId: string): number { return this.#threads.get(threadId)?.revision ?? 0; }
  snapshot(): ThreadView[] { return structuredClone([...this.#threads.values()].map(thread => this.#view(thread))); }
  markStale(): void {
    for (const thread of this.#threads.values()) {
      thread.stale = true;
      for (const turn of thread.turns.values()) turn.stale = true;
    }
  }
  #view(thread: StoredThread): ThreadView {
    return { id: thread.id, metadata: thread.metadata, stale: thread.stale, revision: thread.revision,
      turns: [...thread.turns.values()].map(turn => ({ ...turn, items: [...turn.items.values()] })) };
  }
  #thread(id: string): StoredThread {
    let thread = this.#threads.get(id);
    if (!thread) {
      if (this.#threads.size >= 128) throw new Error("Thread projection limit exceeded");
      thread = { id, metadata: null, stale: false, revision: 0, turns: new Map(), bytes: 0 };
      this.#threads.set(id, thread);
    }
    return thread;
  }
  #turn(thread: StoredThread, id: string): StoredTurn {
    let turn = thread.turns.get(id);
    if (!turn) {
      if (thread.turns.size >= 256) throw new Error("Turn projection limit exceeded");
      turn = { id, status: "inProgress", stale: thread.stale, items: new Map() };
      thread.turns.set(id, turn);
    }
    return turn;
  }
  #setItem(turn: StoredTurn, item: ThreadItem, completed: boolean): void {
    if (!turn.items.has(item.id) && turn.items.size >= 512) throw new Error("Item projection limit exceeded");
    turn.items.set(item.id, { id: item.id, value: structuredClone(item),
      text: item.type === "agentMessage" ? item.text : "", completed });
  }
  #changed(thread: StoredThread): void {
    thread.revision++;
    const bytes = Buffer.byteLength(JSON.stringify(this.#view(thread)));
    this.#totalBytes += bytes - thread.bytes;
    thread.bytes = bytes;
    if (this.#totalBytes > this.#limit) throw new Error("Projection byte limit exceeded");
  }
  replaceMetadata(thread: Thread): void {
    const old = this.#threads.get(thread.id);
    if (old && !old.stale && [...old.turns.values()].some(turn=>turn.status==="inProgress")) throw new Error("Cannot replace active projection");
    if (old) { this.#threads.delete(thread.id); this.#totalBytes -= old.bytes; }
    const value = this.#thread(thread.id); value.metadata = structuredClone({...thread,turns:[]}); this.#changed(value);
  }
  hydrate(thread: Thread, includeTurns: boolean, expectedRevision: number): boolean {
    const view = this.#thread(thread.id);
    if (view.revision !== expectedRevision) return false;
    view.metadata = structuredClone({ ...thread, turns: [] });
    if (includeTurns) {
      for (const payload of thread.turns) {
        const turn = this.#turn(view, payload.id);
        turn.status = payload.status;
        // Only a full item view may replace a previously streamed item set.
        if (payload.itemsView === "full") { turn.items.clear(); turn.stale = false; }
        for (const item of payload.items) this.#setItem(turn, item, terminal(payload.status));
      }
      view.stale = [...view.turns.values()].some(turn => turn.stale);
    }
    this.#changed(view);
    return true;
  }
  apply(method: string, params: Record<string, unknown>): boolean {
    if (method === "thread/started") {
      const payload = params.thread as Thread;
      const thread = this.#thread(payload.id);
      thread.metadata = structuredClone({ ...payload, turns: [] });
      this.#changed(thread);
      return true;
    }
    const thread = this.#thread(params.threadId as string);
    const payload = params.turn as Turn | undefined;
    const turn = this.#turn(thread, payload?.id ?? params.turnId as string);
    if (method === "turn/started") {
      if (payload!.status !== "inProgress") throw new Error("Invalid started turn status");
      if (terminal(turn.status)) return false;
      turn.status = payload!.status;
      for (const item of payload!.items) {
        if (!turn.items.has(item.id)) this.#setItem(turn, item, false);
      }
    } else if (method === "turn/completed") {
      if (!terminal(payload!.status)) throw new Error("Invalid completed turn status");
      if (terminal(turn.status)) return false;
      turn.status = payload!.status;
      for (const item of payload!.items) this.#setItem(turn, item, true);
    } else {
      // A terminal turn may omit its items. A late authoritative item completion
      // can still fill missing final data; starts/deltas must not reopen the turn.
      if (terminal(turn.status) && method !== "item/completed") return false;
      if (method === "item/agentMessage/delta") {
        const id = params.itemId as string;
        let item = turn.items.get(id);
        if (item?.completed) return false;
        if (!item) {
          if (turn.items.size >= 512) throw new Error("Item projection limit exceeded");
          item = { id, value: null, text: "", completed: false };
          turn.items.set(id, item);
        }
        // Identical chunks can be legitimate text. The protocol has no delta sequence ID.
        item.text += params.delta as string;
      } else {
        const item = params.item as ThreadItem;
        const existing = turn.items.get(item.id);
        if (existing?.completed) return false;
        if (method === "item/started" && existing) return false;
        this.#setItem(turn, item, method === "item/completed");
      }
    }
    this.#changed(thread);
    return true;
  }
}
