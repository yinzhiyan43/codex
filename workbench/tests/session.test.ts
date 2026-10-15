import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { ProtocolSession, ProtocolSessionError } from "../protocol-adapter/session.ts";
import { contractManifest, validate } from "../protocol-adapter/contracts.ts";
import { ready, feed, outgoing, approval, syntheticThread, syntheticTurn, fixtureBytes, fixtureMessages } from "./helpers.ts";

test("pins core, UI reference, self identity and disabled experimental surface", () => {
  const manifest = contractManifest();
  assert.equal(manifest.core.commit, "092d3acd6bec3e3a14bdc7e7a2810ab628ab759d");
  assert.equal(manifest.uiReference.version, "26.1007.30912");
  assert.equal(manifest.experimental.enabled, false);
  assert.deepEqual(manifest.experimental.implementedMethods, []);
  manifest.client.name = "changed";
  assert.equal(contractManifest().client.name, "yinzhiyan43_codex_workbench");
});
test("initializes once, acknowledges only valid response, and blocks pre-ready requests", async () => {
  const session = new ProtocolSession();
  assert.throws(() => session.request("thread/read", { threadId: "thread-demo" }), /not-ready/);
  const connection = session.connect();
  const request = outgoing(session)[0]!;
  assert.equal(request.method, "initialize");
  assert.equal(Object.hasOwn(request, "jsonrpc"), false);
  validate("initializeParams", request.params);
  assert.equal((request.params as any).clientInfo.name, "yinzhiyan43_codex_workbench");
  assert.throws(() => session.connect(), /already-connected/);
  feed(session, { id: request.id, result: { userAgent: "synthetic", codexHome: "/synthetic/home", platformFamily: "unix", platformOs: "macos" } });
  await connection.initialized;
  assert.equal(session.state, "ready");
  assert.deepEqual(outgoing(session), [{ method: "initialized" }]);
  feed(session, { id: request.id, result: null });
  assert.deepEqual(outgoing(session), []);
});
test("rejects invalid initialization and permits explicit reconnect", async () => {
  const session = new ProtocolSession(); const connection = session.connect();
  const rejected = assert.rejects(connection.initialized, /invalid-protocol/);
  const request = outgoing(session)[0]!;
  feed(session, { id: request.id, result: {} });
  await rejected;
  assert.equal(session.state, "failed");
  const next = session.connect(); const cancelled = assert.rejects(next.initialized, /transport-closed/);
  assert.equal(next.epoch, connection.epoch + 1);
  session.disconnect(next.epoch); await cancelled;
});
test("initialization RPC rejection sends no initialized notification", async () => {
  const session = new ProtocolSession(); const connection = session.connect();
  const rejected = assert.rejects(connection.initialized, /rpc-error:-32600/);
  const request = outgoing(session)[0]!;
  feed(session, { id: request.id, error: { code: -32600, message: "synthetic rejection" } });
  await rejected;
  assert.equal(session.state, "failed"); assert.deepEqual(outgoing(session), []);
});
test("matches out-of-order responses and isolates caller mutations", async () => {
  const session = await ready();
  const params = { threadId: "thread-demo" };
  const a = session.readThread(params); const b = session.readThread({ threadId: "thread-other" });
  params.threadId = "caller-mutated";
  const requests = outgoing(session);
  feed(session, { id: requests[1]!.id, result: { thread: { ...syntheticThread(), id: "thread-other" } } });
  feed(session, { id: requests[0]!.id, result: { thread: syntheticThread() } });
  assert.equal((await a).thread.id, "thread-demo"); assert.equal((await b).thread.id, "thread-other");
  assert.equal(session.pendingCount, 0); assert.equal(session.state, "ready");
  const snapshot = session.snapshot(); snapshot[0]!.id = "changed";
  assert.equal(session.snapshot()[0]!.id, "thread-other");
});
test("error responses reject only their request and unknown responses are diagnosed", async () => {
  const session = await ready(); const request = session.request("thread/read", { threadId: "thread-demo" });
  const rejected = assert.rejects(request, /rpc-error:-32602/); const sent = outgoing(session)[0]!;
  feed(session, { id: sent.id, error: { code: -32602, message: "synthetic" } }); await rejected;
  feed(session, { id: "unknown", result: null });
  assert.equal(session.state, "ready"); assert.equal(session.pendingCount, 0);
  assert.ok(session.takeEvents().some(event => event.code === "unmatched-response"));
});
test("rejects unimplemented, experimental, prototype-named methods and unreviewed fields", async () => {
  const session = await ready();
  assert.throws(() => session.request("turn/resume", {}), /unsupported-method/);
  assert.throws(() => session.request("project/list", {}), /experimental-disabled/);
  assert.throws(() => session.request("__proto__", {}), /unsupported-method/);
  assert.throws(() => session.request("thread/read", {}), /Invalid threadReadParams/);
  assert.throws(() => session.request("thread/read", { threadId: "thread-demo", futureField: true }), /unsupported-field/);
  assert.deepEqual(outgoing(session), []);
});
test("replays synthetic flow byte-by-byte without breaking UTF-8 or terminal state", async () => {
  const session = await ready();
  for (let i = 0; i < fixtureBytes.length; i++) session.receive(fixtureBytes.subarray(i, i + 1), session.epoch);
  const turn = session.snapshot()[0]!.turns[0]!;
  assert.equal(turn.status, "completed"); assert.equal(turn.items[0]!.text, "合成输出");
  assert.equal(turn.items[0]!.completed, true); assert.deepEqual(outgoing(session), []);
});
test("legitimate repeated text is retained; final item text supersedes streaming and late deltas", async () => {
  const session = await ready();
  feed(session, fixtureMessages[1]);
  const delta = { method: "item/agentMessage/delta", params: { threadId: "thread-demo", turnId: "turn-demo", itemId: "message-demo", delta: "ha" } };
  feed(session, delta); feed(session, delta);
  assert.equal(session.snapshot()[0]!.turns[0]!.items[0]!.text, "haha");
  feed(session, fixtureMessages[5]); feed(session, delta); feed(session, fixtureMessages[2]);
  assert.equal(session.snapshot()[0]!.turns[0]!.items[0]!.text, "合成输出");
  feed(session, fixtureMessages[6]); feed(session, fixtureMessages[1]);
  assert.equal(session.snapshot()[0]!.turns[0]!.status, "completed");
});
for (const status of ["interrupted", "failed"]) {
  test(`preserves ${status} turn completion rather than treating it as success`, async () => {
    const session = await ready(); feed(session, fixtureMessages[1]);
    feed(session, { method: "turn/completed", params: { threadId: "thread-demo", turn: syntheticTurn(status) } });
    assert.equal(session.snapshot()[0]!.turns[0]!.status, status);
  });
}
test("interleaved threads and colliding item IDs remain independent", async () => {
  const session = await ready();
  for (const threadId of ["A", "B"]) feed(session, { method: "item/agentMessage/delta", params: { threadId, turnId: "same", itemId: "same", delta: threadId } });
  assert.deepEqual(session.snapshot().map(thread => thread.turns[0]!.items[0]!.text), ["A", "B"]);
});
test("unknown notifications do not mutate projection or expose payload in diagnostics", async () => {
  const session = await ready(); feed(session, { method: "future/event", params: { privateText: "do-not-log" } });
  assert.deepEqual(session.snapshot(), []); assert.equal(session.state, "ready");
  assert.ok(!JSON.stringify(session.takeEvents()).includes("do-not-log"));
});
test("in-flight snapshot cannot overwrite newer streamed events", async () => {
  const session = await ready(); feed(session, fixtureMessages[1]);
  const response = session.request("thread/read", { threadId: "thread-demo", includeTurns: true });
  const request = outgoing(session)[0]!;
  feed(session, fixtureMessages[3]);
  feed(session, { id: request.id, result: { thread: { ...syntheticThread(), turns: [syntheticTurn("completed")] } } });
  await response;
  assert.equal(session.snapshot()[0]!.turns[0]!.status, "inProgress");
  assert.equal(session.snapshot()[0]!.turns[0]!.items[0]!.text, "合成");
  assert.ok(session.takeEvents().some(event => event.type === "snapshot-obsolete"));
});
test("metadata-only notifications do not erase streamed history", async () => {
  const session = await ready(); session.receive(fixtureBytes, session.epoch); feed(session, fixtureMessages[0]);
  assert.equal(session.snapshot()[0]!.turns[0]!.items[0]!.text, "合成输出");
});
for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"]) {
  test(`${method}: explicit once-only decision waits for server resolution`, async () => {
    const session = await ready(); feed(session, approval("approval-demo", method));
    const view = session.approvals()[0]!;
    assert.equal(view.status, "pending"); assert.deepEqual(outgoing(session), []);
    session.respondApproval(view, "decline");
    const result = outgoing(session)[0]!;
    validate(method.includes("command") ? "commandApprovalResult" : "fileApprovalResult", result.result);
    assert.deepEqual(result, { id: "approval-demo", result: { decision: "decline" } });
    assert.equal(session.approvals()[0]!.status, "responded");
    assert.throws(() => session.respondApproval(view, "accept"), /approval-not-pending/);
    feed(session, { method: "serverRequest/resolved", params: { threadId: "thread-demo", requestId: "approval-demo" } });
    assert.equal(session.approvals()[0]!.status, "resolved");
  });
}
test("string and numeric server IDs are distinct and do not collide with client IDs", async () => {
  const session = await ready(); const read = session.request("thread/read", { threadId: "thread-demo" });
  const sent = outgoing(session)[0]!;
  feed(session, approval(1)); feed(session, approval("1")); feed(session, approval(sent.id as string));
  assert.equal(session.approvals().length, 3);
  for (const view of session.approvals()) session.respondApproval(view, "cancel");
  assert.equal(outgoing(session).length, 3);
  feed(session, { id: sent.id, result: { thread: syntheticThread() } }); await read;
});
test("duplicate requests never re-open responded or resolved approvals", async () => {
  const session = await ready(); const request = approval(); feed(session, request); feed(session, request);
  assert.equal(session.approvals().length, 1);
  session.respondApproval(session.approvals()[0]!, "accept"); outgoing(session); feed(session, request);
  assert.deepEqual(outgoing(session), []);
  feed(session, { method: "serverRequest/resolved", params: { threadId: "thread-demo", requestId: request.id } });
  feed(session, request); assert.equal(session.approvals()[0]!.status, "resolved");
});
test("resolved-before-request stays closed and wrong-thread resolution cannot dismiss an approval", async () => {
  const session = await ready();
  feed(session, { method: "serverRequest/resolved", params: { threadId: "thread-demo", requestId: "early" } });
  feed(session, approval("early")); assert.deepEqual(session.approvals(), []);
  feed(session, approval());
  feed(session, { method: "serverRequest/resolved", params: { threadId: "wrong", requestId: "approval-demo" } });
  assert.equal(session.approvals()[0]!.status, "pending");
});
test("unsupported server requests return one error; no tool execution or credential refresh", async () => {
  const session = await ready();
  const request = { id: "tool", method: "item/tool/call", params: { command: "never-run" } };
  feed(session, request); feed(session, request);
  assert.deepEqual(outgoing(session), [{ id: "tool", error: { code: -32601, message: "Client method not implemented" } }]);
  feed(session, { id: "auth", method: "account/chatgptAuthTokens/refresh", params: {} });
  assert.equal((outgoing(session)[0]!.error as any).code, -32601);
  assert.deepEqual(session.approvals(), []);
});
test("conflicting duplicate IDs fail closed without granting approval", async () => {
  const session = await ready(); feed(session, approval()); feed(session, approval("approval-demo", "item/fileChange/requestApproval"));
  assert.equal(session.state, "failed"); assert.deepEqual(outgoing(session), []);
});
test("stale and wrong-thread handles, persistent decisions, and experimental fields are rejected", async () => {
  const session = await ready(); feed(session, approval()); const view = session.approvals()[0]!;
  assert.throws(() => session.respondApproval({ ...view, threadId: "other" }, "accept"), /approval-not-pending/);
  assert.throws(() => session.respondApproval(view, "acceptForSession" as any), /unsupported-approval-decision/);
  feed(session, { ...approval("exp"), params: { ...approval().params, additionalPermissions: null } });
  assert.equal(session.state, "failed");
  assert.throws(() => session.respondApproval(view, "accept"), /stale-approval/);
});
test("disconnect makes pending results unknown, invalidates approvals, and never replays", async () => {
  const session = await ready(); session.receive(fixtureBytes, session.epoch); feed(session, approval());
  const view = session.approvals()[0]!;
  const read = session.request("thread/read", { threadId: "thread-other" });
  const rejected = assert.rejects(read, error => error instanceof ProtocolSessionError && error.outcome === "unknown");
  outgoing(session);
  const oldEpoch = session.epoch; session.disconnect(oldEpoch); await rejected;
  assert.equal(session.state, "disconnected"); assert.equal(session.pendingCount, 0);
  assert.equal(session.snapshot()[0]!.stale, true); assert.deepEqual(outgoing(session), []);
  assert.deepEqual(new Set(session.recoveryPlan().threadIds), new Set(["thread-demo", "thread-other"]));
  assert.equal(session.recoveryPlan().automaticReplay, false);
  const next = session.connect(); const request = outgoing(session)[0]!;
  feed(session, fixtureMessages[1], oldEpoch);
  feed(session, { id: request.id, result: { userAgent: "synthetic", codexHome: "/synthetic/home", platformFamily: "unix", platformOs: "macos" } }); await next.initialized;
  assert.deepEqual(outgoing(session), [{ method: "initialized" }]);
  assert.throws(() => session.respondApproval(view, "accept"), /stale-approval/);
  feed(session, { ...approval(), id: "fresh" }); assert.equal(session.approvals()[0]!.status, "pending");
});
test("explicit recovery read refreshes full item views but does not erase an omitted old turn", async () => {
  const session = await ready(); session.receive(fixtureBytes, session.epoch); session.disconnect(session.epoch);
  const next = session.connect(); const initialization = outgoing(session)[0]!;
  feed(session, { id: initialization.id, result: { userAgent: "synthetic", codexHome: "/synthetic/home", platformFamily: "unix", platformOs: "macos" } }); await next.initialized; outgoing(session);
  const metadata = session.request("thread/read", { threadId: "thread-demo" }); const metaId = outgoing(session)[0]!.id;
  feed(session, { id: metaId, result: { thread: syntheticThread() } }); await metadata;
  assert.equal(session.snapshot()[0]!.stale, true);
  const full = session.request("thread/read", { threadId: "thread-demo", includeTurns: true }); const fullId = outgoing(session)[0]!.id;
  feed(session, { id: fullId, result: { thread: { ...syntheticThread(), turns: [syntheticTurn("completed", [{ type: "agentMessage", id: "message-demo", text: "恢复" }])] } } }); await full;
  assert.equal(session.snapshot()[0]!.stale, false); assert.equal(session.snapshot()[0]!.turns[0]!.items[0]!.text, "恢复");
});
test("a response for the wrong thread fails closed and cannot populate that projection", async () => {
  const session = await ready(); const read = session.request("thread/read", { threadId: "A" });
  const rejected = assert.rejects(read, /invalid-protocol/); const request = outgoing(session)[0]!;
  feed(session, { id: request.id, result: { thread: syntheticThread() } }); await rejected;
  assert.deepEqual(session.snapshot(), []);
});
for (const malformed of [null, [], { id: null, result: null }, { id: 9007199254740992, result: null }, { id: 1, result: null, error: {} }, { method: "x", id: 1, result: null }]) {
  test(`invalid envelope ${JSON.stringify(malformed)} closes transport deterministically`, async () => {
    const session = await ready(); feed(session, malformed); assert.equal(session.state, "failed");
  });
}
test("invalid known payload and truncated EOF cannot mark a running turn successful", async () => {
  const session = await ready(); feed(session, fixtureMessages[1]);
  feed(session, { method: "turn/completed", params: { threadId: "thread-demo", turn: syntheticTurn("future-status") } });
  assert.equal(session.state, "failed"); assert.equal(session.snapshot()[0]!.turns[0]!.status, "inProgress");
  const other = await ready(); other.receive(Buffer.from('{"method":'), other.epoch); other.end(other.epoch);
  assert.equal(other.state, "failed"); assert.ok(other.takeEvents().some(event => event.code === "truncated-jsonl"));
});
test("request timeouts reject, free pending capacity and ignore late responses", async () => {
  const session = await ready({ timeoutMs: 20 }); const read = session.request("thread/read", { threadId: "thread-demo" });
  const rejected = assert.rejects(read, /request-timeout/); const request = outgoing(session)[0]!;
  await delay(30); await rejected;
  assert.equal(session.pendingCount, 0); assert.equal(session.state, "ready");
  feed(session, { id: request.id, result: { thread: syntheticThread() } }); assert.deepEqual(session.snapshot(), []);
});
test("limits pending calls, server IDs, outbound queues, projections and diagnostics", async () => {
  const pending = await ready({ maxPending: 1 }); const read = pending.request("thread/read", { threadId: "thread-demo" });
  const rejected = assert.rejects(read, /transport-closed/);
  assert.throws(() => pending.request("thread/read", { threadId: "other" }), /pending-limit/);
  pending.disconnect(pending.epoch); await rejected;
  const server = await ready({ maxServerRequests: 1 }); feed(server, approval(1)); feed(server, approval(2));
  assert.equal(server.state, "failed"); assert.deepEqual(outgoing(server), []);
  const projection = await ready({ maxProjectionBytes: 100 }); projection.receive(fixtureBytes, projection.epoch);
  assert.equal(projection.state, "failed");
  const outgoingLimited = new ProtocolSession({ maxOutboundBytes: 1 });
  assert.throws(() => outgoingLimited.connect(), /outbound-limit/); assert.equal(outgoingLimited.state, "failed");
  const diagnostics = await ready(); for (let i = 0; i < 300; i++) feed(diagnostics, { method: "unknown" });
  assert.equal(diagnostics.takeEvents().length, 256); assert.equal(diagnostics.eventsDropped > 0, true);
});
test("resolved approvals retract queued replies without removing a colliding client request", async () => {
  const session = await ready(); const read = session.readThread({ threadId: "thread-demo" });
  const clientId = "wb:1:2";
  feed(session, approval(clientId)); session.respondApproval(session.approvals()[0]!, "accept");
  feed(session, { method: "serverRequest/resolved", params: { threadId: "thread-demo", requestId: clientId } });
  assert.deepEqual(session.approvals()[0]!.params, {});
  const frames = outgoing(session);
  assert.equal(frames.length, 1); assert.equal(frames[0]!.method, "thread/read");
  feed(session, { id: frames[0]!.id, result: { thread: syntheticThread() } }); await read;
});
test("late item completion fills final data without reopening a terminal turn", async () => {
  const session = await ready(); feed(session, fixtureMessages[1]); feed(session, fixtureMessages[2]);
  feed(session, fixtureMessages[6]); feed(session, fixtureMessages[5]); feed(session, fixtureMessages[3]);
  const turn = session.snapshot()[0]!.turns[0]!;
  assert.equal(turn.status, "completed"); assert.equal(turn.items[0]!.text, "合成输出");
  assert.equal(turn.items[0]!.completed, true);
});
test("uncertain calls and stale approvals survive multiple disconnections", async () => {
  const session = await ready(); feed(session, approval());
  const read = session.readThread({ threadId: "unloaded-thread" }); const rejected = assert.rejects(read, /transport-closed/);
  outgoing(session); session.disconnect(session.epoch); await rejected;
  const next = session.connect(); const initialization = outgoing(session)[0]!;
  feed(session, { id: initialization.id, result: { userAgent: "synthetic", codexHome: "/synthetic/home", platformFamily: "unix", platformOs: "macos" } }); await next.initialized;
  session.disconnect(session.epoch);
  assert.deepEqual(new Set(session.recoveryPlan().threadIds), new Set(["unloaded-thread", "thread-demo"]));
  assert.equal(session.recoveryPlan().uncertainRequests.length, 1);
  assert.equal(session.recoveryPlan().staleApprovals.length, 1);
  session.acknowledgeRecovery(); assert.deepEqual(session.recoveryPlan().threadIds, []);
  assert.equal(session.state, "disconnected"); assert.deepEqual(outgoing(session), []);
});
test("sent timeout enters recovery; explicit later read recovers facts", async () => {
  const session = await ready({ timeoutMs: 20 }); const read = session.readThread({ threadId: "thread-demo" });
  const rejected = assert.rejects(read, error => error instanceof ProtocolSessionError && error.outcome === "unknown");
  outgoing(session); await delay(30); await rejected;
  assert.equal(session.recoveryPlan().uncertainRequests.length, 1);
  assert.deepEqual(session.recoveryPlan().threadIds, ["thread-demo"]);
  const reread = session.readThread({ threadId: "thread-demo" }); const request = outgoing(session)[0]!;
  feed(session, { id: request.id, result: { thread: syntheticThread() } }); await reread;
  assert.deepEqual(session.recoveryPlan().uncertainRequests, []);
});
test("unsent timeout retracts its frame and reports not-sent", async () => {
  const session = await ready({ timeoutMs: 20 }); const read = session.readThread({ threadId: "thread-demo" });
  const rejected = assert.rejects(read, error => error instanceof ProtocolSessionError && error.outcome === "not-sent");
  await delay(30); await rejected;
  assert.deepEqual(outgoing(session), []); assert.deepEqual(session.recoveryPlan().uncertainRequests, []);
});
test("server request bytes and reserved recovery data are bounded", async () => {
  const server = await ready({ maxServerRequestBytes: 1024 });
  feed(server, { ...approval(), params: { ...approval().params, reason: "x".repeat(2048) } });
  assert.equal(server.state, "failed"); assert.deepEqual(outgoing(server), []);
  const recovery = await ready({ timeoutMs: 20, maxRecoveryEntries: 1 });
  const read = recovery.readThread({ threadId: "thread-demo" }); const rejected = assert.rejects(read, /request-timeout/);
  outgoing(recovery); await delay(30); await rejected;
  assert.throws(() => recovery.readThread({ threadId: "other" }), /recovery-limit/);
  recovery.acknowledgeRecovery();
  const next = recovery.readThread({ threadId: "other" }); const nextRejected = assert.rejects(next, /transport-closed/);
  recovery.disconnect(recovery.epoch); await nextRejected;
});
test("large batches of valid frames do not depend on transport chunk boundaries", async () => {
  const session = await ready();
  const frame = JSON.stringify({ method: "future/event", params: { text: "x".repeat(900000) } }) + "\n";
  session.receive(Buffer.from(frame.repeat(5)), session.epoch);
  assert.equal(session.state, "ready");
  assert.equal(session.takeEvents().filter(event => event.code === "unknown-notification").length, 5);
});
test("disconnect before dequeue reports not-sent and leaves no uncertain read", async () => {
  const session = await ready(); const read = session.readThread({ threadId: "never-dequeued" });
  const rejected = assert.rejects(read, error => error instanceof ProtocolSessionError && error.outcome === "not-sent");
  session.disconnect(session.epoch); await rejected;
  assert.deepEqual(outgoing(session), []);
  assert.deepEqual(session.recoveryPlan().uncertainRequests, []);
});

test("account/model reads reject refresh and unknown fields while validating bounded replies", async () => {
  const { ready, outgoing, feed } = await import("./helpers.ts"); const session = await ready();
  assert.throws(() => session.getAccount({ refreshToken: true }), /explicit-refresh-disabled/);
  assert.throws(() => session.request("account/read", { apiKey: "never" }), /unsupported-field/);
  const account = session.getAccount({ refreshToken: false }); const sent = outgoing(session)[0]!;
  feed(session, { id: sent.id, result: { account: null, requiresOpenaiAuth: true } }); assert.equal((await account).account, null);
  assert.throws(() => session.listModels({ limit: 101 }), /invalid-page-limit/);
  const models = session.listModels({ limit: 1 }); const modelRequest = outgoing(session)[0]!;
  feed(session, { id: modelRequest.id, result: { data: [], nextCursor: null } }); assert.deepEqual((await models).data, []);
  session.disconnect(session.epoch);
});

test("configuration reads reject project scopes and layers", async () => {
  const session = await ready();
  assert.throws(() => session.readConfiguration({ includeLayers: true }), /config-layers-disabled/);
  assert.throws(() => session.readConfiguration({ includeLayers: false, cwd: "/private-project" }), /unsupported-field/);
  const response = session.readConfiguration({ includeLayers: false }); const sent = outgoing(session)[0]!;
  assert.equal(sent.method, "config/read"); assert.deepEqual(sent.params, { includeLayers: false });
  const rejected = assert.rejects(response, /transport-closed/); session.disconnect(session.epoch); await rejected;
});

test("saved metadata reads validate identity without filling live projection",async()=>{
 const session=await ready();for(let n=0;n<130;n++){const id="saved-"+n;const call=session.readThreadMetadata({threadId:id});const request=outgoing(session)[0]!;assert.deepEqual(request.params,{threadId:id,includeTurns:false});feed(session,{id:request.id,result:{thread:{...syntheticThread(),id,turns:[]}}});await call;}assert.equal(session.state,"ready");assert.deepEqual(session.snapshot(),[]);
 assert.throws(()=>session.readThreadMetadata({threadId:"saved",path:"/private"} as any),/unsupported-field/);const mismatched=session.readThreadMetadata({threadId:"saved"});const rejected=assert.rejects(mismatched,/invalid-protocol/);const request=outgoing(session)[0]!;feed(session,{id:request.id,result:{thread:syntheticThread()}});await rejected;assert.equal(session.state,"failed");
});
test("thread catalog input and replies retain bounds and forbid path filters",async()=>{
 const session=await ready();assert.throws(()=>session.listThreads({cwd:"/private"} as any),/unsupported-field/);assert.throws(()=>session.listThreads({limit:101}),/invalid-page-limit/);assert.throws(()=>session.listThreads({cursor:"x".repeat(4097)}),/invalid-page-cursor/);assert.throws(()=>session.listThreads({modelProviders:Array(17).fill("openai")}),/invalid-provider-filter/);
 assert.throws(()=>session.listThreads({sourceKinds:Array(11).fill("cli")}),/invalid-source-filter/);const good=session.listThreads({limit:1,modelProviders:[],sourceKinds:["cli","vscode","appServer"]});let request=outgoing(session)[0]!;feed(session,{id:request.id,result:{data:[syntheticThread()],nextCursor:"opaque",backwardsCursor:null}});assert.equal((await good).nextCursor,"opaque");
 const oversized=session.listThreads({limit:1});const rejected=assert.rejects(oversized,/invalid-protocol/);request=outgoing(session)[0]!;feed(session,{id:request.id,result:{data:[syntheticThread(),syntheticThread()],nextCursor:null,backwardsCursor:null}});await rejected;assert.equal(session.state,"failed");
});

test("persistent start and ID-only resume reject unreviewed history/path or elevated policies",async()=>{
 const session=await ready();const options={threadId:"saved",model:"gpt-fixture-one",modelProvider:"openai",cwd:"/synthetic/chat",approvalPolicy:"never" as const,sandbox:"read-only" as const,excludeTurns:true};assert.throws(()=>session.resumeThread({...options,path:"/private"} as any),/unsupported-field/);assert.throws(()=>session.resumeThread({...options,sandbox:"danger-full-access"}),/invalid-session-resume/);assert.throws(()=>session.resumeThread({...options,excludeTurns:false}),/invalid-session-resume/);assert.throws(()=>session.request("thread/delete",{threadId:"saved"}),/unsupported-method/);
 const response=session.resumeThread(options);const sent=outgoing(session)[0]!;assert.equal(sent.method,"thread/resume");const rejected=assert.rejects(response,/transport-closed/);session.disconnect(session.epoch);await rejected;
});
