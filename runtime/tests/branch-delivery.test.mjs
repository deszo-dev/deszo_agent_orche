import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { deliveryManifestDigest, executeBranchDelivery } from '../core/branchDelivery.mjs';
import { canonicalHash } from '../core/canonical.mjs';
import { Store, nowIso } from '../core/store.mjs';

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
  const root = join(tmpdir(), `deszo-test-repo-${randomUUID()}`);
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
  const { root } = createFixtureRepo(), cloneDir = join(tmpdir(), `deszo-clone-${randomUUID()}`);
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

test('A1: delivery yields to the event loop while a verification check is running', async () => {
  const { root, baseCommit } = createFixtureRepo();
  const cloneDir = join(tmpdir(), `deszo-clone-${randomUUID()}`);
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
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1: Stop during smoke terminates the check and prevents the ref from being published', async () => {
  const { root, baseCommit } = createFixtureRepo();
  const cloneDir = join(tmpdir(), `deszo-clone-${randomUUID()}`);
  try {
    const hung = { id: 'hung-check', command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'], expectedExitCode: 0 };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    const startedAt = Date.now();
    const result = await executeBranchDelivery({ plan: planFor(root, baseCommit, { verificationChecks: [hung] }), candidateFiles: CANDIDATE, cloneDir, signal: controller.signal });
    clearTimeout(timer);
    assert.ok(Date.now() - startedAt < 20000, 'The stopped verification check was not terminated promptly.');
    assert.equal(result.status, 'stopped');
    assert.equal(result.refUpdated, false);
    assert.equal(result.readyForMerge, false);
    assert.equal(refExists(root, 'refs/heads/feature/live'), false, 'A stopped delivery published the target ref.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('A6: a target checked out during smoke is refused at publication and the caller checkout stays clean', async () => {
  const { root, baseCommit } = createFixtureRepo();
  const cloneDir = join(tmpdir(), `deszo-clone-${randomUUID()}`);
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
    rmSync(root, { recursive: true, force: true });
  }
});

test('A3: hooks:none covers host ref publication, so a host reference-transaction hook does not run', async () => {
  const { root, baseCommit } = createFixtureRepo();
  const cloneDir = join(tmpdir(), `deszo-clone-${randomUUID()}`);
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

    const cloneDir = join(tmpdir(), `deszo-clone-${randomUUID()}`);
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

    const cloneDir = join(tmpdir(), `deszo-clone-${randomUUID()}`);
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
  const cloneDir = join(tmpdir(), `deszo-clone-${randomUUID()}`);
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
  const cloneDir = join(tmpdir(), `deszo-clone-${randomUUID()}`);
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
  const cloneDir = join(tmpdir(), `deszo-clone-r2-${randomUUID()}`);
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
  const cloneDir = join(tmpdir(), `deszo-clone-r3-${randomUUID()}`);

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
  const cloneDir = join(tmpdir(), `deszo-clone-r4-${randomUUID()}`);

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
  const cloneDir = join(tmpdir(), `deszo-clone-r5-${randomUUID()}`);

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
  const storeRoot = join(resolve(import.meta.dirname, '../../.deszo/tests'), `branch-store-${randomUUID()}`);
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


