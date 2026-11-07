# Antigravity Judge Stage 1 evidence

This directory records the bounded production-component integration described in the [Stage 1 report](../../2026-10-21-antigravity-stage1-report.md). Historical PoC and baseline evidence remain unchanged. Do not store credentials, provider authentication stores or raw sensitive logs here.

The pre-change inventory is in report section 2. **Production-path E2E is BLOCKED.** Three actual Engine decisions below use software consent, synthetic process identity and fixture provider responses; they are not three live Antigravity turns. New live provider calls: **0**. The installed service/application/profile, saved Fixer graph and historical baseline are untouched by this campaign.

## Reproduce from the repository root

PowerShell; Node 22.20.0 and installed dependencies were used:

```powershell
node --disable-warning=ExperimentalWarning --test --test-concurrency=1 runtime/tests/judge-control.test.mjs runtime/tests/antigravity-judge.test.mjs runtime/tests/judge-worker.test.mjs runtime/tests/judge-recovery.test.mjs
npm test
npm run docs:check
npm run runtime:bundle
node docs/reviews/evidence/2026-10-21-adr-0007-baseline.mjs
node --disable-warning=ExperimentalWarning docs/reviews/evidence/2026-10-21-antigravity-stage1/reproduce-components.mjs
node docs/reviews/evidence/2026-10-21-antigravity-stage1/analyze-historical-telemetry.mjs
node docs/reviews/evidence/2026-10-21-antigravity-stage1/config-hygiene.mjs
node --disable-warning=ExperimentalWarning docs/reviews/evidence/2026-10-21-antigravity-stage1/inspect-provider.mjs --cli C:/Users/jusse/AppData/Local/agy/bin/agy.exe
node docs/reviews/evidence/2026-10-21-antigravity-stage1/verify-inputs.mjs
node docs/reviews/evidence/2026-10-21-antigravity-stage1/verify-stage1.mjs
```

Tests/reproduction create disposable stores below `.deszo/tests` and close their HTTP servers/Bridge children/Host stores. The component reproducer regenerates fixture IDs and evidence files; preserve the sealed campaign before regenerating it if byte identity matters. The evidence manifest records bytes, not reproducible UUIDs. Do not run the historical PoC to reproduce these checks.

`config-hygiene.mjs` without flags inspects only. The executed cleanup used `--apply`: it proved the archived PoC's exact server path, removed only `deszo-evidence` and its exact broad allow-rule, made backups beside the original configuration and wrote JSON without BOM. No authentication store was read or copied. No cleanup command sets current billing preferences or proves effective future CLI permissions.

The provider inspection runs only `--version`/`--help`, reads public settings and returns typed incomplete-auth/billing status. It never calls `startTurn`. The successful 1.4.4 help is on stderr; the initial diagnostic receipt is preserved beside the corrected one.

To reproduce the captured test logs, redirect each command's output to its matching `.log` file and preserve its exit code. `verify-stage1.mjs` expects completed full/targeted logs, zero docs errors, the bundle receipt, exact source fingerprints and unchanged five baseline files. It also proves that the sole source delta after the full suite began is exactly the stderr-help metadata fix, covered by final targeted tests, the installed read-only probe and bundle. It does not claim full-suite byte identity across that late metadata change. An old failing development log is retained separately and excluded from acceptance.

## Evidence map

| File | What it proves / qualification |
| --- | --- |
| [component-receipt.json](component-receipt.json) | Three actual Engine/Bridge/Host-class decisions and shared ledger charges; explicitly fixture consent/native/provider, zero live turns |
| [engine-transition-receipts.json](engine-transition-receipts.json) | Actual Engine `in_flight → resolved` receipts, unchanged run, no candidate/merge acceptance |
| [engine-judge-journal.json](engine-judge-journal.json) | Actual typed Engine journal plus immutable lifecycle records, read IDs and rejection/application facts |
| [bridge-tool-evidence.json](bridge-tool-evidence.json) | Actual scoped MCP reads and authenticated Worker submissions; no provider/controller credentials |
| [worker-delivery-trace.json](worker-delivery-trace.json) | Existing queue claims, adapter receipt and Worker decision audit; not installed native IPC/Job proof |
| [untrusted-proposals.json](untrusted-proposals.json) | Synthetic proposed decisions and actual invalid-budget refusal; source evidence remains untrusted |
| [component-performance.json](component-performance.json) | Package / one-detail / multiple-detail bytes and local timings; null live token fields |
| [historical-telemetry-analysis.json](historical-telemetry-analysis.json) | Four saved native snapshots; cumulative counters explain the old 524,195 overcount; no new calls or billing claim |
| [provider-readonly-inspection.json](provider-readonly-inspection.json) | Real installed CLI 1.4.4 capabilities; native launch/account/billing gates remain unverified |
| [config-hygiene.json](config-hygiene.json) | Exact PoC-only removal, configuration hashes and backup locations, no copied authentication |
| [process-hygiene.json](process-hygiene.json) | Final scoped inventory: zero remaining test/fixture/Bridge children; existing application/service processes untouched |
| [targeted-tests.log](targeted-tests.log) | 25 tests of real Engine/Bridge/Host boundaries, deterministic race/restart/expiry/injection failures and provider parser/billing gates |
| [full-runtime-tests.log](full-runtime-tests.log) | Full regression command; final counts are in the verification summary |
| [full-runtime-tests-before-final-fixes.log](full-runtime-tests-before-final-fixes.log) | Historical development failure, retained transparently; not acceptance evidence |
| [docs-check.log](docs-check.log), [runtime-bundle.log](runtime-bundle.log), [baseline-check.log](baseline-check.log) | Required checks; baseline script explicitly cannot verify absent original private observation files |
| [source-inputs-at-full-suite-start.json](source-inputs-at-full-suite-start.json), [source-inputs.json](source-inputs.json) | Exact baseline/final source inputs, including pre-existing dirty work; no source/credential export |
| [verification-summary.json](verification-summary.json), [artifact-manifest.json](artifact-manifest.json) | 638 full / 25 targeted tests, zero docs errors, qualified metadata delta, five unchanged baseline files and byte digests of this public directory |

## Failure coverage and limits

Deterministic tests cover wrong identities, revision/candidate/evidence, absent credentials, conflicting duplicates, Stop/revocation/expiry, finite budget exhaustion, simultaneous admission, queue/wake/response deadlines, managed-marker refusal, malformed/BOM settings, denied tools, incomplete/unknown provider output and absent native launcher/custody. Five persisted-boundary Engine/store restarts and an injected queue lease loss prove durable records and no blind replay; they are not abrupt native service/provider crash tests.

No test creates Windows Hello consent, native provider-session custody, clone detection or an installed-worker Judge turn. Actual model timeout/kill proof, fresh scoped re-registration, live effective permissions and subscription entitlement remain blocked. The same-user security limitations of ADR-0006/0007 are not solved by a dedicated profile, process mutex or these fixtures.
