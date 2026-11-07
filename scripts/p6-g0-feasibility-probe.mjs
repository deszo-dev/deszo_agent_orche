import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, version as osVersion } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('P6-G0 feasibility probe requires native Windows.');

const repo = resolve(import.meta.dirname, '..');
const readerMode = process.argv[2] === '--reader';
const helper = resolve(readerMode ? join(repo, 'lifecycle-host/target/debug/examples/p6_g0_file_guard_probe.exe')
  : process.argv[2] ?? join(repo, 'lifecycle-host/target/debug/examples/p6_g0_file_guard_probe.exe'));
if (!readerMode && !existsSync(helper)) throw new Error(`Build the native helper first: cargo build --manifest-path lifecycle-host/Cargo.toml --example p6_g0_file_guard_probe`);

const root = join(tmpdir(), `deszo-p6-g0-probe-${process.pid}-${Date.now()}`);
const evidencePath = resolve(process.argv[3] ?? join(repo, 'docs/reviews/evidence/2026-10-31-p6-g0-feasibility.json'));
mkdirSync(root, { recursive: true });
const hash = path => existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
const sidecars = db => ['-wal', '-shm', '-journal'].map(suffix => ({ suffix, exists: existsSync(db + suffix), sha256: hash(db + suffix), size: existsSync(db + suffix) ? statSync(db + suffix).size : null }));
const fileSet = db => [{ suffix: '', exists: true, sha256: hash(db), size: statSync(db).size }, ...sidecars(db)];
const runHelper = args => {
  const result = spawnSync(helper, args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`native helper failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout.trim());
};

function lineReader(child) {
  let buffer = '';
  const lines = [];
  const waiters = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      lines.push(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      waiters.shift()?.();
    }
  });
  return () => lines.length ? Promise.resolve(lines.shift()) : new Promise((resolveLine, reject) => {
    const timer = setTimeout(() => reject(new Error('native helper output timed out')), 10_000);
    waiters.push(() => { clearTimeout(timer); resolveLine(lines.shift()); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`native helper exited before output (${code})`)); });
  });
}

async function holdFiles(paths) {
  const child = spawn(helper, ['hold', ...paths], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const next = lineReader(child);
  const ready = JSON.parse(await next());
  assert.equal(ready.event, 'guard_ready');
  return {
    child, ready,
    async release() {
      child.stdin.write('release\n');
      const result = JSON.parse(await next());
      await new Promise(resolveExit => child.once('exit', resolveExit));
      return result;
    },
  };
}

async function startReader(databasePath) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', fileURLToPath(import.meta.url), '--reader', databasePath], {
    cwd: repo, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const next = lineReader(child);
  const ready = JSON.parse(await next());
  assert.equal(ready.event, 'ready');
  return {
    child, ready,
    async command(name) { child.stdin.write(`${name}\n`); return JSON.parse(await next()); },
    async wait() { await new Promise(resolveExit => child.once('exit', resolveExit)); },
  };
}

if (readerMode) {
  const databasePath = process.argv[3];
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const ready = {
    event: 'ready',
    journalMode: database.prepare('PRAGMA journal_mode').get().journal_mode,
    rows: database.prepare('SELECT id, value FROM probe ORDER BY id').all(),
  };
  process.stdout.write(`${JSON.stringify(ready)}\n`);
  const rl = await import('node:readline');
  const input = rl.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const command of input) {
    if (command === 'write') {
      try { database.prepare('UPDATE probe SET value=? WHERE id=1').run('B-WROTE'); process.stdout.write('{"event":"write_succeeded"}\n'); }
      catch (error) { process.stdout.write(`${JSON.stringify({ event: 'write_refused', message: error.message, code: error.code })}\n`); }
    } else if (command === 'checkpoint') {
      try { process.stdout.write(`${JSON.stringify({ event: 'checkpoint_result', result: database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() })}\n`); }
      catch (error) { process.stdout.write(`${JSON.stringify({ event: 'checkpoint_refused', message: error.message, code: error.code })}\n`); }
    } else if (command === 'close') {
      database.close();
      process.stdout.write('{"event":"closed"}\n');
      break;
    }
  }
  process.exit(0);
}

const results = {
  schemaVersion: 1,
  kind: 'P6G0WindowsSqliteFeasibilityProbe',
  capturedAt: new Date().toISOString(),
  sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  branch: execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8' }).trim(),
  platform: process.platform,
  windowsVersion: osVersion(),
  nodeVersion: process.version,
  sqliteVersion: new DatabaseSync(':memory:').prepare('SELECT sqlite_version() AS value').get().value,
  nativeHelper: { path: helper, sha256: hash(helper), source: 'lifecycle-host/examples/p6_g0_file_guard_probe.rs' },
  root,
  experiments: {},
};

try {
  const livePath = join(root, 'live-profile', 'store', 'state.sqlite');
  mkdirSync(join(root, 'live-profile', 'store'), { recursive: true });
  const engineA = new DatabaseSync(livePath);
  engineA.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE probe(id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO probe VALUES(1,\'A-initial\');');
  const beforeLivePreflight = fileSet(livePath);
  const liveReader = await startReader(livePath);
  const beforeBWrite = fileSet(livePath);
  const bWrite = await liveReader.command('write');
  const bCheckpoint = await liveReader.command('checkpoint');
  const beforeBClose = fileSet(livePath);
  const guardWhileAOpen = runHelper(['try-guard', livePath]);
  let concurrentWriter;
  try {
    engineA.prepare('UPDATE probe SET value=? WHERE id=1').run('A-concurrent-writer');
    concurrentWriter = { allowed: true };
  } catch (error) { concurrentWriter = { allowed: false, message: error.message, code: error.code }; }
  const afterConcurrentWriter = fileSet(livePath);
  const bClosed = await liveReader.command('close');
  await liveReader.wait();
  const afterLivePreflight = fileSet(livePath);
  engineA.close();
  results.experiments.liveStorePreflight = {
    aAndBUseSameDatabase: true,
    bReadiness: liveReader.ready,
    bWriteAttempt: bWrite,
    bCheckpointAttempt: bCheckpoint,
    filesBefore: beforeLivePreflight,
    filesAfterBOpenAndSql: beforeBWrite,
    filesAfterBClose: beforeBClose,
    filesAfterPreflight: afterLivePreflight,
    mainAndWalUnchangedByBOpen: beforeLivePreflight[0].sha256 === beforeBWrite[0].sha256
      && beforeLivePreflight[1].sha256 === beforeBWrite[1].sha256,
    shmChangedByBOpen: beforeLivePreflight[2].sha256 !== beforeBWrite[2].sha256,
    bClosed,
    guardWhileAConnectionOpen: guardWhileAOpen,
    separateWriterDuringBPreflight: concurrentWriter,
    sidecarsAfterAClosed: sidecars(livePath),
  };
  assert.equal(bWrite.event, 'write_refused');
  assert.equal(bCheckpoint.event, 'checkpoint_refused');
  assert.equal(guardWhileAOpen.opened, false, 'a live A connection must prevent acquiring the no-write guard');
  assert.equal(concurrentWriter.allowed, true, 'a read-only B connection is not itself a writer fence');

  const missingSource = join(root, 'missing-sidecar-source', 'state.sqlite');
  mkdirSync(join(root, 'missing-sidecar-source'), { recursive: true });
  copyFileSync(livePath, missingSource);
  const absentBeforeOpen = sidecars(missingSource);
  const directReadOnly = new DatabaseSync(missingSource, { readOnly: true });
  const directRows = directReadOnly.prepare('SELECT id, value FROM probe ORDER BY id').all();
  directReadOnly.close();
  const absentAfterOpen = sidecars(missingSource);
  results.experiments.readOnlyOpenWithMissingSidecars = { before: absentBeforeOpen, rows: directRows, after: absentAfterOpen };
  assert.equal(absentBeforeOpen[0].exists, false);
  assert.equal(absentBeforeOpen[1].exists, false);
  assert.equal(absentAfterOpen[0].exists, true, 'SQLite created a missing WAL sidecar');
  assert.equal(absentAfterOpen[1].exists, true, 'SQLite created a missing SHM sidecar');
  const individualMissingSidecars = [];
  for (const [caseName, presentSuffix, missingSuffix] of [
    ['missing-wal', '-shm', '-wal'],
    ['missing-shm', '-wal', '-shm'],
  ]) {
    const directory = join(root, caseName);
    mkdirSync(directory, { recursive: true });
    const caseDb = join(directory, 'state.sqlite');
    copyFileSync(livePath, caseDb);
    writeFileSync(caseDb + presentSuffix, Buffer.alloc(presentSuffix === '-shm' ? 32 * 1024 : 0));
    const before = sidecars(caseDb);
    const reader = new DatabaseSync(caseDb, { readOnly: true });
    const rows = reader.prepare('SELECT id, value FROM probe ORDER BY id').all();
    reader.close();
    const after = sidecars(caseDb);
    individualMissingSidecars.push({ caseName, presentSuffix, missingSuffix, before, rows, after,
      SQLiteCreatedMissingSidecar: after.find(item => item.suffix === missingSuffix)?.exists ?? false });
  }
  assert.ok(individualMissingSidecars.every(item => item.SQLiteCreatedMissingSidecar));
  results.experiments.individuallyMissingSidecarsInScratch = individualMissingSidecars;

  const stablePath = join(root, 'stable-profile', 'store', 'state.sqlite');
  mkdirSync(join(root, 'stable-profile', 'store'), { recursive: true });
  const a = new DatabaseSync(stablePath);
  a.exec('PRAGMA journal_mode=WAL; CREATE TABLE probe(id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO probe VALUES(1,\'A-stable\');');
  a.close();
  const stableBefore = fileSet(stablePath);
  const stableDigest = hash(stablePath);
  const productionGuard = await holdFiles([stablePath]);
  const snapshotPath = join(root, 'host-preflight', 'state.sqlite');
  mkdirSync(join(root, 'host-preflight'), { recursive: true });
  copyFileSync(stablePath, snapshotPath);
  const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
  const snapshotRows = snapshot.prepare('SELECT id, value FROM probe ORDER BY id').all();
  let snapshotWrite;
  try { snapshot.prepare('UPDATE probe SET value=? WHERE id=1').run('B-mutation'); snapshotWrite = { refused: false }; }
  catch (error) { snapshotWrite = { refused: true, message: error.message, code: error.code }; }
  let snapshotCheckpoint;
  try { snapshotCheckpoint = { refused: false, result: snapshot.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() }; }
  catch (error) { snapshotCheckpoint = { refused: true, message: error.message, code: error.code }; }
  snapshot.close();
  const stableAfterPreflight = fileSet(stablePath);
  const scratchSidecars = sidecars(snapshotPath);
  const released = await productionGuard.release();
  const fallbackA = new DatabaseSync(stablePath);
  fallbackA.prepare('INSERT INTO probe VALUES(2,\'A-resumed\')').run();
  const fallbackRows = fallbackA.prepare('SELECT id, value FROM probe ORDER BY id').all();
  fallbackA.close();
  results.experiments.disposableStoreCopy = {
    productionBeforeGuard: stableBefore,
    nativeGuard: productionGuard.ready,
    productionSha256Before: stableDigest,
    productionSha256AfterPreflight: stableAfterPreflight[0].sha256,
    productionSha256AfterFallbackAWrite: hash(stablePath),
    productionUnchangedDuringPreflight: stableDigest === stableAfterPreflight[0].sha256,
    productionFilesAfterPreflight: stableAfterPreflight,
    snapshotRows,
    snapshotWrite,
    snapshotCheckpoint,
    scratchSidecars,
    guardReleased: released,
    fallbackAReopenedAndCommitted: fallbackRows,
  };
  assert.equal(snapshotRows[0].value, 'A-stable');
  assert.equal(snapshotWrite.refused, true);
  assert.equal(stableDigest, stableAfterPreflight[0].sha256);
  assert.deepEqual(stableBefore.map(file => [file.suffix, file.exists]), stableAfterPreflight.map(file => [file.suffix, file.exists]));
  assert.equal(fallbackRows.at(-1).value, 'A-resumed');

  let databaseWrite;
  let databaseOpenSucceeded = false;
  const guardAgain = await holdFiles([stablePath]);
  try {
    const staleA = new DatabaseSync(stablePath);
    databaseOpenSucceeded = true;
    try { staleA.prepare('INSERT INTO probe VALUES(3,\'stale-A-write\')').run(); databaseWrite = { refused: false }; }
    catch (error) { databaseWrite = { refused: true, message: error.message, code: error.code }; }
    staleA.close();
  } catch (error) { databaseWrite = { refused: true, openFailed: true, message: error.message, code: error.code }; }
  await guardAgain.release();
  results.experiments.noWriteThroughGuard = { databaseOpenSucceededWithReadonlyFallback: databaseOpenSucceeded, write: databaseWrite };
  assert.equal(databaseWrite.refused, true);

  const marker = join(root, 'guard-marker.bin');
  const moved = join(root, 'guard-marker-moved.bin');
  writeFileSync(marker, 'guard marker');
  const markerGuard = await holdFiles([marker]);
  const blockedWrite = runHelper(['try-write', marker]);
  const blockedDelete = runHelper(['try-delete', marker]);
  const blockedRename = runHelper(['try-rename', marker, moved]);
  const markerReleased = await markerGuard.release();
  const writeAfterRelease = runHelper(['try-write', marker]);
  const renameAfterRelease = runHelper(['try-rename', marker, moved]);
  const deleteAfterRelease = runHelper(['try-delete', moved]);
  assert.equal(blockedWrite.write, 'refused');
  assert.equal(blockedDelete.deleted, false);
  assert.equal(blockedRename.renamed, false);
  assert.equal(writeAfterRelease.write, 'succeeded');
  assert.equal(renameAfterRelease.renamed, true);
  assert.equal(deleteAfterRelease.deleted, true);

  const crashMarker = join(root, 'guard-crash-marker.bin');
  writeFileSync(crashMarker, 'guard crash marker');
  const crashGuard = await holdFiles([crashMarker]);
  crashGuard.child.kill();
  await new Promise(resolveExit => crashGuard.child.once('exit', resolveExit));
  const reacquire = runHelper(['try-guard', crashMarker]);
  assert.equal(reacquire.opened, true);
  results.experiments.fileGuard = {
    shareMode: markerGuard.ready.shareMode,
    nativeFileIdentity: markerGuard.ready.files[0].identity,
    writeWhileHeld: blockedWrite,
    deleteWhileHeld: blockedDelete,
    renameWhileHeld: blockedRename,
    writeAfterRelease,
    renameAfterRelease,
    deleteAfterRelease,
    hostProcessKilledWhileGuardHeld: true,
    guardReacquiredAfterProcessDeath: reacquire,
    aConnectionBlocksGuard: guardWhileAOpen,
    productionStoreGuard: productionGuard.ready,
  };

  results.verdict = 'DISPOSABLE_COPY_REQUIRED';
  results.disposition = 'Live read-only SQLite preflight is not a physical no-write boundary: opening it changes -shm, a separate writer is not excluded, and absent WAL/SHM sidecars may be created. Stop A, guard the production Store, copy its stable SQLite files into Host-owned scratch, and preflight only that disposable copy. Never treat scratch sidecars as production Store changes.';
  mkdirSync(resolve(evidencePath, '..'), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
} finally {
  try { rmSync(root, { recursive: true, force: true }); }
  catch (error) { console.error(`temporary probe cleanup deferred for ${root}: ${error.message}`); }
}
