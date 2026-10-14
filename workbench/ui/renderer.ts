import type { DesktopView } from "../desktop-host/demo-controller.ts";
import type { DesktopCommand } from "../desktop-host/ipc-contract.ts";
declare global { interface Window { workbench: { snapshot(): Promise<DesktopView>; dispatch(command: DesktopCommand): Promise<DesktopView>; subscribe(listener: (view: DesktopView) => void): () => void } } }
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const draft = el<HTMLTextAreaElement>("draft");
let view: DesktopView | null = null; let version = -1; let routeKey = ""; let draftTimer: ReturnType<typeof setTimeout> | null = null;
let inputSequence = 0;
const dialog = el<HTMLDialogElement>("confirm-dialog");
const connectionDialog = el<HTMLDialogElement>("connection-dialog");
function render(next: DesktopView): void {
  if (next.version < version) return;
  version = next.version; view = next;
  const key = next.route.threadId ?? next.route.projectId;
  const changedRoute = key !== routeKey; routeKey = key;
  const project = next.projects.find(p => p.id === next.route.projectId)!;
  el("project-context").textContent = project.name;
  el("empty-title").textContent = `我们应该在${project.name}中做些什么？`;
  const hasConversation = !!next.route.threadId || next.messages.length > 0;
  el("empty").hidden = hasConversation;
  el("conversation").hidden = !hasConversation;
  const scroller = el("conversation"), oldTop = scroller.scrollTop, oldHeight = scroller.scrollHeight;
  const messageRoot = el("messages");
  const oldFirst = messageRoot.querySelector<HTMLElement>("article")?.dataset.messageId;
  const oldLast = messageRoot.querySelector<HTMLElement>("article:last-of-type")?.dataset.messageId;
  const existing = new Map([...messageRoot.querySelectorAll<HTMLElement>("article")].map(node => [node.dataset.messageId!, node]));
  const wantedIds = new Set(next.messages.map(message => message.id));
  for (const node of [...messageRoot.children]) if (!wantedIds.has((node as HTMLElement).dataset.messageId ?? "")) node.remove();
  let messageIndex = 0;
  for (const message of next.messages) {
    const node = existing.get(message.id) ?? document.createElement("article");
    node.className = `message ${message.role}`; node.dataset.messageId = message.id;
    const signature = JSON.stringify([message.text, message.stale, message.status]);
    if (signature !== node.dataset.signature) {
      node.replaceChildren(document.createTextNode(message.text)); node.dataset.signature = signature;
      if (message.stale) { const badge = document.createElement("span"); badge.className = "cache-label"; badge.textContent = "缓存"; node.append(badge); }
    }
    if (message.status) node.dataset.status = message.status; else delete node.dataset.status;
    node.setAttribute("aria-label", message.role === "user" ? "用户消息" : message.status === "running" ? "演示正在回应" : message.status === "cancelled" ? "演示已取消" : "助手消息");
    if (messageRoot.children[messageIndex] !== node) messageRoot.insertBefore(node, messageRoot.children[messageIndex] ?? null);
    messageIndex++;
  }

  if (next.loading) { const loading = document.createElement("p"); loading.className = "loading"; loading.textContent = "正在读取演示历史…"; messageRoot.append(loading); }
  if (changedRoute || (oldLast && oldLast !== next.messages.at(-1)?.id)) scroller.scrollTop = scroller.scrollHeight;
  else if (oldFirst && next.messages.findIndex(message => message.id === oldFirst) > 0) scroller.scrollTop = oldTop + scroller.scrollHeight - oldHeight;
  else scroller.scrollTop = oldTop;
  const remoteThread = !!next.route.threadId && !next.route.threadId.startsWith("local-");
  el("history-toolbar").hidden = !remoteThread;
  el("history-count").textContent = `${next.history.turnCount} 个轮次 · ${next.history.itemCount} 项历史`;
  el("history-status").textContent = next.history.notice ?? (next.history.loading ? "读取中…" : next.history.busy ? "正在结束读取…" : next.history.stale ? "部分缓存待核对" : "");
  el<HTMLButtonElement>("load-history").disabled = !next.history.hasMore || next.history.busy || next.connection !== "ready";
  el("cancel-history").hidden = !next.history.loading;
  el("approval-list").hidden = next.approvals.length === 0;
  const approvalRoot = el("approval-list");
  const cards = new Map([...approvalRoot.querySelectorAll<HTMLElement>("article")].map(node => [node.dataset.approvalKey!, node]));
  const wantedKeys = new Set(next.approvals.map(card => card.key));
  for (const [key, node] of cards) if (!wantedKeys.has(key)) node.remove();
  let cardIndex = 0;
  const priority = { pending: 0, waiting: 1, disconnected: 2, expired: 3, resolved: 4 };
  for (const card of [...next.approvals].sort((a, b) => priority[a.status] - priority[b.status])) {
    let section = cards.get(card.key);
    if (!section) {
      section = document.createElement("article"); section.className = "approval-card"; section.dataset.approvalKey = card.key;
      const heading = document.createElement("strong"), state = document.createElement("span"), detail = document.createElement("p"), actions = document.createElement("div");
      state.className = "approval-status"; actions.className = "approval-actions";
      for (const [decision, label] of [["accept", "同意一次"], ["decline", "拒绝"], ["cancel", "取消请求"]]) {
        const button = document.createElement("button"); button.type = "button"; button.textContent = label!;
        button.dataset.approvalKey = card.key; button.dataset.decision = decision; actions.append(button);
      }
      section.append(heading, state, detail, actions);
    }
    section.dataset.approvalStatus = card.status;
    section.querySelector("strong")!.textContent = card.title;
    const labels = { pending: "等待你的决定", waiting: "等待服务端确认", resolved: "请求已结束", expired: "已失效，不能再答复", disconnected: "连接已断开，结果待核对" };
    section.querySelector(".approval-status")!.textContent = labels[card.status] + (card.decision ? ` · 已答复${{ accept: "同意", decline: "拒绝", cancel: "取消" }[card.decision]}` : "");
    section.querySelector("p")!.textContent = card.detail;
    for (const button of section.querySelectorAll("button")) button.disabled = card.status !== "pending" || next.connection !== "ready";
    if (approvalRoot.children[cardIndex] !== section) approvalRoot.insertBefore(section, approvalRoot.children[cardIndex] ?? null);
    cardIndex++;
  }
  if (changedRoute || document.activeElement !== draft) draft.value = next.draft;
  el("composer").classList.toggle("conversation-composer", hasConversation);
  const online = next.connection === "ready";
  el("connection-label").textContent = online ? "" : "已断开";
  el("detail-connection").textContent = online ? "已连接（合成）" : "已断开";
  const notice = next.error ?? (next.stale ? "演示连接已断开，显示的是缓存内容。草稿会保留。" : next.history.stale ? "较早历史仍是缓存，可以继续加载核对。" : null);
  el("notice").hidden = !notice;
  el("notice-text").textContent = notice ?? "";
  el("retry").hidden = online;
  el<HTMLButtonElement>("send").disabled = !draft.value.trim() || !online || next.loading;
  el("send").hidden = next.running;
  el("stop").hidden = !next.running;
  if (next.pending) { el("confirm-text").textContent = next.pending; if (!dialog.open) dialog.showModal(); }
  else if (dialog.open) dialog.close();
  const list = el("project-list"); list.replaceChildren();
  const query = next.search.toLocaleLowerCase();
  for (const p of next.projects) {
    const visible = p.name.toLocaleLowerCase().includes(query) ? p.threads : p.threads.filter(t => t.title.toLocaleLowerCase().includes(query));
    if (query && !visible.length && !p.name.toLocaleLowerCase().includes(query)) continue;
    const button = document.createElement("button"); button.className = "project-row";
    button.dataset.project = p.id; button.setAttribute("aria-pressed", String(p.id === next.route.projectId && !next.route.threadId));
    const icon = document.createElement("i"); icon.className = "ph ph-folder-open"; icon.setAttribute("aria-hidden", "true");
    button.append(icon, document.createTextNode(p.name)); list.append(button);
    for (const t of visible) {
      const thread = document.createElement("button"); thread.className = "thread-row"; thread.textContent = t.title; thread.dataset.thread = t.id;
      thread.setAttribute("aria-current", String(t.id === next.route.threadId)); list.append(thread);
    }
  }
  if (!list.childElementCount) { const empty = document.createElement("p"); empty.className = "search-empty"; empty.textContent = "没有匹配的演示会话"; list.append(empty); }
}
async function send(command: DesktopCommand): Promise<void> {
  try { render(await window.workbench.dispatch(command)); }
  catch { el("notice").hidden = false; el("notice-text").textContent = "操作未完成，请稍后重试。"; }
}
async function flushDraft(): Promise<void> {
  if (draftTimer) clearTimeout(draftTimer); draftTimer = null;
  inputSequence++; await send({ type: "draft", routeId: routeKey, text: draft.value });
}
async function navigate(command: DesktopCommand): Promise<void> { await flushDraft(); await send(command); }
draft.addEventListener("input", () => {
  el<HTMLButtonElement>("send").disabled = !draft.value.trim() || view?.connection !== "ready" || !!view?.loading;
  if (draftTimer) clearTimeout(draftTimer);
  const sequence = ++inputSequence; const routeId = routeKey; const text = draft.value;
  draftTimer = setTimeout(() => { if (sequence === inputSequence) { draftTimer = null; void send({ type: "draft", routeId, text }); } }, 180);
});
draft.addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!el<HTMLButtonElement>("send").disabled && !view?.running) el<HTMLFormElement>("composer").requestSubmit(); } });
el("composer").addEventListener("submit", event => { event.preventDefault(); void (async () => { await flushDraft(); await send({ type: "submit" }); })(); });
el("project-list").addEventListener("click", event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
  if (button?.dataset.project) void navigate({ type: "project", id: button.dataset.project });
  if (button?.dataset.thread) void navigate({ type: "thread", id: button.dataset.thread });
});
for (const [id, type] of [["back", "back"], ["new", "new"], ["home", "new"], ["workspace", "new"]] as const) el(id).addEventListener("click", () => { void navigate({ type }); });
el("confirm").addEventListener("click", () => { void send({ type: "confirm" }); });
el("cancel-confirm").addEventListener("click", () => { void send({ type: "cancel" }); draft.focus(); });
dialog.addEventListener("cancel", event => { event.preventDefault(); void send({ type: "cancel" }); draft.focus(); });
el("stop").addEventListener("click", () => { void send({ type: "cancel" }); });
el("load-history").addEventListener("click", () => { if (view?.route.threadId) void send({ type: "history", threadId: view.route.threadId }); });
el("cancel-history").addEventListener("click", () => { void send({ type: "cancelHistory" }); });
el("approval-list").addEventListener("click", event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
  if (button && !button.disabled && button.dataset.approvalKey && button.dataset.decision) void send({ type: "approval", key: button.dataset.approvalKey, decision: button.dataset.decision as "accept" | "decline" | "cancel" });
});
el("retry").addEventListener("click", () => { void send({ type: "reconnect" }); });
el("dismiss").addEventListener("click", () => { void send({ type: "clearError" }); });
el("connection-menu").addEventListener("click", () => connectionDialog.showModal());
el("disconnect").addEventListener("click", () => { connectionDialog.close(); void (async () => { await flushDraft(); await send({ type: "disconnect" }); })(); });
el("reconnect").addEventListener("click", () => { connectionDialog.close(); void send({ type: "reconnect" }); });
el("toggle-sidebar").addEventListener("click", () => el("app").classList.toggle("sidebar-hidden"));
el("toggle-details").addEventListener("click", () => { el("details").hidden = !el("details").hidden; el("app").classList.toggle("with-details", !el("details").hidden); });
el("toggle-search").addEventListener("click", () => { el("search-wrap").hidden = !el("search-wrap").hidden; if (!el("search-wrap").hidden) el("search").focus(); });
el<HTMLInputElement>("search").addEventListener("input", event => { void send({ type: "search", text: (event.target as HTMLInputElement).value }); });
el("account").addEventListener("click", () => { el("account-menu").hidden = !el("account-menu").hidden; });
el("account-close").addEventListener("click", () => { el("account-menu").hidden = true; el("account").focus(); });
el("account-help").addEventListener("click", () => { el("account-menu").hidden = true; connectionDialog.showModal(); });
document.addEventListener("keydown", event => { if (event.key === "Escape") { el("account-menu").hidden = true; } });
const unsubscribe = window.workbench.subscribe(render);
window.addEventListener("beforeunload", () => { unsubscribe(); if (draftTimer) clearTimeout(draftTimer); }, { once: true });
void window.workbench.snapshot().then(render);
