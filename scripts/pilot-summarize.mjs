// Read-only inspection of pilot stores. Produces portable evidence without runtime bearer tokens.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { project } from '../shared/replay.mjs';

const legacyNames = ['2026-10-14-real', '2026-10-14-real-02', '2026-10-14-diagnostic', '2026-10-14-diagnostic-all', '2026-10-14-diagnostic-validated'];
const output = resolve(process.argv[2] || 'docs/pilots/evidence/2026-10-14-real-summary.json');
// Explicit roots let later pilots preserve the original report and evidence.
const roots = process.argv.length > 3 ? process.argv.slice(3).map(path => resolve(path)) : legacyNames.map(name => resolve('.deszo/pilots', name));
const summaries = [];
for (const root of roots) {
  const name = basename(root);
  const db = new DatabaseSync(join(root, 'store/state.sqlite'), { readOnly: true });
  const read = id => {
    const row = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id);
    assert.ok(row, `Missing artifact ${id}`);
    const bytes = readFileSync(join(root, 'store', row.relative_path));
    assert.equal(bytes.length, row.byte_size);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), row.sha256);
    return bytes.toString('utf8');
  };
  const json = id => JSON.parse(read(id));
  const events = db.prepare('SELECT envelope_json FROM journal_events ORDER BY run_id, sequence').all().map(row => JSON.parse(row.envelope_json));
  const invocations = [];
  for (const attempt of db.prepare('SELECT * FROM attempts WHERE invocation_artifact_id IS NOT NULL ORDER BY rowid').all()) {
    const invocation = json(attempt.invocation_artifact_id);
    const logs = events.filter(e => e.attemptId === attempt.id && e.type === 'attempt.log_chunk' && e.payload.stream === 'stdout');
    const rawEvents = logs.map(e => read(e.payload.chunk.artifactId)).join('').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    const init = rawEvents.find(e => e.type === 'system' && e.subtype === 'init' || e.event === 'init');
    const terminal = rawEvents.findLast(e => e.type === 'turn.completed' || e.type === 'result' || e.event === 'result');
    const failure = events.findLast(e => e.attemptId === attempt.id && e.type === 'attempt.state_changed' && e.payload.to === 'failed');
    let answer;
    if (attempt.outputs_artifact_id) {
      const manifest = json(attempt.outputs_artifact_id);
      if (manifest.values.json) answer = json(manifest.values.json.artifact.artifactId);
    }
    invocations.push({ node: attempt.node_instance_id, state: attempt.state, provider: invocation.provider, requestedModel: invocation.requestedModel, observedModel: init?.model || init?.init?.model || null, cliVersion: invocation.cliVersion, startedAt: attempt.started_at, endedAt: attempt.ended_at, nativeSessionBefore: !!invocation.nativeSessionBefore, usage: terminal?.usage || terminal?.result?.usage || null, failure: failure?.payload.reason || null, ...(answer ? { answer } : {}) });
  }
  const resultFile = join(root, 'evidence/result.json');
  const configurationFile = join(root, 'evidence/configuration.json');
  const configuration = existsSync(configurationFile) ? JSON.parse(readFileSync(configurationFile, 'utf8')) : null;
  const runs = db.prepare('SELECT id, state, created_at, last_sequence FROM runs').all();
  const replayLifecycle = runs.map(run => {
    const runEvents = events.filter(e => e.runId === run.id);
    const projected = project(runEvents, runEvents.length - 1);
    const databaseLoops = db.prepare('SELECT loop_node_id,state,pause_reason FROM loop_executions WHERE run_id=?').all(run.id);
    return { runId: run.id, databaseLoops, databaseIterations: db.prepare('SELECT loop_node_id,iteration,outcome,ended_at FROM loop_iterations WHERE run_id=?').all(run.id),
      replayRun: projected.run, replayLoops: [...projected.loops].map(([loopNodeId, loop]) => ({ loopNodeId, ...loop })),
      mismatches: databaseLoops.flatMap(loop => {
        const before = projected.loops.get(loop.loop_node_id);
        const expected = loop.state === 'succeeded' ? 'finished' : loop.state;
        return before?.state === expected ? [] : [{ loopNodeId: loop.loop_node_id, database: loop.state, replay: before?.state ?? null }];
      }) };
  });
  summaries.push({ name, root, configuration, runs, invocationCount: invocations.length, invocations, replayLifecycle, gateEvaluations: events.filter(e => e.type === 'gate.evaluated').map(e => ({ node: e.nodeInstanceId, ...e.payload })), operationalFailures: events.filter(e => e.type === 'attempt.state_changed' && e.payload.to === 'failed').map(e => ({ node: e.nodeInstanceId, reason: e.payload.reason })), journalEvents: events.length, integrity: db.prepare('PRAGMA integrity_check').get().integrity_check, ...(existsSync(resultFile) ? { result: JSON.parse(readFileSync(resultFile, 'utf8')) } : {}) });
  db.close();
}
const providerCounts = { codex: 0, claude: 0, antigravity: 0 };
for (const summary of summaries) for (const invocation of summary.invocations) providerCounts[invocation.provider]++;
const result = { createdAt: new Date().toISOString(), providerCounts, totalInvocations: Object.values(providerCounts).reduce((a, b) => a + b, 0), summaries };
mkdirSync(resolve(output, '..'), { recursive: true });
writeFileSync(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ output, totalInvocations: result.totalInvocations, providerCounts, runs: summaries.map(s => ({ name: s.name, states: s.runs.map(r => r.state), invocations: s.invocationCount, integrity: s.integrity })) }));
