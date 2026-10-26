import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInvocation, classifyFailure, codexCustodySupport, codexWindowsSandboxMode, codexWindowsSandboxModeForRun, createParser, subscriptionEnvironment } from '../core/adapters.mjs';
import { singleAgent, startTestRunner } from './helpers.mjs';

const invocation = overrides => buildInvocation({ provider: 'codex', cliPath: 'codex.exe', model: 'gpt-6-luna', effort: 'medium',
  prompt: 'Make the requested change.', cwd: 'C:/isolated/project', nativeSessionId: null, output: { format: 'text' },
  nativeConfiguration: 'restricted', timeoutSeconds: 120, ...overrides });

test('Custody Codex execution uses only verified non-interactive workspace-write flags', () => {
  const { args, stdin, cwd, command } = invocation({ processCustody: true, windowsSandboxMode: 'elevated' });
  assert.equal(command, 'codex.exe');
  assert.equal(cwd, 'C:/isolated/project');
  assert.equal(stdin, 'Make the requested change.');
  assert.deepEqual(args.slice(0, 5), ['-C', cwd, '--ask-for-approval', 'never', 'exec']);
  assert.equal(args[args.indexOf('--model') + 1], 'gpt-6-luna');
  assert.deepEqual(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2), ['--sandbox', 'workspace-write']);
  assert.ok(args.includes('windows.sandbox="elevated"'), 'the configured Windows sandbox backend is reapplied explicitly');
  assert.ok(args.includes('--ephemeral'));
  assert.equal(args.at(-1), '-');
  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('non-Custody Codex retains its existing invocation behavior', () => {
  const { args } = invocation();
  assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(!args.includes('--ask-for-approval'));
  assert.ok(!args.includes('--ephemeral'));
});

test('Custody support is accepted only when the installed help advertises every required option', () => {
  const rootHelp = 'Options: --ask-for-approval <APPROVAL_POLICY>';
  const execHelp = 'Options: --json --sandbox --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check';
  assert.deepEqual(codexCustodySupport(rootHelp, execHelp), { supported: true, reason: null });
  const result = codexCustodySupport(rootHelp, '--json --sandbox');
  assert.equal(result.supported, false);
  assert.match(result.reason, /--ephemeral/);
  assert.match(result.reason, /--ignore-user-config/);
});

test('Codex Windows sandbox backend parser accepts only explicit supported values from the windows table', () => {
  assert.equal(codexWindowsSandboxMode('[windows]\nsandbox = "elevated"'), 'elevated');
  assert.equal(codexWindowsSandboxMode('sandbox = "elevated"\n[windows]\nsandbox = "unelevated" # configured backend'), 'unelevated');
  assert.equal(codexWindowsSandboxMode('[windows]\nsandbox = "danger-full-access"'), null);
  assert.equal(codexWindowsSandboxMode('[other]\nsandbox = "elevated"'), null);
});

test('Codex Windows sandbox configuration is read only for Process Custody', async () => {
  let reads = 0;
  const unreadable = async () => { reads++; throw new Error('configuration is unreadable'); };
  assert.equal(await codexWindowsSandboxModeForRun(false, unreadable), null);
  assert.equal(reads, 0, 'ordinary Codex runs do not inspect this Custody-only setting');
  await assert.rejects(codexWindowsSandboxModeForRun(true, unreadable), /configuration is unreadable/);
  assert.equal(reads, 1, 'Custody fails closed when its Windows backend cannot be verified');
});

test('Codex parser retains lifecycle, item, unknown and usage events while selecting only the completed answer', () => {
  const parser = createParser('codex');
  const started = parser.feed({ type: 'thread.started', thread_id: 'thread-1' });
  assert.equal(started.sessionId, 'thread-1');
  assert.equal(started.providerEvent.type, 'thread.started');
  assert.equal(parser.feed({ type: 'turn.started', model: 'gpt-6-luna' }).model, 'gpt-6-luna');
  const itemStarted = parser.feed({ type: 'item.started', item: { id: 'item-1', type: 'command_execution', command: 'npm test' } });
  assert.equal(itemStarted.providerEvent.item.type, 'command_execution');
  parser.feed({ type: 'item.updated', item: { id: 'item-2', type: 'agent_message', text: 'Working' } });
  parser.feed({ type: 'item.completed', item: { id: 'item-2', type: 'agent_message', text: 'Done.' } });
  const unknown = parser.feed({ type: 'future.event', value: { safe: true } });
  assert.deepEqual(unknown.providerEvent, { type: 'future.event', value: { safe: true } });
  const completed = parser.feed({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 3 } });
  assert.equal(completed.providerEvent.type, 'turn.completed');
  assert.equal(parser.state.terminal, true);
  assert.equal(parser.state.finalText, 'Done.');
  assert.deepEqual(parser.state.usage, { input_tokens: 12, output_tokens: 3 });
  assert.equal(parser.state.error, null);
});

test('Codex failure text distinguishes authentication, rate limits, quota, service outages and protocol faults', () => {
  assert.equal(classifyFailure('Authentication required (HTTP 401).'), 'authentication');
  assert.equal(classifyFailure('Rate limit exceeded; HTTP 429.'), 'rate_limited');
  assert.equal(classifyFailure('Usage limit reached; quota exhausted.'), 'quota');
  assert.equal(classifyFailure('Service temporarily unavailable (503).'), 'provider_unavailable');
  assert.equal(classifyFailure('Malformed JSONL protocol event.'), 'provider_protocol');
  assert.equal(classifyFailure('unknown process exit'), 'process');
});

test('provider environment excludes API keys, Process Custody and inherited Codex app authority metadata', () => {
  const env = subscriptionEnvironment({ PATH: 'test', CODEX_HOME: 'profile', OPENAI_API_KEY: 'secret',
    DESZO_PROCESS_CUSTODY: '1', DESZO_CUSTODY_CAPABILITY: 'internal', CODEX_PERMISSION_PROFILE: ':danger-full-access',
    CODEX_SESSION_ID: 'outer-session', CODEX_APP_TOOLS_PIPE_PATH: 'internal-pipe', CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY: 'outer-family' });
  assert.deepEqual(env, { PATH: 'test', CODEX_HOME: 'profile' });
});

test('Codex Engine normalization retains unknown events and parses a final JSONL record without a newline', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    for (const [model, expected] of [['fixture-unknown-event', 'future.provider_event'], ['fixture-no-final-newline', 'turn.completed']]) {
      const started = await api.run(singleAgent({ id: `codex-${model}`, model, context: null }));
      const finished = await api.waitFor(started.body.run.runId);
      assert.equal(finished.run.state, 'succeeded', model);
      const store = api.runner.engine.store;
      const attempt = store.get("SELECT id FROM attempts WHERE run_id = ? AND node_instance_id = 'agent'", started.body.run.runId);
      const chunks = store.all("SELECT envelope_json FROM journal_events WHERE attempt_id = ? AND event_type = 'attempt.log_chunk'", attempt.id)
        .map(row => JSON.parse(row.envelope_json).payload).filter(item => item.stream === 'normalized').sort((a, b) => a.chunkIndex - b.chunkIndex);
      const text = (await Promise.all(chunks.map(item => api.artifactText(item.chunk.artifactId)))).join('');
      const events = text.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line).providerEvent?.type).filter(Boolean);
      assert.ok(events.includes(expected), `${model} retains ${expected} in normalized output`);
    }
  } finally { await api.close(); }
});
