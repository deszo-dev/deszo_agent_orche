// P6-G0-FINAL C09: a switch whose Engine A tree cannot be proven ended holds. The uncertainty is controlled at the Job's
// emptiness answer, after the real termination ran (a debug-only seam). The Host's own hold and its restart proof are the code
// under test. Nothing starts a second Engine, nothing commits, and progress waits for fresh proof of the recorded instance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildArtifacts, eventually, exited } from './custody-support.mjs';
import { ownedDir, testsRoot } from './test-roots.mjs';
import { ENGINE_A, ENGINE_B, activeSelector, engineSources, fileSha256, freshDescriptor, hostDigest, hostEvents, installEngines,
  installShell, processAlive, recordEvidence, startShellHost } from './p6-g0-support.mjs';

async function requestSwitch(connection, body) {
  const response = await fetch(`http://127.0.0.1:${connection.port}/api/v4/lifecycle/engine-switch`, { method: 'POST',
    headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000) });
  return { status: response.status, body: await response.json().catch(() => null) };
}

// The Host's durable P6 operation record (lifecycle.json under the installation's Host state).
function lifecycleState(installation) {
  const profileStates = join(installation, '.deszo-host', 'profiles');
  const key = readdirSync(profileStates)[0];
  return JSON.parse(readFileSync(join(profileStates, key, 'lifecycle.json'), 'utf8'));
}

const spawns = installation => hostEvents(installation).filter(event => event.type === 'application_spawned');
const spawnedBuilds = installation => spawns(installation).map(event => event.payload.buildId);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Shared setup: one Shell, Engine A selected, Engine B staged, and a switch whose Engine A tree cannot be proven ended.
async function holdUnprovenSwitch(name) {
  const root = ownedDir(join(testsRoot, name));
  const { hostExe } = buildArtifacts();
  const installation = join(root, 'installation');
  installShell(installation);
  const shellBefore = fileSha256(join(installation, 'shell', 'deszo.exe'));
  const hostBefore = fileSha256(hostExe);
  const sources = await engineSources(join(root, 'sources'), { variant: 'marker' });
  const { bRoot } = await installEngines(installation, sources, { stageB: true, testFaultHooks: true });
  const profile = join(root, 'profile');
  const operationId = randomUUID();
  const packageSha256 = hostDigest(bRoot);

  const host = startShellHost({ root, installation, profile, initialBuildId: ENGINE_A, testTerminationUncertain: true });
  const connectionA = await host.engineConnection(ENGINE_A);
  const accepted = await requestSwitch(connectionA, { operationId, targetEngineBuildId: ENGINE_B, packageSha256 });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
  await eventually(() => hostEvents(installation).some(event => event.type === 'engine_switch_held'), 'the unproven switch to hold', 300_000, 200);
  const expectedPid = spawns(installation).find(event => event.payload.buildId === ENGINE_A).payload.applicationPid;
  return { root, installation, profile, host, connectionA, operationId, packageSha256, expectedPid, shellBefore, hostBefore, hostExe };
}

test('P6-G0 C09: an unproven Engine A tree holds the switch with no second Engine, no commit and a durable process record', { timeout: 30 * 60_000 }, async () => {
  const held = await holdUnprovenSwitch('p6-g0-c09-hold-');
  try {
    // The Host attempted the real termination, withheld its emptiness proof, and recorded the instance it could not prove ended.
    const unproven = hostEvents(held.installation).find(event => event.type === 'managed_process_termination_unproven');
    assert.ok(unproven, 'the Host records the unproven termination');
    assert.equal(unproven.payload.processId, held.expectedPid, 'the record names Engine A\'s managed process instance');
    assert.equal(unproven.payload.injected, true, 'the record states that the debug seam withheld the proof');
    assert.equal(typeof unproven.payload.processCreationTime, 'number', 'the instance carries a creation time for later proof');

    // Durable hold: the operation names the same instance, and nothing advanced past the hold.
    const operation = lifecycleState(held.installation).engineOperation;
    assert.equal(operation.phase, 'held');
    assert.equal(operation.terminationUnproven.processId, held.expectedPid);
    assert.match(operation.failure, /could not be proven ended/);

    // No ordinary Engine B starts, no second Engine A starts, and the selector never names B.
    assert.deepEqual(spawnedBuilds(held.installation), [ENGINE_A], 'only the original Engine A was ever launched');
    assert.equal(hostEvents(held.installation).some(event => event.type === 'engine_switch_committed'), false, 'no commit is recorded');
    const selector = activeSelector(held.installation);
    assert.equal(selector.buildId, ENGINE_A);
    assert.equal(selector.committedOperationId, undefined, 'the selector was never written for this operation');

    // The Host kept its containment: no relaunch happens while the hold stands.
    await pause(3_000);
    assert.deepEqual(spawnedBuilds(held.installation), [ENGINE_A], 'a held switch relaunches nothing');

    // Native outcome, recorded separately from the Host's decision: the real termination ended the process.
    assert.equal(processAlive(held.expectedPid), false, 'the process instance is not alive after the real termination');

    // The Shell and the Host are unchanged by the hold.
    assert.equal(fileSha256(join(held.installation, 'shell', 'deszo.exe')), held.shellBefore, 'the Shell is unchanged');
    assert.equal(fileSha256(held.hostExe), held.hostBefore, 'the Host is unchanged');
    recordEvidence('c09-native-hold', { operationId: held.operationId, processId: held.expectedPid,
      processCreationTime: unproven.payload.processCreationTime, injected: unproven.payload.injected,
      operation: { phase: operation.phase, terminationUnprovenProcessId: operation.terminationUnproven.processId, failure: operation.failure },
      launches: spawnedBuilds(held.installation),
      committedRecorded: hostEvents(held.installation).some(event => event.type === 'engine_switch_committed'),
      selector: { buildId: selector.buildId, committedOperationId: selector.committedOperationId ?? null },
      processAliveAfterRealTermination: processAlive(held.expectedPid),
      shellSha256: { before: held.shellBefore, after: fileSha256(join(held.installation, 'shell', 'deszo.exe')) },
      hostSha256: { before: held.hostBefore, after: fileSha256(held.hostExe) } });
  } finally {
    await held.host.stop();
  }
});

test('P6-G0 C09 restart: a restarted Host without fresh proof holds, and with fresh proof it abandons the switch and restarts exactly Engine A', { timeout: 60 * 60_000 }, async () => {
  const held = await holdUnprovenSwitch('p6-g0-c09-restart-');
  await held.host.stop();
  const { installation, profile, operationId, packageSha256, expectedPid, connectionA } = held;
  let withoutProof;

  // Restart with the proof withheld: the recorded instance is not proven ended, so the Host starts no Engine.
  const unprovenRestart = startShellHost({ root: held.root, installation, profile, initialBuildId: ENGINE_A, testProofUncertain: true });
  try {
    await eventually(() => hostEvents(installation).some(event => event.type === 'engine_start_held'), 'the held restart to refuse to start an Engine', 180_000, 200);
    const state = lifecycleState(installation).engineOperation;
    assert.equal(state.phase, 'held', 'the restart does not erase the hold');
    assert.equal(state.terminationUnproven.processId, expectedPid, 'the recorded instance survives the restart');
    assert.equal(hostEvents(installation).some(event => event.type === 'engine_termination_proven'), false, 'no proof is recorded without fresh proof');
    assert.deepEqual(spawnedBuilds(installation), [ENGINE_A], 'a restart without proof launches no Engine');
    withoutProof = { phase: state.phase, launches: spawnedBuilds(installation) };
  } finally {
    await unprovenRestart.stop();
  }

  // Restart with fresh proof: the recorded instance is gone, so the Host proves the tree ended, abandons the switch and restarts A.
  const proven = startShellHost({ root: held.root, installation, profile, initialBuildId: ENGINE_A });
  try {
    await eventually(() => hostEvents(installation).some(event => event.type === 'engine_termination_proven'), 'the fresh proof', 300_000, 200);
    const restarted = await freshDescriptor(profile, ENGINE_A, connectionA.runtimeInstanceId);
    assert.equal(restarted.applicationBuildId, ENGINE_A, 'the committed Engine A restarts');
    assert.notEqual(restarted.runtimeInstanceId, connectionA.runtimeInstanceId, 'the restarted Engine A is a new instance');

    const builds = spawnedBuilds(installation);
    assert.deepEqual(builds, [ENGINE_A, ENGINE_A], 'exactly one launch of A after the original, and no Engine B');
    assert.notEqual(spawns(installation)[1].payload.applicationPid, expectedPid, 'the restarted Engine A is a different process');
    const state = lifecycleState(installation).engineOperation;
    assert.equal(state.phase, 'abandoned', 'the switch is abandoned, not committed');
    assert.match(state.failure, /proved the previous Engine's process tree ended/);
    assert.equal(activeSelector(installation).buildId, ENGINE_A, 'the selector still names Engine A');
    assert.equal(activeSelector(installation).committedOperationId, undefined, 'no commit was written');

    // No candidate substitution: the held operation cannot be completed with a different package under the same identity.
    const substituted = await requestSwitch(restarted, { operationId, targetEngineBuildId: ENGINE_B, packageSha256: 'f'.repeat(64) });
    assert.notEqual(substituted.status, 202, 'a different package cannot take over the operation');
    assert.equal(spawnedBuilds(installation).filter(id => id === ENGINE_B).length, 0, 'Engine B was never launched');

    // The restarted Engine A serves its own store.
    const served = await fetch(`http://127.0.0.1:${restarted.port}/api/v2/settings`, { headers: { Authorization: `Bearer ${restarted.token}` } });
    assert.equal(served.status, 200, 'the restarted Engine A serves');
    recordEvidence('c09-restart-proof', { operationId, recordedProcessId: expectedPid, restartWithoutProof: withoutProof,
      restartWithProof: { phase: state.phase, failure: state.failure, launches: builds, newProcessId: spawns(installation)[1].payload.applicationPid,
        newRuntimeInstanceId: restarted.runtimeInstanceId },
      substitution: { status: substituted.status, engineBLaunches: spawnedBuilds(installation).filter(id => id === ENGINE_B).length },
      selector: { buildId: activeSelector(installation).buildId, committedOperationId: activeSelector(installation).committedOperationId ?? null } });
  } finally {
    await proven.stop();
  }
});

test('P6-G0 C09 crash: a Host killed after the fence leaves an instance it cannot prove ended, and its restart holds with no Engine launched', { timeout: 30 * 60_000 }, async () => {
  const root = ownedDir(join(testsRoot, 'p6-g0-c09-crash-'));
  const installation = join(root, 'installation');
  installShell(installation);
  const sources = await engineSources(join(root, 'sources'), { variant: 'marker' });
  const { bRoot } = await installEngines(installation, sources, { stageB: true, testFaultHooks: true });
  const packageSha256 = hostDigest(bRoot);
  const profile = join(root, 'profile');
  const operationId = randomUUID();

  // The Host exits at the crash point right after it takes the fence, before any stop begins. The request ends with the connection.
  const crashed = startShellHost({ root, installation, profile, initialBuildId: ENGINE_A, testSwitchCrashAt: 'after_fenced' });
  const connectionA = await crashed.engineConnection(ENGINE_A);
  const expectedPid = spawns(installation).find(event => event.payload.buildId === ENGINE_A).payload.applicationPid;
  await requestSwitch(connectionA, { operationId, targetEngineBuildId: ENGINE_B, packageSha256 }).catch(() => null);
  await eventually(() => exited(crashed.child), 'the crashed Host to exit', 120_000, 100);
  assert.equal(lifecycleState(installation).engineOperation.stopping.processId, expectedPid, 'the fence recorded the instance it will stop');

  // Restart with the proof withheld: the Host cannot prove the recorded instance ended, so it launches no Engine and holds.
  const held = startShellHost({ root, installation, profile, initialBuildId: ENGINE_A, testProofUncertain: true });
  try {
    await eventually(() => hostEvents(installation).some(event => event.type === 'engine_start_held'), 'the held restart to refuse to start an Engine', 180_000, 200);
    const state = lifecycleState(installation).engineOperation;
    assert.equal(state.phase, 'held');
    assert.equal(state.terminationUnproven.processId, expectedPid, 'the hold names the instance the fence was taken for');
    assert.deepEqual(spawnedBuilds(installation), [ENGINE_A], 'no Engine is launched beside the unproven instance');
    assert.equal(activeSelector(installation).buildId, ENGINE_A, 'the selector still names Engine A');
    recordEvidence('c09-crash-restart', { operationId, crashPoint: 'after_fenced', crashedHostExitCode: crashed.child.exitCode,
      recordedStoppingProcessId: expectedPid,
      restart: { phase: state.phase, terminationUnprovenProcessId: state.terminationUnproven.processId, launches: spawnedBuilds(installation) },
      selector: { buildId: activeSelector(installation).buildId, committedOperationId: activeSelector(installation).committedOperationId ?? null } });
  } finally {
    await held.stop();
  }
});
