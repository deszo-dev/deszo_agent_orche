import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Engine } from '../core/engine.mjs';
import { inspectManagedToolIsolation, prepareManagedToolIsolation } from '../core/managed-isolation.mjs';
import { startRunner } from '../runner.mjs';
import { managedInvocationDecision } from '../../mcp/managed-invocation.mjs';
import { fixtureAdapters, singleAgent, startTestRunner } from './helpers.mjs';

const testsRoot = resolve(import.meta.dirname, '../../.deszo/tests');
mkdirSync(testsRoot, { recursive: true });
const bridgeConfig = (bridgeScript, provider = 'codex') => provider === 'codex'
  ? `[mcp_servers.deszo]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(bridgeScript)}, "--connection-file", "C:/fixture/connection.json"]\n`
  : JSON.stringify({ mcpServers: { deszo: { command: process.execPath, args: [bridgeScript, '--connection-file', 'C:/fixture/connection.json'] } } });

test('the bridge refuses same-runtime and foreign managed markers, and ignores an absent marker', () => {
  const same = managedInvocationDecision('runtime-a', 'runtime-a');
  assert.equal(same.code, 'managed_invocation_denied');
  assert.equal(same.matchesRuntime, true);
  const foreign = managedInvocationDecision('runtime-b', 'runtime-a');
  assert.equal(foreign.code, 'managed_invocation_denied');
  assert.equal(foreign.matchesRuntime, false);
  assert.match(foreign.details[0].message, /another or previous runtime/);
  assert.equal(managedInvocationDecision(undefined, 'runtime-a'), null);
  assert.equal(managedInvocationDecision('', 'runtime-a'), null);
});

test('managed-run isolation finds configured bridge entries and requires an exact verified neutralizer', async () => {
  const root = mkdtempSync(join(testsRoot, 'mcp-preflight-'));
  const cwd = join(root, 'project');
  const bridgeScript = join(root, 'mcp', 'bridge.mjs');
  const config = join(cwd, '.codex', 'config.toml');
  mkdirSync(join(cwd, '.codex'), { recursive: true });
  mkdirSync(join(root, 'mcp'), { recursive: true });
  writeFileSync(bridgeScript, '');
  const oldCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(root, 'user-config');
  try {
    const args = ['-C', cwd, 'exec', '--ignore-user-config'];
    const empty = await inspectManagedToolIsolation({ provider: 'codex', cliVersion: 'codex-test-1', cwd, args, bridgeScript });
    assert.deepEqual(empty.bridgeEntries, []);
    writeFileSync(config, `${bridgeConfig(bridgeScript)}enabled = false\n`);
    const disabled = await inspectManagedToolIsolation({ provider: 'codex', cliVersion: 'codex-test-1', cwd, args, bridgeScript });
    assert.deepEqual(disabled.bridgeEntries, [], 'a disabled Codex MCP server would not load');
    writeFileSync(config, bridgeConfig(bridgeScript));
    await assert.rejects(inspectManagedToolIsolation({ provider: 'codex', cliVersion: 'codex-test-1', cwd, args, bridgeScript }), {
      code: 'managed_tool_isolation_unavailable',
    });

    const registry = { entries: [{ provider: 'codex', status: 'verified', testedVersion: 'codex-test-1', neutralizer: {
      id: 'codex-project-config-disabled', kind: 'launch-arguments', requiredArgs: ['--ignore-user-config'], forbiddenArgs: ['--load-mcp-config'], scopes: ['project'],
    } }] };
    const isolated = await inspectManagedToolIsolation({ provider: 'codex', cliVersion: 'codex-test-1', cwd, args, bridgeScript, registry });
    assert.equal(isolated.mechanism, 'verified-neutralizer');
    assert.equal(isolated.neutralizerId, 'codex-project-config-disabled');
    assert.equal(isolated.bridgeEntries[0].name, 'deszo');
    await assert.rejects(inspectManagedToolIsolation({ provider: 'codex', cliVersion: 'codex-test-2', cwd, args, bridgeScript, registry }), {
      code: 'managed_tool_isolation_unavailable',
    });
  } finally {
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
  }
});

test('Antigravity managed preflight scans the workspace project configuration and requires a verified neutralizer', async () => {
  const root = mkdtempSync(join(testsRoot, 'antigravity-preflight-'));
  const cwd = join(root, 'project');
  const bridgeScript = join(root, 'mcp', 'bridge.mjs');
  const projectConfig = join(cwd, '.agents', 'mcp_config.json');
  mkdirSync(join(cwd, '.agents'), { recursive: true });
  mkdirSync(join(root, 'mcp'), { recursive: true });
  writeFileSync(bridgeScript, '');
  writeFileSync(projectConfig, bridgeConfig(bridgeScript, 'antigravity'));
  const previousUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = join(root, 'isolated-home');
  try {
    const input = { provider: 'antigravity', cliVersion: 'antigravity-test-1', cwd, args: [], bridgeScript };
    await assert.rejects(inspectManagedToolIsolation(input), { code: 'managed_tool_isolation_unavailable' });
    const registry = { entries: [{ provider: 'antigravity', status: 'verified', testedVersion: 'antigravity-test-1', neutralizer: { id: 'antigravity-marker-propagation', kind: 'marker-propagation', scopes: ['project'] } }] };
    const result = await inspectManagedToolIsolation({ ...input, registry });
    assert.equal(result.mechanism, 'verified-neutralizer');
    assert.deepEqual(result.bridgeEntries.map(item => item.scope), ['Antigravity project']);
    await assert.rejects(inspectManagedToolIsolation({ ...input, cliVersion: 'antigravity-test-2', registry }), { code: 'managed_tool_isolation_unavailable' });
  } finally {
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  }
});

test('verified Codex preparation injects exact MCP child markers after exec and rejects unproved versions or scopes', async () => {
  const root = mkdtempSync(join(testsRoot, 'codex-explicit-marker-'));
  const cwd = join(root, 'project');
  const bridgeScript = join(root, 'mcp', 'bridge.mjs');
  mkdirSync(join(cwd, '.codex'), { recursive: true });
  mkdirSync(join(root, 'user'), { recursive: true });
  writeFileSync(join(cwd, '.codex', 'config.toml'), bridgeConfig(bridgeScript).replace('mcp_servers.deszo', 'mcp_servers.project_deszo'));
  writeFileSync(join(root, 'user', 'config.toml'), bridgeConfig(bridgeScript));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(root, 'user');
  try {
    const registry = { entries: [{ provider: 'codex', status: 'verified', testedVersion: 'codex-native-tested',
      neutralizer: { id: 'explicit-child-marker', kind: 'codex-explicit-mcp-marker', scopes: ['user', 'project'] } }] };
    const runtimeInstanceId = randomUUID();
    const input = { provider: 'codex', cliVersion: 'codex-native-tested', cwd, bridgeScript, runtimeInstanceId, registry,
      args: ['-C', cwd, 'exec', '--json', '-'] };
    await assert.rejects(inspectManagedToolIsolation(input), { code: 'managed_tool_isolation_unavailable' });
    const result = await prepareManagedToolIsolation(input);
    assert.equal(result.neutralizerId, 'explicit-child-marker');
    for (const name of ['deszo', 'project_deszo']) {
      const index = input.args.indexOf(`mcp_servers.${name}.env.DESZO_MANAGED_INVOCATION=${JSON.stringify(runtimeInstanceId)}`);
      assert.ok(index > input.args.indexOf('exec'));
      assert.equal(input.args[index - 1], '-c');
    }
    assert.equal(input.args.at(-1), '-');
    assert.equal((await inspectManagedToolIsolation(input)).mechanism, 'verified-neutralizer');
    await assert.rejects(inspectManagedToolIsolation({ ...input, runtimeInstanceId: randomUUID() }), { code: 'managed_tool_isolation_unavailable' });
    await assert.rejects(prepareManagedToolIsolation({ ...input, cliVersion: 'another-version' }), { code: 'managed_tool_isolation_unavailable' });
    const uncovered = structuredClone(registry); uncovered.entries[0].neutralizer.scopes = ['project'];
    await assert.rejects(prepareManagedToolIsolation({ ...input, registry: uncovered }), { code: 'managed_tool_isolation_unavailable' });
    const restricted = { ...input, args: ['-C', cwd, 'exec', '--ignore-user-config', '-'] };
    await prepareManagedToolIsolation(restricted);
    assert.deepEqual(restricted.args, ['-C', cwd, 'exec', '--ignore-user-config', '-'], 'Do not invent env-only transports excluded by Restricted.');
    writeFileSync(join(cwd, '.codex', 'config.toml'), '# No project MCP servers\n');
    const userOnly = { ...input, args: ['-C', cwd, 'exec', '--ignore-user-config', '-'] };
    assert.equal((await prepareManagedToolIsolation(userOnly)).mechanism, 'verified-neutralizer');
    assert.deepEqual(userOnly.args, ['-C', cwd, 'exec', '--ignore-user-config', '-']);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
  }
});

test('Antigravity managed preflight ignores a registered authoring configuration outside the working directory', async () => {
  const root = mkdtempSync(join(testsRoot, 'antigravity-authoring-'));
  const cwd = join(root, 'project');
  const bridgeScript = join(root, 'mcp', 'bridge.mjs');
  const registeredConfig = join(root, 'authoring', 'mcp_config.json');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(root, 'mcp'), { recursive: true });
  mkdirSync(join(root, 'authoring'), { recursive: true });
  writeFileSync(bridgeScript, '');
  writeFileSync(registeredConfig, bridgeConfig(bridgeScript, 'antigravity'));
  const previousUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = join(root, 'isolated-home');
  try {
    const result = await inspectManagedToolIsolation({ provider: 'antigravity', cliVersion: 'antigravity-test-1', cwd, args: [], bridgeScript });
    assert.equal(result.mechanism, 'bridge-marker-refusal');
    assert.deepEqual(result.bridgeEntries, []);
  } finally {
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  }
});

test('managed-run isolation detects a Deszo bridge from any install location, not only this runtime', async () => {
  const root = mkdtempSync(join(testsRoot, 'mcp-foreign-bridge-'));
  const cwd = join(root, 'project');
  const bridgeScript = join(root, 'mcp', 'bridge.mjs');
  mkdirSync(join(cwd, '.codex'), { recursive: true });
  mkdirSync(join(root, 'mcp'), { recursive: true });
  writeFileSync(bridgeScript, '');
  writeFileSync(join(cwd, '.codex', 'config.toml'), [
    '[mcp_servers.installed]',
    'command = "node"',
    'args = ["C:/Program Files/Deszo/runtime/bridge.mjs", "--connection-file", "C:/fixture/connection.json"]',
    '',
    '[mcp_servers.other-tool]',
    'command = "node"',
    'args = ["C:/tools/other.mjs", "--connection-file", "C:/fixture/connection.json"]',
    '',
    '[mcp_servers.plain-bridge]',
    'command = "node"',
    'args = ["C:/tools/bridge.mjs", "--port", "9000"]',
    '',
  ].join('\n'));
  const oldCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(root, 'user-config');
  try {
    const registry = { entries: [{ provider: 'codex', status: 'verified', testedVersion: 'codex-test-1', neutralizer: { id: 'codex-marker-propagation', kind: 'marker-propagation', scopes: ['project'] } }] };
    const result = await inspectManagedToolIsolation({ provider: 'codex', cliVersion: 'codex-test-1', cwd, args: ['-C', cwd, 'exec'], bridgeScript, registry });
    assert.deepEqual(result.bridgeEntries.map(item => item.name), ['installed']);
  } finally {
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
  }
});

test('the dev confirmation override is process-only and uses a separate fixture root', async () => {
  const root = mkdtempSync(join(testsRoot, 'confirmation-fixture-'));
  const seed = new Engine({ root, adapters: fixtureAdapters(join(root, 'fixture-state')) });
  await seed.initialize();
  const initial = seed.currentSettings();
  seed.updateSettings({ requestId: randomUUID(), expectedRevision: initial.revision,
    settings: { ...initial.settings, externalRunConfirmation: true } });
  await seed.shutdown();

  const adapters = fixtureAdapters(join(root, 'fixture-state'));
  const fixture = await startRunner({ root, adapters, devTestConfirmationOff: true });
  try {
    const row = fixture.engine.store.get('SELECT * FROM application_settings WHERE singleton = 1');
    const saved = fixture.engine.store.readJson(row.settings_artifact_id);
    assert.equal(fixture.engine.currentSettings().settings.externalRunConfirmation, false);
    assert.equal(saved.externalRunConfirmation, true, 'the fixture policy does not rewrite saved settings');
    assert.equal(row.revision, 2, 'the fixture policy does not create a saved settings revision');
    assert.ok(fixture.engine.store.get("SELECT id FROM workspaces WHERE id = 'main'"), 'the owned fixture store has its own workspace');
    assert.notEqual(resolve(fixture.engine.root), resolve(import.meta.dirname, '../../.deszo'));
  } finally { await fixture.close(); }

  const reopened = await startRunner({ root, adapters: fixtureAdapters(join(root, 'fixture-state')) });
  try {
    assert.equal(reopened.engine.currentSettings().settings.externalRunConfirmation, true, 'the saved user setting survives unchanged');
    assert.equal(reopened.engine.currentSettings().revision, 2);
  } finally { await reopened.close(); }
});

test('workflow revisions enforce create/update ETags and replay saved receipts', async () => {
  const api = await startTestRunner();
  try {
    const workflow = singleAgent({ id: 'workflow-revisions', context: null });
    const create = { requestId: randomUUID(), expectedEtag: null, workflow };
    const first = await api.call('PUT', `/api/v3/workflows/${workflow.workflowId}`, create, { headers: { 'If-None-Match': '*' } });
    assert.equal(first.status, 200);
    assert.equal(first.body.revision, 1);
    assert.deepEqual((await api.call('PUT', `/api/v3/workflows/${workflow.workflowId}`, create)).body, first.body);
    assert.equal((await api.call('PUT', `/api/v3/workflows/${workflow.workflowId}`, { ...create, requestId: randomUUID() })).status, 412);

    const updatedWorkflow = structuredClone(workflow);
    updatedWorkflow.nodes.find(node => node.id === 'request').config.value = 'Updated request.';
    const update = await api.call('PUT', `/api/v3/workflows/${workflow.workflowId}`, {
      requestId: randomUUID(), expectedEtag: first.body.etag, workflow: updatedWorkflow,
    }, { headers: { 'If-Match': first.body.etag } });
    assert.equal(update.status, 200);
    assert.equal(update.body.revision, 2);
    assert.notEqual(update.body.etag, first.body.etag);
    assert.equal((await api.call('PUT', `/api/v3/workflows/${workflow.workflowId}`, {
      requestId: randomUUID(), expectedEtag: first.body.etag, workflow,
    }, { headers: { 'If-Match': first.body.etag } })).status, 412);
    assert.deepEqual(api.runner.engine.workflowChanges({ after: 0 }).items.map(item => item.revision), [1, 2]);
  } finally { await api.close(); }
});

test('removing and re-adding a Cache node retires its pin incarnation', async () => {
  const api = await startTestRunner();
  const workflow = includeCache => ({
    schemaVersion: 1, workflowId: 'cache-incarnations', capabilities: ['core-v1', 'cache-v1'],
    settings: { nativeConfiguration: 'restricted' },
    nodes: [
      { id: 'input', type: 'text', config: { value: 'Cache identity fixture.' } },
      ...(includeCache ? [{ id: 'checkpoint', type: 'cache', config: { valueType: 'Text', mode: 'live' } }] : []),
      { id: 'answer', type: 'result-viewer', config: {} },
    ],
    edges: includeCache ? [
      { id: 'input-cache', source: { nodeId: 'input', port: 'text' }, target: { nodeId: 'checkpoint', port: 'value' } },
      { id: 'cache-answer', source: { nodeId: 'checkpoint', port: 'value' }, target: { nodeId: 'answer', port: 'value' } },
    ] : [{ id: 'input-answer', source: { nodeId: 'input', port: 'text' }, target: { nodeId: 'answer', port: 'value' } }],
    after: [],
  });
  try {
    await api.workspace();
    const firstRun = await api.run(workflow(true));
    await api.waitFor(firstRun.body.run.runId);
    const pinned = await api.call('PUT', '/api/v2/workflows/cache-incarnations/cache-pins/checkpoint', {
      runId: firstRun.body.run.runId, nodeInstanceId: 'checkpoint',
    });
    assert.equal(pinned.status, 200);
    const original = api.runner.engine.store.get("SELECT incarnation_id FROM cache_node_incarnations WHERE workflow_id = 'cache-incarnations' AND node_id = 'checkpoint' AND active = 1").incarnation_id;
    await api.save(workflow(false));
    assert.equal(api.runner.engine.store.get("SELECT active FROM cache_node_incarnations WHERE workflow_id = 'cache-incarnations' AND node_id = 'checkpoint' AND incarnation_id = ?", original).active, 0);
    assert.equal((await api.call('GET', '/api/v2/workflows/cache-incarnations/cache-pins')).body.pins[0].orphaned, true);
    await api.save(workflow(true));
    const current = api.runner.engine.store.get("SELECT incarnation_id FROM cache_node_incarnations WHERE workflow_id = 'cache-incarnations' AND node_id = 'checkpoint' AND active = 1").incarnation_id;
    assert.notEqual(current, original);
    assert.equal((await api.call('GET', '/api/v2/workflows/cache-incarnations/cache-pins')).body.pins[0].orphaned, true, 'a re-added node does not adopt the retired pin');
  } finally { await api.close(); }
});

test('external confirmation-off requests have an approved status record and replay their created outcome', async () => {
  const api = await startTestRunner();
  try {
    const current = api.runner.engine.currentSettings();
    await api.call('PUT', '/api/v2/settings', { requestId: randomUUID(), expectedRevision: current.revision,
      settings: { ...current.settings, externalRunConfirmation: false } });
    await api.workspace();
    const workflow = singleAgent({ id: 'external-off', context: null });
    const saved = await api.save(workflow);
    const body = { workflowId: workflow.workflowId, workflowSnapshotSha256: saved.snapshotSha256, workspaceId: 'main', requestId: randomUUID() };
    const first = await api.callExternal('POST', '/api/v2/runs', body);
    assert.equal(first.status, 202);
    assert.equal(first.body.outcome, 'created');
    const status = await api.callExternal('GET', `/api/v2/run-requests/${body.requestId}`);
    assert.equal(status.body.state, 'approved');
    assert.equal(status.body.runId, first.body.run.runId);
    assert.deepEqual((await api.callExternal('POST', '/api/v2/runs', body)).body, first.body);
    await api.waitFor(first.body.run.runId);
  } finally { await api.close(); }
});

test('external run requests wait for approval and support first-party approval and denial', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const current = api.runner.engine.currentSettings();
    const settings = { ...current.settings, externalRunConfirmation: true };
    const changed = await api.call('PUT', '/api/v2/settings', { requestId: randomUUID(), expectedRevision: current.revision, settings });
    assert.equal(changed.status, 200);

    const approvedWorkflow = singleAgent({ id: 'approval-flow', context: null });
    const approvedSaved = await api.save(approvedWorkflow);
    const approvalBody = { workflowId: approvedWorkflow.workflowId, workflowSnapshotSha256: approvedSaved.snapshotSha256, workspaceId: 'main', requestId: randomUUID() };
    const pending = await api.callExternal('POST', '/api/v2/runs', approvalBody);
    assert.equal(pending.body.outcome, 'confirmation_pending');
    assert.equal(api.runner.engine.store.get('SELECT COUNT(*) AS count FROM runs').count, 0, 'pending does not create a run');
    assert.equal((await api.callExternal('GET', `/api/v2/run-requests/${approvalBody.requestId}`)).body.state, 'pending');
    const approval = await api.call('POST', `/api/v2/run-requests/${approvalBody.requestId}/decision`, { requestId: randomUUID(), decision: 'approve' });
    assert.equal(approval.status, 202);
    assert.equal(approval.body.request.state, 'approved');
    await api.waitFor(approval.body.run.runId);

    const deniedWorkflow = singleAgent({ id: 'denial-flow', context: null });
    const deniedSaved = await api.save(deniedWorkflow);
    const denialBody = { workflowId: deniedWorkflow.workflowId, workflowSnapshotSha256: deniedSaved.snapshotSha256, workspaceId: 'main', requestId: randomUUID() };
    const deniedPending = await api.callExternal('POST', '/api/v2/runs', denialBody);
    const denial = await api.call('POST', `/api/v2/run-requests/${denialBody.requestId}/decision`, { requestId: randomUUID(), decision: 'deny' });
    assert.equal(deniedPending.body.outcome, 'confirmation_pending');
    assert.equal(denial.body.state, 'denied');
    assert.equal(api.runner.engine.store.get('SELECT COUNT(*) AS count FROM runs').count, 1, 'denial creates no second run');
  } finally { await api.close(); }
});

test('external credentials cannot change settings, workspaces, Cache pins, Context, recovery or the approval queue', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const id = randomUUID();
    const requests = [
      ['PUT', '/api/v2/settings', {}], ['PUT', '/api/v2/workspaces/main', {}],
      ['PUT', '/api/v2/workflows/wf/cache-pins/cache', {}], ['DELETE', '/api/v2/workflows/wf/cache-pins/cache'],
      ['POST', `/api/v2/context-bindings/${id}/acknowledge`, {}], ['POST', `/api/v2/context-bindings/${id}/messages`, {}],
      ['POST', `/api/v2/runs/${id}/recovery`, {}], ['GET', '/api/v2/run-requests'],
      ['POST', `/api/v2/run-requests/${id}/decision`, {}],
    ];
    for (const [method, path, body] of requests) assert.equal((await api.callExternal(method, path, body)).status, 403, `${method} ${path}`);
  } finally { await api.close(); }
});

test('expired external requests remain expired across a runtime restart', async () => {
  const root = mkdtempSync(join(testsRoot, 'request-expiry-'));
  const first = await startTestRunner({ root });
  const requestId = randomUUID();
  try {
    await first.workspace();
    const settings = first.runner.engine.currentSettings();
    await first.call('PUT', '/api/v2/settings', { requestId: randomUUID(), expectedRevision: settings.revision,
      settings: { ...settings.settings, externalRunConfirmation: true } });
    const workflow = singleAgent({ id: 'expiry-flow', context: null });
    const saved = await first.save(workflow);
    const pending = await first.callExternal('POST', '/api/v2/runs', { workflowId: workflow.workflowId, workflowSnapshotSha256: saved.snapshotSha256,
      workspaceId: 'main', requestId });
    assert.equal(pending.body.outcome, 'confirmation_pending');
    first.runner.engine.store.run('UPDATE external_run_requests SET expires_at = ? WHERE request_id = ?', new Date(Date.now() - 60_000).toISOString(), requestId);
  } finally { await first.close(); }

  const restarted = await startTestRunner({ root });
  try {
    const status = await restarted.callExternal('GET', `/api/v2/run-requests/${requestId}`);
    assert.equal(status.body.state, 'expired');
    assert.equal(restarted.runner.engine.store.get('SELECT COUNT(*) AS count FROM runs').count, 0);
  } finally { await restarted.close(); }
});

test('a Deszo bridge in project config blocks dispatch before the fixture CLI starts', async () => {
  const api = await startTestRunner({ managedMcpPreflight: true });
  try {
    const workspace = await api.workspace();
    const config = join(workspace.cwd, '.codex', 'config.toml');
    mkdirSync(join(workspace.cwd, '.codex'), { recursive: true });
    writeFileSync(config, bridgeConfig(api.runner.engine.bridgeScript));
    const workflow = singleAgent({ id: 'blocked-bridge', context: null });
    const created = await api.run(workflow);
    const done = await api.waitFor(created.body.run.runId);
    assert.equal(done.run.state, 'waiting_for_user');
    const events = await api.call('GET', `/api/v2/runs/${created.body.run.runId}/events/page?afterSequence=0`);
    const failure = events.body.items.find(event => event.type === 'attempt.error');
    assert.equal(failure.payload.code, 'managed_tool_isolation_unavailable');
    assert.match(failure.payload.message, /no verified neutralizer/);
    assert.equal(existsSync(api.stateDir), false, 'the fixture provider process never started');
  } finally { await api.close(); }
});

test('Antigravity workspace and MCP config paths are checked on handshake and workspace movement', async () => {
  const api = await startTestRunner();
  try {
    const workspacePath = join(api.root, 'authoring-safety-workspace');
    mkdirSync(workspacePath, { recursive: true });
    api.runner.engine.putWorkspace('main', { cwd: workspacePath });
    const nestedAuthoring = join(workspacePath, 'authoring');
    mkdirSync(nestedAuthoring, { recursive: true });
    const nestedConfig = join(nestedAuthoring, 'mcp_config.json');
    writeFileSync(nestedConfig, '{}');
    assert.throws(() => api.runner.engine.registerBridge({ bridgeId: randomUUID(), clientProvider: 'antigravity',
      workingDirectory: nestedAuthoring, mcpConfigPath: nestedConfig }), { code: 'authoring_directory_conflict' });

    const authoring = join(api.root, 'dedicated-authoring');
    mkdirSync(authoring, { recursive: true });
    const mcpConfigPath = join(authoring, 'mcp_config.json');
    writeFileSync(mcpConfigPath, '{}');
    api.runner.engine.registerBridge({ bridgeId: randomUUID(), clientProvider: 'antigravity', workingDirectory: authoring, mcpConfigPath });
    const movedInside = join(authoring, 'workspace');
    mkdirSync(movedInside, { recursive: true });
    assert.throws(() => api.runner.engine.putWorkspace('main', { cwd: movedInside }), { code: 'authoring_directory_conflict' });
  } finally { await api.close(); }
});

test('workflow stream reconnect catches up every page beyond the 200-event limit', async () => {
  const api = await startTestRunner();
  const controller = new AbortController();
  try {
    const workflow = id => singleAgent({ id, context: null });
    for (let index = 1; index <= 205; index += 1) {
      const candidate = workflow(`stream-${String(index).padStart(3, '0')}`);
      api.runner.engine.saveWorkflowV3(candidate.workflowId, { requestId: randomUUID(), expectedEtag: null, workflow: candidate });
    }
    const response = await fetch(`http://127.0.0.1:${api.runner.connection.port}/api/v3/authoring/events/stream?after=0`, {
      headers: { Authorization: `Bearer ${api.runner.connection.firstPartyToken}` }, signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const events = [];
    while (events.length < 205) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (!frame.startsWith('event: workflow-change\n')) continue;
        events.push(JSON.parse(frame.split('\n').find(line => line.startsWith('data: ')).slice(6)));
      }
    }
    assert.equal(events.length, 205);
    assert.deepEqual(events.map(item => item.sequence), Array.from({ length: 205 }, (_, index) => index + 1));
  } finally {
    controller.abort();
    await api.close();
  }
});

test('artifact provenance uses the reverse reference index for attempt envelopes', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const workflow = singleAgent({ id: 'provenance-index', context: null });
    const created = await api.run(workflow);
    const done = await api.waitFor(created.body.run.runId);
    const attempt = api.runner.engine.store.get('SELECT invocation_artifact_id FROM attempts WHERE run_id = ? AND invocation_artifact_id IS NOT NULL LIMIT 1', created.body.run.runId);
    const invocation = api.runner.engine.store.readJson(attempt.invocation_artifact_id);
    const artifactId = invocation.stdin.artifactId;
    const provenance = api.runner.engine.artifactProvenance(artifactId);
    assert.ok(provenance.sources.some(source => source.runId === created.body.run.runId && source.sourceKind === 'invocation' && source.path.join('.') === 'stdin'));
    assert.ok(api.runner.engine.store.get('SELECT 1 AS indexed FROM artifact_references WHERE referenced_artifact_id = ? LIMIT 1', artifactId));
  } finally { await api.close(); }
});
