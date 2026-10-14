import type { ThreadItemsListResponse, ThreadTurnsListResponse, ThreadItemEntry, Turn } from "../protocol-adapter/contracts.ts";
export type HistoryMessage = { id: string; role: "user" | "assistant"; text: string; stale: boolean; status?: "completed" };
type Kind = "turns" | "items";
type StoredItem = { entry: ThreadItemEntry; generation: number };
const itemKey = (threadId: string, entry: ThreadItemEntry) => JSON.stringify([threadId, entry.turnId, entry.item.id]);
const mergeOrder = (existing: string[], page: string[], older: boolean) => {
  const newIds = [...new Set(page)].filter(id => !existing.includes(id));
  return older ? [...newIds, ...existing] : [...existing, ...newIds];
};
/** Bounded history ordered by server pages; IDs locate records, never lexical/timestamp sort. */
export class HistoryWindow {
  #generation = 0;
  #threadId: string;
  constructor(threadId: string) { this.#threadId = threadId; }
  get generation(): number { return this.#generation; }
  get initialized(): boolean { return this.#cursor.items !== undefined && this.#cursor.turns !== undefined; }
  #turns = new Map<string, Turn>(); #turnGenerations = new Map<string, number>(); #turnOrder: string[] = [];
  #items = new Map<string, StoredItem>(); #itemOrder: string[] = [];
  #cursor: Record<Kind, string | null | undefined> = { turns: undefined, items: undefined };
  #seen: Record<Kind, Set<string>> = { turns: new Set(), items: new Set() };
  beginGeneration(generation: number): void {
    if (generation === this.#generation) return;
    this.#generation = generation; this.#cursor = { turns: undefined, items: undefined };
    this.#seen = { turns: new Set(), items: new Set() };
  }
  cursor(kind: Kind): string | null { return this.#cursor[kind] ?? null; }
  hasMore(kind: Kind): boolean { return this.#cursor[kind] !== null; }
  /** Commit both independently fetched pages atomically; a failed/cancelled pair never advances. */
  commit(pages: { turns?: ThreadTurnsListResponse; items?: ThreadItemsListResponse }, generation: number): void {
    if (generation !== this.#generation) throw new Error("stale-history-generation");
    const cursors = { ...this.#cursor };
    const seen = { turns: new Set(this.#seen.turns), items: new Set(this.#seen.items) };
    const turns = new Map(this.#turns); const turnGenerations = new Map(this.#turnGenerations); const items = new Map(this.#items);
    let turnOrder = [...this.#turnOrder], itemOrder = [...this.#itemOrder];
    for (const kind of ["turns", "items"] as const) {
      const page = pages[kind]; if (!page) continue;
      const requestCursor = cursors[kind] ?? null; const cursorKey = JSON.stringify(requestCursor);
      if (seen[kind].has(cursorKey) || seen[kind].size >= 64 || (page.nextCursor !== null && (page.nextCursor === requestCursor || seen[kind].has(JSON.stringify(page.nextCursor))))) throw new Error("history-cursor-loop");
      seen[kind].add(cursorKey); cursors[kind] = page.nextCursor;
    }
    if (pages.turns) {
      const chronological = [...pages.turns.data].reverse();
      turnOrder = mergeOrder(turnOrder, chronological.map(turn => turn.id), this.#cursor.turns !== undefined);
      for (const turn of chronological) {
        turnGenerations.set(turn.id, generation);
        const previous = turns.get(turn.id);
        if (!previous || previous.status === "inProgress" || turn.status !== "inProgress") turns.set(turn.id, structuredClone(turn));
      }
    }
    if (pages.items) {
      const chronological = [...pages.items.data].reverse();
      itemOrder = mergeOrder(itemOrder, chronological.map(entry => itemKey(this.#threadId, entry)), this.#cursor.items !== undefined);
      for (const entry of chronological) {
        const key = itemKey(this.#threadId, entry), previous = items.get(key);
        // A late summary cannot replace an observed completed item's final data.
        const value = previous?.entry.completedAtMs !== null && previous && entry.completedAtMs === null ? previous.entry : entry;
        items.set(key, { entry: structuredClone(value), generation });
      }
    }
    // Only a complete canonical reload can remove old generation records.
    if (cursors.turns === null && cursors.items === null) {
      for (const [id, value] of items) if (value.generation !== generation) items.delete(id);
      for (const [id, value] of turnGenerations) if (value !== generation) { turns.delete(id); turnGenerations.delete(id); }
      turnOrder = turnOrder.filter(id => turns.has(id)); itemOrder = itemOrder.filter(id => items.has(id));
    }
    if (turns.size > 128 || items.size > 512 || Buffer.byteLength(JSON.stringify([...items.values()])) + Buffer.byteLength(JSON.stringify([...turns.values()])) > 2 * 1024 * 1024) throw new Error("history-cache-limit");
    this.#turns = turns; this.#turnGenerations = turnGenerations; this.#items = items; this.#turnOrder = turnOrder; this.#itemOrder = itemOrder; this.#cursor = cursors; this.#seen = seen;
  }
  snapshot() {
    const messages: HistoryMessage[] = [];
    for (const id of this.#itemOrder) {
      const stored = this.#items.get(id)!; const item = stored.entry.item;
      const stale = stored.generation !== this.#generation;
      if (item.type === "agentMessage") messages.push({ id, role: "assistant", text: item.text, stale, ...(stored.entry.completedAtMs !== null ? { status: "completed" as const } : {}) });
      if (item.type === "userMessage") messages.push({ id, role: "user", text: item.content.filter(value => value.type === "text").map(value => value.text).join("\n"), stale });
    }
    return structuredClone({ messages, turnIds: this.#turnOrder, turnCount: this.#turns.size, itemCount: this.#items.size,
      hasMore: this.hasMore("turns") || this.hasMore("items"), stale: messages.some(message => message.stale) });
  }
}
