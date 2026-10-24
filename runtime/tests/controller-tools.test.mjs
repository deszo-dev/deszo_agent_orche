import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store, MIGRATION_PATHS } from '../core/store.mjs';
import { createParser } from '../core/adapters.mjs';
import { hash, migrationCatalog, profileCompatibility, writeRuntimeManifest, inspectRuntimeBuild, inputsMatch, inputFingerprint } from '../../scripts/deszo-artifacts.mjs';
import { checkTransport } from '../../scripts/deszo-transport.mjs';
import { doctor, prepare } from '../../scripts/deszo-control.mjs';
import { openBridge } from '../../mcp/stdio-client.mjs';
import { connectDeszo, unwrap } from '../../mcp/controller-client.mjs';
import { planWorkspaceSync } from '../../scripts/deszo-workspace.mjs';
import { startTestRunner } from './helpers.mjs';

const temporary = () => mkdtempSync(join(tmpdir(), 'deszo-controller-'));
const fixture = resolve(import.meta.dirname, 'controller-stdio-fixture.mjs');

test('preflight reproduces schema 12 versus runtime 11 without changing store data', () => {
  const root = temporary(), store = new Store(root,{migrations:MIGRATION_PATHS.slice(0,12).map(path=>readFileSync(path,'utf8'))}); store.close();
  const before = hash(readFileSync(join(root, 'store/state.sqlite')));
  const result = profileCompatibility(root, migrationCatalog().slice(0, 11));
  assert.equal(result.state, 'incompatible'); assert.equal(result.issues[0].code, 'store_schema_too_new');
  assert.equal(result.version, 12); assert.equal(result.supportedVersion, 11);
  assert.equal(hash(readFileSync(join(root, 'store/state.sqlite'))), before);
});
test('preflight distinguishes line endings from a changed historical migration', () => {
  const root = temporary(), store = new Store(root); store.close();
  const catalogue = migrationCatalog();
  catalogue[9].sha256 = catalogue[9].crlfSha256;
  assert.equal(profileCompatibility(root, catalogue).state, 'compatible');
  assert.ok(profileCompatibility(root, catalogue).lineEndingDifferences.includes(10));
  Object.assign(catalogue[9], { sha256: '0'.repeat(64), lfSha256: '0'.repeat(64), crlfSha256: '0'.repeat(64) });
  assert.ok(profileCompatibility(root, catalogue).issues.some(item => item.code === 'migration_history_diverged'));
});
test('build inspection detects replaced executables and unexpected runtime files', () => {
  const dir = temporary();
  for (const entry of migrationCatalog()) copyFileSync(resolve('docs/storage', entry.file), join(dir, entry.file));
  writeFileSync(join(dir, 'runner.mjs'), '// fixture runtime\n');
  writeRuntimeManifest(dir); assert.deepEqual(inspectRuntimeBuild(dir).issues, []);
  writeFileSync(join(dir, 'runner.mjs'), '// changed after packaging\n');
  assert.ok(inspectRuntimeBuild(dir).issues.some(item => item.code === 'artifact_changed'));
  writeFileSync(join(dir, 'unexpected.mjs'), '// not in manifest\n');
  assert.ok(inspectRuntimeBuild(dir).issues.some(item => item.code === 'runtime_inventory_changed'));
});
test('doctor refuses an unmanifested build instead of presenting it as ready', async () => {
  const root = temporary(), store = new Store(root); store.close();
  const result = await doctor({ profile: root, build: temporary() });
  assert.equal(result.state, 'blocked'); assert.equal(result.authorityGranted, false);
  assert.ok(result.issues.some(item => item.code === 'artifact_or_profile_unreadable'));
});
test('prepare reuses a matching package without building or overwriting it', async t => {
  if (!checkTransport().valid) return t.skip('No measured receipt for this platform.');
  const root = temporary(), store = new Store(root); store.close();
  const build = temporary(), dir = join(build, 'runtime');
  const { mkdirSync } = await import('node:fs'); mkdirSync(dir);
  for (const entry of migrationCatalog()) copyFileSync(resolve('docs/storage', entry.file), join(dir, entry.file));
  writeFileSync(join(dir, 'runner.mjs'), '// fixture, never executed\n'); writeFileSync(join(build, 'deszo.exe'), 'fixture, never executed');
  writeRuntimeManifest(dir);
  const manifestPath = join(build, 'package-manifest.json');
  writeFileSync(manifestPath, JSON.stringify({ kind: 'DeszoOperatorPackage', version: 1, profileAtPreparation: root,
    exeSha256: hash(readFileSync(join(build, 'deszo.exe'))), desktopInputsSha256: inputFingerprint('desktop').sha256,
    runtimeManifestSha256: hash(readFileSync(join(dir, 'runtime-manifest.json'))) }));
  const before = readFileSync(manifestPath); const result = await prepare({ profile: root, out: build });
  assert.equal(result.cached, true); assert.ok(readFileSync(manifestPath).equals(before)); assert.equal(result.authorityGranted, false);
});
test('transport cache invalidates changed policy or missing negative measurement', () => {
  const current = checkTransport(), file = join(temporary(), 'receipt.json');
  const receipt = { kind: 'DeszoControllerTransport', passed: true, fingerprint: current.fingerprint,
    samples: [{ delayMs: 25000, elapsedMs: 25010, error: null, passed: true },
      { delayMs: 60000, elapsedMs: 45010, error: 'controller_transport_timeout', passed: true }] };
  writeFileSync(file, JSON.stringify(receipt)); assert.equal(checkTransport(file).valid, true);
  writeFileSync(file, JSON.stringify({ ...receipt, fingerprint: 'stale' })); assert.equal(checkTransport(file).valid, false);
  writeFileSync(file, JSON.stringify({ ...receipt, samples: receipt.samples.slice(0, 1) })); assert.equal(checkTransport(file).valid, false);
});
test('repeated measurement command reuses real saved evidence without a delay or model call', t => {
  if (!checkTransport().valid) return t.skip('No measured transport receipt for this platform/Node major.');
  const start = performance.now();
  const result = JSON.parse(execFileSync(process.execPath, [resolve('scripts/deszo-transport.mjs'), '--measure'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }));
  assert.equal(result.cached, true); assert.equal(result.passed, true); assert.ok(performance.now() - start < 5000);
});
test('stdio handles split UTF-8 and a timeout cancellation without killing its bridge', async () => {
  const bridge = await openBridge({ script: fixture, timeoutMs: 500 });
  try {
    const unicode = await bridge.call('unicode'); assert.equal(unicode.text, 'Привет 🌍');
    await assert.rejects(bridge.call('hold'), { code: 'controller_transport_timeout' });
    assert.equal((await bridge.call('status')).canceled, 1);
  } finally { await bridge.close(); }
});
test('stdio refuses an oversized response and settles its pending request', async () => {
  const bridge = await openBridge({ script: fixture, maxResponseBytes: 512 });
  try { await assert.rejects(bridge.call('oversized'), /byte bound/); }
  finally { await bridge.close(); }
});
test('Codex reconnect progress is diagnostic; terminal failure remains a failure', () => {
  const parser = createParser('codex');
  assert.match(parser.feed({ type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion: interrupted)' }).diagnostic, /Reconnecting/);
  assert.equal(parser.state.error, null); assert.equal(parser.state.terminal, false);
  parser.feed({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } });
  parser.feed({ type: 'turn.completed', usage: {} }); assert.equal(parser.state.terminal, true); assert.equal(parser.state.finalText, 'done');
  const failed = createParser('codex'); failed.feed({ type: 'turn.failed', error: { message: 'Reconnecting... permanent failure' } });
  assert.match(failed.state.error, /permanent failure/); assert.equal(failed.state.terminal, false);
});
test('the reusable client pins store and bridge and exposes complete supervised control', async () => {
  const api = await startTestRunner(); let bridge;
  try {
    const connection = api.runner.connection, expectedBridge = connection.bridgeScript;
    await assert.rejects(connectDeszo({ connectionFile: connection.connectionFile, expectedStoreId: 'wrong-store', expectedBridge }), /reviewed store/);
    bridge = await connectDeszo({ connectionFile: connection.connectionFile, expectedStoreId: connection.storeId, expectedBridge, allowExecution: true });
    assert.ok(bridge.tools.includes('get_control_grant')); assert.ok(bridge.tools.includes('observe_run'));
    assert.deepEqual(unwrap(await bridge.call('get_controller_state')).sessions, []);
    assert.equal(api.runner.engine.store.get('SELECT COUNT(*) AS n FROM runs').n, 0);
    assert.equal((await doctor({ profile: api.root, live: true })).state, 'ready_to_connect', 'Windows path case does not create a false runtime mismatch');
  } finally { await bridge?.close(); await api.close(); }
});
test('build reuse ignores operator-only metadata but refuses changed compiled inputs', () => {
  const current = inputFingerprint('runtime');
  const oversized = { sha256: 'old-key', entries: [...current.entries, { path: 'scripts/deszo-control.mjs', sha256: 'old-doctor' }].sort((a,b) => a.path.localeCompare(b.path)) };
  // Inventory ordering is canonical code-point order, not locale order.
  oversized.entries.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  assert.equal(inputsMatch('runtime', oversized), true);
  const changed = structuredClone(current); changed.sha256 = 'changed'; changed.entries.find(item => item.path === 'runtime/core/engine.mjs').sha256 = 'changed';
  assert.equal(inputsMatch('runtime', changed), false);
});
test('workspace planning preserves developer edits and discovers source changes without copying them', () => {
  const from = temporary(), to = temporary();
  const git = (root, ...args) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: root, windowsHide: true, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
  git(from, 'init', '-q'); writeFileSync(join(from, '.gitignore'), '.deszo/\n'); writeFileSync(join(from, 'source.txt'), 'base\n');
  git(from, 'add', '.'); git(from, '-c', 'user.name=Deszo fixture', '-c', 'user.email=fixture@invalid', 'commit', '-qm', 'fixture');
  git(to, 'clone', '-q', from, '.');
  const manifestPath = join(temporary(), 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify({ kind: 'DeszoSourceManifest', head: git(from, 'rev-parse', 'HEAD').trim(),
    entries: ['.gitignore','source.txt'].map(path => ({ path, sha256: hash(readFileSync(join(to, path))) })), extraInputs: [] }));
  writeFileSync(join(from, 'source.txt'), 'new source\n');
  assert.deepEqual(planWorkspaceSync({ from, to, manifestPath }).changes, ['source.txt']);
  assert.equal(readFileSync(join(to, 'source.txt'), 'utf8'), 'base\n');
  writeFileSync(join(to, 'source.txt'), 'developer work\n');
  assert.throws(() => planWorkspaceSync({ from, to, manifestPath }), /Preserve workspace edit/);
  assert.equal(readFileSync(join(to, 'source.txt'), 'utf8'), 'developer work\n');
  writeFileSync(join(to, 'source.txt'), 'base\n');
  const invalid = JSON.parse(readFileSync(manifestPath, 'utf8')); invalid.extraInputs = [{ path: 'D:escape', sha256: '0'.repeat(64) }];
  writeFileSync(manifestPath, JSON.stringify(invalid));
  assert.throws(() => planWorkspaceSync({ from, to, manifestPath }), /Invalid captured path/);
});
