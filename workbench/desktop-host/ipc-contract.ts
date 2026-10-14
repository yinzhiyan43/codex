export type DesktopCommand =
  | { type: "connect" | "reconnect" | "disconnect" | "new" | "back" | "submit" | "confirm" | "cancel" | "clearError" }
  | { type: "project" | "thread"; id: string }
  | { type: "draft"; routeId: string; text: string }
  | { type: "search"; text: string };
const simple = new Set(["connect", "reconnect", "disconnect", "new", "back", "submit", "confirm", "cancel", "clearError"]);
export function validateDesktopCommand(value: unknown): DesktopCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-command");
  const v = value as Record<string, unknown>;
  if (typeof v.type !== "string") throw new Error("invalid-command");
  const keys = Object.keys(v).sort().join(",");
  if (simple.has(v.type) && keys === "type") return v as DesktopCommand;
  if ((v.type === "project" || v.type === "thread") && keys === "id,type" && typeof v.id === "string" && /^[a-z0-9-]{1,64}$/.test(v.id)) return v as DesktopCommand;
  if (v.type === "draft" && keys === "routeId,text,type" && typeof v.routeId === "string" && /^[a-z0-9-]{1,64}$/.test(v.routeId) && typeof v.text === "string" && v.text.length <= 4000 && !v.text.includes("\0")) return v as DesktopCommand;
  if (v.type === "search" && keys === "text,type" && typeof v.text === "string" && v.text.length <= 128 && !v.text.includes("\0")) return v as DesktopCommand;
  throw new Error("invalid-command");
}
export type SenderIdentity = { owner: boolean; mainFrame: boolean; url: string };
export function validateDesktopSender(sender: SenderIdentity): void {
  if (!sender.owner || !sender.mainFrame || sender.url !== "workbench://app/index.html") throw new Error("untrusted-sender");
}
/** Per-window bounded IPC load, with no per-request token retention. */
export class IpcBudget {
  #active = 0; #count = 0; #since = 0;
  acquire(now = Date.now()): () => void {
    if (now - this.#since >= 1000) { this.#since = now; this.#count = 0; }
    if (this.#active >= 8 || ++this.#count > 80) throw new Error("ipc-busy");
    this.#active++;
    let released = false;
    return () => { if (!released) { released = true; this.#active--; } };
  }
}
