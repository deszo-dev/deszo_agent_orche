import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { deliveryManifestDigest, executeBranchDelivery, runBranchDeliveryProcess } from '../core/branchDelivery.mjs';
import { canonicalHash } from '../core/canonical.mjs';
import { Store, nowIso } from '../core/store.mjs';
import { ownedPath } from './test-roots.mjs';

function computeCandidateDigest(files = []) {
  const manifest = files.map(f => ({
    path: f.path.replace(/\\/g, '/'),
    digest: canonicalHash(f.content),
  })).sort((a, b) => a.path.localeCompare(b.path));
  return canonicalHash(manifest);
}

function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  return res.stdout.trim();
}

function createFixtureRepo() {
  const root = ownedPath(join(tmpdir(), `deszo-test-repo-${randomUUID()}`));
  mkdirSync(root, { recursive: true });
  git(['init', '-b', 'main'], root);
  git(['config', 'user.name', 'Fixture Author'], root);
  git(['config', 'user.email', 'author@example.com'], root);

  const initFile = join(root, 'README.md');
  writeFileSync(initFile, '# Test Repo\n');
  git(['add', 'README.md'], root);
  git(['commit', '-m', 'Initial commit'], root);

  const baseCommit = git(['rev-parse', 'HEAD'], root);
  return { root, baseCommit };
}

const CANDIDATE = [{ path: 'approved.txt', content: 'APPROVED\n' }];

test('manifest v2 delivers the complete binary/deletion/executable-mode tree, including spaced Unicode paths', async () => {
  const { root } = createFixtureRepo(), cloneDir = ownedPath(join(tmpdir(), `deszo-clone-${randomUUID()}`));
  try {
    writeFileSync(join(root, 'obsolete.txt'), 'old'); writeFileSync(join(root, 'run.sh'), '#!/bin/sh\nexit 0\n');
    git(['add', '.'], root); git(['update-index', '--chmod=+x', '--', 'run.sh'], root); git(['commit', '-m', 'files and mode'], root);
    const baseCommit = git(['rev-parse', 'HEAD'], root);
    const files = [{ path: 'README.md', content: Buffer.from('# Test Repo\n'), mode: '100644' }, { path: 'run.sh', content: Buffer.from('#!/bin/sh\nexit 0\n'), mode: '100755' }, { path: 'данные file.bin', content: Buffer.from([0, 255, 128, 10, 13, 0]), mode: '100644' }, { path: 'obsolete.txt', operation: 'delete', content: null, mode: '100644' }];
    const plan = { ...planFor(root, baseCommit), manifestVersion: 2, candidateDigest: deliveryManifestDigest(files, 2) };
    const result = await executeBranchDelivery({ plan, candidateFiles: files, cloneDir });
    assert.equal(result.status, 'READY_FOR_MERGE', result.environmentSmokeReport.diagnostics);
    const binary = spawnSync('git', ['cat-file', 'blob', `${result.verifiedCommitId}:данные file.bin`], { cwd: root, windowsHide: true });
    assert.equal(binary.status, 0); assert.deepEqual(binary.stdout, files[2].content);
    assert.match(git(['ls-tree', result.verifiedCommitId, '--', 'run.sh'], root), /^100755 /);
    assert.equal(git(['ls-tree', result.verifiedCommitId, '--', 'obsolete.txt'], root), '');
    assert.equal(git(['status', '--porcelain'], root), '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function planFor(root, baseCommit, { targetBranchRef = 'refs/heads/feature/live', branchExpectedOldValue = null, verificationChecks = [], hookPolicy } = {}) {
  return {
    schemaVersion: 1,
    kind: 'DeliveryPlan',
    deliveryPlanId: `PLAN-${randomUUID().slice(0, 8)}`,
    runId: randomUUID(),
    candidateDigest: computeCandidateDigest(CANDIDATE),
    repositoryPath: root,
    baseCommit,
    targetBranchRef,
    branchExpectedOldValue,
    isolation: { mode: 'separate_clone', cloneStrategy: 'reference_dissociate' },
    hookPolicy: hookPolicy ?? { installHooks: false, hookSource: null, hooksJournal: 'none' },
    verificationChecks,
    commitPolicy: { authorName: 'Tester', authorEmail: 'test@example.com', message: 'Test delivery' },
    boundaryCriteria: [{ id: 'BC-1', description: 'Clean commit' }],
    createdAt: nowIso(),
  };
}

function refExists(root, ref) {
  return spawnSync('git', ['rev-parse', '--verify', ref], { cwd: root, windowsHide: true }).status === 0;
}

function temporaryHookDirectories() {
  return readdirSync(tmpdir()).filter(name => /^deszo-(?:empty-hooks|hooks)-/.test(name)).map(name => join(tmpdir(), name));
}

function removeFixtureDirectory(path, { maxRetries = 10, retryDelay = 200 } = {}) {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true, maxRetries, retryDelay });
}

function capturingProcessRunner(paths, { failClone = false } = {}) {
  return async (command, args, options = {}) => {
    for (const argument of args) if (argument.startsWith('core.hooksPath=')) paths.add(argument.slice('core.hooksPath='.length).replace(/\//g, '\\'));
    const cloneIndex = args.indexOf('clone');
    if (cloneIndex >= 0 && failClone) {
      return runBranchDeliveryProcess(command, [...args.slice(0, cloneIndex + 1), '--not-a-git-clone-option'], options);
    }
    if (cloneIndex >= 0) {
      const source = args[args.indexOf('--dissociate') + 1];
      const destination = args.at(-1);
      const branch = git(['symbolic-ref', '--short', 'HEAD'], source);
      git(['init', '-b', branch], destination);
      mkdirSync(join(destination, '.git', 'objects', 'info'), { recursive: true });
      writeFileSync(join(destination, '.git', 'objects', 'info', 'alternates'), `${join(source, '.git', 'objects').replace(/\\/g, '/')}\n`);
      return { status: 0, signal: null, timedOut: false, aborted: false, truncated: false, error: null, stdout: '', stderr: '' };
    }
    const fetchIndex = args.indexOf('fetch');
    if (fetchIndex >= 0) {
      // The sandbox blocks Git's local upload-pack helper; pack/unpack the same verified object graph locally.
      const source = args.at(-2); const commit = args.at(-1);
      const pack = spawnSync('git', ['pack-objects', '--stdout', '--revs'], { cwd: source, input: `${commit}\n`, encoding: null, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      if (pack.status !== 0) return { status: pack.status, signal: pack.signal, timedOut: false, aborted: false, truncated: false, error: pack.error ?? null, stdout: pack.stdout ?? Buffer.alloc(0), stderr: pack.stderr ?? '' };
      const unpack = spawnSync('git', ['unpack-objects'], { cwd: options.cwd, input: pack.stdout, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      return { status: unpack.status, signal: unpack.signal, timedOut: false, aborted: false, truncated: false, error: unpack.error ?? null, stdout: unpack.stdout ?? '', stderr: unpack.stderr ?? '' };
    }
    return runBranchDeliveryProcess(command, args, options);
  };
}

test('RL-A01/A06: successful delivery releases private hook directories and preserves the user hook source', async () => {
  const { root, baseCommit } = createFixtureRepo();
  const cloneDir = ownedPath(join(tmpdir(), `deszo-clone-${randomUUID()}`));
  const hookSource = ownedPath(join(tmpdir(), `deszo-user-hooks-${randomUUID()}`));
  mkdirSync(hookSource);
  const sourceFile = join(hookSource, 'keep-this-file.txt');
  writeFileSync(sourceFile, 'user-owned hook source\n');
  const hookPaths = new Set();
  try {
    const result = await executeBranchDelivery({
      plan: planFor(root, baseCommit, { hookPolicy: { installHooks: true, hookSource, hooksJournal: 'installed' } }),
      candidateFiles: CANDIDATE,
      cloneDir,
      processRunner: capturingProcessRunner(hookPaths),
    });
    assert.equal(result.status, 'READY_FOR_MERGE', result.environmentSmokeReport.diagnostics);
    assert.equal(hookPaths.size, 2, 'Git should receive the private clone hooks path and the empty host hooks path.');
    assert.ok([...hookPaths].every(path => !existsSync(path)), `A private hooks directory remained: ${[...hookPaths].filter(existsSync).join(', ')}`);
    assert.equal(readFileSync(sourceFile, 'utf8'), 'user-owned hook source\n');
  } finally { removeFixtureDirectory(root); removeFixtureDirectory(cloneDir); removeFixtureDirectory(hookSource); }
});

test('RL-A02: actual Git failure keeps its diagnostic and releases the exact hooks directory', async () => {
  const { root, baseCommit } = createFixtureRepo();
  const cloneDir = ownedPath(join(tmpdir(), `deszo-clone-${randomUUID()}`));
  const hookPaths = new Set();
  try {
    const result = await executeBranchDelivery({
      plan: planFor(root, baseCommit),
      candidateFiles: CANDIDATE,
      cloneDir,
      processRunner: capturingProcessRunner(hookPaths, { failClone: true }),
    });
    assert.equal(result.status, 'delivery_failed');
    assert.match(result.environmentSmokeReport.diagnostics, /Failed to create isolated delivery clone:/);
    assert.match(result.environmentSmokeReport.diagnostics, /not-a-git-clone-option/i);
    assert.equal(hookPaths.size, 1);
    assert.ok([...hookPaths].every(path => !existsSync(path)), `A hooks directory remained after failure: ${[...hookPaths].filter(existsSync).join(', ')}`);
  } finally { removeFixtureDirectory(root); removeFixtureDirectory(cloneDir); }
});

test('RL-A03: an early return after hooks allocation leaves no temporary hooks root', async () => {
  const { root, baseCommit } = createFixtureRepo();
  const cloneDir = ownedPath(join(tmpdir(), `deszo-clone-${randomUUID()}`));
  const before = new Set(temporaryHookDirectories());
  try {
    const result = await executeBranchDelivery({
      plan: planFor(root, baseCommit, { hookPolicy: { installHooks: true, hookSource: join(tmpdir(), `missing-hooks-${randomUUID()}`), hooksJournal: 'installed' } }),
      candidateFiles: CANDIDATE,
      cloneDir,
    });
    assert.equal(result.status, 'precondition_failed');
    const leaked = temporaryHookDirectories().filter(path => !before.has(path));
    assert.deepEqual(leaked, [], `An exact temporary hooks path remained after the early return: ${leaked.join(', ')}`);
  } finally { removeFixtureDirectory(root); removeFixtureDirectory(cloneDir); }
});

test('RL-A04: concurrent deliveries receive distinct roots and each releases its own hooks path', async () => {
  const { root, baseCommit } = createFixtureRepo();
  const firstClone = ownedPath(join(tmpdir(), `deszo-clone-${randomUUID()}`));
  const secondClone = ownedPath(join(tmpdir(), `deszo-clone-${randomUUID()}`));
  const hookPaths = new Set();
  try {
    const runner = capturingProcessRunner(hookPaths);
    const [first, second] = await Promise.all([
      executeBranchDelivery({ plan: planFor(root, baseCommit, { targetBranchRef: 'refs/heads/feature/concurrent-one' }), candidateFiles: CANDIDATE, cloneDir: firstClone, processRunner: runner }),
      executeBranchDelivery({ plan: planFor(root, baseCommit, { targetBranchRef: 'refs/heads/feature/concurrent-two' }), candidateFiles: CANDIDATE, cloneDir: secondClone, processRunner: runner }),
    ]);
    assert.equal(first.status, 'READY_FOR_MERGE', first.environmentSmokeReport.diagnostics);
    assert.equal(second.status, 'READY_FOR_MERGE', second.environmentSmokeReport.diagnostics);
    assert.equal(hookPaths.size, 2, 'Concurrent operations must not share a temporary hooks path.');
    assert.ok([...hookPaths].every(path => !existsSync(path)), `A concurrent hooks directory remained: ${[...hookPaths].filter(existsSync).join(', ')}`);
  } finally { removeFixtureDirectory(root); removeFixtureDirectory(firstClone); removeFixtureDirectory(secondClone); }
});

test('RL-A07: cleanup refuses a real directory substituted at the allocated path', async () => {
  const { root, baseCommit } = createFixtureRepo();
  const cloneDir = ownedPath(join(tmpdir(), `deszo-clone-${randomUUID()}`));
  let hooksPath = null;
  try {
    const actualRunner = capturingProcessRunner(new Set());
    const processRunner = (command, args, options) => {
      const setting = args.find(argument => argument.startsWith('core.hooksPath='));
      if (!hooksPath && setting) {
        hooksPath = setting.slice('core.hooksPath='.length).replace(/\//g, '\\');
        rmdirSync(hooksPath);
        mkdirSync(hooksPath);
        writeFileSync(join(hooksPath, 'replacement-data.txt'), 'preserve replacement\n');
        return { status: 1, signal: null, timedOut: false, aborted: false, truncated: false, error: null, stdout: '', stderr: 'injected Git failure' };
      }
      return actualRunner(command, args, options);
    };
    const result = await executeBranchDelivery({ plan: planFor(root, baseCommit), candidateFiles: CANDIDATE, cloneDir, processRunner });
    assert.equal(result.status, 'delivery_failed');
    assert.match(result.environmentSmokeReport.diagnostics, /refused: temporary hooks path identity changed after allocation/i);
    assert.ok(lstatSync(hooksPath).isDirectory());
    assert.equal(readFileSync(join(hooksPath, 'replacement-data.txt'), 'utf8'), 'preserve replacement\n');
  } finally {
    if (hooksPath && existsSync(hooksPath)) rmSync(hooksPath, { recursive: true, force: true });
    removeFixtureDirectory(root);
    removeFixtureDirectory(cloneDir);
  }
});

test('RL-A05: cancellation waits for an owned child using the temporary Git hooks directory during fetch', async () => {
  const { root, baseCommit } = createFixtureRepo();
  const cloneDir = ownedPath(join(tmpdir(), `deszo-clone-${randomUUID()}`));
  const marker = join(root, 'hook-consumer-started.txt');
  const vanished = join(root, 'hook-consumer-path-vanished.txt');
  const controller = new AbortController();
  const hookPaths = new Set();
  let childOutcome = null;
  let operation = null;
  let childStarted = false;
  let probeObserved = false;
  let hooksPath = null;
  try {
    const gitRunner = capturingProcessRunner(hookPaths);
    const processRunner = async (command, args, options = {}) => {
      if (command === 'git' && args.includes('fetch')) {
        const setting = args.find(argument => argument.startsWith('core.hooksPath='));
        const hooksPath = setting?.slice('core.hooksPath='.length).replace(/\//g, '\\');
        assert.ok(hooksPath, 'The fetch did not receive its operation-owned hooks path.');
        hookPaths.add(hooksPath);
        const hookFile = join(hooksPath, 'active-process-probe.txt');
        writeFileSync(hookFile, 'this operation-owned hooks path is in use\n');
        const consumer = `const fs=require('node:fs'); const hook=${JSON.stringify(hookFile)}; const marker=${JSON.stringify(marker)}; const vanished=${JSON.stringify(vanished)}; fs.writeFileSync(marker,'started'); setInterval(()=>{try{fs.readFileSync(hook)}catch{fs.writeFileSync(vanished,'missing');process.exit(17)}},20); setTimeout(()=>process.exit(0),750);`;
        childOutcome = await runBranchDeliveryProcess(process.execPath, ['-e', consumer], options);
        return childOutcome;
      }
      return gitRunner(command, args, options);
    };
    operation = executeBranchDelivery({
      plan: planFor(root, baseCommit),
      candidateFiles: CANDIDATE,
      cloneDir,
      signal: controller.signal,
      processRunner,
    });
    const deadline = Date.now() + 10_000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
    childStarted = existsSync(marker);
    hooksPath = [...hookPaths][0] ?? null;
    probeObserved = Boolean(hooksPath && existsSync(join(hooksPath, 'active-process-probe.txt')));
    controller.abort();
    const result = await operation;
    assert.equal(hookPaths.size, 1, 'RL-A05 must track only its one operation-owned hooks directory.');
    assert.ok(childStarted, `The hook consumer child never started: ${result.environmentSmokeReport.diagnostics}`);
    assert.ok(probeObserved, 'The owned child could not observe its hooks directory while running.');
    assert.ok(childOutcome?.aborted, 'The owned child did not report cancellation.');
    assert.notEqual(childOutcome?.processActive, true, 'The owned child was still active when the operation returned.');
    assert.equal(existsSync(vanished), false, 'The temporary hooks path disappeared while its owned child was using it.');
    assert.equal(result.status, 'stopped');
    if (childOutcome.terminationError) {
      assert.match(result.environmentSmokeReport.diagnostics, /Temporary Git hooks directory cleanup deferred/i);
      assert.match(result.environmentSmokeReport.diagnostics, /taskkill exited with 1:.*user name or password is incorrect/i);
      assert.ok(existsSync(hooksPath), 'The operation-owned hooks directory was removed after process-tree termination failed.');
    } else {
      assert.equal(existsSync(hooksPath), false, 'The operation-owned hooks directory remained after the Git process tree settled.');
    }
  } finally {
    controller.abort();
    if (operation) await operation.catch(() => {});
    // This test consumer is a single Node child with no descendants. Only after the runner reports its close
    // (or successful tree termination) is it safe for the fixture to remove its exact intentionally preserved path.
    if (childOutcome && childOutcome.processActive !== true) {
      for (const path of hookPaths) {
        if (existsSync(path)) rmSync(path, { recursive: true, force: false, maxRetries: 10, retryDelay: 200 });
      }
    }
    removeFixtureDirectory(root);
    removeFixtureDirectory(cloneDir, { maxRetries: 30, retryDelay: 250 });
  }
});

test('A1: delivery yields to the event loop while a verification check is running', async () => {
  const { root, baseCommit } = createFixtureRepo();
  const cloneDir = ownedPath(join(tmpdir(), `deszo-clone-${randomUUID()}`));
  try {
    const slow = { id: 'slow-check', command: process.execPath, args: ['-e', 'setTimeout(() => {}, 1500)'], expectedExitCode: 0 };
    let callbackAt = null;
    let refAtCallback = null;
    const timer = setTimeout(() => {
      callbackAt = Date.now();
      refAtCallback = refExists(root, 'refs/heads/feature/live');
    }, 300);
    const result = await executeBranchDelivery({ plan: planFor(root, baseCommit, { verificationChecks: [slow] }), candidateFiles: CANDIDATE, cloneDir });
    const returnedAt = Date.now();
    clearTimeout(timer);
    assert.equal(result.status, 'READY_FOR_MERGE');
    assert.ok(callbackAt !== null && callbackAt < returnedAt, 'The runtime callback did not run before delivery returned.');
    assert.equal(refAtCallback, false, 'The target ref was published before the callback ran during smoke.');
  } finally {
    removeFixtureDirectory(root);
    removeFixtureDirectory(cloneDir);
  }
});

test('A1: Stop during smoke terminates the check and prevents the ref from being published', async () => {
  const { root, baseCommit } = createFixtureRepo();
  const cloneDir = ownedPath(join(tmpdir(), `deszo-clone-${randomUUID()}`));
  const hooksBefore = new Set(temporaryHookDirectories());
  try {
    const hung = { id: 'hung-check', command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'], expectedExitCode: 0 };
    const controller = new AbortController();
    let smokeStarted = false;
    const gitRunner = capturingProcessRunner(new Set());
    const processRunner = (command, args, options) => {
      if (command === process.execPath && args[0] === '-e') {
        smokeStarted = true;
        setTimeout(() => controller.abort(), 500);
      }
      return gitRunner(command, args, options);
    };
    const startedAt = Date.now();
    const result = await executeBranchDelivery({ plan: planFor(root, baseCommit, { verificationChecks: [hung] }), candidateFiles: CANDIDATE, cloneDir, signal: controller.signal, processRunner });
    assert.ok(smokeStarted, 'Delivery did not reach the verification check before cancellation.');
    assert.ok(Date.now() - startedAt < 20000, 'The stopped verification check was not terminated promptly.');
    assert.equal(result.status, 'stopped');
    assert.equal(result.refUpdated, false);
    assert.equal(result.readyForMerge, false);
    assert.equal(refExists(root, 'refs/heads/feature/live'), false, 'A stopped delivery published the target ref.');
    const leaked = temporaryHookDirectories().filter(path => !hooksBefore.has(path));
    assert.deepEqual(leaked, [], `An exact hooks path remained after cancellation settled: ${leaked.join(', ')}`);
  } finally {
    removeFixtureDirectory(root);
    removeFixtureDirectory(cloneDir);
  }
});

test('A6: a target checked out during smoke is refused at publication and the caller checkout stays clean', async () => {
  const { root, baseCommit } = createFixtureRepo();
  const cloneDir = ownedPath(join(tmpdir(), `deszo-clone-${randomUUID()}`));
  try {
    git(['branch', 'codex/audit', baseCommit], root);
    const checkout = { id: 'simulate-checkout', command: 'git', args: ['-C', root, 'checkout', 'codex/audit'], expectedExitCode: 0 };
    const plan = planFor(root, baseCommit, { targetBranchRef: 'refs/heads/codex/audit', branchExpectedOldValue: baseCommit, verificationChecks: [checkout] });
    const result = await executeBranchDelivery({ plan, candidateFiles: CANDIDATE, cloneDir });
    assert.equal(result.status, 'precondition_failed');
    assert.equal(result.readyForMerge, false);
    assert.equal(git(['rev-parse', 'refs/heads/codex/audit'], root), baseCommit);
    assert.equal(git(['status', '--porcelain'], root), '', 'Publication dirtied the caller checkout.');
  } finally {
    removeFixtureDirectory(root);
    removeFixtureDirectory(cloneDir);
  }
});

test('A3: hooks:none covers host ref publication, so a host reference-transaction hook does not run', async () => {
  const { root, baseCommit } = createFixtureRepo();
  const cloneDir = ownedPath(join(tmpdir(), `deszo-clone-${randomUUID()}`));
  try {
    const hooks = join(root, '.git', 'hooks');
    const marker = join(tmpdir(), `host-hook-${randomUUID()}.txt`).replace(/\\/g, '/');
    git(['config', 'core.hooksPath', hooks], root);
    writeFileSync(join(hooks, 'reference-transaction'), `#!/bin/sh\nprintf 'ran\\n' >> "${marker}"\nexit 0\n`, { mode: 0o755 });
    const result = await executeBranchDelivery({ plan: planFor(root, baseCommit), candidateFiles: CANDIDATE, cloneDir });
    assert.equal(result.status, 'READY_FOR_MERGE');
    assert.equal(existsSync(marker), false, 'The host reference-transaction hook ran while delivery reported hooks:none.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ADR5-02: Precondition fails if new branch already exists (destination collision)', async () => {
  const { root, baseCommit } = createFixtureRepo();
  try {
    // Create branch beforehand
    git(['branch', 'feature/test', baseCommit], root);

    const plan = {
      schemaVersion: 1,
      kind: 'DeliveryPlan',
      deliveryPlanId: 'PLAN-001',
      runId: randomUUID(),
      candidateDigest: computeCandidateDigest([]),
      repositoryPath: root,
      baseCommit,
      targetBranchRef: 'refs/heads/feature/test',
      branchExpectedOldValue: null, // Claims it is a new branch
      isolation: { mode: 'separate_clone', cloneStrategy: 'reference_dissociate' },
      hookPolicy: { installHooks: false, hookSource: null, hooksJournal: 'none' },
      verificationChecks: [],
      commitPolicy: { authorName: 'Tester', authorEmail: 'test@example.com', message: 'Test delivery' },
      boundaryCriteria: [{ id: 'BC-1', description: 'Clean commit' }],
      createdAt: nowIso(),
    };

    const cloneDir = ownedPath(join(tmpdir(), `deszo-clone-${randomUUID()}`));
    const res = await executeBranchDelivery({ plan, candidateFiles: [], cloneDir });

    assert.equal(res.status, 'precondition_failed');
    assert.ok(res.environmentSmokeReport.diagnostics.includes('Destination collision'));
    assert.equal(res.readyForMerge, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ADR5-02 / ADR5-06: Precondition fails if target branch moved unexpectedly (ref conflict)', async () => {
  const { root, baseCommit } = createFixtureRepo();
  try {
    git(['branch', 'feature/existing', baseCommit], root);

    const plan = {
      schemaVersion: 1,
      kind: 'DeliveryPlan',
      deliveryPlanId: 'PLAN-002',
      runId: randomUUID(),
      candidateDigest: computeCandidateDigest([]),
      repositoryPath: root,
      baseCommit,
      targetBranchRef: 'refs/heads/feature/existing',
      branchExpectedOldValue: '0'.repeat(40), // Wrong expected commit
      isolation: { mode: 'separate_clone', cloneStrategy: 'reference_dissociate' },
      hookPolicy: { installHooks: false, hookSource: null, hooksJournal: 'none' },
      verificationChecks: [],
      commitPolicy: { authorName: 'Tester', authorEmail: 'test@example.com', message: 'Test delivery' },
      boundaryCriteria: [{ id: 'BC-1', description: 'Clean commit' }],
      createdAt: nowIso(),
    };

    const cloneDir = ownedPath(join(tmpdir(), `deszo-clone-${randomUUID()}`));
    const res = await executeBranchDelivery({ plan, candidateFiles: [], cloneDir });

    assert.equal(res.status, 'ref_conflict');
    assert.ok(res.environmentSmokeReport.diagnostics.includes('Target branch "refs/heads/feature/existing" has moved'));
    assert.equal(res.readyForMerge, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ADR5-01–05: Successful branch delivery applies candidate, verifies smoke, commits and updates ref to READY_FOR_MERGE', async () => {
  const { root, baseCommit } = createFixtureRepo();
  const cloneDir = ownedPath(join(tmpdir(), `deszo-clone-${randomUUID()}`));
  try {
    const candidateFiles = [
      { path: 'src/index.js', content: 'console.log("hello world");\n' },
      { path: 'package.json', content: '{"name": "fixture"}\n' },
    ];

    const plan = {
      schemaVersion: 1,
      kind: 'DeliveryPlan',
      deliveryPlanId: 'PLAN-003',
      runId: randomUUID(),
      candidateDigest: computeCandidateDigest(candidateFiles),
      repositoryPath: root,
      baseCommit,
      targetBranchRef: 'refs/heads/codex/feature-branch',
      branchExpectedOldValue: null,
      isolation: { mode: 'separate_clone', cloneStrategy: 'reference_dissociate' },
      hookPolicy: { installHooks: false, hookSource: null, hooksJournal: 'none' },
      verificationChecks: [
        { id: 'git-status-check', command: 'git', args: ['status', '--porcelain'], expectedExitCode: 0 },
      ],
      commitPolicy: {
        authorName: 'Verified Bot',
        authorEmail: 'bot@example.com',
        message: 'feat: add verified candidate',
      },
      boundaryCriteria: [{ id: 'BC-1', description: 'Candidate applied and committed' }],
      createdAt: nowIso(),
    };

    const res = await executeBranchDelivery({ plan, candidateFiles, cloneDir });

    assert.equal(res.status, 'READY_FOR_MERGE');
    assert.equal(res.readyForMerge, true);
    assert.equal(res.refUpdated, true);
    assert.ok(res.verifiedCommitId);
    assert.equal(res.sourceCommit, baseCommit);
    assert.equal(res.environmentSmokeReport.passed, true);
    assert.equal(res.hookExecution.status, 'none');

    // Verify host repository ref updated to verified commit
    const updatedCommit = git(['rev-parse', 'refs/heads/codex/feature-branch'], root);
    assert.equal(updatedCommit, res.verifiedCommitId);

    // Verify host repo working tree was UNTOUCHED (still only README.md, no src/index.js)
    const hostStatus = git(['status', '--porcelain'], root);
    assert.equal(hostStatus, '', 'Host repository working tree must remain clean and untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cloneDir, { recursive: true, force: true });
  }
});

test('ADR5-04: Environment smoke check failure blocks commit and merge readiness', async () => {
  const { root, baseCommit } = createFixtureRepo();
  const cloneDir = ownedPath(join(tmpdir(), `deszo-clone-${randomUUID()}`));
  try {
    const plan = {
      schemaVersion: 1,
      kind: 'DeliveryPlan',
      deliveryPlanId: 'PLAN-004',
      runId: randomUUID(),
      candidateDigest: computeCandidateDigest([]),
      repositoryPath: root,
      baseCommit,
      targetBranchRef: 'refs/heads/feature/fail-check',
      branchExpectedOldValue: null,
      isolation: { mode: 'separate_clone', cloneStrategy: 'reference_dissociate' },
      hookPolicy: { installHooks: false, hookSource: null, hooksJournal: 'none' },
      verificationChecks: [
        // Intentionally failing check (expected exit 0, but exits non-zero)
        { id: 'failing-test', command: 'git', args: ['log', '--invalid-flag-that-fails'], expectedExitCode: 0 },
      ],
      commitPolicy: { authorName: 'Tester', authorEmail: 'test@example.com', message: 'Failing check' },
      boundaryCriteria: [{ id: 'BC-1', description: 'Checks must pass' }],
      createdAt: nowIso(),
    };

    const res = await executeBranchDelivery({ plan, candidateFiles: [], cloneDir });

    assert.equal(res.status, 'verification_failed');
    assert.equal(res.readyForMerge, false);
    assert.equal(res.refUpdated, false);
    assert.equal(res.environmentSmokeReport.passed, false);
    assert.ok(res.environmentSmokeReport.diagnostics.includes('failing-test'));

    // Target branch must NOT have been created
    const probe = spawnSync('git', ['rev-parse', '--verify', 'refs/heads/feature/fail-check'], { cwd: root });
    assert.notEqual(probe.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cloneDir, { recursive: true, force: true });
  }
});

test('R2: Refuses existing destination clone directory without deleting existing files', async () => {
  const { root, baseCommit } = createFixtureRepo();
  const cloneDir = ownedPath(join(tmpdir(), `deszo-clone-r2-${randomUUID()}`));
  mkdirSync(cloneDir, { recursive: true });
  const sentinel = join(cloneDir, 'user-data.txt');
  writeFileSync(sentinel, 'PRESERVE ME');

  try {
    const plan = {
      schemaVersion: 1,
      kind: 'DeliveryPlan',
      deliveryPlanId: 'PLAN-R2',
      runId: randomUUID(),
      candidateDigest: computeCandidateDigest([]),
      repositoryPath: root,
      baseCommit,
      targetBranchRef: 'refs/heads/feature/r2',
      branchExpectedOldValue: null,
      isolation: { mode: 'separate_clone', cloneStrategy: 'reference_dissociate' },
      hookPolicy: { installHooks: false, hookSource: null, hooksJournal: 'none' },
      verificationChecks: [],
      commitPolicy: { authorName: 'Tester', authorEmail: 'test@example.com', message: 'Test R2' },
      boundaryCriteria: [{ id: 'BC-1', description: 'Destination ownership' }],
      createdAt: nowIso(),
    };

    const res = await executeBranchDelivery({ plan, candidateFiles: [], cloneDir });
    assert.equal(res.status, 'precondition_failed');
    assert.ok(res.environmentSmokeReport.diagnostics.includes('Destination directory already exists'));
    assert.ok(existsSync(sentinel), 'Existing sentinel file must be preserved');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cloneDir, { recursive: true, force: true });
  }
});

test('R3: Candidate path traversal is rejected before write', async () => {
  const { root, baseCommit } = createFixtureRepo();
  const cloneDir = ownedPath(join(tmpdir(), `deszo-clone-r3-${randomUUID()}`));

  try {
    const candidateFiles = [{ path: '../escape.txt', content: 'MALICIOUS' }];
    const plan = {
      schemaVersion: 1,
      kind: 'DeliveryPlan',
      deliveryPlanId: 'PLAN-R3',
      runId: randomUUID(),
      candidateDigest: computeCandidateDigest(candidateFiles),
      repositoryPath: root,
      baseCommit,
      targetBranchRef: 'refs/heads/feature/r3',
      branchExpectedOldValue: null,
      isolation: { mode: 'separate_clone', cloneStrategy: 'reference_dissociate' },
      hookPolicy: { installHooks: false, hookSource: null, hooksJournal: 'none' },
      verificationChecks: [],
      commitPolicy: { authorName: 'Tester', authorEmail: 'test@example.com', message: 'Test R3' },
      boundaryCriteria: [{ id: 'BC-1', description: 'Containment check' }],
      createdAt: nowIso(),
    };

    const res = await executeBranchDelivery({ plan, candidateFiles, cloneDir });
    assert.equal(res.status, 'precondition_failed');
    assert.ok(res.environmentSmokeReport.diagnostics.includes('Path traversal') || res.environmentSmokeReport.diagnostics.includes('relative'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('R4: Working tree mutation during smoke verification is rejected', async () => {
  const { root, baseCommit } = createFixtureRepo();
  const cloneDir = ownedPath(join(tmpdir(), `deszo-clone-r4-${randomUUID()}`));

  try {
    const candidateFiles = [{ path: 'valid.txt', content: 'VALID CONTENT\n' }];
    const plan = {
      schemaVersion: 1,
      kind: 'DeliveryPlan',
      deliveryPlanId: 'PLAN-R4',
      runId: randomUUID(),
      candidateDigest: computeCandidateDigest(candidateFiles),
      repositoryPath: root,
      baseCommit,
      targetBranchRef: 'refs/heads/feature/r4',
      branchExpectedOldValue: null,
      isolation: { mode: 'separate_clone', cloneStrategy: 'reference_dissociate' },
      hookPolicy: { installHooks: false, hookSource: null, hooksJournal: 'none' },
      verificationChecks: [
        {
          id: 'mutating-check',
          command: process.execPath,
          args: ['-e', 'require("fs").writeFileSync("unreviewed.txt", "DIRTY")'],
          expectedExitCode: 0,
        },
      ],
      commitPolicy: { authorName: 'Tester', authorEmail: 'test@example.com', message: 'Test R4' },
      boundaryCriteria: [{ id: 'BC-1', description: 'Integrity check' }],
      createdAt: nowIso(),
    };

    const res = await executeBranchDelivery({ plan, candidateFiles, cloneDir });
    assert.equal(res.status, 'verification_failed');
    assert.equal(res.readyForMerge, false);
    assert.ok(res.environmentSmokeReport.diagnostics.includes('undeclared or mutated'));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cloneDir, { recursive: true, force: true });
  }
});

test('R5: Existing branch delivery preserves ancestry and fast-forward history', async () => {
  const { root, baseCommit } = createFixtureRepo();
  const cloneDir = ownedPath(join(tmpdir(), `deszo-clone-r5-${randomUUID()}`));

  try {
    // Create existing branch with a commit
    git(['checkout', '-b', 'feature/existing-history'], root);
    writeFileSync(join(root, 'feature.txt'), 'Feature v1\n');
    git(['add', 'feature.txt'], root);
    git(['commit', '-m', 'Add feature v1'], root);
    const expectedOld = git(['rev-parse', 'HEAD'], root);
    git(['checkout', 'main'], root);

    const candidateFiles = [{ path: 'feature-v2.txt', content: 'Feature v2\n' }];
    const plan = {
      schemaVersion: 1,
      kind: 'DeliveryPlan',
      deliveryPlanId: 'PLAN-R5',
      runId: randomUUID(),
      candidateDigest: computeCandidateDigest(candidateFiles),
      repositoryPath: root,
      baseCommit: expectedOld,
      targetBranchRef: 'refs/heads/feature/existing-history',
      branchExpectedOldValue: expectedOld,
      isolation: { mode: 'separate_clone', cloneStrategy: 'reference_dissociate' },
      hookPolicy: { installHooks: false, hookSource: null, hooksJournal: 'none' },
      verificationChecks: [],
      commitPolicy: { authorName: 'Tester', authorEmail: 'test@example.com', message: 'Add feature v2' },
      boundaryCriteria: [{ id: 'BC-1', description: 'Ancestry check' }],
      createdAt: nowIso(),
    };

    const res = await executeBranchDelivery({ plan, candidateFiles, cloneDir });
    assert.equal(res.status, 'READY_FOR_MERGE');
    assert.equal(res.parentCommitId, expectedOld);

    // Verify existing feature.txt is still in the delivered branch
    const catCheck = spawnSync('git', ['cat-file', '-e', `${res.verifiedCommitId}:feature.txt`], { cwd: root });
    assert.equal(catCheck.status, 0, 'Previous feature commit must remain in branch history');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cloneDir, { recursive: true, force: true });
  }
});

test('R1: Store persists BranchDelivery result into m9 branch_deliveries table', async () => {
  const storeRoot = ownedPath(join(resolve(import.meta.dirname, '../../.deszo/tests'), `branch-store-${randomUUID()}`));
  mkdirSync(join(storeRoot, 'store'), { recursive: true });
  const store = new Store(storeRoot);
  try {
    const runId = randomUUID();
    store.run('PRAGMA foreign_keys = OFF;');
    store.run(
      'INSERT INTO runs(id, workflow_id, workspace_id, workflow_snapshot_artifact_id, settings_artifact_id, execution_hash, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      runId, 'wf-1', 'ws-1', 'art-1', 'art-2', 'a'.repeat(64), 'running', nowIso()
    );

    const deliveryResult = {
      schemaVersion: 1,
      kind: 'DeliveryResult',
      deliveryResultId: 'DELIV-PERSIST-1',
      deliveryPlanId: 'PLAN-1',
      status: 'READY_FOR_MERGE',
      sourceCommit: 'a'.repeat(40),
      verifiedCommitId: 'b'.repeat(40),
      treeId: 'c'.repeat(40),
      parentCommitId: 'd'.repeat(40),
      targetBranchRef: 'refs/heads/feature/deliv',
      refUpdated: true,
      canonicalManifestDigest: 'e'.repeat(64),
      environmentSmokeReport: { passed: true, exitCode: 0, diagnostics: 'Smoke passed.' },
      hookExecution: { status: 'none', journal: 'Hooks: none' },
      readyForMerge: true,
      completedAt: nowIso(),
    };

    const { deliveryResultId } = store.recordBranchDelivery(deliveryResult, runId);
    assert.equal(deliveryResultId, deliveryResult.deliveryResultId);

    const row = store.get('SELECT * FROM branch_deliveries WHERE id = ?', deliveryResultId);
    assert.ok(row);
    assert.equal(row.run_id, runId);
    assert.equal(row.status, 'READY_FOR_MERGE');
  } finally {
    store.close();
  }
});


