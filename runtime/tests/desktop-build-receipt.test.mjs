import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyDesktopBuildReceipt } from '../../scripts/deszo-artifacts.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('desktop release provenance binds the compiled shell, runtime manifest, build identity, and production fault-hook mode', t => {
  const root = mkdtempSync(join(tmpdir(), 'deszo-desktop-build-receipt-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtimeResources = join(root, 'runtime');
  mkdirSync(runtimeResources);
  const executablePath = join(root, 'deszo.exe');
  const runtimeManifestPath = join(runtimeResources, 'runtime-manifest.json');
  const receiptPath = join(root, 'deszo-build.json');
  const executable = Buffer.from('test desktop executable');
  const runtimeManifest = Buffer.from(JSON.stringify({ kind: 'DeszoRuntimeBuild', version: 1, testFaultHooks: false, files: {} }));
  writeFileSync(executablePath, executable);
  writeFileSync(runtimeManifestPath, runtimeManifest);
  const receipt = { schemaVersion: 1, desktopBuildId: 'build-a', testFaultHooks: false,
    exeSha256: sha256(executable), runtimeManifestSha256: sha256(runtimeManifest) };
  const writeReceipt = value => writeFileSync(receiptPath, JSON.stringify(value));
  writeReceipt(receipt);

  assert.deepEqual(verifyDesktopBuildReceipt({ receiptPath, executablePath, runtimeResources, buildId: 'build-a' }), receipt);
  assert.throws(() => verifyDesktopBuildReceipt({ receiptPath, executablePath, runtimeResources, buildId: 'build-b' }), /identity/);
  writeReceipt({ ...receipt, testFaultHooks: true });
  assert.throws(() => verifyDesktopBuildReceipt({ receiptPath, executablePath, runtimeResources, buildId: 'build-a' }), /test-enabled/);
  writeReceipt(receipt);
  writeFileSync(executablePath, Buffer.from('different executable'));
  assert.throws(() => verifyDesktopBuildReceipt({ receiptPath, executablePath, runtimeResources, buildId: 'build-a' }), /executable/);
  writeFileSync(executablePath, executable);
  writeFileSync(runtimeManifestPath, JSON.stringify({ kind: 'DeszoRuntimeBuild', version: 1, testFaultHooks: true, files: {} }));
  assert.throws(() => verifyDesktopBuildReceipt({ receiptPath, executablePath, runtimeResources, buildId: 'build-a' }), /test-enabled/);
  writeFileSync(runtimeManifestPath, JSON.stringify({ kind: 'DeszoRuntimeBuild', version: 1, testFaultHooks: false, files: { stale: '0' } }));
  assert.throws(() => verifyDesktopBuildReceipt({ receiptPath, executablePath, runtimeResources, buildId: 'build-a' }), /runtime resources/);
});
