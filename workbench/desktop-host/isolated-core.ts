import { officialRouteOverrides } from "./official-config.ts";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname, isAbsolute, relative } from "node:path";
import { homedir } from "node:os";
import type { ProcessLauncher } from "./launch.ts";
const exec = promisify(execFile);
export const OFFICIAL_VERSION = "0.162.1";
export const DEFAULT_CORE_BINARY = "/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex";
export const PROBE_THREAD_ID = "00000000-0000-4000-8000-000000000000";
const config = `cli_auth_credentials_store = "file"
mcp_oauth_credentials_store = "file"
check_for_update_on_startup = false
[analytics]
enabled = false
[otel]
exporter = "none"
trace_exporter = "none"
[features]
secret_auth_storage = false
`;
/** Test-only, no-login native connection. Never accept these options through renderer IPC. */
export async function prepareIsolatedCore(runsDirectory: string, executable = DEFAULT_CORE_BINARY) {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("isolated-core-requires-darwin-arm64");
  if (![runsDirectory, executable].every(path => isAbsolute(path) && !path.includes("\0") && path.length <= 4096)) throw new Error("invalid-isolated-core-path");
  const binary = await realpath(executable);
  if (binary !== executable || !binary.endsWith("/vendor/aarch64-apple-darwin/bin/codex")) throw new Error("unverified-core-layout");
  const vendor = dirname(dirname(binary));
  const metadata = JSON.parse(await readFile(join(vendor, "codex-package.json"), "utf8"));
  const pkg = JSON.parse(await readFile(join(dirname(dirname(vendor)), "package.json"), "utf8"));
  if (metadata.version !== OFFICIAL_VERSION || metadata.target !== "aarch64-apple-darwin" || metadata.entrypoint !== "bin/codex" || pkg.name !== "@openai/codex" || pkg.version !== OFFICIAL_VERSION + "-darwin-arm64" || pkg.repository?.url !== "git+https://github.com/openai/codex.git") throw new Error("core-version-or-provenance-mismatch");
  await mkdir(runsDirectory, { recursive: true, mode: 0o700 });
  const runs = await realpath(runsDirectory);
  const directory = await mkdtemp(join(runs, "isolated-"));
  const userHome = await realpath(homedir());
  if (relative(userHome, directory).startsWith("..")) throw new Error("isolated-core-run-must-be-under-user-home");
  for (const name of ["home", "codex-home", "cwd", "tmp"]) await mkdir(join(directory, name), { mode: 0o700 });
  await writeFile(join(directory, "codex-home", "config.toml"), config, { mode: 0o600 });
  // Child policy adds restrictions; it does not change any system security setting.
  const readRoots = ["/System", "/Library/Apple", "/private/var/db/dyld", "/private/var/db/timezone", "/dev/fd", "/usr", "/bin", "/sbin", "/private/etc", "/etc", "/opt/homebrew/lib/node_modules/@openai/codex", "/opt/homebrew/Cellar", "/opt/homebrew/opt", directory];
  const readable = `(require-any ${readRoots.map(path => `(subpath ${JSON.stringify(path)})`).join(" ")} (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))`;
  const ancestors = new Set<string>(); for (const root of readRoots) for (let path = dirname(root); path !== dirname(path); path = dirname(path)) ancestors.add(path);
  const readableMetadata = `(require-any ${readable} (literal "/") ${[...ancestors].map(path => `(literal ${JSON.stringify(path)})`).join(" ")})`;
  // Protect user storage roots; this test policy is not a complete filesystem allowlist.
  // macOS loader reads outside the runtime roots before --version. Metadata/xattr
  // remain bounded separately; content reads in the following user roots are denied.
  const userStorage = `(require-any ${[userHome, "/Users", "/Volumes", "/tmp", "/private/tmp", "/private/var/folders"].map(path => `(subpath ${JSON.stringify(path)})`).join(" ")})`;
  const policy = `(version 1) (allow default) (deny network*) (deny file-read-data (require-all ${userStorage} (require-not (subpath ${JSON.stringify(directory)})))) (deny file-read-metadata (require-all (subpath "/") (require-not ${readableMetadata}))) (deny file-read-xattr (require-all (subpath "/") (require-not ${readable}))) (deny file-write* (require-not (subpath ${JSON.stringify(directory)}))) (deny mach-lookup (global-name-regex "^com[.]apple[.](securityd|secd)"))`;
  const policyPath = join(directory, "no-network.sb"); await writeFile(policyPath, policy, { mode: 0o600 });
  const environment = Object.freeze({ HOME: join(directory, "home"), CODEX_HOME: join(directory, "codex-home"), TMPDIR: join(directory, "tmp"), PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" });
  const options = { cwd: join(directory, "cwd"), env: environment, timeout: 10000, maxBuffer: 16384 };
  try {
    const version = await exec("/usr/bin/sandbox-exec", ["-f", policyPath, binary, "--version"], options);
    if (version.stdout.trim() !== "codex-cli " + OFFICIAL_VERSION) throw new Error("core-version-mismatch");
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  const identity = Object.freeze({ version: OFFICIAL_VERSION, target: "aarch64-apple-darwin", sha256: createHash("sha256").update(await readFile(binary)).digest("hex") });
  const launcher: ProcessLauncher = () => spawn("/usr/bin/sandbox-exec", ["-f", policyPath, binary, "app-server", "--listen", "stdio://", "--strict-config"], { cwd: options.cwd, env: { ...environment }, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  return { directory, codexHome: environment.CODEX_HOME, identity, launcher, policyPath, environment, cwd: options.cwd };
}

/** Reuse official CLI's managed login in place. Never copy credentials into the run. */
export async function prepareOfficialAccountCore(runsDirectory: string, executable = DEFAULT_CORE_BINARY) {
  const prepared = await prepareIsolatedCore(runsDirectory, executable);
  const environment: Record<string, string> = {};
  for (const name of ["HOME", "CODEX_HOME", "PATH", "TMPDIR", "LANG", "LC_ALL"]) if (typeof process.env[name] === "string") environment[name] = process.env[name]!;
  try {
    const checked = await exec(executable, ["-c", 'model_provider="openai"', "-c", 'forced_login_method="chatgpt"', "login", "status"], { cwd: prepared.cwd, env: environment, timeout: 15000, maxBuffer: 16384 });
    if (!(checked.stdout + checked.stderr).includes("Logged in using ChatGPT")) throw new Error("core-chatgpt-login-required");
  } catch { await rm(prepared.directory, { recursive: true, force: true }); throw new Error("core-chatgpt-login-required"); }
  await mkdir(join(prepared.directory, "state")); await mkdir(join(prepared.directory, "log"));
  const overrides: Record<string, string | number | boolean | string[]> = { model_provider: "openai", forced_login_method: "chatgpt", chatgpt_base_url: "https://chatgpt.com/backend-api/", "analytics.enabled": false, "otel.exporter": "none", "otel.trace_exporter": "none", check_for_update_on_startup: false, sqlite_home: join(prepared.directory, "state"), log_dir: join(prepared.directory, "log"), project_doc_max_bytes: 0, "skills.include_instructions": false, "skills.bundled.enabled": false, "features.background_paginated_rollout_migration": false, "features.goals": false, "features.daemon_auto_start": false, "features.memories": false, "features.apps": false, "features.plugins": false };
  Object.assign(overrides, officialRouteOverrides());
  const args = ["app-server", "--listen", "stdio://"];
  for (const [key, value] of Object.entries(overrides)) args.push("-c", key + "=" + JSON.stringify(value));
  const launcher: ProcessLauncher = () => spawn(executable, args, { cwd: prepared.cwd, env: { ...environment }, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  return { ...prepared, launcher, launchArgs: args, accountEnvironment: environment };
}

/** Bootstrap config only; disable all configured MCP before any chat thread can start. */
export async function prepareOfficialChatCore(runsDirectory: string, persistentRoot: string) {
  if (!isAbsolute(persistentRoot) || persistentRoot.includes("\0")) throw new Error("invalid-workbench-state-path");
  await mkdir(persistentRoot, {recursive:true,mode:0o700});
  const durable = await realpath(persistentRoot);
  for (const name of ["state","log","chat-cwd"]) await mkdir(join(durable,name),{recursive:true,mode:0o700});
  const prepared = await prepareOfficialAccountCore(runsDirectory);
  const { StdioWorkbenchHost } = await import("./stdio-host.ts");
  const bootstrap = new StdioWorkbenchHost(prepared.launcher, { requestTimeoutMs: 10000, shutdownGraceMs: 1000, closeTimeoutMs: 3000 });
  const { discoverChatMcp } = await import("./chat-bootstrap.ts");
  const disabled = await discoverChatMcp(bootstrap, () => rm(prepared.directory, { recursive: true, force: true }));
  const restrictions = { "features.background_paginated_rollout_migration": false, "features.goals": false, "features.daemon_auto_start": false, "features.shell_tool": false, "features.unified_exec": false, "features.view_image": false, "features.code_mode": false, "features.multi_agent": false, "features.multi_agent_v2": false, "features.image_generation": false, "features.browser_use": false, "features.browser_use_external": false, "features.browser_use_full_cdp_access": false, "features.computer_use": false, "agents.enabled": false, "memories.generate_memories": false, "memories.use_memories": false, web_search: "disabled" };
  const args = [...prepared.launchArgs, "-c", "sqlite_home="+JSON.stringify(join(durable,"state")), "-c", "log_dir="+JSON.stringify(join(durable,"log")), "-c", "cwd="+JSON.stringify(join(durable,"chat-cwd")), ...disabled.flatMap(value => ["-c", value]), ...Object.entries(restrictions).flatMap(([key,value]) => ["-c", key+"="+JSON.stringify(value)])];
  const launcher: ProcessLauncher = () => spawn(DEFAULT_CORE_BINARY, args, { cwd: prepared.cwd, env: { ...prepared.accountEnvironment }, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  return { ...prepared, launcher, cwd:join(durable,"chat-cwd") };
}
