import Ajv from "ajv";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export type { InitializeResponse } from "../../codex-rs/app-server-protocol/schema/typescript/InitializeResponse.ts";
export type { ThreadReadParams } from "../../codex-rs/app-server-protocol/schema/typescript/v2/ThreadReadParams.ts";
export type { ThreadReadResponse } from "../../codex-rs/app-server-protocol/schema/typescript/v2/ThreadReadResponse.ts";
export type { Thread } from "../../codex-rs/app-server-protocol/schema/typescript/v2/Thread.ts";
export type { Turn } from "../../codex-rs/app-server-protocol/schema/typescript/v2/Turn.ts";
export type { ThreadItem } from "../../codex-rs/app-server-protocol/schema/typescript/v2/ThreadItem.ts";

export type { ThreadTurnsListParams } from "../../codex-rs/app-server-protocol/schema/typescript/v2/ThreadTurnsListParams.ts";
export type { ThreadTurnsListResponse } from "../../codex-rs/app-server-protocol/schema/typescript/v2/ThreadTurnsListResponse.ts";
export type { ThreadItemsListParams } from "../../codex-rs/app-server-protocol/schema/typescript/v2/ThreadItemsListParams.ts";
export type { ThreadItemsListResponse } from "../../codex-rs/app-server-protocol/schema/typescript/v2/ThreadItemsListResponse.ts";
export type { ThreadItemEntry } from "../../codex-rs/app-server-protocol/schema/typescript/v2/ThreadItemEntry.ts";

export type { GetAccountParams } from "../../codex-rs/app-server-protocol/schema/typescript/v2/GetAccountParams.ts";
export type { GetAccountResponse } from "../../codex-rs/app-server-protocol/schema/typescript/v2/GetAccountResponse.ts";
export type { ModelListParams } from "../../codex-rs/app-server-protocol/schema/typescript/v2/ModelListParams.ts";
export type { ModelListResponse } from "../../codex-rs/app-server-protocol/schema/typescript/v2/ModelListResponse.ts";

type MethodSpec = { params: string; result: string; experimental?: boolean };
type Manifest = {
  core: { repository: string; tag: string; commit: string };
  uiReference: { version: string; build: string; visualEvidence: string };
  client: { name: string; title: string; version: string };
  schemas: Record<string, { path: string; upstreamPath: string; sha256: string }>;
  requests: Record<string, MethodSpec>;
  notifications: Record<string, string>;
  serverRequests: Record<string, MethodSpec>;
  experimental: { enabled: boolean; implementedMethods: string[]; deferredFamilies: string[] };
};
const root = new URL("../", import.meta.url);
const manifest: Manifest = JSON.parse(readFileSync(new URL("contracts/manifest.json", root), "utf8"));
const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: false });
const validators = new Map(Object.entries(manifest.schemas).map(([key, entry]) => {
  const bytes = readFileSync(new URL(entry.path, root));
  if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error(`Contract hash mismatch: ${key}`);
  return [key, ajv.compile(JSON.parse(bytes.toString("utf8")))];
}));
export function validate(schema: string, value: unknown): void {
  const validator = validators.get(schema);
  if (!validator) throw new Error(`Unsupported schema: ${schema}`);
  if (!validator(value)) {
    // No payloads or schema error parameters in diagnostics: they may contain user content.
    throw new Error(`Invalid ${schema} payload at ${validator.errors?.[0]?.instancePath ?? "/"}`);
  }
}
export function contractManifest(): Manifest { return structuredClone(manifest); }

export type { ConfigReadParams } from "../../codex-rs/app-server-protocol/schema/typescript/v2/ConfigReadParams.ts";

export type { ConfigReadResponse } from "../../codex-rs/app-server-protocol/schema/typescript/v2/ConfigReadResponse.ts";
export type { ThreadStartParams } from "../../codex-rs/app-server-protocol/schema/typescript/v2/ThreadStartParams.ts";
export type { ThreadStartResponse } from "../../codex-rs/app-server-protocol/schema/typescript/v2/ThreadStartResponse.ts";
export type { TurnStartParams } from "../../codex-rs/app-server-protocol/schema/typescript/v2/TurnStartParams.ts";
export type { TurnStartResponse } from "../../codex-rs/app-server-protocol/schema/typescript/v2/TurnStartResponse.ts";
export type { TurnInterruptParams } from "../../codex-rs/app-server-protocol/schema/typescript/v2/TurnInterruptParams.ts";
export type { TurnInterruptResponse } from "../../codex-rs/app-server-protocol/schema/typescript/v2/TurnInterruptResponse.ts";
