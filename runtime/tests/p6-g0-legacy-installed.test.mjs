// P6-G0-FINAL legacy bypass through the installed application path. A real Shell and Lifecycle Host run a P6 installation with
// Engine A. The Engine's own production bridge sends the legacy whole-release activation to the Host; the Host refuses it before
// any staging, stop, selector write, process launch or receipt. Nothing else in the installation changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildArtifacts } from './custody-support.mjs';
import { ownedDir, testsRoot } from './test-roots.mjs';
import { ENGINE_A, activeSelector, engineSources, fileSha256, hostEvents, installEngines, installShell, lifecycleState, probeEngine,
  processAlive, recordEvidence, startShellHost } from './p6-g0-support.mjs';

const spawnedBuilds = installation => hostEvents(installation).filter(event => event.type === 'application_spawned').map(event => event.payload.buildId);

test('P6-G0 legacy bypass: the installed Engine\'s own bridge is refused by the Host, with no staging, stop, selector, launch or receipt effect', { timeout: 30 * 60_000 }, async () => {
  const root = ownedDir(join(testsRoot, 'p6-g0-legacy-installed-'));
  const { hostExe } = buildArtifacts();
  const installation = join(root, 'installation');
  installShell(installation);
  const shellBefore = fileSha256(join(installation, 'shell', 'deszo.exe'));
  const hostBefore = fileSha256(hostExe);
  const sources = await engineSources(join(root, 'sources'), { variant: 'marker' });
  await installEngines(installation, sources, { stageB: false, testFaultHooks: true });
  const profile = join(root, 'profile');

  const host = startShellHost({ root, installation, profile, initialBuildId: ENGINE_A, testEngineProbe: true });
  try {
    const connectionA = await host.engineConnection(ENGINE_A);
    const runA = hostEvents(installation).filter(event => event.type === 'engine_ready').at(-1).payload;
    const before = {
      selector: activeSelector(installation),
      versions: readdirSync(join(installation, 'versions')).sort(),
      launches: spawnedBuilds(installation).length,
      events: hostEvents(installation).length,
    };

    // The installed Engine A sends the legacy activation through its production bridge, with a complete request.
    const refusal = await probeEngine(profile, ENGINE_A, { action: 'legacy_activation' });
    assert.equal(refusal.ok, false, 'the Host does not accept the legacy activation');
    assert.equal(refusal.code, 'p6_legacy_activation_refused', 'the Host names the stable P6 refusal');
    assert.equal(refusal.applicationPid, runA.enginePid, 'the refusal came from the installed Engine A process');

    // Nothing changed: the same selector, no new package, no staging or switch record, no launch, no stop.
    assert.deepEqual(activeSelector(installation), before.selector, 'the selector is unchanged');
    assert.deepEqual(readdirSync(join(installation, 'versions')).sort(), before.versions, 'no legacy candidate was installed');
    const after = hostEvents(installation).slice(before.events);
    assert.equal(after.some(event => event.type === 'engine_staged' || event.type.startsWith('engine_switch')), false, 'no staging or switch began');
    assert.equal(spawnedBuilds(installation).length, before.launches, 'no process was launched');
    assert.equal(after.some(event => /managed_process|application_exited|application_stopped/.test(event.type)), false, 'no process was stopped');
    assert.equal(after.some(event => /activat|receipt/i.test(event.type)), false, 'no activation or success receipt was recorded');
    assert.equal(lifecycleState(installation).engineOperation ?? null, null, 'no P6 operation record exists');

    // Engine A is still the running, serving Engine.
    assert.equal(processAlive(runA.applicationPid), true, 'Engine A is still running');
    const served = await fetch(`http://127.0.0.1:${connectionA.port}/api/v2/settings`, { headers: { Authorization: `Bearer ${connectionA.token}` } });
    assert.equal(served.status, 200, 'Engine A still serves its owner API');

    // The Shell and the Host are the same bytes as before.
    assert.equal(fileSha256(join(installation, 'shell', 'deszo.exe')), shellBefore, 'the Shell is unchanged');
    assert.equal(fileSha256(hostExe), hostBefore, 'the Host is unchanged');
    recordEvidence('legacy-installed', { refusal: { ok: refusal.ok, code: refusal.code }, refusingProcessId: refusal.applicationPid,
      selector: before.selector, versions: before.versions, launchesBefore: before.launches, launchesAfter: spawnedBuilds(installation).length,
      eventTypesAfterRefusal: after.map(event => event.type),
      shellSha256: { before: shellBefore, after: fileSha256(join(installation, 'shell', 'deszo.exe')) },
      hostSha256: { before: hostBefore, after: fileSha256(hostExe) } });
  } finally {
    await host.stop();
  }
});
