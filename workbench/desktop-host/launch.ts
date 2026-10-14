import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";

/** Main-process dependency. Never accept a launcher or configuration from renderer IPC. */
export type ProcessLauncher = () => ChildProcessWithoutNullStreams;
export type CodexLaunchConfiguration = { executable: string; cwd: string; environment?: Readonly<Record<string, string>> };
const environmentKeys = new Set(["HOME", "CODEX_HOME", "PATH", "TMPDIR", "LANG", "LC_ALL"]);
export function createCodexLauncher(configuration: CodexLaunchConfiguration): ProcessLauncher {
  for (const path of [configuration.executable, configuration.cwd]) {
    if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0") || path.length > 4096) throw new Error("Invalid launch path");
  }
  const environment: Record<string, string> = {};
  const supplied = configuration.environment ?? {};
  if (Object.keys(supplied).length > environmentKeys.size) throw new Error("Invalid launch environment");
  for (const [key, value] of Object.entries(supplied)) {
    if (!environmentKeys.has(key) || typeof value !== "string" || value.includes("\0") || value.length > 8192) throw new Error("Invalid launch environment");
    environment[key] = value;
  }
  const executable = configuration.executable, cwd = configuration.cwd;
  return () => spawn(executable, ["app-server", "--listen", "stdio://"], {
    cwd, env: { ...environment }, shell: false, stdio: ["pipe", "pipe", "pipe"],
  });
}
