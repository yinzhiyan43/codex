import { officialRouteOverrides, disableConfiguredMcp, assertOfficialRouteConfiguration, assertOfficialModelConfiguration } from "../desktop-host/official-config.ts";
import { promisify } from "node:util";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import Ajv from "ajv";
import { JsonlDecoder } from "../protocol-adapter/jsonl.ts";
import { DEFAULT_CORE_BINARY } from "../desktop-host/isolated-core.ts";
const executeModel = process.argv.includes("--run-model-smoke");
const outputIndex = process.argv.indexOf("--result");
const output = outputIndex < 0 ? null : process.argv[outputIndex + 1];
if (output && (!isAbsolute(output) || output.includes("\0"))) throw new Error("invalid-result-path");
const run = await mkdtemp(join(tmpdir(), "workbench-official-model-"));
await mkdir(join(run, "state")); await mkdir(join(run, "log"));
const environment = {};
for (const name of ["HOME", "CODEX_HOME", "PATH", "TMPDIR", "LANG", "LC_ALL"]) if (typeof process.env[name] === "string") environment[name] = process.env[name];
const overrides = { model_provider: "openai", forced_login_method: "chatgpt", chatgpt_base_url: "https://chatgpt.com/backend-api/", "analytics.enabled": false, "otel.exporter": "none", "otel.trace_exporter": "none", check_for_update_on_startup: false, sqlite_home: join(run, "state"), log_dir: join(run, "log"), project_doc_max_bytes: 0, "skills.include_instructions": false, "skills.bundled.enabled": false, "features.shell_tool": false, "features.unified_exec": false, "features.view_image": false, "features.memories": false, "memories.generate_memories": false, "memories.use_memories": false, "features.apps": false, "features.plugins": false, "features.multi_agent": false, "features.code_mode": false, web_search: "disabled" };
Object.assign(overrides, officialRouteOverrides());
const verifyConfiguration = executeModel || process.argv.includes("--verify-model-configuration");
const args = ["app-server", "--listen", "stdio://"];
for (const [key, value] of Object.entries(overrides)) args.push("-c", key + "=" + JSON.stringify(value));
const ajv = new Ajv({ strict: false, validateFormats: false });
const schemaFiles = { "config/read": ["ConfigReadParams", "ConfigReadResponse"], "account/read": ["GetAccountParams", "GetAccountResponse"], "model/list": ["ModelListParams", "ModelListResponse"], "thread/start": ["ThreadStartParams", "ThreadStartResponse"], "turn/start": ["TurnStartParams", "TurnStartResponse"], "turn/interrupt": ["TurnInterruptParams", "TurnInterruptResponse"] };
const validators = {};
for (const [method, files] of Object.entries(schemaFiles)) validators[method] = await Promise.all(files.map(async file => ajv.compile(JSON.parse(await readFile(new URL("../../codex-rs/app-server-protocol/schema/json/v2/" + file + ".json", import.meta.url), "utf8")))));
validators.initialize = await Promise.all(["InitializeParams", "InitializeResponse"].map(async file => ajv.compile(JSON.parse(await readFile(new URL("../../codex-rs/app-server-protocol/schema/json/v1/" + file + ".json", import.meta.url), "utf8")))));
const methods = [], pending = new Map(), turns = new Map();
let sequence = 0, child, runtimeTimer, threadId = null, cancelTurn = null, interrupt = null, toolCount = 0, stderrBytes = 0, failure = null;
const result = { result: "failed", authenticationType: null, planType: null, provider: "openai", configuredEndpoint: overrides.openai_base_url, configurationGuardConfirmed: false, model: null, modelRequests: 0, toolItems: 0, methods, normal: null, cancellation: null };
function rpc(method, params) {
  if (!validators[method]?.[0](params)) throw new Error("invalid-fixed-request:" + method);
  methods.push(method); const id = "smoke-" + ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("rpc-timeout:" + method)); }, 30000);
    pending.set(id, { method, timer, resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
function handle(frame) {
  if (frame.id !== undefined && !frame.method) {
    const request = pending.get(frame.id); if (!request) return;
    pending.delete(frame.id); clearTimeout(request.timer);
    if (frame.error) request.reject(new Error("rpc-error:" + frame.error.code));
    else if (!validators[request.method][1](frame.result)) request.reject(new Error("invalid-fixed-response:" + request.method));
    else request.resolve(frame.result);
    return;
  }
  if (frame.id !== undefined && frame.method) {
    child.stdin.write(JSON.stringify({ id: frame.id, error: { code: -32601, message: "Smoke test does not provide tool or auth callbacks" } }) + "\n");
    failure = "unexpected-server-request"; return;
  }
  const params = frame.params;
  if (!params || params.threadId !== threadId) return;
  const id = params.turnId ?? params.turn?.id; if (!id) return;
  if (!turns.has(id)) turns.set(id, { deltas: 0, text: "", status: null, error: null });
  const turn = turns.get(id);
  if (frame.method === "item/started" && !["userMessage", "agentMessage", "reasoning"].includes(params.item?.type)) { toolCount++; failure = "unexpected-tool-item"; }
  if (frame.method === "item/agentMessage/delta") {
    turn.deltas++; turn.text += params.delta ?? "";
    if (turn.text.length > 20000) failure = "output-budget-exceeded";
    if (id === cancelTurn && !interrupt) interrupt = rpc("turn/interrupt", { threadId, turnId: id }).then(() => true, () => false);
  }
  if (frame.method === "turn/completed") { turn.status = params.turn.status; turn.error = params.turn.error ? "server-turn-error" : null; }
}
async function until(predicate, label, milliseconds = 45000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { if (failure) throw new Error(failure); if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error("smoke-timeout:" + label);
}
function launchCore(launchArgs = args) {
  const owned = spawn(DEFAULT_CORE_BINARY, launchArgs, { cwd: run, env: environment, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  child = owned;
  const decoder = new JsonlDecoder(1024 * 1024);
  owned.stdout.on("data", bytes => { if (child !== owned) return; try { for (const value of decoder.push(bytes)) handle(value); } catch { failure = "invalid-protocol-output"; } });
  owned.stderr.on("data", bytes => { stderrBytes += bytes.length; });
  owned.stdin.on("error", () => { if (child !== owned) return; failure = "native-stdin-closed"; });
  owned.stdout.on("error", () => { if (child !== owned) return; failure = "native-stdout-failed"; });
  owned.on("error", () => { if (child !== owned) return; failure = "native-spawn-failed"; });
}
async function initializeCore() {
  await rpc("initialize", { clientInfo: { name: "yinzhiyan43_official_smoke", version: "0.1.0" }, capabilities: { experimentalApi: false, requestAttestation: false } });
  methods.push("initialized"); child.stdin.write('{"method":"initialized"}\n');
}
async function closeOwned(owned) {
  owned.stdin.end();
  return await new Promise(resolve => {
    if (owned.exitCode !== null || owned.signalCode !== null) return resolve(true);
    const timers = [setTimeout(() => { if (owned.exitCode === null && owned.signalCode === null) owned.kill("SIGTERM"); }, 2000), setTimeout(() => { if (owned.exitCode === null && owned.signalCode === null) owned.kill("SIGKILL"); }, 4000), setTimeout(() => { owned.stdin.destroy(); owned.stdout.destroy(); owned.stderr.destroy(); resolve(false); }, 6000)];
    owned.once("close", () => { timers.forEach(clearTimeout); resolve(true); });
  });
}
try {
  const version = await promisify(execFile)(DEFAULT_CORE_BINARY, ["--version"], { cwd: run, env: environment, timeout: 10000, maxBuffer: 4096 });
  if (version.stdout.trim() !== "codex-cli 0.162.1") throw new Error("core-version-mismatch");
  runtimeTimer = setTimeout(() => { failure = "overall-smoke-deadline"; for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(failure)); } pending.clear(); child?.stdin.end(); }, 120000);
  launchCore(); await initializeCore();
  const initial = (await rpc("config/read", { includeLayers: false })).config;
  assertOfficialRouteConfiguration(initial); result.routeGuardConfirmed = true;
  if (verifyConfiguration) {
    const disabled = disableConfiguredMcp(initial);
    if (disabled.length) {
      const bootstrap = child;
      if (!(await closeOwned(bootstrap)) || bootstrap.exitCode !== 0) throw new Error("configuration-bootstrap-close-failed");
      launchCore([...args, ...disabled.flatMap(value => ["-c", value])]); await initializeCore();
    }
    const effective = (await rpc("config/read", { includeLayers: false })).config;
    assertOfficialModelConfiguration(effective); result.configurationGuardConfirmed = true;
  }
  const account = (await rpc("account/read", { refreshToken: false })).account;
  result.authenticationType = account?.type ?? null; result.planType = account?.type === "chatgpt" ? account.planType : null;
  if (account?.type !== "chatgpt") throw new Error("chatgpt-login-required-no-api-fallback");
  const catalog = await rpc("model/list", { limit: 100, includeHidden: false });
  const visible = catalog.data.filter(model => !model.hidden && model.model.startsWith("gpt-") && model.inputModalities.includes("text"));
  const selected = visible.find(model => model.isDefault) ?? visible[0];
  if (!selected) throw new Error("no-official-gpt-model-available"); result.model = selected.model;
  console.log(JSON.stringify({ authenticationType: result.authenticationType, planType: result.planType, model: result.model, modelRequestsEnabled: executeModel }));
  if (executeModel) {
    const started = await rpc("thread/start", { model: selected.model, modelProvider: "openai", cwd: run, approvalPolicy: "never", sandbox: "read-only", ephemeral: true, baseInstructions: "You are a text-only smoke test. Follow the exact user text request. Never call tools, inspect files, or access any project.", developerInstructions: "Do not call any tool or read any file. Only return plain text for the smoke test." });
    if (started.modelProvider !== "openai" || started.model !== selected.model || started.cwd !== run || started.sandbox.type !== "readOnly" || started.thread.ephemeral !== true) throw new Error("official-thread-configuration-mismatch");
    result.ephemeralConfirmed = started.thread.ephemeral; threadId = started.thread.id;
    const effort = selected.supportedReasoningEfforts.some(option => option.reasoningEffort === "low") ? "low" : selected.defaultReasoningEffort;
    const request = text => ({ threadId, model: selected.model, effort, input: [{ type: "text", text, text_elements: [] }], approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false } });
    result.modelRequests++; const normal = await rpc("turn/start", request("Reply exactly WORKBENCH_OK as plain text. Do not use tools."));
    await until(() => turns.get(normal.turn.id)?.status !== null && turns.get(normal.turn.id)?.status !== undefined, "normal-complete");
    const observed = turns.get(normal.turn.id);
    result.normal = { status: observed.status, deltas: observed.deltas, expectedText: observed.text.trim() === "WORKBENCH_OK", outputChars: observed.text.length };
    if (observed.status !== "completed" || observed.deltas < 1 || !result.normal.expectedText) throw new Error("normal-response-not-confirmed");
    result.modelRequests++; const cancelled = await rpc("turn/start", request("Write integers from 1 through 1000, one per line, as plain text. Do not use tools."));
    cancelTurn = cancelled.turn.id;
    if ((turns.get(cancelTurn)?.deltas ?? 0) > 0 && !interrupt) interrupt = rpc("turn/interrupt", { threadId, turnId: cancelTurn }).then(() => true, () => false);
    await until(() => turns.get(cancelTurn)?.status !== null && turns.get(cancelTurn)?.status !== undefined, "cancel-terminal");
    const stopped = turns.get(cancelTurn);
    result.cancellation = { status: stopped.status, deltas: stopped.deltas, outputChars: stopped.text.length, interruptAcknowledged: interrupt ? await interrupt : false };
    if (stopped.status !== "interrupted" || stopped.deltas < 1 || !result.cancellation.interruptAcknowledged) throw new Error("cancellation-not-confirmed");
  }
  result.toolItems = toolCount; if (toolCount) throw new Error("tool-call-observed"); result.result = "passed";
} catch (error) { result.error = error instanceof Error ? error.message : "official-smoke-failed"; }
finally {
  clearTimeout(runtimeTimer);
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("smoke-closed")); } pending.clear();
  if (child) {
    const closed = await closeOwned(child);
    result.processExitCode = child.exitCode; result.processSignal = child.signalCode; result.cleanupConfirmed = closed;
    if (!closed || child.exitCode !== 0 || child.signalCode !== null) { result.result = "failed"; result.error ??= "native-cleanup-not-clean"; }
  }
  await rm(run, { recursive: true, force: true });
  if (output) await writeFile(output, JSON.stringify(result, null, 2) + "\n"); console.log(JSON.stringify(result));
  process.exitCode = result.result === "passed" ? 0 : 1;
}
