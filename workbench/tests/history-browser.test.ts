import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { OfficialChatController } from "../desktop-host/official-chat-controller.ts";
import { StdioWorkbenchHost } from "../desktop-host/stdio-host.ts";
const wait=async(fn:()=>boolean)=>{for(let n=0;n<200;n++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error("history-condition-timeout");};
function create(t:{after(fn:()=>Promise<void>):void},mode="normal"){
 const frames:{method:string;params:Record<string,unknown>}[]=[];
 const host=new StdioWorkbenchHost(()=>{const c=spawn(process.execPath,[fileURLToPath(new URL("../desktop/chat-fixture-peer.mjs",import.meta.url)),mode],{env:{},stdio:["pipe","pipe","pipe"]});const write=c.stdin.write.bind(c.stdin);c.stdin.write=((data:string|Uint8Array,...args:unknown[])=>{for(const line of String(data).trim().split("\n"))frames.push(JSON.parse(line));return Reflect.apply(write,c.stdin,[data,...args]);}) as typeof c.stdin.write;return c;},{requestTimeoutMs:1000});
 const controller=new OfficialChatController(host.client(),"/synthetic/chat",true);t.after(()=>controller.dispose());return{controller,host,frames};
}
test("saved browsing uses server list/full-turn cursors, preserves chronology and never executes",async t=>{
 const{controller:c,frames}=create(t);await c.dispatch({type:"connect"});await c.dispatch({type:"draft",routeId:"official-chat",text:"保留草稿"});await c.dispatch({type:"browseHistory"});await c.dispatch({type:"moreThreads"});assert.deepEqual(c.snapshot().historyBrowser!.rows.map(row=>row.id),["saved-z","saved-a","saved-b","saved-c"]);
 await c.dispatch({type:"thread",id:"saved-z"});assert.deepEqual(c.snapshot().messages.map(m=>m.text),["合成历史Z 用户 2","合成历史Z 回应 2","合成历史Z 用户 3","合成历史Z 回应 3"]);await c.dispatch({type:"history",threadId:"saved-z"});assert.equal(c.snapshot().history.turnCount,3);assert.equal(c.snapshot().messages.length,6);assert.match(c.snapshot().messages[0]!.text,/用户 1/);
 for(const type of ["submit","confirm","cancel","selectModel"]){const cmd=type==="selectModel"?{type,model:"gpt-fixture-one"}:{type};await assert.rejects(c.dispatch(cmd),/saved-history-read-only/);}
 assert.equal(JSON.stringify(c.snapshot()).includes("private-never-in-renderer"),false);assert.equal(frames.some(f=>["thread/resume","thread/start","turn/start","thread/items/list"].includes(f.method)),false);
 assert.ok(frames.filter(f=>f.method==="thread/turns/list").every(f=>f.params.itemsView==="full"));await c.dispatch({type:"returnToChat"});assert.equal(c.snapshot().draft,"保留草稿");assert.equal(c.snapshot().route.threadId,null);
});
test("late selected-thread pages cannot overwrite a newer selection or a returned chat",async t=>{
 const{controller:c,frames}=create(t,"slow-history");await c.dispatch({type:"connect"});await c.dispatch({type:"browseHistory"});const old=c.dispatch({type:"thread",id:"saved-z"});await wait(()=>frames.some(f=>f.method==="thread/turns/list"));await c.dispatch({type:"thread",id:"saved-a"});await old;assert.equal(c.snapshot().route.threadId,"saved-a");assert.ok(c.snapshot().messages.every(m=>m.text.includes("历史A")));
 const reading=c.dispatch({type:"thread",id:"saved-z"});await c.dispatch({type:"returnToChat"});await c.dispatch({type:"draft",routeId:"official-chat",text:"not sent during pending read"});await c.dispatch({type:"submit"});assert.equal(c.snapshot().pending,null);await reading;assert.equal(c.snapshot().route.threadId,null);assert.equal(c.snapshot().draft,"not sent during pending read");assert.equal(frames.some(f=>f.method==="turn/start"),false);
});
test("cancelled history read and reconnect preserve stale cache without automatic history or model replay",async t=>{
 const{controller:c,frames}=create(t);await c.dispatch({type:"connect"});await c.dispatch({type:"browseHistory"});await c.dispatch({type:"thread",id:"saved-z"});const count=c.snapshot().messages.length;await c.dispatch({type:"disconnect"});assert.equal(c.snapshot().history.stale,true);await c.dispatch({type:"reconnect"});assert.equal(c.snapshot().messages.length,count);assert.equal(c.snapshot().history.stale,true);assert.equal(frames.filter(f=>f.method==="thread/turns/list").length,1);await c.dispatch({type:"refreshHistory"});assert.equal(c.snapshot().history.stale,false);
});
for(const mode of ["unsupported-history","bad-history-cursor"])test(`history ${mode} preserves safe state and never falls back to items`,async t=>{
 const{controller:c,frames}=create(t,mode);await c.dispatch({type:"connect"});await c.dispatch({type:"browseHistory"});await c.dispatch({type:"thread",id:"saved-z"});if(mode==="bad-history-cursor")await c.dispatch({type:"history",threadId:"saved-z"});assert.equal(c.snapshot().running,false);assert.equal(frames.some(f=>f.method==="thread/items/list"),false);assert.match(c.snapshot().history.notice!,/缓存|存储/);
});
test("unlisted thread and arbitrary history fields cannot read other paths or execute",async t=>{
 const{controller:c,frames}=create(t);await c.dispatch({type:"connect"});await c.dispatch({type:"browseHistory"});await assert.rejects(c.dispatch({type:"thread",id:"unlisted"}),/outside-history/);await assert.rejects(c.dispatch({type:"browseHistory",path:"/private"}),/invalid-command/);assert.equal(frames.some(f=>f.method==="thread/read"),false);
});
test("browsing and returning preserves an existing current conversation, selected model and unsent draft",async t=>{
 const{controller:c,frames}=create(t);await c.dispatch({type:"connect"});await c.dispatch({type:"draft",routeId:"official-chat",text:"existing conversation"});await c.dispatch({type:"submit"});await c.dispatch({type:"confirm"});await wait(()=>!c.snapshot().running);
 const before=c.snapshot();await c.dispatch({type:"draft",routeId:before.route.threadId!,text:"unsent current draft"});await c.dispatch({type:"browseHistory"});await c.dispatch({type:"thread",id:"saved-z"});await c.dispatch({type:"returnToChat"});
 const after=c.snapshot();assert.equal(after.route.threadId,before.route.threadId);assert.equal(after.chatStatus!.model,before.chatStatus!.model);assert.deepEqual(after.messages,before.messages);assert.equal(after.draft,"unsent current draft");assert.equal(frames.filter(f=>f.method==="turn/start").length,1);
});

test("catalog refresh keeps the selected older record readable with its verified title",async t=>{
 const {controller:c}=create(t);await c.dispatch({type:"connect"});await c.dispatch({type:"browseHistory"});await c.dispatch({type:"moreThreads"});await c.dispatch({type:"thread",id:"saved-c"});await c.dispatch({type:"refreshThreads"});
 assert.equal(c.snapshot().historyBrowser!.rows.some(row=>row.id==="saved-c"),false);assert.equal(c.snapshot().title,"合成历史C");await c.dispatch({type:"refreshHistory"});assert.equal(c.snapshot().history.stale,false);assert.match(c.snapshot().messages[0]!.text,/历史C/);
});
test("130 saved selections and reconnect do not fill the live projection or evict current text",async t=>{
 const {controller:c,host,frames}=create(t,"many-history");await c.dispatch({type:"connect"});await c.dispatch({type:"browseHistory"});while(c.snapshot().historyBrowser!.moreThreads)await c.dispatch({type:"moreThreads"});
 const rows=c.snapshot().historyBrowser!.rows;assert.equal(rows.length,130);for(const row of rows)await c.dispatch({type:"thread",id:row.id});assert.equal(host.getView().state,"ready");assert.equal(host.getView().threads.length,0);
 await c.dispatch({type:"disconnect"});await c.dispatch({type:"reconnect"});await c.dispatch({type:"refreshHistory"});assert.equal(host.getView().state,"ready");assert.equal(host.getView().threads.length,0);assert.equal(c.snapshot().history.stale,false);assert.equal(frames.some(f=>["thread/resume","thread/start","turn/start"].includes(f.method)),false);
});


for(const [mode,limit,pages] of [["large-catalog",200,10],["small-page-catalog",32,16]] as const)test(`catalog ${mode} stops at exact capacity before requesting an excess page`,async t=>{
 const {controller:c,frames}=create(t,mode);await c.dispatch({type:"connect"});await c.dispatch({type:"browseHistory"});for(let n=1;n<pages;n++)await c.dispatch({type:"moreThreads"});assert.equal(c.snapshot().historyBrowser!.rows.length,limit);assert.equal(c.snapshot().historyBrowser!.moreThreads,false);assert.match(c.snapshot().history.notice!,/本地展示上限/);
 const count=frames.filter(f=>f.method==="thread/list").length;assert.equal(count,pages);await c.dispatch({type:"moreThreads"});assert.equal(frames.filter(f=>f.method==="thread/list").length,count);await c.dispatch({type:"refreshThreads"});assert.equal(c.snapshot().historyBrowser!.rows.length,mode==="large-catalog"?20:2);assert.equal(c.snapshot().historyBrowser!.moreThreads,true);
});
