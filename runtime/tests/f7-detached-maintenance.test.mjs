// F7-L1: a managed-task delivery writes its verified commit into the source repository with `git fetch`. Git can end a fetch with automatic
// maintenance (`maintenance run --auto`, then `gc --auto`), and `gc --auto` may detach into the background and keep repacking the repository after
// the fetch has returned; the delivery does not wait for a detached process. The source-repository fetch therefore starts no automatic maintenance.
// The proof is deterministic at the level of child commands (GIT_TRACE): a control shows that the default fetch starts maintenance on the same kind
// of repository, and the production fetch starts none. It also samples the process table after the production fetch. Other applications on the
// machine run Git too, so a process counts as a survivor of the fetch only when it is attributable to it: its parent is the fetch process (Windows
// does not reparent an orphan), it is a maintenance command, or it works on this repository. Every other new Git process is recorded, not asserted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SOURCE_FETCH_CONFIG, SOURCE_FETCH_OPTIONS } from '../core/branchDelivery.mjs';
import { testsRoot } from './custody-support.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const MAX_BUFFER = 256 * 1024 * 1024;
const identity = { GIT_AUTHOR_NAME: 'Proof', GIT_AUTHOR_EMAIL: 'proof@example.com', GIT_COMMITTER_NAME: 'Proof', GIT_COMMITTER_EMAIL: 'proof@example.com' };

function git(cwd, args) {
  const result = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, env: { ...process.env, ...identity }, encoding: 'utf8', windowsHide: true, maxBuffer: MAX_BUFFER });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

// A source repository with more loose objects than the automatic maintenance threshold allows, and a clone with one commit the source lacks.
function repositoryPair(label) {
  const base = mkdtempSync(join(testsRoot, `f7l1-${label}-`));
  const source = join(base, 'source'), clone = join(base, 'clone'), scratch = join(base, 'objects');
  mkdirSync(source, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  git(source, ['init', '-q', '-b', 'main']);
  writeFileSync(join(source, 'README.md'), 'base\n');
  git(source, ['add', 'README.md']);
  git(source, ['commit', '-q', '-m', 'base']);
  const files = [];
  for (let index = 0; index < 9000; index += 1) {
    const file = join(scratch, `object-${index}.txt`);
    writeFileSync(file, `object ${index} ${randomUUID()}\n`);
    files.push(file);
  }
  const hashed = spawnSync('git', ['-c', 'core.autocrlf=false', 'hash-object', '-w', '--stdin-paths'], { cwd: source, input: `${files.join('\n')}\n`, encoding: 'utf8',
    windowsHide: true, maxBuffer: MAX_BUFFER });
  assert.equal(hashed.status, 0, `hash-object: ${hashed.error?.message ?? hashed.stderr}`);
  git(base, ['clone', '-q', source, clone]);
  writeFileSync(join(clone, 'change.txt'), `change ${randomUUID()}\n`);
  git(clone, ['add', 'change.txt']);
  git(clone, ['commit', '-q', '-m', 'change']);
  return { base, source, clone, sha: git(clone, ['rev-parse', 'HEAD']) };
}

// The child commands that a traced Git process started, as Git reports them.
function childCommands(stderr) {
  return stderr.split(/\r?\n/).filter(line => line.includes('run_command:')).map(line => line.slice(line.indexOf('run_command:') + 'run_command:'.length).trim());
}

const maintenance = command => /^git (maintenance run|gc --auto)\b/.test(command);

// Git processes on the machine: pid, parent pid and command line.
function gitProcesses() {
  const script = "Get-CimInstance Win32_Process -Filter \"Name='git.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)\" }";
  const listed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, maxBuffer: MAX_BUFFER });
  const processes = new Map();
  for (const line of listed.stdout.split(/\r?\n/)) {
    const [pid, parent, ...command] = line.split('\t');
    if (pid?.trim() && parent !== undefined) processes.set(pid.trim(), { parent: Number(parent), commandLine: command.join('\t') });
  }
  return processes;
}

// Whether a new Git process is attributable to the fetch: started by it, a maintenance command, or working on this repository.
function attributable({ parent, commandLine }, fetchPid, repository) {
  const normalised = commandLine.toLowerCase().replace(/\\/g, '/');
  return parent === fetchPid || /\b(gc|repack|maintenance|pack-objects|prune|pack-refs)\b/.test(commandLine)
    || normalised.includes(repository.toLowerCase().replace(/\\/g, '/'));
}

function traced(cwd, args) {
  const result = spawnSync('git', args, { cwd, env: { ...process.env, ...identity, GIT_TRACE: '1' }, encoding: 'utf8', windowsHide: true, maxBuffer: MAX_BUFFER });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr.split('\n').filter(line => !line.startsWith('warning')).join('\n')}`);
  return { children: childCommands(result.stderr), pid: result.pid };
}

function remove(path) { rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }

test('F7-L1 control: the default fetch of a source repository past the threshold starts automatic maintenance', { timeout: 600_000 }, () => {
  const pair = repositoryPair('control');
  try {
    const { children } = traced(pair.source, ['-c', 'core.hooksPath=/nonexistent', 'fetch', pair.clone, pair.sha]);
    assert.ok(children.some(maintenance), `the control must start automatic maintenance: ${children.join(' | ')}`);
  } finally { remove(pair.base); }
});

test('F7-L1: the production source fetch starts no automatic maintenance, and leaves no Git process of its own after it returns', { timeout: 600_000 }, async () => {
  const pair = repositoryPair('production');
  try {
    const before = new Set(gitProcesses().keys());
    const args = ['-c', 'core.hooksPath=/nonexistent', ...SOURCE_FETCH_CONFIG, 'fetch', ...SOURCE_FETCH_OPTIONS, pair.clone, pair.sha];
    const { children, pid: fetchPid } = traced(pair.source, args);
    assert.deepEqual(children.filter(maintenance), [], 'the production fetch starts no maintenance or gc child');
    assert.equal(spawnSync('git', ['cat-file', '-e', pair.sha], { cwd: pair.source, windowsHide: true }).status, 0, 'the verified commit reached the source repository');
    const survivors = [], unrelated = [];
    for (const wait of [0, 1_000, 3_000]) {
      await delay(wait);
      for (const [pid, info] of gitProcesses()) {
        if (before.has(pid)) continue;
        const entry = { pid, parent: info.parent, sampleDelayMs: wait, commandLine: info.commandLine.slice(0, 160) };
        (attributable(info, fetchPid, pair.source) ? survivors : unrelated).push(entry);
      }
    }
    // Git processes that other applications started during the sampling are reported for the record; they are not the fetch's.
    if (unrelated.length) console.error(`F7-L1: unrelated Git processes seen during sampling: ${JSON.stringify(unrelated)}`);
    assert.deepEqual(survivors, [], 'no Git process attributable to the fetch outlives it');
  } finally { remove(pair.base); }
});
