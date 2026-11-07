import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Engine } from '../core/engine.mjs';
import { inspectManagedToolIsolation, prepareManagedToolIsolation } from '../core/managed-isolation.mjs';
import { startRunner } from '../runner.mjs';
import { managedInvocationDecision } from '../../mcp/managed-invocation.mjs';
import { fixtureAdapters, singleAgent, startTestRunner } from './helpers.mjs';
import { ownedDir } from './test-roots.mjs';

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
  const root = ownedDir(join(testsRoot, 'mcp-preflight-'));
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

test('Codex restricted config omission neutralizes only the exact verified user-config scope', async () => {
  const root = ownedDir(join(testsRoot, 'codex-restricted-config-'));
  const cwd = join(root, 'project');
  const bridgeScript = join(root, 'mcp', 'bridge.mjs');
  const projectConfig = join(cwd, '.codex', 'config.toml');
  const userConfig = join(root, 'user', 'config.toml');
  mkdirSync(join(cwd, '.codex'), { recursive: true });
  mkdirSync(join(root, 'mcp'), { recursive: true });
  mkdirSync(join(root, 'user'), { recursive: true });
  writeFileSync(bridgeScript, '');
  writeFileSync(userConfig, bridgeConfig(bridgeScript));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(root, 'user');
  try {
    const registry = { entries: [{ provider: 'codex', status: 'verified', testedVersion: 'codex-native-restricted', neutralizer: {
      id: 'codex-native-restricted-user-config-omission', kind: 'codex-restricted-config-omission', scopes: ['user'],
    } }] };
    const input = { provider: 'codex', cliVersion: 'codex-native-restricted', cwd, bridgeScript, registry,
      args: ['-C', cwd, '--ask-for-approval', 'never', 'exec', '--ignore-user-config', '--sandbox', 'workspace-write', '-'] };
    const isolated = await inspectManagedToolIsolation(input);
    assert.equal(isolated.neutralizerId, 'codex-native-restricted-user-config-omission');
    assert.deepEqual(isolated.bridgeEntries.map(item => item.scope), ['user']);
    await assert.rejects(inspectManagedToolIsolation({ ...input, cliVersion: 'codex-next-version' }), { code: 'managed_tool_isolation_unavailable' });
    await assert.rejects(inspectManagedToolIsolation({ ...input, args: ['-C', cwd, 'exec', '--sandbox', 'workspace-write', '-'] }), { code: 'managed_tool_isolation_unavailable' });
    writeFileSync(projectConfig, bridgeConfig(bridgeScript));
    await assert.rejects(inspectManagedToolIsolation(input), { code: 'managed_tool_isolation_unavailable' },
      'user-config omission must not be treated as project-config neutralization');
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
  }
});

test('Antigravity managed preflight scans the workspace project configuration and requires a verified neutralizer', async () => {
  const root = ownedDir(join(testsRoot, 'antigravity-preflight-'));
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
  const root = ownedDir(join(testsRoot, 'codex-explicit-marker-'));
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
  const root = ownedDir(join(testsRoot, 'antigravity-authoring-'));
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
  const root = ownedDir(join(testsRoot, 'mcp-foreign-bridge-'));
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
  const root = ownedDir(join(testsRoot, 'confirmation-fixture-'));
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

test('Draft revisions, validation, Publication idempotency, immutable versions, and exact Run binding', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const workflow = singleAgent({ id: 'workflow-revisions', context: null, model: 'fixture-slow-30' });
    workflow.view = { request: { x: 10, y: 20 } };
    const draftPath = `/api/v4/workflows/${workflow.workflowId}/draft`;
    const create = { requestId: randomUUID(), workflow };
    const first = await api.call('PUT', draftPath, create, { headers: { 'If-None-Match': '*' } });
    assert.equal(first.status, 200);
    assert.equal(first.body.revision, 1);
    assert.equal((await api.call('GET', draftPath)).body.definitionDigest, first.body.definitionDigest);
    const valid = await api.call('POST', `${draftPath}/validate`, {}, { headers: { 'If-Match': first.body.etag } });
    assert.equal(valid.body.validation.valid, true);
    const competing = structuredClone(workflow);
    competing.nodes[0].config.value = 'Concurrent stale writer.';
    const update = await api.call('PUT', draftPath, { requestId: randomUUID(), workflow: competing }, { headers: { 'If-Match': first.body.etag } });
    assert.equal(update.status, 200);
    assert.equal(update.body.revision, 2);
    const stale = await api.call('PUT', draftPath, { requestId: randomUUID(), workflow }, { headers: { 'If-Match': first.body.etag } });
    assert.equal(stale.status, 412);
    const createPublication = { requestId: randomUUID() };
    const published = await api.call('POST', `/api/v4/workflows/${workflow.workflowId}/publish`, createPublication, { headers: { 'If-Match': update.body.etag } });
    assert.equal(published.status, 201);
    assert.equal(published.body.version, 1);
    assert.deepEqual((await api.call('POST', `/api/v4/workflows/${workflow.workflowId}/publish`, createPublication, { headers: { 'If-Match': update.body.etag } })).body, published.body);
    const conflictingReceipt = await api.call('POST', `/api/v4/workflows/${workflow.workflowId}/publish`, createPublication, { headers: { 'If-Match': '"different-revision"' } });
    assert.equal(conflictingReceipt.status, 409);
    const versionOne = (await api.call('GET', `/api/v4/workflows/${workflow.workflowId}/versions/1`)).body;
    assert.deepEqual(versionOne.workflow.view, { request: { x: 10, y: 20 } });

    const runBody = { requestId: randomUUID(), workflowId: workflow.workflowId, workspaceId: 'main', workflowSnapshotSha256: published.body.snapshotSha256,
      publishedVersionId: published.body.publishedVersionId, definitionDigest: published.body.definitionDigest };
    const run = await api.call('POST', '/api/v2/runs', runBody);
    assert.equal(run.status, 202);
    assert.equal(run.body.run.publishedVersion.publishedVersionId, published.body.publishedVersionId);

    const viewOnly = structuredClone(competing);
    viewOnly.view.request.x = 99;
    const secondDraft = await api.call('PUT', draftPath, { requestId: randomUUID(), workflow: viewOnly }, { headers: { 'If-Match': update.body.etag } });
    assert.equal(secondDraft.status, 200);
    const secondValidation = await api.call('POST', `${draftPath}/validate`, {}, { headers: { 'If-Match': secondDraft.body.etag } });
    assert.equal(secondValidation.body.validation.valid, true);
    const second = await api.call('POST', `/api/v4/workflows/${workflow.workflowId}/publish`, { requestId: randomUUID() }, { headers: { 'If-Match': secondDraft.body.etag } });
    assert.equal(second.body.version, 2);
    assert.notEqual(second.body.definitionDigest, published.body.definitionDigest);
    assert.equal(second.body.executionHash, published.body.executionHash, 'layout-only changes preserve executionHash');
    assert.deepEqual((await api.call('GET', `/api/v4/workflows/${workflow.workflowId}/versions/1`)).body.workflow.view, { request: { x: 10, y: 20 } });
    const concurrentPublication = { requestId: randomUUID() };
    const concurrentResults = await Promise.all([
      api.call('POST', `/api/v4/workflows/${workflow.workflowId}/publish`, concurrentPublication, { headers: { 'If-Match': secondDraft.body.etag } }),
      api.call('POST', `/api/v4/workflows/${workflow.workflowId}/publish`, concurrentPublication, { headers: { 'If-Match': secondDraft.body.etag } }),
    ]);
    assert.equal(concurrentResults[0].status, 201);
    assert.equal(concurrentResults[1].status, 201);
    assert.deepEqual(concurrentResults[0].body, concurrentResults[1].body, 'concurrent identical Publish requests replay one committed result');
    assert.equal(concurrentResults[0].body.version, 3);
    assert.equal(api.runner.engine.store.get('SELECT COUNT(*) AS n FROM workflow_publications WHERE workflow_id = ?', workflow.workflowId).n, 3);
    const runRow = api.runner.engine.store.get('SELECT * FROM runs WHERE id = ?', run.body.run.runId);
    assert.equal(runRow.published_version_id, published.body.publishedVersionId, 'later Publication does not retarget an admitted Run');
    assert.equal(runRow.definition_digest, published.body.definitionDigest);
    const otherSnapshot = api.runner.engine.store.putJson({ workflow: 'not the Published snapshot' });
    assert.throws(() => api.runner.engine.store.run(`INSERT INTO runs(id,workflow_id,workspace_id,workflow_snapshot_artifact_id,settings_artifact_id,execution_hash,state,created_at,published_version_id,definition_digest)
      VALUES(?,?,?,?,?,?,'succeeded',?,?,?)`, randomUUID(), runRow.workflow_id, runRow.workspace_id, otherSnapshot.artifactId, runRow.settings_artifact_id,
    runRow.execution_hash, new Date().toISOString(), runRow.published_version_id, runRow.definition_digest), /workflow Run must bind an exact Published version and digest/,
    'the database refuses to insert a Run whose snapshot differs from its Published Version');
    assert.throws(() => api.runner.engine.store.run('UPDATE runs SET workflow_snapshot_artifact_id = ? WHERE id = ?', otherSnapshot.artifactId, runRow.id), /Run Published version binding is immutable/,
      'the database refuses to retarget the Run snapshot artifact');
    assert.throws(() => api.runner.engine.store.run('UPDATE runs SET workflow_id = ? WHERE id = ?', `${workflow.workflowId}-other`, runRow.id), /Run Published version binding is immutable/,
      'the database refuses to detach a Run from the workflow named by its Published Version');
    assert.throws(() => api.runner.engine.store.run('UPDATE workflow_publications SET runnable = 0 WHERE id = ?', published.body.publishedVersionId), /immutable/);
    assert.throws(() => api.runner.engine.store.run('DELETE FROM workflow_publications WHERE id = ?', published.body.publishedVersionId), /immutable/);

    const invalid = structuredClone(viewOnly);
    invalid.nodes.push(structuredClone(invalid.nodes[0]));
    const invalidDraft = await api.call('PUT', draftPath, { requestId: randomUUID(), workflow: invalid }, { headers: { 'If-Match': secondDraft.body.etag } });
    assert.equal(invalidDraft.status, 200, 'semantically invalid content remains editable as a Draft');
    const diagnostic = await api.call('POST', `${draftPath}/validate`, {}, { headers: { 'If-Match': invalidDraft.body.etag } });
    assert.equal(diagnostic.body.validation.valid, false);
    const publicationsBeforeRefusal = api.runner.engine.store.get('SELECT COUNT(*) AS n FROM workflow_publications WHERE workflow_id = ?', workflow.workflowId).n;
    const changesBeforeRefusal = api.runner.engine.store.get('SELECT COUNT(*) AS n FROM workflow_changes WHERE workflow_id = ?', workflow.workflowId).n;
    const refused = await api.call('POST', `/api/v4/workflows/${workflow.workflowId}/publish`, { requestId: randomUUID() }, { headers: { 'If-Match': invalidDraft.body.etag } });
    assert.equal(refused.status, 422);
    assert.equal(api.runner.engine.store.get('SELECT COUNT(*) AS n FROM workflow_publications WHERE workflow_id = ?', workflow.workflowId).n, publicationsBeforeRefusal);
    assert.equal(api.runner.engine.store.get('SELECT COUNT(*) AS n FROM workflow_changes WHERE workflow_id = ?', workflow.workflowId).n, changesBeforeRefusal,
      'a failed Publication leaves no partial change event');
    const cannotLaunch = await api.call('POST', '/api/v2/runs', { ...runBody, requestId: randomUUID(), publishedVersionId: randomUUID() });
    assert.equal(cannotLaunch.status, 404);
    assert.equal(cannotLaunch.body.code, 'published_version_not_found');
    assert.equal((await api.call('GET', `/api/v4/workflows/${workflow.workflowId}/versions`)).body.items.length, 3);
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

test('Owner Token Run admission is direct and idempotent regardless of the legacy confirmation setting', async () => {
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
    assert.equal(status.status, 404, 'Owner admission does not create a legacy external approval request');
    assert.deepEqual((await api.callExternal('POST', '/api/v2/runs', body)).body, first.body);
    await api.waitFor(first.body.run.runId);
  } finally { await api.close(); }
});

test('Owner Token directly starts Runs while the obsolete confirmation setting is enabled', async () => {
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
    const direct = await api.callExternal('POST', '/api/v2/runs', approvalBody);
    assert.equal(direct.body.outcome, 'created');
    assert.equal((await api.callExternal('GET', `/api/v2/run-requests/${approvalBody.requestId}`)).status, 404);
    await api.waitFor(direct.body.run.runId);

    const deniedWorkflow = singleAgent({ id: 'denial-flow', context: null });
    const deniedSaved = await api.save(deniedWorkflow);
    const denialBody = { workflowId: deniedWorkflow.workflowId, workflowSnapshotSha256: deniedSaved.snapshotSha256, workspaceId: 'main', requestId: randomUUID() };
    const second = await api.callExternal('POST', '/api/v2/runs', denialBody);
    assert.equal(second.body.outcome, 'created');
    assert.equal(api.runner.engine.store.get('SELECT COUNT(*) AS count FROM runs').count, 2);
    assert.equal((await api.callExternal('POST', `/api/v2/run-requests/${denialBody.requestId}/decision`, { requestId: randomUUID(), decision: 'deny' })).status, 410);
    await api.waitFor(second.body.run.runId);
  } finally { await api.close(); }
});

test('Owner Token reaches public management routes; internal Host routes remain separately classified', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const id = randomUUID();
    const current = api.runner.engine.currentSettings();
    const settings = await api.callExternal('PUT', '/api/v2/settings', { requestId: randomUUID(), expectedRevision: current.revision,
      settings: { ...current.settings, globalLimit: current.settings.globalLimit + 1 } });
    assert.equal(settings.status, 200);
    const requests = [
      ['PUT', '/api/v2/settings', {}], ['PUT', '/api/v2/workspaces/main', {}],
      ['PUT', '/api/v2/workflows/wf/cache-pins/cache', {}], ['DELETE', '/api/v2/workflows/wf/cache-pins/cache'],
      ['POST', `/api/v2/context-bindings/${id}/acknowledge`, {}], ['POST', `/api/v2/context-bindings/${id}/messages`, {}],
      ['POST', `/api/v2/runs/${id}/recovery`, {}], ['GET', '/api/v2/run-requests'],
      ['POST', `/api/v2/run-requests/${id}/decision`, {}],
    ];
    for (const [method, path, body] of requests) {
      const result = await api.callExternal(method, path, body);
      assert.ok(![401, 403].includes(result.status), `${method} ${path} was refused at the credential boundary: ${JSON.stringify(result.body)}`);
    }
  } finally { await api.close(); }
});

test('Owner Run admission does not create a pending request after restart with legacy confirmation enabled', async () => {
  const root = ownedDir(join(testsRoot, 'request-expiry-'));
  const first = await startTestRunner({ root });
  const requestId = randomUUID();
  try {
    await first.workspace();
    const settings = first.runner.engine.currentSettings();
    await first.call('PUT', '/api/v2/settings', { requestId: randomUUID(), expectedRevision: settings.revision,
      settings: { ...settings.settings, externalRunConfirmation: true } });
    const workflow = singleAgent({ id: 'expiry-flow', context: null });
    const saved = await first.save(workflow);
    const created = await first.callExternal('POST', '/api/v2/runs', { workflowId: workflow.workflowId, workflowSnapshotSha256: saved.snapshotSha256,
      workspaceId: 'main', requestId });
    assert.equal(created.body.outcome, 'created');
    await first.waitFor(created.body.run.runId);
  } finally { await first.close(); }

  const restarted = await startTestRunner({ root });
  try {
    const status = await restarted.callExternal('GET', `/api/v2/run-requests/${requestId}`);
    assert.equal(status.status, 404);
    assert.equal(restarted.runner.engine.store.get('SELECT COUNT(*) AS count FROM runs').count, 1);
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
      const saved = await api.call('PUT', `/api/v4/workflows/${candidate.workflowId}/draft`,
        { requestId: randomUUID(), workflow: candidate }, { headers: { 'If-None-Match': '*' } });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
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
