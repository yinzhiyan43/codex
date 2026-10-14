import type { WorkbenchClient } from "./client.ts";
import { HostOperationError } from "./client.ts";
import { FullTurnsWindow } from "../domain/full-turns-window.ts";
import type { DemoMessage } from "./demo-controller.ts";
export type HistoryRow = { id: string; title: string };
export type HistoryBrowserView = { archived: boolean; rows: HistoryRow[]; selectedId: string | null; title: string; messages: DemoMessage[]; turnCount: number; moreThreads: boolean; moreTurns: boolean; loading: boolean; inflight: boolean; listStale: boolean; stale: boolean; notice: string };
/** Persisted archived/unarchived sessions. Browsing never resumes execution. */
export class HistoryBrowser {
  #client: WorkbenchClient; #unsubscribe: () => void; #listeners = new Set<() => void>(); #disposed = false;
  #archived = false; #rows: HistoryRow[] = []; #listCursor: string | null | undefined; #listSeen = new Set<string>(); #listBusy = false; #listStale = true; #listLimited = false;
  #windows = new Map<string, FullTurnsWindow>(); #selected: string | null = null; #selectedRow: HistoryRow | null = null; #readBusy = false;
  #listIntent = 0; #readIntent = 0; #inflight = 0; #generation = 0; #notice = "未归档历史只读；按服务端游标加载完整轮次，不恢复执行或调用模型。";
  constructor(client: WorkbenchClient) {
    this.#client = client; this.#generation = client.getView().generation;
    this.#unsubscribe = client.subscribe(() => {
      const host = client.getView();
      if (host.generation !== this.#generation || host.state !== "ready") {
        this.#generation = host.generation; this.#notice = "历史连接未就绪，缓存保留；长会话可能超过返回上限，请显式重连。"; this.cancel(); this.#listStale = true; this.#listCursor = undefined; this.#listSeen.clear();
        for (const window of this.#windows.values()) window.markStale();
        this.#publish();
      }
    });
  }
  #publish(): void { if (!this.#disposed) for (const listener of this.#listeners) { try { listener(); } catch {} } }
  subscribe(listener: () => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  cancel(): void { this.#listIntent++; this.#readIntent++; this.#listBusy = false; this.#readBusy = false; this.#publish(); }
  snapshot(): HistoryBrowserView {
    const snapshot = this.#selected ? this.#windows.get(this.#selected)?.snapshot() : null;
    return { archived:this.#archived, rows: structuredClone(this.#rows), selectedId: this.#selected, title: this.#rows.find(row => row.id === this.#selected)?.title ?? this.#selectedRow?.title ?? (this.#archived ? "归档历史会话" : "未归档历史会话"), messages: snapshot?.messages ?? [], turnCount: snapshot?.turnCount ?? 0,
      moreThreads: !this.#listLimited && this.#listCursor !== null, moreTurns: snapshot?.hasMore ?? false, loading: this.#listBusy || this.#readBusy, inflight: this.#inflight > 0, listStale: this.#listStale, stale: this.#client.getView().state !== "ready" || (snapshot?.stale ?? this.#listStale), notice: this.#notice };
  }
  #ready(): void { if (this.#disposed || this.#client.getView().state !== "ready") throw new Error("history-offline"); if (this.#inflight >= 4) throw new Error("history-read-budget"); }
  async setArchived(value: boolean): Promise<void> { this.cancel(); this.#archived=value; this.#selected=null; this.#selectedRow=null; this.#rows=[]; this.#listCursor=undefined; this.#listLimited=false; this.#listStale=true; await this.list(true); }
  async list(refresh = false): Promise<void> {
    this.#ready(); if (this.#listBusy || (!refresh && (this.#listCursor === null || this.#listLimited))) return;
    const intent = ++this.#listIntent, generation = this.#client.getView().generation;
    const cursor = refresh ? null : this.#listCursor ?? null;
    this.#listBusy = true; this.#inflight++; this.#publish();
    const current = () => !this.#disposed && intent === this.#listIntent && generation === this.#client.getView().generation && this.#client.getView().state === "ready";
    try {
      const page = await this.#client.listThreads({ cursor, limit: 20, sortKey: "created_at", sortDirection: "desc", modelProviders: [], sourceKinds:["cli","vscode","appServer"], archived: this.#archived });
      if (!current()) return;
      const seen = refresh ? new Set<string>() : new Set(this.#listSeen), requestKey = JSON.stringify(cursor);
      if (seen.size >= 16) { this.#listLimited = true; throw new Error("thread-display-limit"); }
      if (seen.has(requestKey) || (page.nextCursor !== null && (page.nextCursor === cursor || seen.has(JSON.stringify(page.nextCursor))))) throw new Error("thread-cursor-loop");
      const rows = refresh ? [] : [...this.#rows];
      for (const thread of page.data) {
        if (!/^[a-z0-9-]{1,64}$/.test(thread.id) || thread.ephemeral) throw new Error("invalid-saved-thread");
        const row = { id: thread.id, title: (thread.name ?? thread.preview ?? "未命名会话").replace(/\s+/g, " ").slice(0, 100) };
        const index = rows.findIndex(value => value.id === row.id); if (index < 0) rows.push(row); else rows[index] = row;
      }
      if (rows.length > 200) { this.#listLimited = true; throw new Error("thread-display-limit"); }
      seen.add(requestKey); this.#rows = rows; this.#listCursor = page.nextCursor; this.#listSeen = seen; this.#listStale = false; this.#listLimited = page.nextCursor !== null && (rows.length >= 200 || seen.size >= 16);
      this.#notice = this.#listLimited ? "历史列表已达本地展示上限（200会话/16页）；已保留缓存并停止更多加载，可刷新列表。" : rows.length ? (this.#archived ? "归档历史只读；恢复归档后才能选择继续聊。" : "未归档历史只读；选择会话读取文字记录，原当前聊天与草稿会保留。") : (this.#archived ? "未找到归档的持久会话。" : "未找到未归档的持久会话；临时会话不会列入历史。");
    } catch (error) { if (current()) this.#notice = error instanceof Error && error.message === "thread-display-limit" ? "历史列表已达本地展示上限（200会话/16页）；已保留缓存并停止更多加载，可刷新列表。" : "历史列表读取未完成，已保留缓存；可刷新重试。"; }
    finally { this.#inflight--; if (intent === this.#listIntent) this.#listBusy = false; this.#publish(); }
  }
  async select(id: string, refresh = true): Promise<void> {
    this.#ready(); const row = this.#rows.find(row => row.id === id);
    if (!row && !(id === this.#selected && this.#selectedRow?.id === id && this.#windows.has(id))) throw new Error("thread-outside-history-list");
    if (row) this.#selectedRow = { ...row };
    if (!refresh && this.#selected === id && this.#readBusy) return;
    const intent = ++this.#readIntent, generation = this.#client.getView().generation;
    this.#selected = id;
    let window = this.#windows.get(id);
    if (!window) {
      if (this.#windows.size >= 8) { const oldest = this.#windows.keys().next().value!; this.#windows.delete(oldest); }
      window = new FullTurnsWindow(id); this.#windows.set(id, window);
    }
    if (!refresh && !window.hasMore()) return;
    if (refresh) window.restart();
    const cursor = window.cursor(); this.#readBusy = true; this.#inflight++; this.#publish();
    const current = () => !this.#disposed && intent === this.#readIntent && this.#selected === id && generation === this.#client.getView().generation && this.#client.getView().state === "ready";
    try {
      if (refresh) {
        const metadata = await this.#client.readThreadMetadata({ threadId: id });
        if (!current()) return; if (metadata.thread.ephemeral) throw new Error("ephemeral-history-unavailable");
      }
      const page = await this.#client.listTurns({ threadId: id, cursor, limit: 20, sortDirection: "desc", itemsView: "full" });
      if (!current()) return;
      window.commit(page, cursor); this.#notice = window.limited() ? "历史已达本地展示上限（256轮/64页/2MiB序列化展示缓存）；已保留缓存并停止更早加载，可显式刷新。" : "服务端完整轮次分页；只展开文字，附件/工具未展开。历史状态不表示当前正在执行。";
    } catch (error) { if (current()) this.#notice = error instanceof Error && error.message === "saved-history-display-limit" ? "历史已达本地展示上限（256轮/64页/2MiB序列化展示缓存）；已保留缓存并停止更早加载，可显式刷新。" : error instanceof HostOperationError && ["rpc-error:-32601", "rpc-error:-32600"].includes(error.code) ? "当前存储未提供可读的完整轮次，缓存保留；不会回退到 items/list。" : "历史读取未完成，缓存保留。长会话可能超过返回/显示上限，请重连或选择较短会话。"; }
    finally { this.#inflight--; if (intent === this.#readIntent) this.#readBusy = false; this.#publish(); }
  }
  dispose(): void { this.#disposed = true; this.cancel(); this.#unsubscribe(); this.#listeners.clear(); }
}
