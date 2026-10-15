// Packaging checks use no inference and never persist the launcher-only credential.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openBridge } from './authoring-test-support.mjs';

const option = key => { const i = process.argv.indexOf(key); return i < 0 ? undefined : process.argv[i + 1]; };
const root = resolve(option('--root'));
const runnerScript = resolve(option('--runner') || 'dist-runtime/runner.mjs');
const bridgeScript = resolve(option('--bridge') || 'dist-runtime/bridge.mjs');
mkdirSync(root, { recursive: true });
const rejectChild = spawn(process.execPath, [runnerScript, '--root', join(root, 'forbidden'), '--dev-test-confirmation-off'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let rejectedOutput = '', rejectedError = '';
rejectChild.stdout.on('data', b => { rejectedOutput += b; }); rejectChild.stderr.on('data', b => { rejectedError += b; });
assert.notEqual(await new Promise(done => rejectChild.once('close', done)), 0);
assert.equal(rejectedOutput, ''); assert.match(rejectedError, /unsupported option/);
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', runnerScript, '--root', join(root, randomUUID()), '--bridge-file', bridgeScript, '--first-party-token-stdout'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const lines = createInterface({ input: child.stdout }); let bridge;
try {
  const connection = await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(Error('Packaged startup timed out.')), 20_000);
    lines.once('line', line => { clearTimeout(timer); try { done(JSON.parse(line)); } catch (error) { fail(error); } });
    child.once('error', fail);
  });
  const descriptor = JSON.parse(readFileSync(connection.connectionFile));
  assert.ok(connection.firstPartyToken); assert.ok(!descriptor.firstPartyToken);
  const call = async (token, path, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${connection.port}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  const settings = await call(connection.firstPartyToken, '/api/v2/settings');
  assert.equal(settings.body.settings.externalRunConfirmation, true);
  assert.equal((await call(connection.token, '/api/v2/settings', 'PUT', { requestId: randomUUID(), expectedRevision: settings.body.revision, settings: settings.body.settings })).status, 403);
  const retired = await call(connection.token, '/api/v2/workflows/packaged', 'PUT', { workflowId: 'packaged' });
  assert.equal(retired.status, 410); assert.equal(retired.body.code, 'api_upgrade_required');
  bridge = await openBridge({ script: bridgeScript, args: ['--connection-file', connection.connectionFile, '--client-provider', 'other'], env: { ...process.env, DESZO_MANAGED_INVOCATION: '' } });
  const contract = (await bridge.call('get_authoring_contract')).structuredContent;
  assert.equal(contract.status, 'ok'); assert.equal(contract.data.storeId, descriptor.storeId);
  const toolNames = (await bridge.request('tools/list')).tools.map(t => t.name);
  assert.ok(!toolNames.includes('start_run'));
  for (const token of [connection.token, connection.firstPartyToken]) assert.ok(!JSON.stringify({ contract, toolNames }).includes(token));
  const report = { passed: true, root: connection.root, runnerScript, bridgeScript, storeId: descriptor.storeId,
    packagedFixtureFlagRejected: true, freshConfirmationDefault: true, externalSettingsForbidden: true, legacySaveStatus: 410,
    publicDescriptorHasFirstPartyToken: false, authoringOnlyTools: toolNames, bridgeHandshake: true };
  writeFileSync(join(root, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await bridge?.close(); child.stdin.end('{"command":"shutdown"}\n');
  await new Promise(done => { if (child.exitCode !== null) done(); else child.once('close', done); });
}
