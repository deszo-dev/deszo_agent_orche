import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildInvocation, subscriptionEnvironment } from '../core/adapters.mjs';
import { check } from '../core/schemas.mjs';
import { DEFAULT_EFFORT, EFFORT_LEVELS } from '../../shared/effort.mjs';
import { contextChain, singleAgent, startTestRunner } from './helpers.mjs';

const invocation = overrides => buildInvocation({ provider: 'codex', cliPath: 'cli', model: 'explicit-model', prompt: 'Test.', cwd: '.',
  nativeSessionId: null, output: { format: 'text' }, nativeConfiguration: 'restricted', timeoutSeconds: 60, ...overrides });

test('every CLI receives the exact effort on fresh and resumed sessions in either configuration profile', () => {
  for (const provider of ['codex', 'claude', 'antigravity']) for (const effort of EFFORT_LEVELS)
    for (const nativeSessionId of [null, 'session-1']) for (const nativeConfiguration of ['restricted', 'inherit']) {
      const { args } = invocation({ provider, effort, nativeSessionId, nativeConfiguration });
      if (provider === 'codex') {
        const settings = args.flatMap((arg, i) => arg === '-c' ? [args[i + 1]] : []);
        assert.deepEqual(settings.filter(item => item.startsWith('model_reasoning_effort=')), [`model_reasoning_effort="${effort}"`]);
      } else {
        assert.equal(args.filter(arg => arg === '--effort').length, 1);
        assert.equal(args[args.indexOf('--effort') + 1], effort);
      }
    }
});

test('legacy workflows still pass medium explicitly; invalid efforts are rejected before CLI construction', () => {
  for (const provider of ['codex', 'claude', 'antigravity']) {
    const { args } = invocation({ provider });
    assert.ok(args.includes(provider === 'codex' ? `model_reasoning_effort="${DEFAULT_EFFORT}"` : DEFAULT_EFFORT));
    for (const effort of ['extra', 'auto', '', null, 'max" --model other']) assert.throws(() => invocation({ provider, effort }), /Unsupported reasoning effort/);
  }
  const env = subscriptionEnvironment({ PATH: 'test', CLAUDE_CODE_EFFORT_LEVEL: 'low', claude_code_effort_level: 'max' });
  assert.deepEqual(env, { PATH: 'test' }, 'an inherited effort environment variable must not override the requested CLI flag');
});

test('workflow schemas accept effort for ordinary Agents and Map roles and reject unknown levels', () => {
  const workflow = singleAgent({ context: null });
  const agent = workflow.nodes.find(node => node.type === 'agent');
  const map = { id: 'tasks', type: 'map', config: { approvalPolicy: { slots: [{ id: 'quality', role: 'reviewer', view: 'full' }] }, optionalInputs: [],
    limits: { maxFailedVerificationCycles: 3, maxTaskAttempts: 3 }, roles: [{ id: 'writer', kind: 'agent', provider: 'claude', model: 'explicit-model', instructions: 'Write.', timeoutSeconds: 60, context: 'task' }] } };
  for (const effort of EFFORT_LEVELS) {
    agent.config.effort = effort;
    map.config.roles[0].effort = effort;
    assert.deepEqual(check('workflow.schema.json', 'agentNode', agent), []);
    assert.deepEqual(check('workflow.schema.json', 'mapNode', map), []);
  }
  agent.config.effort = 'extra';
  map.config.roles[0].effort = 'extra';
  assert.ok(check('workflow.schema.json', 'agentNode', agent).length);
  assert.ok(check('workflow.schema.json', 'mapNode', map).length);
});

test('the engine forwards each effort and journals it for fresh and resumed Agents', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const workflow = await contextChain();
    const agents = workflow.nodes.filter(node => node.type === 'agent');
    agents.forEach((node, i) => { node.config.effort = ['max', 'medium', 'xhigh'][i]; });
    const received = [];
    const build = api.runner.engine.adapters.buildInvocation;
    api.runner.engine.adapters.buildInvocation = config => { received.push(config.effort); return build(config); };
    const snapshot = await api.waitFor((await api.run(workflow)).body.run.runId);
    assert.equal(snapshot.run.state, 'succeeded');
    assert.deepEqual(received, agents.map(node => node.config.effort));
    const events = await api.events(snapshot.run.runId);
    for (const node of agents) {
      const event = events.find(item => item.type === 'attempt.invocation_committed' && item.nodeInstanceId === node.id);
      const manifest = await api.artifactJson(event.payload.manifest.artifactId);
      assert.equal(manifest.requestedEffort, node.config.effort);
      assert.deepEqual(check('attempt-record.schema.json', 'invocation', manifest), []);
      const outputs = await api.artifactJson(snapshot.instances.find(item => item.nodeId === node.id).outputs.artifactId);
      assert.equal(outputs.providerResult.requestedEffort, node.config.effort);
    }
    assert.ok(events.filter(item => item.type === 'attempt.invocation_committed').length >= 3);
  } finally { await api.close(); }
});

test('Run Node rejects inputs from another effort or from a pre-effort run', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const workflow = singleAgent({ context: null });
    const agent = workflow.nodes.find(node => node.type === 'agent');
    agent.config.effort = 'high';
    const snapshot = await api.waitFor((await api.run(workflow)).body.run.runId);
    const requestNode = async saved => api.call('POST', '/api/v2/runs', { workflowId: workflow.workflowId, workflowSnapshotSha256: saved.snapshotSha256,
      workspaceId: 'main', requestId: randomUUID(), mode: 'node', targets: ['answer'] });
    agent.config.effort = 'max';
    assert.equal((await requestNode(await api.save(workflow))).status, 422, 'a changed effort makes the Agent result stale');
    agent.config.effort = 'high';
    const saved = await api.save(workflow);
    const store = api.runner.engine.store;
    const row = store.get('SELECT plan_artifact_id FROM runs WHERE id = ?', snapshot.run.runId);
    const plan = store.readJson(row.plan_artifact_id);
    delete plan.effortPolicyVersion;
    store.run('UPDATE runs SET plan_artifact_id = ? WHERE id = ?', store.putJson(plan).artifactId, snapshot.run.runId);
    assert.equal((await requestNode(saved)).status, 422, 'historical implicit effort is not evidence of the new explicit setting');
  } finally { await api.close(); }
});
