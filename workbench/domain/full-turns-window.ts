import type { ThreadTurnsListResponse, Turn } from "../protocol-adapter/contracts.ts";
import type { DemoMessage } from "../desktop-host/demo-controller.ts";
type SavedTurn = { id: string; status: Turn["status"]; messages: DemoMessage[] };
/** Consumes actual descending server pages with full items. Never slices a full transcript into fake pages. */
export class FullTurnsWindow {
  #threadId: string; #turns = new Map<string, SavedTurn>(); #order: string[] = [];
  #cursor: string | null | undefined; #seen = new Set<string>(); #started = false; #stale = true; #limited = false;
  constructor(threadId: string) { this.#threadId = threadId; }
  restart(): void { this.#cursor = undefined; this.#seen.clear(); this.#started = false; this.#stale = true; this.#limited = false; }
  markStale(): void { this.#stale = true; }
  cursor(): string | null { return this.#cursor ?? null; }
  hasMore(): boolean { return !this.#limited && this.#cursor !== null; }
  commit(page: ThreadTurnsListResponse, requested: string | null): void {
    if (requested !== this.cursor()) throw new Error("obsolete-history-cursor");
    const requestKey = JSON.stringify(requested);
    if (this.#seen.size >= 64) { this.#limited = true; throw new Error("saved-history-display-limit"); }
    if (this.#seen.has(requestKey) || (page.nextCursor !== null && (page.nextCursor === requested || this.#seen.has(JSON.stringify(page.nextCursor))))) throw new Error("history-cursor-loop");
    if (page.data.some(turn => turn.itemsView !== "full")) throw new Error("full-turn-view-not-confirmed");
    const turns = this.#started ? new Map(this.#turns) : new Map<string, SavedTurn>();
    const pageOrder: string[] = [];
    for (const turn of [...page.data].reverse()) {
      if (!pageOrder.includes(turn.id)) pageOrder.push(turn.id);
      const messages = new Map<string, DemoMessage>();
      for (const item of turn.items) {
        const id = JSON.stringify([this.#threadId, turn.id, item.id]);
        if (item.type === "userMessage") messages.set(id, { id, role: "user", text: item.content.filter(value => value.type === "text").map(value => value.text).join("\n") });
        if (item.type === "agentMessage") messages.set(id, { id, role: "assistant", text: item.text, status: turn.status === "inProgress" ? "unknown" : turn.status === "interrupted" ? "cancelled" : turn.status });
      }
      const previous = turns.get(turn.id);
      if (!previous || previous.status === "inProgress" || turn.status !== "inProgress") turns.set(turn.id, { id: turn.id, status: turn.status, messages: [...messages.values()] });
    }
    const oldOrder = this.#started ? this.#order : [];
    const order = [...pageOrder.filter(id => !oldOrder.includes(id)), ...oldOrder];
    const normalizedBytes = new TextEncoder().encode(JSON.stringify([...turns])).length;
    if (turns.size > 256 || normalizedBytes > 2 * 1024 * 1024) { this.#limited = true; throw new Error("saved-history-display-limit"); }
    this.#turns = turns; this.#order = order; this.#cursor = page.nextCursor; this.#seen.add(requestKey); this.#started = true; this.#stale = false; this.#limited = page.nextCursor !== null && (turns.size >= 256 || this.#seen.size >= 64 || normalizedBytes >= 2 * 1024 * 1024);
  }
  limited(): boolean { return this.#limited; }
  snapshot() { return { messages: this.#order.flatMap(id => this.#turns.get(id)!.messages.map(message => ({ ...message, stale: this.#stale }))), turnCount: this.#turns.size, hasMore: this.hasMore(), stale: this.#stale }; }
}
