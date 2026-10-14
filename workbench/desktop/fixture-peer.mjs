// Protocol-only synthetic peer. No user projects, files, network, login or model.
import { StringDecoder } from "node:string_decoder";
const decoder = new StringDecoder("utf8");
let buffer = "";
const messages = {
  "thread-welcome": ["了解项目与未完成事项", "这是 studio-demo 的演示会话。\n\n工作台使用两层侧栏组织项目和会话，主区展示消息，输入区保留当前草稿。\n\n本阶段可以验证导航、返回、确认发送、取消与连接恢复。", "先检查导航和输入区", "可以先从左侧切换项目，再回到这个会话。草稿会分别保留；确认发送后可点击停止。所有内容都是合成数据。"],
  "thread-layout": ["检查工作台布局", "顶部是窗口控制，左侧是主导航和项目列表。主内容独立滚动，输入区固定在底部。右侧详情可以打开或关闭。"],
  "thread-garden": ["整理花园计划", "演示清单：\n• 记录种植区域\n• 整理浇水安排\n• 查看每周进度\n\n这些条目只用于展示，没有访问真实文件或日历。"],
};
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const thread = id => ({ id, sessionId: "synthetic-session", projectId: null, preview: messages[id]?.[0] ?? "演示", ephemeral: true, modelProvider: "synthetic", createdAt: 1, updatedAt: 1, status: { type: "idle" }, cwd: "/synthetic/demo", cliVersion: "0.162.1", source: "cli", turns: [{ id: `turn-${id}`, rootTurnId: null, itemsView: "full", status: "completed", error: null, startedAt: 1, completedAt: 1, durationMs: 1, items: (messages[id] ?? []).map((text, i) => i % 2 === 0 ? { type: "userMessage", id: `item-${i}`, clientId: null, content: [{ type: "text", text, text_elements: [] }] } : { type: "agentMessage", id: `item-${i}`, text, phase: null, memoryCitation: null, delivery: null, questions: null }) }] });
process.stdin.on("data", bytes => {
  buffer += decoder.write(bytes);
  if (buffer.length > 16384) process.exit(3);
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    let message; try { message = JSON.parse(line); } catch { process.exit(3); }
    if (message.method === "initialize") send({ id: message.id, result: { userAgent: "synthetic-desktop-peer", codexHome: "/synthetic/home", platformFamily: "unix", platformOs: "macos" } });
    else if (message.method === "thread/read") {
      if (!Object.hasOwn(messages, message.params.threadId)) { send({ id: message.id, error: { code: -32602, message: "unknown-fixture" } }); continue; }
      setTimeout(() => send({ id: message.id, result: { thread: thread(message.params.threadId) } }), 120);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
