import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { StdioWorkbenchHost } from "../desktop-host/stdio-host.ts";
import { OfficialChatController } from "../desktop-host/official-chat-controller.ts";
import { SessionSearch } from "../desktop-host/session-search.ts";
import { SessionPreview, PreviewReadBudget } from "../desktop-host/session-preview.ts";
import { ProtocolSession } from "../protocol-adapter/session.ts";
import { validateDesktopCommand } from "../desktop-host/ipc-contract.ts";
const wait=async(fn:()=>boolean)=>{for(let n=0;n<300;n++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw new Error("search-condition-timeout");};
function create(t:{after(fn:()=>Promise<void>):void}){
 const frames:{method:string;params:Record<string,unknown>}[]=[];
 const host=new StdioWorkbenchHost(()=>{const child=spawn(process.execPath,[fileURLToPath(new URL("../desktop/chat-fixture-peer.mjs",import.meta.url)),"search-history"],{env:{},stdio:["pipe","pipe","pipe"]});const write=child.stdin.write.bind(child.stdin);child.stdin.write=((data:string|Uint8Array,...args:unknown[])=>{for(const line of String(data).trim().split("\n"))frames.push(JSON.parse(line));return Reflect.apply(write,child.stdin,[data,...args]);}) as typeof child.stdin.write;return child;},{searchApi:true,requestTimeoutMs:1000});
 const client={...host.client()},controller=new OfficialChatController(client,"/synthetic/chat",true);t.after(()=>controller.dispose());return {host,client,controller,frames};
}
async function query(c:OfficialChatController,text="BODYNEEDLE",archived=false,kind:"content"|"title"="content"){
 await c.dispatch({type:"searchSessions",text,archived,kind});await wait(()=>!c.snapshot().sessionSearch!.loading);return c.snapshot().sessionSearch!;
}
test("official search crosses unloaded catalog pages; preview recovers full older history and preserves editable ownership",async t=>{
 const {controller:c,client,frames,host}=create(t);await c.dispatch({type:"connect"});await c.dispatch({type:"draft",routeId:"official-chat",text:"unsent search draft"});await c.dispatch({type:"browseHistory"});assert.equal(c.snapshot().historyBrowser!.rows.length,2);await c.dispatch({type:"returnToChat"});const before=c.snapshot();
 let result=await query(c);assert.equal(result.rows.length,2);assert.equal(result.more,true);
 await c.dispatch({type:"moreSessionSearch"});await wait(()=>!c.snapshot().sessionSearch!.loading);result=c.snapshot().sessionSearch!;assert.deepEqual(result.rows.map(r=>r.id),["search-0","search-1","search-2","search-3"]);
 await c.dispatch({type:"moreSessionSearch"});await wait(()=>!c.snapshot().sessionSearch!.loading);result=c.snapshot().sessionSearch!;assert.equal(result.rows.length,5);assert.equal(result.more,false);
 assert.equal(c.snapshot().projects.some(p=>p.threads.some(t=>t.id==="search-4")),false);
 const pane=new SessionPreview(client,c.searchPreviewSource("search-4"),new PreviewReadBudget());t.after(async()=>pane.dispose());await pane.dispatch({type:"refreshHistory"});await pane.dispatch({type:"history",threadId:"search-4"});assert.equal(pane.snapshot().history.turnCount,3);assert.match(pane.snapshot().messages[0]!.text,/BODYNEEDLE/);
 assert.deepEqual(c.snapshot().projects,before.projects);assert.deepEqual(c.snapshot().route,before.route);assert.equal(c.snapshot().draft,before.draft);assert.equal(c.snapshot().chatStatus!.model,before.chatStatus!.model);assert.equal(host.getView().threads.length,0);
 assert.equal(frames.some(f=>["thread/resume","thread/start","turn/start","thread/items/list"].includes(f.method)),false);assert.ok(frames.filter(f=>f.method==="thread/search").every(f=>f.params.sourceKinds===undefined&&f.params.archived===false));assert.equal(JSON.stringify(result).includes("private-never-in-renderer"),false);
 for(const type of ["searchSessions","moreSessionSearch","openSearchResult"])await assert.rejects(pane.dispatch(type==="searchSessions"?{type,text:"x",archived:false,kind:"content"}:type==="openSearchResult"?{type,id:"search-0"}:{type}),/preview-read-only/);
});
test("title and archived scopes are explicit, empty results cannot open arbitrary sessions",async t=>{
 const {controller:c,frames}=create(t);await c.dispatch({type:"connect"});assert.equal((await query(c,"BODYNEEDLE",false,"title")).rows.length,0);assert.equal((await query(c,"合成搜索会话 4",false,"title")).rows[0]!.id,"search-4");assert.equal((await query(c,"BODYNEEDLE",true)).rows[0]!.id,"search-5");assert.equal(c.searchPreviewSource("search-5").archived,true);assert.throws(()=>c.searchPreviewSource("search-0"),/unknown-search-result/);assert.equal((await query(c,"does-not-exist")).rows.length,0);assert.match(c.snapshot().sessionSearch!.notice,/没有匹配/);assert.equal(frames.filter(f=>f.method==="thread/list").at(-1)!.params.searchTerm,"合成搜索会话 4");
});
test("cancel drops late responses, rapid terms queue only the latest with one physical search",async t=>{
 const {controller:c,client}=create(t);await c.dispatch({type:"connect"});const original=client.searchThreads;let release!:()=>void;const gate=new Promise<void>(r=>release=r);let calls:string[]=[],active=0,max=0;
 client.searchThreads=async p=>{calls.push(p.searchTerm);active++;max=Math.max(max,active);try{if(calls.length===1)await gate;return await original(p);}finally{active--;}};
 await c.dispatch({type:"searchSessions",text:"BODYNEEDLE",archived:false,kind:"content"});await c.dispatch({type:"searchSessions",text:"discard-middle",archived:false,kind:"content"});await c.dispatch({type:"searchSessions",text:"合成搜索会话",archived:false,kind:"content"});release();await wait(()=>!c.snapshot().sessionSearch!.loading&&!c.snapshot().sessionSearch!.inflight);assert.deepEqual(calls,["BODYNEEDLE","合成搜索会话"]);assert.equal(max,1);assert.equal(c.snapshot().sessionSearch!.term,"合成搜索会话");
 let releaseCancel!:()=>void;const cancelGate=new Promise<void>(r=>releaseCancel=r);client.searchThreads=async p=>{await cancelGate;return original(p);};await c.dispatch({type:"searchSessions",text:"BODYNEEDLE",archived:false,kind:"content"});await c.dispatch({type:"cancelSessionSearch"});releaseCancel();await wait(()=>!c.snapshot().sessionSearch!.inflight);assert.equal(c.snapshot().sessionSearch!.stale,true);assert.equal(c.snapshot().sessionSearch!.rows.length,0);assert.throws(()=>c.searchPreviewSource("search-0"),/search-result-stale/);
});
test("cursor loop/error preserves cache but disables more and open, fresh search recovers",async t=>{
 const {controller:c,client}=create(t);await c.dispatch({type:"connect"});const original=client.searchThreads;await query(c);client.searchThreads=async p=>({...await original(p),nextCursor:p.cursor??"search:2"});await c.dispatch({type:"moreSessionSearch"});await wait(()=>!c.snapshot().sessionSearch!.loading);assert.equal(c.snapshot().sessionSearch!.rows.length,2);assert.equal(c.snapshot().sessionSearch!.stale,true);assert.equal(c.snapshot().sessionSearch!.more,false);client.searchThreads=async()=>{throw new Error("sensitive-server-error");};await query(c);assert.equal(JSON.stringify(c.snapshot().sessionSearch).includes("sensitive-server-error"),false);client.searchThreads=original;await query(c);assert.equal(c.snapshot().sessionSearch!.stale,false);
});
test("reconnect invalidates search without replay, and late old-generation search is ignored",async t=>{
 const {controller:c,client,frames}=create(t);await c.dispatch({type:"connect"});const original=client.searchThreads;let release!:()=>void;const gate=new Promise<void>(r=>release=r);client.searchThreads=async p=>{const page=await original(p);await gate;return page;};await c.dispatch({type:"searchSessions",text:"BODYNEEDLE",archived:false,kind:"content"});await wait(()=>frames.some(f=>f.method==="thread/search"));await c.dispatch({type:"disconnect"});await c.dispatch({type:"reconnect"});release();await wait(()=>!c.snapshot().sessionSearch!.inflight);assert.equal(c.snapshot().sessionSearch!.stale,true);assert.equal(c.snapshot().sessionSearch!.rows.length,0);assert.equal(frames.filter(f=>f.method==="thread/search").length,1);
});
test("search display budget stops before excess page and does not retain raw thread metadata",async t=>{
 const {client}=create(t);await client.start();const original=client.searchThreads;const source=await original({searchTerm:"BODYNEEDLE",limit:20});let count=0;client.searchThreads=async p=>{count++;return {data:Array.from({length:20},(_,n)=>({thread:{...source.data[0]!.thread,id:`result-${(count-1)*20+n}`},snippet:"snippet"})),nextCursor:"cursor-"+count,backwardsCursor:null};};const search=new SessionSearch(client);t.after(async()=>search.dispose());search.search("x",false,"content");await wait(()=>!search.snapshot().loading);for(let n=1;n<5;n++){search.more();await wait(()=>!search.snapshot().loading);}assert.equal(search.snapshot().rows.length,100);assert.equal(search.snapshot().more,false);search.more();assert.equal(count,5);assert.match(search.snapshot().notice,/展示上限/);
});
test("search IPC and optional protocol capability reject unsupported scope and other experimental methods",()=>{
 for(const cmd of [{type:"searchSessions",text:"x",archived:false,kind:"content",path:"/private"},{type:"searchSessions",text:"\u0000",archived:false,kind:"content"},{type:"searchSessions",text:" ",archived:false,kind:"content"},{type:"searchSessions",text:"x".repeat(129),archived:false,kind:"content"},{type:"openSearchResult",id:"../x"}])assert.throws(()=>validateDesktopCommand(cmd),/invalid-command/);
 const s=new ProtocolSession({searchApi:true}),connection=s.connect();void connection.initialized.catch(()=>{});const init=JSON.parse(s.takeOutbound()[0]!);assert.equal(init.params.capabilities.experimentalApi,true);s.receive(Buffer.from(JSON.stringify({id:init.id,result:{userAgent:"fixture",codexHome:"/synthetic",platformFamily:"unix",platformOs:"macos"}})+"\n"),connection.epoch);assert.throws(()=>s.request("thread/searchOccurrences",{}),/experimental-disabled/);assert.throws(()=>s.searchThreads({searchTerm:"x",limit:101}),/invalid-page-limit/);assert.throws(()=>s.searchThreads({searchTerm:"x",cursor:"x".repeat(4097)}),/invalid-page-cursor/);assert.throws(()=>s.searchThreads({searchTerm:"x",path:"/private"} as any),/unsupported-field/);s.disconnect(connection.epoch,"test-finished");
});

test("experimental search is disabled by default and validates native response bounds",async()=>{
 const initialize=async(enabled:boolean)=>{const s=new ProtocolSession({searchApi:enabled});const connection=s.connect(),request=JSON.parse(s.takeOutbound()[0]!);s.receive(Buffer.from(JSON.stringify({id:request.id,result:{userAgent:"fixture",codexHome:"/synthetic",platformFamily:"unix",platformOs:"macos"}})+"\n"),connection.epoch);await connection.initialized;s.takeOutbound();return {s,epoch:connection.epoch};};
 const disabled=await initialize(false);assert.throws(()=>disabled.s.searchThreads({searchTerm:"x"}),/experimental-disabled/);disabled.s.disconnect(disabled.epoch,"test-finished");
 for(const badCursor of [false,true]){const {s,epoch}=await initialize(true);const response=s.searchThreads({searchTerm:"x",limit:1}),rejected=assert.rejects(response,/invalid-protocol/),frame=JSON.parse(s.takeOutbound()[0]!);
  const {syntheticThread}=await import("./helpers.ts");s.receive(Buffer.from(JSON.stringify({id:frame.id,result:{data:badCursor?[]:[{thread:syntheticThread(),snippet:"x"},{thread:syntheticThread(),snippet:"x"}],nextCursor:badCursor?"x".repeat(4097):null,backwardsCursor:null}})+"\n"),epoch);await rejected;assert.equal(s.state,"failed");
 }
});
