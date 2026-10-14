import type { BrowserWindow } from "electron";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
export type OfflineFrame = { method?: string; params?: Record<string, unknown> };
/** Hidden renderer/IPC/host/schema regression using only the offline peer. */
export async function runHistorySmoke(window: BrowserWindow, output: string, errors: string[], frames: () => OfflineFrame[]): Promise<void> {
  const js = (source: string) => window.webContents.executeJavaScript(source);
  const snap = () => js("window.workbench.snapshot()");
  const wait = async (source: string) => { for (let n=0;n<200;n++) { if(await js(source))return;await new Promise(resolve=>setTimeout(resolve,25)); }throw new Error("History UI condition timed out: "+source); };
  const click = (id: string) => js(`document.getElementById(${JSON.stringify(id)}).click()`);
  const select = (id: string) => js(`document.querySelector('[data-thread="${id}"]').click()`);
  const draft = (text: string) => js(`(()=>{const d=document.getElementById('draft');d.value=${JSON.stringify(text)};d.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const capture = async (name: string) => { for(let n=0;n<3;n++){await js("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");try{await writeFile(join(output,name+".png"),(await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());return;}catch(error){if(!(error instanceof Error)||error.message!=="UnknownVizError"||n===2)throw error;await new Promise(resolve=>setTimeout(resolve,150));}} };
  await wait("window.workbench.snapshot().then(v=>v.chatStatus?.ready)");
  assert.equal((await snap()).chatStatus.offline,true);assert.match(await js("document.getElementById('mode-label').textContent"),/离线合成验证/);assert.equal(await js("typeof require"),"undefined");
  // One OFFLINE fake response establishes a current conversation; zero native/model calls.
  await draft("合成当前会话保留验证");await click("send");await wait("document.getElementById('confirm-dialog').open");await click("confirm");
  await wait("window.workbench.snapshot().then(v=>!v.running&&v.messages.some(m=>m.status==='completed'))");
  const current=await snap();assert.equal(frames().filter(f=>f.method==="turn/start").length,1);assert.equal(frames().find(f=>f.method==="thread/start")!.params!.ephemeral,true);
  await click("load-history");await wait("window.workbench.snapshot().then(v=>!v.loading)");assert.match((await snap()).history.notice,/正文保留已观察缓存/);
  const metadataRead=frames().filter(f=>f.method==="thread/read").at(-1)!;assert.equal(metadataRead.params!.includeTurns,false);
  await draft("原聊天未发送草稿");await click("workspace");
  await wait("window.workbench.snapshot().then(v=>v.chatStatus.historyMode&&!v.loading&&v.historyBrowser.rows.length===2)");
  assert.equal(await js("document.getElementById('draft').disabled && document.getElementById('send').disabled && document.getElementById('model-choice').disabled"),true);
  assert.match(await js("document.getElementById('chat-summary').textContent"),/不恢复执行、不调用模型/);
  await click("more-threads");await wait("window.workbench.snapshot().then(v=>!v.loading&&v.historyBrowser.rows.length===4)");
  assert.deepEqual((await snap()).historyBrowser.rows.map((r:{id:string})=>r.id),["saved-z","saved-a","saved-b","saved-c"]);assert.equal(await js("document.querySelectorAll('[data-thread]').length"),4);
  await select("saved-z");await wait("window.workbench.snapshot().then(v=>v.route.threadId==='saved-z'&&v.history.loading)");
  await select("saved-a");await wait("window.workbench.snapshot().then(v=>v.route.threadId==='saved-a'&&!v.loading)");
  await new Promise(resolve=>setTimeout(resolve,450));assert.ok((await snap()).messages.every((m:{text:string})=>m.text.includes("历史A")));
  await select("saved-z");await wait("window.workbench.snapshot().then(v=>!v.loading&&v.route.threadId==='saved-z'&&v.messages.length===4)");
  assert.deepEqual((await snap()).messages.map((m:{text:string})=>m.text),["合成历史Z 用户 2","合成历史Z 回应 2","合成历史Z 用户 3","合成历史Z 回应 3"]);
  await js("window.__historyLast=document.querySelector('#messages article:last-of-type')");await click("load-history");await wait("window.workbench.snapshot().then(v=>!v.loading&&v.history.turnCount===3)");
  assert.equal((await snap()).messages.length,6);assert.match((await snap()).messages[0].text,/用户 1/);assert.equal(await js("window.__historyLast===document.querySelector('#messages article:last-of-type')"),true);
  assert.equal(await js("document.getElementById('load-history').disabled"),true);assert.equal(JSON.stringify(await snap()).includes("private-never-in-renderer"),false);await capture("history-paged");
  await select("saved-c");await wait("window.workbench.snapshot().then(v=>v.route.threadId==='saved-c'&&!v.loading)");await click("refresh-threads");await wait("window.workbench.snapshot().then(v=>!v.loading&&v.historyBrowser.rows.length===2)");
  assert.equal((await snap()).title,"合成历史C");await click("refresh-saved-history");await wait("window.workbench.snapshot().then(v=>!v.loading&&!v.history.stale)");assert.equal((await snap()).route.threadId,"saved-c");
  await select("saved-z");await wait("window.workbench.snapshot().then(v=>v.history.loading)");await click("cancel-history");
  await wait("window.workbench.snapshot().then(v=>!v.history.loading&&v.history.stale)");await new Promise(resolve=>setTimeout(resolve,450));assert.equal((await snap()).history.stale,true);
  await click("refresh-saved-history");await wait("window.workbench.snapshot().then(v=>!v.loading&&!v.history.stale)");
  await click("connection-menu");await click("disconnect");await wait("window.workbench.snapshot().then(v=>v.connection!=='ready')");assert.equal((await snap()).history.stale,true);await capture("history-disconnected");
  const reads=frames().filter(f=>f.method==="thread/turns/list").length;await click("retry");await wait("window.workbench.snapshot().then(v=>v.chatStatus.ready)");
  assert.equal(frames().filter(f=>f.method==="thread/turns/list").length,reads);assert.equal((await snap()).history.stale,true);await click("refresh-saved-history");await wait("window.workbench.snapshot().then(v=>!v.loading&&!v.history.stale)");
  await click("return-chat");await wait("window.workbench.snapshot().then(v=>!v.chatStatus.historyMode)");assert.equal((await snap()).draft,"原聊天未发送草稿");assert.deepEqual((await snap()).messages.map((m:{text:string})=>m.text),current.messages.map((m:{text:string})=>m.text));
  // Reconnect intentionally resets the current ephemeral route, preserving observed cached text.
  assert.equal((await snap()).route.threadId,null);assert.ok((await snap()).messages.every((m:{stale:boolean})=>m.stale));
  await click("workspace");await wait("window.workbench.snapshot().then(v=>v.chatStatus.historyMode&&!v.loading)");await select("saved-z");await wait("window.workbench.snapshot().then(v=>v.history.loading)");await click("return-chat");
  await wait("window.workbench.snapshot().then(v=>!v.chatStatus.historyMode&&!v.loading)");assert.equal((await snap()).draft,"原聊天未发送草稿");assert.equal((await snap()).route.threadId,null);
  await click("workspace");await wait("window.workbench.snapshot().then(v=>v.chatStatus.historyMode&&!v.loading)");await select("saved-a");await wait("window.workbench.snapshot().then(v=>!v.loading&&v.route.threadId==='saved-a')");
  window.setSize(900,650);await wait("innerWidth===900");assert.equal(await js("document.documentElement.scrollWidth>innerWidth"),false);
  assert.equal(await js("(()=>{const r=document.getElementById('return-chat').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()"),true);await capture("history-narrow");
  const observed=frames();assert.equal(observed.some(f=>["thread/resume","thread/items/list"].includes(f.method ?? "")),false);assert.equal(observed.filter(f=>f.method==="turn/start").length,1);assert.ok(observed.filter(f=>f.method==="thread/turns/list").every(f=>f.params!.itemsView==="full"));assert.deepEqual(errors,[]);
  await writeFile(join(output,"smoke-results.json"),JSON.stringify({result:"passed",runKind:"offline-history-protocol-fixture",officialNativeExecuted:false,realModelRequests:0,offlineFakeTurns:1,checks:["explicit-offline-label","renderer-isolation","ephemeral-choice-retained","current-refresh-metadata-only","temporary-body-limit-visible","server-list-cursor","overlap-row-dedup","read-only-composer-model-send","history-execution-boundary","selected-late-response-ignored","full-turn-server-pagination","chronology-with-equal-times","overlap-turn-item-dedup","stable-message-dom","terminal-page-button-disabled","raw-path-omitted","catalog-refresh-keeps-selection","explicit-record-refresh","cancel-keeps-stale-cache","disconnect-cache","reconnect-no-auto-read-replay","return-retains-draft-and-text","late-page-after-return-ignored","no-resume-or-items-rpc","narrow-layout-controls","console-errors"],screenshots:["history-paged","history-disconnected","history-narrow"],methods:observed.map(f=>f.method).filter(Boolean),consoleErrors:errors},null,2)+"\n");
}
