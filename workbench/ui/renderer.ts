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
  el("execution-context").textContent = next.chatStatus?.historyMode ? "只读历史" : next.mode === "official-chat" ? next.chatStatus?.persistent ? "持久纯文本会话" : "临时观察缓存" : "\u6b64\u8ba1\u7b97\u673a";
  el("empty-title").textContent = `我们应该在${project.name}中做些什么？`;
  const official = next.mode !== "synthetic";
  const chat = next.mode === "official-chat";
  const savedHistory = chat && !!next.chatStatus?.historyMode;
  const accountMode = next.mode === "official-account" || chat;
  el("app").classList.toggle("chat-mode", chat);
  el("mode-label").textContent = chat ? (next.chatStatus?.offline ? "官方聊天协议 · 离线合成验证" : "官方核心 · ChatGPT聊天") : official ? (accountMode ? "官方核心 · 原生登录" : "官方核心 · 隔离连接") : "合成演示";
  document.title = chat ? "Codex Workbench — " + (next.chatStatus?.offline ? "\u5b98\u65b9\u804a\u5929\u534f\u8bae\u79bb\u7ebf\u9a8c\u8bc1" : "\u5b98\u65b9ChatGPT\u804a\u5929") : official ? (accountMode ? "Codex Workbench — 官方核心原生账户状态" : "Codex Workbench — 官方核心隔离连接") : "Codex Workbench — 合成演示";
  el("core-status").hidden = savedHistory || !official || (chat && next.messages.length > 0);
  el("chat-summary").hidden = !chat;
  const phases: Record<string,string> = { disconnecting: "正在断开连接", connecting: "正在核验连接", idle: "就绪", starting: "正在发送", running: "正在回应", cancelling: "等待官方中断确认", reading: "读取当前记录", restoring: "恢复记录", managing: "更新会话", unknown: "结果未知，不会自动重发" };
  el("chat-summary").title = next.persistenceNotice ?? "";
  el("chat-summary").textContent = savedHistory ? `只读历史记录 · 不恢复执行、不调用模型${next.chatStatus?.offline ? " · 离线合成验证" : ""}` : chat ? `ChatGPT · ${next.chatStatus?.model ?? "目录未确认"} · ${phases[next.chatStatus?.phase ?? "idle"]} · ${next.chatStatus?.persistent ? "持久会话" : "临时观察缓存"}${next.chatStatus?.offline ? " · 仅离线合成数据" : ""}` : "";
  for (const id of ["new", "back", "home", "workspace"]) el<HTMLButtonElement>(id).disabled = official && !(chat && id === "new" && ["idle","unknown"].includes(next.chatStatus?.phase ?? "idle"));
  if (chat) { el<HTMLButtonElement>("workspace").disabled = next.running || !!next.pending || !(["idle","unknown"].includes(next.chatStatus?.phase ?? "idle")) || next.connection !== "ready"; el("workspace").textContent = "浏览历史会话"; }
  el("saved-history-toolbar").hidden = !savedHistory;
  el("toggle-archived").textContent = next.historyBrowser?.archived ? "查看未归档" : "查看归档";
  el<HTMLButtonElement>("continue-session").disabled = !next.historyBrowser?.selectedId || !!next.historyBrowser?.archived || next.loading || next.connection !== "ready";
  el("saved-history-notice").textContent = savedHistory ? next.historyBrowser?.notice ?? "" : "";
  el<HTMLButtonElement>("refresh-threads").disabled = !!next.historyBrowser?.loading || next.connection !== "ready";
  el<HTMLButtonElement>("more-threads").disabled = !next.historyBrowser?.moreThreads || !!next.historyBrowser?.loading || next.connection !== "ready";
  el<HTMLButtonElement>("toggle-search").disabled = official;
  el<HTMLButtonElement>("account").disabled = official && !chat;
  el("account-menu").querySelector("strong")!.textContent = chat ? "官方CLI当前ChatGPT账号" : "演示账户";
  el("account-menu").querySelector("span")!.textContent = chat ? `套餐标识：${next.coreStatus?.authentication?.planType ?? "未知"}。使用原生登录；更换账号请在终端执行 codex login。` : "仅合成内容";
  el("account").setAttribute("aria-label", chat ? "官方账户状态" : "演示账户菜单");
  el<HTMLButtonElement>("toggle-details").disabled = official;
  draft.disabled = savedHistory || (official && !chat) || (chat && (next.running || next.loading));
  draft.placeholder = savedHistory ? "历史只读；返回当前聊天后可发送" : chat ? "发送到所选官方GPT模型" : official ? (accountMode ? "原生账户连接：此页仅检查状态" : "尚未登录，本阶段不发送消息") : "随心输入";
  el("connection-title").textContent = chat ? "官方聊天连接" : official ? "官方核心隔离连接" : "演示连接";
  el("connection-description").textContent = chat ? "复用官方CLI现有ChatGPT登录；新会话默认保存。重启/重连先读取记录，下一次确认发送才恢复线程，不会自动重复消息。" : official ? (accountMode ? "使用官方CLI现有ChatGPT登录；此页只检查状态与模型目录，不读取既有聊天或发送消息。" : "使用空配置验证官方 0.162.1 进程；不读取既有聊天、不登录、不发送模型请求。") : "只连接本地合成 peer，不使用真实账户或模型。";
  const choice = el<HTMLSelectElement>("model-choice"); choice.hidden = !chat; el("model-label").hidden = chat;
  if (chat) {
    const models = next.coreStatus?.models ?? [];
    if (JSON.stringify([...choice.options].map(option => option.value)) !== JSON.stringify(models)) { choice.replaceChildren(); for (const model of models) { const option = document.createElement("option"); option.value = model; option.textContent = model; choice.append(option); } }
    choice.value = next.chatStatus?.model ?? ""; choice.disabled = savedHistory || !next.chatStatus?.ready || next.running || next.loading || !!next.pending;
  }
  el("confirm-title").textContent = chat ? "发送官方消息？" : "发送演示消息？";
  el("confirm-caption").textContent = chat ? `使用 ${next.chatStatus?.model ?? "所选模型"} 与现有ChatGPT套餐额度。${next.chatStatus?.offline ? "当前为离线合成验证，不调用模型。" : ""}` : "只生成本地演示回应。";
  const modelLabel = el("model-text");
  modelLabel.textContent = official ? next.coreStatus?.defaultModel ?? "模型尚未验证" : "合成模型";
  if (next.coreStatus) {
    const core = next.coreStatus;
    el("core-description").textContent = chat ? "使用官方CLI当前ChatGPT账号；新会话由官方保存，重启可读并继续聊。工作台另保留列表与草稿。" : accountMode ? "使用官方 CLI 现有登录；不复制凭证，不加载既有聊天。此页仅检查连接与模型目录。" : "只验证本机进程和只读协议。此环境为空，尚未登录；不发送消息。";
    el("core-next-step").textContent = chat ? next.persistenceNotice ?? "持久会话保留记录；已有临时会话只能保留实际观察缓存。" : accountMode ? "没有加载既有聊天；真实模型可用性由独立冒烟测试验证。" : "没有加载既有聊天。模型和账户能力将在获准登录后验证。";
    el("core-account").textContent = core.authentication ? `已登录 ChatGPT · 官方套餐标识：${core.authentication.planType ?? "未知"} · ${core.models.length}个GPT模型` : accountMode ? "官方账户状态尚未确认" : "";
    el("core-connection").textContent = `${core.handshake ? "Codex" : "目标核心"} ${core.version} · ${next.connection} · 第${core.generation}次连接 · ${core.handshake ? "握手已确认" : "握手未确认"}`;
    if (chat && next.chatStatus?.offline) {
      el("core-description").textContent = "\u79bb\u7ebf\u5408\u6210\u534f\u8bae\u94fe\u6d4b\u8bd5\uff1a\u4e0d\u8bfb\u53d6\u771f\u5b9e\u767b\u5f55\uff0c\u4e0d\u8c03\u7528\u6a21\u578b\u3002";
      el("core-account").textContent = "\u79bb\u7ebf\u5408\u6210\u8d26\u6237/\u6a21\u578b\u5143\u6570\u636e";
      el("core-connection").textContent = `Offline peer / target schema ${core.version} / ${next.connection}`;
      el("account-menu").querySelector("strong")!.textContent = "\u79bb\u7ebf\u5408\u6210\u8d26\u6237";
      el("account-menu").querySelector("span")!.textContent = "\u4e0d\u4f7f\u7528\u771f\u5b9e\u767b\u5f55\u6216\u51ed\u8bc1";
    }
    el("probe-core").hidden = chat;
    el<HTMLButtonElement>("probe-core").disabled = next.connection !== "ready" || core.checking;
    const results = el("core-results"); results.replaceChildren();
    for (const probe of core.probes) { const row = document.createElement("li"); row.textContent = `${probe.method} · ${probe.code === "known-unsupported:not-requested" ? "已知不可用（本次未请求）" : probe.code === "rpc-error:-32601" ? "当前服务实现不支持" : probe.code === "rpc-error:-32600" ? "空环境中的检查线程不存在" : "检查失败"} (${probe.code})`; results.append(row); }
  }
  const hasConversation = !!next.route.threadId || next.messages.length > 0;
  el("empty").hidden = hasConversation || official;
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
    const signature = JSON.stringify([message.text, message.stale, message.status, savedHistory]);
    if (signature !== node.dataset.signature) {
      node.replaceChildren(document.createTextNode(message.text)); node.dataset.signature = signature;
      if (chat && message.status && message.status !== "running") { const state = document.createElement("span"); state.className = "cache-label"; state.textContent = savedHistory ? ({ completed: "历史完成记录", cancelled: "历史中断记录", failed: "历史失败记录", unknown: "历史未完成状态" })[message.status] : ({ completed: "已完成", cancelled: "官方已确认中断", failed: "失败", unknown: "结果未知" })[message.status]; node.append(state); }
      if (message.stale) { const badge = document.createElement("span"); badge.className = "cache-label"; badge.textContent = "缓存"; node.append(badge); }
    }
    if (message.status) node.dataset.status = message.status; else delete node.dataset.status;
    node.setAttribute("aria-label", message.role === "user" ? "用户消息" : message.status === "running" ? (savedHistory ? "历史保存状态" : chat ? "官方模型正在回应" : "演示正在回应") : message.status === "cancelled" ? (savedHistory ? "历史中断记录" : chat ? "官方已确认中断" : "演示已取消") : "助手消息");
    if (messageRoot.children[messageIndex] !== node) messageRoot.insertBefore(node, messageRoot.children[messageIndex] ?? null);
    messageIndex++;
  }

  if (next.loading) { const loading = document.createElement("p"); loading.className = "loading"; loading.textContent = savedHistory ? "正在读取历史记录…" : chat ? "正在核对当前会话元数据…" : "正在读取演示历史…"; messageRoot.append(loading); }
  if (changedRoute || (oldLast && oldLast !== next.messages.at(-1)?.id)) scroller.scrollTop = scroller.scrollHeight;
  else if (oldFirst && next.messages.findIndex(message => message.id === oldFirst) > 0) scroller.scrollTop = oldTop + scroller.scrollHeight - oldHeight;
  else scroller.scrollTop = oldTop;
  const remoteThread = !!next.route.threadId && !next.route.threadId.startsWith("local-");
  el("history-toolbar").hidden = !remoteThread;
  el("load-history").textContent = savedHistory || (chat && next.chatStatus?.persistent) ? "加载更早轮次" : chat ? "核对当前会话元数据" : "加载更早历史";
  el("conversation").setAttribute("aria-label", savedHistory ? "只读历史记录" : chat ? "官方持久会话" : "演示会话");
  el("stop").setAttribute("aria-label", chat ? "停止官方回应" : "停止演示");
  el<HTMLButtonElement>("stop").disabled = chat && next.chatStatus?.phase === "cancelling";
  el("history-count").textContent = `${next.history.turnCount} 个轮次 · ${next.history.itemCount} 项历史`;
  el("history-status").textContent = next.history.notice ?? (next.history.loading ? "读取中…" : next.history.busy ? "正在结束读取…" : next.history.stale ? "部分缓存待核对" : "");
  el<HTMLButtonElement>("load-history").disabled = (savedHistory || (chat && next.chatStatus?.persistent) ? !next.history.hasMore : chat ? !next.chatStatus?.canRefresh : !next.history.hasMore) || next.history.busy || next.connection !== "ready";
  el("refresh-saved-history").hidden = !savedHistory && !(chat && next.chatStatus?.persistent && remoteThread);
  el<HTMLButtonElement>("refresh-saved-history").disabled = !next.chatStatus?.canRefresh;
  el("cancel-history").hidden = (!savedHistory && chat) || !next.history.loading;
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
  el("detail-connection").textContent = online ? (official ? "已连接（官方核心）" : "已连接（合成）") : "已断开";
  const notice = next.error ?? (next.stale ? (official ? "官方核心连接未就绪，可显式重连。" : "演示连接已断开，显示的是缓存内容。草稿会保留。") : next.history.stale ? "较早历史仍是缓存，可以继续加载核对。" : null);
  el("notice").hidden = !notice;
  el("notice-text").textContent = notice ?? "";
  el("retry").hidden = chat ? ["connecting","disconnecting"].includes(next.chatStatus?.phase ?? "") || (online && !!next.chatStatus?.ready) : online;
  el<HTMLButtonElement>("send").disabled = savedHistory || (official && !chat) || (chat && (!next.chatStatus?.ready || next.running || !!next.pending)) || !draft.value.trim() || !online || next.loading;
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
    button.disabled = official; button.dataset.project = p.id; button.setAttribute("aria-pressed", String(p.id === next.route.projectId && !next.route.threadId));
    const icon = document.createElement("i"); icon.className = "ph ph-folder-open"; icon.setAttribute("aria-hidden", "true");
    button.append(icon, document.createTextNode(p.name)); list.append(button);
    for (const t of visible) {
      const thread = document.createElement("button"); thread.className = "thread-row"; thread.textContent = t.title; thread.dataset.thread = t.id;
      thread.disabled = savedHistory && next.connection !== "ready"; thread.setAttribute("aria-current", String(t.id === next.route.threadId)); list.append(thread);
    }
  }
  if (!list.childElementCount) { const empty = document.createElement("p"); empty.className = "search-empty"; empty.textContent = "没有匹配的演示会话"; list.append(empty); }
}
async function send(command: DesktopCommand): Promise<void> {
  try { render(await window.workbench.dispatch(command)); }
  catch { el("notice").hidden = false; el("notice-text").textContent = "操作未完成，请稍后重试。"; }
}
async function flushDraft(): Promise<void> {
  if (view?.chatStatus?.historyMode || (view?.mode !== "synthetic" && view?.mode !== "official-chat")) return;
  if (draftTimer) clearTimeout(draftTimer); draftTimer = null;
  inputSequence++; await send({ type: "draft", routeId: routeKey, text: draft.value });
}
async function navigate(command: DesktopCommand): Promise<void> { await flushDraft(); await send(command); }
draft.addEventListener("input", () => {
  if (view?.chatStatus?.historyMode || (view?.mode !== "synthetic" && view?.mode !== "official-chat")) return;
  el<HTMLButtonElement>("send").disabled = !draft.value.trim() || view?.connection !== "ready" || !!view?.loading;
  if (draftTimer) clearTimeout(draftTimer);
  const sequence = ++inputSequence; const routeId = routeKey; const text = draft.value;
  draftTimer = setTimeout(() => { if (sequence === inputSequence) { draftTimer = null; void send({ type: "draft", routeId, text }); } }, 180);
});
draft.addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!el<HTMLButtonElement>("send").disabled && !view?.running) el<HTMLFormElement>("composer").requestSubmit(); } });
el("composer").addEventListener("submit", event => { event.preventDefault(); if (view?.chatStatus?.historyMode || (view?.mode !== "synthetic" && view?.mode !== "official-chat")) return; void (async () => { await flushDraft(); await send({ type: "submit" }); })(); });
el("project-list").addEventListener("click", event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
  if (button?.dataset.project) void navigate({ type: "project", id: button.dataset.project });
  if (button?.dataset.thread) void navigate({ type: "thread", id: button.dataset.thread });
});
for (const [id, type] of [["back", "back"], ["new", "new"], ["home", "new"], ["workspace", "new"]] as const) el(id).addEventListener("click", () => { void navigate({ type: id === "workspace" && view?.mode === "official-chat" ? "browseHistory" : type }); });
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

el("probe-core").addEventListener("click", () => void send({ type: "probeCore" }));

el("model-choice").addEventListener("change", event => void send({ type: "selectModel", model: (event.target as HTMLSelectElement).value }));

el("return-chat").addEventListener("click", () => void send({ type: "returnToChat" }));
el("refresh-threads").addEventListener("click", () => void send({ type: "refreshThreads" }));
el("more-threads").addEventListener("click", () => void send({ type: "moreThreads" }));
el("refresh-saved-history").addEventListener("click", () => void send({ type: "refreshHistory" }));

let menuId: string | null = null; let sessionAction: "renameSession" | "archiveSession" | "unarchiveSession" | null = null;
const sessionMenu=el("session-menu"), sessionDialog=el<HTMLDialogElement>("session-dialog");
el("project-list").addEventListener("contextmenu",event=>{
  const button=(event.target as HTMLElement).closest<HTMLButtonElement>("[data-thread]");if(!button?.dataset.thread || view?.mode!=="official-chat")return;event.preventDefault();menuId=button.dataset.thread;
  const record=view.managedSessions?.find(row=>row.id===menuId);el("session-pin").textContent=record?.pinned?"取消置顶":"置顶";el("session-unread").textContent=record?.unread?"标记为已读":"标记为未读";el("session-archive").textContent=record?.archived||view.historyBrowser?.archived?"恢复归档":"归档";
  for(const id of ["session-rename","session-archive"])el<HTMLButtonElement>(id).disabled=view.connection!=="ready"||view.loading||view.running||!!record?.ephemeral;
  el<HTMLButtonElement>("session-rename").disabled ||= !!record?.archived || !!view.historyBrowser?.archived;
  sessionMenu.hidden=false;sessionMenu.style.left=Math.min(event.clientX,innerWidth-230)+"px";sessionMenu.style.top=Math.min(event.clientY,Math.max(10,innerHeight-440))+"px";
});
const showAction=(type:typeof sessionAction,title:string,description:string)=>{sessionAction=type;sessionMenu.hidden=true;el("session-dialog-title").textContent=title;el("session-dialog-description").textContent=description;el("session-name-label").hidden=type!=="renameSession";el("session-apply").hidden=type===null;el<HTMLInputElement>("session-name").value=view?.managedSessions?.find(row=>row.id===menuId)?.title??view?.projects.flatMap(p=>p.threads).find(row=>row.id===menuId)?.title??"";sessionDialog.showModal();};
el("session-rename").addEventListener("click",()=>showAction("renameSession","重命名会话","通过官方接口更新会话名称。"));
el("session-pin").addEventListener("click",()=>{sessionMenu.hidden=true;if(menuId)void send({type:"pinSession",id:menuId});});
el("session-unread").addEventListener("click",()=>{sessionMenu.hidden=true;if(menuId)void send({type:"unreadSession",id:menuId});});
el("session-archive").addEventListener("click",()=>{const archived=view?.managedSessions?.find(row=>row.id===menuId)?.archived||view?.historyBrowser?.archived;showAction(archived?"unarchiveSession":"archiveSession",archived?"恢复归档":"归档会话",archived?"官方接口将恢复这条归档记录。":"官方归档会关闭该会话，可能同时归档其派生会话；正文不会永久删除。确认后才发送请求。");});
el("session-share").addEventListener("click",()=>showAction(null,"分享尚未接入","尚未核实此会话的官方分享接口。此处不会创建链接或对外分享内容。"));
el("session-delete").addEventListener("click",()=>showAction(null,"永久删除当前未开放","官方删除接口已登记；本轮未授权删除真实会话。这里不会发送删除请求或移除正文。"));
el("session-dismiss").addEventListener("click",()=>sessionDialog.close());
el("session-form").addEventListener("submit",event=>{event.preventDefault();if(!menuId||!sessionAction)return;const command=sessionAction==="renameSession"?{type:sessionAction,id:menuId,name:el<HTMLInputElement>("session-name").value}: {type:sessionAction,id:menuId};sessionDialog.close();void send(command);});
document.addEventListener("click",event=>{if(!sessionMenu.contains(event.target as Node))sessionMenu.hidden=true;});
document.addEventListener("keydown",event=>{if(event.key==="Escape")sessionMenu.hidden=true;});
el("continue-session").addEventListener("click",()=>{if(view?.historyBrowser?.selectedId)void send({type:"continueSession",id:view.historyBrowser.selectedId});});
el("toggle-archived").addEventListener("click",()=>void send({type:"toggleArchived"}));
