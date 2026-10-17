# Workbench protocol, host and desktop — through M3.b tool workflow interactions

This package contains a local protocol engine, a stdio process host and an Electron desktop shell with restricted IPC. The full npm test target includes native repository-helper and disposable Git/worktree checks; it does not launch Codex or start a model turn. For pure protocol/state and Node fake-peer checks without native repository/worktree/UI tests, use `npm run coding:simulation:check`. A trusted main process can supply a validated Codex launcher. An explicit isolated mode has now verified the installed official 0.162.1 binary for handshake, read errors and lifecycle; it does not log in or send model requests. See [the M1.b report](../docs/workbench/transport-milestone.md), [the M1.c desktop report](../docs/workbench/desktop-milestone.md), and [the M1.d pagination/approval report](../docs/workbench/pagination-milestone.md), plus [the M1.e real connection report](../docs/workbench/core-connection-milestone.md).

The core is pinned to `rust-v0.162.1` / `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`. UI reference `26.1007.30912` / build `20156` has partial user-supplied screenshot evidence. See [the full plan](../docs/workbench/implementation-plan.md) and [all 92 goals](../docs/workbench/acceptance-checklist.md). This unit does not complete M1, the UI, or the application.

## Development

Requires Node 26 or later, matching the existing local Node runtime. Dependencies are pinned and isolated in this package: Ajv for runtime schema validation, TypeScript and Node types for static checks. The root package/workspace/lockfiles are unchanged.

```sh
cd workbench
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm run check
```

`check` verifies copied contracts against the pinned Git commit, performs type checking, and runs the full test target including native repository-helper and disposable Git/worktree checks. It does not invoke the official Codex core. `contracts:sync` copies the existing upstream generated JSON files without compiling or running the core; it permits independent workbench commits on top of the baseline but refuses changes outside workbench/documentation or modified upstream schemas. `contracts:check` also rejects unexpected snapshot files. The schema files retain the upstream Apache-2.0 license (see [LICENSE](../LICENSE)); TypeScript types are type-only references to upstream exports within this fork.

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

The menu supports official rename/archive/unarchive and locally persisted pin/unread. M2.d now provides complete official forks, official section assignment and explicitly local project labels. Unknown copy submenus remain unavailable; saved-text copying and read-only session windows are available in M2.f/M2.g; share/delete open a non-executing explanation. Unknown archive outcomes stay locked until an explicit official unarchive ACK; fresh catalog pages cannot clear that uncertainty.

`npm run desktop:persistence:smoke -- /absolute/output` runs two hidden offline Apps with shared synthetic disk state to verify exact history/draft/title/pin restoration plus one confirmed same-ID continuation. `npm run persistence:core:check -- --result /absolute/result.json` is an explicit isolated native probe with synthetic paginated records and zero model turns. Real-account model-created history/UI restart remains untested.

See [M2.c menu mapping, evidence and limits](../docs/workbench/persistence-milestone.md) and [machine results](../docs/workbench/persistence-results.json). All 92 original goals and the selected Logo remain unchanged.

## Session management — M2.d

Use the saved-session context menu to fork a whole conversation, assign a local project label, or create/select an official section. Forking preserves the source body and draft, registers the official child ID, and opens it without a model call. A separate registered-forks history group keeps empty-preview forks discoverable after restart even while the upstream ordinary catalog filters them out. Confirmed sending then resumes and continues that same child ID.

Local project labels only organize this workbench; they do not call experimental official project APIs or change cwd/files. Sections use standard `threadSection/list`, `threadSection/create` and `thread/section/move`. Unknown submenus, branch-at-turn, section update/delete, sharing and deletion are not implemented. A sent fork cannot be remotely cancelled: “取消自动打开” preserves a returned child ID while leaving the source selected. Unknown responses are never retried automatically.

Server catalog storage stays bounded to 200 rows/16 pages. Registered forks are shown separately within the 512-record managed index, at most 712 deduplicated history rows total; body/cache budgets remain unchanged. Own metadata edits serialize with draft persistence and roll back on failed local writes. There is no distributed transaction with the official core; unknown created IDs cannot be invented or guaranteed recoverable.

`npm run desktop:management:smoke -- /absolute/output` verifies two hidden offline Apps. `npm run management:core:check -- --result /absolute/result.json` explicitly runs the pinned native core against synthetic records with denied network and zero model turns. See [M2.d evidence and capability map](../docs/workbench/session-management-milestone.md) and [machine results](../docs/workbench/session-management-results.json).

## Saved-turn forks and organization editing — M2.e

Loaded terminal saved turns offer an inclusive fork confirmation using standard `lastTurnId`; later turns are excluded and source drafts remain independent. Official sections support rename with appearance omitted/preserved and verified `beforeThreadId`/append ordering. Anchors require a complete scan within 200 members/16 pages; duplicate members/cursor conflicts fail without importing order. Section pages are not a server snapshot during external concurrent reorders. Sidebar local pins take priority over the observed section order.

Local project labels can be renamed across every matching record, including archived records, with collision refusal and atomic rollback. These labels do not create official projects or change cwd.

Current validation: 51 schemas, 211 offline tests; editing hidden-App restart checks 14 + 10, management regression 18 + 13, isolated native two-process synthetic proof, zero new real model requests. `npm run desktop:editing:smoke -- /absolute/private/output` and `npm run editing:core:check -- --result /absolute/result.json` reproduce the explicit checks. See [M2.e report](../docs/workbench/session-editing-milestone.md) and [machine results](../docs/workbench/session-editing-results.json). The sanitized M2.d base b15bd57 was pushed as authorized; M2.e changes remain a local commit.

## Concurrent edits and saved-text copy — M2.f

Observed section names, membership and full destination order are checked again before edits; stale changes abort without replacement RPCs. Conversation rename also rejects an externally changed visible name. Post-write reads verify observed results, and obsolete operations cannot clear a newer generation’s state. The official APIs have no CAS or cross-page snapshot: an external update after final validation cannot be atomically excluded.

“复制已保存文字” confirms the selected known persistent ID, reads all bounded saved text twice, validates terminal state and matching fingerprints, then invokes the main-process clipboard writer once. It preserves source drafts/history/paging, aborts rather than copying partial text, and never replays on restart. Limits remain 256 turns/64 pages/2 MiB. Attachments, tools and unsent drafts are excluded. Tests use a memory clipboard and never inspect the system clipboard.

Validation: 51 schemas, 225 offline tests; new hidden-App checks 14+9, editing regression 14+10, management 18+13; two concurrent isolated native clients plus reconnect, zero model requests, and independent Sol xhigh final 25/25. Use `npm run desktop:copy:smoke -- /absolute/private/output` and explicit `npm run concurrency:core:check -- --result /absolute/result.json`. See [M2.f report](../docs/workbench/concurrency-copy-milestone.md) and [machine results](../docs/workbench/concurrency-copy-results.json). This increment is a local commit only; new-window opening remains deferred.

## Read-only saved-session windows — M2.g

“在新窗口中打开” opens a fixed known persistent ID in a read-only BrowserWindow. A repeated ID focuses the existing preview; at most four distinct previews exist. The main controller alone owns drafts, confirmation, sending, persistence and the shared core. Preview IPC accepts only refresh, same-ID older turns, read cancellation and error dismissal, with separate channels/preload and exact sender/main-frame/URL checks.

Preview caches/pagination are independent. Their shared four read leases include closed windows’ outstanding requests; the primary window retains its own budget. Main-confirmed names/archive states synchronize. A disconnect marks caches stale; ready broadcasts enable explicit Refresh without automatic reads. Closing a preview never stops the core. Closing the primary saves its draft, destroys previews and disposes the shared host; restart restores the main conversation only, and previews are reopened explicitly.

Validation: 51 schemas, 232 offline tests, hidden multiwindow checks 17+6 plus 78 prior UI regressions, close ledgers 5/5 and 1/1 with no active windows/reads/core after primary exit, and independent Sol xhigh 7/7. No new native-core or real-model requests. Use `npm run desktop:window:smoke -- /absolute/private/output`. See [M2.g report](../docs/workbench/session-window-milestone.md) and [results](../docs/workbench/session-window-results.json). Editable multiwindow drafts/sends, window topology restoration, real-core multiwindow integration and native multi-screen/accessibility remain unverified. This increment is a local commit only.


## Sidebar and workbench settings — M2.h

Selected layout from [solrizon-ai/open-codex](https://github.com/solrizon-ai/open-codex/tree/3362b6bb790cb70485c026d39768e41affc2ce9b) is adapted to the existing DOM frontend: collapsible groups, scrollable session list with a fixed settings footer, and a settings modal with navigation and grouped rows. No new runtime dependencies. The full Apache-2.0 [license and attribution](vendor/open-codex/NOTICE.md) are retained in source and copied into the local build.

Preferences support sidebar visibility/width, list density, reading size and group expansion. A separate private `ui-preferences.json` uses bounded validated patches and serialized atomic writes; failures retain the last committed values. Only the primary preload exposes `preferences.read/update`, with the same owner/frame/URL admission checks as existing commands. Read-only previews have no such bridge. Settings preserve pending drafts, chat routes, models and send confirmations; shared Codex config, account/security settings, task model/reasoning/speed and upstream core are untouched. Local project rename resets that group's expansion because labels have no independent identity.

The search field filters only loaded group names and session titles. Unsupported configuration and service capabilities are explanations without interactive placeholders. Full server search, themes and complete settings parity remain open.

Validation: 51 schemas, 237 offline tests, new settings hidden UI 14+8, prior multiwindow/copy/editing/management 101, and synthetic desktop 23 (146 UI checks total); independent Sol xhigh review found no reproducible P1/P2. No real model/native core execution. Run `npm run desktop:settings:smoke -- /absolute/private/output`. See [report](../docs/workbench/sidebar-settings-milestone.md) and [results](../docs/workbench/sidebar-settings-results.json). This increment is local only; no push.


## Real official core and desktop validation — M2.i

The unchanged pushed product baseline `a688598b6` was exercised with the existing official ChatGPT login and isolated synthetic test sessions. Five real model requests produced four completed turns and one interrupted turn. Per-path assertions covered send/stop, saved body and draft after restart, same-ID continuation, one inclusive saved-turn fork and continuation on its returned child, and primary/read-only-preview names, saved bodies and draft isolation. Existing model/reasoning/service-tier settings were inherited; no shared configuration write or new API service was introduced.

This was a recovered test sequence, not one clean end-to-end run: the restart driver passed its body/draft and continuation assertions, then failed reading its own non-atomic ledger. A later fork-only recovery used the already acknowledged child ID and passed the remaining checks without repeating the fork or earlier successful messages. The report retains the failed stage and the initial read-only preflight isolation caveat. Runtime product code was not changed, prior 237 offline/146 synthetic UI checks were not newly rerun, and only redacted documentation is committed locally this round. See the [real integration report](../docs/workbench/real-core-ui-milestone.md) and [per-path evidence](../docs/workbench/real-core-ui-results.json). Manual native input/accessibility, default user profile, large history and exceptional network/quota behavior remain unverified.


## Keyboard and basic accessibility — M2.l

Session menus support Shift+F10/ContextMenu, arrows, Home/End and Escape; settings use a vertical tablist. Shared dialog handling preserves opening controls across asynchronous reads and DOM refreshes, wraps Tab at modal boundaries, and avoids stealing focus from later actions. Explicit labels, atomic statuses, keyboard scroll regions and skip links retain the exact trusted IPC page URL. Search shortcuts preserve their original focus; stale results return focus to the query.

Composition lifecycle, isComposing, legacy 229 and a short trailing-key guard prevent IME Enter/Escape from sending, searching or dismissing dialogs. Only plain Enter opens send confirmation; explicit pointer submission immediately after composition remains accepted. No new IPC authority, model requests or shared configuration writes.

Validation: 257 offline checks, 24 keyboard/accessibility hidden checks and 185 existing UI regressions (209 total), with no remaining confirmed P1/P2 in independent review. Keyboard/IME/Tab handlers are simulated; native Electron Escape and Chromium accessibility-tree checks are separate. Actual Chinese IME, native Tab traversal and OS VoiceOver remain unaccepted. Run `npm run desktop:keyboard:smoke -- /absolute/private/output`. See the [M2.l report](../docs/workbench/keyboard-accessibility-milestone.md) and [results](../docs/workbench/keyboard-accessibility-results.json) for retry history and validation boundaries. This stage is local only; the remote development branch remains at `231f3aa4ba2b337e1a6a9f46cd8493b397fb1722`.

## Editable multiwindow and delivery recovery — M2.m

Fixed-session previews start read-only. Explicitly claim a session lease to edit; release it before moving that session to another window. Draft writes bind the exact window, session, lease and durable revision. Different sessions retain independent drafts; one global gate admits one confirmation/turn at a time. Same-session observers see generation and may stop it; confirmation belongs to the sender. Normal close awaits every renderer's exact durable proof and keeps windows open on failure. Closing only a generating secondary window retains its runtime until terminal.

Before `turn/start`, the workbench atomically records the pending delivery. A receipt atomically clears that record and the matching sent draft before terminal. Unknown results survive restart and block sending. Explicit main-window reconciliation reads metadata and up to 20 full saved turns; only positive text evidence after the recorded boundary clears it. Missing evidence remains locked. A storage retry cannot clear an unknown execution gate. The official protocol has no cross-client CAS/idempotency; identical text from another client cannot establish request ownership.

Validation: 280 offline checks, 34 new hidden-window checks and all 209 existing regressions (243 total). All new runs are synthetic, with zero real model requests. Actual Chinese IME, native Tab/VoiceOver and multiple displays remain unaccepted. Run `npm run desktop:editable:smoke -- /absolute/private/output`. See [daily use](../docs/workbench/daily-use.md), [the report](../docs/workbench/multiwindow-editing-milestone.md) and [machine results](../docs/workbench/multiwindow-editing-results.json). Local commit only; the original 92 goals, core, Logo, shared config and public remote remain unchanged.

## Explicit repository context and read-only inspection — M3.a

Main and fixed-session windows offer an explicit native folder picker, a bounded directory/text viewer, and sandboxed staged/worktree Git diffs. Existing sessions preserve their official cwd and directory device/inode identity; new threads use the chosen cwd and forks inherit the verified source. Grants persist in the private session store. File contents stay local to each view and are never attached to model input automatically.

The local broker opens each path component relative to the granted root with openat/O_NOFOLLOW. Listings stop at200 entries, UTF-8 text at256 KiB, and helper processes at4 seconds/512 KiB output with4 total in flight. Fixed system Git runs under a macOS sandbox with network, writes and other executables denied; external diff/textconv/fsmonitor/hooks are disabled. Unsupported Git layouts fail closed. This is a local folder grant, not the experimental official project service. No editing, terminal, automatic scan, arbitrary RPC or tool execution is added.

Node26, installed dependencies and Xcode command-line tools are required to build the native helper; nothing is installed automatically. Run `npm run desktop:repository:smoke -- /absolute/private/output` for temporary synthetic-root checks. See [the report](../docs/workbench/repository-context-milestone.md), [machine results](../docs/workbench/repository-context-results.json) and [daily use](../docs/workbench/daily-use.md). The original92 goals retain their IDs and remaining scope. Local commit only; no push, real model request or shared configuration change.

## Tool activity, one-shot approvals and supplemental input — M3.b

Main and fixed windows show bounded tool/plan/reasoning-summary activity and canonical pending requests. Replies bind the actual sender, thread, turn, generation and opaque request key. Observers cannot answer; after the execution window closes, explicit same-session takeover grants only this turn's request handling. Duplicate, resolved, terminal and disconnected requests cannot be replayed. Submitted forms are cleared without being added to the private session store or logs.

Input uses the pinned official question schema: single choice plus `user_note`, free text, explicit skip, and exact-turn stop. Empty answers mean skip and may let the model continue; stop uses interrupt. Secret values are not collected. Required answers are a product rule, not a claim about the upstream schema. The official core may retain ordinary submitted answers.

Production stays text-only with tool features disabled, read-only sandbox and approvalPolicy=never. Accept is blocked in real sessions; only the offline fake peer exercises approval success. No terminal, arbitrary execution, persistent grants or new real coding mode is enabled. A future independent coding mode needs explicit scope and sandbox/feature validation. MCP/dynamic execution and permission grants remain unsupported.

Run `npm run desktop:workflow:smoke -- /absolute/private/output`. See [the report](../docs/workbench/tool-workflow-milestone.md), [machine evidence](../docs/workbench/tool-workflow-results.json), and [daily use](../docs/workbench/daily-use.md). This milestone is a protocol/UI workflow foundation, not acceptance of real coding execution.

## Local change review and isolation plans — M3.c1

Bounded snapshots distinguish HEAD-to-index from index-to-working-file diffs with old/new hunk numbers and observation time. Explicit rechecks detect observed status/HEAD/selected-content changes, permanently expire stale review handles and clear plans. Reads are sequential observations, not atomic snapshots or continuous monitoring. Unexpanded directories cannot be verified; untracked source and unsupported combined hunks do not invent line navigation. Current-file preview is explicitly a different version.

Isolation plans bind the current window/session/root/review and fixed HEAD. They are memory-only and non-executable; no production worktree creation, removal, handoff or terminal IPC exists. Plans explain detached checkout, excluded unsaved/ignored files and shared Git metadata. Real add/remove is tested only in newly generated disposable fixtures, never personal repositories. Ordinary Git removal may delete ignored files; the test preflight includes ignored content, but is not atomic removal or recoverable archival. Production lifecycle needs a separate design and validation.

Run `npm run desktop:review:smoke -- /absolute/private/output`. See [scope](../docs/workbench/change-review-plan.md), [report](../docs/workbench/change-review-milestone.md), and [machine evidence](../docs/workbench/change-review-results.json). Real model review and coding execution remain disabled for this milestone.

## M3.d0 coding preparation (simulation only)

`desktop-host/coding-preparation.ts` is an independent observation state machine, without production imports, IPC, launcher or outbound queue. Every state remains `canExecute: false`; text-only is unchanged. The reviewed configuration declaration, one-shot tickets and owner/root/thread/turn/generation bindings reject mismatches and preserve uncertain outcomes across reconnects. Permission requests produce only an unsent decline classification.

`npm run coding:simulation:check` checks pinned contracts and source-derived experimental subsets, types, then an explicit 15-file pure protocol/Node fake-peer selection (191 tests, 23 new). It deliberately avoids full `npm test`/`check` native helper and Git/worktree tests. No UI or native isolation probes run. Two new contract files are verbatim pinned exports; experimental selection/provenance is a manual strict product subset, not a binary-generated complete schema or verified wire implementation. Configuration observations do not prove runtime isolation. See [the report](../docs/workbench/coding-preparation-milestone.md). Native probes, real coding and public push were not authorized or attempted; new commits are excluded from the pending push cutoff `940e092b9`.
