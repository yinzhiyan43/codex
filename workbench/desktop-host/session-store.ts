import {validDirectoryBinding,type DirectoryBinding} from "../domain/repository.ts";
import { mkdir, open, rename, rm, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DemoMessage } from "./demo-controller.ts";
export type ManagedSession = { root?:DirectoryBinding|null;cwd?:string|null; id: string; title: string; draft: string; model: string | null; pinned: boolean; unread: boolean; archived: boolean; archiveUncertain?: boolean; ephemeral: boolean; localProject?: string | null; sectionId?: string | null; sectionName?: string | null; forkedFromId?: string | null; forkUncertain?: boolean; sectionPosition?:number };
export type PendingDelivery = {token:string;key:string;text:string;beforeTurnId:string|null};
type State = { freshRoot:DirectoryBinding|null; delivery:PendingDelivery|null; version: 1; lastId: string | null; freshDraft: string; sessions: ManagedSession[]; temporary: { id: string; messages: DemoMessage[] } | null };
const empty = (): State => ({freshRoot:null,delivery:null,version:1,lastId:null,freshDraft:"",sessions:[],temporary:null});
const validId = (id: unknown): id is string => typeof id === "string" && /^[a-z0-9-]{1,64}$/.test(id);
const validDelivery=(v:unknown):v is PendingDelivery=>!!v&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).sort().join(",")==="beforeTurnId,key,text,token"&&validId((v as PendingDelivery).key)&&/^[a-f0-9]{32}$/.test((v as PendingDelivery).token)&&typeof (v as PendingDelivery).text==="string"&&(v as PendingDelivery).text.length>0&&(v as PendingDelivery).text.length<=4000&&((v as PendingDelivery).beforeTurnId===null||validId((v as PendingDelivery).beforeTurnId));
/** Own metadata only. Official core owns persisted transcript and continuation. */
export class SessionStore {
  #confirmed:State=empty();
  confirmedDraft(key:string):string{return key==="official-chat"?this.#confirmed.freshDraft:this.#confirmed.sessions.find(row=>row.id===key)?.draft??"";}
  #writeFailed=false;
  #listeners=new Set<()=>void>();
  subscribe(listener:()=>void):()=>void { if(this.#listeners.size>=16)throw new Error("store-subscriber-limit");this.#listeners.add(listener);return()=>this.#listeners.delete(listener); }
  #publish():void { for(const listener of this.#listeners)try{listener();}catch{} }
  #path: string | null; #state: State = empty(); #loaded = false; #tail: Promise<void> = Promise.resolve(); #transactions: Promise<void> = Promise.resolve();
  constructor(path: string | null = null) { this.#path = path; }
  async load(): Promise<void> {
    if(this.#loaded)return;
    if(this.#path){try{const info=await lstat(this.#path);if(!info.isFile()||info.size>4*1024*1024)throw new Error("invalid-session-store");const file=await open(this.#path,constants.O_RDONLY|constants.O_NOFOLLOW);let text;try{text=await file.readFile("utf8");}finally{await file.close();}const v=JSON.parse(text);
      if(!(v.freshRoot===undefined||v.freshRoot===null||validDirectoryBinding(v.freshRoot))||!(v.delivery===undefined||v.delivery===null||validDelivery(v.delivery))||v.version!==1||!Array.isArray(v.sessions)||v.sessions.length>512||typeof v.freshDraft!=="string"||v.freshDraft.length>4000||!(v.lastId===null||validId(v.lastId))||!(v.temporary===null||validId(v.temporary?.id)))throw new Error("invalid-session-store");
      const ids=new Set();for(const row of v.sessions){if(!(row.root===undefined||row.root===null||validDirectoryBinding(row.root))||!(row.cwd===undefined||row.cwd===null||typeof row.cwd==="string"&&row.cwd.startsWith("/")&&row.cwd.length<=4096&&!/[\x00-\x1f]/.test(row.cwd))||row.root&&row.cwd!==row.root.path)throw new Error("invalid-session-store");if(!(row.sectionPosition===undefined||Number.isSafeInteger(row.sectionPosition)&&row.sectionPosition>=0&&row.sectionPosition<200)||![row.sectionId,row.forkedFromId].every(x=>x===undefined||x===null||validId(x))||![row.localProject,row.sectionName].every(x=>x===undefined||x===null||typeof x==="string"&&x.length<=200&&!/[\x00-\x1f]/.test(x))||!(row.forkUncertain===undefined||typeof row.forkUncertain==="boolean"))throw new Error("invalid-session-store");if((row.archiveUncertain!==undefined&&typeof row.archiveUncertain!=="boolean")||!validId(row.id)||ids.has(row.id)||typeof row.title!=="string"||row.title.length>100||typeof row.draft!=="string"||row.draft.length>4000||!["pinned","unread","archived","ephemeral"].every(key=>typeof row[key]==="boolean")||!(row.model===null||typeof row.model==="string"&&/^gpt-[a-z0-9.-]{1,100}$/.test(row.model)))throw new Error("invalid-session-store");ids.add(row.id);}
      if(v.lastId!==null&&!ids.has(v.lastId))throw new Error("invalid-session-store");
      if(v.temporary){if(!Array.isArray(v.temporary.messages)||v.temporary.messages.length>512||Buffer.byteLength(JSON.stringify(v.temporary))>2*1024*1024)throw new Error("invalid-session-store");for(const m of v.temporary.messages){if(typeof m.id!=="string"||m.id.length>256||!["user","assistant"].includes(m.role)||typeof m.text!=="string"||!(m.status===undefined||["running","completed","cancelled","failed","unknown"].includes(m.status)))throw new Error("invalid-session-store");}}
      this.#state={freshRoot:v.freshRoot??null,delivery:v.delivery??null,version:1,lastId:v.lastId,freshDraft:v.freshDraft,sessions:v.sessions.map((x:ManagedSession)=>({root:x.root??null,cwd:x.cwd??null,id:x.id,title:x.title,draft:x.draft,model:x.model,pinned:x.pinned,unread:x.unread,archived:x.archived,archiveUncertain:x.archiveUncertain??false,ephemeral:x.ephemeral,localProject:x.localProject??null,sectionId:x.sectionId??null,sectionName:x.sectionName??null,forkedFromId:x.forkedFromId??null,forkUncertain:x.forkUncertain??false,sectionPosition:x.sectionPosition})),temporary:v.temporary};
    }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw new Error("session-store-unavailable");}}
    this.#loaded=true;this.#confirmed=this.snapshot();
  }
  snapshot(): State { return structuredClone(this.#state); }
  find(id:string): ManagedSession | undefined { return this.snapshot().sessions.find(row=>row.id===id); }
  upsert(id:string,update:Partial<Omit<ManagedSession,"id">>): void {
    if(!validId(id))throw new Error("invalid-session-id");const index=this.#state.sessions.findIndex(row=>row.id===id);const previous=index>=0?this.#state.sessions[index]:{id,title:"持久会话",draft:"",model:null,pinned:false,unread:false,archived:false,ephemeral:false};const row={...previous,...update,id} as ManagedSession;
    if(!(row.root===undefined||row.root===null||validDirectoryBinding(row.root))||!(row.cwd===undefined||row.cwd===null||typeof row.cwd==="string"&&row.cwd.startsWith("/")&&row.cwd.length<=4096&&!/[\x00-\x1f]/.test(row.cwd))||row.root&&row.cwd!==row.root.path||previous?.cwd!=null&&previous.cwd!==row.cwd||previous?.root&&(previous.root.path!==row.root?.path||previous.root.device!==row.root?.device||previous.root.inode!==row.root?.inode))throw new Error("invalid-session-directory");
    if(!(row.sectionPosition===undefined||Number.isSafeInteger(row.sectionPosition)&&row.sectionPosition>=0&&row.sectionPosition<200)||![row.sectionId,row.forkedFromId].every(x=>x===undefined||x===null||validId(x))||![row.localProject,row.sectionName].every(x=>x===undefined||x===null||typeof x==="string"&&x.length<=200&&!/[\x00-\x1f]/.test(x))||!(row.forkUncertain===undefined||typeof row.forkUncertain==="boolean"))throw new Error("invalid-session-metadata");
    if(index<0){if(this.#state.sessions.length>=512)throw new Error("session-store-capacity");this.#state.sessions.push(row);}else this.#state.sessions[index]=row;
  }
  select(id:string|null):void { if(id!==null&&!this.#state.sessions.some(row=>row.id===id))throw new Error("unknown-managed-session");this.#state.lastId=id; }
  pendingDelivery(value:PendingDelivery|null):void {if(value!==null&&!validDelivery(value))throw new Error("invalid-delivery-record");this.#state.delivery=structuredClone(value);}
  freshRoot(root:DirectoryBinding|null):void{if(root!==null&&!validDirectoryBinding(root))throw new Error("invalid-directory-binding");this.#state.freshRoot=structuredClone(root);}
  freshDraft(text:string):void { this.#state.freshDraft=text; }
  preserveTemporary(id:string,messages:DemoMessage[]):void { if(Buffer.byteLength(JSON.stringify(messages))>2*1024*1024||messages.length>512)throw new Error("temporary-cache-capacity");this.#state.temporary={id,messages:structuredClone(messages).map(m=>({...m,stale:true,status:m.status==="running"?"unknown":m.status}))}; }
  /** Serialize metadata edits with persistence. Retain acknowledged remote IDs on write failure. */
  transaction(edit:()=>void,retainOnFailure=false):Promise<void> {
    const run=async()=>{const previous=this.snapshot();try{edit();await this.flush();this.#writeFailed=false;this.#publish();}catch(error){this.#writeFailed=true;if(!retainOnFailure)this.#state=previous;throw error;}};
    const pending=this.#transactions.then(run,run);this.#transactions=pending.catch(()=>{});return pending;
  }
  async settled():Promise<void>{await this.#transactions;if(this.#writeFailed)throw new Error("session-store-write-unconfirmed");await this.#tail;}
  async flush(): Promise<void> {
    if(!this.#path){this.#confirmed=this.snapshot();return;}if(!this.#loaded)throw new Error("session-store-not-loaded");const path=this.#path,confirmed=this.snapshot(),text=JSON.stringify(confirmed)+"\n";
    if(Buffer.byteLength(text)>4*1024*1024)throw new Error("session-store-capacity");
    const write=async()=>{await mkdir(dirname(path),{recursive:true,mode:0o700});const directory=await lstat(dirname(path));if(!directory.isDirectory()||directory.isSymbolicLink())throw new Error("session-store-unavailable");const temp=join(dirname(path),".state-"+randomUUID());try{const file=await open(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);try{await file.writeFile(text);await file.sync();}finally{await file.close();}await rename(temp,path);}finally{await rm(temp,{force:true});}};
    this.#tail=this.#tail.then(write,write);await this.#tail;this.#confirmed=confirmed;
  }
}
