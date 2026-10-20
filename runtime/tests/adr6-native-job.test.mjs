// ADR-0006 native containment on Windows: a Job holder that owns admitted work (runtime/host/native/jobguard.cs).
// These tests run real processes and real kernel Job objects. They touch only processes they start, and they do not
// install a service or a Scheduled Task. They are skipped outside Windows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
// Skipped outside Windows, or where the .NET Framework C# compiler that builds the holder is not installed.
const windows = process.platform === 'win32' && existsSync(csc);
const sourcePath = resolve(import.meta.dirname, '../host/native/jobguard.cs');
const testsRoot = resolve(import.meta.dirname, '../../.deszo/tests');

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const pause = ms => new Promise(done => setTimeout(done, ms));
async function until(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return true; await pause(100); }
  return predicate();
}

// The owned workload: a child that starts a grandchild, records both PIDs, and keeps running.
const CHILD_SCRIPT = `const fs = require('fs'); const cp = require('child_process');
const grandchild = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(process.argv[2], JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
setInterval(() => {}, 1000);
`;

let exe = null;
function compileHolder() {
  if (exe) return exe;
  const dir = mkdtempSync(join(testsRoot, 'native-job-'));
  mkdirSync(dir, { recursive: true });
  const out = join(dir, 'jobguard.exe');
  const result = spawnSync(csc, ['/nologo', '/platform:x64', '/optimize+', `/out:${out}`, sourcePath], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `csc failed: ${result.stdout}${result.stderr}`);
  writeFileSync(join(dir, 'child.cjs'), CHILD_SCRIPT);
  exe = { path: out, dir, child: join(dir, 'child.cjs') };
  return exe;
}

// Starts the holder and resolves its first report line; `exit` resolves with its exit code.
function runHolder(args) {
  const child = spawn(compileHolder().path, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const report = new Promise((resolvePromise, reject) => {
    child.stdout.on('data', chunk => {
      stdout += chunk;
      const line = stdout.split('\n')[0];
      if (line.trim().endsWith('}')) resolvePromise(JSON.parse(line));
    });
    child.once('exit', () => reject(new Error(`holder exited before reporting: ${stderr}`)));
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = new Promise(resolvePromise => child.once('exit', code => resolvePromise(code)));
  return { child, report, exit };
}

const childArgs = pidFile => ['admit', process.execPath, exe.child, pidFile];
const newPidFile = () => join(exe.dir, `pids-${Math.random().toString(36).slice(2)}.json`);
const readOwned = pidFile => JSON.parse(readFileSync(pidFile, 'utf8'));

test('ADR6-09 native: a holder crash ends exactly its owned tree and leaves an unrelated stable process alive', { skip: !windows && 'Windows only' }, async () => {
  compileHolder();
  const stable = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const pidFile = newPidFile();
  const holder = runHolder(childArgs(pidFile));
  try {
    const report = await holder.report;
    assert.equal(report.ownershipVerified, true, 'Exactly one handle to the Job exists.');
    assert.equal(report.jobHandleCount, 1);
    assert.equal(report.childInJob, true, 'The child was assigned to the Job before it ran.');
    assert.ok(await until(() => existsSync(pidFile)), 'The owned workload started.');
    const owned = readOwned(pidFile);
    assert.ok(alive(owned.child) && alive(owned.grandchild));
    // The service "crashes": its process is killed, closing its only Job handle.
    spawnSync('taskkill', ['/F', '/PID', String(report.holderPid)], { windowsHide: true });
    assert.ok(await until(() => !alive(owned.child) && !alive(owned.grandchild)), 'The owned child and grandchild ended with the holder.');
    assert.equal(alive(stable.pid), true, 'The unrelated stable process survives the owned-work failure.');
  } finally {
    stable.kill();
    holder.child.kill();
  }
});

test('ADR6-09 native: a crash after suspended creation and before resume leaves no workload behind', { skip: !windows && 'Windows only' }, async () => {
  compileHolder();
  const pidFile = newPidFile();
  const holder = runHolder(['admit', '--crash-before-resume', process.execPath, exe.child, pidFile]);
  const report = await holder.report;
  assert.equal(report.stage, 'suspended');
  assert.equal(await holder.exit, 70, 'The holder exited between assignment and resume.');
  assert.ok(await until(() => !alive(report.childPid)), 'The suspended child was ended by Job closure.');
  assert.equal(existsSync(pidFile), false, 'The pending launch never ran, so no owned work was ever started.');
});

test('ADR6-10 native: an outside duplicate of the Job handle is reported and keeps the tree alive after the holder dies', { skip: !windows && 'Windows only' }, async () => {
  compileHolder();
  const pidFile = newPidFile();
  const holder = runHolder(['admit', '--leak', process.execPath, exe.child, pidFile]);
  const report = await holder.report;
  // The admission check refuses trust: the Job has two handles.
  assert.equal(report.ownershipVerified, false);
  assert.equal(report.jobHandleCount, 2, 'The leaked duplicate is visible to the kernel count.');
  assert.ok(await until(() => existsSync(pidFile)));
  const owned = readOwned(pidFile);
  spawnSync('taskkill', ['/F', '/PID', String(report.holderPid)], { windowsHide: true });
  await pause(1500);
  // Kill-on-close cannot fire while a duplicate is open, so the gate must refuse this configuration; it is not a kill guarantee.
  assert.equal(alive(owned.child) && alive(owned.grandchild), true, 'The leak keeps the owned tree alive: the gate must reject it.');
  for (const pid of [owned.grandchild, owned.child]) { try { process.kill(pid); } catch { /* already gone */ } }
});

test('ADR6-09 native: the controller stop ends the whole owned tree and the holder exits cleanly', { skip: !windows && 'Windows only' }, async () => {
  compileHolder();
  const pidFile = newPidFile();
  const holder = runHolder(childArgs(pidFile));
  const report = await holder.report;
  assert.equal(report.ownershipVerified, true);
  assert.ok(await until(() => existsSync(pidFile)));
  const owned = readOwned(pidFile);
  holder.child.stdin.end();
  assert.equal(await holder.exit, 0);
  assert.ok(await until(() => !alive(owned.child) && !alive(owned.grandchild)), 'Stop reached the grandchild as well as the child.');
});
