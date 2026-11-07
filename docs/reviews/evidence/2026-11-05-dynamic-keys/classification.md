# Dynamic-key analysis of the P5 subject closure, 2026-11-05

Scope: the static import closure of `runtime/core/engine.mjs` (94 modules), the Engine's subject closure as the Gate walks it. Tooling: TypeScript AST walks, run from the repository root with no files written. The machine-readable inventory is [inventory.json](inventory.json); it was produced before the narrowing and ownership fixes recorded below, so it is the baseline for the residual, not the final state.

## 1. Inventory (baseline)

| Class | Count | Meaning |
|---|---|---|
| index | 38 | key is a loop or index variable (i, j, k, n, idx, index, position, length arithmetic) |
| data-receiver | 212 | key is data read from a local object, a Map-like table or a record |
| reflective | 3 | receiver is a call result, classified by receiver shape, then reviewed (below) |
| unclassified | 1 | receiver is a literal table keyed by a value from a remote URL, reviewed (below) |
| **total** | **254** | element accesses whose key is not a constant |

Reviewed reflective and unclassified sites:

- `runtime/core/engine.mjs` (cache fingerprints, two sites): the receiver is the fingerprint map returned for the workflow, keyed by a node identity. The value is data. A node identity of `constructor` would read `Object` through the prototype chain. Fixed: `ownEntry` reads own entries only.
- `runtime/core/protectedSelfRepair.mjs:54`: a literal table keyed by a contract name supplied by trusted callers. Data-only; no change.
- `runtime/core/p5GitCandidate.mjs:550`: a literal protocol table keyed by the enrolled remote's protocol. Fixed: `Object.hasOwn` guards the lookup, and an unknown protocol fails closed as before.

## 2. What could reach a capability

Three checks, each on the whole closure:

1. **A key-read value is invoked by a call** (`obj[k](...)`, `obj[k].call(...)`, `new obj[k]`): 0 sites.
2. **A key-read value is stored in a variable and that variable is later called** (same file): 0 sites.
3. **A key-read value is passed as an argument** to a call or constructor: 31 sites. These are data-typed in context (characters, fields, chunks, evidence values). Whether any callee invokes an argument it receives was not established for all 31. This is recorded as a residual.

Reflection is the one route the static rules cannot see through a variable. The expression form is refused now (`Object.values`, `Object.entries`, `Object.getOwnPropertyDescriptors` and related calls indexed directly). The demonstration in [reflection-route-demo.txt](reflection-route-demo.txt) reaches `Function` and evaluates a string with default flags, and the code-generation control blocks the same string.

## 3. Decision

- Not refactored: 212 data-receiver and 38 index accesses index data by design. Rewriting them to literals would not change what a run-time key can reach and is out of scope.
- Narrowed: reflection in expression form, the subpath and namespace builtins, numeric array-literal keys, and prototype reads by data keys in the three sites above.
- Residual, recorded for release review: keys held in variables or arrays and computed at run time, string building across statements, the 31 argument-passed reads, and reflection through variables. These are not closed by syntax. The owner's direction is containment, specified in [ADR-0011](../../../adr/0011-engine-runtime-containment.md).

## 4. What the existing Host and runtime boundary already prevents, and what it does not

- Prevents: installing or switching to an Engine package whose bytes differ from the accepted source (digests, source inventory, expected package digest), and substituting the trusted protected control modules at activation (attestation of the running control closure).
- Does not prevent: an accepted Engine running code it generates at run time. The Host verifies bytes, not the strings an Engine evaluates. ADR-0011 names the containment that would.
