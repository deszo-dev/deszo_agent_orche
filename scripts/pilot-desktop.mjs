// Installed-app containment probe with REAL CLI children and prepared, disposable Node descendants.
// The app, its store and its process identities are isolated. No user-owned process is stopped.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { singleAgent } from '../runtime/tests/helpers.mjs';
import { openBridge } from './authoring-test-support.mjs';

const execute = promisify(execFile);
const root = resolve(process.argv[2] || '.deszo/pilots/after-fixes-desktop');
const option = key => { const index = process.argv.indexOf(key); return index < 0 ? undefined : process.argv[index + 1]; };
const exe = resolve(option('--app') || join(root, 'installed/deszo.exe'));
const storage = resolve(option('--storage') || join(process.env.LOCALAPPDATA, 'local.deszo.pilot20261014fixed'));
const connectionFile = join(storage, 'runtime/connection.json');
const evidence = join(root, 'evidence');
const startupOnly = process.argv.includes('--startup-only');
const evidencePrefix = startupOnly ? 'desktop-startup-final' : 'desktop';
const quote = value => "'" + String(value).replace(/'/g, "''") + "'";
const ps = async code => {
  const result = await execute('powershell.exe', ['-NoProfile', '-Command', "$ErrorActionPreference='Stop'; " + code], { windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  return result.stdout.trim() ? JSON.parse(result.stdout.trim()) : null;
};
const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const wait = async (label, predicate, seconds = 60) => {
  const stop = Date.now() + seconds * 1000;
  while (Date.now() < stop) { const result = await predicate(); if (result) return result; await delay(250); }
  throw new Error(`Timed out waiting for ${label}.`);
};
const processInfo = pid => ps(`$p=Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if ($p) { [pscustomobject]@{pid=$p.Id;path=$p.Path;startedAt=$p.StartTime.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress } else { Write-Output 'null' }; exit 0`);
const sameProcess = async identity => {
  const current = await processInfo(identity.pid);
  return !!current && current.path === identity.path && current.startedAt === identity.startedAt;
};
const stopOwned = async identity => {
  assert.ok(identity?.pid > 0 && identity.path && identity.startedAt);
  // One shell rechecks both identity and start time immediately before termination.
  return ps(`$p=Get-Process -Id ${identity.pid} -ErrorAction SilentlyContinue; if ($p) { if ($p.Path -ne ${quote(identity.path)} -or $p.StartTime.ToUniversalTime().ToString('o') -ne ${quote(identity.startedAt)}) { throw 'Owned process identity changed; refusing termination' }; Stop-Process -Id $p.Id -Force }; @{stopped=${identity.pid}} | ConvertTo-Json -Compress`);
};
const launch = () => ps(`$p=Start-Process -FilePath ${quote(exe)} -WindowStyle Hidden -PassThru; [pscustomobject]@{pid=$p.Id;path=$p.Path;startedAt=$p.StartTime.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress`);
const readConnection = () => { try { return JSON.parse(readFileSync(connectionFile, 'utf8')); } catch { return null; } };
const call = async (connection, method, path, body, extraHeaders = {}) => {
  const endpoint = path.startsWith('/api/') ? path : `/api/v2${path}`;
  const response = await fetch(`http://127.0.0.1:${connection.port}${endpoint}`, { method,
    headers: { Authorization: `Bearer ${connection.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
  const result = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(result)}`);
  return result;
};
const waitConnection = previous => wait('the frontend to obtain a new authenticated runtime connection', async () => {
  const connection = readConnection();
  if (!connection || previous && connection.token === previous.token) return false;
  try { await call(connection, 'GET', '/api/v3/authoring/contract'); return connection; } catch { return false; }
}, 90);
const runtimeIdentity = async app => {
  const row = await ps(`$p=Get-CimInstance Win32_Process -Filter "Name='node.exe' AND ParentProcessId=${app.pid}"; @($p | Select-Object @{n='pid';e={$_.ProcessId}}) | ConvertTo-Json -Compress`);
  const rows = Array.isArray(row) ? row : row ? [row] : [];
  assert.equal(rows.length, 1, 'Exactly one owned runtime must be a direct child of the app.');
  const identity = await processInfo(rows[0].pid);
  assert.ok(identity);
  return identity;
};
const readStore = query => {
  const db = new DatabaseSync(join(storage, 'store/state.sqlite'), { readOnly: true });
  try { return query(db); } finally { db.close(); }
};
const holdSource = `import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const child=spawn(process.execPath,['-e',"require('node:fs').writeFileSync('child-ready.json',JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));setInterval(()=>{},1000)"],{stdio:'ignore',windowsHide:true});
writeFileSync('hold-ready.json',JSON.stringify({pid:process.pid,childPid:child.pid,startedAt:new Date().toISOString()}));
setTimeout(()=>{child.kill();process.exit(0)},240000);
`;
const beginHold = async (connection, workspaceId) => {
  const workspaces = await call(connection, 'GET', '/workspaces?limit=200');
  const workspace = workspaces.items.find(item => item.workspaceId === workspaceId);
  assert.ok(workspace, `Create workspace "${workspaceId}" in Deszo before starting this external-authority probe.`);
  for (const marker of ['hold-ready.json', 'child-ready.json']) {
    const path = join(workspace.cwd, marker);
    if (existsSync(path)) unlinkSync(path);
  }
  writeFileSync(join(workspace.cwd, 'hold.mjs'), holdSource);
  const workflow = singleAgent({ id: `${workspaceId}-${randomUUID().slice(0, 6)}`, provider: 'codex', model: 'gpt-6-luna', context: 'new', timeoutSeconds: 300 });
  workflow.nodes.find(n => n.id === 'request').config.value = 'This is a disposable process-containment pilot. Execute exactly `node hold.mjs` in the current working directory, using your command tool, and wait for it to finish. Do not background it or edit any file. The prepared script starts a child process and records their PIDs. The test controller will deliberately interrupt the runtime. Do not perform other work. Return a short plain-text completion only if the command actually finishes.';
  const draft = await call(connection, 'PUT', `/api/v4/workflows/${workflow.workflowId}/draft`, { requestId: randomUUID(), workflow }, { 'If-None-Match': '*' });
  const validation = await call(connection, 'POST', `/api/v4/workflows/${workflow.workflowId}/draft/validate`, {}, { 'If-Match': draft.etag });
  assert.equal(validation.validation.valid, true, JSON.stringify(validation.validation.issues));
  const published = await call(connection, 'POST', `/api/v4/workflows/${workflow.workflowId}/publish`, { requestId: randomUUID() }, { 'If-Match': draft.etag });
  const created = await call(connection, 'POST', '/runs', { workflowId: workflow.workflowId, publishedVersionId: published.publishedVersionId,
    definitionDigest: published.definitionDigest, workflowSnapshotSha256: published.snapshotSha256, workspaceId, requestId: randomUUID() });
  assert.equal(created.outcome, 'created');
  const runId = created.run?.runId;
  assert.ok(runId, 'Owner-authorized Run admission returns the created Run directly.');
  console.log(JSON.stringify({ phase: 'live-cli-started', runId, workspaceId, model: 'gpt-6-luna' }));
  const proof = await wait('the real CLI to launch both prepared Node descendants', async () => {
    if (!existsSync(join(workspace.cwd, 'child-ready.json')) || !existsSync(join(workspace.cwd, 'hold-ready.json'))) return false;
    const parent = JSON.parse(readFileSync(join(workspace.cwd, 'hold-ready.json'), 'utf8'));
    const child = JSON.parse(readFileSync(join(workspace.cwd, 'child-ready.json'), 'utf8'));
    assert.equal(parent.childPid, child.pid);
    return { parent, child };
  }, 180);
  const attempt = readStore(db => db.prepare('SELECT * FROM attempts WHERE run_id=? AND node_instance_id=? ORDER BY ordinal DESC LIMIT 1').get(runId, 'agent'));
  assert.equal(attempt.state, 'running');
  const identities = await Promise.all([attempt.process_id, proof.parent.pid, proof.child.pid].map(processInfo));
  assert.ok(identities.every(Boolean), 'CLI and both descendants must be alive before the crash.');
  return { runId, workspaceId, proof, identities, cliAttemptId: attempt.id };
};

assert.ok(existsSync(exe), 'Install the isolated pilot package before running this probe.');
assert.ok(!existsSync(join(evidence, evidencePrefix + '-result.json')), 'Preserve the previous desktop result.');
mkdirSync(evidence, { recursive: true });
const startedAt = new Date().toISOString();
let app, connection, bridge;
const phases = [];
try {
  const previous = readConnection();
  app = await launch();
  connection = await waitConnection(previous);
  bridge = await openBridge({ script: connection.bridgeScript, args: ['--connection-file', connection.connectionFile, '--client-provider', 'other'], env: { ...process.env, DESZO_MANAGED_INVOCATION: '' } });
  assert.equal((await bridge.call('get_authoring_contract')).structuredContent.data.storeId, connection.storeId);
  assert.equal(connection.processContainment, 'tauri-job');
  const startup = { phase: 'installed-startup', app, runtime: await runtimeIdentity(app), port: connection.port, containment: connection.processContainment };
  phases.push(startup);
  writeFileSync(join(evidence, evidencePrefix + '-progress.json'), JSON.stringify({ startedAt, phases }, null, 2));
  console.log(JSON.stringify(startup));

  if (!startupOnly) {
  const runtimeCase = await beginHold(connection, 'pilot-desktop');
  const oldRuntime = await runtimeIdentity(app);
  const killedAt = Date.now();
  await stopOwned(oldRuntime);
  const replacement = await waitConnection(connection);
  const afterRuntimeReconnect = (await bridge.call('get_authoring_contract')).structuredContent;
  assert.equal(afterRuntimeReconnect.status, 'ok');
  assert.equal(afterRuntimeReconnect.data.storeId, connection.storeId);
  assert.equal(afterRuntimeReconnect.data.runtimeInstanceId, replacement.runtimeInstanceId);
  await wait('the old runtime and its CLI descendants to be gone', async () => !(await Promise.all([oldRuntime, ...runtimeCase.identities].map(sameProcess))).some(Boolean), 30);
  const recovered = await call(replacement, 'GET', '/runs/' + runtimeCase.runId);
  assert.equal(recovered.run.state, 'interrupted');
  const bindings = await call(replacement, 'GET', '/context-bindings?workspaceId=' + runtimeCase.workspaceId);
  assert.ok(bindings.bindings.some(binding => binding.state === 'needs_review'));
  const runtimeResult = { phase: 'runtime-crash', ...runtimeCase, oldRuntime, replacementRuntime: await runtimeIdentity(app), oldPort: connection.port, replacementPort: replacement.port, recoveredState: recovered.run.state, reconnectionMilliseconds: Date.now() - killedAt, childrenGone: true, bindingNeedsReview: true, reconnectTriggeredByFrontend: true, openBridgeReconnected: true };
  phases.push(runtimeResult);
  connection = replacement;
  writeFileSync(join(evidence, 'desktop-progress.json'), JSON.stringify({ startedAt, phases }, null, 2));
  console.log(JSON.stringify({ phase: runtimeResult.phase, runId: runtimeResult.runId, recoveredState: runtimeResult.recoveredState, reconnectionMilliseconds: runtimeResult.reconnectionMilliseconds, childrenGone: true }));

  const appCase = await beginHold(connection, 'pilot-desktop');
  const runtimeBeforeAppCrash = await runtimeIdentity(app);
  const appBeforeCrash = app;
  await stopOwned(app);
  app = null;
  await wait('the crashed app and all owned CLI descendants to be gone', async () => !(await Promise.all([appBeforeCrash, runtimeBeforeAppCrash, ...appCase.identities].map(sameProcess))).some(Boolean), 30);
  app = await launch();
  const restarted = await waitConnection(connection);
  const afterAppReconnect = (await bridge.call('get_authoring_contract')).structuredContent;
  assert.equal(afterAppReconnect.status, 'ok');
  assert.equal(afterAppReconnect.data.storeId, connection.storeId);
  assert.equal(afterAppReconnect.data.runtimeInstanceId, restarted.runtimeInstanceId);
  const afterAppRestart = await call(restarted, 'GET', '/runs/' + appCase.runId);
  assert.equal(afterAppRestart.run.state, 'interrupted');
  const appResult = { phase: 'app-crash', ...appCase, appBeforeCrash, runtimeBeforeAppCrash, restartedApp: app, restartedRuntime: await runtimeIdentity(app), childrenGone: true, recoveredState: afterAppRestart.run.state, openBridgeReconnected: true };
  phases.push(appResult);
  }
  const integrity = readStore(db => db.prepare('PRAGMA integrity_check').get().integrity_check);
  assert.equal(integrity, 'ok');
  const result = { passed: true, startedAt, finishedAt: new Date().toISOString(), exe, storage, productionAdapters: true, realCliInvocations: startupOnly ? 0 : 2, integrity, phases };
  writeFileSync(join(evidence, evidencePrefix + '-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ phase: 'completed', passed: true, integrity, realCliInvocations: result.realCliInvocations }));
} catch (error) {
  writeFileSync(join(evidence, evidencePrefix + '-error.json'), JSON.stringify({ startedAt, phases, message: error.message, stack: error.stack }, null, 2));
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  await bridge?.close();
  if (app && await sameProcess(app)) await stopOwned(app);
}
