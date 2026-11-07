// Opt-in real-provider proof for P1 durable workflow continuation. This is deliberately not a *.test.mjs file: it makes one live
// Codex inference. A published three-node workflow runs under Process Custody: A is a deterministic text node, B is a real Codex
// CLI task, C is a deterministic verification of the project that starts only after B is accepted. Engine A is terminated while
// Codex waits at its in-task READY gate. Engine B must restore the same Run, reattach the same Codex invocation, let it complete,
// settle B once, run C once and finish the original Run. No continuation API is called.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { detectProvider } from '../core/adapters.mjs';
import {
  buildArtifacts, cleanup, database, eventually, hostRecords, isAlive, newScratch, processIdentity, publishDefinition, registerWorkspace,
  sha256File, startCustodyHost, startEngine, testsRoot, waitForRunState,
} from './custody-support.mjs';

const repo = resolve(import.meta.dirname, '../..');
const evidencePath = join(repo, 'docs/reviews/evidence/2026-10-26-p1-codex-continuation-real.json');
const modelArg = process.argv.indexOf('--model');
const model = modelArg >= 0 ? process.argv[modelArg + 1] : '';
if (!model || model.startsWith('-')) throw new Error('Supply the exact workflow model explicitly with --model MODEL. No model fallback is used.');

const SETTLED = ['succeeded', 'failed', 'canceled', 'interrupted', 'waiting_for_user'];
const readyRelative = 'tools/.engine-replacement.READY.json';
const releaseRelative = 'tools/.engine-replacement.RELEASE.json';
const releasedRelative = 'tools/.engine-replacement.RELEASED.json';
const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));

// The disposable project: a small module with a contract, its tests, the in-task gate and the verification command.
function writeProject(workspace) {
  for (const dir of ['src', 'test', 'tools']) mkdirSync(join(workspace, dir), { recursive: true });
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'deszo-p1-codex-continuation', version: '1.0.0', private: true, type: 'module' }, null, 2) + '\n');
  writeFileSync(join(workspace, 'src/normalize.mjs'), 'export function normalizeCount(value) {\n  return Number.isInteger(value) && value >= 0 ? value : 0;\n}\n');
  writeFileSync(join(workspace, 'test/normalize.test.mjs'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { normalizeCount } from '../src/normalize.mjs';",
    "test('keeps non-negative integers', () => { assert.equal(normalizeCount(4), 4); assert.equal(normalizeCount(0), 0); });",
    "test('maps invalid values to zero', () => { assert.equal(normalizeCount(-1), 0); assert.equal(normalizeCount('4'), 0); });",
    '',
  ].join('\n'));
  writeFileSync(join(workspace, 'README.md'), '# normalize\n\n`normalizeCount` returns a non-negative integer and maps every other value to 0.\n');
  // The in-task gate. Codex runs it in the foreground; it publishes READY with a token and waits until the harness releases it
  // with that token after Engine B has reattached. It never touches the provider's process or the Engine.
  writeFileSync(join(workspace, 'tools/engine-replacement-gate.mjs'), `import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const READY = join(root, '${readyRelative}');
const RELEASE = join(root, '${releaseRelative}');
const RELEASED = join(root, '${releasedRelative}');
if (existsSync(READY) || existsSync(RELEASE) || existsSync(RELEASED)) { console.error('gate marker already exists'); process.exit(4); }
const token = randomUUID();
function atomicJson(path, value) {
  const temporary = path + '.' + process.pid + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\\n', { flag: 'wx' });
  renameSync(temporary, path);
}
atomicJson(READY, { schemaVersion: 1, pid: process.pid, parentPid: process.ppid, startedAt: new Date().toISOString(), releaseToken: token });
console.log('ENGINE_REPLACEMENT_GATE_READY ' + process.pid);
const deadline = Date.now() + 600000;
while (Date.now() < deadline) {
  if (existsSync(RELEASE)) {
    const release = JSON.parse(readFileSync(RELEASE, 'utf8'));
    if (release.schemaVersion !== 1 || release.releaseToken !== token || release.engineBReattached !== true) { console.error('gate release refused'); process.exit(2); }
    atomicJson(RELEASED, { schemaVersion: 1, pid: process.pid, releasedAt: new Date().toISOString(), releaseToken: token });
    console.log('ENGINE_REPLACEMENT_GATE_RELEASED');
    process.exit(0);
  }
  await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
}
console.error('gate release timed out');
process.exit(3);
`);
}

function command(executable, args, { cwd, timeout = 120_000 } = {}) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Read-only views of the Engine's durable store.
function rows(root, sql, ...params) {
  const db = database(root);
  try { return db.prepare(sql).all(...params).map(row => ({ ...row })); } finally { db.close(); }
}
const attemptsOf = (root, runId, node) => rows(root,
  'SELECT id, node_instance_id AS node, state, process_id AS pid, process_start_identity AS identity FROM attempts WHERE run_id = ? AND node_instance_id = ? ORDER BY ordinal',
  runId, node);
const custodyOf = (root, runId) => rows(root, 'SELECT attempt_id, custody_id FROM attempt_custody WHERE run_id = ?', runId);
const runRow = (root, runId) => rows(root, 'SELECT id, state, published_version_id AS publishedVersionId FROM runs WHERE id = ?', runId)[0];
function journal(root, runId) {
  return rows(root, 'SELECT sequence, event_type, envelope_json FROM journal_events WHERE run_id = ? ORDER BY sequence', runId).map(row => {
    const envelope = JSON.parse(row.envelope_json);
    return { sequence: row.sequence, type: row.event_type, node: envelope.nodeInstanceId, attemptId: envelope.attemptId, payload: envelope.payload };
  });
}
const settledCount = (root, runId, node) => journal(root, runId)
  .filter(event => event.type === 'attempt.state_changed' && event.node === node && event.payload?.to === 'succeeded').length;
const runnerLock = root => {
  const path = join(root, 'runtime', 'runner.lock');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
};
const processEpoch = host => JSON.parse(readFileSync(join(host.state, 'custody', 'epoch.json'), 'utf8')).epoch;
const writeAtomically = (path, value) => {
  const temporary = path + '.' + process.pid + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  renameSync(temporary, path);
};

const provider = await detectProvider('codex', { processCustody: true });
if (!provider.available || !provider.cliPath) throw new Error(provider.reason || 'Codex CLI is unavailable.');
if (provider.supportsCustodyExec !== true) throw new Error(provider.custodyReason || 'Installed Codex CLI does not support Custody execution.');
const executableHash = sha256File(provider.cliPath);
const hostArtifacts = buildArtifacts();
const scratch = newScratch('p1-codex-real');
const workspace = mkdtempSync(join(resolve(repo, '..'), 'deszo-p1-codex-workspace-'));
writeProject(workspace);
command('git', ['-C', workspace, 'init', '--quiet'], { cwd: repo });
const baseline = command('node', ['--test'], { cwd: workspace });
assert.equal(baseline.status, 0, `the baseline project tests pass: ${baseline.stdout}${baseline.stderr}`);
const readyPath = join(workspace, readyRelative);
const releasePath = join(workspace, releaseRelative);

const TASK = [
  'Before inspecting or changing project source, run `node tools/engine-replacement-gate.mjs` as a foreground command and wait for it to finish successfully.',
  'The gate writes a READY marker and waits. The proof harness creates its RELEASE marker only after the replacement Engine has reattached. Do not create or edit gate markers, do not run the gate in the background, and do not modify the gate script.',
  'After the gate exits successfully, update src/normalize.mjs so normalizeCount accepts decimal strings containing only base-10 digits, including "0", as non-negative integer values.',
  'Preserve existing behavior for non-negative integer numbers and invalid values. Add a regression test in test/normalize.test.mjs and update the README contract.',
  'Only modify src/normalize.mjs, test/normalize.test.mjs, and README.md. Do not change package.json or the gate script. Do not stage, commit, push, or access the network.',
  'Run `node --test` after the changes. Do not use npm. Report the exact test result and changed files.',
].join('\n');

// A (deterministic) -> B (Codex, Custody) -> C (deterministic verification, After B).
const definition = {
  schemaVersion: 1, workflowId: 'p1-real-codex-continuation', capabilities: ['core-v1', 'loops-v1'], settings: { nativeConfiguration: 'restricted' },
  nodes: [
    { id: 'node-a', type: 'text', config: { value: 'Disposable project preparation: the normalizeCount contract is known and its tests pass.' } },
    { id: 'node-b-prompt', type: 'prompt-template', config: { template: `Preparation result: {{prior}}\n\n${TASK}`, slots: [{ id: 'prior' }] } },
    { id: 'node-b', type: 'agent', config: { provider: 'codex', model, timeoutSeconds: 600, output: { format: 'text' } } },
    { id: 'node-c', type: 'file-input', config: { mode: 'files', paths: ['src/normalize.mjs', 'test/normalize.test.mjs', 'README.md'] } },
    { id: 'result', type: 'result-viewer', config: {} },
    { id: 'result-c', type: 'result-viewer', config: {} },
  ],
  edges: [
    { id: 'a-to-b-prompt', source: { nodeId: 'node-a', port: 'text' }, target: { nodeId: 'node-b-prompt', port: 'prior' } },
    { id: 'b-prompt-to-b', source: { nodeId: 'node-b-prompt', port: 'text' }, target: { nodeId: 'node-b', port: 'prompt' } },
    { id: 'b-to-result', source: { nodeId: 'node-b', port: 'text' }, target: { nodeId: 'result', port: 'value' } },
    { id: 'c-to-result', source: { nodeId: 'node-c', port: 'value' }, target: { nodeId: 'result-c', port: 'value' } },
  ],
  after: [{ before: 'node-b', after: 'node-c' }],
};

const host = await startCustodyHost(scratch.root, { allowedExecutables: [{ path: provider.cliPath, sha256: executableHash }] });
const engineOptions = { fixtureProvider: false, isolateCodexHome: false, devTestConfirmationOff: true };
const engineA = await startEngine(scratch.root, host, engineOptions);
const engineAIdentity = processIdentity(engineA.pid);
const lockA = await eventually(() => runnerLock(scratch.root), 'Engine A runner.lock ownership', 30_000, 100);
assert.equal(lockA.pid, engineA.pid, 'runner.lock names Engine A');
const epochA = processEpoch(host);

let engineB = null;
const evidence = { schemaVersion: 1, generatedAt: new Date().toISOString(), verdict: null, model, provider: { cliPath: provider.cliPath, cliVersion: provider.cliVersion, executableSha256: executableHash },
  host: { pid: host.pid, executableSha256: sha256File(hostArtifacts.hostExe) }, engineA: { pid: engineA.pid, identity: engineAIdentity, epoch: epochA }, workspace, timeline: [] };
const mark = (event, detail = {}) => evidence.timeline.push({ at: new Date().toISOString(), event, ...detail });
try {
  await registerWorkspace(engineA, 'main', workspace);
  const publication = await publishDefinition(engineA, definition);
  const started = await engineA.api('POST', '/api/v2/runs', { workflowId: definition.workflowId, workflowSnapshotSha256: publication.snapshotSha256,
    publishedVersionId: publication.publishedVersionId, definitionDigest: publication.definitionDigest, workspaceId: 'main', requestId: randomUUID() });
  assert.equal(started.status, 202, `run admitted: ${JSON.stringify(started.body)}`);
  const runId = started.body.run.runId;
  mark('run-admitted', { runId, publishedVersionId: publication.publishedVersionId });

  const bRunning = await eventually(() => {
    const [attempt] = attemptsOf(scratch.root, runId, 'node-b').filter(row => row.state === 'running');
    return attempt && attempt.pid && isAlive(attempt.pid) ? attempt : null;
  }, 'node B to launch Codex under Process Custody', 300_000, 250);
  const codexIdentity = processIdentity(bRunning.pid);
  const ready = await eventually(() => existsSync(readyPath) ? JSON.parse(readFileSync(readyPath, 'utf8')) : null, 'Codex to publish READY from its in-task gate', 600_000, 250);
  assert.equal(isAlive(ready.pid), true, 'the gate process is alive at READY');
  assert.equal(settledCount(scratch.root, runId, 'node-c'), 0, 'C has not run while B is active');
  mark('codex-ready', { codexPid: bRunning.pid, codexIdentity, gatePid: ready.pid });

  const [custodyBefore] = custodyOf(scratch.root, runId);
  const attemptB = bRunning.id;
  engineA.kill();
  mark('engine-a-terminated', { hostAlive: host.child.exitCode === null, codexAlive: isAlive(bRunning.pid) });
  assert.equal(host.child.exitCode, null, 'the Host survives Engine A');
  assert.equal(isAlive(bRunning.pid), true, 'Codex survives Engine A');

  engineB = await startEngine(scratch.root, host, engineOptions);
  const epochB = processEpoch(host);
  assert.notEqual(epochB, epochA, 'Engine B attached a new Host epoch');
  assert.equal(runnerLock(scratch.root).pid, engineB.pid, 'runner.lock names Engine B');
  const stillRunning = await eventually(async () => (await engineB.api('GET', `/api/v2/runs/${runId}`)).body?.run?.state === 'running' ? true : null, 'Engine B to report the original Run as running', 60_000, 250);
  assert.equal(stillRunning, true, 'the original Run is restored, not interrupted');
  const [attemptAfter] = attemptsOf(scratch.root, runId, 'node-b');
  assert.equal(attemptAfter.id, attemptB, 'Node B keeps its Attempt identity');
  assert.equal(attemptAfter.pid, bRunning.pid, 'Node B keeps its Codex process');
  assert.equal(processIdentity(bRunning.pid), codexIdentity, 'the Codex process creation identity is unchanged');
  assert.equal(settledCount(scratch.root, runId, 'node-a'), 1, 'Node A remains accepted once');
  mark('engine-b-reattached', { engineBPid: engineB.pid, epochB, codexPid: bRunning.pid });

  writeAtomically(releasePath, { schemaVersion: 1, releaseToken: ready.releaseToken, engineBReattached: true, releasedAt: new Date().toISOString() });
  mark('gate-released');

  const finalState = await waitForRunState(engineB, runId, SETTLED, 900_000);
  assert.equal(finalState, 'succeeded', 'the original Run reaches succeeded under Engine B');
  mark('run-final', { state: finalState });

  const [bDone] = attemptsOf(scratch.root, runId, 'node-b');
  const launches = hostRecords(host).length;
  assert.equal(custodyOf(scratch.root, runId).length, 1, 'exactly one Custody invocation exists for the Run');
  assert.equal(custodyOf(scratch.root, runId)[0].custody_id, custodyBefore.custody_id, 'the Custody invocation is the original one');
  assert.equal(bDone.state, 'succeeded');
  assert.equal(bDone.pid, bRunning.pid, 'the Codex process did not change');
  assert.equal(settledCount(scratch.root, runId, 'node-a'), 1, 'Node A executed once');
  assert.equal(settledCount(scratch.root, runId, 'node-b'), 1, 'Node B settled exactly once');
  assert.equal(settledCount(scratch.root, runId, 'node-c'), 1, 'Node C dispatched exactly once');
  const events = journal(scratch.root, runId);
  const bAccepted = events.find(event => event.node === 'node-b' && event.payload?.to === 'succeeded').sequence;
  const cAccepted = events.find(event => event.node === 'node-c' && event.payload?.to === 'succeeded').sequence;
  assert.ok(bAccepted < cAccepted, 'Node C is accepted only after Node B is accepted');
  assert.equal(runRow(scratch.root, runId).publishedVersionId, publication.publishedVersionId, 'the Run stays bound to its published version');

  // Independent verification of the project, outside Deszo and outside the Run.
  const tests = command('node', ['--test'], { cwd: workspace, timeout: 120_000 });
  assert.equal(tests.status, 0, `the project test suite passes: ${tests.stdout}${tests.stderr}`);
  const probe = command('node', ['--input-type=module', '-e', "import { normalizeCount } from './src/normalize.mjs'; console.log(JSON.stringify([normalizeCount('12'), normalizeCount('0'), normalizeCount(4), normalizeCount('-1'), normalizeCount('1.5'), normalizeCount('x1')]));"], { cwd: workspace });
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout), [12, 0, 4, 0, 0, 0], 'the decimal-string contract holds and invalid values stay 0');
  evidence.run = { runId, publishedVersionId: publication.publishedVersionId, finalState, nodes: { a: 'node-a', b: 'node-b', c: 'node-c' } };
  evidence.attempts = { a: attemptsOf(scratch.root, runId, 'node-a')[0].id, b: attemptB, c: attemptsOf(scratch.root, runId, 'node-c')[0].id };
  evidence.codex = { pid: bRunning.pid, identity: codexIdentity, custodyId: custodyBefore.custody_id, hostRecords: launches };
  evidence.settlements = { a: settledCount(scratch.root, runId, 'node-a'), b: settledCount(scratch.root, runId, 'node-b'), c: settledCount(scratch.root, runId, 'node-c') };
  evidence.independent = { projectTests: 'pass', normalizeCountProbe: JSON.parse(probe.stdout) };
  evidence.journal = events.filter(event => ['attempt.state_changed', 'run.state_changed', 'continuation.reconciled'].includes(event.type))
    .map(event => ({ sequence: event.sequence, type: event.type, node: event.node, attemptId: event.attemptId, from: event.payload?.from ?? null, to: event.payload?.to ?? null, reason: event.payload?.reason ?? null }));
  evidence.storeRoot = scratch.root;
  evidence.verdict = 'P1 REAL CODEX CONTINUATION VERIFIED';
} catch (error) {
  evidence.verdict = 'P1 NOT VERIFIED';
  evidence.error = String(error.message || error).slice(0, 4000);
  throw error;
} finally {
  if (engineB) await engineB.stop().catch(() => engineB.kill());
  engineA.kill();
  await host.shutdown().catch(() => host.crash());
  mkdirSync(join(repo, 'docs/reviews/evidence'), { recursive: true });
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  // The Engine store is kept: the journal evidence above is the audit record, and the store is its source.
}
