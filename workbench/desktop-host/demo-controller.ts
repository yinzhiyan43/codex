import type { WorkbenchClient, HostState } from "./client.ts";
import { validateDesktopCommand } from "./ipc-contract.ts";
export const demoProjects = [
  { id: "project-garden", name: "garden-lab", threads: [{ id: "thread-garden", title: "整理花园计划" }] },
  { id: "project-studio", name: "studio-demo", threads: [{ id: "thread-welcome", title: "了解项目与未完成事项" }, { id: "thread-layout", title: "检查工作台布局" }] },
];
export type DemoMessage = { role: "user" | "assistant"; text: string; status?: "running" | "completed" | "cancelled" };
export type DesktopView = {
  mode: "synthetic"; version: number; connection: HostState; stale: boolean; projects: typeof demoProjects;
  route: { projectId: string; threadId: string | null }; title: string; messages: DemoMessage[];
  draft: string; search: string; loading: boolean; pending: string | null; running: boolean;
  error: string | null;
};
/** Synthetic workspace state only. Does not map UI submission to turn/start. */
export class DemoController {
  #client: WorkbenchClient;
  #projects = structuredClone(demoProjects); #localThreadCount = 0;
  #route = { projectId: "project-studio", threadId: null as string | null };
  #drafts = new Map<string, string>(); #cache = new Map<string, DemoMessage[]>();
  #localMessages = new Map<string, DemoMessage[]>();
  #history: { projectId: string; threadId: string | null }[] = [];
  #search = ""; #loading = false; #pending: string | null = null; #running = false; #error: string | null = null;
  #sequence = 0; #version = 0; #timer: ReturnType<typeof setTimeout> | null = null;
  #activePrompt = ""; #listeners = new Set<() => void>(); #unsubscribe: () => void;
  #disposed = false; #connectPromise: Promise<void> | null = null;
  constructor(client: WorkbenchClient) {
    this.#client = client;
    this.#unsubscribe = client.subscribe(() => {
      if (client.getView().state !== "ready" && (this.#running || this.#pending)) this.#cancel("连接已断开，演示已停止。草稿已保留。");
      this.#publish();
    });
  }
  #key(): string { return this.#route.threadId ?? this.#route.projectId; }
  #publish(): void { this.#version++; if (!this.#disposed) for (const listener of this.#listeners) { try { listener(); } catch { /* Isolate observers. */ } } }
  subscribe(listener: () => void): () => void { if (this.#disposed || this.#listeners.size >= 16) throw new Error("controller-unavailable"); this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  snapshot(): DesktopView {
    const host = this.#client.getView();
    const project = this.#projects.find(p => p.id === this.#route.projectId)!;
    const thread = project.threads.find(t => t.id === this.#route.threadId);
    return structuredClone({ mode: "synthetic", version: this.#version, connection: host.state,
      stale: host.state !== "ready", projects: this.#projects, route: this.#route,
      title: thread?.title ?? project.name, messages: [...(this.#cache.get(this.#key()) ?? []), ...(this.#localMessages.get(this.#key()) ?? [])].slice(-24),
      draft: this.#drafts.get(this.#key()) ?? "", search: this.#search, loading: this.#loading,
      pending: this.#pending, running: this.#running, error: this.#error });
  }
  #cancel(error: string | null = null): void {
    if (this.#timer) clearTimeout(this.#timer); this.#timer = null;
    if (this.#running) {
      const messages = this.#localMessages.get(this.#key()) ?? [];
      const last = messages.at(-1); if (last?.status === "running") { last.status = "cancelled"; last.text = "演示已取消。"; }
      if (!this.#drafts.get(this.#key())) this.#drafts.set(this.#key(), this.#activePrompt);
    }
    this.#pending = null; this.#running = false; this.#activePrompt = "";
    this.#sequence++; this.#loading = false; if (error) this.#error = error;
  }
  #navigate(route: { projectId: string; threadId: string | null }, remember = true): boolean {
    if (route.projectId === this.#route.projectId && route.threadId === this.#route.threadId) return false;
    this.#cancel();
    if (remember) { this.#history.push({ ...this.#route }); if (this.#history.length > 32) this.#history.shift(); }
    this.#route = route; this.#error = null; this.#publish(); return true;
  }
  async #loadThread(id: string): Promise<void> {
    if (id.startsWith("local-")) return; // Local synthetic messages never become a core RPC.
    const sequence = ++this.#sequence; this.#loading = true; this.#publish();
    try {
      const { thread } = await this.#client.readThread({ threadId: id, includeTurns: true });
      if (this.#disposed || sequence !== this.#sequence) return;
      const messages: DemoMessage[] = [];
      for (const turn of thread.turns) for (const item of turn.items) {
        if (item.type === "agentMessage") messages.push({ role: "assistant", text: item.text, status: "completed" });
        if (item.type === "userMessage") messages.push({ role: "user", text: item.content.filter(i => i.type === "text").map(i => i.text).join("\n") });
      }
      this.#cache.set(id, messages.slice(-16));
    } catch { if (sequence === this.#sequence) this.#error = "无法读取演示会话。连接恢复后可重试。"; }
    finally { if (sequence === this.#sequence) { this.#loading = false; this.#publish(); } }
  }
  async #connect(reconnect: boolean): Promise<void> {
    if (this.#connectPromise) return this.#connectPromise;
    const result = (async () => {
      try {
        await (reconnect ? this.#client.reconnect() : this.#client.start());
        this.#error = null;
        if (this.#route.threadId) await this.#loadThread(this.#route.threadId);
      } catch { this.#error = "演示连接未就绪，请重试。"; }
      finally { this.#publish(); }
    })();
    this.#connectPromise = result;
    try { await result; } finally { if (this.#connectPromise === result) this.#connectPromise = null; }
  }
  async dispatch(value: unknown): Promise<DesktopView> {
    if (this.#disposed) throw new Error("controller-unavailable");
    const command = validateDesktopCommand(value);
    switch (command.type) {
      case "connect": await this.#connect(false); break;
      case "reconnect": await this.#connect(true); break;
      case "disconnect": this.#cancel(); await this.#client.stop(); break;
      case "project": {
        if (!this.#projects.some(p => p.id === command.id)) throw new Error("unknown-project");
        this.#navigate({ projectId: command.id, threadId: null }); break;
      }
      case "thread": {
        const project = this.#projects.find(p => p.threads.some(t => t.id === command.id));
        if (!project) throw new Error("unknown-thread");
        if (this.#navigate({ projectId: project.id, threadId: command.id })) await this.#loadThread(command.id);
        break;
      }
      case "new": this.#navigate({ projectId: this.#route.projectId, threadId: null }); break;
      case "back": {
        const route = this.#history.pop(); if (route) { this.#navigate(route, false); if (route.threadId) await this.#loadThread(route.threadId); } break;
      }
      case "draft": {
        if (!this.#projects.some(p => p.id === command.routeId || p.threads.some(t => t.id === command.routeId))) throw new Error("unknown-draft-route");
        this.#drafts.set(command.routeId, command.text); break;
      }
      case "search": this.#search = command.text; break;
      case "clearError": this.#error = null; break;
      case "submit": {
        if (this.#running || this.#pending) break;
        if (this.#client.getView().state !== "ready") { this.#error = "连接已断开。请先重连，草稿会保留。"; break; }
        const text = (this.#drafts.get(this.#key()) ?? "").trim();
        if (text) this.#pending = text; break;
      }
      case "confirm": {
        if (!this.#pending || this.#running) break;
        if (this.#client.getView().state !== "ready") { this.#pending = null; this.#error = "连接已断开，请先重连。"; break; }
        const confirmedText = this.#pending;
        if (!this.#route.threadId) {
          if (this.#localThreadCount >= 8) { this.#pending = null; this.#error = "演示新会话已达到 8 个，请使用现有会话。"; break; }
          const project = this.#projects.find(p => p.id === this.#route.projectId)!;
          const id = `local-${++this.#localThreadCount}`;
          project.threads.push({ id, title: this.#pending.replace(/\s+/g, " ").slice(0, 24) });
          this.#drafts.set(this.#key(), "");
          this.#navigate({ projectId: project.id, threadId: id });
          // Navigation invalidates pending UI work; preserve the full confirmed text.
          this.#pending = confirmedText;
        }
        const text = this.#pending; this.#pending = null; this.#running = true; this.#activePrompt = text;
        this.#drafts.set(this.#key(), "");
        const messages: DemoMessage[] = [...(this.#localMessages.get(this.#key()) ?? []).slice(-12), { role: "user", text }, { role: "assistant", text: "正在整理演示回应…", status: "running" }];
        this.#localMessages.set(this.#key(), messages);
        const sequence = ++this.#sequence;
        this.#timer = setTimeout(() => {
          if (sequence !== this.#sequence || this.#disposed) return;
          const last = messages.at(-1)!; last.text = "已收到你的演示消息。可以切换项目、返回会话，或继续检查输入与取消流程。\n\n这条回应由本地合成数据生成，没有调用真实模型。"; last.status = "completed";
          this.#running = false; this.#activePrompt = ""; this.#timer = null; this.#publish();
        }, 1500);
        break;
      }
      case "cancel": this.#cancel(); break;
    }
    this.#publish(); return this.snapshot();
  }
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#cancel(); this.#disposed = true; this.#unsubscribe(); this.#listeners.clear(); await this.#client.dispose();
  }
}
