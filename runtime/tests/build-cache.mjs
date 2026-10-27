// Reusable build outputs for the test suite (never test state). An output is reused only when the record beside it names the same inputs
// and the output still has the digest recorded when it was built; anything else is rebuilt. Inputs are content digests, never file names
// or times: a fixture is keyed by its source and the exact compiler, a desktop package by every repository build input and the toolchain.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '../..');
const sha256 = value => createHash('sha256').update(value).digest('hex');
export const sha256File = path => sha256(readFileSync(path));

const toolCache = new Map();
function toolVersion(command, args) {
  const key = `${command} ${args.join(' ')}`;
  if (!toolCache.has(key)) {
    const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    toolCache.set(key, result.status === 0 ? result.stdout.trim() : `unavailable: ${result.error?.message ?? result.stderr}`);
  }
  return toolCache.get(key);
}

const RUSTC_FLAGS = ['--edition=2021', '-O'];
const fixtureKey = source => sha256(JSON.stringify({ source: sha256File(source), rustc: toolVersion('rustc', ['-vV']), flags: RUSTC_FLAGS }));

// The directory a single-file Rust fixture is built into: <base>/<key>. A changed source or compiler is a different directory.
export function rustFixtureDir(source, base) {
  return join(base, fixtureKey(source).slice(0, 24));
}

function readRecord(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

// Builds `source` to `exe` unless a verified build is already there; returns the executable's SHA-256. The compiler writes a private file
// that is renamed into place, so a concurrent build or a running copy never sees a partly written executable, and an executable in use is
// never overwritten (the cause of LNK1104 when every test process recompiled into one shared path).
export function buildRustFixture(source, exe) {
  const record = join(dirname(exe), 'build.json');
  const key = fixtureKey(source);
  const existing = readRecord(record);
  if (existing?.key === key && existsSync(exe) && sha256File(exe) === existing.exeSha256) return existing.exeSha256;
  mkdirSync(dirname(exe), { recursive: true });
  const temporary = join(dirname(exe), `build-${process.pid}-${randomUUID().slice(0, 8)}.exe`);
  const built = spawnSync('rustc', [...RUSTC_FLAGS, source, '-o', temporary], { cwd: repo, encoding: 'utf8', timeout: 120_000, windowsHide: true });
  if (built.status !== 0) {
    rmSync(temporary, { force: true });
    throw new Error(`The Rust fixture ${source} did not build:\n${built.stdout}\n${built.stderr}`);
  }
  const exeSha256 = sha256File(temporary);
  try { renameSync(temporary, exe); }
  catch (error) {
    // An executable without a valid record is still running (an orphan of an interrupted run): refuse rather than replace it.
    rmSync(temporary, { force: true });
    throw new Error(`The Rust fixture ${exe} could not be installed (is a previous copy still running?): ${error.message}`);
  }
  rmSync(temporary.replace(/\.exe$/, '.pdb'), { force: true });
  const recordTemporary = `${record}.${randomUUID()}.tmp`;
  writeFileSync(recordTemporary, JSON.stringify({ key, source, exeSha256, rustc: toolVersion('rustc', ['-vV']), flags: RUSTC_FLAGS, builtAt: new Date().toISOString() }, null, 2));
  renameSync(recordTemporary, record);
  return exeSha256;
}

// ---- Desktop candidate packages (Proof B) ----

// Every repository file that can reach a desktop package: tracked and untracked-but-not-ignored files, except test files themselves
// (*.test.mjs) and the review evidence. Test support modules stay in: the runtime bundle includes one (runner.mjs imports
// runtime/tests/fixture-adapters.mjs). Deliberately wider than the desktop receipt's fingerprint, so a reused package can never miss an input.
function repositoryInputs() {
  const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
  const paths = [...new Set(listed.stdout.split('\0').filter(Boolean))].filter(path => !/^(runtime\/tests\/.*\.test\.mjs$|docs\/reviews\/)/.test(path)).sort();
  return paths.map(path => { const full = join(repo, path); return [path, existsSync(full) ? sha256File(full) : null]; });
}

// The installed dependency tree as npm records it: bundled modules (Ajv, the MCP server), Vite and the Tauri CLI come from node_modules,
// which git ignores, and an install can change it without changing package-lock.json.
function installedDependencies() {
  const path = join(repo, 'node_modules', '.package-lock.json');
  return existsSync(path) ? sha256File(path) : null;
}

export function desktopPackageKey({ buildId, overlay }) {
  return sha256(JSON.stringify({ schema: 2, buildId, overlay, inputs: repositoryInputs(), dependencies: installedDependencies(), node: process.version,
    rustc: toolVersion('rustc', ['-vV']), cargo: toolVersion('cargo', ['-V']), platform: process.platform, arch: process.arch,
    environment: Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(CARGO_|RUSTFLAGS|RUSTC|TAURI_)/i.test(name)).sort()) }));
}

// The package recorded in <packageRoot>.cache.json (beside the package, so it is not part of its digest), when it was built from `key` and its executable and candidate digests still match.
// `digestCandidate` is the Host's own digest of a candidate directory.
export async function verifiedDesktopPackage(packageRoot, key, digestCandidate) {
  const cached = readRecord(`${packageRoot}.cache.json`);
  if (!cached || cached.key !== key) return { hit: false, reason: cached ? 'inputs changed' : 'no cache record' };
  const executable = join(packageRoot, 'deszo.exe');
  if (!existsSync(executable) || sha256File(executable) !== cached.exeSha256) return { hit: false, reason: 'executable digest differs' };
  const packageDigest = await digestCandidate(packageRoot);
  if (packageDigest !== cached.packageDigest) return { hit: false, reason: 'package digest differs' };
  return { hit: true, exeSha256: cached.exeSha256, packageDigest };
}

export function recordDesktopPackage(packageRoot, record) {
  const path = `${packageRoot}.cache.json`;
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify({ ...record, recordedAt: new Date().toISOString() }, null, 2));
  renameSync(temporary, path);
}
