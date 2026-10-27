import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  attemptsOf, buildArtifacts, cleanup, custodyBindings, database, eventually, exited, hostRecords, newScratch,
  publishDefinition, readInvocations, registerWorkspace, startCustodyHost, startEngine, startPublishedRun, waitForRunState, agentDefinition,
} from './custody-support.mjs';
import { deterministicOutcomeId, normalizeAttemptErrorCode, makeFailureOutcome, sourceForErrorCode } from '../core/failureOutcomes.mjs';
import { assertValid } from '../core/schemas.mjs';
import { singleAgent, startTestRunner } from './helpers.mjs';

const TERMINAL = ['succeeded', 'failed', 'canceled', 'interrupted', 'waiting_for_user'];

function outcomesOf(root, runId) {
  const db = database(root);
  try {
    return db.prepare('SELECT outcome_json,first_sequence,latest_sequence,revision FROM failure_outcomes WHERE run_id = ? ORDER BY latest_sequence').all(runId)
      .map(row => ({ outcome: JSON.parse(row.outcome_json), firstSequence: row.first_sequence, latestSequence: row.latest_sequence, revision: row.revision }));
  } finally { db.close(); }
}

function eventsOf(root, runId) {
  const db = database(root);
  try {
    return db.prepare('SELECT id,sequence,event_type,attempt_id,envelope_json FROM journal_events WHERE run_id = ? ORDER BY sequence').all(runId)
      .map(row => ({ ...row, envelope: JSON.parse(row.envelope_json) }));
  } finally { db.close(); }
}

function pagePath(runId, limit = 100) {
  return `/api/v2/runs/${runId}/failure-outcomes/page?afterSequence=0&limit=${limit}`;
}

test('P3 typed outcomes normalize only to canonical journal codes and keep summaries free of raw diagnostics', () => {
  assert.deepEqual(normalizeAttemptErrorCode('ENOENT', { source: 'provider', operation: 'provider_launch' }), {
    canonicalCode: 'provider_unavailable', rawCode: 'ENOENT',
  });
  assert.deepEqual(normalizeAttemptErrorCode('ENOENT', { source: 'engine', operation: 'persistence' }), {
    canonicalCode: 'process', rawCode: 'ENOENT',
  });
  assert.deepEqual(normalizeAttemptErrorCode('unknown value containing secret', { source: 'provider' }), {
    canonicalCode: 'process', rawCode: undefined,
  });
  assert.deepEqual(normalizeAttemptErrorCode('lifecycle_host_unavailable', { source: 'host' }), {
    canonicalCode: 'custody_unavailable', rawCode: 'lifecycle_host_unavailable',
  });
  assert.equal(sourceForErrorCode('lifecycle_unauthorized'), 'workflow');
  assert.equal(sourceForErrorCode('lifecycle_contract'), 'workflow');
  assert.equal(sourceForErrorCode('capture_failed'), 'engine', 'a local capture/storage failure is an Engine operational failure');
  assert.equal(sourceForErrorCode('workspace_overlap'), 'engine', 'workspace policy enforcement is owned by the Engine');

  const run = { id: '00000000-0000-4000-8000-000000000001', workspace_id: 'main', published_version_id: null };
  const attempt = { id: '00000000-0000-4000-8000-000000000002', node_instance_id: 'agent', state: 'failed' };
  assert.equal(deterministicOutcomeId(run.id, 'published_definition_integrity'), deterministicOutcomeId(run.id, 'published_definition_integrity'));
  const auth = makeFailureOutcome({ run, attempt, source: 'provider', code: 'authentication', attemptState: 'failed', runState: 'waiting_for_user',
    observedState: { exitCode: 13 }, evidenceReferences: [], recordedAt: '2026-10-27T00:00:00.000Z' });
  assert.equal(auth.category, 'provider_failure');
  assert.equal(auth.canonicalCode, 'authentication');
  assert.doesNotMatch(JSON.stringify(auth), /codex_secret|invalid token|diagnostic/i);

  const refusedLaunch = makeFailureOutcome({ run, attempt, source: 'host', code: 'provider_unavailable', attemptState: 'failed',
    runState: 'waiting_for_user', observedState: { hostState: 'launch_failed' }, executionCertainty: 'not_started', causeKnowledge: 'direct_fact' });
  assert.equal(refusedLaunch.category, 'orchestrator_failure', 'the proven Host source outranks the compatibility error code');

  const uncertain = makeFailureOutcome({ run, attempt, source: 'host', code: 'custody_unresolved', attemptState: 'running',
    executionCertainty: 'unresolved', observedState: { hostState: 'unavailable' } });
  assert.equal(uncertain.category, 'execution_uncertain');
  assert.equal(uncertain.executionCertainty, 'unresolved');
  assert.match(uncertain.message, /completion remains unproven/i);
  assert.doesNotMatch(uncertain.message, /confirmed the execution state/i);
  const refusedUnknown = makeFailureOutcome({ run, attempt, source: 'host', code: 'custody_unresolved', attemptState: 'running',
    executionCertainty: 'unresolved', observedState: { hostState: 'refused' } });
  assert.match(refusedUnknown.message, /Host refused a custody command/i);
  assert.doesNotMatch(refusedUnknown.message, /Host is unavailable/i);
  const recoveredBeforeLaunch = makeFailureOutcome({ run, attempt, source: 'recovery', code: 'interrupted', attemptState: 'canceled',
    executionCertainty: 'not_started', sideEffectCertainty: 'none_proven' });
  assert.equal(recoveredBeforeLaunch.source, 'recovery');
  assert.equal(recoveredBeforeLaunch.category, 'control_outcome');
  const recoveredUnknown = makeFailureOutcome({ run, attempt, source: 'recovery', code: 'interrupted', attemptState: 'interrupted',
    executionCertainty: 'unresolved' });
  assert.equal(recoveredUnknown.category, 'execution_uncertain');

  const runScoped = makeFailureOutcome({ run: { ...run, state: 'running' }, outcomeId: '00000000-0000-4000-8000-000000000003', source: 'engine', code: 'process', runState: 'running',
    causeKnowledge: 'unknown', executionCertainty: 'unknown', recordedAt: '2026-10-27T00:00:00.000Z' });
  assert.equal(runScoped.attemptId, undefined);
  assert.equal(runScoped.nodeInstanceId, undefined);
  assert.equal(runScoped.observedState.runState, 'running');
  assertValid('failure-outcome.schema.json', null, runScoped, 'Run-scoped failure outcome');
});

test('P3 run-scoped outcomes have durable identity without fake Attempt fields', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const started = await api.run(singleAgent({ id: 'p3-run-scope', model: 'fixture-echo', context: null }));
    const runId = started.body.run.runId;
    await api.waitFor(runId, run => run.state === 'succeeded');
    const engine = api.runner.engine;
    const successPage = await api.call('GET', pagePath(runId));
    assert.deepEqual(successPage.body.items, [], 'a successful provider completion creates no false failure outcome');
    const event = engine.failureOutcomeEvent(null, { runId, outcomeId: randomUUID(), source: 'engine', code: 'process', causeKnowledge: 'unknown',
      executionCertainty: 'unknown', runState: 'succeeded' });
    assert.equal(event.type, 'run.failure_outcome');
    engine.store.appendEvents(runId, [event]);
    const page = await api.call('GET', pagePath(runId));
    assert.equal(page.status, 200);
    assert.equal(page.body.items.length, 1);
    assert.equal(page.body.items[0].outcome.runId, runId);
    assert.equal(page.body.items[0].outcome.attemptId, undefined);
    assert.equal(page.body.items[0].outcome.nodeInstanceId, undefined);
    assert.equal(page.body.items[0].outcome.observedState.runState, 'succeeded');
    assert.deepEqual(page.body.legacyCoverage, { status: 'untyped', source: 'journal', untypedFailureCount: 0 });
  } finally { await api.close(); }
});

test('P3 legacy journal failures remain readable and the typed page reports its untyped gap', async () => {
  const api = await startTestRunner();
  try {
    await api.workspace();
    const started = await api.run(singleAgent({ id: 'p3-legacy-coverage', model: 'fixture-fail-once', context: null }));
    const runId = started.body.run.runId;
    await api.waitFor(runId, run => ['waiting_for_user', 'failed'].includes(run.state), 15_000);
    const engine = api.runner.engine;
    const attempt = engine.latestAttempt(runId, 'agent');
    engine.store.transaction(() => {
      // Model a pre-P3 journal: the failure and attempt history remain, while the additive typed projection is absent.
      engine.store.run('DELETE FROM failure_outcomes WHERE attempt_id = ?', attempt.id);
      engine.store.run(`DELETE FROM journal_events WHERE run_id = ? AND attempt_id = ?
        AND event_type IN ('attempt.failure_outcome','attempt.failure_outcome_updated')`, runId, attempt.id);
      const canceledAttemptId = randomUUID();
      engine.store.run(`INSERT INTO node_instances(run_id,id,node_id,node_type,state) VALUES(?, 'legacy-canceled', 'legacy-canceled', 'agent', 'canceled')`, runId);
      engine.store.run(`INSERT INTO attempts(id,run_id,node_instance_id,ordinal,state) VALUES(?, ?, 'legacy-canceled', 1, 'canceled')`, canceledAttemptId, runId);
      engine.store.appendEvents(runId, [{ type: 'attempt.state_changed', nodeInstanceId: 'legacy-canceled', attemptId: canceledAttemptId,
        payload: { from: 'scheduled', to: 'canceled', reason: 'Legacy user Stop.', process: null } }]);
    });
    const page = await api.call('GET', pagePath(runId));
    assert.equal(page.status, 200);
    assert.deepEqual(page.body.items, []);
    assert.deepEqual(page.body.legacyCoverage, { status: 'untyped', source: 'journal', untypedFailureCount: 2 });
    assert.ok(engine.store.readEvents(runId).some(event => event.type === 'attempt.error' && event.attemptId === attempt.id),
      'the original canonical failure remains accessible through the append-only journal');
  } finally { await api.close(); }
});

test('P3-E2E-01: a settled provider failure retains the same typed outcome and evidence after Engine replacement', { timeout: 240_000 }, async () => {
  buildArtifacts();
  const scratch = newScratch('p3-e2e-01');
  const host = await startCustodyHost(scratch.root);
  let engineA = null, engineB = null;
  try {
    engineA = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    await registerWorkspace(engineA, 'p3-e2e-01', scratch.workspace);
    const publication = await publishDefinition(engineA, agentDefinition({ workflowId: 'p3-e2e-01', model: 'custody-p2-repair-fail', requestText: 'Trigger the deterministic provider failure.' }));
    const runId = await startPublishedRun(engineA, publication, 'p3-e2e-01');
    assert.equal(await waitForRunState(engineA, runId, ['waiting_for_user'], 90_000), 'waiting_for_user');

    const firstPage = await engineA.api('GET', pagePath(runId, 1));
    assert.equal(firstPage.status, 200, JSON.stringify(firstPage.body));
    assert.equal(firstPage.body.items.length, 1);
    assert.equal(firstPage.body.nextCursor, null);
    assert.deepEqual(firstPage.body.legacyCoverage, { status: 'untyped', source: 'journal', untypedFailureCount: 0 });
    const stored = outcomesOf(scratch.root, runId);
    assert.equal(stored.length, 1);
    const before = stored[0].outcome;
    assert.equal(before.runId, runId);
    assert.equal(before.category, 'provider_failure');
    assert.equal(before.source, 'provider');
    assert.equal(before.executionCertainty, 'completed');
    assert.equal(before.canonicalCode, 'process');

    const events = eventsOf(scratch.root, runId);
    const typed = events.filter(event => event.event_type === 'attempt.failure_outcome');
    assert.equal(typed.length, 1);
    assert.equal(events.filter(event => event.event_type === 'attempt.failure_outcome_updated').length, 0);
    assert.equal(stored[0].firstSequence, typed[0].sequence);
    const eventRef = before.evidenceReferences.find(item => item.type === 'journal_event');
    assert.ok(eventRef, 'the outcome references its matching attempt.error event');
    assert.ok(events.some(event => event.id === eventRef.id && event.event_type === 'attempt.error'));
    const artifactRef = before.evidenceReferences.find(item => item.type === 'artifact');
    assert.ok(artifactRef, 'the provider exit evidence is durable');
    const artifact = await engineA.api('GET', `/api/v2/artifacts/${artifactRef.id}`);
    assert.equal(artifact.status, 200);
    assert.equal(artifact.etag, `"${artifactRef.sha256}"`);

    const originalAttemptId = before.attemptId;
    engineA.kill();
    assert.equal(await eventually(() => exited(engineA.child), 'Engine A to exit after the outcome was committed', 30_000, 100), true);
    engineB = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    const afterPage = await engineB.api('GET', pagePath(runId, 1));
    assert.equal(afterPage.status, 200);
    assert.deepEqual(afterPage.body.items[0].outcome, before);
    assert.equal(afterPage.body.items[0].firstSequence, stored[0].firstSequence);
    assert.equal(eventsOf(scratch.root, runId).filter(event => ['attempt.failure_outcome', 'attempt.failure_outcome_updated'].includes(event.event_type)).length, 1);
    assert.equal(attemptsOf(scratch.root, runId).filter(item => item.id === originalAttemptId).length, 1);
    assert.equal(readInvocations(scratch.fixtureState).filter(item => item.model === 'custody-p2-repair-fail').length, 1, 'recovery does not replay the provider invocation');
  } finally {
    for (const engine of [engineB, engineA]) if (engine && !exited(engine.child)) engine.kill();
    await host.shutdown().catch(() => host.crash());
    cleanup(scratch.root);
  }
});

test('P3-03/P3-22: provider authentication failure is typed without copying credential-shaped diagnostics', { timeout: 240_000 }, async () => {
  buildArtifacts();
  const scratch = newScratch('p3-auth');
  const host = await startCustodyHost(scratch.root);
  let engine = null;
  try {
    engine = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    await registerWorkspace(engine, 'p3-auth', scratch.workspace);
    const publication = await publishDefinition(engine, agentDefinition({ workflowId: 'p3-auth', model: 'custody-p3-auth-fail', requestText: 'Run the deterministic auth-failure fixture.' }));
    const runId = await startPublishedRun(engine, publication, 'p3-auth');
    assert.equal(await waitForRunState(engine, runId, ['waiting_for_user'], 90_000), 'waiting_for_user');
    const outcome = outcomesOf(scratch.root, runId)[0].outcome;
    assert.equal(outcome.category, 'provider_failure');
    assert.equal(outcome.canonicalCode, 'authentication');
    assert.equal(outcome.executionCertainty, 'completed');
    assert.doesNotMatch(JSON.stringify(outcome), /codex_secret_test_value/);
  } finally {
    if (engine && !exited(engine.child)) engine.kill();
    await host.shutdown().catch(() => host.crash());
    cleanup(scratch.root);
  }
});

test('P3-E2E-02: Rust Host failure evidence reconciles after Engine absence without a second launch', { timeout: 300_000 }, async () => {
  buildArtifacts();
  const scratch = newScratch('p3-e2e-02');
  const host = await startCustodyHost(scratch.root);
  let engineA = null, engineB = null;
  try {
    engineA = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    await registerWorkspace(engineA, 'p3-e2e-02', scratch.workspace);
    const publication = await publishDefinition(engineA, agentDefinition({ workflowId: 'p3-e2e-02', model: 'custody-p2-gated-repair-fail',
      requestText: 'Wait at the deterministic P2 Repair barrier, then fail.' }));
    const runId = await startPublishedRun(engineA, publication, 'p3-e2e-02');
    const readyPath = join(scratch.workspace, 'READY-P2_REPAIR.marker');
    await eventually(() => existsSync(readyPath), 'provider fixture to reach its synchronization barrier', 90_000, 100);
    const attempt = attemptsOf(scratch.root, runId).find(item => item.process_id);
    assert.ok(attempt?.id);
    const custodyId = custodyBindings(scratch.root, runId).find(item => item.attempt_id === attempt.id)?.custody_id;
    assert.ok(custodyId);
    assert.equal(hostRecords(host).find(record => record.custodyId === custodyId)?.state, 'running');

    engineA.kill();
    assert.equal(await eventually(() => exited(engineA.child), 'Engine A to exit while the Host keeps the process', 30_000, 100), true);
    writeFileSync(join(scratch.workspace, 'RELEASE-P2_REPAIR.marker'), 'fail under Host ownership\n');
    const terminalHost = await eventually(() => {
      const row = hostRecords(host).find(record => record.custodyId === custodyId);
      return row?.state === 'exited' && row.drained === true && row.spoolComplete === true ? row : null;
    }, 'Host to persist terminal process-tree and spool evidence', 90_000, 100);
    assert.equal(terminalHost.exitCode, 12);

    engineB = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    assert.equal(await waitForRunState(engineB, runId, ['waiting_for_user'], 90_000), 'waiting_for_user');
    const item = (await engineB.api('GET', pagePath(runId, 10))).body.items[0];
    assert.ok(item);
    const outcome = item.outcome;
    assert.equal(outcome.attemptId, attempt.id);
    assert.equal(outcome.custodyInvocationId, custodyId);
    assert.equal(outcome.category, 'provider_failure');
    assert.equal(outcome.canonicalCode, 'process');
    assert.equal(outcome.executionCertainty, 'completed');
    assert.equal(outcome.observedState.processTreeEnded, true);
    assert.equal(outcome.observedState.exitCode, 12);
    assert.equal(outcome.observedState.spoolComplete, true);
    assert.equal(outcomesOf(scratch.root, runId).length, 1);
    assert.equal(eventsOf(scratch.root, runId).filter(event => ['attempt.failure_outcome', 'attempt.failure_outcome_updated'].includes(event.event_type)).length, 1);
    assert.equal(readInvocations(scratch.fixtureState).filter(item => item.model === 'custody-p2-gated-repair-fail').length, 1);

    await engineB.stop();
    engineB = null;
    const engineC = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState });
    try {
      const recoveredPage = await engineC.api('GET', pagePath(runId, 10));
      assert.deepEqual(recoveredPage.body.items[0].outcome, outcome);
      assert.equal(eventsOf(scratch.root, runId).filter(event => ['attempt.failure_outcome', 'attempt.failure_outcome_updated'].includes(event.event_type)).length, 1);
      assert.equal(readInvocations(scratch.fixtureState).filter(item => item.model === 'custody-p2-gated-repair-fail').length, 1);
    } finally {
      if (!exited(engineC.child)) await engineC.stop().catch(() => engineC.kill());
    }
  } finally {
    writeFileSync(join(scratch.workspace, 'RELEASE-P2_REPAIR.marker'), 'test teardown\n');
    for (const engine of [engineB, engineA]) if (engine && !exited(engine.child)) engine.kill();
    await host.shutdown().catch(() => host.crash());
    cleanup(scratch.root);
  }
});

test('P3-E2E-03: a temporary Host outage stays uncertain, then reconciles the same outcome when the process completes', { timeout: 240_000 }, async () => {
  buildArtifacts();
  const scratch = newScratch('p3-e2e-03');
  const host = await startCustodyHost(scratch.root);
  const outage = join(scratch.root, 'custody-outage.flag');
  let engine = null;
  try {
    engine = await startEngine(scratch.root, host, { fixtureStateDir: scratch.fixtureState, extraEnv: { DESZO_CUSTODY_TEST_OUTAGE_FILE: outage } });
    await registerWorkspace(engine, 'p3-e2e-03', scratch.workspace);
    const publication = await publishDefinition(engine, agentDefinition({ workflowId: 'p3-e2e-03', model: 'custody-steady', requestText: '[ticks=18]' }));
    const runId = await startPublishedRun(engine, publication, 'p3-e2e-03');
    const attempt = await eventually(() => attemptsOf(scratch.root, runId).find(item => item.process_id), 'the Host-owned process to start', 60_000, 100);
    await eventually(() => hostRecords(host).some(record => record.attemptId === attempt.id && record.state === 'running'), 'the Host to confirm its process', 30_000, 100);

    writeFileSync(outage, 'temporarily unavailable\n');
    const unresolved = await eventually(() => outcomesOf(scratch.root, runId)[0]?.outcome?.executionCertainty === 'unresolved'
      ? outcomesOf(scratch.root, runId)[0].outcome : null, 'typed execution uncertainty to be recorded', 30_000, 100);
    assert.equal(unresolved.category, 'execution_uncertain');
    assert.equal(unresolved.observedState.hostState, 'unavailable');
    assert.match(unresolved.message, /completion remains unproven/i);
    assert.equal(attemptsOf(scratch.root, runId).find(item => item.id === attempt.id).state, 'running');
    const unresolvedError = eventsOf(scratch.root, runId).find(event => event.event_type === 'attempt.error' && event.attempt_id === attempt.id);
    assert.match(unresolvedError.envelope.payload.message, /Attempt state is running/);
    assert.doesNotMatch(unresolvedError.envelope.payload.message, /attempt stays running/i);
    assert.equal((await engine.api('GET', `/api/v2/runs/${runId}`)).body.run.state, 'running');

    rmSync(outage, { force: true });
    assert.equal(await waitForRunState(engine, runId, ['succeeded'], 90_000), 'succeeded');
    const reconciled = outcomesOf(scratch.root, runId)[0].outcome;
    assert.equal(reconciled.outcomeId, unresolved.outcomeId);
    assert.ok(reconciled.revision >= 2);
    assert.equal(reconciled.executionCertainty, 'completed');
    assert.equal(reconciled.observedState.processTreeEnded, true);
    const outcomeEvents = eventsOf(scratch.root, runId).filter(event => ['attempt.failure_outcome', 'attempt.failure_outcome_updated'].includes(event.event_type));
    assert.equal(outcomeEvents.filter(event => event.event_type === 'attempt.failure_outcome').length, 1);
    assert.ok(outcomeEvents.some(event => event.event_type === 'attempt.failure_outcome_updated'));
    assert.equal(outcomesOf(scratch.root, runId).length, 1);
    assert.equal(readInvocations(scratch.fixtureState).filter(item => item.pid === attempt.process_id).length, 1);
  } finally {
    rmSync(outage, { force: true });
    if (engine && !exited(engine.child)) engine.kill();
    await host.shutdown().catch(() => host.crash());
    cleanup(scratch.root);
  }
});
