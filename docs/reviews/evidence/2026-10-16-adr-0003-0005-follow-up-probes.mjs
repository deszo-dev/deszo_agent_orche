import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalHash } from '../../../runtime/core/canonical.mjs';
import { executeBranchDelivery } from '../../../runtime/core/branchDelivery.mjs';
import { DEFAULT_DESZO_CRITICAL_AREAS, deriveSourceFacts, evaluateCandidateFloors, selectExecutionPlan } from '../../../runtime/core/taskAssessment.mjs';
import { buildContextPackage, evaluateAcceptanceRecord, handleContextNeededRequest } from '../../../runtime/core/contextPackage.mjs';
import { Store } from '../../../runtime/core/store.mjs';

// These checks assert required behavior and exit nonzero when a boundary fails.
// All Git changes occur in newly created fixture repositories, never in the checkout.
const checkout = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const scratch = mkdtempSync(join(tmpdir(), 'deszo-follow-up-'));
const results = [];
const inputs = [
  'runtime/core/branchDelivery.mjs', 'runtime/core/taskAssessment.mjs',
  'runtime/core/contextPackage.mjs', 'runtime/core/store.mjs',
  'docs/schemas/delivery-plan.schema.json', 'docs/schemas/acceptance-record.schema.json',
  'docs/schemas/execution-plan.schema.json', 'docs/storage/m9.sql',
];
const digest = path => createHash('sha256').update(readFileSync(join(checkout, path))).digest('hex');
const inputDigests = Object.fromEntries(inputs.map(path => [path, digest(path)]));
const now = '2026-10-16T12:00:00.000Z';

function git(args, cwd, required = true) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (required && result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.error?.message || result.stderr || result.stdout}`);
  return required ? result.stdout.trim() : result;
}
function fixture(name, baseFiles = []) {
  const host = join(scratch, name, 'host');
  mkdirSync(host, { recursive: true });
  git(['init', '-b', 'main'], host);
  git(['config', 'user.name', 'Review Fixture'], host);
  git(['config', 'user.email', 'fixture@example.com'], host);
  git(['config', 'core.autocrlf', 'false'], host);
  git(['config', 'commit.gpgSign', 'false'], host);
  writeFileSync(join(host, 'README.md'), 'BASE\n');
  for (const file of baseFiles) writeFileSync(join(host, file.path), file.content);
  git(['add', '.'], host);
  git(['commit', '-m', 'base'], host);
  return { host, base: git(['rev-parse', 'HEAD'], host), clone: join(scratch, name, 'clone') };
}
function deliveryPlan(repo, files, overrides = {}) {
  const manifest = files.map(f => ({ path: f.path.replace(/\\/g, '/'), digest: canonicalHash(f.content) })).sort((a, b) => a.path.localeCompare(b.path));
  return {
    schemaVersion: 1, kind: 'DeliveryPlan', deliveryPlanId: randomUUID(), runId: randomUUID(),
    candidateDigest: canonicalHash(manifest), repositoryPath: repo.host, baseCommit: repo.base,
    targetBranchRef: 'refs/heads/codex/fixture', branchExpectedOldValue: null,
    isolation: { mode: 'separate_clone', cloneStrategy: 'reference_dissociate' },
    hookPolicy: { installHooks: false, hookSource: null, hooksJournal: 'none' },
    verificationChecks: [], commitPolicy: { authorName: 'Review Fixture', authorEmail: 'fixture@example.com', message: 'delivery' },
    boundaryCriteria: [{ id: 'BR-1', description: 'Exact candidate delivered.' }], createdAt: now, ...overrides,
  };
}
const candidate = [{ path: 'approved.txt', content: 'APPROVED\n' }];
function assessment() {
  return {
    schemaVersion: 1, kind: 'TaskAssessment', assessmentId: 'ASSESS-FOLLOW-UP', assessmentRunId: randomUUID(),
    businessRequestId: 'BUSINESS-1', authorRole: 'analyst', sourceSnapshotHash: 'a'.repeat(64),
    intendedOutcome: 'Add a local setting', constraints: [], exclusions: [],
    requirements: [{ id: 'REQ-1', title: 'Setting', acceptanceCriteria: [{ id: 'AC-1', description: 'Setting works', requiredEvidence: 'Unit test', evidenceProducer: 'test-author' }] }],
    scope: { affectedComponents: ['src/local.js'] },
    sourceDerivedFacts: { criticalPaths: [], publicContracts: [], dependencyFanOut: 1 },
    assessmentAxes: { scopeCoupling: 'local', technicalDifficulty: 'low', failureImpact: 'limited', uncertainty: 'low', verifiability: 'clear' },
    grounds: { references: ['src/local.js'], assumptions: [], confidence: 'Recorded', unresolvedQuestions: [] },
    planningAdvice: { recommendedStages: [] }, createdAt: now,
  };
}
const roleBindings = {
  analyst: { role: 'analyst', provider: 'codex', model: 'gpt-6.1-sol', effort: 'max' },
  developer: { role: 'developer', provider: 'claude', model: 'claude-haiku-5-5', effort: 'xhigh' },
  testAuthor: { role: 'testAuthor', provider: 'claude', model: 'claude-haiku-5-5', effort: 'xhigh' },
  codeReviewer: { role: 'codeReviewer', provider: 'claude', model: 'claude-opus-5-5', effort: 'medium' },
  testReviewer: { role: 'testReviewer', provider: 'claude', model: 'claude-opus-5-5', effort: 'medium' },
  juniorAnalyst: { role: 'juniorAnalyst', provider: 'codex', model: 'gpt-6-luna', effort: 'max' },
};
const sourceFacts = deriveSourceFacts(['src/local.js'], { criticalAreas: DEFAULT_DESZO_CRITICAL_AREAS });
const confirmation = { confirmed: true, confirmedBy: 'codeReviewer', confirmedAt: now, reason: 'Local scope checked.' };
function planArgs(a = assessment()) { return { assessment: a, sourceFacts, roleBindings, reviewerConfirmation: confirmation }; }
async function probe(name, run) {
  const observed = {};
  try {
    await run(observed);
    results.push({ name, passed: true, observed });
  } catch (error) {
    results.push({ name, passed: false, observed, error: error.stack || String(error) });
  }
}

await probe('existing_directory_and_traversal_are_rejected', async observed => {
  const repo = fixture('containment');
  mkdirSync(repo.clone);
  const sentinel = join(repo.clone, 'sentinel.txt');
  writeFileSync(sentinel, 'PRESERVE');
  const existing = await executeBranchDelivery({ plan: deliveryPlan(repo, candidate), candidateFiles: candidate, cloneDir: repo.clone });
  const escaped = [{ path: '../outside.txt', content: 'NO' }];
  const traversal = await executeBranchDelivery({ plan: deliveryPlan(repo, escaped), candidateFiles: escaped, cloneDir: `${repo.clone}-other` });
  Object.assign(observed, { existingStatus: existing.status, sentinel: readFileSync(sentinel, 'utf8'), traversalStatus: traversal.status });
  assert.equal(existing.status, 'precondition_failed');
  assert.equal(readFileSync(sentinel, 'utf8'), 'PRESERVE');
  assert.equal(traversal.status, 'precondition_failed');
});

await probe('explicit_bindings_and_distinct_role_ids_are_required', async observed => {
  assert.throws(() => selectExecutionPlan({ ...planArgs(), roleBindings: null }), /Explicit role bindings required/);
  const duplicated = { ...roleBindings, testReviewer: { ...roleBindings.codeReviewer } };
  assert.throws(() => selectExecutionPlan({ ...planArgs(), roleBindings: duplicated }), /distinct roles/);
  observed.rejectionsConfirmed = true;
});

await probe('context_expansion_ignores_attempt_ids_and_retains_missing_dependencies', async observed => {
  const common = { role: 'codeReviewer', taskBinding: 'TASK-1', subjectDigest: 'a'.repeat(64), declaredScope: [] };
  const available = new Map([['helper.js', 'export const a=1;']]);
  const expand = id => handleContextNeededRequest({ contextPackage: buildContextPackage({ ...common, stepInstanceId: id }), request: { paths: ['helper.js'] }, availableArtifacts: available });
  const a = expand('A'), b = expand('B');
  assert.equal(a.widenedPackage.semanticFingerprint, b.widenedPackage.semanticFingerprint);
  const missing = handleContextNeededRequest({ contextPackage: a.widenedPackage, request: { paths: ['helper.js', 'missing.js'] }, availableArtifacts: available });
  Object.assign(observed, { sameExpandedFingerprint: true, resumed: missing.resumed, missing: missing.missing });
  assert.equal(missing.resumed, false);
  assert.deepEqual(missing.missing, ['missing.js']);
});

await probe('every_candidate_file_must_exist_in_the_commit', async observed => {
  const repo = fixture('ignored-candidate', [{ path: '.gitignore', content: 'ignored.txt\n' }]);
  const files = [...candidate, { path: 'ignored.txt', content: 'REQUIRED APPROVED CONTENT\n' }];
  const result = await executeBranchDelivery({ plan: deliveryPlan(repo, files), candidateFiles: files, cloneDir: repo.clone });
  const hasIgnored = result.verifiedCommitId ? git(['cat-file', '-e', `${result.verifiedCommitId}:ignored.txt`], repo.host, false).status === 0 : false;
  Object.assign(observed, { status: result.status, ready: result.readyForMerge, candidateFileCommitted: hasIgnored });
  assert.ok(!result.readyForMerge || hasIgnored, 'READY_FOR_MERGE omitted an approved candidate file after git add failed.');
});

await probe('undeclared_git_conversions_cannot_change_accepted_bytes', async observed => {
  const repo = fixture('git-conversion', [{ path: '.gitattributes', content: 'approved.txt text eol=lf\n' }]);
  const files = [{ path: 'approved.txt', content: 'APPROVED\r\n' }];
  const result = await executeBranchDelivery({ plan: deliveryPlan(repo, files), candidateFiles: files, cloneDir: repo.clone });
  const blob = result.verifiedCommitId ? git(['show', `${result.verifiedCommitId}:approved.txt`], repo.host, false).stdout : null;
  Object.assign(observed, { status: result.status, candidateContent: files[0].content, committedContent: blob });
  assert.ok(!result.readyForMerge || blob === files[0].content, 'READY_FOR_MERGE accepted a different blob without a captured transformation policy.');
});

await probe('smoke_must_not_verify_a_different_tracked_source_tree', async observed => {
  const repo = fixture('smoke-tracked-change');
  const plan = deliveryPlan(repo, candidate, { verificationChecks: [{ id: 'mutate-existing-source', command: process.execPath, args: ['-e', "require('fs').writeFileSync('README.md','SMOKE-ONLY SOURCE\\n')"], expectedExitCode: 0 }] });
  const result = await executeBranchDelivery({ plan, candidateFiles: candidate, cloneDir: repo.clone });
  Object.assign(observed, { status: result.status, statusAfterSmoke: git(['status', '--porcelain'], repo.clone, false).stdout, smokeSource: readFileSync(join(repo.clone, 'README.md'), 'utf8'), committedSource: result.verifiedCommitId ? git(['show', `${result.verifiedCommitId}:README.md`], repo.host, false).stdout : null });
  assert.equal(result.readyForMerge, false, 'READY_FOR_MERGE was published after smoke mutated a tracked source file.');
});

await probe('delivery_cannot_silently_switch_the_declared_base', async observed => {
  const repo = fixture('changed-base');
  git(['checkout', '-b', 'codex/existing'], repo.host);
  writeFileSync(join(repo.host, 'unapproved-base-input.txt'), 'NOT IN CAPTURED BASE\n');
  git(['add', '.'], repo.host); git(['commit', '-m', 'another source state'], repo.host);
  const targetHead = git(['rev-parse', 'HEAD'], repo.host);
  git(['checkout', 'main'], repo.host);
  const result = await executeBranchDelivery({ plan: deliveryPlan(repo, candidate, { targetBranchRef: 'refs/heads/codex/existing', branchExpectedOldValue: targetHead }), candidateFiles: candidate, cloneDir: repo.clone });
  Object.assign(observed, { status: result.status, declaredBase: repo.base, reportedSource: result.sourceCommit, actualParent: result.parentCommitId });
  assert.equal(result.readyForMerge, false, 'A different target head became the source without a new captured candidate/base.');
});

await probe('delivery_must_preserve_the_callers_checked_out_branch_state', async observed => {
  const repo = fixture('checked-out-target');
  git(['checkout', '-b', 'codex/checked-out'], repo.host);
  const originalHead = git(['rev-parse', 'HEAD'], repo.host);
  const result = await executeBranchDelivery({ plan: deliveryPlan(repo, candidate, { targetBranchRef: 'refs/heads/codex/checked-out', branchExpectedOldValue: originalHead }), candidateFiles: candidate, cloneDir: repo.clone });
  const hostStatus = git(['status', '--porcelain'], repo.host);
  Object.assign(observed, { status: result.status, headChanged: git(['rev-parse', 'HEAD'], repo.host) !== originalHead, hostStatus });
  assert.equal(hostStatus, '', 'Publishing the ref changed a clean caller checkout into a checkout with staged deletions.');
});

await probe('hooks_none_must_apply_before_clone_and_checkout', async observed => {
  const repo = fixture('ambient-checkout-hook');
  const hooks = join(scratch, 'ambient-hooks');
  const marker = join(scratch, 'ambient-hook-ran.txt');
  const config = join(scratch, 'fixture-global.gitconfig');
  mkdirSync(hooks);
  const shellQuote = value => `'${value.replace(/'/g, `'\\''`)}'`;
  writeFileSync(join(hooks, 'post-checkout'), `#!/bin/sh\nprintf 'AMBIENT HOOK RAN\\n' > ${shellQuote(marker.replace(/\\/g, '/'))}\n`);
  writeFileSync(config, `[core]\n\thooksPath = "${hooks.replace(/\\/g, '/')}"\n`);
  const priorGlobal = process.env.GIT_CONFIG_GLOBAL;
  try {
    // Change only this probe process's environment, never the user's Git configuration.
    process.env.GIT_CONFIG_GLOBAL = config;
    const result = await executeBranchDelivery({ plan: deliveryPlan(repo, candidate), candidateFiles: candidate, cloneDir: repo.clone });
    Object.assign(observed, { status: result.status, hookExecution: result.hookExecution, ambientHookRan: existsSync(marker) });
    assert.equal(existsSync(marker), false, 'An ambient post-checkout hook ran before hooks:none was enforced.');
  } finally {
    if (priorGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = priorGlobal;
  }
});

await probe('acceptance_cannot_open_with_unresolved_evidence', async observed => {
  const record = {
    schemaVersion: 1, kind: 'AcceptanceRecord', recordId: 'ACC-FOLLOW-UP', deliveryBoundary: 'candidate', subjectId: 'SUBJECT-1', candidateDigest: 'c'.repeat(64),
    accepter: { ...roleBindings.analyst, contextId: 'fresh', independent: false },
    criteria: [{ criterionId: 'AC-1', requirementRef: 'REQ-1', status: 'satisfied', reason: 'Claimed verified.', evidenceRefs: [{ kind: 'check', id: 'nonexistent-check', digest: 'd'.repeat(64) }] }],
    overallStatus: 'accepted', unresolvedLimitations: [], evaluatedAt: now,
  };
  const result = evaluateAcceptanceRecord(record, { expectedCriteria: ['AC-1'], expectedSubjectId: record.subjectId, expectedCandidateDigest: record.candidateDigest });
  Object.assign(observed, result);
  assert.equal(result.canOpenGate, false, 'A syntactically valid reference to nonexistent evidence opened the acceptance Gate.');
});

await probe('plan_fingerprint_must_include_constraints_and_exclusions', async observed => {
  const a = assessment();
  const first = selectExecutionPlan(planArgs(a));
  const second = selectExecutionPlan(planArgs({ ...a, constraints: ['No external network access'], exclusions: ['Do not modify public API'] }));
  Object.assign(observed, { sameFingerprint: first.planFingerprint === second.planFingerprint, first: first.planFingerprint, second: second.planFingerprint });
  assert.notEqual(first.planFingerprint, second.planFingerprint, 'Changed normative task restrictions retained the same plan fingerprint.');
});

await probe('fixed_planning_inputs_must_not_depend_on_the_clock', async observed => {
  const args = { ...planArgs(), reviewerConfirmation: { confirmed: true, confirmedBy: 'codeReviewer', reason: 'Captured confirmation without a timestamp.' } };
  const first = selectExecutionPlan(args);
  await new Promise(resolve => setTimeout(resolve, 25));
  const second = selectExecutionPlan(args);
  Object.assign(observed, { sameFingerprint: first.planFingerprint === second.planFingerprint, firstConfirmation: first.omittedStages[0].reviewerConfirmation.confirmedAt, secondConfirmation: second.omittedStages[0].reviewerConfirmation.confirmedAt });
  assert.equal(first.planFingerprint, second.planFingerprint, 'The selector inserts current time into semantic fingerprint inputs.');
});

await probe('store_must_retain_multiple_revisions_of_one_plan', async observed => {
  const root = join(scratch, 'revision-store');
  mkdirSync(join(root, 'store'), { recursive: true });
  const store = new Store(root);
  try {
    // Upstream workflow/artifact parents are irrelevant to this isolated m9 primary-key test.
    store.run('PRAGMA foreign_keys = OFF;');
    const a = assessment();
    store.run('INSERT INTO runs(id, workflow_id, workspace_id, workflow_snapshot_artifact_id, settings_artifact_id, execution_hash, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', a.assessmentRunId, 'wf-1', 'ws-1', 'art-1', 'art-2', 'a'.repeat(64), 'running', now);
    store.recordTaskAssessment(a);
    const first = selectExecutionPlan(planArgs(a));
    store.recordExecutionPlan(first, a.assessmentId);
    const revision = evaluateCandidateFloors(first, ['docs/storage/m10.sql'], { criticalAreas: DEFAULT_DESZO_CRITICAL_AREAS }).escalationPlan;
    Object.assign(observed, { firstPlanId: first.planId, revisedPlanId: revision.planId, distinctRevisionIds: first.planRevisionId !== revision.planRevisionId });
    try { store.recordExecutionPlan(revision, a.assessmentId); }
    catch (error) { observed.persistenceError = error.message; }
    observed.storedRevisions = store.get('SELECT COUNT(*) AS n FROM execution_plans WHERE id = ?', first.planId).n;
    assert.equal(observed.storedRevisions, 2, 'The first persisted revision prevents storing the escalated revision of the same plan.');
  } finally { store.close(); }
});

await probe('delivery_must_not_block_runtime_control_callbacks', async observed => {
  const repo = fixture('event-loop-control');
  let controlCallbackRan = false;
  const timer = setTimeout(() => { controlCallbackRan = true; }, 50);
  const plan = deliveryPlan(repo, candidate, { verificationChecks: [{ id: 'brief-work', command: process.execPath, args: ['-e', 'setTimeout(()=>{},300)'], expectedExitCode: 0 }] });
  const started = Date.now();
  const result = await executeBranchDelivery({ plan, candidateFiles: candidate, cloneDir: repo.clone });
  clearTimeout(timer);
  Object.assign(observed, { status: result.status, elapsedMs: Date.now() - started, controlCallbackRan });
  assert.equal(controlCallbackRan, true, 'A 50ms runtime callback could not run during synchronous delivery and smoke execution.');
});

const changedInputs = inputs.filter(path => digest(path) !== inputDigests[path]);
const report = {
  capturedAt: new Date().toISOString(), checkout, head: git(['rev-parse', 'HEAD'], checkout), scratch, inputDigests, changedInputs,
  summary: { total: results.length, passed: results.filter(r => r.passed).length, failed: results.filter(r => !r.passed).length }, results,
};
if (process.argv[2]) writeFileSync(process.argv[2], `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.summary.failed > 0 || changedInputs.length > 0 ? 1 : 0;
