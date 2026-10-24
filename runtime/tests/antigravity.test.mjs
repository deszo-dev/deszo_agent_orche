import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { buildInvocation, createParser } from '../core/adapters.mjs';
import { compileOutputSchema } from '../core/schemas.mjs';
import { fixtureAdapters, singleAgent, startTestRunner } from './helpers.mjs';

const schema = {
  type: 'object', properties: {
    outcome: { type: 'string', enum: ['READY_FOR_REVIEW'] },
    issueSummary: { type: 'string' }, attemptedApproaches: { type: 'array', items: { type: 'string' } },
  }, required: ['outcome', 'issueSummary', 'attemptedApproaches'], additionalProperties: false,
};
const output = { format: 'json', schema };
const verdict = { outcome: 'READY_FOR_REVIEW', issueSummary: '', attemptedApproaches: [] };
const rejection = {
  event: 'step_update', step_update: {
    step_index: 2, step_type: 'tool', state: 'ERROR', tool_name: 'finish',
    tool_info: { error: { type: 'TOOL_ERROR', message: "invalid arguments:\n- at '/attemptedApproaches': got null, want array\n- at '/issueSummary': got null, want string" } },
  },
};

test('Antigravity gets a positive CLI deadline with time to exit before the process deadline', () => {
  for (const seconds of [1, 5, 60, 300, 3600]) for (const nativeSessionId of [null, 'existing-session']) {
    const invocation = buildInvocation({ provider: 'antigravity', cliPath: 'agy', model: 'gemini-3.8-flash-high', effort: 'high',
      prompt: 'A bounded task.', cwd: '.', nativeSessionId, output, nativeConfiguration: 'restricted', timeoutSeconds: seconds });
    const deadline = invocation.args[invocation.args.indexOf('--print-timeout') + 1];
    assert.match(deadline, /^\d+ms$/);
    const milliseconds = Number(deadline.slice(0, -2));
    assert.ok(milliseconds > 0 && milliseconds < seconds * 1000);
    assert.ok(seconds * 1000 - milliseconds <= 30_000, 'the cleanup reserve does not grow without bound');
    assert.equal(invocation.args[invocation.args.indexOf('--effort') + 1], 'high');
    assert.equal(invocation.args.includes('--conversation'), nativeSessionId !== null);
  }
});

test('a rejected finish is observable without being accepted or preventing a valid correction', () => {
  const parser = createParser('antigravity', { output });
  const normalized = parser.feed(rejection);
  assert.match(normalized.diagnostic, /finish step 2: invalid arguments/);
  assert.match(normalized.diagnostic, /got null, want array/);
  assert.equal(parser.state.error, null, 'a recoverable tool error is not a final provider error');
  assert.equal(parser.state.terminal, false);
  assert.equal(parser.state.finalText, null);
  parser.feed({ event: 'step_update', step_update: { step_type: 'tool', state: 'DONE', tool_name: 'finish', tool_info: { parameters: verdict } } });
  assert.equal(parser.state.terminal, false, 'a tool step alone is not a terminal CLI result');
  parser.feed({ event: 'result', result: { status: 'SUCCESS', response: JSON.stringify(verdict), structured_output: verdict } });
  assert.equal(parser.state.terminal, true);
  assert.equal(parser.state.error, null);
  assert.deepEqual(JSON.parse(parser.state.finalText), verdict);
  assert.deepEqual(compileOutputSchema(schema)(JSON.parse(parser.state.finalText)), []);
  assert.equal(parser.state.diagnostics.length, 1, 'the recovered error remains available as evidence');
});

test('Antigravity diagnostic retention is bounded and repeated events are not duplicated', () => {
  const parser = createParser('antigravity', { output });
  parser.feed(rejection);
  assert.equal(parser.feed(rejection).diagnostic, undefined);
  for (let index = 3; index < 30; index++) parser.feed({ ...rejection, step_update: { ...rejection.step_update, step_index: index } });
  assert.equal(parser.state.diagnostics.length, 8);
  assert.match(parser.state.diagnostics.at(-1), /step 29/);
  assert.equal(parser.state.error, null);
  assert.equal(parser.state.terminal, false);
});

const adapters = scenario => ({
  ...fixtureAdapters('unused'), createParser,
  buildInvocation: ({ prompt, cwd }) => ({ command: process.execPath,
    args: [resolve(import.meta.dirname, 'stream-fixture.mjs'), scenario], stdin: prompt, cwd, env: process.env }),
});

for (const scenario of ['timeout', 'recovered', 'invalid-result']) test(`Antigravity finish ${scenario} preserves the engine result boundary`, async () => {
  const api = await startTestRunner({ runner: { adapters: adapters(`antigravity-finish-${scenario}`) } });
  try {
    await api.workspace();
    const workflow = singleAgent({ id: `ag-finish-${scenario}`, provider: 'antigravity', context: null, timeoutSeconds: scenario === 'timeout' ? 5 : 10, output });
    const snapshot = await api.waitFor((await api.run(workflow)).body.run.runId);
    const events = api.runner.engine.store.readEvents(snapshot.run.runId, 0);
    const error = events.find(event => event.type === 'attempt.error');
    const agent = snapshot.instances.find(instance => instance.nodeId === 'agent');
    if (scenario === 'recovered') {
      assert.equal(snapshot.run.state, 'succeeded');
      assert.equal(error, undefined);
      const manifest = await api.artifactJson(agent.outputs.artifactId);
      assert.deepEqual(await api.artifactJson(manifest.values.json.artifact.artifactId), verdict);
    } else {
      assert.equal(snapshot.run.state, 'waiting_for_user');
      assert.equal(agent.outputs, null, 'partial or schema-invalid replies are never published');
      assert.equal(error.payload.code, scenario === 'timeout' ? 'timeout' : 'output_contract');
      if (scenario === 'timeout') {
        assert.match(error.payload.message, /Last provider diagnostic: Antigravity finish/);
        const evidence = await api.artifactJson(error.payload.evidence.artifactId);
        assert.match(evidence.providerDiagnostics[0], /got null, want array/);
      }
    }
    if (scenario !== 'invalid-result') {
      const chunks = events.filter(event => event.type === 'attempt.log_chunk' && event.payload.stream === 'normalized');
      const text = (await Promise.all(chunks.map(event => api.artifactText(event.payload.chunk.artifactId)))).join('');
      assert.match(text, /"diagnostic":"Antigravity finish/, 'tool failure survives normalization and durable capture');
    }
  } finally { await api.close(); }
});
