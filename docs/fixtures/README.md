# Contract Fixtures

[manifest.json](manifest.json) selects valid cases from files using JSON Pointer. [invalid/cases.json](invalid/cases.json) defines negative variants. Each case names schema, optional $defs definition, expected valid/invalid, optional semantic rule group and mutations. An invalid case names phase = schema or semantic; semantic cases require the specified error code after structural acceptance.

Mutations use add/replace/remove with JSON Pointer paths; array add at /- appends. The loader deep-copies source data before mutation. Shared source files avoid duplicating complete workflows for every one-field regression. A maximumAgentTimeoutSeconds override supplies a synthetic advertised capability to workflow semantic cases; default is the M1 maximum 600.

## Synthetic identities

UUIDs, hashes, executable paths and model names in these fixtures are **shape examples**, not objects, accounts or executable providers on this machine. Binding existence/account/cwd compatibility still requires separate M1 runtime fixtures against a prepared store/adapter. The reference checker can prove ordering of bindings named in a definition, not the availability of an external native session.

[roles.json](roles.json) contains the minimal role capabilities required for map semantics. It is not an executable registry/template and does not replace the full pre-M4/M5 contracts.

[decisions.json](decisions.json) describes pure contract expectations for future engine tests: all-inactive joins, bounded verification, capacity across workspaces and failure/Stop behavior. The checker verifies a reference decision table, not a live scheduler.

[sql-cases.json](sql-cases.json) contains isolated setup statements and expected accept/reject/query rows. Short local keys and tiny JSON envelopes deliberately exercise **DDL constraints only**; complete record validation is covered separately by the schema/semantic cases. SQLite does not itself validate all UUIDs, event payloads, legal transitions, digests or native compatibility. Production writes require the corresponding engine validations.

## Reuse and maintenance

When a rule changes, update its normative document/schema, source examples and affected expectations together. Schema-negative and semantic-negative cases remain distinct so that a new structural restriction cannot accidentally mask a missing semantic check. IDs and expected semantic codes are stable test assets; do not renumber them to hide a regression.

Run [docs:check](../tools/README.md) before requesting another documentation review. These files can be used directly by the future M1 validator tests; actual engine tests must compare its results rather than call the documentation oracle as their implementation.
