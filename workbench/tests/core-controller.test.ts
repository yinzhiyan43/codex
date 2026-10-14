import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CoreController } from "../desktop-host/core-controller.ts";
import { StdioWorkbenchHost } from "../desktop-host/stdio-host.ts";
test("read-only core controller never maps demo commands to real requests", async t => {
  const fixture = fileURLToPath(new URL("../desktop/fixture-peer.mjs", import.meta.url));
  const host = new StdioWorkbenchHost(() => spawn(process.execPath, [fixture], { env: {}, stdio: ["pipe", "pipe", "pipe"] }));
  const controller = new CoreController(host.client()); t.after(() => controller.dispose());
  await controller.dispatch({ type: "connect" });
  assert.equal(controller.snapshot().mode, "official-isolated"); assert.deepEqual(controller.snapshot().messages, []);
  for (const value of [{ type: "submit" }, { type: "confirm" }, { type: "approval", key: "approval-" + "a".repeat(24), decision: "accept" }, { type: "history", threadId: "thread-welcome" }]) await assert.rejects(controller.dispatch(value), /isolated-core-read-only/);
  await controller.dispatch({ type: "disconnect" }); assert.equal(controller.snapshot().coreStatus!.handshake, false);
  await controller.dispatch({ type: "reconnect" }); assert.equal(controller.snapshot().coreStatus!.handshake, true); assert.deepEqual(controller.snapshot().messages, []);
});
test("core spawn failures are rendered as a recoverable connection error", async t => {
  const host = new StdioWorkbenchHost(() => { throw new Error("unavailable"); });
  const controller = new CoreController(host.client()); t.after(() => controller.dispose());
  await controller.dispatch({ type: "connect" }); assert.equal(controller.snapshot().connection, "failed"); assert.match(controller.snapshot().error!, /spawn-failed/);
  await controller.dispatch({ type: "reconnect" }); assert.equal(controller.snapshot().connection, "failed"); assert.equal(controller.snapshot().coreStatus!.handshake, false);
});

for (const next of ["disconnect", "reconnect"] as const) test(`superseded connect cannot overwrite ${next} with its late failure`, async t => {
  const fixture = fileURLToPath(new URL("../desktop/fixture-peer.mjs", import.meta.url));
  const host = new StdioWorkbenchHost(() => spawn(process.execPath, [fixture], { env: {}, stdio: ["pipe", "pipe", "pipe"] }));
  const controller = new CoreController(host.client()); t.after(() => controller.dispose());
  const old = controller.dispatch({ type: "connect" }); const latest = controller.dispatch({ type: next });
  await Promise.all([old, latest]); assert.equal(controller.snapshot().error, null);
  assert.equal(controller.snapshot().connection, next === "disconnect" ? "stopped" : "ready");
});
test("preflight failures retain a specific sanitized error code", async t => {
  const { HostOperationError } = await import("../desktop-host/client.ts");
  const host = new StdioWorkbenchHost(() => { throw new HostOperationError("core-version-mismatch"); });
  const controller = new CoreController(host.client()); t.after(() => controller.dispose());
  await controller.dispatch({ type: "connect" }); assert.match(controller.snapshot().error!, /core-version-mismatch/);
});

test("account mode drops email and stale account results after disconnect", async t => {
  const fixture = fileURLToPath(new URL("../desktop/fixture-peer.mjs", import.meta.url));
  const host = new StdioWorkbenchHost(() => spawn(process.execPath, [fixture], { env: {}, stdio: ["pipe", "pipe", "pipe"] }));
  let finish!: (value: import("../protocol-adapter/contracts.ts").GetAccountResponse) => void;
  const account = new Promise<import("../protocol-adapter/contracts.ts").GetAccountResponse>(resolve => { finish = resolve; });
  const client = { ...host.client(), checkOfficialRoute: async () => {}, getAccount: () => account, listModels: async () => ({ data: [], nextCursor: null }) };
  const controller = new CoreController(client, true); t.after(() => controller.dispose());
  const loading = controller.dispatch({ type: "connect" });
  for (let i=0; i<100 && host.getView().state!=="ready"; i++) await new Promise(resolve=>setTimeout(resolve,5));
  await controller.dispatch({ type: "disconnect" }); finish({ account: { type: "chatgpt", email: "private@example.invalid", planType: "pro" }, requiresOpenaiAuth: true }); await loading;
  assert.equal(controller.snapshot().coreStatus!.authentication, null); assert.equal(controller.snapshot().loading, false);
  await controller.dispatch({ type: "reconnect" }); assert.equal(controller.snapshot().coreStatus!.authentication!.type, "chatgpt");
  assert.equal(JSON.stringify(controller.snapshot()).includes("private@example.invalid"), false);
});

test("account read process exit clears busy and previously confirmed account state", async t => {
  const fixture = fileURLToPath(new URL("../desktop/fixture-peer.mjs", import.meta.url));
  let child!: import("node:child_process").ChildProcessWithoutNullStreams;
  const host = new StdioWorkbenchHost(() => { child = spawn(process.execPath, [fixture], { env: {}, stdio: ["pipe", "pipe", "pipe"] }); return child; });
  let reject!: (error: Error) => void; let reading = false;
  const response = new Promise<import("../protocol-adapter/contracts.ts").GetAccountResponse>((_, fail) => { reject = fail; });
  const controller = new CoreController({ ...host.client(), checkOfficialRoute: async () => {}, getAccount: () => { reading = true; return response; } }, true); t.after(() => controller.dispose());
  const pending = controller.dispatch({ type: "connect" });
  for(let i=0;i<100&&!reading;i++) await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(controller.snapshot().loading, true); child.kill("SIGTERM");
  for(let i=0;i<100&&host.getView().processActive;i++) await new Promise(resolve=>setTimeout(resolve,5));
  reject(new Error("process-exited")); await pending;
  assert.equal(controller.snapshot().loading, false); assert.equal(controller.snapshot().coreStatus!.checking, false); assert.equal(controller.snapshot().coreStatus!.authentication, null);
});

test("account route rejection prevents account and catalog reads", async t => {
  const fixture = fileURLToPath(new URL("../desktop/fixture-peer.mjs", import.meta.url));
  const host = new StdioWorkbenchHost(() => spawn(process.execPath, [fixture], { env: {}, stdio: ["pipe", "pipe", "pipe"] }));
  const { HostOperationError } = await import("../desktop-host/client.ts");
  let reads = 0;
  const controller = new CoreController({ ...host.client(),
    checkOfficialRoute: async () => { throw new HostOperationError("official-endpoint-not-confirmed"); },
    getAccount: async () => { reads++; throw new Error("unexpected-account-read"); },
    listModels: async () => { reads++; throw new Error("unexpected-model-read"); }
  }, true); t.after(() => controller.dispose());
  await controller.dispatch({ type: "connect" });
  assert.equal(reads, 0); assert.match(controller.snapshot().error!, /official-endpoint-not-confirmed/);
  assert.equal(controller.snapshot().coreStatus!.authentication, null); assert.equal(controller.snapshot().loading, false);
});

test("official diagnostics never retries known unsupported items pagination",async t=>{
 const fixture=fileURLToPath(new URL("../desktop/fixture-peer.mjs",import.meta.url));
 const host=new StdioWorkbenchHost(()=>spawn(process.execPath,[fixture],{env:{},stdio:["pipe","pipe","pipe"]}));let items=0;
 const controller=new CoreController({...host.client(),listItems:async()=>{items++;throw new Error("must-not-request");}});t.after(()=>controller.dispose());
 await controller.dispatch({type:"connect"});await controller.dispatch({type:"probeCore"});assert.equal(items,0);assert.equal(controller.snapshot().coreStatus!.probes.at(-1)!.code,"known-unsupported:not-requested");
});
