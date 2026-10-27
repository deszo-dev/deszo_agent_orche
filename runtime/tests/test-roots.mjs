// Test-owned scratch roots and their lifecycle. A test file process (node --test) records every root it creates in its own owner
// registry under .deszo/tests/.owners/<owner>/, holds an exclusive SQLite lock there for its whole life, and removes each root as soon as
// its test ends: stoppers first (an in-process runner's close), then its tracked child processes, then the files. A passing test leaves
// nothing behind; a failing one leaves bounded diagnostics under .deszo/tests/failures/ (DESZO_TEST_KEEP_FAILED=1 keeps the whole root).
// A process that is killed hard keeps its registry; scripts/test-artifacts.mjs removes the roots of an owner whose lock is free again.
// Only a root this infrastructure created, recorded and can still prove (a direct child of an approved base, a real directory, not a
// link) is ever removed. Outside a test file process (scripts, real-provider harnesses) a root is an ordinary temporary directory.
// Order: this module's afterEach runs before a test's own t.after() callbacks, so a Host or Engine that must stop before its root goes is
// stopped in the test body (try/finally), registered with addStopper/trackProcess, or stopped in a file-level after().
import { afterEach, after, beforeEach } from 'node:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync,
  statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const repo = resolve(import.meta.dirname, '../..');
export const testsRoot = join(repo, '.deszo', 'tests');
export const ownersRoot = join(testsRoot, '.owners');
export const failuresRoot = join(testsRoot, 'failures');
// Roots are created only as direct children of these directories.
export const approvedBases = () => [testsRoot, tmpdir()];

const KEEP_FAILED = process.env.DESZO_TEST_KEEP_FAILED === '1';
const DIAGNOSTIC_LIMITS = { textBytes: 256 * 1024, sqliteBytes: 16 * 1024 * 1024, totalBytes: 48 * 1024 * 1024, files: 400, listing: 2000, keep: 20 };
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', 'webview2', 'versions', 'staging', 'runtime-bundle', 'EBWebView']);
const BINARY = /\.(exe|dll|pdb|node|wasm|pack|idx)$/i;
const TEXT = /\.(log|json|jsonl|txt|md|tap|out|err|ndjson|yaml|yml|toml)$/i;

export const isTestFileProcess = Boolean(process.env.NODE_TEST_CONTEXT) && /\.test\.m?js$/.test(process.argv[1] ?? '');

const comparable = path => (process.platform === 'win32' ? path.toLowerCase() : path);
const realBase = base => { try { return realpathSync.native(base); } catch { return resolve(base); } };

// Why a path may not be removed as a test root, or null when it may.
export function unsafeReason(root, bases = approvedBases()) {
  if (typeof root !== 'string' || !isAbsolute(root)) return 'not an absolute path';
  const absolute = resolve(root);
  const parent = comparable(realBase(dirname(absolute)));
  if (!bases.some(base => comparable(realBase(base)) === parent)) return 'outside the approved test bases';
  if ([...bases, repo].some(base => comparable(resolve(base)) === comparable(absolute))) return 'an approved base itself';
  let info;
  try { info = lstatSync(absolute); } catch (error) { return error.code === 'ENOENT' ? null : `unreadable (${error.code})`; }
  if (info.isSymbolicLink()) return 'a symbolic link or junction';
  if (!info.isDirectory()) return 'not a directory';
  let real;
  try { real = realpathSync.native(absolute); } catch (error) { return `unresolvable (${error.code})`; }
  if (comparable(real) !== comparable(absolute)) return 'resolves elsewhere';
  return null;
}

// Removes one verified root. Never follows a link out of it (Node's recursive rm unlinks a link or junction, it does not descend).
// Returns { removed, reason }. Windows sharing violations are retried for a bounded time, then reported.
export function removeVerifiedRoot(root, { bases } = {}) {
  const reason = unsafeReason(root, bases);
  if (reason) return { removed: false, reason: `refused: ${reason}` };
  if (!existsSync(root)) return { removed: true, reason: 'already absent' };
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    return { removed: true, reason: null };
  } catch (error) {
    return { removed: false, reason: `${error.code ?? 'error'}: ${error.message}` };
  }
}

// ---- Owner registry (only in a test file process) ----

let owner = null;
const roots = new Map(); // comparable(root) -> entry
let depth = 0;
let currentTest = null;
const reports = [];

function ensureOwner() {
  if (owner) return owner;
  const id = `${process.pid}-${randomUUID()}`;
  const dir = join(ownersRoot, id);
  mkdirSync(dir, { recursive: true });
  // The lock that proves this owner alive: released by the OS however the process ends (the same mechanism as the runtime's runner.lock).
  const db = new DatabaseSync(join(dir, 'owner.sqlite'));
  // A reconciliation probing this new owner holds the file for an instant; wait it out rather than fail the test.
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = DELETE; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (id TEXT); COMMIT');
  writeFileSync(join(dir, 'owner.json'), JSON.stringify({ id, pid: process.pid, testFile: process.argv[1], startedAt: new Date().toISOString() }));
  owner = { id, dir, db, registry: join(dir, 'roots.jsonl') };
  return owner;
}

function record(op, entry, extra = {}) {
  if (!owner) return;
  appendFileSync(owner.registry, `${JSON.stringify({ op, path: entry.path, test: entry.test, at: new Date().toISOString(), ...extra })}\n`);
}

function register(path, scope) {
  if (!isTestFileProcess) return path;
  ensureOwner();
  const entry = { path, test: currentTest, scope: scope ?? (depth > 0 ? 'test' : 'file'), stoppers: [], children: [] };
  roots.set(comparable(path), entry);
  record('create', entry);
  return path;
}

// mkdtempSync(prefixPath) for a test-owned root. prefixPath is join(<approved base>, '<prefix>-'). A root made inside a test is removed when
// that test ends; { scope: 'file' } keeps it for the rest of the file (a fixture built once and used by later tests).
export function ownedDir(prefixPath, { scope } = {}) {
  const base = dirname(prefixPath);
  if (isTestFileProcess && !approvedBases().some(item => comparable(realBase(item)) === comparable(realBase(base))))
    throw new Error(`A test root must be created directly in an approved base, not in ${base}.`);
  mkdirSync(base, { recursive: true });
  return register(mkdtempSync(prefixPath), scope);
}

// A root that the code under test will create at a fresh, unique path (a delivery's clone directory). It is owned only when nothing exists
// there yet, so an existing directory can never be adopted.
export function ownedPath(path) {
  if (!isTestFileProcess) return path;
  if (!approvedBases().some(item => comparable(realBase(item)) === comparable(realBase(dirname(path)))))
    throw new Error(`A test root must be directly in an approved base, not ${path}.`);
  if (existsSync(path)) throw new Error(`${path} already exists and cannot become a test-owned root.`);
  return register(path);
}

// A root that a child process started by this test created and reported back (a script that makes its own runner root). It must be a
// real directory directly in an approved base; from here on it has the same lifecycle as any other root of the test.
export function adoptRoot(path) {
  if (!isTestFileProcess) return path;
  const reason = unsafeReason(path);
  if (reason || !existsSync(path)) throw new Error(`${path} cannot become a test-owned root: ${reason ?? 'it does not exist'}.`);
  return register(path);
}

function ownerOf(path) {
  if (!path) return null;
  const target = comparable(resolve(path));
  for (const [key, entry] of roots) if (target === key || target.startsWith(key + comparable(sep))) return entry;
  return null;
}

export const isOwned = path => Boolean(ownerOf(path));

// Work that must finish before a root's files may go (an in-process Engine's close). No-op for a root this process does not own.
export function addStopper(path, stop) { ownerOf(path)?.stoppers.push(stop); }
// A child process using a root. It must have exited before the root is removed; at teardown a live one is ended (it is this process's child).
export function trackProcess(path, child) { if (child) ownerOf(path)?.children.push(child); }

const childExited = child => child.exitCode !== null || child.signalCode !== null;

async function stopOwned(entry) {
  const problems = [];
  for (const stop of entry.stoppers.splice(0)) {
    let timer;
    try { await Promise.race([stop(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('stopper timed out')), 30_000); })]); }
    catch (error) { problems.push(`stopper: ${error.message}`); } finally { clearTimeout(timer); }
  }
  for (const child of entry.children) {
    if (childExited(child)) continue;
    // The handle is this process's own child and has not exited, so its PID still names it.
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    if (!childExited(child)) await new Promise(done => { const timer = setTimeout(done, 15_000); child.once('exit', () => { clearTimeout(timer); done(); }); });
    if (!childExited(child)) problems.push(`child ${child.pid} did not exit`);
  }
  return problems;
}

// Removes a root now (a test that is done with it early). Refuses while a tracked child is alive. Idempotent.
export function releaseOwnedDir(path) {
  const entry = roots.get(comparable(path));
  if (!entry) return { removed: false, reason: 'not owned by this process' };
  const alive = entry.children.filter(child => !childExited(child));
  if (alive.length) return { removed: false, reason: `refused: live child ${alive.map(child => child.pid).join(',')}` };
  const result = removeVerifiedRoot(entry.path);
  if (result.removed) { roots.delete(comparable(path)); record('removed', entry); }
  else record('remove_failed', entry, { reason: result.reason });
  return result;
}

// ---- Failure diagnostics ----

function walk(root, visit) {
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    let entries;
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const item of entries) {
      const child = rel ? join(rel, item.name) : item.name;
      if (item.isSymbolicLink()) { visit(child, 'link'); continue; }
      if (item.isDirectory()) { visit(child, 'dir'); if (!SKIPPED_DIRECTORIES.has(item.name)) stack.push(child); continue; }
      visit(child, 'file');
    }
  }
}

function slug(text) { return String(text ?? 'unnamed').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60); }

export function collectDiagnostics(entries, { test, file, error }) {
  mkdirSync(failuresRoot, { recursive: true });
  const target = join(failuresRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}-${slug(basename(file ?? ''))}-${slug(test)}-${randomUUID().slice(0, 8)}`);
  mkdirSync(target, { recursive: true });
  let total = 0, copied = 0;
  const summary = { test, file, error: error ? { message: String(error.message ?? error).slice(0, 8000), stack: String(error.stack ?? '').slice(0, 8000), code: error.code ?? null } : null,
    keepFailed: KEEP_FAILED, roots: [] };
  for (const [index, entry] of entries.entries()) {
    const info = { path: entry.path, retained: KEEP_FAILED, children: entry.children.map(child => ({ pid: child.pid, exitCode: child.exitCode, signal: child.signalCode })), listing: [], copied: [] };
    if (existsSync(entry.path)) walk(entry.path, (rel, kind) => {
      let size = null;
      if (kind === 'file') { try { size = statSync(join(entry.path, rel)).size; } catch { /* Gone meanwhile. */ } }
      if (info.listing.length < DIAGNOSTIC_LIMITS.listing) info.listing.push({ path: rel, kind, size });
      if (kind !== 'file' || size === null || BINARY.test(rel) || copied >= DIAGNOSTIC_LIMITS.files) return;
      const sqlite = /\.sqlite(-wal|-shm)?$/i.test(rel);
      if (!sqlite && !TEXT.test(rel) && size > 64 * 1024) return;
      const limit = sqlite ? DIAGNOSTIC_LIMITS.sqliteBytes : DIAGNOSTIC_LIMITS.textBytes;
      if (sqlite && size > limit) return;
      const bytes = Math.min(size, limit);
      if (total + bytes > DIAGNOSTIC_LIMITS.totalBytes) return;
      const destination = join(target, 'files', String(index), rel);
      try {
        mkdirSync(dirname(destination), { recursive: true });
        if (size <= limit) copyFileSync(join(entry.path, rel), destination);
        else { const data = readFileSync(join(entry.path, rel)); writeFileSync(destination, data.subarray(data.length - limit)); }
        total += bytes; copied += 1; info.copied.push({ path: rel, bytes, truncated: size > limit });
      } catch { /* A file held by a process is listed, not copied. */ }
    });
    summary.roots.push(info);
  }
  writeFileSync(join(target, 'failure.json'), JSON.stringify(summary, null, 2));
  pruneFailures();
  return target;
}

function pruneFailures() {
  let names;
  try { names = readdirSync(failuresRoot).filter(name => existsSync(join(failuresRoot, name, 'failure.json'))).sort(); } catch { return; }
  for (const name of names.slice(0, Math.max(0, names.length - DIAGNOSTIC_LIMITS.keep)))
    removeVerifiedRoot(join(failuresRoot, name), { bases: [failuresRoot] });
}

// ---- Teardown ----

async function finalize(entries, outcome) {
  if (!entries.length) return;
  const problems = [];
  for (const entry of entries) problems.push(...(await stopOwned(entry)).map(text => `${entry.path}: ${text}`));
  const failed = outcome && !outcome.passed;
  if (failed) {
    try { const target = collectDiagnostics(entries, outcome); process.stderr.write(`[test-roots] diagnostics for "${outcome.test}": ${target}\n`); }
    catch (error) { problems.push(`diagnostics: ${error.message}`); }
  }
  for (const entry of entries) {
    if (failed && KEEP_FAILED) { record('retained', entry, { reason: 'DESZO_TEST_KEEP_FAILED' }); roots.delete(comparable(entry.path)); continue; }
    const result = releaseOwnedDir(entry.path);
    if (!result.removed) problems.push(`${entry.path}: ${result.reason}`);
  }
  for (const problem of problems) { reports.push(problem); process.stderr.write(`[test-roots] cleanup problem: ${problem}\n`); }
}

if (isTestFileProcess) {
  beforeEach(t => { if (depth === 0) currentTest = t.name; depth += 1; });
  afterEach(async t => {
    depth = Math.max(0, depth - 1);
    if (depth > 0) return;
    const entries = [...roots.values()].filter(entry => entry.scope === 'test');
    await finalize(entries, { passed: t.passed, test: t.name, file: process.argv[1], error: t.error });
    currentTest = null;
  });
  after(async () => {
    await finalize([...roots.values()], null);
    if (!owner) return;
    const unfinished = [...roots.values()].length || reports.length;
    if (reports.length) process.stderr.write(`[test-roots] ${reports.length} cleanup problem(s); registry kept at ${owner.dir}\n`);
    try { owner.db.close(); } catch { /* Already closed. */ }
    // A clean file leaves no registry; one with retained or unremovable roots keeps it for scripts/test-artifacts.mjs.
    const retained = readFileSync(owner.registry, 'utf8').includes('"op":"retained"');
    if (!unfinished && !retained) rmSync(owner.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
}
