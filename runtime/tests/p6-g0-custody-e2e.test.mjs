// P6-G0-FINAL Custody E2E. A real Shell, a real Lifecycle Host and Engine A run a packaged switch while a live Process Custody Job
// and its descendant exist. The Job is launched by Engine A through its own production Custody client. B1: the switch refuses on
// the live Job and releases its fence. B3: an admission during the fence window is refused. B2: after the Job and its descendant
// end through the Host's own Stop, the same operation commits Engine B exactly once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildArtifacts, eventually } from './custody-support.mjs';
import { ownedDir, testsRoot } from './test-roots.mjs';
import { ENGINE_A, ENGINE_B, activeSelector, engineSources, fileSha256, freshDescriptor, hostDigest, hostEvents, installEngines, installShell,
  lifecycleState, probeEngine, processAlive, recordEvidence, startShellHost } from './p6-g0-support.mjs';

// A Custody-launched tree: this process and one descendant, both waiting until the Host ends the Job.
const FIXTURE = `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(process.argv[2], JSON.stringify({ parent: process.pid, child: child.pid }));
setInterval(() => {}, 1000);
`;

async function requestSwitch(connection, body) {
  const response = await fetch(`http://127.0.0.1:${connection.port}/api/v4/lifecycle/engine-switch`, { method: 'POST',
    headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(900_000) });
  return { status: response.status, body: await response.json().catch(() => null) };
}

const fenceWindows = (installation, operationId) => hostEvents(installation)
  .filter(event => event.type === 'engine_switch_fence_window' && event.payload.operationId === operationId).length;
const spawnedBuilds = installation => hostEvents(installation).filter(event => event.type === 'application_spawned').map(event => event.payload.buildId);

// The Windows variables a Node provider needs to start. Without SYSTEMROOT, node.exe aborts inside a Custody Job (exit 134).
const WINDOWS_ENVIRONMENT = ['PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'USERPROFILE', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT', 'WINDIR'];
const windowsEnvironment = () => Object.fromEntries(WINDOWS_ENVIRONMENT.filter(name => process.env[name] !== undefined)
  .map(name => [name, process.env[name]]));

test('P6-G0 Custody E2E: a live Job and its descendant hold a packaged switch, the fence refuses racing admissions, and the switch commits once after the Job ends', { timeout: 60 * 60_000 }, async () => {
  const root = ownedDir(join(testsRoot, 'p6-g0-custody-e2e-'));
  const { hostExe } = buildArtifacts();
  const installation = join(root, 'installation');
  installShell(installation);
  const shellBefore = fileSha256(join(installation, 'shell', 'deszo.exe'));
  const hostBefore = fileSha256(hostExe);
  const sources = await engineSources(join(root, 'sources'), { variant: 'marker' });
  const { bRoot } = await installEngines(installation, sources, { stageB: true, testFaultHooks: true });
  const packageSha256 = hostDigest(bRoot);
  const profile = join(root, 'profile');
  const work = join(root, 'custody-work');
  mkdirSync(work, { recursive: true });
  const fixture = join(work, 'custody-tree.mjs');
  writeFileSync(fixture, FIXTURE);
  const pidFile = join(work, 'pids.json');
  const admission = name => ({ attemptId: randomUUID(), runId: randomUUID(), provider: name, command: process.execPath, cwd: work,
    deadlineMs: 1_800_000, args: [fixture, join(work, `${name}.pids.json`)], env: windowsEnvironment() });

  // The Host's Custody allowlist names the test's Node executable by its exact digest; the fence window is held for 3 seconds.
  const host = startShellHost({ root, installation, profile, initialBuildId: ENGINE_A, testEngineProbe: true, testFenceWindowMs: 3000,
    custody: { allowedExecutables: [{ path: process.execPath, sha256: fileSha256(process.execPath) }] } });
  try {
    const connectionA = await host.engineConnection(ENGINE_A);
    const runA = hostEvents(installation).filter(event => event.type === 'engine_ready').at(-1).payload;

    // 1. Engine A launches a Custody Job through its own production Custody client. The Job is live, with a descendant.
    const started = await probeEngine(profile, ENGINE_A, { action: 'custody_launch', payload: { ...admission('p6-custody-tree'), args: [fixture, pidFile] } });
    assert.equal(started.ok, true, JSON.stringify(started));
    const custodyId = started.value.custodyId;
    await eventually(() => existsSync(pidFile), 'the Custody Job tree to start', 120_000, 100);
    const tree = JSON.parse(readFileSync(pidFile, 'utf8'));
    assert.equal(processAlive(tree.parent), true, 'the Job process is alive');
    assert.equal(processAlive(tree.child), true, 'the Job descendant is alive');
    const live = await probeEngine(profile, ENGINE_A, { action: 'custody_status', custodyId });
    assert.equal(live.value.state, 'running', 'the Host registry shows the Job running');
    assert.equal(live.value.terminal, false);

    // 2. B1 and B3: a switch with a live Job refuses on the zero-job boundary. A racing admission in its fence window is refused.
    const operationId = randomUUID();
    const windowsBefore = fenceWindows(installation, operationId);
    const refusedSwitch = requestSwitch(connectionA, { operationId, targetEngineBuildId: ENGINE_B, packageSha256 });
    await eventually(() => fenceWindows(installation, operationId) > windowsBefore, 'the fence window of the refused switch', 120_000, 50);
    const racing = await probeEngine(profile, ENGINE_A, { action: 'custody_reserve', payload: admission('p6-custody-racing') });
    assert.equal(racing.ok, false, 'an admission inside the fence window is not admitted');
    assert.equal(racing.code, 'custody_fenced', 'the fence names the refusal');
    const refused = await refusedSwitch;
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'custody_jobs_active', 'the zero-job boundary refuses the switch on the live Job');

    // The refusal left everything in place: Engine A selected, no Engine B launch, the Job still running, the operation not accepted.
    assert.equal(activeSelector(installation).buildId, ENGINE_A, 'the selector still names Engine A');
    assert.equal(spawnedBuilds(installation).includes(ENGINE_B), false, 'Engine B was never launched');
    assert.equal(hostEvents(installation).some(event => event.type === 'engine_switch_accepted'), false, 'the refused switch was not accepted');
    assert.equal(processAlive(tree.parent) && processAlive(tree.child), true, 'the live Job is still running');

    // A refusal releases the fence: a fresh admission is accepted, and it is withdrawn at once so it holds nothing.
    const reopened = await probeEngine(profile, ENGINE_A, { action: 'custody_reserve', payload: admission('p6-custody-reopened') });
    assert.equal(reopened.ok, true, 'the fence is released after the refusal');
    const withdrawn = await probeEngine(profile, ENGINE_A, { action: 'custody_cancel', custodyId: reopened.value.custodyId });
    assert.equal(withdrawn.ok, true, 'the admission is withdrawn before launch');

    // 3. B2: the Job and its descendant end through the Host's own Stop. Both are gone before any switch can commit.
    const stopped = await probeEngine(profile, ENGINE_A, { action: 'custody_stop', custodyId });
    assert.equal(stopped.ok, true, JSON.stringify(stopped));
    await eventually(() => !processAlive(tree.parent) && !processAlive(tree.child), 'the Job and its descendant to end', 60_000, 200);
    // The record is finalized once the Job's watcher observes the empty Job, which can land just after the Stop reply.
    const ended = await eventually(async () => {
      const status = await probeEngine(profile, ENGINE_A, { action: 'custody_status', custodyId });
      return status.value?.terminal ? status : null;
    }, 'the Host to record the Job as ended', 60_000, 200);
    // The Host's own proof that every process of the invocation ended (the Engine releases its workspace hold only on this).
    assert.equal(ended.value.processTreeEnded, true, 'the Host proves the Job tree ended');
    assert.equal(ended.value.terminal, true, 'the Job stays ended');

    // 4. The same operation is retried. Its fence window still refuses a racing admission, then the switch commits Engine B once.
    const retryWindows = fenceWindows(installation, operationId);
    const retry = requestSwitch(connectionA, { operationId, targetEngineBuildId: ENGINE_B, packageSha256 });
    await eventually(() => fenceWindows(installation, operationId) > retryWindows, 'the fence window of the committed switch', 120_000, 50);
    const inFence = await probeEngine(profile, ENGINE_A, { action: 'custody_reserve', payload: admission('p6-custody-in-fence') });
    assert.equal(inFence.ok, false, 'an admission inside the committed switch fence is not admitted');
    assert.equal(inFence.code, 'custody_fenced');
    const accepted = await retry;
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
    await eventually(() => hostEvents(installation).some(event => event.type === 'engine_switch_verified'), 'the committed Engine B to become ready', 600_000, 200);

    // 5. The switch committed once, under this operation, to Engine B. Engine A is gone and Engine B serves the same Store.
    const selector = activeSelector(installation);
    assert.equal(selector.buildId, ENGINE_B);
    assert.equal(selector.committedOperationId, operationId);
    assert.equal(hostEvents(installation).filter(event => event.type === 'engine_switch_committed').length, 1, 'exactly one commit');
    assert.equal(lifecycleState(installation).engineOperation.phase, 'verified');
    assert.equal(processAlive(runA.enginePid), false, 'Engine A is not running after the commit');
    const connectionB = await freshDescriptor(profile, ENGINE_B, connectionA.runtimeInstanceId);
    const served = await fetch(`http://127.0.0.1:${connectionB.port}/api/v2/settings`, { headers: { Authorization: `Bearer ${connectionB.token}` } });
    assert.equal(served.status, 200, 'Engine B serves the owner API');
    assert.equal(fileSha256(join(installation, 'shell', 'deszo.exe')), shellBefore, 'the Shell is unchanged');
    assert.equal(fileSha256(hostExe), hostBefore, 'the Host is unchanged');
    recordEvidence('custody-e2e', { operationId, custodyId,
      jobProcesses: { parent: tree.parent, child: tree.child },
      liveStatus: live.value.state,
      refusal: { status: refused.status, code: refused.body.code },
      racingAdmission: { ok: racing.ok, code: racing.code },
      reopenedAdmission: reopened.ok, withdrawnAdmission: withdrawn.ok,
      stop: { processTreeEnded: ended.value.processTreeEnded, terminal: ended.value.terminal },
      committedRetry: { fenceAdmission: { ok: inFence.ok, code: inFence.code }, status: accepted.status },
      commits: hostEvents(installation).filter(event => event.type === 'engine_switch_committed').length,
      selector: { buildId: selector.buildId, committedOperationId: selector.committedOperationId },
      shellSha256: { before: shellBefore, after: fileSha256(join(installation, 'shell', 'deszo.exe')) },
      hostSha256: { before: hostBefore, after: fileSha256(hostExe) } });
  } finally {
    await host.stop();
  }
});
