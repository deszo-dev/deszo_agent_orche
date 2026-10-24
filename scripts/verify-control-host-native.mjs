// Opt-in installed-service verification. Requires the elevated installation operator. Never runs in npm test.
// It deliberately crashes ONLY the verified DeszoControlHost service and stops its own launcher task.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { connectHost } from '../runtime/host/ipc.mjs';
import { createConnection } from 'node:net';
import { INSTALLED_HOST_PIPE } from '../runtime/host/nativeClient.mjs';

if (process.platform !== 'win32' || !process.argv.includes('--installed-service')) throw new Error('Use --installed-service on Windows; this test intentionally stops the installed authority.');
const evidenceArg = process.argv.indexOf('--evidence');
const output = resolve(evidenceArg < 0 ? '.deszo/pilots/adr6-completion/native-service-evidence.json' : process.argv[evidenceArg + 1]);
const report = { kind: 'InstalledControlHostVerification', at: new Date().toISOString(), operatorPid: process.pid, checks: [] };
const pause = ms => new Promise(r => setTimeout(r, ms));
const shell = code => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
let client = connectHost(INSTALLED_HOST_PIPE,{timeoutMs:60000});
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function until(fn, ms = 8000) { const end = Date.now() + ms; do { if (await fn()) return; await pause(100); } while (Date.now() < end); throw new Error('Native verification deadline elapsed.'); }
async function check(name, fn) {
  try { const evidence = await fn(); report.checks.push({ name, passed: true, evidence }); console.log(`PASS ${name}`); }
  catch (error) { report.checks.push({ name, passed: false, error: error.message }); throw error; }
}
async function tree(ms = 10000, kind = 'tree') {
  const testId = randomUUID(), root = await client.call('installation.probe', { testId, kind, durationMs: ms });
  let observed;
  try { await until(async () => { observed = await client.call('installation.probe.inspect', { process: root }); return observed.children?.length === 1; }); }
  catch (error) { error.message += ` Last native observation: ${JSON.stringify(observed)}`; throw error; }
  assert.equal(root.administratorMember, false); assert.equal(root.elevatedAdministrator, false); assert.equal(root.integritySid, 'S-1-16-8192');
  return { testId, root, descendant: observed.children[0] };
}
async function ended(t) { await until(() => !alive(t.root.pid) && !alive(t.descendant.pid)); }
// The native client makes one bounded pipe attempt per process (5 s). After an SCM restart the pipe may appear later, so
// reconnect with fresh client processes until the restarted service answers, within an explicit deadline.
async function reconnect(deadlineMs = 60000) {
  client.close();
  const end = Date.now() + deadlineMs;
  let lastError = null;
  while (Date.now() < end) {
    const candidate = connectHost(INSTALLED_HOST_PIPE, { timeoutMs: 15000 });
    try { await candidate.ready; client = candidate; return await client.call('host.health'); }
    catch (error) { lastError = error; candidate.close(); await pause(1000); }
  }
  throw new Error(`The restarted service did not answer within ${deadlineMs} ms: ${lastError?.message}`);
}
try {
  report.before = await client.call('installation.status'); assert.equal(report.before.enrolled, true);
  await check('medium-token protected installation, state, task ACLs and broker-role refusal', async () => {
    const result = await client.call('installation.probe.security');
    for (const name of ['config', 'state', 'launcherTask', 'brokerTask', 'brokerRole', 'gitTool']) assert.equal(result[name].denied, true, `${name}: ${JSON.stringify(result[name])}`);
    assert.equal(result.process.administratorMember, false); return result;
  });
  await check('source Git metadata runs through a restricted user helper while the host captures actual source/import/dependency identities',async()=>{
    const started=Date.now(),source=await client.call('installation.source.inspect',{sourceRoot:resolve(import.meta.dirname,'..')});
    const expected=execFileSync('git',['-c','core.fsmonitor=false','rev-parse','HEAD'],{encoding:'utf8',windowsHide:true,timeout:10000}).trim();
    assert.equal(source.sourceCommit,expected);assert.match(source.sourceDigest,/^[a-f0-9]{64}$/);assert.match(source.tcbDigest,/^[a-f0-9]{64}$/);
    assert.equal(source.metadataProcess.administratorMember,false);assert.equal(source.metadataProcess.integritySid,'S-1-16-8192');assert.notEqual(source.metadataProcess.userSid,'S-1-5-19');
    return{...source,durationMs:Date.now()-started};
  });
  await check('Stop kills exactly the owned child and grandchild', async () => {
    const t = await tree(); await client.call('installation.probe.stop', { testId: t.testId }); await ended(t); assert.equal(alive(process.pid), true); return t;
  });
  await check('lifecycle stop of a preview root reaps its whole owned domain and leaves outside processes', async () => {
    // The same native path the lifecycle uses: the policy domain is stopped through the service's own Job handle.
    const t = await tree(), stopped = await client.call('installation.probe.stopRoot', { testId: t.testId, process: t.root });
    assert.equal(stopped.domainEmpty, true, JSON.stringify(stopped));
    await ended(t); assert.equal(alive(process.pid), true);
    return { tree: t, stopped };
  });
  await check('a nested run Job inside the policy domain ends with the domain; the outside process survives', async () => {
    // A child Job nested in the policy Job (as Deszo's per-run Job is) must be ended by the domain stop, not only its root.
    const t = await tree(10000, 'nested'), stopped = await client.call('installation.probe.stopRoot', { testId: t.testId, process: t.root });
    assert.equal(stopped.domainEmpty, true, JSON.stringify(stopped));
    await ended(t); assert.equal(alive(process.pid), true);
    return { tree: t, stopped };
  });
  await check('native expiry kills the owned tree without Node timers', async () => { const t = await tree(1800); await ended(t); return t; });
  await check('a duplicate outer handle refuses suspended admission', async () => {
    const result = await client.call('installation.probe', { testId: randomUUID(), kind: 'leak' }); assert.equal(result.refused, true); await until(() => !alive(result.process.pid)); return result;
  });
  await check('Stop fences a concurrently preparing launch and confirms its suspended root terminated before returning',async()=>{
    const result=await client.call('installation.probe',{testId:randomUUID(),kind:'stop-fence',durationMs:10000});
    assert.equal(result.refused,true);assert.equal(result.termination.terminationConfirmed,true);assert.equal(result.termination.domainEmpty,true);
    assert.equal(alive(result.process.pid),false);return result;
  });
  await check('launcher termination before acknowledgement reaps atomic pending launch', async () => {
    const pending = await client.call('installation.probe', { testId: randomUUID(), kind: 'pending' });
    shell("Stop-ScheduledTask -TaskPath '\\DeszoControlHost\\' -TaskName InteractiveLauncher"); await until(() => !alive(pending.process.pid));
    shell("Start-ScheduledTask -TaskPath '\\DeszoControlHost\\' -TaskName InteractiveLauncher");
    await until(async () => (await client.call('host.health')).launcherConnected); return pending;
  });
  await check('clients that connect and drop before accept do not fail-stop the authority', async () => {
    // Regression for a restart defect: a dropped client made the accept loop exit the service (pipe.failure, status 72).
    const before = await client.call('host.health');
    for (let i = 0; i < 40; i++) {
      await new Promise(done => { const socket = createConnection(INSTALLED_HOST_PIPE); socket.once('connect', () => { socket.destroy(); done(); }); socket.once('error', () => done()); });
    }
    await pause(1500);
    const after = await client.call('host.health');
    assert.equal(after.pid, before.pid, 'The same service process served the connections after the dropped clients.');
    return { pid: after.pid, dropped: 40 };
  });
  await check('actual SCM service crash fail-stops tree; recovery retains Hello enrollment', async () => {
    const t = await tree(), before = await client.call('host.health');
    const actualPid = Number(shell("(Get-CimInstance Win32_Service -Filter \"Name='DeszoControlHost'\").ProcessId").trim());
    assert.equal(actualPid, before.pid); shell(`Stop-Process -Id ${actualPid} -Force`); await ended(t);
    assert.equal(alive(process.pid), true); report.crashCheckpoint = { tree: t, servicePid: actualPid, ownedTreeTerminated: true, verifierSurvived: true };
    // SCM restarts the service on a 3s/10s/30s backoff, and an early instance can fail while the closing instance still
    // owns the pipe. Measure the recovery rather than assume one attempt: wait for a healthy host from a new instance, then
    // for the launcher to reconnect to it. Both waits are bounded; the timings are recorded in the evidence.
    const restartStarted = Date.now();
    await until(() => shell("(Get-Service DeszoControlHost).Status.ToString()").trim() === 'Running', 60000);
    const after = await reconnect(120000);
    const healthyAfterMs = Date.now() - restartStarted;
    await until(async () => (await client.call('host.health')).launcherConnected, 120000);
    const launcherConnectedAfterMs = Date.now() - restartStarted;
    const status = await client.call('installation.status');
    // Same boot, new service process and host instance, and the enrollment is still present.
    assert.notEqual(after.pid, before.pid, 'The service process was replaced.');
    assert.notEqual(after.hostInstance, before.hostInstance, 'The restarted service is a new host instance.');
    assert.equal(after.bootId, before.bootId, 'The SCM restart stays within the same OS boot.');
    assert.equal(status.enrolled, true, 'Enrollment survives the service crash.');
    assert.equal(status.autonomyEnabled, false, 'A restart never enables autonomy.');
    return { timing: { healthyAfterMs, launcherConnectedAfterMs }, tree: t, before: { pid: before.pid, hostInstance: before.hostInstance, bootId: before.bootId }, after: { pid: after.pid, hostInstance: after.hostInstance, bootId: after.bootId, launcherConnected: after.launcherConnected, enrolled: status.enrolled, assurance: status.assurance } };
  });
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.stack; process.exitCode = 1; }
finally { try { shell("Start-Service DeszoControlHost; Start-ScheduledTask -TaskPath '\\DeszoControlHost\\' -TaskName InteractiveLauncher"); } catch {} client.close(); mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2)); console.log(output); }
