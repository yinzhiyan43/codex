// Protocol-only synthetic peer. No user projects, files, network, login or model.
import { StringDecoder } from "node:string_decoder";
const decoder = new StringDecoder("utf8");
const mode = process.argv[2] ?? "normal";
if (!["normal", "slow-history", "page-error"].includes(mode)) process.exit(2);
let buffer = "", approvalsIssued = false, pageErrorIssued = false;
const decisions = new Set();
const latest = {
  "thread-welcome": ["了解项目与未完成事项", "这是 studio-demo 的演示会话。\n\n工作台使用两层侧栏组织项目和会话，主区展示消息，输入区保留当前草稿。\n\n本阶段可以验证导航、返回、确认发送、取消与连接恢复。", "先检查导航和输入区", "可以先从左侧切换项目，再回到这个会话。草稿会分别保留；确认发送后可点击停止。所有内容都是合成数据。"],
  "thread-layout": ["检查工作台布局", "顶部是窗口控制，左侧是主导航和项目列表。主内容独立滚动，输入区固定在底部。右侧详情可以打开或关闭。"],
  "thread-garden": ["整理花园计划", "演示清单：\n• 记录种植区域\n• 整理浇水安排\n• 查看每周进度\n\n这些条目只用于展示，没有访问真实文件或日历。"],
};
const texts = id => id === "thread-welcome" ? ["较早记录一", "这是较早的第一组历史。", "较早记录二", "分页会保留服务器顺序。", "较早记录三", "重叠页不会重复显示同一消息。", ...latest[id]] : latest[id];
const entries = id => texts(id).map((text, index) => ({ turnId: "turn-" + (Math.floor(index / 2) + 1), startedAtMs: 1000, completedAtMs: 1000,
  item: index % 2 === 0 ? { type: "userMessage", id: "item-" + index, clientId: null, content: [{ type: "text", text, text_elements: [] }] } : { type: "agentMessage", id: "item-" + index, text, phase: null, memoryCitation: null, delivery: null, questions: null } }));
const turns = id => [...new Set(entries(id).map(entry => entry.turnId))].map(turnId => ({ id: turnId, rootTurnId: null, itemsView: "summary", status: "completed", error: null, startedAt: 1, completedAt: 1, durationMs: 1, items: [] }));
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const reply = value => setTimeout(() => send(value), mode === "slow-history" ? 600 : 80);
const resolveApproval = id => send({ method: "serverRequest/resolved", params: { threadId: "thread-welcome", requestId: id } });
function issueApprovals() {
  if (approvalsIssued) return; approvalsIssued = true;
  for (const [id, kind] of [["accept-demo", "commandExecution"], ["decline-demo", "commandExecution"], ["cancel-demo", "fileChange"], ["expire-demo", "fileChange"], ["offline-demo", "commandExecution"]]) {
    send({ id, method: "item/" + kind + "/requestApproval", params: { threadId: "thread-welcome", turnId: "turn-5", itemId: id, startedAtMs: 1000,
      ...(kind === "commandExecution" ? { command: "synthetic-never-run " + id } : { reason: "合成文件修改，不会写入用户文件" }) } });
  }
  setTimeout(() => resolveApproval("expire-demo"), 900);
}
function page(data, cursor, prefix, limit, descending) {
  let start = descending ? data.length - 1 : 0;
  if (typeof cursor === "string") {
    if (!cursor.startsWith(prefix) || !/^\d+$/.test(cursor.slice(prefix.length))) throw new Error("bad-cursor");
    start = Number(cursor.slice(prefix.length));
  } else if (cursor && typeof cursor === "object") {
    const index = data.findIndex(entry => entry.item?.id === cursor.itemId);
    if (index < 0) throw new Error("bad-anchor"); start = index + (descending ? -1 : 1);
  }
  const selected = [];
  for (let index = start; index >= 0 && index < data.length && selected.length < limit; index += descending ? -1 : 1) selected.push(data[index]);
  // Deliberate inclusive overlap in continuation pages; IDs must deduplicate.
  const next = descending ? start - selected.length + 1 : start + selected.length - 1;
  const done = !selected.length || (descending ? next <= 0 : next >= data.length - 1);
  return { data: selected, nextCursor: done ? null : prefix + next, backwardsCursor: selected.length ? prefix + start : null };
}
function handle(message) {
  if (message.method === "initialize") { send({ id: message.id, result: { userAgent: "synthetic-desktop-peer", codexHome: "/synthetic/home", platformFamily: "unix", platformOs: "macos" } }); return; }
  if (Object.hasOwn(message, "result")) {
    if (decisions.has(message.id)) process.exit(9); decisions.add(message.id);
    if (!["accept", "decline", "cancel"].includes(message.result.decision)) process.exit(8);
    setTimeout(() => resolveApproval(message.id), 120); return;
  }
  if (!["thread/read", "thread/turns/list", "thread/items/list"].includes(message.method)) return;
  const id = message.params.threadId;
  if (!Object.hasOwn(latest, id)) { reply({ id: message.id, error: { code: -32602, message: "unknown-fixture" } }); return; }
  if (message.method === "thread/read") {
    if (id === "thread-welcome") issueApprovals();
    reply({ id: message.id, result: { thread: { id, sessionId: "synthetic-session", projectId: null, preview: latest[id][0], ephemeral: true, modelProvider: "synthetic", createdAt: 1, updatedAt: 1, status: { type: "idle" }, cwd: "/synthetic/demo", cliVersion: "0.162.1", source: "cli", turns: [] } } }); return;
  }
  if (mode === "page-error" && message.method === "thread/items/list" && !pageErrorIssued) { pageErrorIssued = true; reply({ id: message.id, error: { code: -32603, message: "synthetic-page-error" } }); return; }
  let data = message.method === "thread/turns/list" ? turns(id) : entries(id);
  if (message.params.turnId) data = data.filter(entry => entry.turnId === message.params.turnId);
  try { reply({ id: message.id, result: page(data, message.params.cursor, message.method === "thread/turns/list" ? "turns-" : "items-", message.params.limit ?? 4, message.params.sortDirection === "desc") }); }
  catch { reply({ id: message.id, error: { code: -32602, message: "synthetic-invalid-cursor" } }); }
}
process.stdin.on("data", bytes => {
  buffer += decoder.write(bytes); if (buffer.length > 16384) process.exit(3);
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); let message; try { message = JSON.parse(line); } catch { process.exit(3); } handle(message); }
});
process.stdin.on("end", () => process.exit(0));
