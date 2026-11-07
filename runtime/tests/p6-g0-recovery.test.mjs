// P6-G0 native recovery matrix. Each case crashes the real Rust Host at one named switch point (a debug-only seam), or changes the
// installation while the Host is down, then starts the real Host again and checks the one authoritative outcome: which Engine is
// selected, how many ordinary Engines ran, whether the Store was touched, and whether anything was committed twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildArtifacts, eventually, exited } from './custody-support.mjs';
import { ownedDir, testsRoot } from './test-roots.mjs';
import { ENGINE_A, ENGINE_B, activeSelector, descriptorInstance, engineSources, freshDescriptor, hostDigest, hostEvents, installEngines,
  installShell, processAlive, startShellHost } from './p6-g0-support.mjs';

const CRASH_EXIT = 86;

async function trigger(connection, body) {
  try {
    const response = await fetch(`http://127.0.0.1:${connection.port}/api/v4/lifecycle/engine-switch`, { method: 'POST',
      headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000) });
    return { status: response.status, body: await response.json().catch(() => null) };
  } catch (error) {
    // The Host may end while the request is in flight; the crash is the expected outcome.
    return { status: 0, error: error.message };
  }
}

function lifecycleState(installation) {
  const key = readdirSync(join(installation, '.deszo-host', 'profiles'))[0];
  return JSON.parse(readFileSync(join(installation, '.deszo-host', 'profiles', key, 'lifecycle.json'), 'utf8'));
}

const builds = installation => hostEvents(installation).filter(event => event.type === 'application_spawned').map(event => event.payload.buildId);
const has = (installation, type) => hostEvents(installation).some(event => event.type === type);

async function waitForCrash(host) {
  await eventually(() => exited(host.child), 'the Host to end at its crash point', 600_000, 200);
  assert.equal(host.child.exitCode, CRASH_EXIT, `the Host ended at the named crash point: ${host.stderr.slice(-1500)}`);
}

// One installation with the stable Shell, the selected Engine A, and the staged Engine B from the given source variant.
async function installation(label, variant) {
  const root = ownedDir(join(testsRoot, `p6-g0-${label}-`));
  const { hostExe } = buildArtifacts();
  const install = join(root, 'installation');
  installShell(install);
  const sources = await engineSources(join(root, 'sources'), { variant });
  const { bRoot } = await installEngines(install, sources, { stageB: true, testFaultHooks: true });
  return { root, install, profile: join(root, 'profile'), hostExe, packageSha256: hostDigest(bRoot) };
}

// Runs the switch until the Host ends at the named crash point. Returns the descriptor instance the crashed session left behind,
// so the restarted Host's Engine can be told apart from any earlier one.
async function crashAt(env, point, { settle = null } = {}) {
  const operationId = randomUUID();
  const host = startShellHost({ root: env.root, installation: env.install, profile: env.profile, initialBuildId: ENGINE_A, testSwitchCrashAt: point });
  const connectionA = await host.engineConnection(ENGINE_A);
  const requested = trigger(connectionA, { operationId, targetEngineBuildId: ENGINE_B, packageSha256: env.packageSha256 });
  await waitForCrash(host);
  await requested;
  if (settle) await settle();
  return { operationId, stale: descriptorInstance(env.profile) };
}

// A restarted Host over the same installation and profile.
function restart(env) {
  return startShellHost({ root: env.root, installation: env.install, profile: env.profile, initialBuildId: ENGINE_A });
}

test('G0-C04/C10 crash after the fenced switch or after Engine A stopped: the switch is abandoned and the committed Engine A restarts', { timeout: 40 * 60_000 }, async () => {
  for (const point of ['after_fenced', 'after_a_stopped']) {
    const env = await installation(`c10-${point.replace(/_/g, '')}`, 'marker');
    const { stale } = await crashAt(env, point);
    const host = restart(env);
    try {
      const connection = await freshDescriptor(env.profile, ENGINE_A, stale);
      assert.equal(connection.engineMarker, undefined, `${point}: the committed Engine A restarted`);
      assert.equal(activeSelector(env.install).buildId, ENGINE_A, `${point}: the selector still names Engine A`);
      assert.equal(lifecycleState(env.install).engineOperation.phase, 'abandoned', `${point}: the unfinished switch is abandoned`);
      assert.equal(has(env.install, 'engine_switch_committed'), false, `${point}: nothing was committed`);
      assert.equal(builds(env.install).includes(ENGINE_B), false, `${point}: the candidate was never launched`);
    } finally {
      await host.stop();
    }
  }
});

test('G0-C07 crash while the candidate runs its preflight: the candidate ends with the Host and exact Engine A is restored once', { timeout: 40 * 60_000 }, async () => {
  const env = await installation('c07', 'marker');
  const { stale } = await crashAt(env, 'after_candidate_spawned');
  const host = restart(env);
  try {
    const connection = await freshDescriptor(env.profile, ENGINE_A, stale);
    assert.equal(connection.engineMarker, undefined, 'the exact previous Engine A serves');
    assert.equal(activeSelector(env.install).buildId, ENGINE_A, 'the selector never named the candidate');
    assert.equal(has(env.install, 'engine_switch_committed'), false, 'nothing was committed');
    const operation = lifecycleState(env.install).engineOperation;
    assert.equal(operation.phase, 'rolled_back');
    assert.equal(operation.fallbackAttempted, true);
    assert.deepEqual(builds(env.install), [ENGINE_A, ENGINE_B, ENGINE_A], 'A, then the candidate for its preflight, then the restored A');
  } finally {
    await host.stop();
  }
});

test('G0-C07/C11 crash after the candidate reports its preflight, before the selector commit: exact Engine A is restored once', { timeout: 40 * 60_000 }, async () => {
  const env = await installation('c11', 'marker');
  const { stale } = await crashAt(env, 'before_commit_write');
  const host = restart(env);
  try {
    const connection = await freshDescriptor(env.profile, ENGINE_A, stale);
    assert.equal(connection.engineMarker, undefined);
    assert.equal(activeSelector(env.install).buildId, ENGINE_A, 'the selector never named the candidate');
    const operation = lifecycleState(env.install).engineOperation;
    assert.equal(operation.phase, 'rolled_back');
    assert.equal(operation.fallbackAttempted, true);
    assert.equal(builds(env.install).filter(id => id === ENGINE_B).length, 1, 'the candidate ran once, for its preflight');
  } finally {
    await host.stop();
  }
});

test('G0-C12/C13/C18 crash after the selector commit: the committed Engine B starts, survives repeated Host restarts, and is never replaced', { timeout: 60 * 60_000 }, async () => {
  for (const point of ['after_commit_write', 'after_committed_phase']) {
    const env = await installation(`c12-${point.replace(/_/g, '')}`, 'marker');
    const { operationId, stale } = await crashAt(env, point);
    let previous = stale;
    let host = restart(env);
    try {
      const connection = await freshDescriptor(env.profile, ENGINE_B, previous);
      assert.equal(connection.engineMarker, 'engine-b', `${point}: the committed Engine B starts after the crash`);
      await eventually(() => lifecycleState(env.install).engineOperation?.phase === 'verified', `${point}: the operation verifies`, 120_000, 200);
      assert.equal(activeSelector(env.install).committedOperationId, operationId);
      previous = connection.runtimeInstanceId;
    } finally {
      await host.stop();
    }
    // C18: repeated restarts keep exactly the committed selection and never launch Engine A again.
    for (let round = 0; round < 2; round += 1) {
      host = restart(env);
      try {
        const again = await freshDescriptor(env.profile, ENGINE_B, previous);
        assert.equal(again.engineMarker, 'engine-b', `${point}: restart ${round + 1} keeps Engine B`);
        assert.equal(activeSelector(env.install).buildId, ENGINE_B);
        previous = again.runtimeInstanceId;
      } finally {
        await host.stop();
      }
    }
    const spawns = builds(env.install);
    assert.equal(spawns.filter(id => id === ENGINE_A).length, 1, `${point}: Engine A ran once, before the switch`);
    assert.equal(spawns.at(-1), ENGINE_B);
  }
});

test('G0-C15 crash during the single fallback: the restart completes the restore of exact Engine A without a second candidate', { timeout: 40 * 60_000 }, async () => {
  const env = await installation('c15', 'failing');
  const { stale } = await crashAt(env, 'before_fallback_start');
  const host = restart(env);
  try {
    const connection = await freshDescriptor(env.profile, ENGINE_A, stale);
    assert.equal(connection.engineMarker, undefined, 'the exact previous Engine A serves');
    assert.equal(activeSelector(env.install).buildId, ENGINE_A);
    const operation = lifecycleState(env.install).engineOperation;
    assert.equal(operation.phase, 'rolled_back');
    assert.equal(operation.fallbackAttempted, true, 'the fallback budget is not replenished by the restart');
  } finally {
    await host.stop();
  }
});

test('G0-C16 the production Store changes while the Host is down: the switch holds and no Engine starts', { timeout: 40 * 60_000 }, async () => {
  const env = await installation('c16', 'marker');
  await crashAt(env, 'after_guard', {
    settle: async () => {
      // The Host has ended and released its guards; an identity change to the guarded production file is then not explained by it.
      appendFileSync(join(env.profile, 'store', 'state.sqlite'), Buffer.from('G0-unexplained-change'));
    },
  });
  const host = restart(env);
  try {
    await eventually(() => lifecycleState(env.install).engineOperation?.phase === 'held', 'the switch to hold', 120_000, 200);
    // The phase is reconciled before the Host finishes starting, so the journal line that records the held start follows it.
    await eventually(() => has(env.install, 'engine_start_held'), 'the Host to record that it started no Engine', 60_000, 100);
    assert.equal(activeSelector(env.install).buildId, ENGINE_A, 'the selection is unchanged');
    // The crash point precedes every candidate launch, so the candidate never ran, and the held restart starts no Engine at all.
    assert.equal(builds(env.install).filter(id => id === ENGINE_B).length, 0, 'the candidate was never launched');
    assert.deepEqual(builds(env.install), [ENGINE_A], 'the restart started no Engine');
    const firstSpawn = hostEvents(env.install).find(event => event.type === 'application_spawned');
    assert.equal(processAlive(firstSpawn?.payload?.pid ?? 0), false, 'the first Engine is not running');
  } finally {
    await host.stop();
  }
});

test('G0-C14 the candidate exits after its preflight report and before the decision: the Host restores exact Engine A', { timeout: 40 * 60_000 }, async () => {
  const env = await installation('c14', 'exits-after-preflight');
  const host = startShellHost({ root: env.root, installation: env.install, profile: env.profile, initialBuildId: ENGINE_A });
  try {
    const connectionA = await host.engineConnection(ENGINE_A);
    const operationId = randomUUID();
    const accepted = await trigger(connectionA, { operationId, targetEngineBuildId: ENGINE_B, packageSha256: env.packageSha256 });
    assert.equal(accepted.status, 202, JSON.stringify(accepted));
    await eventually(() => has(env.install, 'engine_switch_rolled_back'), 'the candidate exit to roll back', 600_000, 200);
    assert.equal(activeSelector(env.install).buildId, ENGINE_A);
    assert.equal(has(env.install, 'engine_switch_committed'), false, 'a candidate that exited is never committed');
    assert.equal(lifecycleState(env.install).engineOperation.phase, 'rolled_back');
    const restored = await freshDescriptor(env.profile, ENGINE_A, connectionA.runtimeInstanceId);
    assert.equal(restored.engineMarker, undefined);
  } finally {
    await host.stop();
  }
});

test('G0-C17: concurrent switch requests admit exactly one switch, which commits once', { timeout: 40 * 60_000 }, async () => {
  const env = await installation('c17', 'marker');
  const host = startShellHost({ root: env.root, installation: env.install, profile: env.profile, initialBuildId: ENGINE_A });
  try {
    const connectionA = await host.engineConnection(ENGINE_A);
    const operationId = randomUUID();
    const [first, second] = await Promise.all([
      trigger(connectionA, { operationId, targetEngineBuildId: ENGINE_B, packageSha256: env.packageSha256 }),
      trigger(connectionA, { operationId: randomUUID(), targetEngineBuildId: ENGINE_B, packageSha256: env.packageSha256 }),
    ]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [202, 409], 'exactly one request is admitted');
    await eventually(() => has(env.install, 'engine_switch_verified'), 'the admitted switch to verify', 600_000, 200);
    assert.equal(hostEvents(env.install).filter(event => event.type === 'engine_switch_committed').length, 1, 'one commit');
    assert.equal(activeSelector(env.install).buildId, ENGINE_B);
  } finally {
    await host.stop();
  }
});

test('G0-C01/C02/C03: crashes inside staging leave a reconcilable stage; the restart discards partial bytes and the re-requested switch completes once', { timeout: 90 * 60_000 }, async () => {
  const scenarios = [
    // C01: the stage intent is recorded and nothing is copied yet. C02 is the same crash with a truncated copy left behind.
    { point: 'after_stage_intent', partialCopy: true, id: 'c01c02' },
    // C03: the package is complete and installed, but the stage record was never written.
    { point: 'after_stage_copy', partialCopy: false, id: 'c03' },
  ];
  for (const { point, partialCopy, id } of scenarios) {
    const env = await installation(id, 'marker');
    const { operationId, stale } = await crashAt(env, point);
    if (partialCopy) {
      // The bytes a crashed copy left under the operation's incoming name: a truncated bundle that must never be promoted.
      const incoming = join(env.install, 'versions', `.incoming-${operationId}`, 'runtime');
      mkdirSync(incoming, { recursive: true });
      writeFileSync(join(incoming, 'runner.mjs'), '// truncated by a crash');
    }
    const host = restart(env);
    try {
      const connectionA = await freshDescriptor(env.profile, ENGINE_A, stale);
      assert.equal(lifecycleState(env.install).engineOperation.phase, 'staging', `${point}: the stage intent survives the crash`);
      assert.equal(existsSync(join(env.install, 'versions', `.incoming-${operationId}`)), false, `${point}: partial bytes are discarded on restart`);
      const resumed = await trigger(connectionA, { operationId, targetEngineBuildId: ENGINE_B, packageSha256: env.packageSha256 });
      assert.equal(resumed.status, 202, `${point}: the same operation resumes: ${JSON.stringify(resumed)}`);
      await eventually(() => has(env.install, 'engine_switch_verified'), `${point}: the resumed switch verifies`, 600_000, 200);
      assert.equal(hostEvents(env.install).filter(event => event.type === 'engine_switch_committed').length, 1, `${point}: one commit`);
      assert.equal(activeSelector(env.install).buildId, ENGINE_B);
      const connectionB = await freshDescriptor(env.profile, ENGINE_B, stale);
      assert.equal(connectionB.engineMarker, 'engine-b', `${point}: the committed Engine B serves`);
    } finally {
      await host.stop();
    }
  }
});
