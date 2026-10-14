import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { StdioWorkbenchHost } from "../desktop-host/stdio-host.ts";
import { DemoController } from "../desktop-host/demo-controller.ts";
import { validateDesktopCommand, validateDesktopSender, IpcBudget } from "../desktop-host/ipc-contract.ts";
function create(t: { after(fn: () => Promise<void>): void }) {
  let launches = 0;
  const fixture = fileURLToPath(new URL("../desktop/fixture-peer.mjs", import.meta.url));
  const host = new StdioWorkbenchHost(() => { launches++; return spawn(process.execPath, [fixture], { env: {}, stdio: ["pipe", "pipe", "pipe"] }); });
  const controller = new DemoController(host.client()); t.after(() => controller.dispose());
  return { controller, host, launches: () => launches };
}
test("IPC rejects arbitrary RPC, paths, extra properties, oversize and untrusted frames", () => {
  for (const value of [null, [], { type: "turn/start" }, { type: "connect", executable: "/fake" }, { type: "thread", id: "../private" }, { type: "search", text: "x".repeat(129) }, { type: "draft", routeId: "project-studio", text: "x".repeat(4001) }]) assert.throws(() => validateDesktopCommand(value));
  for (const sender of [{ owner: false, mainFrame: true, url: "workbench://app/index.html" }, { owner: true, mainFrame: false, url: "workbench://app/index.html" }, { owner: true, mainFrame: true, url: "https://example.invalid/" }]) assert.throws(() => validateDesktopSender(sender));
  assert.doesNotThrow(() => validateDesktopSender({ owner: true, mainFrame: true, url: "workbench://app/index.html" }));
});
test("IPC admission is bounded and releases idempotently", () => {
  const budget = new IpcBudget(); const releases = Array.from({ length: 8 }, () => budget.acquire(1000));
  assert.throws(() => budget.acquire(1000)); releases.forEach(release => { release(); release(); });
  for (let i = 0; i < 70; i++) budget.acquire(1000)();
  assert.throws(() => { for (let i = 0; i < 10; i++) budget.acquire(1000)(); });
  assert.doesNotThrow(() => budget.acquire(2000)());
});
test("synthetic thread fixture validates through the pinned host contracts", async t => {
  const { controller } = create(t); await controller.dispatch({ type: "connect" });
  const state = await controller.dispatch({ type: "thread", id: "thread-welcome" });
  assert.equal(state.connection, "ready"); assert.equal(state.messages.length, 4); assert.equal(state.loading, false); assert.equal(state.error, null);
  state.messages[0]!.text = "mutated"; assert.notEqual(controller.snapshot().messages[0]!.text, "mutated");
});
test("navigation preserves separate drafts and repeats do not reload an active thread", async t => {
  const { controller } = create(t); await controller.dispatch({ type: "connect" });
  await controller.dispatch({ type: "thread", id: "thread-welcome" });
  await controller.dispatch({ type: "draft", routeId: "thread-welcome", text: "保留草稿" });
  await controller.dispatch({ type: "project", id: "project-garden" });
  // A delayed renderer draft belongs to its explicit old route, never the new project.
  await controller.dispatch({ type: "draft", routeId: "thread-welcome", text: "旧路由草稿" });
  assert.equal(controller.snapshot().draft, "");
  await controller.dispatch({ type: "back" }); assert.equal(controller.snapshot().draft, "旧路由草稿");
  const version = controller.snapshot().messages;
  await controller.dispatch({ type: "thread", id: "thread-welcome" }); assert.deepEqual(controller.snapshot().messages, version);
  await assert.rejects(controller.dispatch({ type: "thread", id: "unknown" }));
  await assert.rejects(controller.dispatch({ type: "draft", routeId: "unknown", text: "x" }));
});
test("later navigation wins an in-flight thread read without stale content or loading", async t => {
  const { controller } = create(t); await controller.dispatch({ type: "connect" });
  const reading = controller.dispatch({ type: "thread", id: "thread-welcome" });
  await controller.dispatch({ type: "project", id: "project-garden" }); await reading;
  assert.equal(controller.snapshot().route.projectId, "project-garden"); assert.equal(controller.snapshot().loading, false); assert.equal(controller.snapshot().messages.length, 0);
});
test("confirmation and cancellation are idempotent and preserve the draft", async t => {
  const { controller } = create(t); await controller.dispatch({ type: "connect" });
  await controller.dispatch({ type: "draft", routeId: "project-studio", text: "<img src=synthetic>" });
  await controller.dispatch({ type: "submit" }); await controller.dispatch({ type: "submit" });
  assert.equal(controller.snapshot().pending, "<img src=synthetic>");
  await controller.dispatch({ type: "cancel" }); assert.equal(controller.snapshot().draft, "<img src=synthetic>");
  await controller.dispatch({ type: "submit" }); await controller.dispatch({ type: "confirm" }); await controller.dispatch({ type: "confirm" });
  assert.equal(controller.snapshot().messages.length, 2);
  await controller.dispatch({ type: "cancel" }); await controller.dispatch({ type: "cancel" });
  assert.equal(controller.snapshot().running, false); assert.equal(controller.snapshot().messages.at(-1)!.status, "cancelled"); assert.equal(controller.snapshot().draft, "<img src=synthetic>");
});
test("disconnect keeps cached facts stale, blocks submit and reconnect never replays", async t => {
  const { controller, launches } = create(t);
  await Promise.all([controller.dispatch({ type: "connect" }), controller.dispatch({ type: "connect" })]); assert.equal(launches(), 1);
  await controller.dispatch({ type: "thread", id: "thread-welcome" });
  await controller.dispatch({ type: "draft", routeId: "thread-welcome", text: "保留" });
  await controller.dispatch({ type: "disconnect" }); await controller.dispatch({ type: "submit" });
  assert.equal(controller.snapshot().stale, true); assert.equal(controller.snapshot().messages.length, 4); assert.equal(controller.snapshot().pending, null);
  await Promise.all([controller.dispatch({ type: "reconnect" }), controller.dispatch({ type: "reconnect" })]);
  assert.equal(launches(), 2); assert.equal(controller.snapshot().stale, false); assert.equal(controller.snapshot().draft, "保留"); assert.equal(controller.snapshot().messages.length, 4);
});
test("dispose during an owned read prevents late publication and resurrection", async t => {
  const { controller, host } = create(t); await controller.dispatch({ type: "connect" });
  const reading = controller.dispatch({ type: "thread", id: "thread-welcome" }); await controller.dispose(); await reading;
  assert.equal(host.getView().processActive, false); assert.equal(host.getView().state, "disposed");
  await assert.rejects(controller.dispatch({ type: "connect" }));
});
test("local completed and cancelled messages survive back and explicit reconnect", async t => {
  const { controller } = create(t); await controller.dispatch({ type: "connect" });
  await controller.dispatch({ type: "thread", id: "thread-welcome" });
  await controller.dispatch({ type: "draft", routeId: "thread-welcome", text: "本地完成记录" });
  await controller.dispatch({ type: "submit" }); await controller.dispatch({ type: "confirm" });
  await new Promise(resolve => setTimeout(resolve, 1550));
  await controller.dispatch({ type: "project", id: "project-garden" }); await controller.dispatch({ type: "back" });
  assert.equal(controller.snapshot().messages.length, 6); assert.equal(controller.snapshot().messages.at(-1)!.status, "completed");
  await controller.dispatch({ type: "draft", routeId: "thread-welcome", text: "取消记录" });
  await controller.dispatch({ type: "submit" }); await controller.dispatch({ type: "confirm" });
  await controller.dispatch({ type: "disconnect" }); await controller.dispatch({ type: "reconnect" });
  assert.equal(controller.snapshot().messages.length, 8); assert.equal(controller.snapshot().messages.at(-1)!.status, "cancelled"); assert.equal(controller.snapshot().draft, "取消记录");
});
test("new synthetic conversations get separate bounded identities and survive navigation", async t => {
  const { controller } = create(t); await controller.dispatch({ type: "connect" });
  const text = "完整的合成消息应该保留，不因侧栏标题截断而丢失。".repeat(3);
  await controller.dispatch({ type: "draft", routeId: "project-studio", text }); await controller.dispatch({ type: "submit" }); await controller.dispatch({ type: "confirm" }); await controller.dispatch({ type: "cancel" });
  const id = controller.snapshot().route.threadId!; assert.equal(id, "local-1"); assert.equal(controller.snapshot().messages[0]!.text, text);
  const title = controller.snapshot().projects.flatMap(p => p.threads).find(t => t.id === id)!.title;
  assert.ok(title.length <= 24); assert.notEqual(title, text);
  await controller.dispatch({ type: "new" }); assert.equal(controller.snapshot().messages.length, 0);
  await controller.dispatch({ type: "thread", id }); assert.equal(controller.snapshot().messages[0]!.text, text);
  for (let i = 0; i < 8; i++) {
    await controller.dispatch({ type: "new" }); await controller.dispatch({ type: "draft", routeId: "project-studio", text: `新会话${i}` }); await controller.dispatch({ type: "submit" }); await controller.dispatch({ type: "confirm" }); await controller.dispatch({ type: "cancel" });
  }
  assert.equal(controller.snapshot().projects.flatMap(p => p.threads).filter(t => t.id.startsWith("local-")).length, 8);
  assert.match(controller.snapshot().error!, /8 个/);
});
