import type { BrowserWindow } from "electron";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import type { OfflineFrame } from "./history-smoke.ts";
export async function runSettingsSmoke(main: BrowserWindow, output: string, errors: string[], phase: "write" | "restart", frames: () => OfflineFrame[], panes: () => BrowserWindow[], preferencePath: string): Promise<void> {
  const js = (source: string, pane = main) => pane.webContents.executeJavaScript(source);
  const snap = () => js("window.workbench.snapshot()"), prefs = () => js("window.workbench.preferences.read()"), click = (id: string) => js(`document.getElementById(${JSON.stringify(id)}).click()`);
  const wait = async (test: () => Promise<boolean>) => { for (let n = 0; n < 140; n++) { if (await test()) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error("Settings UI condition timed out"); };
  const dispatch = (command: unknown) => js("window.workbench.dispatch(" + JSON.stringify(command) + ")");
  const change = async (id: string, value: string) => { await js(`(()=>{const input=document.getElementById(${JSON.stringify(id)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('change',{bubbles:true}));})()`); await wait(async () => await js("document.getElementById('preferences-status').textContent==='已保存界面偏好。'")); };
  const capture = async (name: string) => { for (let n = 0; n < 3; n++) { await js("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))"); try { await writeFile(join(output, name + ".png"), (await main.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); return; } catch (error) { if (!(error instanceof Error) || error.message !== "UnknownVizError" || n === 2) throw error; } } };
  const checks = ["offline-synthetic-preferences"];
  await wait(async () => !!(await snap()).chatStatus?.ready && !await js("document.getElementById('toggle-sidebar').disabled"));
  if (phase === "write") {
    await click("workspace"); await wait(async () => !!(await snap()).chatStatus.historyMode && !(await snap()).loading);
    await dispatch({ type: "continueSession", id: "saved-z" });
    const before = await snap(), methodsBefore = frames().map(f => f.method);
    // Enter settings while the draft is still inside its debounce interval.
    await js("(()=>{const d=document.getElementById('draft');d.value='设置前尚未发送的合成草稿';d.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('open-settings').click();})()");
    await wait(async () => await js("document.getElementById('settings-dialog').open"));
    assert.equal((await snap()).draft, "设置前尚未发送的合成草稿"); assert.equal((await snap()).route.threadId, before.route.threadId); checks.push("opening-settings-flushes-pending-draft-and-preserves-route");
    await change("pref-sidebar-width", "300"); await change("pref-density", "compact"); await change("pref-font-size", "16");
    assert.equal(await js("Math.round(document.querySelector('.sidebar').getBoundingClientRect().width)"), 300);
    assert.equal(await js("getComputedStyle(document.getElementById('draft')).fontSize"), "16px");
    assert.equal(await js("getComputedStyle(document.querySelector('.thread-row')).height"), "27px"); checks.push("width-density-reading-size-affect-real-layout");
    assert.equal((await snap()).chatStatus.model, before.chatStatus.model); assert.equal((await snap()).pending, before.pending);
    assert.deepEqual(frames().map(f => f.method), methodsBefore); checks.push("ui-settings-do-not-call-core-or-change-model-pending");
    const saved = await prefs(); await rename(preferencePath, preferencePath + ".saved"); await mkdir(preferencePath);
    try {
      await js("(()=>{const p=document.getElementById('pref-font-size');p.value='14';p.dispatchEvent(new Event('change',{bubbles:true}));})()");
      await wait(async () => await js("document.getElementById('preferences-status').textContent.includes('保存失败')"));
      assert.equal(await js("document.getElementById('pref-font-size').value"), "16"); assert.deepEqual(await prefs(), saved); checks.push("write-failure-visible-and-values-rolled-back");
    } finally { await rm(preferencePath, { recursive: true }); await rename(preferencePath + ".saved", preferencePath); }
    await change("pref-font-size", "14"); await change("pref-font-size", "16"); checks.push("write-retry-succeeds");
    for (const patch of [{ model: "gpt-other" }, { speed: "fast" }, { path: "/tmp/forbidden" }, { sidebarWidth: 9999 }]) assert.equal(await js("window.workbench.preferences.update(" + JSON.stringify(patch) + ").then(()=>false,()=>true)"), true);
    checks.push("preload-preferences-reject-config-model-speed-path-and-invalid-input");
    await js("document.querySelector('[data-settings-section=capabilities]').click()");
    assert.equal(await js("document.querySelector('[data-settings-panel=capabilities]').querySelectorAll('input,select,button').length"), 0); checks.push("unsupported-capabilities-have-no-fake-controls");
    await js("document.querySelector('[data-settings-section=about]').click()"); assert.ok(await js("document.querySelector('[data-settings-panel=about]').textContent.includes('solrizon-ai')"));
    await js("document.querySelector('[data-settings-section=appearance]').click()"); await capture("settings-wide");
    await click("settings-close"); await wait(async () => await js("document.activeElement.id==='open-settings'"));
    await js("document.querySelector('[data-group=\"official-chat\"]').focus();document.querySelector('[data-group=\"official-chat\"]').click()"); await wait(async () => (await prefs()).collapsedGroups.includes("official-chat"));
    assert.equal(await js("document.querySelector('[data-group=\"official-chat\"]').getAttribute('aria-expanded')"), "false"); assert.equal(await js("document.activeElement.dataset.group"), "official-chat"); checks.push("group-collapse-persists-with-keyboard-focus");
    await click("toggle-search"); await js("(()=>{const s=document.getElementById('search');s.value='合成';s.dispatchEvent(new Event('input',{bubbles:true}));})()");
    assert.equal(await js("document.querySelector('[data-group=\"official-chat\"]').getAttribute('aria-expanded')"), "true");
    await js("(()=>{const s=document.getElementById('search');s.value='不存在';s.dispatchEvent(new Event('input',{bubbles:true}));})()"); assert.equal(await js("!!document.querySelector('.search-empty')"), true);
    await js("(()=>{const s=document.getElementById('search');s.value='';s.dispatchEvent(new Event('input',{bubbles:true}));})()"); assert.equal(await js("document.querySelector('[data-group=\"official-chat\"]').getAttribute('aria-expanded')"), "false"); checks.push("loaded-list-filter-reveals-collapsed-matches-without-changing-preference");
    await click("toggle-search"); await dispatch({ type: "openSessionWindow", id: "saved-a" }); await wait(async () => panes().length === 1);
    assert.equal(await js("typeof window.workbench.preferences", panes()[0]!), "undefined"); checks.push("read-only-preview-has-no-preference-bridge");
    await click("open-settings-toolbar"); await wait(async () => await js("document.getElementById('settings-dialog').open"));
    main.setSize(900, 650); await wait(async () => await js("innerWidth===900"));
    assert.equal(await js("document.documentElement.scrollWidth>innerWidth"), false);
    assert.equal(await js("document.querySelector('.settings-content').scrollWidth>document.querySelector('.settings-content').clientWidth"), false);
    assert.equal(await js("(()=>{const b=document.getElementById('settings-close').getBoundingClientRect();return b.top>=0&&b.bottom<=innerHeight})()"), true); await capture("settings-narrow"); checks.push("900px-settings-no-horizontal-overflow-and-return-visible");
    await click("settings-close"); await click("toggle-sidebar"); await wait(async () => !(await prefs()).sidebarVisible);
    await capture("sidebar-hidden"); assert.equal((await snap()).draft, "设置前尚未发送的合成草稿");
    assert.equal(frames().some(f => ["turn/start", "thread/resume"].includes(f.method ?? "")), false); checks.push("sidebar-hide-preserves-draft-no-send-resume");
  } else {
    const value = await prefs(); assert.equal(value.sidebarVisible, false); assert.equal(value.sidebarWidth, 300); assert.equal(value.density, "compact"); assert.equal(value.fontSize, 16); assert.ok(value.collapsedGroups.includes("official-chat"));
    assert.equal(await js("document.getElementById('app').classList.contains('sidebar-hidden')"), true); checks.push("all-ui-preferences-restored-after-app-restart");
    assert.equal((await snap()).draft, "设置前尚未发送的合成草稿"); assert.equal((await snap()).route.threadId, "saved-z"); checks.push("session-draft-and-route-restored-independently");
    await click("open-settings-toolbar"); await wait(async () => await js("document.getElementById('settings-dialog').open")); checks.push("settings-accessible-with-sidebar-hidden");
    await click("pref-expand-groups"); await wait(async () => (await prefs()).collapsedGroups.length === 0); checks.push("expand-all-works-after-restart");
    await click("pref-sidebar-visible"); await wait(async () => (await prefs()).sidebarVisible);
    await js("document.getElementById('settings-dialog').dispatchEvent(new Event('cancel',{cancelable:true}))");
    // Native Escape is checked through Electron's input path so the default close behavior runs.
    main.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" }); main.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await wait(async () => !await js("document.getElementById('settings-dialog').open")); checks.push("escape-closes-settings");
    assert.equal(frames().some(f => ["turn/start", "thread/resume"].includes(f.method ?? "")), false); checks.push("restart-and-settings-never-send-or-resume"); await capture("sidebar-restored");
  }
  assert.equal(frames().some(f => /config.*write|config.*set|account.*login|thread\/delete|thread\/share/.test(f.method ?? "")), false);
  assert.deepEqual(errors, []); checks.push("no-config-writes-share-delete-or-renderer-errors");
  await writeFile(join(output, "smoke-results.json"), JSON.stringify({ result: "passed", phase, runKind: "offline-sidebar-settings", officialNativeExecuted: false, realModelRequests: 0, checks, methods: frames().map(f => f.method).filter(Boolean), consoleErrors: errors }, null, 2) + "\n");
}
