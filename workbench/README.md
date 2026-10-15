# Workbench protocol, host and desktop — through M2.d

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
- `readThread(params)`, `readThreadMetadata(params)`, `listThreads(params)`, `listTurns(params)` and the synthetic adapter `listItems(params)` are typed read APIs. Generic `request` uses reviewed per-method field allowlists; the official chat also has narrowly validated configuration/account/catalog reads and text-only start/interrupt APIs. Saved metadata reads use the same thread/read schema and ID validation without retaining unrelated threads in the live projection. Invalid or unreviewed fields, unimplemented methods and all experimental methods are rejected before enqueue.
- `receive(bytes, epoch)` processes bounded JSONL data, including fragmented UTF-8. It separates client responses, server requests and notifications; numeric/string IDs and the two request directions are independent. Unsafe numeric IDs and ambiguous envelopes fail the connection.
- `snapshot()` projects thread/turn/item state. Final item text replaces streaming text; terminal turn state does not regress because of late starts/deltas. Identical text chunks are not deduplicated, because the protocol lacks delta sequence IDs. Exactly-once transport delivery is **not** assumed.
- Command/file approvals stay pending until an explicit `respondApproval(handle, decision)`. Supported decisions are only `accept`, `decline`, `cancel`. Sending moves to responded; `serverRequest/resolved` moves to resolved. Session/persistent policy amendments, user-input forms, permission approvals, dynamic tools and token refresh are not implemented. Unsupported server requests receive an error, with no local execution.
- Epoch-bound handles reject old connections and old approvals. Disconnect/timeout retract a still-queued request and report `not-sent`; frames already taken by the host have an `unknown` outcome. Recovery notices survive repeated disconnects, and stale projections are preserved. Reconnection performs only a new handshake: no task, approval, command or request is replayed automatically. `acknowledgeRecovery()` only dismisses local old notices; it does not send a decision, replay work, or mark any projection fresh.
- Recovery is explicit and bounded. A `thread/read` response cannot overwrite later notifications that arrived while the read was in flight. Metadata-only reads do not refresh stale items; only full item views refresh their returned turns. The legacy full-thread projection keeps missing turns stale. The synthetic desktop reads bounded turns/items fixtures through its history window; official saved browsing reads metadata plus actual full-turns server pages through a separate window; deprecated full-history hydration is not used by that flow. Composite thread/turn/item IDs retain message and DOM identity. Descending pages are reversed into chronological display order; overlapping records update in place. A complete new-generation reload prunes unrefreshed old records only after both cursors finish. Failed or cancelled page pairs never advance cursors; late results are ignored. Pagination is read-only and is not an execution replay.
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

A production stdio launcher and lifecycle host are implemented with synthetic verification. A synthetic desktop UI and restricted IPC are present. Official CLI login reuse, catalog and text-only start/interrupt are present; a workbench metadata/draft store is present; PTY and settings backend remain unimplemented. Official saved browsing uses server full-turns cursors validated with isolated synthetic native records; large real histories, all item renderers and actual native-history UI remain unverified. Server-side user input, MCP/permissions and experiment support need separate reviewed contracts and tests. Native formats that JSON Schema describes only as strings (such as paths) are not semantically validated for OS access by this unit; a future host must validate before using them. The framework ADR is recorded; real binary compatibility, native integration, performance budgets, complete visual verification and remaining milestones remain open.

## Bounded history and approval UI

History cursors stay in the main process; renderer IPC accepts only the selected thread ID, load/cancel, and an opaque approval key with an allowed decision. Synthetic history is limited to 128 turns, 512 items and 2 MiB per retained thread, with a 64-page cursor budget and 16 pending read batches. Cancellation immediately re-enables retry; each request owns its busy token so old cleanup cannot clear a newer request. Cache limits and cursor loops produce a retryable error without a partial page commit.

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

Native integration passed 6 tests; real UI passed 12 groups and startup-failure UI passed 5. Actual read/turns-list probes on a fixed nonexistent UUID return -32600; the earlier items-list probe returned -32601. Official diagnostics now display known-unavailable without requesting items-list again. Schema presence does not establish real pagination support, and logging in alone does not prove that support. The existing official ChatGPT login and one GPT text/interrupt smoke were subsequently verified. See the M1.e report for the first-run evidence limits and next desktop integration step.

### Native account and bounded model evidence

`npm run desktop:account` reuses the official CLI-managed login and displays sanitized account/catalog metadata after effective route validation. `npm run official:status` makes no model turns. One authorized GPT streaming/cancellation smoke was completed before finalization; it was not rerun. Final configuration guards disable MCP/notify/hooks for future model smoke runs using session overrides, without rewriting user config. See the M1.e report for missing first-run side-process/endpoint/ephemeral measurements and the zero-model final verification.

## Official text chat — M2.a

```sh
npm run desktop:chat
```

Uses the current official CLI-managed ChatGPT login and actual server model catalog. View the account using the lower-left button, select a GPT from the composer dropdown, type text, and confirm sending. Stop waits for the native interrupted terminal event; disconnect/reconnect never replays a turn. Switching accounts uses official `codex login`, then reconnect. This UI does not manage additional credentials or use local providers/API-key fallback.

New conversations default to persistent (ephemeral:false). The official core stores complete transcripts; the workbench saves IDs, drafts, model choices, pin/unread and titles. Restart reads history without execution; the next confirmed message resumes the same ID before sending one turn. Current and archived/unarchived history use metadata plus full-turns server cursors. Browsing remains read-only until “继续聊” activates a selected session; selection still sends no model request. Old ephemeral conversations retain only actually observed cache; unrecorded closed text cannot be recovered. Named external tool and agent/browser/computer configuration entries are disabled and checked using process overrides, with read-only/no-network turn permissions. This does not claim a universal upstream deny-all-tools mechanism.

`npm run desktop:chat:smoke -- /absolute/output-directory` is explicitly offline and uses a protocol fixture, never the Codex binary or a real model. M2.a validation was 31 schemas/131 offline tests. Current M2.d validation: 49 schemas, 197 offline tests, management App restart stages with 18 + 13 checks, persistence regression 14 + 18, history UI 26, chat UI 22 and base synthetic UI 23. Native saved-history proof used three isolated synthetic legacy files, including cursors and ephemeral metadata limits, with zero model requests; real user-history UI and model UI remain unverified. See [the M2.a report](../docs/workbench/official-chat-milestone.md) and [machine evidence](../docs/workbench/official-chat-results.json).

## Saved history — M2.b

Click “浏览历史会话” in the official chat sidebar. Choose a saved record, load older turns, refresh records/catalog, switch archived/unarchived views, continue the selected session, or return to current chat. Saved pages disable input, send and model selection. Only user/agent plain text is rendered; attachment/tool expansion remains unsupported. Archived records require restore before continuation.

`npm run desktop:history:smoke -- /absolute/output` runs the hidden offline renderer/IPC/host/schema chain only. `npm run history:core:check -- --result /absolute/result.json` is a separate explicit opt-in native probe with new empty HOME/CODEX_HOME, three synthetic legacy files and denied network, never real user history or model turns.

Saved display is bounded to 200 catalog rows/16 pages, 8 cached threads, 256 turns/64 pages/2MiB serialized normalized display cache per cache, and 4 in-flight reads. Hitting display capacity preserves cache and disables further paging until refresh. Core legacy turns paging still rebuilds the entire rollout each request; it bounds transfer rather than core CPU/memory. A single large full turn can exceed the 1MiB frame budget and require explicit reconnection. See [M2.b evidence and limits](../docs/workbench/history-milestone.md) and [results](../docs/workbench/history-results.json).

## Default persistence — M2.c

The real chat profile is `$appData/Codex Workbench` (on Mac, `~/Library/Application Support/Codex Workbench`). `sessions.json` saves workbench metadata/drafts with atomic 0600 writes; `core/state` is the official projection store; `core/chat-cwd` and `core/log` remain stable. Official full rollouts stay in the core's `CODEX_HOME` (normally `~/.codex/sessions`), outside sessions.json. Quit preserves these paths. Original official config is not rewritten; credentials are not copied.

The menu supports official rename/archive/unarchive and locally persisted pin/unread. M2.d now provides complete official forks, official section assignment and explicitly local project labels. Copy submenus and new windows remain disabled; share/delete open a non-executing explanation. Unknown archive outcomes stay locked until an explicit official unarchive ACK; fresh catalog pages cannot clear that uncertainty.

`npm run desktop:persistence:smoke -- /absolute/output` runs two hidden offline Apps with shared synthetic disk state to verify exact history/draft/title/pin restoration plus one confirmed same-ID continuation. `npm run persistence:core:check -- --result /absolute/result.json` is an explicit isolated native probe with synthetic paginated records and zero model turns. Real-account model-created history/UI restart remains untested.

See [M2.c menu mapping, evidence and limits](../docs/workbench/persistence-milestone.md) and [machine results](../docs/workbench/persistence-results.json). All 92 original goals and the selected Logo remain unchanged.

## Session management — M2.d

Use the saved-session context menu to fork a whole conversation, assign a local project label, or create/select an official section. Forking preserves the source body and draft, registers the official child ID, and opens it without a model call. A separate registered-forks history group keeps empty-preview forks discoverable after restart even while the upstream ordinary catalog filters them out. Confirmed sending then resumes and continues that same child ID.

Local project labels only organize this workbench; they do not call experimental official project APIs or change cwd/files. Sections use standard `threadSection/list`, `threadSection/create` and `thread/section/move`. Unknown submenus, branch-at-turn, section update/delete, sharing and deletion are not implemented. A sent fork cannot be remotely cancelled: “取消自动打开” preserves a returned child ID while leaving the source selected. Unknown responses are never retried automatically.

Server catalog storage stays bounded to 200 rows/16 pages. Registered forks are shown separately within the 512-record managed index, at most 712 deduplicated history rows total; body/cache budgets remain unchanged. Own metadata edits serialize with draft persistence and roll back on failed local writes. There is no distributed transaction with the official core; unknown created IDs cannot be invented or guaranteed recoverable.

`npm run desktop:management:smoke -- /absolute/output` verifies two hidden offline Apps. `npm run management:core:check -- --result /absolute/result.json` explicitly runs the pinned native core against synthetic records with denied network and zero model turns. See [M2.d evidence and capability map](../docs/workbench/session-management-milestone.md) and [machine results](../docs/workbench/session-management-results.json).
