import {spawn} from "node:child_process";
import {rm} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {EditableWorkspace} from "../desktop-host/editable-workspace.ts";
import {SessionStore} from "../desktop-host/session-store.ts";
import {PreviewReadBudget} from "../desktop-host/session-preview.ts";
import {StdioWorkbenchHost} from "../desktop-host/stdio-host.ts";
import {syntheticRepositoryRoots} from "./repository-fixture.ts";
export const workflowWait=async(fn:()=>boolean)=>{for(let n=0;n<400;n++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error("workflow-condition-timeout");};
export async function workflowFixture(t:{after(fn:()=>Promise<void>):void},offline=true){const f=await syntheticRepositoryRoots(),frames:Record<string,any>[]=[];
 const host=new StdioWorkbenchHost(()=>{const child=spawn(process.execPath,[fileURLToPath(new URL("../desktop/chat-fixture-peer.mjs",import.meta.url)),"workflow",join(f.directory,"core.json")],{env:{},stdio:["pipe","pipe","pipe"]});const write=child.stdin.write.bind(child.stdin);child.stdin.write=((data:string|Uint8Array,...args:unknown[])=>{for(const line of String(data).trim().split("\n"))frames.push(JSON.parse(line));return Reflect.apply(write,child.stdin,[data,...args]);})as typeof child.stdin.write;return child;},{requestTimeoutMs:1500});
 const store=new SessionStore(join(f.directory,"sessions.json")),workspace=new EditableWorkspace(host.client(),f.roots.a,offline,store);t.after(async()=>{try{await workspace.dispose();}finally{await host.dispose();await rm(f.directory,{recursive:true,force:true});}});await workspace.dispatch({type:"connect"});await workspace.dispatch({type:"browseHistory"});await workspace.dispatch({type:"continueSession",id:"saved-z"});await workspace.selectDirectory("main",workspace.captureDirectory("main"),f.roots.a);
 const write=async(text:string,owner="main")=>{const e=workspace.snapshotOwner(owner).editor!;await workspace.dispatchOwner(owner,{type:"editDraft",routeId:e.key,text,revision:e.revision,lease:e.lease});};
 const start=async(text:string,owner="main")=>{await write(text,owner);await workspace.dispatchOwner(owner,{type:"submit"});await workspace.dispatchOwner(owner,{type:"confirm"});await workflowWait(()=>!!workspace.snapshotOwner(owner).workflow!.requests.find(r=>r.status==="pending"));return workspace.snapshotOwner(owner).workflow!.requests.find(r=>r.status==="pending")!;};
 const preview=(owner:string,id="saved-z")=>workspace.registerPreview(owner,workspace.previewSource(id),new PreviewReadBudget());return {...f,workspace,store,host,frames,start,write,preview};}
