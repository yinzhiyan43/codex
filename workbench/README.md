# Workbench protocol unit — M1.a

This package is a pure, local protocol engine. It does not launch Codex, access credentials, open user files, use the network, or start a model turn. All emitted frames stay in a memory queue until a future host explicitly consumes them.

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

- `connect()` queues one initialize request, using a distinct client name and `experimentalApi: false`. It returns an epoch and handshake promise. A valid response queues `initialized` and moves the protocol state to ready. Process starting/stopping is a future host responsibility.
- `readThread(params)` is the typed read-only API. Generic `request` applies the same allowlist: only `thread/read` is supported. Invalid or unreviewed fields, unimplemented methods and all experimental methods are rejected before enqueue.
- `receive(bytes, epoch)` processes bounded JSONL data, including fragmented UTF-8. It separates client responses, server requests and notifications; numeric/string IDs and the two request directions are independent. Unsafe numeric IDs and ambiguous envelopes fail the connection.
- `snapshot()` projects thread/turn/item state. Final item text replaces streaming text; terminal turn state does not regress because of late starts/deltas. Identical text chunks are not deduplicated, because the protocol lacks delta sequence IDs. Exactly-once transport delivery is **not** assumed.
- Command/file approvals stay pending until an explicit `respondApproval(handle, decision)`. Supported decisions are only `accept`, `decline`, `cancel`. Sending moves to responded; `serverRequest/resolved` moves to resolved. Session/persistent policy amendments, user-input forms, permission approvals, dynamic tools and token refresh are not implemented. Unsupported server requests receive an error, with no local execution.
- Epoch-bound handles reject old connections and old approvals. Disconnect/timeout retract a still-queued request and report `not-sent`; frames already taken by the host have an `unknown` outcome. Recovery notices survive repeated disconnects, and stale projections are preserved. Reconnection performs only a new handshake: no task, approval, command or request is replayed automatically. `acknowledgeRecovery()` only dismisses local old notices; it does not send a decision, replay work, or mark any projection fresh.
- Recovery is explicit and bounded. A `thread/read` response cannot overwrite later notifications that arrived while the read was in flight. Metadata-only reads do not refresh stale items; only full item views refresh their returned turns. Missing turns remain visible/stale. Full-history hydration is deprecated upstream; pagination support is deferred.
- Diagnostic events are a bounded observation ring, not a durable event log; `eventsDropped` reports truncation. A caller must use snapshots rather than assuming that every diagnostic was retained. Diagnostics exclude raw payloads. Snapshot/approval values are cloned for callers.

Minimal synthetic use (no transport or model task):

```ts
const session = new ProtocolSession();
const { epoch, initialized } = session.connect();
const frames = session.takeOutbound(); // feed only to a synthetic peer in M1.a
// Synthetic peer replies via session.receive(bytes, epoch).
await initialized;
```

## Limits and remaining work

Inbound/outbound frames, pending calls, server request IDs/bytes, recovery records/bytes, projection entities/bytes and diagnostic history have limits. Large valid batches are decoded incrementally, independent of host chunk boundaries. Resolved approvals clear their full parameters; bounded request hash tombstones remain until reconnect so duplicates cannot reopen an approval. The default 4096 server-ID budget is per connection; exhausting it fails closed and requires explicit reconnect. Recovery budgets are reserved before admitting work; if unresolved old notices exhaust them, explicit local acknowledgement is required before further requests. Over-budget or invalid known messages fail the connection; callers must inspect the diagnostic/state, then recover explicitly. Snapshots are display caches, not a complete persisted history or proof that an execution succeeded.

No production stdio/PTY bridge, desktop container, login, model catalog, turn/start, settings, full pagination, durable data store or UI is present. Server-side user input, MCP/permissions and experiment support need separate reviewed contracts and tests. Native formats that JSON Schema describes only as strings (such as paths) are not semantically validated for OS access by this unit; a future host must validate before using them. Framework ADR, real binary compatibility, native integration, performance budgets, visual verification and the remaining milestones remain open.
