import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
import { openBridge } from './authoring-test-support.mjs';

const option = key => { const i = process.argv.indexOf(key); return i < 0 ? undefined : process.argv[i + 1]; };
const root = resolve(option('--root'));
const connectionFile = resolve(option('--connection-file'));
const connection = JSON.parse(readFileSync(connectionFile));
const cwd = join(root, 'authoring', 'antigravity');
const bridge = await openBridge({ script: connection.bridgeScript, args: ['--connection-file', connectionFile, '--client-provider', 'antigravity',
  '--working-directory', cwd, '--mcp-config-path', join(cwd, '.agents', 'mcp_config.json')] });
const call = async path => (await fetch(`http://127.0.0.1:${connection.port}${path}`, { headers: { Authorization: `Bearer ${connection.token}` } })).json();
const lines = createInterface({ input: process.stdin });
try {
  const contract = (await bridge.call('get_authoring_contract')).structuredContent;
  assert.equal(contract.status, 'ok');
  console.log(JSON.stringify({ phase: 'directory-registered', cwd, storeId: contract.data.storeId }));
  await new Promise((done, fail) => { const timer = setTimeout(() => fail(Error('The UI collision check was not completed before the timeout.')), 240_000); lines.once('line', () => { clearTimeout(timer); done(); }); });
  const uiEvidence = JSON.parse(readFileSync(join(root, 'ui-directory-conflict.json')));
  assert.match(uiEvidence.tree, /The workspace root overlaps a connected Antigravity authoring directory or MCP config path\./);
  const workspaces = await call('/api/v2/workspaces?limit=200');
  assert.ok(!workspaces.items.some(w => w.workspaceId === 'authoring-collision'));
  const workspace = workspaces.items.find(w => w.workspaceId === 'acceptance'); assert.ok(workspace);
  const forbiddenConfig = join(workspace.cwd, '.agents', 'mcp_config.json');
  mkdirSync(join(workspace.cwd, '.agents'), { recursive: true }); writeFileSync(forbiddenConfig, '{}');
  await assert.rejects(() => openBridge({ script: connection.bridgeScript, args: ['--connection-file', connectionFile, '--client-provider', 'antigravity',
    '--working-directory', workspace.cwd, '--mcp-config-path', forbiddenConfig] }), /authoring_directory_conflict/);
  const report = { passed: true, storeId: connection.storeId, registeredDirectory: cwd, collisionWorkspaceAbsent: true, uiCollisionRecorded: true, workspaceDirectoryHandshakeRejected: true };
  writeFileSync(join(root, 'directory-check-final.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { lines.close(); await bridge.close(); }
