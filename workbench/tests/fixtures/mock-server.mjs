// Offline peer: only memory, its stdin/stdout and synthetic JSON. No model/files/network.
import { StringDecoder } from "node:string_decoder";
import { spawn } from "node:child_process";
const modes = new Set(["normal", "fragmented", "stderr", "malformed", "truncated", "crash-init", "crash-read", "hang-init", "approval", "close-stdout", "ignore-stop", "no-read", "delayed-read", "close-stdin", "final-exit", "reject-init", "inherited-stdout", "inherited-stderr"]);
const mode = process.argv[2] ?? "normal";
if (!modes.has(mode)) process.exit(2);
const decoder = new StringDecoder("utf8");
let buffer = "", reads = 0;
const heartbeat = setInterval(() => {}, 1000);
// Failsafe for test harness failure; never leave this owned peer running indefinitely.
setTimeout(() => process.exit(99), 20000).unref();
if (mode === "ignore-stop") process.on("SIGTERM", () => {});
const thread = (id = "thread-demo", preview = "synthetic") => ({ id, sessionId: "session-demo", projectId: null,
  preview, ephemeral: false, modelProvider: "synthetic", createdAt: 1, updatedAt: 1, status: { type: "idle" },
  cwd: "/synthetic/project", cliVersion: "0.162.1", source: "cli", turns: [] });
function send(message) {
  const bytes = Buffer.from(JSON.stringify(message) + "\n");
  if (mode === "fragmented") {
    // Preserve order through one writer while deliberately splitting Chinese UTF-8.
    for (let i = 0; i < bytes.length; i += 3) process.stdout.write(bytes.subarray(i, i + 3));
  } else process.stdout.write(bytes);
}
function metrics() { send({ method: "thread/started", params: { thread: thread("fixture-metrics", `reads:${reads}`) } }); }
function handle(message) {
  if (message.method === "initialize") {
    if (mode === "hang-init") return;
    if (mode === "crash-init") process.exit(7);
    if (mode === "reject-init") { send({ id: message.id, error: { code: -32600, message: "synthetic-private-error" } }); return; }
    send({ id: message.id, result: { userAgent: "synthetic", codexHome: "/synthetic/home", platformFamily: "unix", platformOs: "macos" } });
  } else if (message.method === "initialized") {
    metrics();
    if (mode === "stderr") process.stderr.write("synthetic-secret-TOKEN /private/synthetic-only\n".repeat(200));
    if (mode === "malformed") process.stdout.write("synthetic-private-malformed\n");
    if (mode === "truncated") { process.stdout.write('{"syntheticPrivate":'); process.stdout.end(); }
    if (mode === "close-stdout") process.stdout.end();
    if (mode === "close-stdin") process.stdin.destroy();
    if (mode === "inherited-stdout" || mode === "inherited-stderr") {
      spawn(process.execPath, ["-e", "setTimeout(() => {}, 500)"], { env: {}, stdio: ["ignore", mode === "inherited-stdout" ? process.stdout : "ignore", process.stderr] });
      process.exit(0);
    }
    if (mode === "no-read") { process.stdin.pause(); send({ method: "thread/started", params: { thread: thread("peer-paused") } }); }
    if (mode === "approval") send({ id: "approval-demo", method: "item/commandExecution/requestApproval", params: {
      threadId: "thread-demo", turnId: "turn-demo", itemId: "command-demo", startedAtMs: 1000, command: "synthetic-never-run" } });
  } else if (message.method === "thread/read") {
    reads++;
    if (mode === "crash-read") process.exit(9);
    const result = { id: message.id, result: { thread: thread(message.params.threadId, `合成:${reads}`) } };
    if (mode === "delayed-read") { setTimeout(() => send(result), 200); return; }
    if (mode === "final-exit") { process.stdout.write(JSON.stringify(result) + "\n", () => process.exit(0)); return; }
    send(result); metrics();
  } else if (Object.hasOwn(message, "result") && message.id === "approval-demo") {
    send({ method: "serverRequest/resolved", params: { threadId: "thread-demo", requestId: message.id } });
  }
}
process.stdin.on("data", bytes => {
  buffer += decoder.write(bytes);
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    try { handle(JSON.parse(line)); } catch { process.exit(3); }
  }
});
process.stdin.on("end", () => { if (mode !== "ignore-stop" && mode !== "no-read") { clearInterval(heartbeat); process.exit(0); } });
