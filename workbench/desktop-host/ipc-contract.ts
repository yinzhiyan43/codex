export type DesktopCommand =
  | {type:"claimEditor"|"releaseEditor"|"retryPersistence"|"reconcileDelivery"}
  | {type:"editDraft";routeId:string;text:string;revision:number;lease:string}
  | { type: "connect" | "reconnect" | "disconnect" | "new" | "back" | "submit" | "confirm" | "cancel" | "clearError" | "cancelHistory" | "probeCore" | "browseHistory" | "returnToChat" | "refreshThreads" | "moreThreads" | "refreshHistory" | "toggleArchived" }
  | { type: "selectModel"; model: string }
  | { type: "project" | "thread"; id: string }
  | { type: "draft"; routeId: string; text: string }
  | { type: "search"; text: string }
  | {type:"searchSessions";text:string;archived:boolean;kind:"content"|"title"}
  | {type:"moreSessionSearch"|"cancelSessionSearch"}
  | {type:"openSearchResult";id:string}
  | { type: "history"; threadId: string }
  | { type: "openSessionWindow" | "copySession" | "continueSession" | "archiveSession" | "unarchiveSession" | "pinSession" | "unreadSession"; id: string }
  | { type:"forkSession"; id:string; lastTurnId?:string }
  | {type:"loadSections";id?:string}
  | { type:"loadSectionOrder"; sectionId:string }
  | { type:"renameSection"; sectionId:string; name:string }
  | { type:"renameProject"; id:string; name:string }
  | { type: "renameSession"; id: string; name: string }
  | { type: "assignProject"; id: string; name: string }
  | { type: "createSection"; name: string }
  | { type: "assignSection"; id: string; sectionId: string | null; beforeThreadId?:string }
  | { type: "approval"; key: string; decision: "accept" | "decline" | "cancel" };
const simple = new Set(["connect", "reconnect", "disconnect", "new", "back", "submit", "confirm", "cancel", "clearError", "cancelHistory", "probeCore", "browseHistory", "returnToChat", "refreshThreads", "moreThreads", "refreshHistory", "toggleArchived", "loadSections", "moreSessionSearch", "cancelSessionSearch", "claimEditor", "releaseEditor", "retryPersistence", "reconcileDelivery"]);
export function validateDesktopCommand(value: unknown): DesktopCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-command");
  const v = value as Record<string, unknown>;
  if (typeof v.type !== "string") throw new Error("invalid-command");
  const keys = Object.keys(v).sort().join(",");
  if (simple.has(v.type) && keys === "type") return v as DesktopCommand;
  if(v.type==="searchSessions"&&keys==="archived,kind,text,type"&&typeof v.text==="string"&&v.text.trim().length>0&&v.text.length<=128&&!/[\x00-\x1f]/.test(v.text)&&typeof v.archived==="boolean"&&["content","title"].includes(v.kind as string))return v as DesktopCommand;
  if (v.type === "selectModel" && keys === "model,type" && typeof v.model === "string" && /^gpt-[a-z0-9.-]{1,100}$/.test(v.model)) return v as DesktopCommand;
  const validId=(x:unknown)=>typeof x==="string"&&/^[a-z0-9-]{1,64}$/.test(x);
  const validName=(x:unknown)=>typeof x==="string"&&!!x.trim()&&x.length<=80&&!/[\x00-\x1f]/.test(x);
  if(v.type==="forkSession"&&["id,type","id,lastTurnId,type"].includes(keys)&&validId(v.id)&&(v.lastTurnId===undefined||validId(v.lastTurnId)))return v as DesktopCommand;
  if(v.type==="loadSections"&&keys==="id,type"&&validId(v.id))return v as DesktopCommand;
  if(v.type==="loadSectionOrder"&&keys==="sectionId,type"&&validId(v.sectionId))return v as DesktopCommand;
  if(v.type==="renameSection"&&keys==="name,sectionId,type"&&validId(v.sectionId)&&validName(v.name))return v as DesktopCommand;
  if(v.type==="renameProject"&&keys==="id,name,type"&&validId(v.id)&&validName(v.name))return v as DesktopCommand;
  if(v.type==="assignProject"&&keys==="id,name,type"&&typeof v.id==="string"&&/^[a-z0-9-]{1,64}$/.test(v.id)&&typeof v.name==="string"&&v.name.length<=80&&!/[\x00-\x1f]/.test(v.name))return v as DesktopCommand;
  if(v.type==="createSection"&&keys==="name,type"&&typeof v.name==="string"&&v.name.trim().length>0&&v.name.length<=80&&!/[\x00-\x1f]/.test(v.name))return v as DesktopCommand;
  if(v.type==="assignSection"&&["id,sectionId,type","beforeThreadId,id,sectionId,type"].includes(keys)&&(v.beforeThreadId===undefined||validId(v.beforeThreadId)&&v.beforeThreadId!==v.id&&v.sectionId!==null)&&typeof v.id==="string"&&/^[a-z0-9-]{1,64}$/.test(v.id)&&(v.sectionId===null||typeof v.sectionId==="string"&&/^[a-z0-9-]{1,64}$/.test(v.sectionId)))return v as DesktopCommand;
  if (v.type === "renameSession" && keys === "id,name,type" && typeof v.id === "string" && /^[a-z0-9-]{1,64}$/.test(v.id) && typeof v.name === "string" && v.name.trim().length > 0 && v.name.length <= 100 && !/[\x00-\x1f]/.test(v.name)) return v as DesktopCommand;
  if (["openSearchResult","openSessionWindow","copySession","continueSession","forkSession","archiveSession","unarchiveSession","pinSession","unreadSession"].includes(v.type) && keys === "id,type" && typeof v.id === "string" && /^[a-z0-9-]{1,64}$/.test(v.id)) return v as DesktopCommand;
  if ((v.type === "project" || v.type === "thread") && keys === "id,type" && typeof v.id === "string" && /^[a-z0-9-]{1,64}$/.test(v.id)) return v as DesktopCommand;
  if(v.type==="editDraft"&&keys==="lease,revision,routeId,text,type"&&validId(v.routeId)&&typeof v.text==="string"&&v.text.length<=4000&&!v.text.includes("\0")&&Number.isSafeInteger(v.revision)&&(v.revision as number)>=0&&typeof v.lease==="string"&&/^edit-[a-f0-9]{32}$/.test(v.lease))return v as DesktopCommand;
  if (v.type === "draft" && keys === "routeId,text,type" && typeof v.routeId === "string" && /^[a-z0-9-]{1,64}$/.test(v.routeId) && typeof v.text === "string" && v.text.length <= 4000 && !v.text.includes("\0")) return v as DesktopCommand;
  if (v.type === "search" && keys === "text,type" && typeof v.text === "string" && v.text.length <= 128 && !v.text.includes("\0")) return v as DesktopCommand;
  if (v.type === "history" && keys === "threadId,type" && typeof v.threadId === "string" && /^[a-z0-9-]{1,64}$/.test(v.threadId)) return v as DesktopCommand;
  if (v.type === "approval" && keys === "decision,key,type" && typeof v.key === "string" && /^approval-[a-f0-9]{24}$/.test(v.key) && ["accept", "decline", "cancel"].includes(v.decision as string)) return v as DesktopCommand;
  throw new Error("invalid-command");
}
export type SenderIdentity = { owner: boolean; mainFrame: boolean; url: string; surface?:"main"|"preview" };
export function validateDesktopSender(sender: SenderIdentity): void {
  if (!sender.owner || !sender.mainFrame || sender.url !== (sender.surface==="preview"?"workbench://app/preview.html":"workbench://app/index.html")) throw new Error("untrusted-sender");
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
