// runner.lock: one live Engine per runtime root. Ownership is an exclusive SQLite lock on runtime/runner.lock.db, held by the owning connection
// for the Engine's whole life and released by the operating system when the process ends; runtime/runner.lock is only the owner's marker.
// The proofs use real processes: lock-level contenders that import runtime/lock.mjs, and real Engines started from runtime/runner.mjs. The
// original defect (two contenders recovering one stale marker, one deleting the other's fresh lock) is forced with a test-only barrier that holds
// every contender at the lock database until all of them have arrived. Only processes these tests start are ever stopped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:net';
import { startRunner } from '../runner.mjs';
import { fixtureAdapters } from './fixture-adapters.mjs';
import { buildArtifacts, fixtureDir, isAlive, processIdentity, readInvocations, repo, retargetJunction, startCustodyHost, testsRoot } from './custody-support.mjs';

const lockModule = pathToFileURL(join(repo, 'runtime/lock.mjs')).href;
const register = pathToFileURL(join(repo, 'runtime/tests/fixtures/runner-lock-register.mjs')).href;
const runnerPath = join(repo, 'runtime/runner.mjs');
const OWNED = /A runtime already owns this data directory/;
const SETTLED = ['succeeded', 'failed', 'canceled', 'interrupted', 'waiting_for_user'];
const sleep = ms => new Promise(done => setTimeout(done, ms));
const evidence = { schemaVersion: 1, generatedAt: new Date().toISOString(), node: process.version, cases: {} };
const owned = new Set();

test.after(() => {
  for (const pid of owned) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  mkdirSync(join(testsRoot, 'runner-lock-evidence'), { recursive: true });
  writeFileSync(join(testsRoot, 'runner-lock-evidence', 'runner-lock.json'), JSON.stringify(evidence, null, 2));
});

function newRoot(label) {
  mkdirSync(testsRoot, { recursive: true });
  const root = mkdtempSync(join(testsRoot, `runner-lock-${label}-`));
  mkdirSync(join(root, 'runtime'), { recursive: true });
  return root;
}
const markerPath = root => join(root, 'runtime', 'runner.lock');
const marker = root => (existsSync(markerPath(root)) ? JSON.parse(readFileSync(markerPath(root), 'utf8')) : null);
function remove(path) { rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
function deadPid() {
  const pid = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', windowsHide: true }).stdout);
  assert.equal(isAlive(pid), false, 'the stale owner is a process that has ended');
  return pid;
}

// ---------- Lock-level contenders: real processes that import runtime/lock.mjs ----------
// A contender waits for `go` (when given), tries the lock, prints one line, then obeys stdin: "work" (store transactions and child processes,
// as an Engine does), "release" (its release closure; the process stays alive), "exit".
const contenderCode = `
  import { acquireRuntimeLock } from ${JSON.stringify(lockModule)};
  import { existsSync, mkdirSync } from 'node:fs';
  import { spawnSync } from 'node:child_process';
  import { DatabaseSync } from 'node:sqlite';
  import { createInterface } from 'node:readline';
  const [file, go, scratch] = process.argv.slice(1);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  if (go) { const until = Date.now() + 30000; while (!existsSync(go)) { if (Date.now() > until) process.exit(5); Atomics.wait(pause, 0, 0, 2); } }
  let release = null;
  try { release = await acquireRuntimeLock(file); console.log('acquired'); } catch (error) { console.log('refused ' + error.message); }
  createInterface({ input: process.stdin }).on('line', async line => {
    if (line === 'work') {
      mkdirSync(scratch, { recursive: true });
      const store = new DatabaseSync(scratch + '/work.sqlite');
      store.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS t(v)');
      for (let i = 0; i < 300; i++) store.exec("BEGIN IMMEDIATE; INSERT INTO t VALUES ('" + i + "'); COMMIT;");
      store.close();
      for (let i = 0; i < 3; i++) spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 100)']);
      globalThis.gc?.();
      console.log('worked');
    }
    if (line === 'release') { await release?.(); await release?.(); console.log('released'); }
    if (line === 'exit') process.exit(0);
  });`;

function contender(file, { go = '', scratch = '' } = {}) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--expose-gc', '--input-type=module', '-e', contenderCode, file, go, scratch],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  owned.add(child.pid);
  const lines = []; let wake = null; let stderr = '';
  child.stdout.on('data', chunk => { for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) lines.push(line); wake?.(); });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.on('error', () => {});
  child.exited = new Promise(done => child.once('exit', code => { owned.delete(child.pid); done(code); }));
  child.next = (timeoutMs = 30_000) => new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`contender ${child.pid} said nothing: ${stderr}`)), timeoutMs);
    const poll = () => { if (lines.length) { clearTimeout(timer); wake = null; done(lines.shift()); } else wake = poll; };
    poll();
  });
  child.send = command => { if (child.exitCode === null) child.stdin.write(`${command}\n`); };
  child.end = async () => { child.send('exit'); await Promise.race([child.exited, sleep(10_000)]); if (child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); };
  return child;
}

async function contend(file) { const probe = contender(file); const outcome = await probe.next(); await probe.end(); return outcome; }

// What any other connection to the lock database gets while it is held: an exclusive transaction, a read, the lock's own first statement.
function rawAccess(file) {
  const result = {};
  for (const [name, sql] of Object.entries({ beginExclusive: 'BEGIN EXCLUSIVE; COMMIT;', read: 'SELECT count(*) FROM sqlite_master;', journalMode: 'PRAGMA journal_mode = DELETE;' })) {
    const db = new DatabaseSync(`${file}.db`);
    try { db.exec(sql); result[name] = 'ok'; } catch (error) { result[name] = `errcode ${error.errcode}`; } finally { db.close(); }
  }
  return result;
}

test('LOCK-SEM: the exclusive lock holds after COMMIT and through Engine activity, refuses every other process, and is released by close and by process death', { timeout: 180_000 }, async () => {
  const root = newRoot('sem');
  const file = markerPath(root);
  try {
    const holder = contender(file, { scratch: join(root, 'scratch') });
    assert.equal(await holder.next(), 'acquired');
    const ownerMarker = marker(root);
    assert.equal(ownerMarker.pid, holder.pid, 'the marker names the owner: { pid, id } as the launcher reads it');
    assert.match(ownerMarker.id, /^[0-9a-f-]{36}$/);
    const afterCommit = rawAccess(file);
    assert.deepEqual(afterCommit, { beginExclusive: 'errcode 5', read: 'errcode 5', journalMode: 'errcode 5' }, 'the lock is still held after its transaction committed');
    assert.match(await contend(file), OWNED);

    holder.send('work');
    assert.equal(await holder.next(), 'worked');
    const afterActivity = rawAccess(file);
    assert.deepEqual(afterActivity, afterCommit, 'store transactions, child processes and a garbage collection in the owner do not release it');
    assert.match(await contend(file), OWNED);

    // LCK-06: the marker is not the lock. Without it, the owner still excludes everyone.
    unlinkSync(file);
    assert.match(await contend(file), OWNED, 'a missing marker admits nobody while the lock is held');
    assert.equal(existsSync(file), false, 'a refused contender writes no marker');

    holder.send('release');
    assert.equal(await holder.next(), 'released');
    assert.equal(isAlive(holder.pid), true, 'the former owner is still running');
    assert.equal(await contend(file), 'acquired', 'closing the owning connection releases the lock, with its process alive');
    await holder.end();

    // LCK-07 and process death: the lock database stays on disk; a killed owner leaves its marker, and the next contender takes the lock.
    const killed = contender(file);
    assert.equal(await killed.next(), 'acquired');
    const killedMarker = marker(root);
    spawnSync('taskkill', ['/PID', String(killed.pid), '/F'], { windowsHide: true });
    await killed.exited;
    assert.deepEqual(marker(root), killedMarker, 'a killed owner leaves its marker behind');
    assert.ok(existsSync(`${file}.db`), 'the lock database remains');
    const successor = contender(file);
    assert.equal(await successor.next(), 'acquired', 'the operating system released the lock of the killed owner');
    assert.equal(marker(root).pid, successor.pid, 'the successor replaced the stale marker');
    await successor.end();
    evidence.cases['LOCK-SEM'] = { node: process.version, sqlite: new DatabaseSync(':memory:').prepare('SELECT sqlite_version() AS v').get().v, afterCommit, afterActivity,
      releasedByCloseWithOwnerAlive: true, releasedByKill: true, missingMarkerStillRefused: true };
  } finally { remove(root); }
});

test('LOCK-RACE (RL-FIX-02/08 at the lock): contenders released together, with and without a stale marker, yield exactly one owner every round', { timeout: 300_000 }, async () => {
  const rounds = [];
  for (let round = 0; round < 24; round++) {
    const root = newRoot(`race-${round}`);
    const file = markerPath(root), go = join(root, 'go');
    const stale = round % 2 === 0;
    if (stale) writeFileSync(file, JSON.stringify({ pid: deadPid(), id: 'stale-owner' }));
    try {
      const count = round % 3 === 0 ? 2 : 10;
      const racers = Array.from({ length: count }, () => contender(file, { go }));
      await sleep(400);
      writeFileSync(go, '1');
      const outcomes = await Promise.all(racers.map(racer => racer.next()));
      const winners = racers.filter((_, index) => outcomes[index] === 'acquired');
      assert.equal(winners.length, 1, `round ${round}: exactly one owner (${outcomes.join(' | ')})`);
      assert.ok(outcomes.filter(outcome => outcome !== 'acquired').every(outcome => OWNED.test(outcome)), 'every other contender is refused as already owned');
      assert.equal(marker(root).pid, winners[0].pid, 'the marker is the winner\'s, never a loser\'s or the stale one');
      rounds.push({ round, contenders: count, staleMarker: stale, owners: winners.length });
      await Promise.all(racers.map(racer => racer.end()));
    } finally { remove(root); }
  }
  evidence.cases['LOCK-RACE'] = { rounds: rounds.length, contenders: rounds.reduce((sum, item) => sum + item.contenders, 0), everyRoundOneOwner: rounds.every(item => item.owners === 1) };
});

test('LCK-05: a release removes only its own marker, and a release after ownership passed on removes nothing of the successor and does not touch its lock', { timeout: 60_000 }, async () => {
  const root = newRoot('lck05');
  const file = markerPath(root);
  const { acquireRuntimeLock } = await import(lockModule);
  try {
    // A marker that is not the releasing owner's (written by someone else meanwhile) is left in place, and the lock is released.
    const earlier = await acquireRuntimeLock(file);
    const foreign = { pid: deadPid(), id: 'someone-else' };
    writeFileSync(file, JSON.stringify(foreign));
    await earlier();
    assert.deepEqual(marker(root), foreign, 'the owner did not remove a marker that is not its own');
    assert.equal(await contend(file), 'acquired', 'the lock was released all the same');

    const first = await acquireRuntimeLock(file);
    await first();
    const successor = contender(file);
    assert.equal(await successor.next(), 'acquired');
    const successorMarker = marker(root);
    await first(); // A late, repeated release by the earlier owner.
    assert.deepEqual(marker(root), successorMarker, 'the successor\'s marker stays');
    assert.match(await contend(file), OWNED, 'the successor still owns the root');
    await successor.end();
    evidence.cases['LCK-05'] = { foreignMarkerKeptOnRelease: true, staleReleaseKeptSuccessorMarker: true, successorStillOwner: true };
  } finally { remove(root); }
});

// ---------- Real Engines from runtime/runner.mjs ----------
function startEngine(root, role, { env = {}, hooks = false, custody = null } = {}) {
  const connectionFile = join(root, 'runtime', `connection-${role}.json`);
  const fixtureState = join(root, `fixture-${role}`);
  mkdirSync(fixtureState, { recursive: true });
  const args = ['--disable-warning=ExperimentalWarning', ...(hooks ? ['--import', register] : []), runnerPath, '--root', root, '--connection-file', connectionFile, '--dev-test-confirmation-off'];
  const childEnv = { ...process.env, ...env };
  if (custody) {
    const codexHome = join(root, `codex-home-${role}`); mkdirSync(codexHome, { recursive: true });
    Object.assign(childEnv, { PATH: `${fixtureDir}${delimiter}${process.env.PATH}`, DESZO_PROCESS_CUSTODY: '1', CUSTODY_FIXTURE_STATE_DIR: fixtureState, CODEX_HOME: codexHome,
      DESZO_CUSTODY_ADDRESS: custody.address, DESZO_CUSTODY_CAPABILITY: custody.capability, DESZO_CUSTODY_GENERATION: custody.generation });
  } else {
    args.push('--fixture-state', fixtureState);
    delete childEnv.DESZO_PROCESS_CUSTODY;
  }
  const child = spawn(process.execPath, args, { cwd: repo, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  owned.add(child.pid);
  const engine = { role, child, pid: child.pid, connectionFile, stderr: '', exitCode: undefined };
  child.stderr.on('data', chunk => { engine.stderr += chunk; });
  child.stdout.on('data', () => {});
  child.stdin.on('error', () => {});
  engine.exited = new Promise(done => child.once('exit', code => { engine.exitCode = code; owned.delete(child.pid); done(code); }));
  return engine;
}

// Ready: the Engine initialized and published its connection descriptor. Exited: it refused or failed before that.
async function outcome(engine, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (engine.exitCode !== undefined) return { state: 'exited', exitCode: engine.exitCode, stderr: engine.stderr };
    if (existsSync(engine.connectionFile)) { try { engine.connection = JSON.parse(readFileSync(engine.connectionFile, 'utf8')); return { state: 'ready' }; } catch { /* Being written. */ } }
    await sleep(50);
  }
  throw new Error(`Engine ${engine.role} (${engine.pid}) neither started nor exited: ${engine.stderr}`);
}

async function stopEngine(engine) {
  if (engine.exitCode !== undefined) return 'already-exited';
  engine.child.stdin.write('{"command":"shutdown"}\n');
  const result = await Promise.race([engine.exited.then(() => 'graceful'), sleep(20_000).then(() => 'timeout')]);
  if (result === 'timeout') { spawnSync('taskkill', ['/PID', String(engine.pid), '/T', '/F'], { windowsHide: true }); await engine.exited; }
  return result;
}

async function api(engine, method, path, body, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${engine.connection.port}${path}`, { method, signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${engine.connection.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, etag: response.headers.get('etag'), body: text ? JSON.parse(text) : null };
}

// Publishes a one-agent workflow and starts a Run of it in a fresh workspace; returns the Run id.
async function dispatch(engine, { workspaceId, cwd, model, requestText = 'echo' }) {
  mkdirSync(cwd, { recursive: true });
  assert.equal((await api(engine, 'PUT', `/api/v2/workspaces/${workspaceId}`, { cwd })).status, 200);
  const workflowId = `lock-${randomUUID().slice(0, 8)}`;
  const definition = { schemaVersion: 1, workflowId, capabilities: ['core-v1'], settings: { nativeConfiguration: 'restricted' },
    nodes: [{ id: 'request', type: 'text', config: { value: requestText } },
      { id: 'agent', type: 'agent', config: { provider: 'codex', model, timeoutSeconds: 120, output: { format: 'text' } } },
      { id: 'result', type: 'result-viewer', config: {} }],
    edges: [{ id: 'request-agent', source: { nodeId: 'request', port: 'text' }, target: { nodeId: 'agent', port: 'prompt' } },
      { id: 'agent-result', source: { nodeId: 'agent', port: 'text' }, target: { nodeId: 'result', port: 'value' } }], after: [] };
  const draft = await api(engine, 'PUT', `/api/v4/workflows/${workflowId}/draft`, { requestId: randomUUID(), workflow: definition }, { 'If-None-Match': '*' });
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  assert.equal((await api(engine, 'POST', `/api/v4/workflows/${workflowId}/draft/validate`, {}, { 'If-Match': draft.etag })).status, 200);
  const publication = await api(engine, 'POST', `/api/v4/workflows/${workflowId}/publish`, { requestId: randomUUID() }, { 'If-Match': draft.etag });
  assert.equal(publication.status, 201, JSON.stringify(publication.body));
  const started = await api(engine, 'POST', '/api/v2/runs', { workflowId, workflowSnapshotSha256: publication.body.snapshotSha256,
    publishedVersionId: publication.body.publishedVersionId, definitionDigest: publication.body.definitionDigest, workspaceId, requestId: randomUUID() });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  return started.body.run.runId;
}

async function settled(engine, runId, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const state = (await api(engine, 'GET', `/api/v2/runs/${runId}`)).body?.run?.state;
    if (SETTLED.includes(state)) return state;
    await sleep(150);
  }
  throw new Error(`run ${runId} did not settle`);
}

function storeRows(root, sql, ...params) {
  const db = new DatabaseSync(join(root, 'store', 'state.sqlite'), { readOnly: true });
  try { return db.prepare(sql).all(...params).map(row => ({ ...row })); } finally { db.close(); }
}
const agentAttempt = (root, runId) => storeRows(root, "SELECT id, state, process_id, process_start_identity FROM attempts WHERE run_id = ? AND node_instance_id = 'agent'", runId)[0] ?? null;
async function until(predicate, label, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  for (;;) { const value = await predicate(); if (value) return value; if (Date.now() > end) throw new Error(`timed out: ${label}`); await sleep(100); }
}

// Engines held at the lock database until all of them have arrived, each recording every marker operation it performs.
function startContending(root, count, label) {
  const barrier = join(root, `barrier-${label}`); mkdirSync(barrier);
  return Array.from({ length: count }, (_, index) => {
    const log = join(root, `fs-${label}-${index}.log`);
    const engine = startEngine(root, `${label}${index}`, { hooks: true, env: { RUNNER_LOCK_BARRIER_DIR: barrier, RUNNER_LOCK_BARRIER_COUNT: String(count), RUNNER_LOCK_FS_LOG: log } });
    engine.fsLog = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split(/\r?\n/).filter(Boolean) : []);
    return engine;
  });
}

test('RL-FIX-01: ten Engines started together for one root: exactly one initializes, serves and dispatches; nine are refused before the Engine', { timeout: 600_000 }, async () => {
  const rounds = [];
  for (let round = 0; round < 3; round++) {
    const root = newRoot(`fix01-${round}`);
    const engines = startContending(root, 10, `r${round}-`);
    try {
      const outcomes = await Promise.all(engines.map(engine => outcome(engine)));
      const winners = engines.filter((_, index) => outcomes[index].state === 'ready');
      assert.equal(winners.length, 1, `round ${round}: exactly one Engine initialized (${outcomes.map(item => item.state).join(',')}): ${engines[0].stderr.slice(-600)}`);
      const losers = engines.filter(engine => engine !== winners[0]);
      for (const loser of losers) {
        assert.notEqual(loser.exitCode, 0, 'a refused Engine exits with an error');
        assert.match(loser.stderr, OWNED);
        assert.equal(existsSync(loser.connectionFile), false, 'a refused Engine never published a connection');
        assert.deepEqual(loser.fsLog(), [], 'a refused Engine performed no marker operation');
      }
      const winner = winners[0];
      assert.equal(marker(root).pid, winner.pid);
      assert.equal((await api(winner, 'GET', '/api/v2/settings')).status, 200, 'the winner serves');
      const runId = await dispatch(winner, { workspaceId: 'ws-win', cwd: join(root, 'work'), model: 'fixture-echo' });
      assert.equal(await settled(winner, runId), 'succeeded', 'the winner dispatches work');
      assert.equal(storeRows(root, 'SELECT COUNT(*) AS n FROM runs')[0].n, 1, 'the only Run in the store is the winner\'s');
      rounds.push({ round, engines: engines.length, winnerPid: winner.pid, winnerCreated: processIdentity(winner.pid), refused: losers.length, runId });
      assert.equal(await stopEngine(winner), 'graceful');
      assert.equal(marker(root), null, 'a graceful owner removes its marker');
    } finally { for (const engine of engines) if (engine.exitCode === undefined) await stopEngine(engine); remove(root); }
  }
  evidence.cases['RL-FIX-01'] = { rounds };
});

test('RL-FIX-02 / RL-FIX-08: two Engines recovering one stale marker, released together at the lock: exactly one owns; the loser never touches the marker', { timeout: 600_000 }, async () => {
  const rounds = [];
  for (let round = 0; round < 4; round++) {
    const root = newRoot(`fix02-${round}`);
    const stale = { pid: deadPid(), id: `stale-${round}` };
    writeFileSync(markerPath(root), JSON.stringify(stale));
    const [a, b] = startContending(root, 2, `r${round}-`);
    try {
      const [oa, ob] = await Promise.all([outcome(a), outcome(b)]);
      const states = [oa.state, ob.state].sort();
      assert.deepEqual(states, ['exited', 'ready'], `round ${round}: one owner, one refusal (${oa.state}/${ob.state}): ${a.stderr}${b.stderr}`);
      const [winner, loser] = oa.state === 'ready' ? [a, b] : [b, a];
      assert.match(loser.stderr, OWNED);
      assert.deepEqual(loser.fsLog(), [], 'the loser neither deleted nor replaced any marker');
      const operations = winner.fsLog().map(line => line.split(' ')[1]);
      assert.deepEqual(operations, ['write', 'rename'], 'the winner replaced the stale marker atomically, after taking the lock, and deleted nothing');
      assert.equal(marker(root).pid, winner.pid, 'the marker names the winner');
      assert.notEqual(marker(root).id, stale.id);
      const runId = await dispatch(winner, { workspaceId: 'ws-win', cwd: join(root, 'work'), model: 'fixture-echo' });
      assert.equal(await settled(winner, runId), 'succeeded');
      rounds.push({ round, stalePid: stale.pid, winner: winner.role, winnerPid: winner.pid, loserPid: loser.pid, loserMarkerOperations: 0, winnerMarkerOperations: operations });
      await stopEngine(winner);
    } finally { for (const engine of [a, b]) if (engine.exitCode === undefined) await stopEngine(engine); remove(root); }
  }
  evidence.cases['RL-FIX-02/08'] = { rounds };
});

test('RL-FIX-03 / LCK-04: an owner killed during a Run leaves a stale marker; the successor starts without any file removal and recovers alone', { timeout: 300_000 }, async () => {
  const root = newRoot('fix03');
  let a, b, cli = null;
  try {
    a = startEngine(root, 'A');
    assert.equal((await outcome(a)).state, 'ready');
    const runId = await dispatch(a, { workspaceId: 'ws-a', cwd: join(root, 'work-a'), model: 'fixture-slow-30' });
    const running = await until(() => { const row = agentAttempt(root, runId); return row?.state === 'running' && row.process_id ? row : null; }, 'A\'s CLI to run');
    cli = { pid: running.process_id, created: processIdentity(running.process_id) };
    const staleMarker = marker(root);
    // Only the Engine process is killed. On Windows Node keeps its children in a kill-on-close Job, so the headless CLI ends with its Engine:
    // no process of the old owner overlaps the successor.
    spawnSync('taskkill', ['/PID', String(a.pid), '/F'], { windowsHide: true });
    await a.exited;
    assert.equal(isAlive(a.pid), false);
    await until(() => !isAlive(cli.pid), 'the dead owner\'s CLI to end with it', 15_000);
    assert.deepEqual(marker(root), staleMarker, 'the killed owner\'s marker remains');
    b = startEngine(root, 'B');
    assert.equal((await outcome(b)).state, 'ready', b.stderr);
    assert.equal(marker(root).pid, b.pid, 'the successor replaced the stale marker');
    assert.equal(await settled(b, runId), 'interrupted', 'the successor\'s recovery settles the dead owner\'s Run under the existing restart policy');
    const next = await dispatch(b, { workspaceId: 'ws-b', cwd: join(root, 'work-b'), model: 'fixture-echo' });
    assert.equal(await settled(b, next), 'succeeded');
    evidence.cases['RL-FIX-03'] = { killedOwner: a.pid, survivingCli: cli, staleMarkerPid: staleMarker.pid, successor: b.pid, successorCreated: processIdentity(b.pid),
      cliEndedWithOwner: true, recoveredRun: 'interrupted', newRun: 'succeeded' };
  } finally {
    if (b) await stopEngine(b);
    // A CLI of this test that is still the same process is stopped here; anything else is left alone.
    if (cli && isAlive(cli.pid) && processIdentity(cli.pid) === cli.created) spawnSync('taskkill', ['/PID', String(cli.pid), '/T', '/F'], { windowsHide: true });
    remove(root);
  }
});

test('RL-FIX-04 / LCK-07: a graceful shutdown releases ownership and removes its marker; the next Engine starts over the remaining lock database', { timeout: 180_000 }, async () => {
  const root = newRoot('fix04');
  try {
    const a = startEngine(root, 'A');
    assert.equal((await outcome(a)).state, 'ready');
    assert.equal(marker(root).pid, a.pid);
    assert.equal(await stopEngine(a), 'graceful');
    assert.equal(marker(root), null);
    assert.ok(existsSync(`${markerPath(root)}.db`), 'the lock database remains');
    const b = startEngine(root, 'B');
    assert.equal((await outcome(b)).state, 'ready');
    assert.equal(marker(root).pid, b.pid);
    assert.equal(await stopEngine(b), 'graceful');
    assert.equal(marker(root), null);
    evidence.cases['RL-FIX-04'] = { first: a.pid, second: b.pid, markerRemovedOnShutdown: true, lockDatabaseRetained: true };
  } finally { remove(root); }
});

test('RL-FIX-05 / LCK-01 / LCK-02: a crash after taking the lock, before or after the marker, leaves no lasting ownership', { timeout: 180_000 }, async () => {
  const root = newRoot('fix05');
  try {
    const beforeMarker = startEngine(root, 'crash1', { env: { DESZO_RUNNER_LOCK_TEST_FAULT: 'after-ownership' } });
    assert.equal((await outcome(beforeMarker)).exitCode, 97);
    assert.equal(marker(root), null, 'the crash came before the marker');
    assert.equal(existsSync(beforeMarker.connectionFile), false);
    const afterMarker = startEngine(root, 'crash2', { env: { DESZO_RUNNER_LOCK_TEST_FAULT: 'after-marker' } });
    assert.equal((await outcome(afterMarker)).exitCode, 97);
    const stale = marker(root);
    assert.equal(stale.pid, afterMarker.pid, 'the crash came after the marker and before the Engine');
    assert.equal(existsSync(join(root, 'store', 'state.sqlite')), false, 'no Engine was initialized');
    const next = startEngine(root, 'next');
    assert.equal((await outcome(next)).state, 'ready', next.stderr);
    assert.equal(marker(root).pid, next.pid);
    assert.notEqual(marker(root).id, stale.id);
    await stopEngine(next);
    evidence.cases['RL-FIX-05'] = { crashBeforeMarker: { pid: beforeMarker.pid, exitCode: 97, marker: null }, crashAfterMarker: { pid: afterMarker.pid, exitCode: 97, staleMarkerPid: stale.pid },
      successor: next.pid };
  } finally { remove(root); }
});

test('LCK-03: an Engine initialization failure closes the lock and removes its own marker; the root starts once the cause is gone', { timeout: 180_000 }, async () => {
  const root = newRoot('lck03');
  try {
    mkdirSync(join(root, 'store'), { recursive: true });
    writeFileSync(join(root, 'store', 'state.sqlite'), 'this is not a database'.repeat(200));
    const failing = startEngine(root, 'failing');
    const result = await outcome(failing);
    assert.equal(result.state, 'exited');
    assert.notEqual(result.exitCode, 0);
    assert.doesNotMatch(failing.stderr, OWNED);
    assert.equal(marker(root), null, 'the failed owner removed its own marker');
    assert.equal(await contend(markerPath(root)), 'acquired', 'the lock was released');
    unlinkSync(join(root, 'store', 'state.sqlite'));
    const next = startEngine(root, 'next');
    assert.equal((await outcome(next)).state, 'ready', next.stderr);
    await stopEngine(next);
    evidence.cases['LCK-03'] = { failedPid: failing.pid, exitCode: result.exitCode, markerAfterFailure: null, lockReleased: true, successor: next.pid };
  } finally { remove(root); }
});

test('LCK-03b: a failure after initialization (the HTTP listen) shuts the Engine down before the lock is released', { timeout: 120_000 }, async () => {
  const root = newRoot('lck03b');
  const blocker = createServer();
  await new Promise(done => blocker.listen(0, '127.0.0.1', done));
  try {
    const port = blocker.address().port;
    await assert.rejects(startRunner({ root, port, devTestConfirmationOff: true, adapters: fixtureAdapters(join(root, 'fixture-state')), connectionFile: join(root, 'runtime', 'connection.json') }),
      /EADDRINUSE/);
    assert.equal(marker(root), null, 'the failed owner removed its marker');
    assert.doesNotThrow(() => rmSync(join(root, 'store'), { recursive: true }), 'the Engine closed its store: it was shut down');
    assert.equal(await contend(markerPath(root)), 'acquired', 'the lock was released after the shutdown');
    evidence.cases['LCK-03b'] = { listenFailure: 'EADDRINUSE', engineShutDown: true, markerRemoved: true, lockReleased: true };
  } finally { blocker.close(); remove(root); }
});

test('LCK-LEGACY: a live runtime from before this lock, holding only the marker, is not displaced; once it ends, the root starts', { timeout: 120_000 }, async () => {
  const root = newRoot('legacy');
  const legacy = spawn(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(markerPath(root))}, JSON.stringify({ pid: process.pid, id: 'pre-fix-owner' })); setInterval(() => {}, 1000);`],
    { windowsHide: true, stdio: 'ignore' });
  owned.add(legacy.pid);
  const legacyExited = new Promise(done => legacy.once('exit', done));
  try {
    await until(() => marker(root)?.pid === legacy.pid, 'the pre-fix owner\'s marker');
    const before = readFileSync(markerPath(root), 'utf8');
    const refused = startEngine(root, 'refused');
    assert.equal((await outcome(refused)).state, 'exited');
    assert.match(refused.stderr, OWNED);
    assert.equal(readFileSync(markerPath(root), 'utf8'), before, 'the live pre-fix owner\'s marker is not replaced');
    spawnSync('taskkill', ['/PID', String(legacy.pid), '/F'], { windowsHide: true });
    await legacyExited;
    owned.delete(legacy.pid);
    const next = startEngine(root, 'next');
    assert.equal((await outcome(next)).state, 'ready', next.stderr);
    assert.equal(marker(root).pid, next.pid, 'the ended owner\'s marker was replaced');
    await stopEngine(next);
    evidence.cases['LCK-LEGACY'] = { preFixOwner: legacy.pid, refusedWhileAlive: true, startedAfterItEnded: next.pid };
  } finally { if (legacy.exitCode === null) spawnSync('taskkill', ['/PID', String(legacy.pid), '/F'], { windowsHide: true }); remove(root); }
});

test('LCK-REUSE: after an owner crash, a failed start and the reuse of the crashed owner\'s PID, a valid successor still starts', { timeout: 180_000 }, async () => {
  const root = newRoot('reuse');
  // A live process of this test stands in for an unrelated process that was given the crashed owner's PID.
  const reused = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  owned.add(reused.pid);
  const reusedExited = new Promise(done => reused.once('exit', done));
  try {
    const crashed = startEngine(root, 'crashed', { env: { DESZO_RUNNER_LOCK_TEST_FAULT: 'after-marker' } });
    assert.equal((await outcome(crashed)).exitCode, 97);
    const crashedMarker = marker(root);
    const failed = startEngine(root, 'failed', { env: { DESZO_RUNNER_LOCK_TEST_FAULT: 'after-ownership' } });
    assert.equal((await outcome(failed)).exitCode, 97, 'a start that took the lock and ended before writing its marker');
    assert.deepEqual(marker(root), crashedMarker);
    writeFileSync(markerPath(root), JSON.stringify({ ...crashedMarker, pid: reused.pid }));
    const successor = startEngine(root, 'successor');
    assert.equal((await outcome(successor)).state, 'ready', `a marker written by an earlier owner never blocks: ${successor.stderr}`);
    assert.equal(marker(root).pid, successor.pid);
    await stopEngine(successor);
    evidence.cases['LCK-REUSE'] = { crashedOwner: crashed.pid, failedStart: failed.pid, reusedPid: reused.pid, successor: successor.pid };
  } finally {
    spawnSync('taskkill', ['/PID', String(reused.pid), '/F'], { windowsHide: true });
    await reusedExited;
    owned.delete(reused.pid);
    remove(root);
  }
});

test('RL-FIX-06: with the owner\'s marker deleted, a second Engine is still refused', { timeout: 180_000 }, async () => {
  const root = newRoot('fix06');
  let a;
  try {
    a = startEngine(root, 'A');
    assert.equal((await outcome(a)).state, 'ready');
    unlinkSync(markerPath(root));
    const b = startEngine(root, 'B');
    const refused = await outcome(b);
    assert.equal(refused.state, 'exited');
    assert.match(b.stderr, OWNED);
    assert.equal(marker(root), null, 'the refused Engine wrote no marker');
    assert.equal((await api(a, 'GET', '/api/v2/settings')).status, 200, 'the owner keeps serving');
    evidence.cases['RL-FIX-06'] = { owner: a.pid, refused: b.pid, refusedExitCode: refused.exitCode };
  } finally { if (a) await stopEngine(a); remove(root); }
});

test('RL-FIX-07 / LCK-08: a second Engine against an active one is refused before recovery; the owner\'s Run, CLI and marker are untouched', { timeout: 300_000 }, async () => {
  const root = newRoot('fix07');
  let a;
  try {
    a = startEngine(root, 'A');
    assert.equal((await outcome(a)).state, 'ready');
    // The CLI runs 30 s, longer than the refused starts and the checks below take.
    const runId = await dispatch(a, { workspaceId: 'ws-a', cwd: join(root, 'work-a'), model: 'fixture-slow-30' });
    const running = await until(() => { const row = agentAttempt(root, runId); return row?.state === 'running' && row.process_id ? row : null; }, 'A\'s CLI to run');
    const cliCreated = processIdentity(running.process_id);
    const markerBefore = readFileSync(markerPath(root), 'utf8');
    const locksBefore = storeRows(root, 'SELECT resource_key, run_id FROM resource_locks ORDER BY resource_key');
    const contenders = [];
    for (let index = 0; index < 3; index++) {
      const b = startEngine(root, `B${index}`);
      const refused = await outcome(b);
      assert.equal(refused.state, 'exited');
      assert.match(b.stderr, OWNED);
      contenders.push({ pid: b.pid, exitCode: refused.exitCode });
    }
    const during = agentAttempt(root, runId);
    assert.equal(during.state, 'running', 'the owner\'s attempt was not interrupted');
    assert.equal(during.process_id, running.process_id);
    assert.equal(isAlive(running.process_id), true, 'the owner\'s CLI was not killed');
    assert.equal(processIdentity(running.process_id), cliCreated, 'it is the same process');
    assert.deepEqual(storeRows(root, 'SELECT resource_key, run_id FROM resource_locks ORDER BY resource_key'), locksBefore, 'no contender erased the owner\'s resource locks');
    assert.equal(readFileSync(markerPath(root), 'utf8'), markerBefore, 'the marker is unchanged');
    assert.equal((await api(a, 'GET', '/api/v2/settings')).status, 200, 'the owner stays responsive');
    assert.equal(await settled(a, runId), 'succeeded', 'the owner completes its attempt normally');
    const events = storeRows(root, "SELECT event_type, envelope_json FROM journal_events WHERE run_id = ? AND event_type = 'attempt.state_changed'", runId).map(row => JSON.parse(row.envelope_json).payload.to);
    assert.ok(!events.includes('interrupted'), 'no attempt of the Run was ever interrupted');
    evidence.cases['RL-FIX-07'] = { owner: a.pid, runId, cli: running.process_id, cliCreated, refusedDuringRun: contenders, finalState: 'succeeded', resourceLocksDuringRun: locksBefore.length };
  } finally { if (a) await stopEngine(a); remove(root); }
});

test('LOCK-ALIAS: the same root named through a junction or in another letter case is the same lock', { timeout: 180_000 }, async () => {
  const root = newRoot('alias');
  const alias = join(testsRoot, `runner-lock-alias-${randomUUID().slice(0, 8)}`);
  let a;
  try {
    a = startEngine(root, 'A');
    assert.equal((await outcome(a)).state, 'ready');
    retargetJunction(alias, root);
    const viaAlias = startEngine(alias, 'alias');
    assert.equal((await outcome(viaAlias)).state, 'exited');
    assert.match(viaAlias.stderr, OWNED);
    const upper = root.toUpperCase();
    const viaCase = startEngine(upper, 'case');
    assert.equal((await outcome(viaCase)).state, 'exited');
    assert.match(viaCase.stderr, OWNED);
    evidence.cases['LOCK-ALIAS'] = { owner: a.pid, junctionRefused: true, caseVariantRefused: true };
  } finally { if (a) await stopEngine(a); if (existsSync(alias)) rmSync(alias, { recursive: true, force: true }); remove(root); }
});

test('RL-FIX-10: exclusivity does not depend on Process Custody; with Custody on, the refused Engine never attaches, so the owner keeps the Host epoch', { timeout: 420_000 }, async () => {
  // Without Custody: every Engine test above runs with DESZO_PROCESS_CUSTODY removed. With Custody: one Host, an owner running a Host-owned CLI.
  buildArtifacts();
  const root = newRoot('fix10');
  const host = await startCustodyHost(root);
  owned.add(host.pid);
  const custody = { address: host.address, capability: host.capability, generation: host.generation };
  let a;
  try {
    a = startEngine(root, 'A', { custody });
    assert.equal((await outcome(a)).state, 'ready', a.stderr);
    const runId = await dispatch(a, { workspaceId: 'ws-a', cwd: join(root, 'work-a'), model: 'custody-steady', requestText: '[ticks=16]' });
    await until(() => { const row = agentAttempt(root, runId); return row?.state === 'running' && row.process_id ? row : null; }, 'the Host-owned CLI to run');
    const epochFile = join(host.state, 'custody', 'epoch.json');
    const epochBefore = JSON.parse(readFileSync(epochFile, 'utf8')).epoch;
    const b = startEngine(root, 'B', { custody });
    assert.equal((await outcome(b)).state, 'exited');
    assert.match(b.stderr, OWNED);
    assert.equal(JSON.parse(readFileSync(epochFile, 'utf8')).epoch, epochBefore, 'the refused Engine never attached to the Host');
    assert.equal(await settled(a, runId, 120_000), 'succeeded');
    assert.equal(readInvocations(join(root, 'fixture-A')).length, 1, 'one launch');
    evidence.cases['RL-FIX-10'] = { withoutCustody: 'every other Engine test', withCustody: { owner: a.pid, refused: b.pid, epoch: epochBefore, finalState: 'succeeded', launches: 1 } };
  } finally {
    if (a) await stopEngine(a);
    await host.shutdown().catch(() => host.crash());
    owned.delete(host.pid);
    remove(root);
  }
});
