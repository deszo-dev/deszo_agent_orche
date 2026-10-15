# Storage and Integrity

Version: 0.8  
Status: implemented M1–M6 storage foundations; ADR-0001 migration 6 applied by the runtime  
Updated: 2026-10-15

This document owns storage layout, immutable-record integrity, database transactions, retention, and export. The [reference M1 DDL](storage/m1.sql) is a documentation artifact, not a runtime migration already installed by the prototype.

## Layout and ownership

Use an application-selected local root, independent of the user's project:

```text
<application-root>/
  store/
    state.sqlite
    objects/<sha256-first-two>/<sha256>
    staging/<opaque-id>/
  workdirs/
    scratch/<workspace-id>/
    tasks/<run-id>/<map-generation>/<task-id>/<attempt-id>/
    reviews/<run-id>/<review-id>/
    checks/<run-id>/<check-id>/
  drafts/
    workflows/<workflow-id>.json
```

Task/reviewer/runner directories are under the sibling `workdirs` root, never nested under `store`. M1 may also use a user-selected project outside this root. Reject a project/cwd that resolves into `store`; resolve symlinks/junctions before comparing paths. Locks use canonical OS path identity, including case handling on Windows.

Only the runtime writes engine records through authenticated commands. Agent-output parsing never imports claimed engine IDs/certificates as records. Record an agent's JSON as source evidence before validating and wrapping it.

Full Access can still reach sibling directories or the same user's SQLite database. Sibling roots and hashes reduce accidental damage and detect ordinary corruption; they do **not** prevent a same-user process from changing both a blob and its recorded digest. Strong adversarial isolation requires another OS identity/sandbox and is outside the current scope.

## Immutable records and hashes

Store saved definitions, settings/input/invocation/output manifests, successful values, **batched** log chunks, native binding references, and later specification/approval/task/check records as immutable objects. Small journal envelopes are immutable canonical UTF-8 JSON stored **inline in SQLite**, with envelope_sha256 and envelope_byte_size; they do not each create an object file. Verify inline size/digest before parsing or publishing, just as for object bytes.

`artifacts` records a UUID, SHA-256, byte size, media type, and relative content-addressed path. Write staging bytes, flush, hash, atomically publish under the digest, and then commit database references. Never overwrite a published object. On every read, verify the bytes against the SQLite digest/size before parsing or returning them. A mismatch or missing referenced object is a `corruption` error, never a successful review or check.

Canonical JSON hashes use the rule in [M1 contracts](M1_CONTRACTS.md#workflow-and-identity). Snapshot file contents use their exact byte hashes. Credentials/bearer tokens are not stored in artifacts. Native session references are local sensitive metadata, protected by ordinary user filesystem permissions and excluded from default export.

State tables are transactional projections of committed records/events. Their identities must agree with the validated records they reference. Digest verification alone does not prove the truth of an agent's statement or the correctness of a test.

## Database and commit boundary

M1 SQLite uses foreign keys, WAL, `synchronous = FULL`, and one runtime writer. The reference DDL defines:

| Table | Purpose |
| --- | --- |
| `schema_migrations` | Applied version and migration digest |
| `artifacts` | Immutable-object inventory |
| `application_settings` | Singleton current capacity revision and immutable settings reference |
| `workspaces` | Local cwd binding and identity |
| `workflows` | Latest saved draft snapshot |
| `runs` | Captured workflow/settings, execution hash, lifecycle, last journal sequence |
| `node_instances` | Captured executable graph nodes and state |
| `attempts` | Captured invocation, manifests, process identity/result and recovery state |
| `context_bindings` | Native identity, provider/account/cwd/configuration fingerprint and binding state |
| `run_context_bindings` | Captured run/Context-node/mode → local binding; workflow identity derives from run |
| `journal_events` | Per-run sequence and inline immutable envelopes with digest/size |
| `command_receipts` | Idempotent create/stop requests and captured responses |
| `resource_locks` | Runtime reservations reconciled after restart |
| `runtime_identity` | Stable store identity paired with the canonical application root |
| `workflow_changes` | Durable, monotonically sequenced saved-workflow change notifications |
| `cache_node_incarnations` | Runtime-owned Cache identity across edits and remove/re-add cycles |
| `external_run_requests` | Idempotent pending/approved/denied/expired external run requests pinned to a workflow snapshot and workspace identity |
| `bridge_registrations` | Short-lived Antigravity authoring-directory/config metadata refreshed by bridge heartbeat |

After referenced blobs are safely published, one SQLite transaction commits one or more inline envelopes, advances last_sequence and updates associated projections/outputs. Multiple ready log batches/events may share that FULL transaction. Publish SSE only after commit; successful values require their outputs-committed event. Atomic output manifests/state changes never wait for an unrelated stream's batch timer. The terminal state follows after final stream flushes, in the same or next ordered transaction.

Initialize application settings revision 1 before accepting commands; its artifact validates against the application-settings schema. Updating that singleton, the idempotent receipt and capacity-change events for all active runs is one transaction. Native identity rows remain separate from run Context mappings. Context node IDs refer to declarations in the captured workflow, which the planner validates; they are not executable node_instances. Each executable instance has its scheduled attempt at plan time. Scope ownership/transition legality are validated before database writes; foreign keys additionally reject cross-run attempt/event references.

Log batching/backpressure rules live in [the journal contract](RUN_HISTORY_AND_REPLAY.md#log-batching). Object deduplication and transaction batching do not permit dropping captured bytes.

Each run starts with `run.created` then `run.state_changed` from null to queued. Sequences are contiguous from 1, unique per run. Distinct events can share a timestamp. The journal sequence, not clock time, orders parallel work. Orphan blobs after a crash can be garbage-collected later; a committed missing blob is corruption.

Migration scripts are versioned and hashed. Back up the database before applying a migration, reject unsupported newer versions, and never silently reinterpret stored events. The runtime applies each reference script's statements and its `schema_migrations` row in **one** SQLite transaction (it supplies the script's `BEGIN`/`COMMIT` and pragma boundaries itself), so an interrupted or failing migration rolls back completely and startup reports the unchanged version instead of leaving a newer schema without its version record. Database migration 6 is in [m6.sql](storage/m6.sql); it introduces workflow revisions, durable authoring changes, store identity, Cache incarnations, external-run approval requests and bridge registrations. Migration 7 is in [m7.sql](storage/m7.sql); it adds a reverse index for artifact references so provenance reads do not scan every attempt envelope. Workflow-change events are retained indefinitely so an editor/client can detect a missed cursor and resynchronize from saved revisions.

## Restart, retention, and export

On restart, validate referenced records and reconcile PID/start/supervisor identities under [the containment policy](M1_CONTRACTS.md#process-containment). Nonterminal runs, including draining, become interrupted. In Tauri mode Rust has terminated the previous Job; confirm that cleanup before releasing reservations. Standalone development blocks on any surviving/uncertain owned tree until termination is resolved. Neither mode adopts surviving work or issues a model call automatically. Ambiguous native bindings become needs_review. List endpoints make these interrupted runs discoverable after frontend state is lost.

Keep run journals and referenced objects by default. Deletion is a separate explicit user operation: protect live runs, Context references, Cache pins, carried approvals, and selected results. Retention/garbage-collection commands are deferred until their reference accounting is specified.

Default portable export contains workflow JSON and selected user-approved artifacts. It excludes credentials, native bindings/session references, raw provider logs, and absolute local cwd. A portable Continue Context must be explicitly rebound; export cannot silently turn it into New.
