import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { defaultUiPreferences, validateUiPreferences, validateUiPreferencesPatch, type UiPreferences } from "./ui-preferences-contract.ts";

/** Fixed host-owned path; no renderer paths or shared Codex configuration. */
export class UiPreferencesStore {
  #path: string;
  #state = defaultUiPreferences();
  #loaded = false;
  #tail: Promise<unknown> = Promise.resolve();
  constructor(path: string) { this.#path = path; }
  #enqueue<T>(run: () => Promise<T>): Promise<T> {
    const pending = this.#tail.then(run, run);
    this.#tail = pending.catch(() => {});
    return pending;
  }
  async #load(): Promise<void> {
    if (this.#loaded) return;
    try {
      const directory = await lstat(dirname(this.#path));
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("invalid-directory");
      const file = await open(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let text: string;
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 40 * 1024) throw new Error("invalid-file");
        text = await file.readFile("utf8");
        if (Buffer.byteLength(text) > 40 * 1024) throw new Error("invalid-file");
      } finally { await file.close(); }
      this.#state = validateUiPreferences(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("ui-preferences-unavailable");
    }
    this.#loaded = true;
  }
  read(): Promise<UiPreferences> {
    return this.#enqueue(async () => { await this.#load(); return structuredClone(this.#state); });
  }
  update(value: unknown): Promise<UiPreferences> {
    // Copy before queuing so the caller cannot mutate an accepted patch later.
    const patch = validateUiPreferencesPatch(value);
    return this.#enqueue(async () => {
      await this.#load();
      const next = validateUiPreferences({ ...this.#state, ...patch });
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      const directory = await lstat(dirname(this.#path));
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("ui-preferences-unavailable");
      try {
        const target = await lstat(this.#path);
        if (!target.isFile() || target.isSymbolicLink()) throw new Error("ui-preferences-unavailable");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const temp = join(dirname(this.#path), ".ui-preferences-" + randomUUID());
      try {
        const file = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        try { await file.writeFile(JSON.stringify(next) + "\n"); await file.sync(); } finally { await file.close(); }
        await rename(temp, this.#path);
        this.#state = next;
      } finally { await rm(temp, { force: true }); }
      return structuredClone(this.#state);
    });
  }
  settled(): Promise<unknown> { return this.#tail; }
}
