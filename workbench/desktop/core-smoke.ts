import type { BrowserWindow } from "electron";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
/** Background-only integration with our renderer and the real, isolated native process. */
export async function runCoreSmoke(window: BrowserWindow, output: string, errors: string[], expectedFailure = false, accountMode = false): Promise<void> {
  const js = (source: string) => window.webContents.executeJavaScript(source);
  const snapshot = () => js("window.workbench.snapshot()");
  const wait = async (source: string) => {
    for (let i = 0; i < 100; i++) { if (await js(source)) return; await new Promise(resolve => setTimeout(resolve, 25)); }
    throw new Error("Official core UI condition timed out: " + source);
  };
  const click = (id: string) => js(`document.getElementById(${JSON.stringify(id)}).click()`);
  const capture = async (name: string) => {
    for (let i = 0; i < 3; i++) {
      await js("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      try { await writeFile(join(output, name + ".png"), (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); return; }
      catch (error) { if (!(error instanceof Error) || error.message !== "UnknownVizError" || i === 2) throw error; await new Promise(resolve => setTimeout(resolve, 150)); }
    }
  };
  if (expectedFailure) {
    await wait("!document.getElementById('notice').hidden && window.workbench.snapshot().then(view=>view.connection==='failed')");
    assert.equal((await snapshot()).coreStatus.handshake, false);
    assert.match(await js("document.getElementById('notice-text').textContent"), /官方核心连接未就绪/);
    assert.equal(await js("document.getElementById('probe-core').disabled && document.getElementById('send').disabled"), true);
    await capture("official-start-failed"); await click("retry");
    await wait("window.workbench.snapshot().then(view=>view.connection==='failed')");
    assert.deepEqual(errors, []);
    await writeFile(join(output, "smoke-results.json"), JSON.stringify({ result: "passed", mode: "official-isolated", scenario: "startup-failure", checks: ["failed-preflight-visible", "no-handshake-claim", "send-and-probe-disabled", "explicit-retry-failure", "console-errors"], screenshots: ["official-start-failed"], consoleErrors: errors }, null, 2)); return;
  }
  await wait("!document.getElementById('core-status').hidden && window.workbench.snapshot().then(view=>view.connection==='ready' && !view.coreStatus.checking)");
  let view = await snapshot(); assert.equal(view.mode, accountMode ? "official-account" : "official-isolated"); assert.equal(view.coreStatus.version, "0.162.1");
  if (accountMode) { assert.equal(view.coreStatus.authentication.type, "chatgpt"); assert.ok(view.coreStatus.models.length > 0); assert.ok(view.coreStatus.defaultModel.startsWith("gpt-")); assert.equal(Object.hasOwn(view.coreStatus.authentication, "email"), false); }
  assert.equal(view.coreStatus.handshake, true); assert.deepEqual(view.messages, []); assert.deepEqual(view.approvals, []);
  assert.equal(await js("['send','draft','new','account'].every(id=>document.getElementById(id).disabled)"), true);
  assert.match(await js("document.getElementById('mode-label').textContent"), /官方核心/);
  assert.equal(await js("typeof require"), "undefined"); await capture("official-ready");
  await click("probe-core"); await wait("document.querySelectorAll('#core-results li').length===3 && !document.getElementById('probe-core').disabled");
  view = await snapshot(); assert.deepEqual(view.coreStatus.probes.map((row: { code: string }) => row.code), ["rpc-error:-32600", "rpc-error:-32600", "rpc-error:-32601"]);
  assert.match(await js("document.getElementById('core-results').textContent"), /当前服务实现不支持/);
  await capture("official-read-errors");
  const generation = view.coreStatus.generation;
  await click("connection-menu"); await click("disconnect");
  await wait("window.workbench.snapshot().then(view=>view.connection==='stopped')");
  assert.equal((await snapshot()).coreStatus.handshake, false); assert.equal(await js("document.getElementById('probe-core').disabled"), true);
  await capture("official-stopped"); await click("retry");
  await wait("window.workbench.snapshot().then(view=>view.connection==='ready' && !view.coreStatus.checking)");
  assert.ok((await snapshot()).coreStatus.generation > generation);
  assert.deepEqual((await snapshot()).coreStatus.probes, []);
  assert.equal(await js("document.getElementById('send').disabled"), true);
  await capture("official-reconnected");
  window.setSize(900, 650); await wait("innerWidth===900");
  assert.equal(await js("document.documentElement.scrollWidth > innerWidth"), false); await capture("official-narrow");
  assert.deepEqual(errors, []);
  await writeFile(join(output, "smoke-results.json"), JSON.stringify({ result: "passed", mode: accountMode ? "official-account" : "official-isolated", coreVersion: "0.162.1", checks: [...(accountMode ? ["native-chatgpt-login-reuse", "official-model-catalog", "account-email-omitted"] : []), "actual-native-handshake", "mode-separated", "no-fixture-messages", "submissions-disabled", "renderer-isolation", "actual-read-errors", "unsupported-items-visible", "actual-process-stop", "explicit-new-generation", "no-automatic-read-replay", "narrow-layout", "console-errors"], screenshots: ["official-ready", "official-read-errors", "official-stopped", "official-reconnected", "official-narrow"], consoleErrors: errors }, null, 2));
}
