// Test artifact status and stale-root reconciliation (runtime/tests/test-roots.mjs).
//   node scripts/test-artifacts.mjs status               owners, their roots, failure diagnostics, unowned legacy entries
//   node scripts/test-artifacts.mjs reconcile [--dry-run] [--include-retained]
// Reconciliation removes only roots that a test file process recorded in its own registry, after proving that process gone: its exclusive
// owner lock can be taken again (the operating system releases it however the process ended). A live owner is never touched. Every root
// is checked again before removal (a direct child of an approved base, a real directory, not a link). A root kept on purpose
// (DESZO_TEST_KEEP_FAILED=1) stays unless --include-retained is given. Anything unexplained is reported, never removed. Unowned
// directories from before this mechanism are only counted.
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { failuresRoot, ownersRoot, removeVerifiedRoot, testsRoot, unsafeReason } from '../runtime/tests/test-roots.mjs';

const CONTENDED = new Set([5, 6]); // SQLITE_BUSY, SQLITE_LOCKED

// 'alive' while the owning process holds its lock, 'dead' once it can be taken, 'unknown' when it cannot be told.
export function ownerState(dir) {
  const lock = join(dir, 'owner.sqlite');
  if (!existsSync(lock)) return 'unknown';
  let db;
  try {
    db = new DatabaseSync(lock);
    db.exec('BEGIN EXCLUSIVE; COMMIT');
    return 'dead';
  } catch (error) {
    return CONTENDED.has(error.errcode & 0xff) ? 'alive' : 'unknown';
  } finally { try { db?.close(); } catch { /* Not open. */ } }
}

// The final state of every root an owner recorded: create, then removed / remove_failed / retained.
export function ownerRoots(dir) {
  const registry = join(dir, 'roots.jsonl');
  if (!existsSync(registry)) return null;
  const roots = new Map();
  for (const line of readFileSync(registry, 'utf8').split(/\r?\n/).filter(Boolean)) {
    let entry;
    try { entry = JSON.parse(line); } catch { return null; }
    if (entry.op === 'create') roots.set(entry.path, { path: entry.path, test: entry.test, state: 'created' });
    else if (roots.has(entry.path)) roots.get(entry.path).state = entry.op;
  }
  return [...roots.values()];
}

// `owners` (default: every owner) and `bases` (default: the approved bases) narrow a reconciliation, as the cleanup tests do.
export function reconcile({ dryRun = false, includeRetained = false, log = console.log, owners = () => true, bases } = {}) {
  const summary = { owners: 0, alive: 0, removedRoots: 0, keptRoots: 0, ambiguous: [] };
  if (!existsSync(ownersRoot)) return summary;
  for (const name of readdirSync(ownersRoot).filter(owners)) {
    const dir = join(ownersRoot, name);
    summary.owners += 1;
    const state = ownerState(dir);
    if (state === 'alive') { summary.alive += 1; continue; }
    const roots = ownerRoots(dir);
    if (state === 'unknown' || !roots) { summary.ambiguous.push(`${dir}: owner ${state}, registry ${roots ? 'readable' : 'unreadable'}`); continue; }
    let unresolved = 0;
    for (const root of roots) {
      if (root.state === 'removed') continue;
      if (root.state === 'retained' && !includeRetained) { unresolved += 1; summary.keptRoots += 1; continue; }
      if (!existsSync(root.path)) continue;
      const reason = unsafeReason(root.path, bases);
      if (reason) { unresolved += 1; summary.ambiguous.push(`${root.path}: ${reason}`); continue; }
      if (dryRun) { log(`would remove ${root.path}`); unresolved += 1; continue; }
      const result = removeVerifiedRoot(root.path, { bases });
      if (result.removed) { summary.removedRoots += 1; log(`removed ${root.path} (owner ${name}, test ${root.test ?? 'file'})`); }
      else { unresolved += 1; summary.ambiguous.push(`${root.path}: ${result.reason}`); }
    }
    if (!unresolved && !dryRun) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  return summary;
}

function directorySize(path) {
  let files = 0, bytes = 0;
  const stack = [path];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(child);
      else { files += 1; try { bytes += statSync(child).size; } catch { /* Gone. */ } }
    }
  }
  return { files, bytes };
}

// Owned roots currently recorded, so legacy counting can tell them apart.
function recordedRoots() {
  const paths = new Set();
  if (!existsSync(ownersRoot)) return paths;
  for (const name of readdirSync(ownersRoot)) for (const root of ownerRoots(join(ownersRoot, name)) ?? []) paths.add(root.path.toLowerCase());
  return paths;
}

const family = name => name.replace(/-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}.*$/, '').replace(/-[A-Za-z0-9_]{6}$/, '').replace(/-[0-9a-f]{8}$/, '');

export function status() {
  const owners = existsSync(ownersRoot) ? readdirSync(ownersRoot).map(name => {
    const dir = join(ownersRoot, name), roots = ownerRoots(dir) ?? [];
    const counts = {};
    for (const root of roots) counts[root.state] = (counts[root.state] ?? 0) + 1;
    return { owner: name, state: ownerState(dir), roots: counts };
  }) : [];
  const failures = existsSync(failuresRoot) ? readdirSync(failuresRoot) : [];
  const recorded = recordedRoots();
  const legacy = {};
  for (const [base, filter] of [[testsRoot, () => true], [tmpdir(), name => name.startsWith('deszo-')]]) {
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory() || !filter(entry.name) || ['.owners', 'failures'].includes(entry.name)) continue;
      if (recorded.has(join(base, entry.name).toLowerCase())) continue;
      const key = `${base === testsRoot ? '.deszo/tests' : '%TEMP%'}/${family(entry.name)}`;
      legacy[key] = (legacy[key] ?? 0) + 1;
    }
  }
  return { owners, failures: { count: failures.length, ...directorySize(failuresRoot) },
    unownedEntries: Object.fromEntries(Object.entries(legacy).sort((a, b) => b[1] - a[1])) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command = 'status', ...flags] = process.argv.slice(2);
  if (command === 'status') console.log(JSON.stringify(status(), null, 2));
  else if (command === 'reconcile') {
    const summary = reconcile({ dryRun: flags.includes('--dry-run'), includeRetained: flags.includes('--include-retained') });
    console.log(JSON.stringify(summary, null, 2));
    if (summary.ambiguous.length) process.exitCode = 2;
  } else { console.error('usage: node scripts/test-artifacts.mjs status | reconcile [--dry-run] [--include-retained]'); process.exitCode = 1; }
}
