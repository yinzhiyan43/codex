import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { StdioWorkbenchHost, HostOperationError, createCodexLauncher } from "../desktop-host/index.ts";
import type { HostOptions } from "../desktop-host/index.ts";
const fixture = fileURLToPath(new URL("fixtures/mock-server.mjs", import.meta.url));

function peer(modes = ["normal"], options: HostOptions = {}) {
  const children: ChildProcessWithoutNullStreams[] = [];
  let calls = 0;
  const host = new StdioWorkbenchHost(() => {
    const child = spawn(process.execPath, [fixture, modes[Math.min(calls++, modes.length - 1)]!],
      { cwd: dirname(fixture), env: {}, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    children.push(child); return child;
  }, { requestTimeoutMs: 1000, shutdownGraceMs: 30, terminateGraceMs: 30, closeTimeoutMs: 1000, ...options });
  return { host, children, launches: () => calls };
}
async function until(predicate: () => boolean, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error("Synthetic condition timed out"); await delay(5); }
}
function released(child: ChildProcessWithoutNullStreams) {
  for (const event of ["spawn", "exit", "close", "error"]) assert.equal(child.listenerCount(event), 0, event);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
  assert.equal(child.stdin.listenerCount("drain"), 0);
}
test("real synthetic pipe initializes, reads, notifies and releases owned resources", async t => {
  const { host, children, launches } = peer(); t.after(() => host.dispose());
  let notices = 0; const unsubscribe = host.subscribe(() => notices++);
  await host.start(); assert.equal(host.getView().state, "ready"); await host.start(); assert.equal(launches(), 1);
  const response = await host.readThread({ threadId: "thread-demo" }); assert.equal(response.thread.preview, "合成:1");
  assert.ok(notices > 0); unsubscribe(); await delay(0); const count = notices;
  await host.stop(); await delay(0); assert.equal(notices, count);
  assert.equal(host.getView().processActive, false); assert.equal(host.getView().state, "stopped"); released(children[0]!);
});
test("fragmented peer writes preserve Chinese and coalesce change notifications", async t => {
  const { host } = peer(["fragmented"]); t.after(() => host.dispose()); await host.start();
  assert.equal((await host.readThread({ threadId: "thread-demo" })).thread.preview, "合成:1");
});
test("renderer client excludes executable settings, raw RPC and streams", async t => {
  const { host } = peer(); t.after(() => host.dispose()); const client = host.client();
  assert.equal(Object.isFrozen(client), true);
  assert.deepEqual(Object.keys(client).sort(), ["acknowledgeRecovery", "dispose", "getView", "readThread", "reconnect", "respondApproval", "start", "stop", "subscribe", "takeDiagnostics"].sort());
  await assert.rejects(client.readThread({ threadId: "thread-demo" }), /not-ready/);
  await client.start(); await assert.rejects(client.readThread({ threadId: 1 } as any), /invalid-client-operation/);
});
test("stderr is drained but only byte counts enter bounded diagnostics", async t => {
  const { host } = peer(["stderr"]); t.after(() => host.dispose()); await host.start();
  const records: ReturnType<typeof host.takeDiagnostics> = [];
  await until(() => { records.push(...host.takeDiagnostics()); return records.some(item => item.code === "stderr-output"); });
  await host.readThread({ threadId: "thread-demo" });
  records.push(...host.takeDiagnostics());
  assert.ok(records.some(item => (item.stderrBytes ?? 0) > 0));
  const serialized = JSON.stringify(records); assert.ok(!serialized.includes("TOKEN")); assert.ok(!serialized.includes("/private"));
});
for (const mode of ["malformed", "truncated", "close-stdout", "crash-init", "reject-init"]) {
  test(`${mode} propagates bounded failure/disconnect and reaps peer`, async t => {
    const { host, children } = peer([mode]); t.after(() => host.dispose());
    try { await host.start(); } catch (error) { assert.ok(error instanceof HostOperationError); }
    await until(() => !host.getView().processActive);
    assert.ok(["failed", "disconnected"].includes(host.getView().state));
    assert.ok(!JSON.stringify(host.takeDiagnostics()).includes("synthetic-private")); released(children[0]!);
  });
}
test("spawn errors never expose executable paths and allow explicit retry", async t => {
  const childList: ChildProcessWithoutNullStreams[] = []; let launches = 0;
  const host = new StdioWorkbenchHost(() => {
    launches++;
    const child = launches === 1 ? spawn("/synthetic/missing-private-binary", [], { env: {}, stdio: ["pipe", "pipe", "pipe"] })
      : spawn(process.execPath, [fixture, "normal"], { cwd: dirname(fixture), env: {}, stdio: ["pipe", "pipe", "pipe"] });
    childList.push(child); return child;
  }); t.after(() => host.dispose());
  await assert.rejects(host.start(), /spawn-failed/); await until(() => !host.getView().processActive);
  assert.ok(!JSON.stringify(host.takeDiagnostics()).includes("missing-private-binary")); released(childList[0]!);
  await host.start(); assert.equal(launches, 2);
});
test("synchronous launcher failure does not retain a generation or unhandled rejection", async t => {
  const host = new StdioWorkbenchHost(() => { throw new Error("synthetic-private-launch-error"); }); t.after(() => host.dispose());
  await assert.rejects(host.start(), /spawn-failed/); assert.equal(host.getView().processActive, false);
  assert.ok(!JSON.stringify(host.takeDiagnostics()).includes("private-launch"));
});
test("handshake timeout kills/reaps the peer without input-driven polling", async t => {
  const { host, children } = peer(["hang-init"], { requestTimeoutMs: 200 }); t.after(() => host.dispose());
  await assert.rejects(host.start(), /initialization-failed|protocol-failed/);
  await until(() => !host.getView().processActive); released(children[0]!);
});
test("process failure rejects sent reads and explicit reconnect does not replay them", async t => {
  const { host, launches } = peer(["crash-read", "normal"]); t.after(() => host.dispose()); await host.start();
  await assert.rejects(host.readThread({ threadId: "thread-demo" }), error => error instanceof HostOperationError && error.outcome === "unknown");
  await until(() => !host.getView().processActive);
  assert.equal(host.getView().recovery.automaticReplay, false);
  await host.reconnect(); await until(() => host.getView().threads.some(thread => thread.id === "fixture-metrics" && thread.metadata?.preview === "reads:0"));
  assert.equal(launches(), 2); assert.equal((await host.readThread({ threadId: "thread-demo" })).thread.preview, "合成:1");
});
test("buffered final response is processed before the process close", async t => {
  const { host } = peer(["final-exit"]); t.after(() => host.dispose()); await host.start();
  assert.equal((await host.readThread({ threadId: "thread-demo" })).thread.preview, "合成:1");
  await until(() => !host.getView().processActive); assert.equal(host.getView().state, "disconnected");
});
test("approval roundtrip resolves once and old-generation handles cannot be sent", async t => {
  const { host } = peer(["approval", "normal"]); t.after(() => host.dispose()); await host.start();
  await until(() => host.getView().approvals.length === 1); const approval = host.getView().approvals[0]!;
  host.respondApproval(approval, "decline"); await until(() => host.getView().approvals[0]!.status === "resolved");
  assert.throws(() => host.respondApproval(approval, "accept"), /approval-not-pending/);
  await host.reconnect(); assert.throws(() => host.respondApproval(approval, "accept"), /stale-approval/);
});
test("stop invalidates unanswered approvals and preserves local recovery notice", async t => {
  const { host } = peer(["approval"]); t.after(() => host.dispose()); await host.start();
  await until(() => host.getView().approvals.length === 1); const approval = host.getView().approvals[0]!;
  await host.stop(); assert.equal(host.getView().approvals.length, 0); assert.equal(host.getView().recovery.staleApprovals.length, 1);
  assert.throws(() => host.respondApproval(approval, "accept"), /not-ready/);
});
test("shutdown escalates only the owned stubborn peer and releases listeners", async t => {
  const { host, children } = peer(["ignore-stop"]); t.after(() => host.dispose()); await host.start();
  await host.stop(); assert.equal(children[0]!.signalCode, "SIGKILL"); released(children[0]!);
});
test("real stdin backpressure keeps the second read queued/not-sent on stop", async t => {
  const { host } = peer(["no-read"]); t.after(() => host.dispose()); await host.start();
  await until(() => host.getView().threads.some(thread => thread.id === "peer-paused"));
  const first = host.readThread({ threadId: "x".repeat(800000) }); const second = host.readThread({ threadId: "second" });
  const a = assert.rejects(first, error => error instanceof HostOperationError && error.outcome === "unknown");
  const b = assert.rejects(second, error => error instanceof HostOperationError && error.outcome === "not-sent");
  await host.stop(); await Promise.all([a, b]);
  assert.equal(host.getView().recovery.uncertainRequests.length, 1);
});
test("concurrent start/reconnect is serialized and disposed clients stay closed", async () => {
  const { host, launches } = peer(); await Promise.all([host.start(), host.start()]); assert.equal(launches(), 1);
  await Promise.all([host.reconnect(), host.reconnect()]); assert.equal(launches(), 2);
  await Promise.all([host.dispose(), host.dispose()]); assert.equal(host.getView().state, "disposed");
  await assert.rejects(host.start(), /host-disposed/); assert.throws(() => host.subscribe(() => {}), /host-disposed/);
});
test("stop during startup cancels handshake and does not leave listeners", async () => {
  const { host, children } = peer(["hang-init"]); const start = host.start(); const rejected = assert.rejects(start, /host-stopped/);
  await host.stop(); await rejected; assert.equal(host.getView().state, "stopped"); released(children[0]!); await host.dispose();
});
test("throwing subscribers are isolated and their removal prevents more callbacks", async t => {
  const { host } = peer(); t.after(() => host.dispose()); const unsubscribe = host.subscribe(() => { throw new Error("private-ui-error"); });
  await host.start(); unsubscribe(); assert.equal((await host.readThread({ threadId: "thread-demo" })).thread.id, "thread-demo");
});
test("production launch configuration is immutable, bounded and shell-free by construction", () => {
  const configuration = { executable: "/synthetic/codex", cwd: "/synthetic/project", environment: { LANG: "C" } };
  const launcher = createCodexLauncher(configuration); configuration.executable = "/another-path";
  assert.equal(typeof launcher, "function"); // Deliberately never launch a real Codex binary here.
  assert.throws(() => createCodexLauncher({ executable: "codex", cwd: "/synthetic" }), /Invalid launch path/);
  assert.throws(() => createCodexLauncher({ executable: "/synthetic/codex", cwd: "/synthetic", environment: { TOKEN: "never-inherit" } }), /Invalid launch environment/);
  assert.throws(() => createCodexLauncher({ executable: "/synthetic/codex\0", cwd: "/synthetic" }), /Invalid launch path/);
});
test("later stop supersedes a reconnect waiting for close and prevents respawn", async t => {
  const { host, launches } = peer(); t.after(() => host.dispose()); await host.start();
  const reconnect = host.reconnect(); const rejected = assert.rejects(reconnect, /lifecycle-superseded/);
  await host.stop(); await rejected;
  assert.equal(launches(), 1); assert.equal(host.getView().state, "stopped"); assert.equal(host.getView().processActive, false);
});
test("dispose supersedes pending reconnect without starting a new peer", async () => {
  const { host, launches } = peer(); await host.start(); const reconnect = host.reconnect();
  const rejected = assert.rejects(reconnect, /lifecycle-superseded/);
  await host.dispose(); await rejected; assert.equal(launches(), 1); assert.equal(host.getView().state, "disposed");
});
test("late actual close finalizes disposal after a bounded kill failure", async () => {
  const { host, children } = peer(["ignore-stop"], { shutdownGraceMs: 10, terminateGraceMs: 10, closeTimeoutMs: 20 });
  await host.start(); const child = children[0]!; const realKill = child.kill.bind(child);
  child.kill = () => false; // Simulate an infrastructure kill failure, not a core denial.
  try {
    await assert.rejects(host.dispose(), /shutdown-timeout/);
    assert.equal(host.getView().state, "failed"); await assert.rejects(host.start(), /host-disposed/);
  } finally { realKill("SIGKILL"); }
  await until(() => host.getView().state === "disposed");
  await host.dispose(); released(child); assert.equal(host.getView().processActive, false);
});
test("exit blocks new reads while bounded stdout draining releases inherited pipe ends", async t => {
  const { host, children } = peer(["inherited-stdout"], { closeTimeoutMs: 80 }); t.after(() => host.dispose());
  try { await host.start(); } catch (error) { assert.ok(error instanceof HostOperationError); }
  await until(() => host.getView().state === "draining");
  await assert.rejects(host.readThread({ threadId: "must-not-send" }), /not-ready/);
  await until(() => !host.getView().processActive);
  assert.equal(host.getView().state, "failed");
  assert.ok(host.takeDiagnostics().some(item => item.code === "stdio-drain-timeout")); released(children[0]!);
});
test("stdin error propagation rejects in-flight work without leaking its raw error", async t => {
  const { host, children } = peer(); t.after(() => host.dispose()); await host.start();
  const read = host.readThread({ threadId: "thread-demo" }); const rejected = assert.rejects(read, /stdin-error/);
  children[0]!.stdin.emit("error", new Error("synthetic-private-pipe-error"));
  await rejected; await until(() => !host.getView().processActive);
  assert.ok(!JSON.stringify(host.takeDiagnostics()).includes("private-pipe")); released(children[0]!);
});
test("stderr-only inheritance never signals an already exited peer", async t => {
  const { host, children } = peer(["inherited-stderr"], { shutdownGraceMs: 10, terminateGraceMs: 10, closeTimeoutMs: 80 });
  t.after(() => host.dispose()); const starting = host.start(); const child = children[0]!;
  const signals: (NodeJS.Signals | number | undefined)[] = []; const realKill = child.kill.bind(child);
  child.kill = signal => { signals.push(signal); return realKill(signal); };
  try { await starting; } catch (error) { assert.ok(error instanceof HostOperationError); }
  await until(() => !host.getView().processActive);
  assert.deepEqual(signals, []); assert.equal(child.exitCode, 0); released(child);
});
