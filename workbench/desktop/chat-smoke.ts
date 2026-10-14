import type { BrowserWindow } from "electron";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
/** Full renderer→IPC→controller→host→schema→offline JSONL peer chain, no native core. */
export async function runChatSmoke(window: BrowserWindow, output: string, errors: string[]): Promise<void> {
  const js = (source: string) => window.webContents.executeJavaScript(source);
  const snap = () => js("window.workbench.snapshot()");
  const wait = async (source: string) => { for(let i=0;i<160;i++){if(await js(source))return;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error("Offline chat UI condition timed out: "+source); };
  const click = (id: string) => js(`document.getElementById(${JSON.stringify(id)}).click()`);
  const capture = async (name: string) => { for(let i=0;i<3;i++) { await js("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))"); try { await writeFile(join(output,name+".png"),(await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG()); return; } catch(error) { if (!(error instanceof Error) || error.message!=="UnknownVizError" || i===2) throw error; await new Promise(resolve=>setTimeout(resolve,150)); } } };
  const draft = (text: string) => js(`(()=>{const d=document.getElementById('draft');d.value=${JSON.stringify(text)};d.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const submit = async (text: string) => {await draft(text);await click("send");await wait("document.getElementById('confirm-dialog').open");await click("confirm");};
  await wait("window.workbench.snapshot().then(v=>v.chatStatus?.ready)");
  let view = await snap(); assert.equal(view.mode,"official-chat");assert.equal(view.chatStatus.offline,true);
  assert.match(await js("document.getElementById('mode-label').textContent"),/离线合成验证/);
  assert.equal(await js("typeof require"),"undefined");assert.equal(JSON.stringify(view).includes("fixture@example.invalid"),false);
  await click("account");assert.match(await js("document.getElementById('account-menu').textContent"),/\u79bb\u7ebf\u5408\u6210\u8d26\u6237/);await click("account-close");
  await js("(()=>{const m=document.getElementById('model-choice');m.value='gpt-fixture-two';m.dispatchEvent(new Event('change'));})()");
  await wait("window.workbench.snapshot().then(v=>v.chatStatus.model==='gpt-fixture-two')");await capture("chat-ready");
  await draft("完整离线流式链");await click("send");await wait("document.getElementById('confirm-dialog').open");
  await js("document.getElementById('confirm').click();document.getElementById('confirm').click();");
  await wait("window.workbench.snapshot().then(v=>v.messages.some(m=>m.role==='assistant'&&m.status==='running'&&m.text.includes('离线协议')))");await capture("chat-streaming");
  await wait("window.workbench.snapshot().then(v=>v.messages.some(m=>m.role==='assistant'&&m.status==='completed'))");
  view=await snap();assert.equal(view.history.turnCount,1);assert.equal(view.messages.filter((m:{role:string})=>m.role==="user").length,1);assert.equal(view.draft,"");
  assert.match(view.messages.at(-1).text,/离线协议流式验证已完成/);assert.equal(view.history.hasMore,false);
  await click("refresh-saved-history");await wait("window.workbench.snapshot().then(v=>!v.loading)");assert.match((await snap()).history.notice,/官方持久会话/);
  await submit("[slow] 取消链");await wait("window.workbench.snapshot().then(v=>v.chatStatus.phase==='running')");await click("stop");
  await wait("window.workbench.snapshot().then(v=>v.chatStatus.phase==='cancelling'&&v.chatStatus.interruptAcknowledged)");assert.equal((await snap()).running,true);
  await wait("window.workbench.snapshot().then(v=>v.messages.some(m=>m.status==='cancelled'))");view=await snap();assert.equal(view.running,false);assert.equal(JSON.stringify(view).includes("LATE_MUST_IGNORE"),false);await capture("chat-interrupted");
  await submit("[fail] 失败链");await wait("window.workbench.snapshot().then(v=>v.messages.some(m=>m.status==='failed'))");assert.match((await snap()).error,/失败/);assert.equal(JSON.stringify(await snap()).includes("not-for-renderer"),false);
  await submit("[disconnect] 断线链");await wait("window.workbench.snapshot().then(v=>v.chatStatus.phase==='unknown')");view=await snap();assert.equal(view.chatStatus.ready,false);assert.equal(await js("document.getElementById('send').disabled"),true);await capture("chat-disconnected");
  await click("retry");await wait("window.workbench.snapshot().then(v=>v.chatStatus.ready)");view=await snap();assert.equal(view.running,false);assert.equal(view.route.threadId,null);assert.equal(view.messages.some((m:{stale?:boolean})=>m.stale),true);
  await click("new");await wait("window.workbench.snapshot().then(v=>v.messages.length===0)");
  window.setSize(900,650);await wait("innerWidth===900");assert.equal(await js("document.documentElement.scrollWidth>innerWidth"),false);await capture("chat-narrow");assert.deepEqual(errors,[]);
  await writeFile(join(output,"smoke-results.json"),JSON.stringify({result:"passed",runKind:"offline-protocol-fixture",officialNativeExecuted:false,realModelRequests:0,checks:["explicit-offline-label","renderer-isolation","native-account-metadata-shape","email-omitted","server-catalog-selection","ui-ipc-host-jsonl-chain","confirmation-once","streamed-text","completed-terminal","draft-cleared-on-ack","refresh-current-thread-only","persistence-and-pagination-visible","interrupt-ack-not-terminal","interrupted-terminal","late-delta-ignored","failed-terminal","private-error-omitted","disconnect-unknown","no-auto-replay","new-persistent-route","narrow-layout","console-errors"],screenshots:["chat-ready","chat-streaming","chat-interrupted","chat-disconnected","chat-narrow"],consoleErrors:errors},null,2)+"\n");
}
