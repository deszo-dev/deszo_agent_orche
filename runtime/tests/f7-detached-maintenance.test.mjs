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
import { mkdirSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { SOURCE_FETCH_CONFIG, SOURCE_FETCH_OPTIONS } from '../core/branchDelivery.mjs';
import { ownedDir, releaseOwnedDir, testsRoot } from './test-roots.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const MAX_BUFFER = 256 * 1024 * 1024;
const identity = { GIT_AUTHOR_NAME: 'Proof', GIT_AUTHOR_EMAIL: 'proof@example.com', GIT_COMMITTER_NAME: 'Proof', GIT_COMMITTER_EMAIL: 'proof@example.com' };

function git(cwd, args) {
  const result = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, env: { ...process.env, ...identity }, encoding: 'utf8', windowsHide: true, maxBuffer: MAX_BUFFER });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

// Loose blob objects written into a repository in Git's own loose format (zlib of "blob <size>\0<content>", named by its SHA-1). Writing
// them directly, in parallel, takes seconds; `git hash-object --stdin-paths` over 9,000 files took 90-100 s on Windows. Git then reads
// every one back (cat-file --batch-check) and counts them (count-objects), so the fixture is proven to be what Git sees as loose objects.
async function writeLooseBlobs(repository, count) {
  const objects = join(repository, '.git', 'objects');
  for (let index = 0; index < 256; index += 1) mkdirSync(join(objects, index.toString(16).padStart(2, '0')), { recursive: true });
  const ids = [];
  let next = 0;
  const writer = async () => {
    while (next < count) {
      const index = next++;
      const content = Buffer.from(`object ${index} ${randomUUID()}\n`);
      const raw = Buffer.concat([Buffer.from(`blob ${content.length}\0`), content]);
      const id = createHash('sha1').update(raw).digest('hex');
      await writeFile(join(objects, id.slice(0, 2), id.slice(2)), deflateSync(raw), { flag: 'wx' });
      ids.push(id);
    }
  };
  await Promise.all(Array.from({ length: 16 }, writer));
  const checked = spawnSync('git', ['cat-file', '--batch-check'], { cwd: repository, input: `${ids.join('\n')}\n`, encoding: 'utf8', windowsHide: true, maxBuffer: MAX_BUFFER });
  assert.equal(checked.status, 0, `cat-file: ${checked.stderr}`);
  assert.equal(checked.stdout.trim().split(/\r?\n/).filter(line => / blob \d+$/.test(line)).length, count, 'Git reads every written object as a blob');
  const counted = Number(/^count: (\d+)$/m.exec(git(repository, ['count-objects', '-v']))?.[1]);
  assert.ok(counted >= count, `Git counts ${counted} loose objects`);
}

// A source repository with more loose objects than the automatic maintenance threshold allows, and a clone with one commit the source lacks.
// The clone is taken before the loose objects exist: it needs only the shared base, and cloning or committing next to 9,000 loose objects
// cost another 30 s (the clone's own commit ran automatic maintenance).
async function repositoryPair(label) {
  const base = ownedDir(join(testsRoot, `f7l1-${label}-`));
  const source = join(base, 'source'), clone = join(base, 'clone');
  mkdirSync(source, { recursive: true });
  git(source, ['init', '-q', '-b', 'main']);
  writeFileSync(join(source, 'README.md'), 'base\n');
  git(source, ['add', 'README.md']);
  git(source, ['commit', '-q', '-m', 'base']);
  git(base, ['clone', '-q', source, clone]);
  writeFileSync(join(clone, 'change.txt'), `change ${randomUUID()}\n`);
  git(clone, ['add', 'change.txt']);
  git(clone, ['commit', '-q', '-m', 'change']);
  await writeLooseBlobs(source, 9000);
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

const MAINTENANCE_COMMANDS = new Set(['gc', 'repack', 'maintenance', 'pack-objects', 'prune', 'pack-refs', 'prune-packed', 'commit-graph', 'multi-pack-index']);
// Children of gc whose subcommand alone is ordinary (`git worktree list` is not maintenance; `git worktree prune` is).
const MAINTENANCE_PAIRS = new Set(['worktree prune', 'rerere gc', 'reflog expire']);
const OPTIONS_WITH_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);

// The Git subcommand of a command line (the first argument after the executable and Git's own options) and the argument after it, or
// null when they cannot be told. A word inside another argument (another application's `git diff -- f7-detached-maintenance.test.mjs`)
// is not a maintenance command.
function gitSubcommand(commandLine) {
  const tokens = [...commandLine.matchAll(/"([^"]*)"|(\S+)/g)].map(match => match[1] ?? match[2]);
  if (!tokens.length || !/(^|[\\/])git(\.exe)?$/i.test(tokens[0])) return null;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (OPTIONS_WITH_VALUE.has(token)) { index += 1; continue; }
    if (token.startsWith('-')) continue;
    return { name: token, next: tokens[index + 1] ?? '' };
  }
  return null;
}

// Whether a new Git process is attributable to the fetch: started by it, a maintenance command, or working on this repository. A command
// line whose subcommand cannot be told is judged by the words it contains, as before.
function attributable({ parent, commandLine }, fetchPid, repository) {
  const normalised = commandLine.toLowerCase().replace(/\\/g, '/');
  const subcommand = gitSubcommand(commandLine);
  const maintenanceCommand = subcommand
    ? MAINTENANCE_COMMANDS.has(subcommand.name) || MAINTENANCE_PAIRS.has(`${subcommand.name} ${subcommand.next}`)
    : /\b(gc|repack|maintenance|pack-objects|prune|pack-refs)\b/.test(commandLine);
  return parent === fetchPid || maintenanceCommand || normalised.includes(repository.toLowerCase().replace(/\\/g, '/'));
}

function traced(cwd, args) {
  const result = spawnSync('git', args, { cwd, env: { ...process.env, ...identity, GIT_TRACE: '1' }, encoding: 'utf8', windowsHide: true, maxBuffer: MAX_BUFFER });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr.split('\n').filter(line => !line.startsWith('warning')).join('\n')}`);
  return { children: childCommands(result.stderr), pid: result.pid };
}

function remove(path) { releaseOwnedDir(path); }

test('F7-L1 control: the default fetch of a source repository past the threshold starts automatic maintenance', { timeout: 600_000 }, async () => {
  const pair = await repositoryPair('control');
  try {
    const { children } = traced(pair.source, ['-c', 'core.hooksPath=/nonexistent', 'fetch', pair.clone, pair.sha]);
    assert.ok(children.some(maintenance), `the control must start automatic maintenance: ${children.join(' | ')}`);
  } finally { remove(pair.base); }
});

test('F7-L1: the production source fetch starts no automatic maintenance, and leaves no Git process of its own after it returns', { timeout: 600_000 }, async () => {
  const pair = await repositoryPair('production');
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
