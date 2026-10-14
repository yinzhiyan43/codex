import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { OfficialChatController } from "../desktop-host/official-chat-controller.ts";
import { StdioWorkbenchHost } from "../desktop-host/stdio-host.ts";
const wait = async (predicate: () => boolean) => { for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error("offline-condition-timeout"); };
function create(t: {after(fn:()=>Promise<void>):void}, mode="normal", cancelTimeout=15000) {
  const frames: {method:string;params:Record<string,unknown>}[]=[];
  const fixture=fileURLToPath(new URL("../desktop/chat-fixture-peer.mjs",import.meta.url));
  const host=new StdioWorkbenchHost(()=>{
    const child=spawn(process.execPath,[fixture,mode],{env:{},stdio:["pipe","pipe","pipe"]});const original=child.stdin.write.bind(child.stdin);
    child.stdin.write=((data:string|Uint8Array,...args:unknown[])=>{for(const line of String(data).trim().split("\n")) frames.push(JSON.parse(line));return Reflect.apply(original,child.stdin,[data,...args]);}) as typeof child.stdin.write;return child;
  },{requestTimeoutMs:1000});
  const controller=new OfficialChatController(host.client(),"/synthetic/chat",true,cancelTimeout);t.after(()=>controller.dispose());
  return {controller,host,frames};
}
const draft = (c:OfficialChatController,text:string) => c.dispatch({type:"draft",routeId:c.snapshot().route.threadId??"official-chat",text});
async function send(c:OfficialChatController,text:string) {await draft(c,text);await c.dispatch({type:"submit"});await c.dispatch({type:"confirm"});}
test("offline real-protocol chain selects catalog model, sends once, streams and refreshes only owned thread",async t=>{
  const {controller:c,host,frames}=create(t);await c.dispatch({type:"connect"});assert.equal(c.snapshot().chatStatus!.ready,true);
  await assert.rejects(c.dispatch({type:"selectModel",model:"gpt-not-in-catalog"}),/model-unavailable/);
  await c.dispatch({type:"selectModel",model:"gpt-fixture-two"});await draft(c,"流式中文");await Promise.all([c.dispatch({type:"submit"}),c.dispatch({type:"submit"})]);
  await Promise.all([c.dispatch({type:"confirm"}),c.dispatch({type:"confirm"})]);
  await wait(()=>c.snapshot().messages.some(m=>m.status==="running"&&m.text.includes("离线协议")));
  assert.equal(frames.filter(f=>f.method==="turn/start").length,1);assert.equal(frames.find(f=>f.method==="turn/start")!.params.model,"gpt-fixture-two");
  assert.ok(frames.findIndex(f=>f.method==="config/read")<frames.findIndex(f=>f.method==="thread/start"));
  await wait(()=>c.snapshot().messages.some(m=>m.status==="completed"));assert.equal(c.snapshot().messages.filter(m=>m.role==="user").length,1);assert.equal(c.snapshot().draft,"");
  assert.equal(c.snapshot().history.hasMore,false);assert.equal(c.snapshot().chatStatus!.canRefresh,true);
  await c.dispatch({type:"history",threadId:c.snapshot().route.threadId!});assert.equal(frames.filter(f=>f.method==="thread/items/list").length,0);assert.equal(frames.find(f=>f.method==="thread/read")!.params.includeTurns,false);
  assert.equal(JSON.stringify(c.snapshot()).includes("fixture@example.invalid"),false);assert.equal(host.getView().state,"ready");
});
test("cancel while turn/start reply is pending sends one interrupt and waits for terminal",async t=>{
  const {controller:c,frames}=create(t);await c.dispatch({type:"connect"});await draft(c,"[slow] 测试取消");await c.dispatch({type:"submit"});const pending=c.dispatch({type:"confirm"});
  await wait(()=>frames.some(f=>f.method==="turn/start"));await Promise.all([c.dispatch({type:"cancel"}),c.dispatch({type:"cancel"})]);await pending;
  assert.equal(c.snapshot().chatStatus!.phase,"cancelling");assert.equal(c.snapshot().chatStatus!.interruptAcknowledged,true);assert.equal(c.snapshot().running,true);
  await wait(()=>c.snapshot().messages.some(m=>m.status==="cancelled"));assert.equal(c.snapshot().running,false);assert.equal(frames.filter(f=>f.method==="turn/interrupt").length,1);
  assert.equal(JSON.stringify(c.snapshot()).includes("LATE_MUST_IGNORE"),false);
});
test("terminal completion wins over a late interrupt RPC error",async t=>{
  const {controller:c,host}=create(t);await c.dispatch({type:"connect"});await send(c,"[finish-before-interrupt-error]");await wait(()=>c.snapshot().chatStatus!.phase==="running");await c.dispatch({type:"cancel"});
  assert.equal(c.snapshot().chatStatus!.phase,"idle");assert.equal(c.snapshot().error,null);assert.equal(host.getView().state,"ready");assert.equal(c.snapshot().messages.some(m=>m.status==="completed"),true);
});
test("missing cancel terminal reaches unknown and stops without replay",async t=>{
  const {controller:c,host,frames}=create(t,"normal",40);await c.dispatch({type:"connect"});await send(c,"[no-cancel-terminal]");await c.dispatch({type:"cancel"});
  await wait(()=>host.getView().state==="stopped");assert.equal(c.snapshot().chatStatus!.phase,"unknown");assert.equal(c.snapshot().chatStatus!.ready,false);
  await c.dispatch({type:"new"});await draft(c,"must-not-send");await c.dispatch({type:"submit"});await c.dispatch({type:"confirm"});assert.equal(frames.filter(f=>f.method==="turn/start").length,1);
});
test("service failed terminal is distinct from completion and exposes no raw error",async t=>{
  const {controller:c}=create(t);await c.dispatch({type:"connect"});await send(c,"[fail]");await wait(()=>c.snapshot().messages.some(m=>m.status==="failed"));assert.match(c.snapshot().error!,/失败/);assert.equal(c.snapshot().running,false);assert.equal(JSON.stringify(c.snapshot()).includes("not-for-renderer"),false);
});
test("disconnect during streaming preserves unknown cache and reconnect never repeats turn",async t=>{
  const {controller:c,frames}=create(t);await c.dispatch({type:"connect"});await send(c,"[disconnect]");await wait(()=>c.snapshot().chatStatus!.phase==="unknown");assert.equal(c.snapshot().chatStatus!.ready,false);
  await c.dispatch({type:"reconnect"});assert.equal(c.snapshot().route.threadId,null);assert.equal(c.snapshot().messages.some(m=>m.stale),true);assert.equal(frames.filter(f=>f.method==="turn/start").length,1);
});
for(const mode of ["unsafe-config","unsafe-tools","unsafe-agents","unsafe-computer","no-account"]) test(`invalid ${mode} fails closed before model turn`,async t=>{
  const {controller:c,frames}=create(t,mode);await c.dispatch({type:"connect"});assert.equal(c.snapshot().chatStatus!.ready,false);await draft(c,"never sent");await c.dispatch({type:"submit"});await c.dispatch({type:"confirm"});assert.equal(frames.filter(f=>["thread/start","turn/start"].includes(f.method)).length,0);
});
test("uncertain start reply stops connection and preserves draft without automatic retry",async t=>{
  const {controller:c,host,frames}=create(t);await c.dispatch({type:"connect"});await send(c,"[reply-error]");assert.equal(c.snapshot().chatStatus!.phase,"unknown");assert.equal(host.getView().state,"stopped");assert.equal(c.snapshot().draft,"[reply-error]");assert.equal(frames.filter(f=>f.method==="turn/start").length,1);
});

test("disconnect supersedes a pending current-thread refresh and permits reconnect",async t=>{
  const {controller:c,host,frames}=create(t,"slow-read");await c.dispatch({type:"connect"});await send(c,"complete before refresh");await wait(()=>c.snapshot().messages.some(m=>m.status==="completed"));
  const reading=c.dispatch({type:"history",threadId:c.snapshot().route.threadId!});await wait(()=>frames.some(f=>f.method==="thread/read"));await c.dispatch({type:"disconnect"});await reading;
  assert.equal(c.snapshot().chatStatus!.phase,"idle");assert.equal(host.getView().state,"stopped");await c.dispatch({type:"reconnect"});assert.equal(c.snapshot().chatStatus!.ready,true);assert.equal(frames.filter(f=>f.method==="turn/start").length,1);
});
