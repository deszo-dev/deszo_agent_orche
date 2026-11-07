// P6-G0 M2-M3 native proof: the active Engine A stages the exact Engine B, the Host fences Custody, stops A, guards the
// production Store, runs B's maintenance preflight on a disposable copy, commits B with one selector write, and B serves.
// A candidate that fails before its commit is stopped, and the exact previous Engine is restored exactly once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildArtifacts, eventually } from './custody-support.mjs';
import { ownedDir, testsRoot } from './test-roots.mjs';
import { ENGINE_A, ENGINE_B, activeSelector, engineSources, fileSha256, freshDescriptor, hostDigest, hostEvents, installEngines,
  installShell, processAlive, readProfileDb, recordEvidence, startShellHost } from './p6-g0-support.mjs';

async function requestSwitch(connection, body) {
  const response = await fetch(`http://127.0.0.1:${connection.port}/api/v4/lifecycle/engine-switch`, { method: 'POST',
    headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000) });
  return { status: response.status, body: await response.json().catch(() => null) };
}


const eventIndex = (installation, type) => hostEvents(installation).findIndex(event => event.type === type);
const spawnedBuilds = installation => hostEvents(installation).filter(event => event.type === 'application_spawned').map(event => event.payload.buildId);

// The Host's durable P6 operation record (lifecycle.json under the profile's state owner).
function lifecycleState(installation) {
  const profileStates = join(installation, '.deszo-host', 'profiles');
  const key = readdirSync(profileStates)[0];
  return JSON.parse(readFileSync(join(profileStates, key, 'lifecycle.json'), 'utf8'));
}

test('P6-G0 switch: Engine A stages B, the Host switches A to B, B serves, and A is not running afterwards', { timeout: 45 * 60_000 }, async () => {
  const root = ownedDir(join(testsRoot, 'p6-g0-switch-'));
  const { hostExe } = buildArtifacts();
  const installation = join(root, 'installation');
  installShell(installation);
  const shellBefore = fileSha256(join(installation, 'shell', 'deszo.exe'));
  const hostBefore = fileSha256(hostExe);
  const sources = await engineSources(join(root, 'sources'), { variant: 'marker' });
  const { bRoot } = await installEngines(installation, sources, { stageB: true, testFaultHooks: true });
  const packageSha256 = hostDigest(bRoot);
  const profile = join(root, 'profile');
  const operationId = randomUUID();

  let committedInstance = null;
  const host = startShellHost({ root, installation, profile, initialBuildId: ENGINE_A });
  try {
    const connectionA = await host.engineConnection(ENGINE_A);
    const runA = hostEvents(installation).filter(event => event.type === 'engine_ready').at(-1).payload;
    assert.equal(connectionA.applicationBuildId, ENGINE_A);
    assert.equal(connectionA.engineMarker, undefined, 'Engine A carries no Engine-only marker');

    // Engine A accepts the owner's request: it quiesces, stages B while still selected, and sends the one fixed switch.
    const accepted = await requestSwitch(connectionA, { operationId, targetEngineBuildId: ENGINE_B, packageSha256 });
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
    assert.equal(accepted.body.accepted, true);
    assert.equal(accepted.body.operationId, operationId);

    await eventually(() => hostEvents(installation).some(event => event.type === 'engine_switch_verified'),
      'the committed Engine B to become ready', 600_000, 200);
    const connectionB = await freshDescriptor(profile, ENGINE_B, connectionA.runtimeInstanceId);
    committedInstance = connectionB.runtimeInstanceId;
    assert.equal(connectionB.engineMarker, 'engine-b', 'the Host now runs the Engine-only difference');

    // The journal orders the protocol: stage, fenced switch, the candidate's preflight, the boundary check, the commit, readiness.
    const types = ['engine_staged', 'engine_switch_accepted', 'engine_preflight_passed', 'engine_store_boundary_verified',
      'engine_switch_committed', 'engine_switch_verified'];
    const indices = types.map(type => eventIndex(installation, type));
    indices.forEach((index, position) => assert.ok(index >= 0, `the journal records ${types[position]}`));
    assert.deepEqual([...indices].sort((x, y) => x - y), indices, 'the switch events occur in protocol order');

    // Exactly one selector write names B and this operation.
    const selector = activeSelector(installation);
    assert.equal(selector.buildId, ENGINE_B);
    assert.equal(selector.committedOperationId, operationId);

    // The durable operation is verified; B preflighted exactly the copy the Host made; no fallback ran.
    const operation = lifecycleState(installation).engineOperation;
    assert.equal(operation.phase, 'verified');
    assert.equal(operation.fallbackAttempted, false);
    const copied = operation.storeEvidence.copiedFiles.find(file => file.name === 'state.sqlite');
    assert.equal(operation.preflight.copySha256, copied.sha256, 'B preflighted exactly the disposable copy the Host made');
    assert.equal(operation.preflight.engineBuildId, ENGINE_B);
    assert.ok(existsSync(join(installation, '.deszo-host', 'p6', operationId, 'preflight', 'state.sqlite')), 'the disposable copy is kept as evidence');

    // Engine A's tree ended before the Store boundary; Engine B is the single running ordinary Engine.
    assert.equal(processAlive(runA.enginePid), false, 'Engine A is not running after the switch');
    const runB = hostEvents(installation).filter(event => event.type === 'engine_ready').at(-1).payload;
    assert.equal(runB.buildId, ENGINE_B);
    assert.equal(processAlive(runB.enginePid), true, 'Engine B is running');

    // The Shell and the Host are the same bytes after the switch as before it.
    assert.equal(fileSha256(join(installation, 'shell', 'deszo.exe')), shellBefore, 'the Shell executable is unchanged');
    assert.equal(fileSha256(hostExe), hostBefore, 'the Host executable is unchanged');

    // Engine B serves the owner API on the same store.
    const served = await fetch(`http://127.0.0.1:${connectionB.port}/api/v2/settings`, { headers: { Authorization: `Bearer ${connectionB.token}` } });
    assert.equal(served.status, 200, 'Engine B serves the owner API after the commit');
    assert.equal(typeof readProfileDb(profile, 'SELECT COUNT(*) AS count FROM runs')[0].count, 'number');
    recordEvidence('switch', { operationId, packageSha256,
      engineA: { applicationBuildId: ENGINE_A, enginePid: runA.enginePid, packageSha256: hostDigest(join(installation, 'versions', ENGINE_A)) },
      engineB: { applicationBuildId: ENGINE_B, enginePid: runB.enginePid, runtimeInstanceId: connectionB.runtimeInstanceId, packageSha256 },
      selector: { buildId: selector.buildId, committedOperationId: selector.committedOperationId },
      operation: { phase: operation.phase, fallbackAttempted: operation.fallbackAttempted, preflightCopySha256: operation.preflight.copySha256 },
      journalOrder: types.map((type, position) => ({ type, index: indices[position] })),
      shellSha256: { before: shellBefore, after: fileSha256(join(installation, 'shell', 'deszo.exe')) },
      hostSha256: { before: hostBefore, after: fileSha256(hostExe) } });
  } finally {
    await host.stop();
  }

  // A Host restart reconciles the committed selection: B starts and the restarted Host never launches A.
  const restarted = startShellHost({ root, installation, profile, initialBuildId: ENGINE_A });
  try {
    const again = await freshDescriptor(profile, ENGINE_B, committedInstance);
    assert.equal(again.engineMarker, 'engine-b');
    const builds = spawnedBuilds(installation);
    assert.equal(builds.at(-1), ENGINE_B, 'the restarted Host launches the committed Engine');
    assert.equal(builds.indexOf(ENGINE_A), 0, 'A ran only before the switch');
  } finally {
    await restarted.stop();
  }
});

test('P6-G0 switch negative: a candidate that fails before its commit is stopped and the exact previous Engine is restored once', { timeout: 45 * 60_000 }, async () => {
  const root = ownedDir(join(testsRoot, 'p6-g0-switch-fail-'));
  const { hostExe } = buildArtifacts();
  const installation = join(root, 'installation');
  installShell(installation);
  const hostBefore = fileSha256(hostExe);
  const sources = await engineSources(join(root, 'sources'), { variant: 'failing' });
  const { bRoot } = await installEngines(installation, sources, { stageB: true, testFaultHooks: true });
  const packageSha256 = hostDigest(bRoot);
  const profile = join(root, 'profile');
  const operationId = randomUUID();

  const host = startShellHost({ root, installation, profile, initialBuildId: ENGINE_A });
  try {
    const connectionA = await host.engineConnection(ENGINE_A);
    const accepted = await requestSwitch(connectionA, { operationId, targetEngineBuildId: ENGINE_B, packageSha256 });
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
    await eventually(() => hostEvents(installation).some(event => event.type === 'engine_switch_rolled_back'),
      'the failed candidate to be rolled back to the previous Engine', 600_000, 200);

    const selector = activeSelector(installation);
    assert.equal(selector.buildId, ENGINE_A, 'the previous Engine remains the committed release');
    assert.equal(selector.committedOperationId, undefined, 'no commit was ever written');
    assert.equal(hostEvents(installation).some(event => event.type === 'engine_switch_committed'), false, 'no commit was recorded');
    const operation = lifecycleState(installation).engineOperation;
    assert.equal(operation.phase, 'rolled_back');
    assert.equal(operation.fallbackAttempted, true, 'the single fallback was consumed');

    // The restored Engine A serves again on its own store.
    const restored = await freshDescriptor(profile, ENGINE_A, connectionA.runtimeInstanceId);
    assert.equal(restored.engineMarker, undefined);
    const served = await fetch(`http://127.0.0.1:${restored.port}/api/v2/settings`, { headers: { Authorization: `Bearer ${restored.token}` } });
    assert.equal(served.status, 200, 'the restored Engine A serves');
    assert.equal(fileSha256(hostExe), hostBefore, 'the Host executable is unchanged');
    const builds = spawnedBuilds(installation);
    assert.equal(builds.filter(id => id === ENGINE_B).length, 1, 'the candidate was launched once, for its preflight');
    assert.equal(builds.at(-1), ENGINE_A, 'the last launch restored the exact previous Engine');
    recordEvidence('failed-b', { operationId, packageSha256,
      selector: { buildId: selector.buildId, committedOperationId: selector.committedOperationId ?? null },
      operation: { phase: operation.phase, fallbackAttempted: operation.fallbackAttempted },
      launches: builds, restoredBuildId: ENGINE_A,
      hostSha256: { before: hostBefore, after: fileSha256(hostExe) } });
  } finally {
    await host.stop();
  }
});
