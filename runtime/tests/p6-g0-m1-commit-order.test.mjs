// P6-HOST-M1 native regression: the switch worker's commit and the Host's own shutdown must share one ordering. The worker parks at a
// debug-only barrier between its candidate checks and its commit, so each scenario sequences the Host's shutdown or the candidate's
// death against the worker's position without a sleep. The unfixed Host commits a known-dead or shutdown-stopped candidate in
// M1-A and M1-B; the fixed Host refuses those commits and keeps the selection on the previous Engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eventually, exited } from './custody-support.mjs';
import { ownedDir, testsRoot } from './test-roots.mjs';
import { ENGINE_A, ENGINE_B, activeSelector, engineSources, hostDigest, hostEvents, installEngines, installShell,
  lifecycleState, processAlive, startShellHost } from './p6-g0-support.mjs';

async function requestSwitch(connection, body) {
  const response = await fetch(`http://127.0.0.1:${connection.port}/api/v4/lifecycle/engine-switch`, { method: 'POST',
    headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000) });
  return { status: response.status, body: await response.json().catch(() => null) };
}

// One installation with the stable Shell, Engine A selected and the exact Engine B staged beside it.
async function stageInstallation(root) {
  const installation = join(root, 'installation');
  installShell(installation);
  const sources = await engineSources(join(root, 'sources'), { variant: 'marker' });
  const { bRoot } = await installEngines(installation, sources, { stageB: true, testFaultHooks: true });
  return { installation, profile: join(root, 'profile'), packageSha256: hostDigest(bRoot) };
}

const count = (installation, type) => hostEvents(installation).filter(event => event.type === type).length;
const barrierDirectory = root => { const directory = join(root, 'barrier'); mkdirSync(directory, { recursive: true }); return directory; };
const release = (directory, point) => writeFileSync(join(directory, `resume-${point}`), 'resume');

// The candidate's own managed application process, as the Host recorded it when it spawned B.
const candidateApplicationPid = installation => hostEvents(installation).filter(event => event.type === 'application_spawned'
  && event.payload?.buildId === ENGINE_B).at(-1).payload.applicationPid;

test('P6-HOST-M1-A: a Host shutdown accepted before the commit prevents the commit; the previous Engine stays selected', { timeout: 40 * 60_000 }, async () => {
  const root = ownedDir(join(testsRoot, 'p6-g0-m1-a-'));
  const { installation, profile, packageSha256 } = await stageInstallation(root);
  const barriers = barrierDirectory(root);
  const operationId = randomUUID();
  const host = startShellHost({ root, installation, profile, initialBuildId: ENGINE_A, testSwitchBarrierDir: barriers });
  try {
    const connectionA = await host.engineConnection(ENGINE_A);
    const accepted = await requestSwitch(connectionA, { operationId, targetEngineBuildId: ENGINE_B, packageSha256 });
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
    // The worker has passed B's preflight and the package check; B is alive at the barrier, just before the commit decision.
    await eventually(() => existsSync(join(barriers, 'reached-pre_commit')), 'the switch worker to park before its commit', 20 * 60_000, 100);
    host.child.stdin.write('shutdown\n');
    await eventually(() => count(installation, 'host_shutdown_requested') > 0, 'the Host to accept its shutdown', 60_000, 50);
    release(barriers, 'pre_commit');
    await eventually(() => exited(host.child), 'the Host to stop', 5 * 60_000, 100);
  } finally {
    if (!exited(host.child)) host.child.kill();
  }
  // The shutdown won the ordering: no commit happened and the selector still names A.
  assert.equal(count(installation, 'engine_switch_committed'), 0, 'the candidate was not committed after the shutdown');
  assert.equal(activeSelector(installation).buildId, ENGINE_A, 'the previous Engine stays the selected release');
  assert.notEqual(lifecycleState(installation).engineOperation?.phase, 'verified', 'the switch does not report successful activation');
  // Restart reconciliation: the pre-commit operation rolls back to the selected previous Engine, which serves again.
  const restarted = startShellHost({ root, installation, profile, initialBuildId: ENGINE_A });
  try {
    const connection = await restarted.engineConnection(ENGINE_A);
    assert.equal(connection.applicationBuildId, ENGINE_A);
    assert.equal(activeSelector(installation).buildId, ENGINE_A);
  } finally {
    await restarted.stop();
  }
});

test('P6-HOST-M1-B: a candidate that exits before the commit is never committed; the switch falls back to the previous Engine', { timeout: 40 * 60_000 }, async () => {
  const root = ownedDir(join(testsRoot, 'p6-g0-m1-b-'));
  const { installation, profile, packageSha256 } = await stageInstallation(root);
  const barriers = barrierDirectory(root);
  const operationId = randomUUID();
  const host = startShellHost({ root, installation, profile, initialBuildId: ENGINE_A, testSwitchBarrierDir: barriers });
  try {
    const connectionA = await host.engineConnection(ENGINE_A);
    const accepted = await requestSwitch(connectionA, { operationId, targetEngineBuildId: ENGINE_B, packageSha256 });
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
    await eventually(() => existsSync(join(barriers, 'reached-pre_commit')), 'the switch worker to park before its commit', 20 * 60_000, 100);
    // The candidate dies while the worker is parked: the Host's record of B is no longer a running Engine.
    const pid = candidateApplicationPid(installation);
    process.kill(pid);
    await eventually(() => !processAlive(pid), 'the candidate process to exit', 60_000, 100);
    release(barriers, 'pre_commit');
    // The fixed worker refuses the dead candidate and falls back; the previous Engine serves again.
    await eventually(() => count(installation, 'engine_switch_rolled_back') > 0 || count(installation, 'engine_switch_held') > 0,
      'the switch to settle after the refused commit', 10 * 60_000, 200);
  } finally {
    host.child.kill();
  }
  assert.equal(count(installation, 'engine_switch_committed'), 0, 'a candidate that died before the commit is never committed');
  assert.equal(activeSelector(installation).buildId, ENGINE_A, 'the selection stays on the previous Engine');
  const operation = lifecycleState(installation).engineOperation;
  assert.equal(operation.phase, 'rolled_back', 'the refused commit falls back exactly once');
  assert.equal(operation.fallbackAttempted, true);
});

test('P6-HOST-M1-C: a commit that wins before the shutdown stays selected; the shutdown is postcommit and restart reconciles B', { timeout: 40 * 60_000 }, async () => {
  const root = ownedDir(join(testsRoot, 'p6-g0-m1-c-'));
  const { installation, profile, packageSha256 } = await stageInstallation(root);
  const barriers = barrierDirectory(root);
  const operationId = randomUUID();
  const host = startShellHost({ root, installation, profile, initialBuildId: ENGINE_A, testSwitchBarrierDir: barriers });
  try {
    const connectionA = await host.engineConnection(ENGINE_A);
    const accepted = await requestSwitch(connectionA, { operationId, targetEngineBuildId: ENGINE_B, packageSha256 });
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
    // The commit is already recorded: the selector names B. The shutdown now arrives before the worker's readiness wait.
    await eventually(() => existsSync(join(barriers, 'reached-post_commit')), 'the switch worker to reach the post-commit barrier', 20 * 60_000, 100);
    assert.equal(activeSelector(installation).buildId, ENGINE_B, 'the commit is recorded before the shutdown');
    host.child.stdin.write('shutdown\n');
    await eventually(() => count(installation, 'host_shutdown_requested') > 0, 'the Host to accept its shutdown', 60_000, 50);
    release(barriers, 'post_commit');
    await eventually(() => exited(host.child), 'the Host to stop', 5 * 60_000, 100);
  } finally {
    if (!exited(host.child)) host.child.kill();
  }
  assert.equal(activeSelector(installation).buildId, ENGINE_B, 'the committed candidate stays selected: no automatic rollback');
  assert.equal(lifecycleState(installation).engineOperation.fallbackAttempted, false, 'no postcommit fallback ran');
  // Restart reconciles the committed B: it starts, the previous Engine does not.
  const restarted = startShellHost({ root, installation, profile, initialBuildId: ENGINE_A });
  try {
    const connection = await restarted.engineConnection(ENGINE_B);
    assert.equal(connection.applicationBuildId, ENGINE_B);
    const spawned = hostEvents(installation).filter(event => event.type === 'application_spawned').map(event => event.payload.buildId);
    assert.equal(spawned.at(-1), ENGINE_B, 'after restart only the committed Engine is started');
  } finally {
    await restarted.stop();
  }
});

test('P6-HOST-M1-D: a shutdown accepted before the candidate is spawned starts no candidate; the previous Engine restarts once on the next Host start', { timeout: 40 * 60_000 }, async () => {
  const root = ownedDir(join(testsRoot, 'p6-g0-m1-d-'));
  const { installation, profile, packageSha256 } = await stageInstallation(root);
  const barriers = barrierDirectory(root);
  const operationId = randomUUID();
  const host = startShellHost({ root, installation, profile, initialBuildId: ENGINE_A, testSwitchBarrierDir: barriers });
  try {
    const connectionA = await host.engineConnection(ENGINE_A);
    const accepted = await requestSwitch(connectionA, { operationId, targetEngineBuildId: ENGINE_B, packageSha256 });
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
    // The previous Engine has stopped and the worker is about to start the candidate's preflight: the shutdown arrives first.
    await eventually(() => existsSync(join(barriers, 'reached-pre_candidate_spawn')), 'the switch worker to park before the candidate spawn', 20 * 60_000, 100);
    host.child.stdin.write('shutdown\n');
    await eventually(() => count(installation, 'host_shutdown_requested') > 0, 'the Host to accept its shutdown', 60_000, 50);
    release(barriers, 'pre_candidate_spawn');
    await eventually(() => exited(host.child), 'the Host to stop', 5 * 60_000, 100);
  } finally {
    if (!exited(host.child)) host.child.kill();
  }
  const shutdownAt = Number(hostEvents(installation).find(event => event.type === 'host_shutdown_requested').at);
  const candidateSpawnsAfterShutdown = hostEvents(installation).filter(event => event.type === 'application_spawned'
    && event.payload?.buildId === ENGINE_B && Number(event.at) >= shutdownAt);
  assert.equal(candidateSpawnsAfterShutdown.length, 0, 'no candidate is spawned once the Host shutdown is accepted');
  assert.equal(count(installation, 'engine_switch_committed'), 0, 'no commit happens');
  assert.equal(activeSelector(installation).buildId, ENGINE_A, 'the previous Engine stays selected');
  const restarted = startShellHost({ root, installation, profile, initialBuildId: ENGINE_A });
  try {
    const connection = await restarted.engineConnection(ENGINE_A);
    assert.equal(connection.applicationBuildId, ENGINE_A);
  } finally {
    await restarted.stop();
  }
});
