---
name: deszo-control
description: Operate, diagnose, prepare and resume Deszo workflows through MCP with reusable compatibility checks, supervised control and bounded observations. Use for Deszo controller or workflow operations and their troubleshooting.
---

# Deszo control

Use the project's maintained tools. The Deszo checkout must contain `scripts/deszo-control.mjs`; resolve its root from the user's workspace rather than a dated pilot folder. These scripts are part of the repository, not copied into the installed skill.

## Start or resume

Read the latest public checkpoint and, if present, `.deszo/operator/current-package.json`. They are locators and historical evidence, never current authority. Keep the existing workflow's models, explicit efforts, graph and limits unless the user authorizes a revision.

Run one read-only preflight against an **explicit profile**, saved workflow and registered workspace:

```powershell
node --disable-warning=ExperimentalWarning scripts/deszo-control.mjs doctor --profile PROFILE --build BUILD --workflow WORKFLOW --workspace WORKSPACE --workspace-dir DIRECTORY
```

Omit `--build` only when checking source compatibility before preparing a build. `compatible_offline` does not mean the application is running or a run is authorized. After the user opens the application, add `--live`, then inspect the actual runtime through MCP.

- Resolve reported blockers before suggesting an executable or requesting approvals. Compare schema histories, not just application versions or commit labels.
- A newer profile is not repaired by deleting migration rows, downgrading its schema or hiding a startup error. Find and integrate the missing source changes. Preserve unrelated dirty work.
- An old bridge can reconnect to the same store and still expose an outdated tool inventory. Verify the full control tool set; reconnect using the selected build's bridge when necessary.

For source/build changes, use the maintained preparation command. A valid existing output is reused; choose a new directory when its captured inputs no longer match:

```powershell
node --disable-warning=ExperimentalWarning scripts/deszo-control.mjs prepare --profile PROFILE --out NEW_BUILD
```

It checks compatibility first, reuses a matching desktop binary, rebuilds only the runtime when appropriate, records content fingerprints and verifies the package. Do not edit bundled JavaScript or inject a private timeout-registry overlay. Native apps are opened according to the user's preference; in this project the user opens them.

## Reuse transport verification

`node scripts/deszo-transport.mjs` checks the saved receipt without waiting. Its fingerprint covers the shared stdio driver, timeout policy, platform and Node major. Restarts, changed task text, application rebuilds, CLI model selection and new chats do not themselves require another measurement.

If the fingerprint is missing or incompatible, use the existing `--measure` command once. It uses no models; a valid receipt is reused even with `--measure`. Reserve `--force` for an explicit retest. A receipt for this driver does not certify the desktop's default MCP host or an autonomous worker. Keep enclosing `node_repl` calls at least 55 seconds; individual watches stay at most 20 seconds.

## MCP control

Prefer the available Deszo MCP tools. If the app's cached integration lacks full control tools or a verified transport, use the maintained `mcp/controller-client.mjs` in one persistent Node REPL. Read [the controller procedure](references/controller.md) for the exact connection and run lifecycle. Do not recreate JSON-RPC clients in chat or install another monitoring daemon.

Create one bridge-held controller session, one exact grant and one idempotent start request. Verify actual grant and request states after human confirmation. `--allow-execution`, saved IDs and historical approval messages are not approval authority. Do not read first-party tokens or simulate trusted consent. Windows Hello remains a physical user action where required.

Use bounded `observe_run` receipts. Process the returned semantic events and relevant evidence, then explicitly ACK that receipt's cursor. Never ACK from a newer `get_run` cursor, skip unread details or renew supervision on a timer. Do not repeatedly read full provider streams while roles are working normally. The runtime keeps those streams; fetch relevant ranges when investigating a failure or escalation.

Stop on a suspected Deszo defect, verify owned-process termination and preserve typed incident evidence. Queued reports are not registered incidents; a Stop request is not a termination proof. See the controller reference for recovery and recording.

## Captured workspaces

Use registered bindings, not a convenient checkout. For an existing captured workspace, use `scripts/deszo-workspace.mjs --from SOURCE --to TARGET --manifest MANIFEST` to inspect changes without copying. `--sync --profile PROFILE --workspace ID` additionally checks ownership, unchanged target inputs and unfinished runs before copying; it preserves a content-addressed source snapshot. Unexpected edits, deletions or changed Git bases require reconciliation, not a reset.

## Efficient judge work

For the user's Fixer workflow the chat is the external Judge; Developer and Watcher perform their assigned work inside Deszo. Routine continuation stays in their loop. Read [Fixer conventions](references/fixer.md) only when operating that workflow.

Run checks appropriate to changed code. Reuse completed evidence when its inputs still match; rerun broader tests after integration changes or unresolved failures, not after every connection. Distinguish local fixtures, packaged startup, real application UI and independent acceptance. Tooling or a successful Fixer handoff does not close ADR criteria that require other evidence.
