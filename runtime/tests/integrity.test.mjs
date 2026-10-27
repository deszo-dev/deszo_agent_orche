// Regressions for the M1–M6 implementation review (R3, R5, R6, R7).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createParser, selectFinal } from '../core/adapters.mjs';
import { MIGRATION_PATHS, Store } from '../core/store.mjs';
import { fixtureAdapters, singleAgent, startTestRunner } from './helpers.mjs';

const stream = resolve(import.meta.dirname, 'stream-fixture.mjs');
const streamAdapters = (scenario, parser = null) => ({
  ...fixtureAdapters('unused'),
  ...(parser ? { createParser: parser } : {}),
  buildInvocation: ({ prompt, cwd }) => ({ command: process.execPath, args: [stream, scenario], stdin: prompt, cwd, env: process.env }),
});
const terminal = run => ['succeeded', 'failed', 'canceled', 'interrupted', 'waiting_for_user'].includes(run.state);
const agentText = async (api, snapshot) => {
  const instance = snapshot.instances.find(item => item.nodeId === 'agent');
  return api.artifactText((await api.artifactJson(instance.outputs.artifactId)).values.text.artifact.artifactId);
};

test('R6: a multibyte character split across stdout chunks is decoded intact', async () => {
  const api = await startTestRunner({ runner: { adapters: streamAdapters('split-utf8') } });
  try {
    await api.workspace();
    const done = await api.waitFor((await api.run(singleAgent({ id: 'utf8' }))).body.run.runId, terminal);
    assert.equal(done.run.state, 'succeeded');
    assert.equal(await agentText(api, done), 'Hello, 🌍 — привет');
  } finally { await api.close(); }
});

test('R5: final-answer selection follows the current output contract', () => {
  assert.deepEqual(selectFinal({ text: 'ORBIT\n', structured: { message: 'STALE' }, format: 'text', turnScopedStructured: false }), { finalText: 'ORBIT\n' });
  assert.deepEqual(selectFinal({ text: '{"message":"NOW"}', structured: { message: 'STALE' }, format: 'json', turnScopedStructured: false }), { finalText: '{"message":"NOW"}' });
  assert.deepEqual(selectFinal({ text: '', structured: { message: 'ONLY' }, format: 'json', turnScopedStructured: false }), { finalText: '{"message":"ONLY"}' });
  assert.match(selectFinal({ text: 'plain words', structured: { message: 'STALE' }, format: 'json', turnScopedStructured: false }).error, /stale or ambiguous/);
  assert.deepEqual(selectFinal({ text: 'Done.', structured: { message: 'TURN' }, format: 'json', turnScopedStructured: true }), { finalText: '{"message":"TURN"}' });
  const parser = createParser('antigravity', { output: { format: 'text' } });
  parser.feed({ event: 'result', result: { status: 'SUCCESS', response: 'ORBIT\n', structured_output: { message: 'STALE' } } });
  assert.equal(parser.state.finalText, 'ORBIT\n');
});

test('R5: an Antigravity text resume commits the current response, never the stale structured output', async () => {
  const api = await startTestRunner({ runner: { adapters: streamAdapters('antigravity-stale', createParser) } });
  try {
    await api.workspace();
    const done = await api.waitFor((await api.run(singleAgent({ id: 'stale-text', provider: 'antigravity' }))).body.run.runId, terminal);
    assert.equal(done.run.state, 'succeeded');
    assert.equal(await agentText(api, done), 'ORBIT\n');
    const ambiguous = await api.waitFor((await api.run(singleAgent({ id: 'stale-json', provider: 'antigravity', output: { format: 'json' } }))).body.run.runId, terminal);
    assert.equal(ambiguous.run.state, 'waiting_for_user', 'an ambiguous structured result fails instead of publishing it');
  } finally { await api.close(); }
});

test('R3: a log-storage failure is contained as capture_failed; a store that cannot be written blocks new work without crashing', async () => {
  const api = await startTestRunner({ runner: { adapters: streamAdapters('noisy') } });
  const store = api.runner.engine.store;
  const original = store.putBytes.bind(store);
  try {
    await api.workspace();
    store.putBytes = (bytes, mediaType, ...rest) => {
      if (mediaType === 'application/octet-stream') throw Object.assign(new Error('Injected ENOSPC while capturing CLI output'), { code: 'ENOSPC' });
      return original(bytes, mediaType, ...rest);
    };
    const runId = (await api.run(singleAgent({ id: 'capture-fault', context: null }))).body.run.runId;
    const failed = await api.waitFor(runId, terminal);
    assert.equal(failed.run.state, 'waiting_for_user');
    store.putBytes = original;
    await api.closeRun(runId);
    const error = (await api.events(runId)).find(event => event.type === 'attempt.error');
    assert.equal(error.payload.code, 'capture_failed');
    assert.match(error.payload.message, /ENOSPC/);
    const typed = (await api.events(runId)).find(event => event.type === 'attempt.failure_outcome' && event.attemptId === error.attemptId);
    assert.equal(typed.payload.outcome.source, 'engine');
    assert.equal(typed.payload.outcome.category, 'orchestrator_failure');
    assert.equal(typed.payload.outcome.canonicalCode, 'capture_failed');

    // When even the journal cannot be written, the runtime refuses new work and stays up.
    const appendEvents = store.appendEvents.bind(store);
    const second = (await api.run(singleAgent({ id: 'capture-fault-2', context: null }))).body.run.runId;
    store.putBytes = (bytes, mediaType, ...rest) => { if (mediaType === 'application/octet-stream') throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); return original(bytes, mediaType, ...rest); };
    store.appendEvents = (runId2, events) => { if (events.some(event => event.type === 'attempt.error')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); return appendEvents(runId2, events); };
    for (let i = 0; i < 100 && !api.runner.engine.recoveryBlocked; i++) await new Promise(done => setTimeout(done, 50));
    assert.match(api.runner.engine.recoveryBlocked, /could not write its store/);
    store.putBytes = original; store.appendEvents = appendEvents;
    const refused = await api.call('POST', '/api/v2/runs', { workflowId: 'capture-fault-2', workflowSnapshotSha256: (await api.save(singleAgent({ id: 'capture-fault-2', context: null }))).snapshotSha256, workspaceId: 'main', requestId: randomUUID() });
    assert.equal(refused.status, 409);
    void second;
  } finally { store.putBytes = original; await api.close(); }
});

test('R7: a failing migration rolls back its DDL together with its version row', async () => {
  const root = join(resolve(import.meta.dirname, '../../.deszo/tests'), `migration-${randomUUID()}`);
  mkdirSync(join(root, 'store'), { recursive: true });
  const scripts = MIGRATION_PATHS.map(path => readFileSync(path, 'utf8'));
  new Store(root, { migrations: scripts.slice(0, 1) }).close();
  const broken = scripts[1].replace('COMMIT;', 'INSERT INTO no_such_table VALUES (1);\nCOMMIT;');
  assert.throws(() => new Store(root, { migrations: [scripts[0], broken] }), /migration 2 failed and was rolled back; the store is unchanged at version 1/);
  const db = new DatabaseSync(join(root, 'store', 'state.sqlite'));
  assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, 1);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='loop_executions'").get(), undefined, 'no partial schema survives');
  db.close();
  const store = new Store(root);
  assert.equal(store.get('SELECT MAX(version) AS v FROM schema_migrations').v, scripts.length);
  store.close();
});
