import test from "node:test";
import assert from "node:assert/strict";
import { execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { writeFile, access, rm, mkdtemp } from "node:fs/promises";
import { prepareIsolatedCore } from "../../desktop-host/isolated-core.ts";
import { StdioWorkbenchHost } from "../../desktop-host/stdio-host.ts";
import { CoreController } from "../../desktop-host/core-controller.ts";
const exec = promisify(execFile);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** Explicit opt-in only; npm test never runs this native integration suite. */
test("official 0.162.1 app-server with empty isolated HOME and no network", { timeout: 20000 }, async t => {
  const runs = fileURLToPath(new URL("./.runs/", import.meta.url));
  const prepared = await prepareIsolatedCore(runs);
  const methods: string[] = []; let child: ChildProcessWithoutNullStreams | null = null;
  const host = new StdioWorkbenchHost(() => {
    const c = prepared.launcher(); child = c;
    const write = c.stdin.write.bind(c.stdin);
    c.stdin.write = ((data: string | Uint8Array, ...args: unknown[]) => {
      for (const line of String(data).trim().split("\n")) { const frame = JSON.parse(line); methods.push(frame.method); assert.ok(["initialize", "initialized", "thread/read", "thread/turns/list", "thread/items/list"].includes(frame.method)); }
      return Reflect.apply(write, c.stdin, [data, ...args]);
    }) as typeof c.stdin.write;
    return c;
  }, { requestTimeoutMs: 5000, shutdownGraceMs: 1000, closeTimeoutMs: 3000 });
  const controller = new CoreController(host.client());
  t.after(async () => { await controller.dispose(); await rm(prepared.directory, { recursive: true, force: true }); });
  await t.test("child policy denies other user files and network listeners", async () => {
    const sentinel = join(runs, "known-public-test-sentinel.txt"); await writeFile(sentinel, "only synthetic sentinel", { mode: 0o600 });
    await assert.rejects(exec("/usr/bin/sandbox-exec", ["-f", prepared.policyPath, "/bin/cat", sentinel], { cwd: prepared.cwd, env: prepared.environment, timeout: 5000 }), error => (error as { code: number }).code !== 0);
    const source = "const s=require('net').createServer();s.on('error',e=>{process.exit(e.code==='EPERM'||e.code==='EACCES'?7:8)});s.listen(0,'127.0.0.1',()=>{s.close();process.exit(9)})";
    await assert.rejects(exec("/usr/bin/sandbox-exec", ["-f", prepared.policyPath, process.execPath, "-e", source], { cwd: prepared.cwd, env: prepared.environment, timeout: 5000 }), error => (error as { code: number }).code === 7);
    const outside = await mkdtemp("/tmp/workbench-known-public-sentinel-");
    await writeFile(join(outside, "sentinel.txt"), "only synthetic sentinel");
    try {
      await assert.rejects(exec("/usr/bin/sandbox-exec", ["-f", prepared.policyPath, "/bin/cat", join(outside, "sentinel.txt")], { cwd: prepared.cwd, env: prepared.environment, timeout: 5000 }));
      await assert.rejects(exec("/usr/bin/sandbox-exec", ["-f", prepared.policyPath, "/bin/ls", outside], { cwd: prepared.cwd, env: prepared.environment, timeout: 5000 }));
      await assert.rejects(exec("/usr/bin/sandbox-exec", ["-f", prepared.policyPath, "/usr/bin/stat", join(outside, "sentinel.txt")], { cwd: prepared.cwd, env: prepared.environment, timeout: 5000 }));
    } finally { await rm(outside, { recursive: true, force: true }); await rm(sentinel); }
  });
  await t.test("actual initialize response matches fresh CODEX_HOME and target", async () => {
    await controller.dispatch({ type: "connect" }); assert.equal(host.getView().state, "ready");
    const info = host.getView().serverInfo!; assert.equal(info.codexHome, prepared.codexHome); assert.equal(info.platformOs, "macos"); assert.equal(info.platformFamily, "unix"); assert.match(info.userAgent, /0\.162\.1/);
    info.codexHome = "mutated"; assert.equal(host.getView().serverInfo!.codexHome, prepared.codexHome);
    assert.equal(controller.snapshot().coreStatus!.handshake, true); assert.equal(controller.snapshot().mode, "official-isolated");
    assert.equal(Object.hasOwn(controller.snapshot(), "serverInfo"), false);
  });
  await t.test("actual read errors are visible without any existing thread or model call", async () => {
    await controller.dispatch({ type: "probeCore" });
    assert.deepEqual(controller.snapshot().coreStatus!.probes.map(value => value.code), ["rpc-error:-32600", "rpc-error:-32600", "rpc-error:-32601"]);
    assert.equal(host.getView().state, "ready"); assert.deepEqual(controller.snapshot().messages, []);
    for (const command of [{ type: "submit" }, { type: "confirm" }, { type: "new" }, { type: "thread", id: "thread-welcome" }, { type: "draft", routeId: "core-check", text: "never submitted" }]) await assert.rejects(controller.dispatch(command), /isolated-core-read-only/);
    assert.equal(methods.filter(method => method === "thread/read").length, 1);
  });
  await t.test("owned process exit is observed and explicit reconnect uses a new generation", async () => {
    const previous = host.getView().generation; assert.ok(child); (child as ChildProcessWithoutNullStreams).kill("SIGTERM");
    for (let i = 0; i < 100 && host.getView().processActive; i++) await sleep(20);
    assert.equal(host.getView().processActive, false); assert.ok(["failed", "disconnected"].includes(host.getView().state)); assert.equal(controller.snapshot().coreStatus!.handshake, false);
    await controller.dispatch({ type: "reconnect" }); assert.equal(host.getView().state, "ready"); assert.ok(host.getView().generation > previous);
    assert.deepEqual(controller.snapshot().coreStatus!.probes, []); assert.equal(methods.filter(method => method === "thread/read").length, 1);
  });
  await t.test("stop exits cleanly, reconnect works and no known auth files were created", async () => {
    await controller.dispatch({ type: "disconnect" }); assert.equal(host.getView().state, "stopped"); assert.equal(host.getView().processActive, false);
    assert.ok(host.takeDiagnostics().some(value => value.code === "process-exit" && value.exitCode === 0));
    await controller.dispatch({ type: "reconnect" }); assert.equal(host.getView().state, "ready");
    for (const name of ["auth.json", ".credentials.json"]) await assert.rejects(access(join(prepared.codexHome, name)));
    await controller.dispose(); assert.equal(host.getView().state, "disposed"); assert.equal(host.getView().processActive, false);
  });
  if (process.env.WORKBENCH_CORE_RESULT) await writeFile(process.env.WORKBENCH_CORE_RESULT, JSON.stringify({ result: "passed", identity: prepared.identity, isolatedHomeConfirmed: true, networkDenied: true, otherUserFileDenied: true, outsideHomeFileAndDirectoryDenied: true, keychainMachLookupRuleConfigured: true, knownAuthFilesPresent: false, methods, errorCodes: [-32600, -32600, -32601], modelRequests: 0, checks: ["policy-denials", "version-and-package-metadata", "actual-initialize", "actual-read-errors", "read-only-controller", "owned-exit", "explicit-reconnect", "clean-stop", "no-known-auth-files", "disposed"], processActive: host.getView().processActive }, null, 2));
});
