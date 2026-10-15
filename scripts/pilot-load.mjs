// A bounded local load/restart probe. All model responses are fixture responses; no provider is called.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startTestRunner, singleAgent } from '../runtime/tests/helpers.mjs';

const root = resolve(process.argv[2] || '.deszo/pilots/2026-10-14-load');
const workers = 6, rounds = 30;
const minuteOption = process.argv.indexOf('--minutes');
const soakMinutes = minuteOption < 0 ? null : Number(process.argv[minuteOption + 1]);
assert.ok(soakMinutes === null || Number.isFinite(soakMinutes) && soakMinutes > 0 && soakMinutes <= 120, 'Soak duration must be 1–120 minutes.');
assert.ok(!existsSync(join(root, 'store/state.sqlite')), 'Use a fresh load root to preserve earlier evidence.');
mkdirSync(root, { recursive: true });
let api = await startTestRunner({ root });
const started = Date.now(), runIds = [], samples = [], intervals = [], evidence = [];
const sample = setInterval(() => samples.push({ milliseconds: Date.now() - started, ...process.memoryUsage() }), 1000);
try {
  for (let worker = 0; worker < workers; worker++) await api.workspace(`worker-${worker}`);
  await Promise.all(Array.from({ length: workers }, async (_, worker) => {
    for (let round = 0; soakMinutes === null ? round < rounds : Date.now() - started < soakMinutes * 60_000; round++) {
      const provider = ['codex', 'claude', 'antigravity'][(worker + round) % 3];
      const noisy = round % 3 === 0;
      const workflow = singleAgent({ id: `load-${worker}`, provider, model: noisy ? 'fixture-noisy' : 'fixture-slow-1', context: null });
      const created = await api.run(workflow, `worker-${worker}`);
      assert.equal(created.status, 202, JSON.stringify(created.body));
      const id = created.body.run.runId;
      runIds.push(id);
      const snapshot = await api.waitFor(id, undefined, 120_000);
      assert.equal(snapshot.run.state, 'succeeded');
      const events = await api.events(id);
      assert.deepEqual(events.map(e => e.sequence), Array.from({ length: events.length }, (_, i) => i + 1));
      const attempt = api.runner.engine.store.get('SELECT * FROM attempts WHERE run_id = ? AND node_instance_id = ?', id, 'agent');
      intervals.push({ runId: id, provider, started: attempt.started_at, ended: attempt.ended_at });
      const chunks = events.filter(e => e.type === 'attempt.log_chunk' && e.payload.stream === 'stdout');
      assert.deepEqual(chunks.map(e => e.payload.chunkIndex), chunks.map((_, i) => i));
      let stream = '';
      for (const chunk of chunks) stream += await api.artifactText(chunk.payload.chunk.artifactId);
      if (noisy) assert.equal(stream.trim().split('\n').length, 403);
      const replayFrom = Math.floor(events.length / 2);
      assert.deepEqual(await api.events(id, replayFrom), events.slice(replayFrom));
      evidence.push({ runId: id, provider, journalEvents: events.length, stdoutBatches: chunks.length, stdoutBytes: Buffer.byteLength(stream), replayFrom });
      if (round % 10 === 0) {
        const progress = { completed: evidence.length, total: soakMinutes === null ? workers * rounds : null, soakMinutes, milliseconds: Date.now() - started, rss: process.memoryUsage().rss };
        writeFileSync(join(root, 'load-progress.json'), JSON.stringify(progress, null, 2));
        console.log(JSON.stringify(progress));
      }
    }
  }));
  const boundaries = intervals.flatMap(i => [{ at: i.started, delta: 1, provider: i.provider }, { at: i.ended, delta: -1, provider: i.provider }]).sort((a, b) => a.at.localeCompare(b.at) || a.delta - b.delta);
  let live = 0, peak = 0;
  const providers = { codex: 0, claude: 0, antigravity: 0 }, providerPeaks = { ...providers };
  for (const boundary of boundaries) {
    live += boundary.delta;
    providers[boundary.provider] += boundary.delta;
    peak = Math.max(peak, live);
    providerPeaks[boundary.provider] = Math.max(providerPeaks[boundary.provider], providers[boundary.provider]);
    assert.ok(live <= 3, 'Global capacity exceeded');
    assert.ok(providers[boundary.provider] <= 1, 'Provider capacity exceeded');
  }
  assert.equal(live, 0);
  assert.ok(peak >= 2, 'Probe did not exercise parallel calls');
  const journalCount = api.runner.engine.store.get('SELECT count(*) AS n FROM journal_events').n;
  const artifactCount = api.runner.engine.store.get('SELECT count(*) AS n FROM artifacts').n;
  await api.close();
  api = await startTestRunner({ root });
  assert.equal(api.runner.engine.store.get('PRAGMA integrity_check').integrity_check, 'ok');
  assert.equal(api.runner.engine.store.get('SELECT count(*) AS n FROM journal_events').n, journalCount);
  const history = [];
  let cursor;
  do {
    const page = await api.call('GET', '/api/v2/runs?limit=17' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    assert.equal(page.status, 200);
    history.push(...page.body.items.map(item => item.runId));
    cursor = page.body.nextCursor;
  } while (cursor);
  assert.deepEqual(history.sort(), [...runIds].sort());
  for (const id of [runIds[0], runIds.at(-1)]) {
    const events = await api.events(id);
    assert.equal(events.length, evidence.find(item => item.runId === id).journalEvents);
    assert.equal((await api.call('GET', '/api/v2/runs/' + id)).body.run.state, 'succeeded');
  }
  const result = { passed: true, fixtureOnly: true, soakMinutes, runs: runIds.length, workspaces: workers, elapsedSeconds: (Date.now() - started) / 1000, peak, providerPeaks, journalCount, artifactCount, sqliteBytes: statSync(join(root, 'store/state.sqlite')).size, rssMinimum: Math.min(...samples.map(s => s.rss)), rssMaximum: Math.max(...samples.map(s => s.rss)), integrity: 'ok', restartHistory: 'all runs and journal counts preserved', evidence, samples };
  writeFileSync(join(root, 'load-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, evidence: undefined, samples: undefined }));
} catch (error) {
  writeFileSync(join(root, 'load-error.json'), JSON.stringify({ message: error.message, stack: error.stack, completed: evidence.length }, null, 2));
  throw error;
} finally {
  clearInterval(sample);
  await api.close();
}
