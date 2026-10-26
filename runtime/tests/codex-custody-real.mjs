// Opt-in real-provider proof. This is deliberately not a *.test.mjs file: it makes one live Codex inference.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { detectProvider } from '../core/adapters.mjs';
import {
  attemptsOf, buildArtifacts, committedChunks, custodyBindings, database, eventually, exited, hostRecords,
  isAlive, newScratch, processIdentity, runEventTypes, runState, sha256File, startAgentRun, startCustodyHost,
  startEngine, waitForRunState,
} from './custody-support.mjs';

const repo = resolve(import.meta.dirname, '../..');
const evidencePath = join(repo, 'docs/reviews/evidence/2026-10-25-codex-custody-real.json');
const validateOnly = process.argv.includes('--validate-only');
const modelArg = process.argv.indexOf('--model');
const model = modelArg >= 0 ? process.argv[modelArg + 1] : '';
if (!validateOnly && (!model || model.startsWith('-'))) throw new Error('Supply the exact workflow model explicitly with --model MODEL. No model fallback is used.');

function command(executable, args, { cwd, timeout = 120_000 } = {}) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} ${args.join(' ')} failed (${result.status ?? result.signal}):\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function git(cwd, ...args) { return command('git', ['-C', cwd, ...args], { cwd: repo }); }

function writeProject(workspace) {
  mkdirSync(join(workspace, 'src'), { recursive: true });
  mkdirSync(join(workspace, 'test'), { recursive: true });
  mkdirSync(join(workspace, 'tools'), { recursive: true });
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({
    name: 'deszo-codex-custody-proof', version: '1.0.0', private: true, type: 'module',
  }, null, 2) + '\n');
  writeFileSync(join(workspace, 'src/normalize.mjs'), 'export function normalizeCount(value) {\n  return Number.isInteger(value) && value >= 0 ? value : 0;\n}\n');
  writeFileSync(join(workspace, 'test/normalize.test.mjs'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { normalizeCount } from '../src/normalize.mjs';",
    "test('keeps non-negative integers', () => { assert.equal(normalizeCount(4), 4); assert.equal(normalizeCount(0), 0); });",
    "test('maps invalid values to zero', () => { assert.equal(normalizeCount(-1), 0); assert.equal(normalizeCount('4'), 0); });",
    '',
  ].join('\n'));
  writeFileSync(join(workspace, 'tools/engine-replacement-gate.mjs'), `import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function option(name, fallback) { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; }
function projectPath(path) {
  const full = resolve(root, path);
  if (full === root || !full.toLowerCase().startsWith(root.toLowerCase() + sep)) throw new Error('Gate marker path must stay inside the disposable project.');
  return full;
}
const readyPath = projectPath(option('--ready', 'tools/.engine-replacement.READY.json'));
const releasePath = projectPath(option('--release', 'tools/.engine-replacement.RELEASE.json'));
const releasedPath = projectPath(option('--released', 'tools/.engine-replacement.RELEASED.json'));
const timeoutMs = Number(option('--timeout-ms', '300000'));
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900000) throw new Error('Gate timeout must be between 1000 and 900000 milliseconds.');
if (existsSync(readyPath) || existsSync(releasePath) || existsSync(releasedPath)) throw new Error('Gate marker already exists.');
function atomicJson(path, value) {
  const temporary = path + '.' + process.pid + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\\n', { flag: 'wx' });
  renameSync(temporary, path);
}
const releaseToken = randomUUID();
const startedAt = new Date().toISOString();
atomicJson(readyPath, { schemaVersion: 1, pid: process.pid, parentPid: process.ppid, startedAt, nodeVersion: process.version, releaseToken });
console.log('ENGINE_REPLACEMENT_GATE_READY ' + process.pid + ' ' + startedAt);
const deadline = Date.now() + timeoutMs;
while (Date.now() <= deadline) {
  if (existsSync(releasePath)) {
    const release = JSON.parse(readFileSync(releasePath, 'utf8'));
    if (release.schemaVersion !== 1 || release.releaseToken !== releaseToken || release.engineBReattached !== true || !Number.isFinite(Date.parse(release.releasedAt))) {
      console.error('ENGINE_REPLACEMENT_GATE_INVALID_RELEASE');
      process.exit(2);
    }
    const releasedAt = new Date().toISOString();
    atomicJson(releasedPath, { schemaVersion: 1, pid: process.pid, startedAt, releasedAt, engineBPid: release.engineBPid, engineBEpoch: release.engineBEpoch });
    console.log('ENGINE_REPLACEMENT_GATE_RELEASED ' + process.pid + ' ' + releasedAt);
    process.exit(0);
  }
  await delay(100);
}
console.error('ENGINE_REPLACEMENT_GATE_TIMEOUT');
process.exit(124);
`);
  writeFileSync(join(workspace, 'README.md'), '# normalizeCount\n\n`normalizeCount(value)` accepts non-negative integer numbers. Other values return `0`.\n\nThe proof project includes `tools/engine-replacement-gate.mjs`; the harness releases it only after Engine B reattaches. Do not modify the gate or create its RELEASE marker.\n');
}

function artifactBytes(root, artifactId) {
  const db = database(root);
  let row;
  try { row = db.prepare('SELECT sha256, byte_size, relative_path FROM artifacts WHERE id = ?').get(artifactId); }
  finally { db.close(); }
  assert.ok(row, `artifact ${artifactId} exists`);
  const bytes = readFileSync(join(root, 'store', row.relative_path));
  assert.equal(bytes.length, row.byte_size);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), row.sha256);
  return bytes;
}

function committedStream(root, attemptId, stream) {
  const chunks = committedChunks(root, attemptId, stream);
  let offset = 0;
  const buffers = chunks.map(chunk => {
    assert.equal(chunk.byteOffset, offset, `${stream} chunks are contiguous and not duplicated`);
    const bytes = artifactBytes(root, chunk.chunk.artifactId);
    assert.equal(bytes.length, chunk.byteLength);
    offset += bytes.length;
    return bytes;
  });
  return { bytes: Buffer.concat(buffers), chunks: chunks.length };
}

function acknowledgedStdoutCutover(record, custodyId, committedLength) {
  if (!record || record.custodyId !== custodyId || record.state !== 'running') return false;
  return Number.isSafeInteger(record.stdoutAcked) && record.stdoutAcked > 0
    && record.stdoutAcked === committedLength && record.stdoutAcked <= record.stdoutDurable;
}

function processEpoch(host) {
  return JSON.parse(readFileSync(join(host.state, 'custody', 'epoch.json'), 'utf8')).epoch;
}

function countDeszoBridgeDescendants(rootPid) {
  const script = `
$rootPid = ${Number(rootPid)}
$all = @(Get-CimInstance Win32_Process)
$seen = [System.Collections.Generic.HashSet[int]]::new()
[void]$seen.Add($rootPid)
$found = 0
do {
  $changed = $false
  foreach ($process in $all) {
    if ($seen.Contains([int]$process.ParentProcessId) -and $seen.Add([int]$process.ProcessId)) {
      if ($process.CommandLine -match '(?i)bridge\\.mjs' -and $process.CommandLine -match '--connection-file') { $found++ }
      $changed = $true
    }
  }
} while ($changed)
$found
`;
  const observed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  if (observed.status !== 0) throw new Error('Could not inspect the real Codex process tree for Deszo bridge children.');
  return Number(observed.stdout.trim());
}

function hostSpool(host, custodyId, stream) {
  return readFileSync(join(host.state, 'custody', 'spool', custodyId, stream + '.bin'));
}

function verifyNodeTestCommand() {
  const resolved = spawnSync('where.exe', ['node.exe'], { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  if (resolved.status !== 0) throw new Error(`Could not resolve node.exe before Codex launch: ${resolved.stderr}`);
  const firstPath = resolve(resolved.stdout.split(/\r?\n/).find(Boolean).trim());
  assert.equal(firstPath.toLowerCase(), resolve(process.execPath).toLowerCase(), 'the `node` test command resolves to the Node executable running this harness');
  const version = command('node', ['--version'], { cwd: repo, timeout: 10_000 });
  assert.equal(version, process.version, 'the PATH Node version matches the harness Node version');
  return { command: 'node --test', executable: firstPath, version };
}

function runTests(workspace) {
  const result = spawnSync('node', ['--test'], { cwd: workspace, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}

function testSummary(output) {
  const value = name => {
    const match = output.match(new RegExp(`^# ${name} (\\d+)$`, 'm'));
    return match ? Number(match[1]) : null;
  };
  const tests = value('tests'), passed = value('pass'), failed = value('fail');
  return tests === null || passed === null || failed === null ? null : { tests, passed, failed };
}

function writeJsonAtomically(path, value) {
  const temporary = path + '.' + process.pid + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  renameSync(temporary, path);
}

function spawnGate(workspace, readyRelative, releaseRelative, releasedRelative, timeoutMs) {
  const child = spawn('node', ['tools/engine-replacement-gate.mjs', '--ready', readyRelative, '--release', releaseRelative,
    '--released', releasedRelative, '--timeout-ms', String(timeoutMs)], { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return { child, stdout: () => stdout, stderr: () => stderr };
}

async function validateGateScript(workspace) {
  const makePaths = label => {
    const name = `.engine-replacement-${label}-${randomUUID()}`;
    return { ready: `tools/${name}.READY.json`, release: `tools/${name}.RELEASE.json`, released: `tools/${name}.RELEASED.json` };
  };
  const absolute = path => join(workspace, path);
  const validPaths = makePaths('valid');
  let valid = spawnGate(workspace, validPaths.ready, validPaths.release, validPaths.released, 10_000);
  try {
    const readyPath = absolute(validPaths.ready), releasePath = absolute(validPaths.release), releasedPath = absolute(validPaths.released);
    const ready = await eventually(() => existsSync(readyPath) ? JSON.parse(readFileSync(readyPath, 'utf8')) : null, 'the standalone gate to atomically publish READY', 8_000, 50);
    assert.equal(ready.pid, valid.child.pid);
    assert.equal(isAlive(ready.pid), true);
    const identity = processIdentity(ready.pid);
    assert.ok(identity, 'the gate process has an observable Windows creation identity');
    writeJsonAtomically(releasePath, { schemaVersion: 1, releaseToken: ready.releaseToken, engineBReattached: true,
      engineBPid: 1, engineBEpoch: 1, releasedAt: new Date().toISOString() });
    const released = await eventually(() => existsSync(releasedPath) ? JSON.parse(readFileSync(releasedPath, 'utf8')) : null,
      'the valid RELEASE to produce a RELEASED marker', 5_000, 50);
    assert.equal(released.pid, ready.pid);
    await eventually(() => exited(valid.child), 'the valid gate process to exit', 5_000, 50);
    assert.equal(valid.child.exitCode, 0, valid.stderr());
    assert.equal(isAlive(ready.pid), false);
  } finally {
    if (valid && !exited(valid.child)) valid.child.kill();
    for (const path of Object.values(validPaths)) rmSync(absolute(path), { force: true });
  }

  const invalidPaths = makePaths('invalid');
  let invalid = spawnGate(workspace, invalidPaths.ready, invalidPaths.release, invalidPaths.released, 10_000);
  try {
    const readyPath = absolute(invalidPaths.ready), releasePath = absolute(invalidPaths.release), releasedPath = absolute(invalidPaths.released);
    const ready = await eventually(() => existsSync(readyPath) ? JSON.parse(readFileSync(readyPath, 'utf8')) : null, 'the gate READY marker for invalid-release validation', 8_000, 50);
    writeJsonAtomically(releasePath, { schemaVersion: 1, releaseToken: 'invalid', engineBReattached: true, releasedAt: new Date().toISOString() });
    await eventually(() => exited(invalid.child), 'the gate to reject an invalid RELEASE', 5_000, 50);
    assert.equal(invalid.child.exitCode, 2, invalid.stderr());
    assert.equal(existsSync(releasedPath), false, 'an invalid release cannot produce a successful RELEASED marker');
    assert.equal(isAlive(ready.pid), false);
  } finally {
    if (invalid && !exited(invalid.child)) invalid.child.kill();
    for (const path of Object.values(invalidPaths)) rmSync(absolute(path), { force: true });
  }

  const timeoutPaths = makePaths('timeout');
  let timed = spawnGate(workspace, timeoutPaths.ready, timeoutPaths.release, timeoutPaths.released, 1_000);
  try {
    const readyPath = absolute(timeoutPaths.ready), releasedPath = absolute(timeoutPaths.released);
    await eventually(() => existsSync(readyPath), 'the gate READY marker for timeout validation', 8_000, 50);
    await eventually(() => exited(timed.child), 'the gate to enforce its finite timeout', 5_000, 50);
    assert.equal(timed.child.exitCode, 124, timed.stderr());
    assert.equal(existsSync(releasedPath), false, 'timeout cannot produce a successful RELEASED marker');
  } finally {
    if (timed && !exited(timed.child)) timed.child.kill();
    for (const path of Object.values(timeoutPaths)) rmSync(absolute(path), { force: true });
  }
  return { validReleaseExitCode: 0, invalidReleaseExitCode: 2, timeoutExitCode: 124, finiteTimeoutMilliseconds: 1_000 };
}

function projectSnapshot(workspace, { exclude = [] } = {}) {
  const excluded = new Set(exclude.map(path => path.replaceAll('\\', '/')));
  const files = {};
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (directory === workspace && entry.name === '.git') continue;
      const full = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink in disposable project: ${full}`);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const path = relative(workspace, full).replaceAll('\\', '/');
        if (!excluded.has(path)) files[path] = sha256File(full);
      }
    }
  };
  walk(workspace);
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

function snapshotDigest(snapshot) {
  return createHash('sha256').update(Object.entries(snapshot).map(([path, hash]) => `${path}\0${hash}\n`).join('')).digest('hex');
}

function checkNoIndexWhitespace(workspace, baselineRoot, files) {
  for (const file of files) {
    const result = spawnSync('git', ['-c', 'core.autocrlf=false', 'diff', '--no-index', '--check', '--', join(baselineRoot, file), join(workspace, file)],
      { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    assert.ok(result.status === 0 || result.status === 1, `Git whitespace check failed for ${file}: ${result.stderr}`);
    assert.equal(`${result.stdout}${result.stderr}`.trim(), '', `Git found whitespace errors in ${file}`);
  }
  return { files: [...files].sort(), noIndexChecks: files.length, diagnostics: 0 };
}

function workspaceHold(root, attemptId) {
  const db = database(root);
  try { return db.prepare('SELECT state, evidence_json FROM custody_workspace_holds WHERE attempt_id = ?').get(attemptId) ?? null; }
  finally { db.close(); }
}

function runnerLock(root) {
  const path = join(root, 'runtime', 'runner.lock');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

function providerJsonl(bytes) {
  return bytes.toString('utf8').split(/\r?\n/).filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function isProcessDescendant(rootPid, targetPid) {
  if (!rootPid || !targetPid || Number(rootPid) === Number(targetPid)) return false;
  const script = `
$root = [int]${Number(rootPid)}
$target = [int]${Number(targetPid)}
$all = @(Get-CimInstance Win32_Process)
$parents = @{}
foreach ($process in $all) { $parents[[int]$process.ProcessId] = [int]$process.ParentProcessId }
$seen = [System.Collections.Generic.HashSet[int]]::new()
$cursor = $target
while ($parents.ContainsKey($cursor) -and $seen.Add($cursor)) {
  $cursor = $parents[$cursor]
  if ($cursor -eq $root) { 'true'; exit 0 }
}
'false'
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  if (result.status !== 0) throw new Error(`Could not verify process ancestry for ${targetPid}: ${result.stderr}`);
  return result.stdout.trim().toLowerCase() === 'true';
}

function terminalEvents(bytes) {
  return bytes.toString('utf8').split(/\r?\n/).filter(Boolean).flatMap(line => {
    try { const item = JSON.parse(line); return ['turn.completed', 'turn.failed', 'error'].includes(item.type) ? [item.type] : []; }
    catch { return []; }
  });
}

function providerEventSummaries(bytes) {
  return providerJsonl(bytes).map((event, index) => ({
    index,
    type: typeof event.type === 'string' ? event.type : null,
    itemType: typeof event.item?.type === 'string' ? event.item.type : null,
    command: typeof event.item?.command === 'string' ? redactedDiagnostic(event.item.command) : undefined,
    exitCode: Number.isInteger(event.item?.exit_code) ? event.item.exit_code : undefined,
    errorCode: typeof event.error?.code === 'string' ? event.error.code : undefined,
    errorMessage: typeof (event.error?.message ?? event.message) === 'string'
      ? redactedDiagnostic(event.error?.message ?? event.message).slice(0, 2_000) : undefined,
  }));
}

if (validateOnly) {
  const nodeTestCommand = verifyNodeTestCommand();
  const workspace = mkdtempSync(join(resolve(repo, '..'), 'deszo-codex-custody-harness-validation-'));
  try {
    assert.equal(resolve(workspace).toLowerCase().startsWith(resolve(repo).toLowerCase() + '\\'), false, 'validation project is outside Deszo');
    assert.equal(resolve(workspace).toLowerCase().startsWith(resolve(homedir()).toLowerCase() + '\\'), false, 'validation project is outside the user profile');
    writeProject(workspace);
    const baselineTests = runTests(workspace);
    assert.equal(baselineTests.exitCode, 0, baselineTests.stderr || baselineTests.stdout);
    assert.deepEqual(testSummary(baselineTests.stdout), { tests: 2, passed: 2, failed: 0 });
    assert.equal(acknowledgedStdoutCutover({ custodyId: 'proof', state: 'running', stdoutAcked: 0, stdoutDurable: 626 }, 'proof', 626), false,
      'a stale pre-ACK Host snapshot cannot authorize replacement');
    assert.equal(acknowledgedStdoutCutover({ custodyId: 'proof', state: 'running', stdoutAcked: 626, stdoutDurable: 626 }, 'proof', 626), true,
      'a fresh Host ACK matching committed bytes can authorize replacement');
    const gate = await validateGateScript(workspace);
    const whitespaceBaseline = mkdtempSync(join(resolve(repo, '..'), 'deszo-codex-custody-whitespace-baseline-'));
    const whitespaceCandidate = mkdtempSync(join(resolve(repo, '..'), 'deszo-codex-custody-whitespace-candidate-'));
    let whitespace;
    try {
      writeFileSync(join(whitespaceBaseline, 'sample.txt'), 'before\n');
      writeFileSync(join(whitespaceCandidate, 'sample.txt'), 'after\n');
      whitespace = checkNoIndexWhitespace(whitespaceCandidate, whitespaceBaseline, ['sample.txt']);
      writeFileSync(join(whitespaceCandidate, 'sample.txt'), 'after \n');
      const bad = spawnSync('git', ['-c', 'core.autocrlf=false', 'diff', '--no-index', '--check', '--', join(whitespaceBaseline, 'sample.txt'), join(whitespaceCandidate, 'sample.txt')],
        { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
      assert.equal(bad.status, 3, 'the no-index whitespace probe finds the introduced trailing space');
      assert.match(`${bad.stdout}${bad.stderr}`, /trailing whitespace/i);
    } finally {
      rmSync(whitespaceBaseline, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      rmSync(whitespaceCandidate, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
    process.stdout.write(JSON.stringify({ mode: 'validate-only', liveInference: false, nodeTestCommand, baselineTestExitCode: baselineTests.exitCode,
      baselineTestSummary: testSummary(baselineTests.stdout), gate, noIndexWhitespaceCheck: whitespace }, null, 2) + '\n');
  } finally { rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  process.exit(0);
}

const provider = await detectProvider('codex', { processCustody: true });
if (!provider.available || !provider.cliPath) throw new Error(provider.reason || 'Codex CLI is unavailable.');
if (provider.supportsCustodyExec !== true) throw new Error(provider.custodyReason || 'Installed Codex CLI does not support Custody execution.');
assert.match(provider.cliPath.toLowerCase(), /\.exe$/i, 'Process Custody must launch the native Codex executable directly.');
const executableHash = sha256File(provider.cliPath);
const nodeTestCommand = verifyNodeTestCommand();
const hostArtifacts = buildArtifacts();
const scratch = newScratch('real-codex-stage1');
const workspace = mkdtempSync(join(resolve(repo, '..'), 'deszo-codex-custody-workspace-'));
const baselineRoot = mkdtempSync(join(resolve(repo, '..'), 'deszo-codex-custody-baseline-'));
const readyRelative = 'tools/.engine-replacement.READY.json';
const releaseRelative = 'tools/.engine-replacement.RELEASE.json';
const releasedRelative = 'tools/.engine-replacement.RELEASED.json';
const readyPath = join(workspace, readyRelative);
const releasePath = join(workspace, releaseRelative);
const releasedPath = join(workspace, releasedRelative);
let host = null, engineA = null, engineB = null, publishedVersionId = null, runId = null, attemptId = null, custodyId = null;
let hostRecord = null, hostRecordAtLaunch = null, attempt = null, gateReady = null, gateReleased = null, result = null, failure = null;
let engineAPid = null, engineBPid = null, codexObservedIdentity = null, gateObservedIdentity = null, engineAIdentity = null, engineBIdentity = null;
let epochA = null, epochB = null, lockA = null, lockB = null, committedBefore = null, normalizedBefore = null, committedAfterAttach = null;
let ackAtCutover = null, finalRunState = null, finalAttempt = null, finalStatus = null, finalRecord = null, baselineTests = null, testResult = null;
let initialSnapshot = null, initialTreeSha256 = null, finalSnapshot = null, projectChangedFiles = [], codexCommandItems = [], workspaceReleaseAt = null;
const timeline = [];
const mark = (event, detail = {}) => {
  const item = { event, observedAt: new Date().toISOString(), ...detail };
  timeline.push(item);
  return item;
};
const expectedChangedFiles = ['README.md', 'src/normalize.mjs', 'test/normalize.test.mjs'];
const gateMarkerPaths = [readyRelative, releaseRelative, releasedRelative];

function redactedError(error) {
  return String(error?.message ?? error).replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]').replace(/sk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]');
}

function redactedDiagnostic(value) {
  return String(value).replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]').replace(/sk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]');
}

function persistedRunState() {
  if (!runId) return null;
  try {
    const db = database(scratch.root);
    try { return db.prepare('SELECT state FROM runs WHERE id = ?').get(runId)?.state ?? null; }
    finally { db.close(); }
  } catch { return null; }
}

function processAncestryOrUnknown(rootPid, targetPid) {
  try { return isProcessDescendant(rootPid, targetPid); } catch { return null; }
}

function collectPartialEvidence(status, error = null) {
  const records = host ? hostRecords(host) : [];
  const record = records.find(item => item.custodyId === custodyId) ?? records[0] ?? null;
  let raw = Buffer.alloc(0), stderr = Buffer.alloc(0), attemptRows = [];
  if (host && custodyId) { try { raw = hostSpool(host, custodyId, 'stdout'); } catch { /* No spool file yet. */ } }
  if (host && custodyId) { try { stderr = hostSpool(host, custodyId, 'stderr'); } catch { /* No spool file yet. */ } }
  if (runId) { try { attemptRows = attemptsOf(scratch.root, runId); } catch { /* Store may not exist. */ } }
  const gateLive = gateReady ? isAlive(gateReady.pid) : false;
  return {
    schemaVersion: 2,
    status,
    verdict: 'REAL CODEX CUSTODY NOT VERIFIED',
    verifiedAt: new Date().toISOString(),
    failure: error ? { message: redactedError(error) } : null,
    environment: { node: process.version, codexCliVersion: provider.cliVersion, selectedModel: model,
      authenticationMode: 'Existing ChatGPT sign-in; credentials are not recorded.', selectedProtocol: 'codex exec --json' },
    workflow: { runId, attemptId, custodyId, publishedVersionId, runState: persistedRunState(),
      attemptState: attemptRows.find(row => row.id === attemptId)?.state ?? null },
    processes: { hostPid: host?.pid ?? null, engineAPid, engineBPid, codexPid: record?.processId ?? attempt?.process_id ?? null,
      codexProcessCreationIdentity: record?.processCreationTime ?? null, codexPowerShellCreationIdentity: codexObservedIdentity,
      gatePid: gateReady?.pid ?? null, gateProcessCreationIdentity: gateObservedIdentity, gateAliveAtCapture: gateLive,
      engineAIdentity, engineBIdentity, hostRecordState: record?.state ?? null, hostExitCode: record?.exitCode ?? null,
      hostLaunchCount: records.length },
    barrier: { readyObserved: Boolean(gateReady), readyStartedAt: gateReady?.startedAt ?? null,
      readyObservedWhileCodexAlive: Boolean(gateReady && record && isAlive(record.processId) && gateLive),
      gateWasCodexDescendant: gateReady ? processAncestryOrUnknown(record?.processId, gateReady.pid) : false,
      engineAEnded: Boolean(engineA && exited(engineA.child)), codexSurvivedEngineA: Boolean(engineA && exited(engineA.child) && record && isAlive(record.processId)),
      engineBReattachedAt: timeline.find(item => item.event === 'engine-b-custody-reattached')?.observedAt ?? null,
      releaseWrittenAt: timeline.find(item => item.event === 'gate-release-written')?.observedAt ?? null,
      releasedAt: gateReleased?.releasedAt ?? null },
    streams: { stdoutBytesObserved: raw.length, stderrBytesObserved: stderr.length, stdoutEventTypes: providerJsonl(raw).map(item => item.type).filter(Boolean),
      stdoutSha256: raw.length ? createHash('sha256').update(raw).digest('hex') : null,
      stderrSha256: stderr.length ? createHash('sha256').update(stderr).digest('hex') : null,
      stdoutSpoolPath: host && custodyId ? relative(repo, join(host.state, 'custody', 'spool', custodyId, 'stdout.bin')).replaceAll('\\', '/') : null,
      stderrSpoolPath: host && custodyId ? relative(repo, join(host.state, 'custody', 'spool', custodyId, 'stderr.bin')).replaceAll('\\', '/') : null,
      stdoutEventSummaries: providerEventSummaries(raw),
      stdoutBytesCommittedAtCutover: committedBefore?.bytes.length ?? null, stdoutAckedAtCutover: ackAtCutover },
    timeline: [...timeline],
    custodyStateRoot: scratch ? relative(repo, scratch.root).replaceAll('\\', '/') : null,
    workspace: { isolatedOutsideDeszo: true, isolatedOutsideUserProfile: true,
      path: workspace, baselineTreeSha256: initialTreeSha256, changedFilesObserved: projectChangedFiles },
  };
}

function saveEvidence(value) {
  mkdirSync(join(repo, 'docs/reviews/evidence'), { recursive: true });
  writeFileSync(evidencePath, JSON.stringify(value, null, 2) + '\n');
}

try {
  assert.equal(resolve(workspace).toLowerCase().startsWith(resolve(repo).toLowerCase() + '\\'), false, 'real task workspace is outside Deszo');
  assert.equal(resolve(workspace).toLowerCase().startsWith(resolve(homedir()).toLowerCase() + '\\'), false, 'real task workspace is outside the user profile');
  writeProject(workspace);
  initialSnapshot = projectSnapshot(workspace);
  initialTreeSha256 = snapshotDigest(initialSnapshot);
  for (const [path, hash] of Object.entries(initialSnapshot)) {
    const baselinePath = join(baselineRoot, path);
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, readFileSync(join(workspace, path)));
    assert.equal(sha256File(baselinePath), hash, `baseline copy matches ${path}`);
  }
  baselineTests = runTests(workspace);
  assert.equal(baselineTests.exitCode, 0, baselineTests.stderr || baselineTests.stdout);
  assert.deepEqual(testSummary(baselineTests.stdout), { tests: 2, passed: 2, failed: 0 });
  mark('node-test-command-verified', { command: nodeTestCommand.command, executable: nodeTestCommand.executable, version: nodeTestCommand.version,
    baselineTestExitCode: baselineTests.exitCode, baselineTestSummary: testSummary(baselineTests.stdout) });

  command('git', ['-C', workspace, 'init', '--quiet'], { cwd: repo });
  assert.equal(git(workspace, 'diff', '--cached', '--name-only').trim(), '', 'the disposable project starts with no staged files');
  const initialHead = spawnSync('git', ['-C', workspace, 'rev-parse', '--verify', 'HEAD'], { cwd: repo, encoding: 'utf8', windowsHide: true });
  assert.notEqual(initialHead.status, 0, 'the no-commit proof project has no initial commit');
  mark('disposable-project-created', { workspaceOutsideDeszo: true, workspaceOutsideUserProfile: true,
    baselineTreeSha256: initialTreeSha256, initialStagedFiles: 0, initialCommitCount: 0 });

  host = await startCustodyHost(scratch.root, { allowedExecutables: [{ path: provider.cliPath, sha256: executableHash }] });
  mark('host-started', { hostPid: host.pid, hostSha256: sha256File(hostArtifacts.hostExe) });
  engineA = await startEngine(scratch.root, host, { fixtureProvider: false, isolateCodexHome: false, devTestConfirmationOff: true });
  engineAPid = engineA.pid;
  engineAIdentity = processIdentity(engineAPid);
  lockA = await eventually(() => runnerLock(scratch.root), 'Engine A runner.lock ownership', 30_000, 100);
  assert.equal(lockA.pid, engineAPid, 'runner.lock names Engine A');
  mark('engine-a-started', { engineAPid, engineAIdentity, runnerLockOwner: lockA });

  const started = await startAgentRun(engineA, {
    workflowId: 'real-codex-custody-stage1', model,
    requestText: [
      'Before inspecting or changing project source, run `node tools/engine-replacement-gate.mjs` as a foreground command and wait for it to finish successfully.',
      'The gate writes a READY marker and waits. The proof harness creates its RELEASE marker only after Engine B has reattached. Do not create or edit gate markers, do not run the gate in the background, and do not modify the gate script.',
      'After the gate exits successfully, update src/normalize.mjs so normalizeCount accepts decimal strings containing only base-10 digits, including "0", as non-negative integer values.',
      'Preserve existing behavior for non-negative integer numbers and invalid values. Add a regression test in test/normalize.test.mjs and update the README contract.',
      'Only modify src/normalize.mjs, test/normalize.test.mjs, and README.md. Do not change package.json or the proof harness. Do not stage, commit, push, or access the network.',
      'Run the verified project test command `node --test` after the changes. Do not use npm. Report the exact test result and changed files.',
    ].join('\n'),
    workspaceCwd: workspace, timeoutSeconds: 600,
  });
  runId = started.runId;
  publishedVersionId = started.publishedVersionId;
  mark('run-admitted', { runId, publishedVersionId, launchRequested: true });
  attempt = await eventually(() => attemptsOf(scratch.root, runId).find(row => row.process_id), 'the real Codex process to launch', 180_000, 100);
  attemptId = attempt.id;
  hostRecord = await eventually(() => hostRecords(host).find(record => record.attemptId === attemptId && record.state === 'running'),
    'the Rust Host to admit and run Codex', 60_000, 100);
  hostRecordAtLaunch = { ...hostRecord };
  custodyId = hostRecord.custodyId;
  assert.equal(hostRecord.provider, 'codex');
  assert.equal(hostRecord.processId, attempt.process_id);
  assert.equal(hostRecords(host).length, 1, 'the Host has exactly one real provider invocation');
  assert.equal(isAlive(hostRecord.processId), true);
  codexObservedIdentity = processIdentity(hostRecord.processId);
  assert.ok(codexObservedIdentity, 'Windows reports the real Codex creation identity');
  mark('codex-launched', { hostPid: host.pid, engineAPid, codexPid: hostRecord.processId,
    codexProcessCreationIdentity: hostRecordAtLaunch.processCreationTime, codexPowerShellCreationIdentity: codexObservedIdentity,
    hostAdmissionState: hostRecordAtLaunch.state, hostRecordCreatedAt: hostRecordAtLaunch.createdAt, hostRecordUpdatedAt: hostRecordAtLaunch.updatedAt,
    custodyInvocationId: custodyId, attemptId, runId, hostLaunchCount: hostRecords(host).length });

  gateReady = await eventually(() => {
    if (existsSync(readyPath)) return JSON.parse(readFileSync(readyPath, 'utf8'));
    const current = hostRecords(host).find(record => record.custodyId === custodyId);
    if (current?.state === 'exited') throw new Error(`Codex exited with code ${current.exitCode} before its in-task gate published READY.`);
    return null;
  }, 'Codex to invoke its in-task gate and publish READY', 300_000, 100);
  gateObservedIdentity = processIdentity(gateReady.pid);
  assert.ok(gateObservedIdentity, 'Windows reports the gate process creation identity');
  assert.equal(isAlive(gateReady.pid), true, 'the gate process is alive at READY');
  assert.equal(isProcessDescendant(hostRecord.processId, gateReady.pid), true, 'the gate was started in the real Codex process tree');
  mark('gate-ready-observed', { gatePid: gateReady.pid, gateParentPid: gateReady.parentPid, gateStartedAt: gateReady.startedAt,
    gateObservedCreationIdentity: gateObservedIdentity, codexAlive: isAlive(hostRecord.processId),
    codexProcessCreationIdentity: codexObservedIdentity, codexIsGateAncestor: true });

  const activeAttempt = attemptsOf(scratch.root, runId).find(row => row.id === attemptId);
  assert.equal(activeAttempt.state, 'running', 'the original attempt remains running at the gate');
  assert.equal(await runState(engineA, runId), 'running', 'the original Run has no terminal result at the gate');
  const holdAtCutover = workspaceHold(scratch.root, attemptId);
  assert.equal(holdAtCutover?.state, 'held', 'the workspace hold remains held at the gate');
  assert.equal(isAlive(host.pid), true, 'Host is alive before Engine replacement');
  assert.equal(isAlive(hostRecord.processId), true, 'Codex is alive before Engine replacement');
  assert.equal(processIdentity(hostRecord.processId), codexObservedIdentity);
  assert.equal(isAlive(gateReady.pid), true);
  assert.equal(processIdentity(gateReady.pid), gateObservedIdentity);
  assert.equal(existsSync(releasePath), false, 'RELEASE has not been written before Engine B reattaches');
  assert.equal(existsSync(releasedPath), false);
  const deszoBridgeProcessesAtReplacement = countDeszoBridgeDescendants(hostRecord.processId);
  assert.equal(deszoBridgeProcessesAtReplacement, 0, 'the exact-version --ignore-user-config neutralizer starts no user-profile Deszo bridge');
  epochA = processEpoch(host);
  const acknowledgedAtCutover = await eventually(() => {
    const current = hostRecords(host).find(record => record.custodyId === custodyId);
    const committed = committedStream(scratch.root, attemptId, 'stdout');
    return acknowledgedStdoutCutover(current, custodyId, committed.bytes.length) ? { record: current, committed } : null;
  }, 'Engine A to commit and acknowledge the initial Codex JSONL before replacement', 30_000, 100);
  hostRecord = acknowledgedAtCutover.record;
  committedBefore = acknowledgedAtCutover.committed;
  ackAtCutover = hostRecord.stdoutAcked;
  assert.equal(await runState(engineA, runId), 'running', 'the original Run remains active immediately before replacement');
  assert.equal(attemptsOf(scratch.root, runId).find(row => row.id === attemptId).state, 'running',
    'the original Attempt remains active immediately before replacement');
  assert.equal(workspaceHold(scratch.root, attemptId)?.state, 'held', 'workspace ownership remains held immediately before replacement');
  assert.equal(isAlive(host.pid), true, 'Host remains alive immediately before replacement');
  assert.equal(isAlive(hostRecord.processId), true, 'Codex remains alive immediately before replacement');
  assert.equal(processIdentity(hostRecord.processId), codexObservedIdentity, 'Codex process identity is unchanged immediately before replacement');
  assert.equal(isAlive(gateReady.pid), true, 'the in-task gate remains alive immediately before replacement');
  assert.equal(processIdentity(gateReady.pid), gateObservedIdentity, 'gate process identity is unchanged immediately before replacement');
  assert.equal(existsSync(releasePath), false, 'the gate is still unreleased immediately before replacement');
  normalizedBefore = committedStream(scratch.root, attemptId, 'normalized');
  const rawAtCutover = hostSpool(host, custodyId, 'stdout');
  assert.deepEqual(terminalEvents(rawAtCutover), [], 'Codex has produced no terminal JSONL event at the gate');
  assert.equal(committedBefore.bytes.length, ackAtCutover, 'Engine A commit offset equals the committed byte stream length');
  assert.ok(committedBefore.bytes.includes(Buffer.from('thread.started')));
  assert.ok(committedBefore.bytes.includes(Buffer.from('turn.started')));
  assert.deepEqual(projectSnapshot(workspace, { exclude: [readyRelative] }), initialSnapshot,
    'Codex has not changed project files before the gate is released');
  assert.equal(existsSync(releasePath), false);
  mark('barrier-confirmed', { ready: true, codexAlive: true, gateAlive: true, attemptState: activeAttempt.state,
    workspaceHoldState: holdAtCutover.state, terminalEvents: [], stdoutCommittedBytes: committedBefore.bytes.length,
    stdoutAckedBytes: ackAtCutover, stdoutDurableBytes: rawAtCutover.length, normalizedCommittedBytes: normalizedBefore.bytes.length,
    projectTreeUnchanged: true, engineAEpoch: epochA });

  assert.equal(isProcessDescendant(engineAPid, hostRecord.processId), false, 'the Host owns Codex independently from Engine A');
  assert.equal(isProcessDescendant(engineAPid, gateReady.pid), false, 'the gate is owned by Codex, not Engine A');
  engineA.kill();
  await eventually(() => exited(engineA.child), 'Engine A to terminate', 30_000, 100);
  mark('engine-a-terminated', { engineAPid, engineAIdentity, engineAEnded: true });
  assert.equal(isAlive(host.pid), true, 'the Rust Host remains alive');
  assert.equal(isAlive(hostRecord.processId), true, 'Codex survives Engine A termination');
  assert.equal(processIdentity(hostRecord.processId), codexObservedIdentity, 'Codex PID and OS creation identity are unchanged');
  assert.equal(isAlive(gateReady.pid), true, 'the Codex-invoked gate survives Engine A termination');
  assert.equal(processIdentity(gateReady.pid), gateObservedIdentity);
  hostRecord = hostRecords(host).find(record => record.custodyId === custodyId);
  assert.equal(hostRecord.state, 'running');
  assert.deepEqual(terminalEvents(hostSpool(host, custodyId, 'stdout')), []);
  mark('codex-survived-engine-a', { codexPid: hostRecord.processId, codexProcessCreationIdentity: processIdentity(hostRecord.processId),
    gatePid: gateReady.pid, gateProcessCreationIdentity: processIdentity(gateReady.pid), hostRecordState: hostRecord.state });

  engineB = await startEngine(scratch.root, host, { fixtureProvider: false, isolateCodexHome: false, devTestConfirmationOff: true });
  engineBPid = engineB.pid;
  engineBIdentity = processIdentity(engineBPid);
  mark('engine-b-started', { engineBPid, engineBIdentity });
  lockB = await eventually(() => { const lock = runnerLock(scratch.root); return lock?.pid === engineBPid ? lock : null; }, 'runner.lock ownership to transfer to Engine B', 30_000, 100);
  assert.notEqual(lockB.id, lockA.id, 'Engine B owns a new runner.lock identity');
  epochB = await eventually(() => { const epoch = processEpoch(host); return epoch > epochA ? epoch : null; }, 'Engine B to attach to the same Host', 60_000, 100);
  mark('engine-b-host-reattached', { engineBPid, engineBIdentity, runnerLockOwner: lockB, engineBEpoch: epochB });
  const resumedProcess = await eventually(async () => {
    const response = await engineB.api('GET', '/api/v2/runs/' + runId + '/processes');
    return response.status === 200 ? response.body.items.find(item => item.attemptId === attemptId && item.pid === hostRecord.processId && item.launched && item.alive) : null;
  }, 'Engine B to reattach to the original live Codex process', 60_000, 150);
  assert.ok(resumedProcess);
  assert.equal((await runState(engineB, runId)), 'running', 'the original Run remains active while Codex waits in its gate');
  assert.equal(attemptsOf(scratch.root, runId).find(row => row.id === attemptId).state, 'running');
  assert.deepEqual(custodyBindings(scratch.root, runId), [{ attempt_id: attemptId, custody_id: custodyId }], 'the original invocation binding is reused');
  assert.equal(isAlive(hostRecord.processId), true);
  assert.equal(processIdentity(hostRecord.processId), codexObservedIdentity);
  assert.equal(isAlive(gateReady.pid), true);
  assert.equal(processIdentity(gateReady.pid), gateObservedIdentity);
  assert.equal(existsSync(releasePath), false, 'the harness has not released the gate before reattachment is verified');
  assert.equal(isAlive(host.pid), true);
  const reattachedStreams = await eventually(async () => {
    const status = await host.request('custody.status', { custodyId, epoch: epochB, generation: host.generation });
    if (status.refused || status.state !== 'running' || status.processId !== hostRecord.processId) return null;
    const committed = committedStream(scratch.root, attemptId, 'stdout');
    const normalized = committedStream(scratch.root, attemptId, 'normalized');
    return status.stdoutAcked === committed.bytes.length ? { status, committed, normalized } : null;
  }, 'Engine B to commit and acknowledge the replayed stdout prefix', 30_000, 100);
  const statusAfterAttach = reattachedStreams.status;
  committedAfterAttach = reattachedStreams.committed;
  assert.ok(committedAfterAttach.bytes.length >= committedBefore.bytes.length);
  assert.deepEqual(committedAfterAttach.bytes.subarray(0, committedBefore.bytes.length), committedBefore.bytes,
    'Engine B retains the exact committed stdout prefix without applying it twice');
  const normalizedAfterAttach = reattachedStreams.normalized;
  assert.ok(normalizedAfterAttach.bytes.length >= normalizedBefore.bytes.length);
  assert.deepEqual(normalizedAfterAttach.bytes.subarray(0, normalizedBefore.bytes.length), normalizedBefore.bytes,
    'Engine B retains the exact committed normalized-event prefix');
  const committedAtReattach = committedStream(scratch.root, attemptId, 'stdout');
  assert.equal(statusAfterAttach.stdoutAcked, committedAtReattach.bytes.length, 'Host ACK offset matches Engine B committed bytes');
  assert.deepEqual(terminalEvents(hostSpool(host, custodyId, 'stdout')), [], 'the original Codex turn is still non-terminal before RELEASE');
  const holdAtReattach = workspaceHold(scratch.root, attemptId);
  assert.equal(holdAtReattach?.state, 'held', 'workspace remains held until Codex process-tree completion');
  mark('engine-b-custody-reattached', { resumedProcess, engineBEpoch: epochB, runnerLockOwner: lockB,
    stdoutCommittedBytes: committedAtReattach.bytes.length, stdoutAckedBytes: statusAfterAttach.stdoutAcked,
    stdoutDurableBytes: statusAfterAttach.stdoutDurable, normalizedCommittedBytes: normalizedAfterAttach.bytes.length,
    workspaceHoldState: holdAtReattach.state, codexAlive: true, gateAlive: true, terminalEvents: [] });

  const releaseValue = { schemaVersion: 1, releaseToken: gateReady.releaseToken, engineBReattached: true,
    engineBPid, engineBEpoch: epochB, runId, attemptId, releasedAt: new Date().toISOString() };
  writeJsonAtomically(releasePath, releaseValue);
  mark('gate-release-written', { engineBPid, engineBEpoch: epochB, releasedAt: releaseValue.releasedAt });
  gateReleased = await eventually(() => existsSync(releasedPath) ? JSON.parse(readFileSync(releasedPath, 'utf8')) : null,
    'the Codex-invoked gate to accept RELEASE after Engine B reattachment', 30_000, 100);
  assert.equal(gateReleased.pid, gateReady.pid);
  await eventually(() => !isAlive(gateReady.pid), 'the gate process to exit successfully', 15_000, 100);
  mark('gate-released-and-exited', { gatePid: gateReady.pid, gateExitCode: 0, gateReleasedAt: gateReleased.releasedAt,
    engineBReattachedBeforeRelease: true });

  finalRunState = await waitForRunState(engineB, runId, ['succeeded', 'failed', 'canceled', 'interrupted', 'waiting_for_user'], 900_000);
  mark('run-terminal-observed', { runId, finalRunState });
  assert.equal(finalRunState, 'succeeded', "Codex's original turn settles successfully under Engine B");
  finalAttempt = attemptsOf(scratch.root, runId).find(row => row.id === attemptId);
  assert.equal(finalAttempt.state, 'succeeded');
  assert.equal(finalAttempt.process_id, hostRecord.processId);
  assert.equal(finalAttempt.process_start_identity, 'custody:' + hostRecord.processCreationTime);
  finalRecord = hostRecords(host).find(record => record.custodyId === custodyId);
  finalStatus = await host.request('custody.status', { custodyId, epoch: epochB, generation: host.generation });
  assert.equal(finalStatus.refused, undefined);
  assert.equal(finalStatus.state, 'exited');
  assert.equal(finalStatus.exitCode, 0);
  assert.equal(finalStatus.spoolComplete, true);
  assert.equal(finalStatus.processTreeEnded, true);
  mark('host-process-tree-complete', { hostState: finalStatus.state, processTreeEnded: finalStatus.processTreeEnded,
    exitCode: finalStatus.exitCode, spoolComplete: finalStatus.spoolComplete });

  const committedStdout = committedStream(scratch.root, attemptId, 'stdout');
  const committedStderr = committedStream(scratch.root, attemptId, 'stderr');
  const rawStdout = hostSpool(host, custodyId, 'stdout');
  const rawStderr = hostSpool(host, custodyId, 'stderr');
  assert.deepEqual(committedStdout.bytes, rawStdout, "committed stdout exactly matches the Host's durable byte spool");
  assert.deepEqual(committedStderr.bytes, rawStderr, "committed stderr exactly matches the Host's durable byte spool");
  assert.equal(finalRecord.stdoutAcked, finalRecord.stdoutDurable);
  assert.equal(finalRecord.stderrAcked, finalRecord.stderrDurable);
  assert.equal(finalStatus.stdoutAcked, finalStatus.stdoutDurable);
  assert.equal(finalStatus.stderrAcked, finalStatus.stderrDurable);

  const providerEvents = providerJsonl(committedStdout.bytes);
  assert.equal(providerEvents.length, providerJsonl(rawStdout).length, 'every durable Codex JSONL line parses as one provider event');
  const providerEventTypes = providerEvents.map(event => event.type).filter(Boolean);
  for (const eventType of ['thread.started', 'turn.started', 'turn.completed']) assert.ok(providerEventTypes.includes(eventType), 'raw Codex JSONL includes ' + eventType);
  const normalized = committedStream(scratch.root, attemptId, 'normalized');
  const observations = providerJsonl(normalized.bytes);
  const normalizedProviderEvents = observations.map(item => item.providerEvent).filter(event => event && typeof event === 'object');
  assert.deepEqual(normalizedProviderEvents, providerEvents,
    'Engine B commits each original Codex JSONL event exactly once, in order, with no missing or duplicate normalized events');
  const normalizedTypes = observations.map(item => item.providerEvent?.type).filter(Boolean);
  for (const eventType of ['thread.started', 'turn.started', 'turn.completed']) assert.ok(normalizedTypes.includes(eventType), 'normalized output includes ' + eventType);
  const terminalNormalized = normalizedTypes.filter(type => ['turn.completed', 'turn.failed', 'error'].includes(type));
  assert.deepEqual(terminalNormalized, ['turn.completed'], 'exactly one successful terminal provider event is normalized');
  codexCommandItems = providerEvents.filter(event => event.item?.type === 'command_execution').map(event => event.item.command).filter(value => typeof value === 'string');
  assert.ok(codexCommandItems.some(value => /node(?:\.exe)?\s+--test/i.test(value)), 'Codex actually invoked the verified Node test command');
  assert.equal(codexCommandItems.some(value => /npm(?:\.cmd)?\s+test/i.test(value)), false, 'Codex did not use the broken npm shim');

  let attemptRow, holdRow, settledRows, invocationCount;
  const db = database(scratch.root);
  try {
    attemptRow = db.prepare('SELECT invocation_artifact_id, outputs_artifact_id FROM attempts WHERE id = ?').get(attemptId);
    holdRow = db.prepare('SELECT state, evidence_json FROM custody_workspace_holds WHERE attempt_id = ?').get(attemptId);
    settledRows = db.prepare("SELECT envelope_json FROM journal_events WHERE run_id = ? AND attempt_id = ? AND event_type = 'attempt.state_changed'").all(runId, attemptId)
      .map(row => JSON.parse(row.envelope_json).payload).filter(payload => ['succeeded', 'failed', 'canceled', 'interrupted'].includes(payload.to));
    invocationCount = db.prepare("SELECT COUNT(*) AS count FROM journal_events WHERE run_id = ? AND attempt_id = ? AND event_type = 'attempt.invocation_committed'").get(runId, attemptId).count;
  } finally { db.close(); }
  assert.equal(holdRow.state, 'released');
  const holdEvidence = JSON.parse(holdRow.evidence_json);
  assert.equal(holdEvidence.processTreeEnded, true, 'workspace hold release includes Host process-tree termination proof');
  assert.equal(holdEvidence.hostState, 'exited');
  assert.equal(settledRows.length, 1, 'the attempt settles exactly once');
  assert.equal(invocationCount, 1, 'the workflow invocation is committed exactly once');
  assert.equal(hostRecords(host).length, 1, 'the Host created one provider invocation');
  workspaceReleaseAt = new Date().toISOString();
  mark('workspace-hold-released', { state: holdRow.state, processTreeEnded: holdEvidence.processTreeEnded,
    hostState: holdEvidence.hostState, terminalAttemptSettlementCount: settledRows.length });

  const invocation = JSON.parse(artifactBytes(scratch.root, attemptRow.invocation_artifact_id).toString('utf8'));
  assert.equal(invocation.provider, 'codex');
  assert.equal(invocation.requestedModel, model);
  assert.equal(resolve(invocation.cwd), resolve(workspace));
  assert.equal(sha256File(invocation.cliExecutable), executableHash);
  assert.ok(invocation.arguments.includes('--ask-for-approval') && invocation.arguments.includes('never'));
  assert.ok(invocation.arguments.includes('--sandbox') && invocation.arguments.includes('workspace-write'));
  assert.ok(invocation.arguments.includes('--ephemeral'));
  assert.ok(!invocation.arguments.includes('--dangerously-bypass-approvals-and-sandbox'));
  const promptBytes = artifactBytes(scratch.root, invocation.stdin.artifactId);
  assert.ok(promptBytes.length <= 48 * 1024, 'the invocation fits the verified Host stdin limit');

  const outputs = JSON.parse(artifactBytes(scratch.root, attemptRow.outputs_artifact_id).toString('utf8'));
  const finalText = artifactBytes(scratch.root, outputs.values.text.artifact.artifactId).toString('utf8');
  assert.ok(finalText.trim().length > 0, 'the completed Codex turn has a recorded final assistant response');
  assert.equal(outputs.providerResult.requestedModel, model);
  for (const marker of gateMarkerPaths) rmSync(join(workspace, marker), { force: true });
  finalSnapshot = projectSnapshot(workspace);
  const finalPaths = Object.keys(finalSnapshot);
  assert.deepEqual(finalPaths, Object.keys(initialSnapshot), 'no unexpected project files were created or removed');
  projectChangedFiles = finalPaths.filter(path => finalSnapshot[path] !== initialSnapshot[path]).sort();
  assert.deepEqual(projectChangedFiles, expectedChangedFiles, 'only the three requested project files changed');
  assert.equal(git(workspace, 'diff', '--cached', '--name-only').trim(), '', 'no project files were staged');
  const finalHead = spawnSync('git', ['-C', workspace, 'rev-parse', '--verify', 'HEAD'], { cwd: repo, encoding: 'utf8', windowsHide: true });
  assert.notEqual(finalHead.status, 0, 'no project commit was created');
  testResult = runTests(workspace);
  assert.equal(testResult.exitCode, 0, testResult.stderr || testResult.stdout);
  assert.deepEqual(testSummary(testResult.stdout), { tests: 3, passed: 3, failed: 0 }, 'independent verified Node test run passes all project tests');
  const diffCheck = spawnSync('git', ['-C', workspace, 'diff', '--check'], { cwd: repo, encoding: 'utf8', windowsHide: true });
  assert.equal(diffCheck.status, 0, diffCheck.stderr || diffCheck.stdout);
  const noIndexDiffCheck = checkNoIndexWhitespace(workspace, baselineRoot, projectChangedFiles);
  mark('project-verified-independently', { command: nodeTestCommand.command, exitCode: testResult.exitCode,
    testSummary: testSummary(testResult.stdout),
    changedFiles: projectChangedFiles, gitDiffCheckExitCode: diffCheck.status, baselineComparisonWhitespaceErrors: noIndexDiffCheck.diagnostics,
    stagedFiles: 0, commitCount: 0 });

  const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  const redactedCliPath = '%LOCALAPPDATA%/' + relative(localAppData, provider.cliPath).replaceAll('\\', '/');
  result = {
    schemaVersion: 2,
    status: 'verified',
    verdict: 'REAL CODEX CUSTODY VERIFIED — STAGE 1 COMPLETE',
    verifiedAt: new Date().toISOString(),
    environment: {
      windows: spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[System.Environment]::OSVersion.VersionString'], { encoding: 'utf8', windowsHide: true }).stdout.trim(),
      node: process.version,
      verifiedNodeExecutable: nodeTestCommand.executable,
      rust: spawnSync('rustc', ['--version'], { encoding: 'utf8', windowsHide: true }).stdout.trim(),
      codexCliVersion: provider.cliVersion,
      codexExecutable: redactedCliPath,
      codexSha256: executableHash,
      hostSha256: sha256File(hostArtifacts.hostExe),
      authenticationMode: 'Existing ChatGPT sign-in; credentials are not recorded.',
      selectedProtocol: 'codex exec --json over Host-owned stdin/stdout/stderr pipes',
      selectedModel: model,
    },
    workflow: { runId, attemptId, custodyInvocationId: custodyId, publishedVersionId, finalRunState, finalAttemptState: finalAttempt.state },
    processes: {
      hostPid: host.pid,
      engineAPid,
      engineBPid,
      codexPid: finalStatus.processId,
      codexProcessCreationIdentity: finalStatus.processCreationTime,
      codexPowerShellCreationIdentity: codexObservedIdentity,
      gatePid: gateReady.pid,
      gateParentPid: gateReady.parentPid,
      gateProcessCreationIdentity: gateObservedIdentity,
      gateWasCodexDescendant: true,
      engineAIdentity,
      engineBIdentity,
      engineAEpoch: epochA,
      engineBEpoch: epochB,
      runnerLockOwnerA: lockA,
      runnerLockOwnerB: lockB,
      hostAdmissionStateAtLaunch: hostRecordAtLaunch.state,
      hostRecordCreatedAt: hostRecordAtLaunch.createdAt,
      hostRecordUpdatedAt: hostRecordAtLaunch.updatedAt,
      hostLaunchCount: hostRecords(host).length,
      deszoBridgeProcessesAtReplacement,
    },
    barrier: {
      readyObserved: true,
      readyStartedAt: gateReady.startedAt,
      readyObservedWhileCodexAlive: true,
      codexSurvivedEngineA: true,
      engineATerminated: true,
      engineBReattached: true,
      engineBReattachedBeforeRelease: true,
      releaseWrittenAt: timeline.find(item => item.event === 'gate-release-written').observedAt,
      gateReleasedAt: gateReleased.releasedAt,
      gateExitCode: 0,
    },
    streams: {
      providerEventTypes,
      normalizedEventTypes: normalizedTypes,
      stdoutBytesCommittedAtCutover: committedBefore.bytes.length,
      stdoutBytesAckedAtCutover: ackAtCutover,
      stdoutBytesCommittedAtReattach: committedAfterAttach.bytes.length,
      stdoutBytesAckedAtReattach: statusAfterAttach.stdoutAcked,
      stdoutBytesCommittedFinal: committedStdout.bytes.length,
      stdoutBytesAcknowledgedFinal: finalStatus.stdoutAcked,
      stderrBytesCommittedFinal: committedStderr.bytes.length,
      stderrBytesAcknowledgedFinal: finalStatus.stderrAcked,
      stdoutBytesDurableFinal: finalStatus.stdoutDurable,
      stderrBytesDurableFinal: finalStatus.stderrDurable,
      stdoutSha256: createHash('sha256').update(rawStdout).digest('hex'),
      stderrSha256: createHash('sha256').update(rawStderr).digest('hex'),
      stdoutSpoolPath: relative(repo, join(host.state, 'custody', 'spool', custodyId, 'stdout.bin')).replaceAll('\\', '/'),
      stderrSpoolPath: relative(repo, join(host.state, 'custody', 'spool', custodyId, 'stderr.bin')).replaceAll('\\', '/'),
      spoolComplete: finalStatus.spoolComplete,
      exactHostSpoolReconciliation: true,
    },
    settlement: {
      terminalAttemptSettlementCount: settledRows.length,
      committedInvocationCount: invocationCount,
      hostProcessTreeEnded: finalStatus.processTreeEnded,
      finalHostState: finalStatus.state,
      finalHostExitCode: finalStatus.exitCode,
      workspaceHoldState: holdRow.state,
      workspaceHoldReleasedAtObserved: workspaceReleaseAt,
      workspaceHoldEvidence: holdEvidence,
      requestedModel: outputs.providerResult.requestedModel,
    },
    project: {
      baselineTreeSha256: initialTreeSha256,
      finalTreeSha256: snapshotDigest(finalSnapshot),
      modifiedFiles: projectChangedFiles,
      codexCommandItems,
      baselineTestExitCode: baselineTests.exitCode,
      codexTestCommand: nodeTestCommand.command,
      independentFinalTestExitCode: testResult.exitCode,
      independentTestSummary: testSummary(testResult.stdout),
      gitDiffCheckExitCode: diffCheck.status,
      baselineComparisonWhitespaceCheck: noIndexDiffCheck,
      stagedFiles: [],
      commitCreated: false,
      outsideDeszoRepository: true,
      outsideUserProfile: true,
    },
    realCodexDesktopReplacement: 'not_performed; this proof covers Node Engine A-to-B reattachment only',
    custodyStateRoot: relative(repo, scratch.root).replaceAll('\\', '/'),
    workspacePath: workspace,
    timeline: [...timeline],
  };
  mark('real-codex-engine-replacement-proof-complete', { verdict: result.verdict, runId, attemptId, custodyId });
} catch (error) {
  failure = error;
  mark('proof-not-verified', { message: redactedError(error) });
  result = collectPartialEvidence('not_verified', error);
} finally {
  const cleanup = { engineAStopped: false, engineBStopped: false, hostStopped: false };
  if (engineA && !exited(engineA.child)) {
    engineA.kill();
    await eventually(() => exited(engineA.child), 'owned Engine A cleanup', 30_000, 100).catch(() => {});
  }
  cleanup.engineAStopped = !engineA || exited(engineA.child);
  if (engineB && !exited(engineB.child)) await engineB.stop().catch(() => engineB.kill());
  cleanup.engineBStopped = !engineB || exited(engineB.child);
  if (host && !exited(host.child)) await host.shutdown().catch(() => host.crash());
  cleanup.hostStopped = !host || exited(host.child);
  if (failure) result = collectPartialEvidence('not_verified', failure);
  if (result) {
    result.timeline = [...timeline];
    result.cleanup = cleanup;
    saveEvidence(result);
  }
  rmSync(baselineRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

if (failure) throw failure;
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
