// P6-G0 M1: one unchanged Tauri Shell launches two different Engine identities. The Shell executable and the Rust Host
// executable are hashed before and after each run; neither may change. Every Engine is a real packaged desktop release.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildArtifacts } from './custody-support.mjs';
import { ownedDir, testsRoot } from './test-roots.mjs';
import { ENGINE_A, ENGINE_B, engineSources, fileSha256, hostDigest, hostEvents, installEngines, installShell, processAlive, recordEvidence, startShellHost } from './p6-g0-support.mjs';

test('P6-G0 M1: unchanged Shell S runs Engine A and then Engine B; Shell and Host bytes are identical across both runs', { timeout: 60 * 60_000 }, async () => {
  const root = ownedDir(join(testsRoot, 'p6-g0-m1-'));
  const { hostExe } = buildArtifacts();
  const installA = join(root, 'installation-a');
  installShell(installA);
  const shellPath = join(installA, 'shell', 'deszo.exe');
  const shellBefore = fileSha256(shellPath);
  const hostBefore = fileSha256(hostExe);
  const sources = await engineSources(join(root, 'sources'));
  const { a, b } = await installEngines(installA, sources);
  assert.notEqual(a.manifest.engineBuildId, b.manifest.engineBuildId, 'engine A and engine B have distinct identities');
  assert.notEqual(a.runnerDigest, b.runnerDigest, 'the Engine-only difference changes the bundled runner');
  assert.equal(a.manifest.shellBuildId, b.manifest.shellBuildId, 'both Engines bind to the same Shell identity');

  const profile = join(root, 'profile');
  // Shell S + Engine A: the Host launches the installed Shell, and the Shell starts Engine A from its own package root.
  const hostA = startShellHost({ root, installation: installA, profile, initialBuildId: ENGINE_A });
  let connectionA;
  try {
    connectionA = await hostA.engineConnection(ENGINE_A);
    // A production Engine package has no switch trigger: the route is absent from the package, so the request is not found.
    const trigger = await fetch(`http://127.0.0.1:${connectionA.port}/api/v4/lifecycle/engine-switch`, { method: 'POST',
      headers: { Authorization: `Bearer ${connectionA.token}`, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(trigger.status, 404, 'a production Engine package has no switch trigger');
    recordEvidence('production-trigger', { engineBuildId: ENGINE_A, route: 'POST /api/v4/lifecycle/engine-switch', status: trigger.status,
      package: 'production, built without the test marker' });
  } finally {
    await hostA.stop();
  }
  const runA = hostEvents(installA).filter(event => event.type === 'engine_ready').at(-1)?.payload;
  assert.equal(connectionA.applicationBuildId, ENGINE_A);
  assert.equal(connectionA.engineMarker, undefined, 'engine A carries no Engine-only marker');
  assert.ok(runA, 'the Host journal records engine A readiness');
  assert.equal(processAlive(runA.enginePid), false, 'engine A ends with its Host-managed tree');
  const spawnedA = hostEvents(installA).find(event => event.type === 'application_spawned');
  assert.equal(spawnedA.payload.bootstrap, 'engine');
  assert.equal(spawnedA.payload.buildId, ENGINE_A);
  assert.equal(spawnedA.payload.executable.toLowerCase(), join(installA, 'shell', 'deszo.exe').toLowerCase(), 'the Host launched the stable Shell executable');
  assert.equal(fileSha256(shellPath), shellBefore, 'the Shell executable is unchanged after Engine A');
  assert.equal(fileSha256(hostExe), hostBefore, 'the Host executable is unchanged after Engine A');

  // Shell S + Engine B: the same Shell bytes under a second installation beside the same profile.
  const installB = join(root, 'installation-b');
  cpSync(join(installA, 'shell'), join(installB, 'shell'), { recursive: true });
  cpSync(join(installA, 'versions', ENGINE_B), join(installB, 'versions', ENGINE_B), { recursive: true });
  mkdirSync(join(installB, 'staging'), { recursive: true });
  assert.equal(fileSha256(join(installB, 'shell', 'deszo.exe')), shellBefore, 'the copied Shell is byte-identical');
  const hostB = startShellHost({ root, installation: installB, profile, initialBuildId: ENGINE_B });
  let connectionB;
  try {
    connectionB = await hostB.engineConnection(ENGINE_B);
  } finally {
    await hostB.stop();
  }
  const runB = hostEvents(installB).filter(event => event.type === 'engine_ready').at(-1)?.payload;
  const spawnedB = hostEvents(installB).find(event => event.type === 'application_spawned');
  assert.equal(connectionB.applicationBuildId, ENGINE_B);
  assert.equal(connectionB.engineMarker, 'engine-b', 'engine B runs its own Engine-only code');
  assert.equal(spawnedB.payload.buildId, ENGINE_B);
  assert.equal(spawnedB.payload.executable.toLowerCase(), join(installB, 'shell', 'deszo.exe').toLowerCase(), 'the same Shell executable launched engine B');
  assert.equal(processAlive(runB.enginePid), false, 'engine B ends with its Host-managed tree');
  assert.equal(fileSha256(join(installB, 'shell', 'deszo.exe')), shellBefore, 'the Shell executable is unchanged after Engine B');
  assert.equal(fileSha256(shellPath), shellBefore, 'the original Shell executable is unchanged after both runs');
  assert.equal(fileSha256(hostExe), hostBefore, 'the Host executable is unchanged after both runs');
  assert.notEqual(runA.buildId, runB.buildId, 'the two Engine readiness records name different Engine identities');
  assert.equal(runA.applicationBuildId ?? runA.buildId, ENGINE_A);
  recordEvidence('m1-identity', { engineA: { applicationBuildId: ENGINE_A, enginePid: runA.enginePid, packageDigest: hostDigest(join(installA, 'versions', ENGINE_A)) },
    engineB: { applicationBuildId: ENGINE_B, enginePid: runB.enginePid, packageDigest: hostDigest(join(installB, 'versions', ENGINE_B)) },
    shellSha256: { before: shellBefore, after: fileSha256(shellPath) }, hostSha256: { before: hostBefore, after: fileSha256(hostExe) } });
});
