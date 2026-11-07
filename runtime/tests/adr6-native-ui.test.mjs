// Injected native-protocol tests. Actual Windows activation/desktop behavior still needs installed evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureNativeUi } from '../host/nativeUi.mjs';
import { sha256 } from '../core/canonical.mjs';
import { ownedDir } from './test-roots.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aefkAAAAASUVORK5CYII=';
function fixture() {
  const stateRoot = ownedDir(join(tmpdir(), 'deszo-native-ui-')), process = { pid: 6001, creationTime: '10001', imageSha256: 'a'.repeat(64), sessionId: 1 };
  const args = { stateRoot, process, policyId: 'policy', runtimeGeneration: 'generation', deadlineMs: 50, pollMs: 1 };
  const identity = { pid: process.pid, creationTime: process.creationTime, sessionId: 1, runtimeGeneration: args.runtimeGeneration };
  return { ...args, args, identity, evidence: { ...identity, available: true, foreground: true, pngBase64: png } };
}

test('native UI requests focus once for its exact owned application, then persists only bound PNG evidence', async () => {
  const c = fixture(), calls = [];
  const result = await captureNativeUi({ ...c.args, native: async (method, params) => {
    calls.push([method, params]);
    if (method === 'uiFocus') return { focused: true, ...c.identity };
    if (method === 'uiEvidence') return calls.length === 1 ? { available: false, reason: 'application_not_foreground' } : c.evidence;
    throw new Error('Unexpected action');
  } });
  assert.equal(result.available, true); assert.equal(result.activation.focused, true);
  assert.deepEqual(calls.map(([method]) => method), ['uiEvidence', 'uiFocus', 'uiEvidence']);
  assert.deepEqual(calls[1][1], { domain: c.policyId, runtimeGeneration: c.runtimeGeneration, process: c.process });
  assert.equal(result.sha256, sha256(Buffer.from(png, 'base64'))); assert.deepEqual(readFileSync(result.path), Buffer.from(png, 'base64'));
  assert.ok(result.path.startsWith(join(c.stateRoot, 'evidence'))); assert.equal(Object.hasOwn(result, 'pngBase64'), false);
});

test('Windows activation refusal is a blocker with no synthetic-input or alternate-window fallback', async () => {
  const c = fixture(), calls = [];
  const result = await captureNativeUi({ ...c.args, native: async method => {
    calls.push(method); return method === 'uiEvidence' ? { available: false, reason: 'application_not_foreground' } : { focused: false, reason: 'foreground_activation_denied' };
  } });
  assert.equal(result.available, false); assert.equal(result.activation.reason, 'foreground_activation_denied');
  assert.deepEqual(calls, ['uiEvidence', 'uiFocus']); assert.equal(existsSync(join(c.stateRoot, 'evidence')), false);
});

test('wrong process birth, generation or desktop and malformed image cannot become native UI evidence', async () => {
  for (const change of [{ creationTime: 'reused' }, { runtimeGeneration: 'other' }, { sessionId: 2 }, { pngBase64: 'bm90IGEgcG5n' }]) {
    const c = fixture();
    const result = await captureNativeUi({ ...c.args, native: async method => { assert.equal(method, 'uiEvidence'); return { ...c.evidence, ...change }; } });
    assert.equal(result.available, false); assert.equal(existsSync(join(c.stateRoot, 'evidence')), false);
  }
  const c = fixture();
  const result = await captureNativeUi({ ...c.args, native: async method => method === 'uiEvidence' ? { available: false, reason: 'application_not_foreground' } : { focused: true, ...c.identity, runtimeGeneration: 'other' } });
  assert.equal(result.reason, 'native_activation_identity_mismatch'); assert.equal(existsSync(join(c.stateRoot, 'evidence')), false);
});

test('unavailable desktop never focuses; absent window has a bounded wait without focus attempts', async () => {
  for (const reason of ['interactive_desktop_unavailable', 'no_visible_window_for_process']) {
    const c = fixture(); let calls = 0;
    const result = await captureNativeUi({ ...c.args, deadlineMs: 5, native: async method => { calls++; assert.equal(method, 'uiEvidence'); return { available: false, reason }; } });
    assert.equal(result.available, false); assert.equal(result.reason, reason); assert.ok(calls >= 1 && calls < 20);
    assert.equal(existsSync(join(c.stateRoot, 'evidence')), false);
  }
});
