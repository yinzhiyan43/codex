import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, symlink, stat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UiPreferencesStore } from "../desktop-host/ui-preferences-store.ts";
import { defaultUiPreferences, validateUiPreferencesPatch } from "../desktop-host/ui-preferences-contract.ts";
import { sessionGroups } from "../domain/session-groups.ts";
import type { ManagedSession } from "../desktop-host/session-store.ts";
async function root(t: { after(fn: () => Promise<void>): void }) { const dir = await mkdtemp(join(tmpdir(), "workbench-ui-prefs-")); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test("UI preferences persist privately and serialize independent patches without lost updates", async t => {
  const dir = await root(t), path = join(dir, "ui-preferences.json"), store = new UiPreferencesStore(path);
  assert.deepEqual(await store.read(), defaultUiPreferences());
  const groups = ["official-chat"];
  const first = store.update({ collapsedGroups: groups }); groups.push("changed-later");
  await Promise.all([first, store.update({ sidebarWidth: 300 }), store.update({ fontSize: 16 }), store.update({ density: "compact" })]);
  const saved = await new UiPreferencesStore(path).read();
  assert.deepEqual(saved, { ...defaultUiPreferences(), collapsedGroups: ["official-chat"], sidebarWidth: 300, fontSize: 16, density: "compact" });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  saved.collapsedGroups.push("external-mutation"); assert.deepEqual((await store.read()).collapsedGroups, ["official-chat"]);
  assert.equal((await readFile(path, "utf8")).includes("model"), false);
});

test("UI preference boundary rejects config, paths, models, arbitrary keys and invalid sizes before writes", async t => {
  const dir = await root(t), path = join(dir, "ui-preferences.json"), store = new UiPreferencesStore(path);
  for (const patch of [null, [], {}, { config: {} }, { path: "/tmp/other" }, { model: "gpt-x" }, { reasoning: "high" }, { speed: "fast" }, { sidebarWidth: 9000 }, { sidebarVisible: "true" }, { density: "other" }, { fontSize: 0 }, { version: 2 }, { collapsedGroups: ["../other"] }, { collapsedGroups: ["x", "x"] }, { collapsedGroups: Array.from({ length: 513 }, (_, i) => "x" + i) }, JSON.parse('{"__proto__":{}}')]) assert.throws(() => validateUiPreferencesPatch(patch));
  await assert.rejects(readFile(path)); assert.deepEqual(await store.read(), defaultUiPreferences());
});

test("UI preferences preserve corrupt and newer files and reject symlinks/oversized files", async t => {
  const dir = await root(t), path = join(dir, "ui-preferences.json");
  for (const text of ["bad json", JSON.stringify({ ...defaultUiPreferences(), version: 3 }), JSON.stringify({ ...defaultUiPreferences(), unknown: true }), " ".repeat(41 * 1024)]) {
    await writeFile(path, text); const store = new UiPreferencesStore(path);
    await assert.rejects(store.read()); await assert.rejects(store.update({ fontSize: 14 }));
    assert.equal(await readFile(path, "utf8"), text);
  }
  await rm(path); const target = join(dir, "shared-config"); await writeFile(target, "untouched"); await symlink(target, path);
  await assert.rejects(new UiPreferencesStore(path).read()); await assert.rejects(new UiPreferencesStore(path).update({ fontSize: 14 })); assert.equal(await readFile(target, "utf8"), "untouched");
  const link = join(dir, "linked-root"); await symlink(dir, link); await assert.rejects(new UiPreferencesStore(join(link, "missing.json")).read());
});

test("UI preference write failure retains committed state and later retry succeeds", async t => {
  const dir = await root(t), path = join(dir, "ui-preferences.json"), store = new UiPreferencesStore(path);
  await store.update({ fontSize: 14 }); await rm(path); await mkdir(path);
  await assert.rejects(store.update({ fontSize: 16 })); assert.equal((await store.read()).fontSize, 14);
  await rm(path, { recursive: true }); await store.update({ fontSize: 16 }); assert.equal((await new UiPreferencesStore(path).read()).fontSize, 16);
});

test("group IDs survive record reorder, pinning and section rename; project rename resets only its group", () => {
  const row = (id: string, project: string, sectionId = "section-a"): ManagedSession => ({ id, title: "Synthetic", draft: "", model: null, pinned: false, unread: false, archived: false, ephemeral: false, localProject: project, sectionId, sectionName: "Original" });
  const a = row("saved-a", "Alpha"), b = row("saved-b", "Beta");
  const id = (rows: ManagedSession[], thread: string) => sessionGroups(rows).find(group => group.threads.some(t => t.id === thread))!.id;
  assert.equal(id([a, b], a.id), id([{ ...b, pinned: true }, { ...a, sectionName: "Renamed" }], a.id));
  assert.notEqual(id([a, b], a.id), id([{ ...a, localProject: "Renamed" }, b], a.id));
  assert.equal(id([a, b], b.id), id([{ ...a, localProject: "Renamed" }, b], b.id));
  assert.notEqual(id([a], a.id), id([{ ...a, sectionId: "section-b" }], a.id));
});
