import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HistoryWindow } from "../domain/history-window.ts";
import { ApprovalCards } from "../domain/approval-cards.ts";
import { StdioWorkbenchHost } from "../desktop-host/stdio-host.ts";
import { DemoController } from "../desktop-host/demo-controller.ts";
import type { ThreadItemEntry, Turn } from "../protocol-adapter/contracts.ts";
import { feed, outgoing, ready, approval } from "./helpers.ts";
const entry = (id: string, text = id, turnId = "turn-1", completedAtMs: number | null = 1000): ThreadItemEntry => ({ turnId, startedAtMs: 1000, completedAtMs,
  item: { type: "agentMessage", id, text, phase: null, delivery: null, questions: null, memoryCitation: null } });
const turn = (id: string): Turn => ({ id, rootTurnId: null, items: [], itemsView: "summary", status: "completed", error: null, startedAt: 1, completedAt: 1, durationMs: 1 });
const items = (data: ThreadItemEntry[], nextCursor: string | null = null) => ({ data, nextCursor, backwardsCursor: null });
const turns = (data: Turn[], nextCursor: string | null = null) => ({ data, nextCursor, backwardsCursor: null });
test("history follows server order rather than lexical IDs or tied timestamps and deduplicates overlap", () => {
  const window = new HistoryWindow("thread-A"); window.beginGeneration(1);
  window.commit({ turns: turns([turn("turn-2")], "t1"), items: items([entry("a-last"), entry("z-first")], "i1") }, 1);
  const ids = window.snapshot().messages.map(message => message.id);
  window.commit({ turns: turns([turn("turn-2"), turn("turn-1")]), items: items([entry("z-first"), entry("old", "older", "turn-0")]) }, 1);
  assert.deepEqual(window.snapshot().messages.map(message => message.text), ["older", "z-first", "a-last"]);
  assert.deepEqual(window.snapshot().messages.slice(-2).map(message => message.id), ids); assert.equal(window.snapshot().hasMore, false);
});
test("same item IDs in different turns or threads retain separate stable keys", () => {
  const a = new HistoryWindow("thread-A"), b = new HistoryWindow("thread-B"); a.beginGeneration(1); b.beginGeneration(1);
  a.commit({ items: items([entry("same", "second", "turn-2"), entry("same", "first", "turn-1")]), turns: turns([]) }, 1);
  b.commit({ items: items([entry("same", "other", "turn-1")]), turns: turns([]) }, 1);
  assert.equal(new Set([...a.snapshot().messages, ...b.snapshot().messages].map(message => message.id)).size, 3);
});
test("cursor loops reject the entire page pair without advancing or partially mutating", () => {
  const window = new HistoryWindow("thread-A"); window.beginGeneration(1);
  window.commit({ items: items([entry("first")], "i1"), turns: turns([turn("turn-1")], "t1") }, 1);
  const before = window.snapshot();
  assert.throws(() => window.commit({ turns: turns([turn("turn-new")]), items: items([entry("new")], "i1") }, 1), /cursor-loop/);
  assert.deepEqual(window.snapshot(), before); assert.equal(window.cursor("turns"), "t1");
});
test("fresh generation retains old history as stale until each page is reread", () => {
  const window = new HistoryWindow("thread-A"); window.beginGeneration(1);
  window.commit({ items: items([entry("recent"), entry("old")]), turns: turns([]) }, 1);
  window.beginGeneration(2); assert.equal(window.snapshot().stale, true);
  assert.throws(() => window.commit({ items: items([entry("late")]) }, 1), /stale-history/);
  window.commit({ items: items([entry("recent", "updated")], "i1"), turns: turns([]) }, 2);
  assert.equal(window.snapshot().messages[0]!.stale, true); assert.equal(window.snapshot().messages[1]!.stale, false);
  window.commit({ items: items([entry("old")]) }, 2); assert.equal(window.snapshot().stale, false);
});
test("complete new-generation history removes absent old messages and turns", () => {
  const window = new HistoryWindow("thread-A"); window.beginGeneration(1);
  window.commit({ items: items([entry("kept", "kept", "turn-2"), entry("deleted", "old", "turn-1")]), turns: turns([turn("turn-2"), turn("turn-1")]) }, 1);
  window.beginGeneration(2); window.commit({ items: items([entry("kept", "kept", "turn-2")]), turns: turns([turn("turn-2")]) }, 2);
  assert.equal(window.snapshot().messages.length, 1); assert.deepEqual(window.snapshot().turnIds, ["turn-2"]);
  assert.equal(window.snapshot().hasMore, false); assert.equal(window.snapshot().stale, false);
});
test("bounded history and late partial item data cannot overwrite completed data", () => {
  const window = new HistoryWindow("thread-A"); window.beginGeneration(1);
  window.commit({ items: items([entry("final", "final text")], "i1"), turns: turns([]) }, 1);
  window.commit({ items: items([entry("final", "partial", "turn-1", null)], "i2") }, 1);
  assert.equal(window.snapshot().messages[0]!.text, "final text");
  const before = window.snapshot();
  assert.throws(() => window.commit({ items: items(Array.from({ length: 513 }, (_, i) => entry("item-" + i))) }, 1), /cache-limit/);
  assert.deepEqual(window.snapshot(), before);
});
test("typed paginated requests use copied contracts and accept explicit direction and scoped anchors", async () => {
  const session = await ready();
  const request = session.listItems({ threadId: "thread-demo", turnId: "turn-1", cursor: { type: "item", itemId: "anchor" }, limit: 2, sortDirection: "asc" });
  const sent = outgoing(session)[0]!; assert.equal(sent.method, "thread/items/list");
  feed(session, { id: sent.id, result: items([entry("new")]) }); assert.equal((await request).data.length, 1);
  assert.throws(() => session.listItems({ threadId: "thread-demo", cursor: { type: "item", itemId: "anchor" } }), /invalid-item-anchor/);
  assert.throws(() => session.listTurns({ threadId: "thread-demo", limit: 101 }), /invalid-page-limit/);
  assert.throws(() => session.request("thread/turns/list", { threadId: "thread-demo", futureField: true }), /unsupported-field/);
  session.disconnect(session.epoch);
});
test("pagination replies remain scoped to their request and reject oversized/wrong-turn data", async () => {
  for (const wrongTurn of [false, true]) {
    const session = await ready(); const pending = session.listItems({ threadId: "thread-demo", turnId: "turn-1", limit: 1 });
    const sent = outgoing(session)[0]!;
    feed(session, { id: sent.id, result: items(wrongTurn ? [entry("wrong", "x", "turn-other")] : [entry("one"), entry("two")]) });
    await assert.rejects(pending); assert.equal(session.state, "failed");
  }
});
test("approval cards distinguish waiting, resolved, expired and disconnected without exposing handles", async () => {
  const session = await ready();
  const client = {
    getView: () => ({ state: session.state === "ready" ? "ready" as const : "disconnected" as const, generation: session.epoch, protocolState: session.state, processActive: false, threads: session.snapshot(), approvals: session.approvals(), recovery: session.recoveryPlan() }),
    respondApproval: (handle: Parameters<typeof session.respondApproval>[0], decision: Parameters<typeof session.respondApproval>[1]) => session.respondApproval(handle, decision),
  };
  const cards = new ApprovalCards(); feed(session, approval("command")); cards.sync(client.getView());
  const card = cards.snapshot("thread-demo")[0]!; assert.equal(card.status, "pending"); assert.equal(Object.hasOwn(card, "handle"), false);
  // Only the two capabilities actually used by respond are needed for this synthetic seam.
  cards.respond(card.key, "cancel", client as Parameters<typeof cards.respond>[2]);
  assert.equal(cards.snapshot("thread-demo")[0]!.status, "waiting"); assert.throws(() => cards.respond(card.key, "cancel", client as Parameters<typeof cards.respond>[2]));
  feed(session, { method: "serverRequest/resolved", params: { threadId: "thread-demo", requestId: "command" } }); cards.sync(client.getView());
  assert.equal(cards.snapshot("thread-demo")[0]!.status, "resolved");
  feed(session, approval("expires")); cards.sync(client.getView()); feed(session, { method: "serverRequest/resolved", params: { threadId: "thread-demo", requestId: "expires" } }); cards.sync(client.getView());
  assert.equal(cards.snapshot("thread-demo")[1]!.status, "expired");
  feed(session, approval("offline")); cards.sync(client.getView()); session.disconnect(session.epoch); cards.sync(client.getView());
  const stale = cards.snapshot("thread-demo")[2]!; assert.equal(stale.status, "disconnected"); assert.throws(() => cards.respond(stale.key, "accept", client as Parameters<typeof cards.respond>[2]));
});
function create(t: { after(fn: () => Promise<void>): void }, mode = "normal") {
  const fixture = fileURLToPath(new URL("../desktop/fixture-peer.mjs", import.meta.url));
  const host = new StdioWorkbenchHost(() => spawn(process.execPath, [fixture, mode], { env: {}, stdio: ["pipe", "pipe", "pipe"] }));
  const controller = new DemoController(host.client()); t.after(() => controller.dispose()); return { controller, host };
}
test("controller loads overlapping history pages once and preserves stable IDs on back/reconnect", async t => {
  const { controller } = create(t); await controller.dispatch({ type: "connect" }); await controller.dispatch({ type: "thread", id: "thread-welcome" });
  const original = controller.snapshot().messages.map(message => message.id);
  await Promise.all([controller.dispatch({ type: "history", threadId: "thread-welcome" }), controller.dispatch({ type: "history", threadId: "thread-welcome" })]);
  while (controller.snapshot().history.hasMore) await controller.dispatch({ type: "history", threadId: "thread-welcome" });
  const full = controller.snapshot(); assert.equal(full.messages.length, 10); assert.equal(new Set(full.messages.map(message => message.id)).size, 10); assert.deepEqual(full.messages.slice(-4).map(message => message.id), original);
  await controller.dispatch({ type: "project", id: "project-garden" }); await controller.dispatch({ type: "back" }); assert.deepEqual(controller.snapshot().messages.map(message => message.id), full.messages.map(message => message.id));
  await controller.dispatch({ type: "disconnect" }); await controller.dispatch({ type: "reconnect" }); assert.equal(controller.snapshot().history.stale, true);
  while (controller.snapshot().history.hasMore) await controller.dispatch({ type: "history", threadId: "thread-welcome" }); assert.equal(controller.snapshot().history.stale, false);
});
test("cancelled reads ignore late results and route changes do not populate a different page", async t => {
  const { controller } = create(t, "slow-history"); await controller.dispatch({ type: "connect" });
  const pending = controller.dispatch({ type: "thread", id: "thread-welcome" }); await controller.dispatch({ type: "cancelHistory" }); await pending;
  assert.equal(controller.snapshot().messages.length, 0); assert.equal(controller.snapshot().loading, false);
  const retry = controller.dispatch({ type: "history", threadId: "thread-welcome" }); await controller.dispatch({ type: "project", id: "project-garden" }); await retry;
  assert.equal(controller.snapshot().route.projectId, "project-garden"); assert.equal(controller.snapshot().messages.length, 0); assert.equal(controller.snapshot().loading, false);
});
test("cancelling an in-flight page immediately enables retry while ignoring its late results", async t => {
  const { controller } = create(t, "slow-history"); await controller.dispatch({ type: "connect" }); await controller.dispatch({ type: "thread", id: "thread-welcome" });
  const old = controller.dispatch({ type: "history", threadId: "thread-welcome" });
  assert.equal(controller.snapshot().history.busy, true);
  await controller.dispatch({ type: "cancelHistory" });
  assert.equal(controller.snapshot().history.busy, false); assert.equal(controller.snapshot().loading, false); assert.equal(controller.snapshot().history.hasMore, true);
  await new Promise(resolve => setTimeout(resolve, 100));
  const retry = controller.dispatch({ type: "history", threadId: "thread-welcome" });
  assert.equal(controller.snapshot().history.busy, true);
  await old; assert.equal(controller.snapshot().history.busy, true); assert.equal(controller.snapshot().messages.length, 4);
  await retry; assert.equal(controller.snapshot().history.busy, false); assert.equal(controller.snapshot().messages.length, 7);
});
test("rapid away/back starts a new owned read and old cleanup cannot erase its busy token", async t => {
  const { controller } = create(t, "slow-history"); await controller.dispatch({ type: "connect" });
  const old = controller.dispatch({ type: "thread", id: "thread-welcome" });
  await controller.dispatch({ type: "project", id: "project-garden" });
  const back = controller.dispatch({ type: "back" });
  assert.equal(controller.snapshot().history.busy, true);
  await old; assert.equal(controller.snapshot().history.busy, true);
  await back; assert.equal(controller.snapshot().route.threadId, "thread-welcome");
  assert.equal(controller.snapshot().messages.length, 4); assert.equal(controller.snapshot().history.busy, false); assert.equal(controller.snapshot().loading, false);
});
test("a failed pair retries the same cursors and history cancellation does not cancel local response timers", async t => {
  const { controller } = create(t, "page-error"); await controller.dispatch({ type: "connect" }); await controller.dispatch({ type: "thread", id: "thread-welcome" });
  assert.equal(controller.snapshot().history.itemCount, 0); assert.match(controller.snapshot().error!, /历史读取/);
  await controller.dispatch({ type: "history", threadId: "thread-welcome" }); assert.equal(controller.snapshot().history.itemCount, 4);
  await controller.dispatch({ type: "draft", routeId: "thread-welcome", text: "本地回应" }); await controller.dispatch({ type: "submit" }); await controller.dispatch({ type: "confirm" });
  const reading = controller.dispatch({ type: "history", threadId: "thread-welcome" }); await controller.dispatch({ type: "cancelHistory" }); await reading;
  await new Promise(resolve => setTimeout(resolve, 1550)); assert.equal(controller.snapshot().running, false); assert.equal(controller.snapshot().messages.at(-1)!.status, "completed");
});
test("controller decisions are route-bound, once only and old keys stay disabled after reconnect", async t => {
  const { controller, host } = create(t); await controller.dispatch({ type: "connect" }); await controller.dispatch({ type: "thread", id: "thread-welcome" });
  const card = controller.snapshot().approvals.find(card => card.detail.includes("accept-demo"))!;
  await Promise.all([controller.dispatch({ type: "approval", key: card.key, decision: "accept" }), controller.dispatch({ type: "approval", key: card.key, decision: "accept" })]);
  await new Promise(resolve => setTimeout(resolve, 160)); assert.equal(host.getView().state, "ready"); assert.equal(controller.snapshot().approvals.find(value => value.key === card.key)!.status, "resolved");
  const pending = controller.snapshot().approvals.find(card => card.detail.includes("offline-demo"))!;
  await controller.dispatch({ type: "project", id: "project-garden" }); await assert.rejects(controller.dispatch({ type: "approval", key: pending.key, decision: "accept" }));
  await controller.dispatch({ type: "back" }); await controller.dispatch({ type: "disconnect" }); await controller.dispatch({ type: "reconnect" });
  await controller.dispatch({ type: "approval", key: pending.key, decision: "accept" });
  assert.equal(controller.snapshot().approvals.find(card => card.key === pending.key)!.status, "disconnected"); assert.equal(host.getView().state, "ready");
});
