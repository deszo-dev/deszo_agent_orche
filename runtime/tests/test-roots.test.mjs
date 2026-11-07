// Proofs for the test-root lifecycle (test-roots.mjs) and stale-root reconciliation (scripts/test-artifacts.mjs). Fixture test files run as
// real `node --test` child processes whose temporary directory (an approved base) is a scratch directory of this test, so nothing here
// can reach a real workspace, build cache or evidence file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { failuresRoot, ownedDir, ownersRoot, releaseOwnedDir, removeVerifiedRoot, repo, trackProcess, unsafeReason } from './test-roots.mjs';
import { ownerState, reconcile } from '../../scripts/test-artifacts.mjs';

const moduleUrl = pathToFileURL(join(import.meta.dirname, 'test-roots.mjs')).href;
const wait = ms => new Promise(done => setTimeout(done, ms));
async function eventually(predicate, what, timeoutMs = 30_000) {
  const started = Date.now();
  while (!predicate()) { if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`); await wait(50); }
}

// A fixture test file in `dir` and the scratch base its process uses as its temporary directory.
function fixture(scratch, name, body) {
  const base = join(scratch, `base-${name}`);
  mkdirSync(base, { recursive: true });
  const file = join(scratch, `${name}.test.mjs`);
  writeFileSync(file, `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';\n`
    + `import { join } from 'node:path';\nimport { tmpdir } from 'node:os';\nimport { spawn } from 'node:child_process';\n`
    + `import { ownedDir, releaseOwnedDir, trackProcess } from ${JSON.stringify(moduleUrl)};\nconst report = ${JSON.stringify(join(scratch, `${name}.report.json`))};\n${body}\n`);
  return { file, base, report: join(scratch, `${name}.report.json`) };
}

function runFixture({ file, base }, env = {}) {
  // This process's own test-runner context must not reach the fixture's runner, which then runs it as a file of its own.
  const childEnv = { ...process.env, TEMP: base, TMP: base, ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', file], { cwd: repo, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.done = new Promise(done => child.once('exit', code => done({ code, output })));
  return child;
}

const readReport = path => JSON.parse(readFileSync(path, 'utf8'));
const ownerDirOf = pid => (existsSync(ownersRoot) ? readdirSync(ownersRoot).filter(name => name.startsWith(`${pid}-`)) : []);
const failureDirsFor = marker => (existsSync(failuresRoot) ? readdirSync(failuresRoot).filter(name => name.includes(marker)) : []);
const removeFailureDirs = marker => failureDirsFor(marker).forEach(name => removeVerifiedRoot(join(failuresRoot, name), { bases: [failuresRoot] }));

test('TR-01/03/04: a passing test removes its disposable root; a build cache and an evidence file beside it are untouched', async () => {
  const scratch = ownedDir(join(tmpdir(), 'deszo-test-roots-'));
  const fx = fixture(scratch, 'pass', `
test('creates and passes', () => {
  const root = ownedDir(join(tmpdir(), 'disposable-'));
  mkdirSync(join(root, 'store'), { recursive: true });
  writeFileSync(join(root, 'store', 'state.sqlite'), 'x'.repeat(1024));
  writeFileSync(join(root, 'stdout.spool'), 'spool');
  // A reusable cache and an acceptance record in the same base, created without ownership.
  mkdirSync(join(tmpdir(), 'build-cache', 'abc'), { recursive: true });
  writeFileSync(join(tmpdir(), 'build-cache', 'abc', 'codex.exe'), 'binary');
  writeFileSync(join(tmpdir(), 'proof-evidence.json'), '{"proof":true}');
  writeFileSync(report, JSON.stringify({ root, pid: process.pid }));
});`);
  const { code, output } = await runFixture(fx).done;
  assert.equal(code, 0, output);
  const { root, pid } = readReport(fx.report);
  assert.equal(existsSync(root), false, 'the disposable root is removed when its test passes');
  assert.equal(readFileSync(join(fx.base, 'build-cache', 'abc', 'codex.exe'), 'utf8'), 'binary', 'an unowned build cache stays');
  assert.equal(readFileSync(join(fx.base, 'proof-evidence.json'), 'utf8'), '{"proof":true}', 'an unowned evidence file stays');
  assert.deepEqual(ownerDirOf(pid), [], 'a clean test file leaves no owner registry');
  assert.match(unsafeReason(join(repo, 'docs', 'reviews', 'evidence')), /outside the approved test bases/);
});

test('TR-02: a failing test leaves bounded diagnostics and no full copy; DESZO_TEST_KEEP_FAILED=1 keeps the whole root for reconciliation to skip', async () => {
  const scratch = ownedDir(join(tmpdir(), 'deszo-test-roots-'));
  const marker = `tr02-${randomUUID().slice(0, 8)}`;
  const body = `
test(${JSON.stringify(marker)}, () => {
  const root = ownedDir(join(tmpdir(), 'failing-'));
  writeFileSync(join(root, 'engine.log'), 'line\\n'.repeat(100));
  writeFileSync(join(root, 'host-status.json'), JSON.stringify({ state: 'stopped' }));
  writeFileSync(join(root, 'huge.log'), Buffer.alloc(600 * 1024, 65));
  writeFileSync(join(root, 'package.bin'), Buffer.alloc(3 * 1024 * 1024, 1));
  writeFileSync(join(root, 'deszo.exe'), Buffer.alloc(1024, 1));
  mkdirSync(join(root, 'versions', 'build-a'), { recursive: true });
  writeFileSync(join(root, 'versions', 'build-a', 'runner.log'), 'packaged copy');
  writeFileSync(report, JSON.stringify({ root, pid: process.pid }));
  assert.equal('observed', 'expected');
});`;
  try {
    const fx = fixture(scratch, 'fail', body);
    const { code } = await runFixture(fx).done;
    assert.notEqual(code, 0);
    const { root } = readReport(fx.report);
    assert.equal(existsSync(root), false, 'the failing root itself is removed');
    const [diagnostics] = failureDirsFor(marker);
    assert.ok(diagnostics, 'a diagnostics directory names the failing test');
    const summary = JSON.parse(readFileSync(join(failuresRoot, diagnostics, 'failure.json'), 'utf8'));
    assert.equal(summary.test, marker);
    assert.match(summary.error.message, /observed/);
    const copied = summary.roots[0].copied.map(item => item.path).sort();
    assert.deepEqual(copied, ['engine.log', 'host-status.json', 'huge.log']);
    assert.equal(summary.roots[0].copied.find(item => item.path === 'huge.log').truncated, true, 'a large log keeps only its tail');
    assert.ok(summary.roots[0].listing.some(item => item.path === 'package.bin' && item.size === 3 * 1024 * 1024), 'large and binary files are listed, not copied');
    assert.equal(existsSync(join(failuresRoot, diagnostics, 'files', '0', 'versions')), false, 'a packaged copy is not copied');

    const kept = fixture(scratch, 'keep', body.replace(marker, `${marker}-keep`));
    const keptRun = await runFixture(kept, { DESZO_TEST_KEEP_FAILED: '1' }).done;
    assert.notEqual(keptRun.code, 0);
    const keptReport = readReport(kept.report);
    assert.equal(existsSync(join(keptReport.root, 'package.bin')), true, 'the keep option retains the complete failing root');
    const [owner] = ownerDirOf(keptReport.pid);
    assert.ok(owner, 'the retained root keeps its registry');
    const bases = [kept.base];
    assert.equal(reconcile({ log: () => {}, owners: name => name === owner, bases }).removedRoots, 0, 'reconciliation keeps a retained root');
    assert.equal(existsSync(keptReport.root), true);
    assert.equal(reconcile({ log: () => {}, owners: name => name === owner, bases, includeRetained: true }).removedRoots, 1);
    assert.equal(existsSync(keptReport.root), false);
    assert.deepEqual(ownerDirOf(keptReport.pid), []);
  } finally { removeFailureDirs(marker); }
});

test('TR-05: removal refuses a base, a nested path, a relative path, an outside path and a junction root, and never follows a junction out', () => {
  const base = ownedDir(join(tmpdir(), 'deszo-test-roots-'));
  const bases = [base];
  const outside = ownedDir(join(tmpdir(), 'deszo-test-roots-outside-'));
  writeFileSync(join(outside, 'user-file.txt'), 'must survive');
  mkdirSync(join(base, 'root', 'nested'), { recursive: true });
  assert.match(removeVerifiedRoot(base, { bases }).reason, /refused: .*(outside|base itself)/);
  assert.match(removeVerifiedRoot(join(base, 'root', 'nested'), { bases }).reason, /refused: outside the approved test bases/);
  assert.match(removeVerifiedRoot('relative-root', { bases }).reason, /refused: not an absolute path/);
  assert.match(removeVerifiedRoot(outside, { bases }).reason, /refused: outside the approved test bases/);
  const junctionRoot = join(base, 'junction-root');
  assert.equal(spawnSync('cmd', ['/c', 'mklink', '/J', junctionRoot, outside], { windowsHide: true }).status, 0);
  assert.match(removeVerifiedRoot(junctionRoot, { bases }).reason, /refused: a symbolic link or junction/);
  // A junction inside a root is unlinked with the root; what it points to stays.
  assert.equal(spawnSync('cmd', ['/c', 'mklink', '/J', join(base, 'root', 'link-out'), outside], { windowsHide: true }).status, 0);
  assert.equal(removeVerifiedRoot(join(base, 'root'), { bases }).removed, true);
  assert.equal(existsSync(join(base, 'root')), false);
  assert.equal(readFileSync(join(outside, 'user-file.txt'), 'utf8'), 'must survive');
  assert.equal(existsSync(outside), true);
  spawnSync('cmd', ['/c', 'rmdir', junctionRoot], { windowsHide: true });
});

test('TR-06/08: a root whose tracked process is alive, or whose file is held open, is not removed; it goes once the process exits and the file closes', async () => {
  const root = ownedDir(join(tmpdir(), 'deszo-test-roots-live-'));
  const spool = join(root, 'stdout.spool');
  const writer = spawn(process.execPath, ['-e', `const fs = require('fs'); setInterval(() => fs.appendFileSync(${JSON.stringify(spool)}, 'x'), 20);`], { windowsHide: true, stdio: 'ignore' });
  trackProcess(root, writer);
  await eventually(() => existsSync(spool), 'the writer to start its spool');
  const refused = releaseOwnedDir(root);
  assert.equal(refused.removed, false);
  assert.match(refused.reason, /refused: live child/);
  assert.equal(existsSync(spool), true, 'the live process keeps its spool');
  writer.kill();
  await new Promise(done => (writer.exitCode !== null || writer.signalCode !== null ? done() : writer.once('exit', done)));
  // A file held open without delete sharing (SQLite on Windows): the bounded retry gives up, reports, and leaves the root.
  const db = new DatabaseSync(join(root, 'held.sqlite'));
  db.exec('CREATE TABLE t (x)');
  const started = Date.now();
  const locked = releaseOwnedDir(root);
  assert.equal(locked.removed, false);
  assert.match(locked.reason, /EBUSY|EPERM|ENOTEMPTY/);
  assert.ok(Date.now() - started < 15_000, 'a locked file is retried for a bounded time');
  assert.equal(existsSync(join(root, 'held.sqlite')), true);
  db.close();
  assert.equal(releaseOwnedDir(root).removed, true);
  assert.equal(existsSync(root), false);
  // TR-10: repeated cleanup is idempotent.
  assert.deepEqual(releaseOwnedDir(root), { removed: false, reason: 'not owned by this process' });
  assert.deepEqual(removeVerifiedRoot(root), { removed: true, reason: 'already absent' });
});

test('TR-07/09/10: concurrent fixture roots are isolated; reconciliation skips a live owner and removes only a dead owner\'s recorded roots', async () => {
  const scratch = ownedDir(join(tmpdir(), 'deszo-test-roots-'));
  const holder = fixture(scratch, 'holder', `
test('holds its root until it is killed', async () => {
  const root = ownedDir(join(tmpdir(), 'held-'));
  writeFileSync(join(root, 'state.sqlite'), 'state');
  writeFileSync(report, JSON.stringify({ root, pid: process.pid }));
  await new Promise(() => setInterval(() => {}, 1000));
});`);
  const other = fixture(scratch, 'other', `
test('finishes first', () => { const root = ownedDir(join(tmpdir(), 'other-')); writeFileSync(report, JSON.stringify({ root })); });`);
  // The same base for both, so a mistaken cleanup would be able to reach the other's root.
  other.base = holder.base;
  const first = runFixture(holder);
  await eventually(() => existsSync(holder.report), 'the holder to create its root');
  const { root: heldRoot, pid } = readReport(holder.report);
  const otherRun = await runFixture(other).done;
  assert.equal(otherRun.code, 0, otherRun.output);
  assert.equal(existsSync(readReport(other.report).root), false);
  assert.equal(existsSync(heldRoot), true, 'one test process\'s cleanup does not remove another\'s root');
  const [owner] = ownerDirOf(pid);
  assert.equal(ownerState(join(ownersRoot, owner)), 'alive');
  const bases = [holder.base];
  const unowned = join(holder.base, 'unowned-user-dir');
  mkdirSync(unowned);
  assert.equal(reconcile({ log: () => {}, owners: name => name === owner, bases }).alive, 1);
  assert.equal(existsSync(heldRoot), true, 'a live owner\'s root is never reconciled');
  // A hard kill: no teardown runs, so the registry and root remain until reconciliation proves the owner gone.
  spawnSync('taskkill', ['/PID', String(first.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  await first.done;
  await eventually(() => ownerState(join(ownersRoot, owner)) === 'dead', 'the killed owner\'s lock to be released');
  assert.equal(existsSync(heldRoot), true);
  const reconciled = reconcile({ log: () => {}, owners: name => name === owner, bases });
  assert.equal(reconciled.removedRoots, 1);
  assert.deepEqual(reconciled.ambiguous, []);
  assert.equal(existsSync(heldRoot), false);
  assert.equal(existsSync(unowned), true, 'a directory nobody recorded is never removed');
  assert.deepEqual(ownerDirOf(pid), []);
  assert.equal(reconcile({ log: () => {}, owners: name => name === owner, bases }).removedRoots, 0, 'reconciliation is idempotent');
});
