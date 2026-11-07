// P6-G0-FINAL recovery evidence with a real interruption. C02: the Host exits inside the staging copy, after the first real file, so
// the incoming directory holds genuine partial bytes. The restarted Host discards them, and the same operation then stages and commits
// Engine B once. C13: after that commit, a retry of the same operation (a lost acknowledgement) returns the committed status, starts
// nothing, commits nothing, and leaves Engine B's admission open.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildArtifacts, eventually, exited } from './custody-support.mjs';
import { ownedDir, testsRoot } from './test-roots.mjs';
import { ENGINE_A, ENGINE_B, activeSelector, engineSources, fileSha256, freshDescriptor, hostDigest, hostEvents, installEngines, installShell,
  lifecycleState, probeEngine, recordEvidence, startShellHost } from './p6-g0-support.mjs';

async function requestSwitch(connection, body) {
  const response = await fetch(`http://127.0.0.1:${connection.port}/api/v4/lifecycle/engine-switch`, { method: 'POST',
    headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(600_000) });
  return { status: response.status, body: await response.json().catch(() => null) };
}

// Every file beneath a directory, so partial copies can be counted against the whole package.
function filesUnder(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

const spawnedBuilds = installation => hostEvents(installation).filter(event => event.type === 'application_spawned').map(event => event.payload.buildId);

test('P6-G0 C02 and C13: a Host killed mid-copy leaves real partial bytes that the restart discards, and a retry after commit starts nothing', { timeout: 60 * 60_000 }, async () => {
  const root = ownedDir(join(testsRoot, 'p6-g0-c02-c13-'));
  const { hostExe } = buildArtifacts();
  const installation = join(root, 'installation');
  installShell(installation);
  const hostBefore = fileSha256(hostExe);
  const sources = await engineSources(join(root, 'sources'), { variant: 'marker' });
  const { bRoot } = await installEngines(installation, sources, { stageB: true, testFaultHooks: true });
  const packageSha256 = hostDigest(bRoot);
  const packageFiles = filesUnder(bRoot).length;
  const profile = join(root, 'profile');
  const operationId = randomUUID();
  const incoming = join(installation, 'versions', `.incoming-${operationId}`);

  // 1. The Host exits inside the staging copy, after the first real file. The incoming directory holds those bytes and no more.
  const crashing = startShellHost({ root, installation, profile, initialBuildId: ENGINE_A, testSwitchCrashAt: 'mid_stage_copy' });
  const connectionA = await crashing.engineConnection(ENGINE_A);
  await requestSwitch(connectionA, { operationId, targetEngineBuildId: ENGINE_B, packageSha256 }).catch(() => null);
  await eventually(() => exited(crashing.child), 'the Host to exit at the mid-copy crash point', 120_000, 100);
  assert.ok(hostEvents(installation).some(event => event.type === 'test_switch_crash_point' && event.payload.point === 'mid_stage_copy'),
    'the Host reached the mid-copy point');
  assert.ok(existsSync(incoming), 'the interrupted copy left its incoming directory');
  const partial = filesUnder(incoming).length;
  assert.ok(partial >= 1 && partial < packageFiles, `the interruption left real partial bytes (${partial} of ${packageFiles} files)`);
  assert.equal(lifecycleState(installation).engineOperation.phase, 'staging', 'the durable record names the interrupted stage');
  assert.equal(activeSelector(installation).buildId, ENGINE_A, 'the selector never moved');

  // 2. The restarted Host discards the partial bytes, restarts Engine A, and the same operation stages and commits Engine B once.
  const restarted = startShellHost({ root, installation, profile, initialBuildId: ENGINE_A, testEngineProbe: true });
  try {
    // The descriptor of the crashed Engine A is still on disk: wait for the restarted Engine's own, which exists only after the reconcile.
    const connectionA2 = await freshDescriptor(profile, ENGINE_A, connectionA.runtimeInstanceId);
    const reconciled = hostEvents(installation).filter(event => event.type === 'engine_operation_reconciled').map(event => event.payload.phase);
    const left = existsSync(incoming) ? filesUnder(incoming).length : 0;
    const profileStates = join(installation, '.deszo-host', 'profiles');
    const records = readdirSync(profileStates).map(key => `${key.slice(0, 8)}:${JSON.parse(readFileSync(join(profileStates, key, 'lifecycle.json'), 'utf8')).engineOperation?.phase ?? 'none'}`);
    const hostStarts = hostEvents(installation).filter(event => event.type === 'host_started').length;
    assert.equal(existsSync(incoming), false, `the restart discards the partial incoming bytes (reconciled phases: ${reconciled.join(',') || 'none'}; files left: ${left}; profile records: ${records.join(' ')}; host starts: ${hostStarts})`);
    const accepted = await requestSwitch(connectionA2, { operationId, targetEngineBuildId: ENGINE_B, packageSha256 });
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
    await eventually(() => hostEvents(installation).some(event => event.type === 'engine_switch_verified'), 'the committed Engine B to become ready', 900_000, 200);
    assert.equal(hostEvents(installation).filter(event => event.type === 'engine_switch_committed').length, 1, 'the same operation commits once');
    assert.equal(activeSelector(installation).buildId, ENGINE_B);
    assert.equal(activeSelector(installation).committedOperationId, operationId);
    assert.equal(spawnedBuilds(installation).filter(id => id === ENGINE_B).length, 1, 'Engine B is launched once for its preflight');

    // 3. C13: the caller's retry after the commit (a lost acknowledgement) starts nothing and commits nothing.
    const connectionB = await freshDescriptor(profile, ENGINE_B, connectionA2.runtimeInstanceId);
    const launchesBefore = spawnedBuilds(installation).length;
    const commitsBefore = hostEvents(installation).filter(event => event.type === 'engine_switch_committed').length;
    const retried = await requestSwitch(connectionB, { operationId, targetEngineBuildId: ENGINE_B, packageSha256 });
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(retried.body.duplicate, true, 'the retry is answered from the recorded operation');
    assert.equal(retried.body.committed, true, 'the caller obtains the committed status');
    assert.equal(retried.body.phase, 'verified', 'the recorded phase is verified');
    assert.equal(spawnedBuilds(installation).length, launchesBefore, 'the retry launches nothing');
    assert.equal(hostEvents(installation).filter(event => event.type === 'engine_switch_committed').length, commitsBefore, 'the retry commits nothing');
    assert.equal(activeSelector(installation).buildId, ENGINE_B, 'the selector is unchanged by the retry');

    // The retry did not keep Engine B quiesced: its admission is open, so the Run barrier admits again.
    const probe = await probeEngine(profile, ENGINE_B, { action: 'quiescence_state' });
    assert.equal(probe.ok, true, JSON.stringify(probe));
    assert.equal(probe.value.active, false, 'the committed Engine admits Runs after a refused retry');

    assert.equal(hostDigest(bRoot), packageSha256, 'the staged package is unchanged');
    assert.equal(fileSha256(hostExe), hostBefore, 'the Host is unchanged');
    recordEvidence('c02-c13', { operationId, packageSha256,
      crash: { point: 'mid_stage_copy', partialFiles: partial, packageFiles, durablePhase: 'staging' },
      restart: { committedCount: hostEvents(installation).filter(event => event.type === 'engine_switch_committed').length,
        selector: { buildId: activeSelector(installation).buildId, committedOperationId: activeSelector(installation).committedOperationId } },
      retry: { status: retried.status, duplicate: retried.body.duplicate, committed: retried.body.committed, phase: retried.body.phase,
        launchesAdded: spawnedBuilds(installation).length - launchesBefore,
        commitsAdded: hostEvents(installation).filter(event => event.type === 'engine_switch_committed').length - commitsBefore },
      admissionOpenAfterRetry: probe.value.active === false,
      hostSha256: { before: hostBefore, after: fileSha256(hostExe) } });
  } finally {
    await restarted.stop();
  }
});
