// Test-owned desktop builds never change the production artifact set. A Node test names a root inside .deszo/tests with
// DESZO_BUILD_ROOT; the build chain refuses a test build without one, refuses links that would lead out of it, and a failing
// test-hook build leaves production untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { PROJECT, TESTS_ROOT, testLayout } from '../../scripts/build-layout.mjs';
import { productionArtifactSnapshot, snapshotChanges } from './production-artifacts.mjs';

const control = join(PROJECT, 'scripts', 'deszo-control.mjs');
const bundle = join(PROJECT, 'scripts', 'bundle-runtime.mjs');
const tauriBuild = join(PROJECT, 'scripts', 'tauri-build.mjs');
const isolationRoot = join(TESTS_ROOT, 'desktop-build-isolation');

// A child environment as a Node test build sees it, with the build-chain variables under the test's control only.
function testEnv(extra = {}) {
  const env = { ...process.env, NODE_TEST_CONTEXT: '1' };
  for (const key of ['DESZO_BUILD_ROOT', 'DESZO_TEST_FAULT_HOOKS', 'DESZO_TAURI_CONFIG_OVERLAY']) delete env[key];
  return { ...env, ...extra };
}

function freshRoot(name) {
  const root = join(isolationRoot, name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  return root;
}

const runNode = (script, args, env) => spawnSync(process.execPath, [script, ...args], { cwd: PROJECT, env, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
const combined = result => `${result.stdout}\n${result.stderr}`;

test('a build root must be a directory strictly inside .deszo/tests', () => {
  assert.throws(() => testLayout(TESTS_ROOT), /must be a directory inside/);
  assert.throws(() => testLayout(join(TESTS_ROOT, '..', 'outside-the-tests')), /must be a directory inside/);
  assert.throws(() => testLayout(tmpdir()), /must be a directory inside/);
  const root = join(TESTS_ROOT, 'layout-check');
  const layout = testLayout(root);
  for (const path of [layout.exe, layout.shim, layout.receipt, layout.inputs, layout.runtime, layout.runtimeShim, layout.frontend, layout.cargoTarget])
    assert.ok(path.startsWith(root + sep), `${path} is inside the test root`);
  assert.equal(layout.env.CARGO_TARGET_DIR, layout.cargoTarget, 'cargo writes its outputs into the test root');
});

// Creates a junction (no privilege needed) and returns a cleanup that removes the junction and then its target directory.
function junction(link, name) {
  const target = join(tmpdir(), `deszo-junction-target-${process.pid}-${name}`);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  rmSync(link, { recursive: true, force: true });
  const made = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'mklink', '/J', link, target], { encoding: 'utf8', windowsHide: true });
  assert.equal(made.status, 0, `junction created for the probe: ${combined(made)}`);
  return () => {
    // rmdir removes only the junction itself; the target directory is then removed as an ordinary directory.
    spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'rmdir', link], { encoding: 'utf8', windowsHide: true });
    rmSync(target, { recursive: true, force: true });
  };
}

test('a test build root reached through a junction is refused', () => {
  freshRoot('junction-probe');
  const link = join(isolationRoot, 'junction-link');
  const cleanup = junction(link, 'root');
  try {
    assert.throws(() => testLayout(link), /link or junction|resolves outside/, 'a junction at the root is refused');
    assert.throws(() => testLayout(join(link, 'nested')), /link or junction|resolves outside/, 'a root beneath a junction is refused');
  } finally { cleanup(); }
});

test('a junction at a directory the desktop build writes is refused before anything is written', () => {
  for (const name of ['cargo-target', 'cargo-target/release', 'dist-runtime', 'frontend-dist']) {
    const label = name.replaceAll('/', '-');
    const root = freshRoot(`link-${label}`);
    const parent = join(root, ...name.split('/').slice(0, -1));
    mkdirSync(parent, { recursive: true });
    const cleanup = junction(join(root, ...name.split('/')), label);
    try {
      assert.throws(() => testLayout(root), /link or junction/, `a junction at ${name} is refused`);
    } finally { cleanup(); }
  }
});

test('build commands refuse test builds without a test-owned root, and production stays unchanged', () => {
  const before = productionArtifactSnapshot();
  const cases = [
    ['a Node test build without DESZO_BUILD_ROOT', bundle, [], testEnv(), /DESZO_BUILD_ROOT/],
    ['a Node test build with a root outside .deszo/tests', bundle, [], testEnv({ DESZO_BUILD_ROOT: join(tmpdir(), 'deszo-outside') }), /inside/],
    ['a test-hook bundle outside a Node test', bundle, [], testEnv({ NODE_TEST_CONTEXT: '', DESZO_TEST_FAULT_HOOKS: '1' }), /reserved for test-owned/],
    ['a test build of the control chain without a root', control, ['build-begin'], testEnv(), /DESZO_BUILD_ROOT/],
    ['a test build with a frontend path that is not plain', tauriBuild, [], testEnv({ DESZO_BUILD_ROOT: freshRoot('metachar&root'), DESZO_TEST_FAULT_HOOKS: '1' }), /may contain only/],
    ['a production build with a test-only overlay', tauriBuild, [], { ...process.env, NODE_TEST_CONTEXT: '', DESZO_TAURI_CONFIG_OVERLAY: join(PROJECT, 'package.json') }, /test-only configuration/],
  ];
  for (const [description, script, args, env, pattern] of cases) {
    const result = runNode(script, args, env);
    assert.notEqual(result.status, 0, `${description} must be refused`);
    assert.match(combined(result), pattern, description);
  }
  assert.deepEqual(snapshotChanges(before, productionArtifactSnapshot()), [], 'no refused build changed a production artifact');
});

test('a desktop build that produced no shim or executable publishes no receipt', () => {
  const root = freshRoot('missing-outputs');
  const layout = testLayout(root);
  const before = productionArtifactSnapshot();
  const env = testEnv({ DESZO_BUILD_ROOT: root, DESZO_DESKTOP_BUILD_ID: 'isolation-missing' });
  assert.equal(runNode(control, ['build-begin'], env).status, 0, 'build-begin records the inputs of the test build');
  const finish = runNode(control, ['build-finish'], env);
  assert.notEqual(finish.status, 0);
  assert.match(finish.stderr, /did not produce deszo\.exe and the launch shim/);
  assert.equal(existsSync(layout.receipt), false, 'no receipt is published without the compiled outputs');
  assert.equal(existsSync(layout.runtimeShim), false, 'no shim is copied into the runtime without the compiled shim');
  assert.deepEqual(snapshotChanges(before, productionArtifactSnapshot()), [], 'production artifacts are unchanged');
});

test('a failing test-hook desktop build leaves the production artifact set unchanged', () => {
  const root = freshRoot('failing-hook-build');
  const layout = testLayout(root);
  // An unreadable build configuration makes tauri-build.mjs fail after the test runtime has been bundled. This is the failure path
  // that previously could replace the shared runtime and receipt.
  const overlay = join(root, 'broken-overlay.json');
  writeFileSync(overlay, '{ "build": ');
  const before = productionArtifactSnapshot();
  const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run desktop:build'], { cwd: PROJECT, encoding: 'utf8',
    windowsHide: true, timeout: 600_000, env: testEnv({ DESZO_TEST_FAULT_HOOKS: '1', DESZO_BUILD_ROOT: root, DESZO_DESKTOP_BUILD_ID: 'isolation-failure',
      DESZO_TAURI_CONFIG_OVERLAY: overlay }) });
  assert.notEqual(result.status, 0, combined(result));
  assert.match(combined(result), /JSON/, 'the failure is the unreadable configuration, not an unrelated error');
  assert.deepEqual(snapshotChanges(before, productionArtifactSnapshot()), [], 'the failed test-hook build changed no production artifact');
  // The hook bundle was written where the test asked for it, and it carries the test-hook marker.
  const manifest = JSON.parse(readFileSync(join(layout.runtime, 'runtime-manifest.json'), 'utf8'));
  assert.equal(manifest.testFaultHooks, true, 'the test-hook bundle is confined to the test root');
  assert.equal(existsSync(layout.receipt), false, 'a failed build publishes no receipt');
});
