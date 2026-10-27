// Runs the runtime test suite or one developer tier, one file process at a time.
//   node scripts/run-tests.mjs full          every runtime/tests/*.test.mjs (npm test)
//   node scripts/run-tests.mjs quick         files listed in neither tier of runtime/tests/tiers.json
//   node scripts/run-tests.mjs integration   real Engine/Host, Process Custody, recovery and P1/P2/P3 integration files
//   node scripts/run-tests.mjs heavy         Tauri desktop replacement, F7 Git scale, control-host exploration
//   node scripts/run-tests.mjs check         validates the tier lists against the files on disk
// Any extra argument (e.g. --test-name-pattern=...) is passed to node --test.
// Every tier except quick holds the test gate (.deszo/tests/.gate) for its whole run: the gated tiers share build outputs (the Tauri
// target and packages, Cargo targets, fixture binaries), and two of them at once is how the P2/P3 regressions met LNK1104 and contention
// failures. The gate is an exclusive SQLite lock that the operating system releases however this process ends, so an abandoned gate never
// blocks the next run; a held one refuses the new run at once and never stops the other. Before a run, the roots of test processes that
// were killed hard are reconciled (scripts/test-artifacts.mjs).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { reconcile } from './test-artifacts.mjs';

const repo = resolve(import.meta.dirname, '..');
const testsDir = join(repo, 'runtime', 'tests');
const gateDir = join(repo, '.deszo', 'tests', '.gate');
const CONTENDED = new Set([5, 6]); // SQLITE_BUSY, SQLITE_LOCKED

export function classify() {
  const tiers = JSON.parse(readFileSync(join(testsDir, 'tiers.json'), 'utf8'));
  const files = readdirSync(testsDir).filter(name => name.endsWith('.test.mjs')).sort();
  const problems = [];
  const listed = new Map();
  for (const tier of ['heavy', 'integration']) {
    for (const name of tiers[tier] ?? []) {
      if (!files.includes(name)) problems.push(`${tier} lists ${name}, which is not a test file`);
      if (listed.has(name)) problems.push(`${name} is listed in both ${listed.get(name)} and ${tier}`);
      listed.set(name, tier);
    }
  }
  const selection = { heavy: [], integration: [], quick: [] };
  for (const name of files) selection[listed.get(name) ?? 'quick'].push(name);
  const covered = selection.heavy.length + selection.integration.length + selection.quick.length;
  if (covered !== files.length) problems.push(`the tiers cover ${covered} of ${files.length} files`);
  return { files, selection, problems };
}

function acquireGate(tier) {
  mkdirSync(gateDir, { recursive: true });
  const db = new DatabaseSync(join(gateDir, 'gate.sqlite'));
  try {
    db.exec('PRAGMA journal_mode = DELETE; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS runs (pid INTEGER, tier TEXT, started_at TEXT); COMMIT');
  } catch (error) {
    db.close();
    if (!CONTENDED.has(error.errcode & 0xff)) throw error;
    let holder = 'unknown';
    try { holder = readFileSync(join(gateDir, 'gate.json'), 'utf8'); } catch { /* Not written yet. */ }
    return { refused: holder };
  }
  writeFileSync(join(gateDir, 'gate.json'), JSON.stringify({ pid: process.pid, tier, startedAt: new Date().toISOString(), cwd: process.cwd() }));
  return { db };
}

async function main() {
  const [tier = 'full', ...passThrough] = process.argv.slice(2);
  const { files, selection, problems } = classify();
  if (tier === 'check') {
    console.log(JSON.stringify({ files: files.length, heavy: selection.heavy.length, integration: selection.integration.length, quick: selection.quick.length, problems }, null, 2));
    process.exitCode = problems.length ? 1 : 0;
    return;
  }
  if (!['full', 'quick', 'integration', 'heavy'].includes(tier)) { console.error(`unknown tier ${tier}`); process.exitCode = 1; return; }
  if (problems.length) { console.error(`[run-tests] tiers.json is inconsistent:\n  ${problems.join('\n  ')}`); process.exitCode = 1; return; }
  let gate = null;
  if (tier !== 'quick') {
    gate = acquireGate(tier);
    if (gate.refused) {
      console.error(`[run-tests] another gated test run is active (${gate.refused}). It is left running; start this one when it ends.`);
      process.exitCode = 75;
      return;
    }
  }
  const reconciled = reconcile({ log: () => {} });
  if (reconciled.removedRoots || reconciled.ambiguous.length)
    console.error(`[run-tests] stale test roots: removed ${reconciled.removedRoots}; left ${reconciled.ambiguous.length} unexplained${reconciled.ambiguous.length ? `:\n  ${reconciled.ambiguous.join('\n  ')}` : ''}`);
  // The full suite is selected exactly as before: Node expands the same pattern.
  const selected = tier === 'full' ? ['runtime/tests/*.test.mjs'] : selection[tier].map(name => `runtime/tests/${name}`);
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', '--test-concurrency=1', ...passThrough, ...selected],
    { cwd: repo, stdio: 'inherit' });
  const code = await new Promise(done => child.once('exit', (exitCode, signal) => done(exitCode ?? (signal ? 1 : 0))));
  if (existsSync(join(repo, '.deszo', 'tests', '.owners')) && readdirSync(join(repo, '.deszo', 'tests', '.owners')).length)
    console.error('[run-tests] some test roots could not be removed; see node scripts/test-artifacts.mjs status');
  gate?.db.close();
  process.exitCode = code;
}

await main();
