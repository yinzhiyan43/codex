# Workbench protocol, host and synthetic desktop — M1.a/M1.b/M1.c/M1.d/M1.e

This package contains a local protocol engine, a stdio process host and an Electron desktop shell with restricted IPC. Default npm test checks are offline and launch only synthetic Node peers; they do not launch Codex, access credentials, open user files, use the network, or start a model turn. A trusted main process can supply a validated Codex launcher. An explicit isolated mode has now verified the installed official 0.162.1 binary for handshake, read errors and lifecycle; it does not log in or send model requests. See [the M1.b report](../docs/workbench/transport-milestone.md), [the M1.c desktop report](../docs/workbench/desktop-milestone.md), and [the M1.d pagination/approval report](../docs/workbench/pagination-milestone.md), plus [the M1.e real connection report](../docs/workbench/core-connection-milestone.md).

The core is pinned to `rust-v0.162.1` / `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`. UI reference `26.1007.30912` / build `20156` has partial user-supplied screenshot evidence. See [the full plan](../docs/workbench/implementation-plan.md) and [all 92 goals](../docs/workbench/acceptance-checklist.md). This unit does not complete M1, the UI, or the application.

## Development

Requires Node 26 or later, matching the existing local Node runtime. Dependencies are pinned and isolated in this package: Ajv for runtime schema validation, TypeScript and Node types for static checks. The root package/workspace/lockfiles are unchanged.

```sh
cd workbench
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm run check
```

`check` verifies copied contracts against the pinned Git commit, performs type checking, and runs only synthetic Node tests. It does not invoke upstream code. `contracts:sync` copies the existing upstream generated JSON files without compiling or running the core; it permits independent workbench commits on top of the baseline but refuses changes outside workbench/documentation or modified upstream schemas. `contracts:check` also rejects unexpected snapshot files. The schema files retain the upstream Apache-2.0 license (see [LICENSE](../LICENSE)); TypeScript types are type-only references to upstream exports within this fork.

## Implemented contract

- `connect()` queues one initialize request, using a distinct client name and `experimentalApi: false`. It returns an epoch and handshake promise. A valid response queues `initialized` and moves the protocol state to ready. Process starting/stopping is owned by `desktop-host/stdio-host.ts`.
- `readThread(params)`, `listTurns(params)` and `listItems(params)` are typed read-only APIs. Generic `request` applies the same allowlist: only `thread/read`, `thread/turns/list` and `thread/items/list` are supported. Invalid or unreviewed fields, unimplemented methods and all experimental methods are rejected before enqueue.
- `receive(bytes, epoch)` processes bounded JSONL data, including fragmented UTF-8. It separates client responses, server requests and notifications; numeric/string IDs and the two request directions are independent. Unsafe numeric IDs and ambiguous envelopes fail the connection.
- `snapshot()` projects thread/turn/item state. Final item text replaces streaming text; terminal turn state does not regress because of late starts/deltas. Identical text chunks are not deduplicated, because the protocol lacks delta sequence IDs. Exactly-once transport delivery is **not** assumed.
- Command/file approvals stay pending until an explicit `respondApproval(handle, decision)`. Supported decisions are only `accept`, `decline`, `cancel`. Sending moves to responded; `serverRequest/resolved` moves to resolved. Session/persistent policy amendments, user-input forms, permission approvals, dynamic tools and token refresh are not implemented. Unsupported server requests receive an error, with no local execution.
- Epoch-bound handles reject old connections and old approvals. Disconnect/timeout retract a still-queued request and report `not-sent`; frames already taken by the host have an `unknown` outcome. Recovery notices survive repeated disconnects, and stale projections are preserved. Reconnection performs only a new handshake: no task, approval, command or request is replayed automatically. `acknowledgeRecovery()` only dismisses local old notices; it does not send a decision, replay work, or mark any projection fresh.
- Recovery is explicit and bounded. A `thread/read` response cannot overwrite later notifications that arrived while the read was in flight. Metadata-only reads do not refresh stale items; only full item views refresh their returned turns. The legacy full-thread projection keeps missing turns stale. The desktop now reads metadata plus bounded turns/items pages through a separate history window; deprecated full-history hydration is not used by that flow. Composite thread/turn/item IDs retain message and DOM identity. Descending pages are reversed into chronological display order; overlapping records update in place. A complete new-generation reload prunes unrefreshed old records only after both cursors finish. Failed or cancelled page pairs never advance cursors; late results are ignored. Pagination is read-only and is not an execution replay.
- Diagnostic events are a bounded observation ring, not a durable event log; `eventsDropped` reports truncation. A caller must use snapshots rather than assuming that every diagnostic was retained. Diagnostics exclude raw payloads. Snapshot/approval values are cloned for callers.

Minimal protocol-only synthetic use (no transport or model task):

```ts
const session = new ProtocolSession();
const { epoch, initialized } = session.connect();
const frames = session.takeOutbound(); // feed to a synthetic peer
// Synthetic peer replies via session.receive(bytes, epoch).
await initialized;
```

## Limits and remaining work

Inbound/outbound frames, pending calls, server request IDs/bytes, recovery records/bytes, projection entities/bytes and diagnostic history have limits. Large valid batches are decoded incrementally, independent of host chunk boundaries. Resolved approvals clear their full parameters; bounded request hash tombstones remain until reconnect so duplicates cannot reopen an approval. The default 4096 server-ID budget is per connection; exhausting it fails closed and requires explicit reconnect. Recovery budgets are reserved before admitting work; if unresolved old notices exhaust them, explicit local acknowledgement is required before further requests. Over-budget or invalid known messages fail the connection; callers must inspect the diagnostic/state, then recover explicitly. Snapshots are display caches, not a complete persisted history or proof that an execution succeeded.

A production stdio launcher and lifecycle host are implemented with synthetic verification. A synthetic desktop UI and restricted IPC are present. No PTY bridge, official login, model catalog, turn/start, settings backend or durable data store is present. Pagination is implemented for the bounded synthetic desktop history; large real histories, all item renderers and streaming/paging integration remain unverified. Server-side user input, MCP/permissions and experiment support need separate reviewed contracts and tests. Native formats that JSON Schema describes only as strings (such as paths) are not semantically validated for OS access by this unit; a future host must validate before using them. The framework ADR is recorded; real binary compatibility, native integration, performance budgets, complete visual verification and remaining milestones remain open.

## Bounded history and approval UI

History cursors stay in the main process; renderer IPC accepts only the selected thread ID, load/cancel, and an opaque approval key with an allowed decision. History is limited to 128 turns, 512 items and 2 MiB per retained thread, with a 64-page cursor budget and 16 pending read batches. Cancellation immediately re-enables retry; each request owns its busy token so old cleanup cannot clear a newer request. Cache limits and cursor loops produce a retryable error without a partial page commit.

Approval cards are limited to 64. Canonical epoch-bound handles remain in the main process. Pending decisions move through waiting to server-resolved; a resolved request without a local decision is shown as unavailable, without inventing a timeout cause. Disconnected cards are disabled. Duplicate, old and wrong-route decisions cannot submit a new answer; no synthetic command or file change is executed.

## Synthetic desktop

```sh
npm run desktop
```

Opens our own local Electron window. Only the bundled synthetic peer is launched; sending produces a clearly labeled local demo response. No official app, account or model is contacted. New demo chats are in-memory and bounded to eight; quit clears the demo state.

```sh
npm run desktop:smoke -- /absolute/private/output-directory
```

Runs the same renderer in accessory/offscreen mode without showing a window, focusing it, or requesting Dock attention, saves synthetic screenshots and a result JSON, then exits. Startup has a 15-second limit; smoke has a 30-second limit. The M1.e check passed 114 offline synthetic tests and verified 25 schemas; the synthetic UI regression still passed 23 groups with zero console errors; native keyboard/IME/accessibility remain unverified. Build files stay in ignored `.desktop/`.

After a fresh `npm ci --ignore-scripts`, install the pinned official Electron runtime with `node node_modules/electron/install.js`. This may take time to download; it does not launch the Codex core. See [design QA](design-qa.md) and [desktop ADR](../docs/workbench/desktop-adr.md).

## Official core connection — explicit opt-in

```sh
npm run core:check
npm run desktop:core
npm run desktop:core:smoke -- /absolute/private/output-directory
```

These separate commands use the installed official npm darwin-arm64 0.162.1 native binary with a new empty HOME/CODEX_HOME, file credential storage, telemetry disabled, and a test-only child sandbox. The policy denies network, writes outside the run, and content reads from user storage roots; metadata/xattr and keychain lookup are restricted. It is not a complete filesystem content allowlist. Package layout/version/metadata and native --version are checked before launch; failures produce an error rather than a synthetic fallback. This mode cannot submit drafts, create threads, log in, browse existing history or send model requests. npm test remains synthetic only.

Native integration passed 6 tests; real UI passed 12 groups and startup-failure UI passed 5. Actual read/turns-list probes on a fixed nonexistent UUID return -32600; items-list returns -32601 (current default storage does not support it). Schema presence does not establish real pagination support, and logging in alone does not prove that support. The existing official ChatGPT login and one GPT text/interrupt smoke were subsequently verified. See the M1.e report for the first-run evidence limits and next desktop integration step.

### Native account and bounded model evidence

`npm run desktop:account` reuses the official CLI-managed login and displays sanitized account/catalog metadata after effective route validation. `npm run official:status` makes no model turns. One authorized GPT streaming/cancellation smoke was completed before finalization; it was not rerun. Final configuration guards disable MCP/notify/hooks for future model smoke runs using session overrides, without rewriting user config. See the M1.e report for missing first-run side-process/endpoint/ephemeral measurements and the zero-model final verification.
