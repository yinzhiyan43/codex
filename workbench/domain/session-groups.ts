import { createHash } from "node:crypto";
import type { ManagedSession } from "../desktop-host/session-store.ts";
export function sessionGroups(records:ManagedSession[]){
 const groups=[{id:"official-chat",name:"官方持久会话",threads:[] as {id:string;title:string}[]}],byName=new Map<string,typeof groups[number]>();
 for(const row of [...records].reverse().sort((a,b)=>Number(b.pinned)-Number(a.pinned))){
  if(row.archived)continue;let group=groups[0]!;
  if(row.localProject||row.sectionId){const key=JSON.stringify([row.localProject??null,row.sectionId??null]);let owned=byName.get(key);if(!owned){owned={id:"group-"+createHash("sha256").update(key).digest("hex").slice(0,24),name:(row.localProject?"本地项目："+row.localProject:"未分配项目")+(row.sectionId?" · 官方分区："+(row.sectionName??row.sectionId):""),threads:[]};groups.push(owned);byName.set(key,owned);}group=owned;}
  group.threads.push({id:row.id,title:(row.pinned?"📌 ":"")+(row.unread?"● ":"")+(row.forkedFromId?"⑂ ":"")+row.title});
 }
 const byId=new Map(records.map(row=>[row.id,row]));for(const group of groups)group.threads.sort((a,b)=>{const x=byId.get(a.id)!,y=byId.get(b.id)!;return Number(y.pinned)-Number(x.pinned)||(x.sectionId&&x.sectionId===y.sectionId?(x.sectionPosition??200)-(y.sectionPosition??200):0);});
 return groups;
}
