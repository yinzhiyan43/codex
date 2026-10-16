import type { BrowserWindow } from "electron";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
/** Exercises only this app's synthetic document through its own webContents. */
export async function runDesktopSmoke(window: BrowserWindow, output: string, errors: string[], iconSize: { width: number; height: number }): Promise<void> {
  assert.deepEqual(iconSize, { width: 1254, height: 1254 });
  const js = (source: string) => window.webContents.executeJavaScript(source);
  const snapshot = () => js("window.workbench.snapshot()");
  const wait = async (predicate: string) => {
    for (let i = 0; i < 100; i++) { if (await js(predicate)) return; await new Promise(resolve => setTimeout(resolve, 25)); }
    throw new Error(`Smoke condition timed out: ${predicate}`);
  };
  const click = async (selector: string) => { await js(`document.querySelector(${JSON.stringify(selector)}).click()`); };
  const screenshot = async (name: string) => {
    // Resizing an offscreen surface can briefly make Chromium capture unavailable.
    for (let attempt = 0; attempt < 3; attempt++) {
      await js("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      try {
        const captured = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
        await writeFile(join(output, name + ".png"), captured.toPNG()); return;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "UnknownVizError" || attempt === 2) throw error;
        console.warn(`Offscreen capture retry: ${name}`);
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
  };
  await wait("document.getElementById('project-context').textContent === 'studio-demo'");
  assert.equal((await snapshot()).connection, "ready");
  await wait("document.getElementById('notice').hidden");
  assert.equal(await js("typeof require"), "undefined");
  assert.deepEqual(await js("Object.keys(window.workbench.preferences).sort()"), ["read", "update"]);
  assert.deepEqual(await js("Object.keys(window.workbench).sort()"), ["dispatch", "preferences", "snapshot", "subscribe"]);
  await screenshot("empty");
  await click('[data-thread="thread-welcome"]');
  await wait("document.querySelectorAll('.message').length === 4");

  await wait("document.querySelectorAll('.approval-card').length === 5");
  assert.equal((await snapshot()).approvals.some((card: object) => "epoch" in card || "params" in card || "handle" in card), false);
  await screenshot("approvals-pending");
  const acceptKey = (await snapshot()).approvals.find((card: { detail: string }) => card.detail.includes("accept-demo")).key;
  const approvalButton = (key: string, decision: string) => 'article[data-approval-key="' + key + '"] button[data-decision="' + decision + '"]';
  await js("document.querySelector(" + JSON.stringify(approvalButton(acceptKey, "accept")) + ").focus(); window.workbench.dispatch({type:'search',text:''})");
  assert.equal(await js("document.activeElement.dataset.approvalKey"), acceptKey);
  await click(approvalButton(acceptKey, "accept")); await click(approvalButton(acceptKey, "accept"));
  await wait("document.querySelector('article[data-approval-key=\"" + acceptKey + "\"]').dataset.approvalStatus === 'resolved'");
  const declineKey = (await snapshot()).approvals.find((card: { detail: string }) => card.detail.includes("decline-demo")).key;
  await click(approvalButton(declineKey, "decline"));
  await wait("document.querySelector('article[data-approval-key=\"" + declineKey + "\"]').dataset.approvalStatus === 'resolved'");
  const cancelKey = (await snapshot()).approvals.find((card: { kind: string; status: string }) => card.kind === "file" && card.status === "pending").key;
  await click(approvalButton(cancelKey, "cancel"));
  await wait("document.querySelector('article[data-approval-key=\"" + cancelKey + "\"]').dataset.approvalStatus === 'resolved'");
  await wait("document.querySelector('[data-approval-status=\"expired\"]') !== null");
  assert.equal(await js("[...document.querySelectorAll('[data-approval-status=\"expired\"] button')].every(button=>button.disabled)"), true);
  await screenshot("approvals-processed");
  const originalMessageIds = (await snapshot()).messages.map((message: { id: string }) => message.id);
  await js("window.__originalMessageNode = document.querySelector('#messages article')");
  await click("#load-history"); await wait("!document.getElementById('cancel-history').hidden"); await click("#cancel-history");
  await wait("!document.getElementById('load-history').disabled");
  assert.equal((await snapshot()).history.itemCount, 4);
  await screenshot("history-cancelled");
  const loadPage = async () => {
    await click("#load-history");
    await wait("window.workbench.snapshot().then(value=>value.history.busy)");
    await wait("window.workbench.snapshot().then(value=>!value.history.busy)");
  };
  for (let page = 0; page < 5 && (await snapshot()).history.hasMore; page++) await loadPage();
  const fullHistory = await snapshot();
  assert.equal(fullHistory.history.hasMore, false); assert.equal(fullHistory.messages.length, 10);
  assert.equal(new Set(fullHistory.messages.map((message: { id: string }) => message.id)).size, 10);
  assert.deepEqual(fullHistory.messages.slice(-4).map((message: { id: string }) => message.id), originalMessageIds);
  assert.equal(await js("window.__originalMessageNode.isConnected && [...document.querySelectorAll('#messages article')].includes(window.__originalMessageNode)"), true);
  await screenshot("history-paged");

  await click('#toggle-details'); await click('#account');
  await wait("!document.getElementById('details').hidden && !document.getElementById('account-menu').hidden");
  await screenshot("conversation");
  await click('#account-close'); await click('#toggle-details');
  await js("document.getElementById('draft').value='保留我的演示草稿'; document.getElementById('draft').dispatchEvent(new Event('input',{bubbles:true}))");
  await click('[data-project="project-garden"]');
  await wait("document.getElementById('project-context').textContent === 'garden-lab'");
  await click('[data-thread="thread-welcome"]');
  await wait("document.getElementById('draft').value === '保留我的演示草稿'");
  await click('[data-thread="thread-welcome"]'); await click('[data-thread="thread-welcome"]');
  await wait("document.querySelector('.loading') === null && !document.getElementById('conversation').hidden");
  assert.equal((await snapshot()).loading, false);
  await click('#send'); await wait("document.getElementById('confirm-dialog').open");
  await click('#cancel-confirm'); await wait("!document.getElementById('confirm-dialog').open");
  assert.equal((await snapshot()).draft, "保留我的演示草稿");
  await click('#send'); await wait("document.getElementById('confirm-dialog').open");
  await click('#confirm'); await click('#confirm');
  await wait("!document.getElementById('stop').hidden");
  await click('#stop'); await wait("document.getElementById('stop').hidden");
  assert.equal((await snapshot()).messages.filter((m: { status: string }) => m.status === "cancelled").length, 1);
  await click('#send'); await wait("document.getElementById('confirm-dialog').open"); await click('#confirm');
  await wait("document.getElementById('stop').hidden");
  assert.match((await snapshot()).messages.at(-1).text, /没有调用真实模型/);
  await screenshot("submitted");
  await click('#connection-menu'); await click('#disconnect');
  await wait("!document.getElementById('notice').hidden && document.getElementById('send').disabled");
  assert.equal((await snapshot()).stale, true);
  assert.equal(await js("document.querySelectorAll('[data-approval-status=\"disconnected\"] button').length > 0 && [...document.querySelectorAll('[data-approval-status=\"disconnected\"] button')].every(button=>button.disabled)"), true);
  await screenshot("disconnected");
  await click('#retry'); await click('#retry');
  await wait("window.workbench.snapshot().then(value=>value.connection==='ready' && !value.history.busy)");
  for (let page = 0; page < 5 && (await snapshot()).history.hasMore; page++) await loadPage();
  await wait("document.getElementById('notice').hidden");
  assert.equal((await snapshot()).connection, "ready");
  await click('#new'); await wait("!document.getElementById('empty').hidden");
  await click('#back'); await wait("!document.getElementById('conversation').hidden");
  await click('#toggle-search');
  await js("document.getElementById('search').value='不存在'; document.getElementById('search').dispatchEvent(new Event('input',{bubbles:true}))");
  await wait("document.querySelector('.search-empty') !== null");
  await js("document.getElementById('search').value=''; document.getElementById('search').dispatchEvent(new Event('input',{bubbles:true}))");
  await wait("document.querySelectorAll('[data-thread]').length >= 3");
  await click('#toggle-search');
  window.setSize(900, 650);
  await wait("innerWidth === 900");
  assert.equal(await js("document.documentElement.scrollWidth > innerWidth"), false);
  const visible = await js("(()=>{const r=document.getElementById('send').getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.bottom<=innerHeight})()");
  assert.equal(visible, true);
  await screenshot("narrow");
  window.setSize(1536, 894);
  await click('[data-project="project-studio"]');
  await wait("!document.getElementById('empty').hidden");
  await screenshot("empty-final");
  assert.deepEqual(errors, []);
  await writeFile(join(output, "smoke-results.json"), JSON.stringify({ result: "passed", checks: ["selected-app-icon", "ready-synthetic-peer", "renderer-isolation", "project-thread-navigation", "draft-preservation", "repeated-clicks", "confirm-return", "cancel-running", "complete-synthetic-response", "disconnect-stale", "explicit-reconnect", "new-back", "search-empty", "narrow-controls", "console-errors", "history-overlap-and-order", "stable-message-dom", "history-cancel", "approval-once", "approval-decline", "approval-cancel", "approval-expiry", "approval-disconnect"], selectedIcon: iconSize, screenshots: ["empty", "conversation", "submitted", "disconnected", "narrow", "empty-final", "approvals-pending", "approvals-processed", "history-cancelled", "history-paged"], consoleErrors: errors }, null, 2));
}
