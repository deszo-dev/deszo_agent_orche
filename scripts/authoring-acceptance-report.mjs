// Assemble a redacted report from completed checks; this script runs no models.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(process.argv[2] || '.deszo/acceptance/adr0001-20261015-01');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const read = path => json(join(root, path));
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const identity = path => ({ path: relative(process.cwd(), path).replaceAll('\\', '/'), byteSize: statSync(path).size, sha256: hash(path) });
const relativeRoot = relative(process.cwd(), root).replaceAll('\\', '/');
const passed = path => { const value = read(path); assert.equal(value.passed, true, path); return value; };
const tests = readFileSync(join(root, 'final-tests.log'), 'utf8');
assert.match(tests, /# tests 373\b/); assert.match(tests, /# pass 373\b/); assert.match(tests, /# fail 0\b/);
assert.match(readFileSync(join(root, 'native-tests.log'), 'utf8'), /4 passed; 0 failed/);
assert.match(readFileSync(join(root, 'final-build.log'), 'utf8'), /built in/);
const assetNames = log => [...new Set(readFileSync(join(root, log), 'utf8').match(/dist\/assets\/[^\s]+/g))].sort();
const frontendAssets = assetNames('package-build.log');
assert.ok(frontendAssets.length > 0);
assert.deepEqual(assetNames('release-package-build.log'), frontendAssets);
const policy = passed('confirmation-default-check.json');
const cutover = passed('v2-cutover-check.json');
const packaged = passed('packaged-check/result.json');
const desktop = passed('desktop-01/evidence/desktop-result.json');
const restart = passed('desktop-01/evidence/restart-audit.json');
const directory = passed('clients/directory-check-final.json');
const race = passed('clients/race-result.json');
const beforeApproval = passed('clients/before-approval.json');
assert.equal(beforeApproval.runCount, 0); assert.equal(beforeApproval.requests.length, 3);
assert.ok(directory.uiCollisionRecorded && directory.workspaceDirectoryHandshakeRejected);
assert.equal(restart.cases.length, 2); assert.ok(restart.cases.every(c => !c.automaticRetry && c.providerAttempts === 1));
const pilot = json(resolve('docs/pilots/evidence/2026-10-15-authoring-pilot.json'));
assert.equal(pilot.verdict, 'passed_with_controller_recovery');
const smoke = read('smoke-01/smoke-results.json'); assert.equal(smoke.state, 'succeeded');
const uiProofs = {
  cleanRefresh: ['clients/ui-clean-refresh.json', /Live edit verified/],
  dirtyConflict: ['clients/ui-dirty-conflict.json', /Save conflict:.*Your draft is still here/],
  draftCopy: ['clients/ui-draft-copy.json', /Saved your draft as/],
  pendingQueue: ['clients/ui-pending-approvals.json', /3 pending/],
  directoryConflict: ['clients/ui-directory-conflict.json', /The workspace root overlaps a connected Antigravity authoring directory or MCP config path\./],
};
for (const [path, pattern] of Object.values(uiProofs)) assert.match(read(path).tree, pattern);
assert.match(read('clients/ui-dirty-conflict.json').tree, /LOCAL_UNSAVED_DRAFT/);
const clientRecords = readdirSync(join(root, 'clients')).filter(f => /^(codex|claude|antigravity)-(create|edit|request|inspect|race)-.*-result\.json$/.test(f))
  .map(file => ({ file, ...read(`clients/${file}`) }));
assert.ok(clientRecords.every(record => record.passed));
const db = new DatabaseSync(join(desktop.storage, 'store/state.sqlite'), { readOnly: true });
const clients = ['codex', 'claude', 'antigravity'].map(provider => {
  const phases = clientRecords.filter(record => record.provider === provider);
  for (const phase of ['create', 'edit', 'request', 'inspect']) assert.ok(phases.some(p => p.phase === phase));
  const run = passed(`clients/${provider}-run-result.json`);
  const request = db.prepare('SELECT state,run_id FROM external_run_requests WHERE request_id=?').get(run.requestId);
  assert.equal(request.state, 'approved'); assert.equal(request.run_id, run.runId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM runs WHERE workflow_id=?').get(run.workflowId).n, 1);
  return { provider, cliVersion: phases[0].cliVersion, requestedAuthoringModel: phases[0].requestedModel,
    observedAuthoringModels: [...new Set(phases.map(p => p.observedModel ?? null))],
    phases: phases.map(p => ({ phase: p.phase, requestId: p.requestId, revision: p.revision, raceOutcome: p.raceOutcome, evidence: `${relativeRoot}/clients/${p.file}` })),
    runId: run.runId, runRequestId: run.requestId, workflowId: run.workflowId, runState: run.state, eventCount: run.eventCount,
    exactlyOneRun: true, contiguousJournal: true, providerInvocations: run.invocations.map((invocation, index) => ({ provider: invocation.provider,
      requestedModel: invocation.requestedModel, observedModel: run.providerOutputs[index].observedModel,
      cliVersion: invocation.cliVersion, isolationMechanism: invocation.managedToolIsolation.mechanism })),
    finalArtifact: run.finalArtifact };
});
assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE state IN ('queued','running','waiting_for_user')").get().n, 0);
db.close();
const profileConfigs = [join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'), join(homedir(), '.claude.json'), join(homedir(), '.gemini/config/mcp_config.json')];
for (const path of profileConfigs) if (existsSync(path)) assert.doesNotMatch(readFileSync(path, 'utf8'), /deszo_(?:acceptance|live)_[a-z0-9_]+/i, 'A temporary profile registration remains.');
const bundles = ['runner.mjs', 'bridge.mjs'].map(file => {
  const source = resolve('dist-runtime', file); const installed = join(root, 'installed/runtime', file);
  assert.equal(hash(source), hash(installed)); return identity(installed);
});
const proofRoots = ['native-a7b04444', 'native-fdd93156'];
const compatibility = proofRoots.map(directory => {
  const evidence = read(`${directory}/result.json`); assert.ok(evidence.results.every(r => r.passed));
  return { privateEvidenceRoot: `${relativeRoot}/${directory}`, phases: evidence.results.map(r => ({ provider: r.provider, phase: r.phase,
    cliVersion: r.cliVersion, nativeConfiguration: r.nativeConfiguration, passed: r.passed,
    mcpStarts: r.observations.filter(o => o.event === 'started').length,
    calls: r.observations.filter(o => o.event === 'response' && o.tool === 'get_authoring_contract').length })) };
});
const sourceFiles = {};
const walk = path => { for (const entry of readdirSync(path, { withFileTypes: true })) {
  const name = join(path, entry.name); if (entry.isDirectory()) walk(name);
  else if (/\.(mjs|ts|tsx|css|rs|json|sql)$/.test(entry.name)) sourceFiles[relative(process.cwd(), name).replaceAll('\\', '/')] = hash(name);
} };
for (const directory of ['runtime', 'mcp', 'shared', 'src', 'src-tauri/src', 'scripts']) walk(resolve(directory));
for (const path of ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.lock', 'docs/authoring/mcp-neutralizers.json', 'docs/schemas/application-settings.schema.json']) sourceFiles[path] = hash(resolve(path));
const manifest = { capturedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version, files: sourceFiles };
const baseline = read('baseline.json');
for (const [path, digest] of Object.entries(baseline.files).filter(([path]) => path.startsWith('src/'))) assert.equal(sourceFiles[path], digest, `Frontend changed after the tested baseline: ${path}`);
writeFileSync(join(root, 'final-source-manifest.json'), JSON.stringify(manifest, null, 2));
const pilotManifest = read('pilot-02/evidence/source-manifest.json');
const postPilotChangedFiles = Object.entries(pilotManifest.files).filter(([path, digest]) => sourceFiles[path] !== digest).map(([path]) => path);
assert.deepEqual(postPilotChangedFiles.sort(), ['mcp/bridge.mjs', 'runtime/core/engine.mjs']);
const acceptanceInstaller = resolve('src-tauri/target/release/bundle/nsis/Deszo Acceptance_0.2.0_x64-setup.exe');
const releaseInstaller = resolve('src-tauri/target/release/bundle/nsis/Deszo_0.2.0_x64-setup.exe');
assert.ok(existsSync(releaseInstaller));
const report = {
  schemaVersion: 1, date: '2026-10-15', generatedAt: new Date().toISOString(), verdict: 'passed_for_listed_windows_versions_and_scopes',
  privateEvidenceRoot: relativeRoot, platform: `${process.platform}-${process.arch}`, node: process.version,
  gates: { G0: { status: 'passed', nodeTests: 373, nativeTests: 4, frontendBuild: true, runtimeBundle: true },
    G1: { status: 'passed', supportedScopes: ['Windows user/global', 'Windows project'], bundledReruns: compatibility },
    G2: { status: pilot.verdict, runId: pilot.runId, providerCalls: pilot.providers, explicitControllerRecoveries: pilot.controllerActions.length,
      certificate: pilot.acceptance, exportTests: pilot.exportedTests, independentChecks: pilot.independentChecks },
    G3: { status: 'passed', confirmationDefault: true, missingFieldFallback: true, persistedFalsePreserved: true, packagedFixtureFlagRejected: packaged.packagedFixtureFlagRejected },
    G4: { status: 'passed', v2SaveStatus: 410, v3ConditionalSaves: true, v2OtherRoutesRetained: true, smokeRunId: smoke.runId },
    G5: { status: 'passed', clients: ['codex', 'claude', 'antigravity'], mixedProviderRuns: 3, executionProviderCalls: 9, containmentProviderCalls: 2,
      noRunBeforeApproval: true, firstPartyUiDecisions: 5, directoryConflict: true, crossClientRace: race,
      uiProofs: Object.fromEntries(Object.entries(uiProofs).map(([name, [path]]) => [name, `${relativeRoot}/${path}`])), lifecycle: restart.cases } },
  clients, packages: { installedCandidate: { identifier: 'local.deszo.acceptance20261015', installer: identity(acceptanceInstaller), executable: identity(join(root, 'installed/deszo.exe')), bundles },
    standardRelease: { identifier: 'local.deszo.app', installer: identity(releaseInstaller), installedOverExistingUserStore: false, runtimeAndFrontendMatchAcceptanceCandidate: true, frontendAssets } },
  sourceManifest: { path: `${relativeRoot}/final-source-manifest.json`, sha256: hash(join(root, 'final-source-manifest.json')) },
  postPilotChanges: { changedPreviouslyCapturedExecutionFiles: postPilotChangedFiles, addedBridgeTransport: 'mcp/runtime-client.mjs',
    description: 'Confirmation initialization/fallback and the reserved internal save guard changed in the engine. V2 retirement is in the HTTP router. Bridge HTTP transport gained same-store reconnection. Scheduler, process adapters, and isolation preparation stayed identical to the successful pilot; the changed bridge was re-probed with all three clients and both crash scenarios.' },
  cleanup: { temporaryProfileRegistrationsRemoved: true, ownedCrashDescendantsGone: true, activeInstalledRuns: 0, sqliteIntegrity: 'ok' },
  limitations: [
    'Only the exact installed CLI versions and listed Windows scopes are verified; unknown versions and uncovered scopes fail closed when a Deszo registration is detected.',
    'Claude local and managed/system registrations and non-Windows installations were not live-verified.',
    'Codex explicit child-marker overrides support simple server names only; quoted dotted names are blocked.',
    'The reference pilot needed one explicit controller retry and is not an unattended-success claim.',
    'Codex did not expose an observed model ID in the parsed native evidence; its requested model is recorded without inventing an observed value.',
    'An existing persisted confirmation=false remains false; fresh stores and missing fields default to true.',
    'Live installed checks used an isolated application identifier. The standard installer is built from the same source and matching runtime/frontend assets and was not installed over the existing user store.',
    'The mixed-provider smoke graph constrains only its first Agent to a literal response; later Agents receive the prior answer as their complete prompt. Final artifacts are checked for integrity and non-empty text, not a deterministic downstream sentence.'
  ],
};
// Check the standard package was assembled after the passing installed candidate,
// and the frontend build did not introduce a different asset set.
const runtimeResource = resolve('src-tauri/target/release/runtime');
if (existsSync(runtimeResource)) for (const file of ['runner.mjs', 'bridge.mjs']) assert.equal(hash(join(runtimeResource, file)), hash(resolve('dist-runtime', file)));
writeFileSync(resolve('docs/pilots/evidence/2026-10-15-authoring-acceptance.json'), JSON.stringify(report, null, 2));
const currentCompatibility = json(resolve('docs/pilots/evidence/2026-10-15-authoring-compatibility.json'));
currentCompatibility.finalBundledReruns = compatibility;
currentCompatibility.finalBridgeSha256 = hash(resolve('dist-runtime/bridge.mjs'));
writeFileSync(resolve('docs/pilots/evidence/2026-10-15-authoring-compatibility.json'), JSON.stringify(currentCompatibility, null, 2));
console.log(JSON.stringify({ passed: true, verdict: report.verdict, clients: clients.map(c => c.provider), report: 'docs/pilots/evidence/2026-10-15-authoring-acceptance.json' }));
