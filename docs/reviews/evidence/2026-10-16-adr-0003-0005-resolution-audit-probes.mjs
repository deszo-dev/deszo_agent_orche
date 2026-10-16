import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalHash } from '../../../runtime/core/canonical.mjs';
import { executeBranchDelivery } from '../../../runtime/core/branchDelivery.mjs';
import { evaluateAcceptanceRecord } from '../../../runtime/core/contextPackage.mjs';
import { deriveSourceFacts, selectExecutionPlan } from '../../../runtime/core/taskAssessment.mjs';
import { MIGRATION_PATHS, Store } from '../../../runtime/core/store.mjs';

// Audit the fixes, including ordering and failure/retry behavior, in owned fixtures.
const checkout = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const scratch = mkdtempSync(join(tmpdir(), 'deszo-resolution-audit-'));
const results = [];
const inputPaths = ['runtime/core/branchDelivery.mjs', 'runtime/core/contextPackage.mjs', 'runtime/core/taskAssessment.mjs', 'runtime/core/store.mjs', 'docs/storage/m9.sql'];
const digest = path => createHash('sha256').update(readFileSync(join(checkout, path))).digest('hex');
const inputDigests = Object.fromEntries(inputPaths.map(path => [path, digest(path)]));
const capturedTime = '2026-10-16T12:00:00.000Z';
function git(args, cwd, required = true) {
  const result = spawnSync('git', args, { cwd, timeout: 10000, encoding: 'utf8', windowsHide: true });
  if (required && result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.error?.message || result.stderr || result.stdout}`);
  return required ? result.stdout.trim() : result;
}
function fixture(name) {
  const root = join(scratch, name, 'host');
  mkdirSync(root, { recursive: true });
  git(['init', '-b', 'main'], root);
  git(['config', 'user.name', 'Review Fixture'], root);
  git(['config', 'user.email', 'fixture@example.com'], root);
  git(['config', 'core.autocrlf', 'false'], root);
  git(['config', 'commit.gpgSign', 'false'], root);
  writeFileSync(join(root, 'README.md'), 'BASE\n');
  git(['add', 'README.md'], root);
  git(['commit', '-m', 'base'], root);
  return { root, base: git(['rev-parse', 'HEAD'], root), clone: join(scratch, name, 'clone') };
}
const candidate = [{ path: 'approved.txt', content: 'APPROVED\n' }];
function deliveryPlan(repo, checks = []) {
  return {
    schemaVersion: 1, kind: 'DeliveryPlan', deliveryPlanId: randomUUID(), runId: randomUUID(),
    candidateDigest: canonicalHash(candidate.map(file => ({ path: file.path, digest: canonicalHash(file.content) }))),
    repositoryPath: repo.root, baseCommit: repo.base, targetBranchRef: 'refs/heads/codex/audit', branchExpectedOldValue: null,
    isolation: { mode: 'separate_clone', cloneStrategy: 'reference_dissociate' },
    hookPolicy: { installHooks: false, hookSource: null, hooksJournal: 'none' },
    verificationChecks: checks,
    commitPolicy: { authorName: 'Review Fixture', authorEmail: 'fixture@example.com', message: 'delivery' },
    boundaryCriteria: [{ id: 'BR-1', description: 'Exact verified candidate.' }], createdAt: capturedTime,
  };
}
async function probe(name, run) {
  const observed = {};
  try { await run(observed); results.push({ name, passed: true, observed }); }
  catch (error) { results.push({ name, passed: false, observed, error: error.stack || String(error) }); }
}

await probe('control_callback_must_run_before_smoke_ends_and_ref_is_published', async observed => {
  const repo = fixture('control-order');
  const smokeEnd = join(scratch, 'smoke-ended.json');
  let callbackAt = null, publishedAtCallback = null;
  const timer = setTimeout(() => {
    callbackAt = Date.now();
    publishedAtCallback = git(['rev-parse', '--verify', 'refs/heads/codex/audit'], repo.root, false).status === 0;
  }, 50);
  const plan = deliveryPlan(repo, [{ id: 'brief-work', command: process.execPath, args: ['-e', `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(smokeEnd)},JSON.stringify({endedAt:Date.now()})),300)`], expectedExitCode: 0 }]);
  const startedAt = Date.now();
  const immediateResult = executeBranchDelivery({ plan, candidateFiles: candidate, cloneDir: repo.clone });
  const returnedAt = Date.now();
  const refPublishedBeforeAwait = git(['rev-parse', '--verify', plan.targetBranchRef], repo.root, false).status === 0;
  const result = await immediateResult;
  clearTimeout(timer);
  const smokeEndedAt = JSON.parse(readFileSync(smokeEnd, 'utf8')).endedAt;
  Object.assign(observed, { status: result.status, startedAt, returnedAt, smokeEndedAt, callbackAt, publishedAtCallback, refPublishedBeforeAwait, synchronousCallMs: returnedAt - startedAt });
  assert.ok(callbackAt !== null && callbackAt < smokeEndedAt && !publishedAtCallback, 'Control resumed only after smoke, commit and target-ref publication; the thenable does not make delivery asynchronous.');
});

await probe('hooks_none_must_also_cover_host_ref_publication', async observed => {
  const repo = fixture('host-ref-hook');
  const hooks = join(repo.root, '.git', 'hooks');
  const marker = join(scratch, 'host-reference-hook-ran.txt');
  git(['config', 'core.hooksPath', hooks], repo.root);
  const quotedMarker = `'${marker.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`;
  writeFileSync(join(hooks, 'reference-transaction'), `#!/bin/sh\nprintf 'HOST HOOK RAN\\n' >> ${quotedMarker}\nexit 0\n`, { mode: 0o755 });
  const result = await executeBranchDelivery({ plan: deliveryPlan(repo), candidateFiles: candidate, cloneDir: repo.clone });
  Object.assign(observed, { status: result.status, hookExecution: result.hookExecution, hostHookRan: existsSync(marker), marker: existsSync(marker) ? readFileSync(marker, 'utf8') : null });
  assert.equal(existsSync(marker), false, 'The host reference-transaction hook executed while delivery reported hooks:none.');
});

await probe('checked_out_target_must_be_rechecked_after_smoke', async observed => {
  const repo = fixture('checkout-during-smoke');
  git(['branch', 'codex/audit', repo.base], repo.root);
  const beforeRef = git(['symbolic-ref', 'HEAD'], repo.root);
  // Simulate another actor checking out the existing target after the preflight check.
  const check = { id: 'simulate-concurrent-checkout', command: 'git', args: ['-C', repo.root, 'checkout', 'codex/audit'], expectedExitCode: 0 };
  const plan = { ...deliveryPlan(repo, [check]), branchExpectedOldValue: repo.base };
  const result = await executeBranchDelivery({ plan, candidateFiles: candidate, cloneDir: repo.clone });
  Object.assign(observed, { status: result.status, beforeRef, afterRef: git(['symbolic-ref', 'HEAD'], repo.root), hostStatus: git(['status', '--porcelain'], repo.root) });
  assert.equal(result.readyForMerge, false, 'Preflight checkout protection became stale during smoke and publication dirtied the caller checkout.');
});

const acceptance = {
  schemaVersion: 1, kind: 'AcceptanceRecord', recordId: 'ACC-AUDIT', deliveryBoundary: 'candidate', subjectId: 'SUBJECT-1', candidateDigest: 'c'.repeat(64),
  accepter: { role: 'analyst', provider: 'codex', model: 'gpt-6.1-sol', effort: 'max', contextId: 'fresh', independent: false },
  criteria: [{ criterionId: 'AC-1', requirementRef: 'REQ-1', status: 'satisfied', reason: 'Claimed verified.', evidenceRefs: [{ kind: 'check', id: 'check-1', digest: 'd'.repeat(64) }] }],
  overallStatus: 'accepted', unresolvedLimitations: [], evaluatedAt: capturedTime,
};
// Authoritative inputs captured for the delivery boundary; a resolver is added by the probes that exercise it.
const acceptanceOptions = { expectedCriteria: ['AC-1'], expectedBoundary: acceptance.deliveryBoundary, expectedSubjectId: acceptance.subjectId, expectedCandidateDigest: acceptance.candidateDigest };
await probe('structural_validation_without_trusted_inputs_cannot_open_gate', observed => {
  const result = evaluateAcceptanceRecord(acceptance);
  Object.assign(observed, result);
  assert.equal(result.canOpenGate, false, 'Default evaluation opened a Gate with no trusted criterion inventory or resolved evidence.');
});
await probe('evidence_id_membership_cannot_replace_digest_verification', observed => {
  const result = evaluateAcceptanceRecord(acceptance, { ...acceptanceOptions, resolvedEvidence: new Set(['check-1']) });
  Object.assign(observed, result);
  assert.equal(result.canOpenGate, false, 'ID-only membership accepted a digest that was never verified.');
  // With the engine resolver present, an identifier-and-digest record is still incomplete and must be refused.
  const incomplete = evaluateAcceptanceRecord(acceptance, { ...acceptanceOptions, resolveEvidence: ref => ({ id: ref.id, digest: ref.digest }) });
  Object.assign(observed, { incomplete });
  assert.equal(incomplete.canOpenGate, false, 'An identifier-and-digest engine record opened the Gate.');
});
await probe('resolved_evidence_must_match_kind_source_and_success', observed => {
  // A complete engine record of the wrong kind, subject, candidate and outcome, resolved for the same identifier and digest.
  const unrelatedFailedEvidence = { id: 'check-1', kind: 'artifact', digest: 'd'.repeat(64), subjectId: 'OTHER-SUBJECT', candidateDigest: 'e'.repeat(64), boundary: 'candidate', source: 'engine', outcome: 'failed', appliesToCriteria: ['AC-1'], recordedAt: capturedTime };
  const resolved = new Map([['check-1', unrelatedFailedEvidence]]);
  const result = evaluateAcceptanceRecord(acceptance, { ...acceptanceOptions, resolveEvidence: ref => resolved.get(ref.id) });
  Object.assign(observed, { ...result, resolvedRecord: unrelatedFailedEvidence });
  assert.equal(result.canOpenGate, false, 'Matching ID/digest accepted evidence of the wrong type, source and execution status.');
});

function storeFixture(name) {
  const root = join(scratch, name);
  const store = new Store(root);
  // Omit unrelated upstream parent records in this private database only.
  store.run('PRAGMA foreign_keys = OFF;');
  const a = {
    schemaVersion: 1, kind: 'TaskAssessment', assessmentId: 'ASSESS-AUDIT', assessmentRunId: randomUUID(), businessRequestId: 'BUSINESS-1', authorRole: 'analyst', sourceSnapshotHash: 'a'.repeat(64), intendedOutcome: 'Local change', constraints: [], requirements: [], scope: { affectedComponents: ['src/local.js'] },
    sourceDerivedFacts: { criticalPaths: [], publicContracts: [], dependencyFanOut: 1 },
    assessmentAxes: { scopeCoupling: 'local', technicalDifficulty: 'low', failureImpact: 'limited', uncertainty: 'low', verifiability: 'clear' },
    grounds: { references: [], assumptions: [], confidence: 'Recorded', unresolvedQuestions: [] }, planningAdvice: { recommendedStages: [] }, createdAt: capturedTime,
  };
  store.run('INSERT INTO runs(id, workflow_id, workspace_id, workflow_snapshot_artifact_id, settings_artifact_id, execution_hash, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', a.assessmentRunId, 'wf-1', 'ws-1', 'art-1', 'art-2', 'a'.repeat(64), 'running', capturedTime);
  store.recordTaskAssessment(a);
  const roleBindings = Object.fromEntries(['analyst', 'developer', 'testAuthor', 'codeReviewer', 'testReviewer'].map(role => [role, { role, provider: 'fixture', model: 'fixture-model', effort: 'medium' }]));
  const plan = selectExecutionPlan({ assessment: a, sourceFacts: deriveSourceFacts(['src/local.js'], { criticalAreas: ['critical/**'] }), roleBindings, reviewerConfirmation: { confirmed: true, confirmedBy: 'codeReviewer', confirmedAt: capturedTime, reason: 'Captured' } });
  return { store, a, plan };
}
await probe('failed_revision_retry_must_preserve_the_active_revision', observed => {
  const { store, a, plan } = storeFixture('revision-retry');
  try {
    store.recordExecutionPlan(plan, a.assessmentId);
    try { store.recordExecutionPlan(plan, a.assessmentId); } catch (error) { observed.retryError = error.message; }
    observed.revisions = store.all('SELECT id, plan_revision_id, status FROM execution_plans WHERE id = ?', plan.planId);
    assert.equal(observed.revisions.filter(r => r.status === 'active').length, 1, 'A rejected retry superseded the only active revision without installing a replacement.');
  } finally { store.close(); }
});

await probe('opening_an_existing_m9_store_must_upgrade_the_plan_revision_key', observed => {
  // m9 is restored to the definition an existing store applied (id alone); m10 owns the upgrade. The store is opened
  // with the earlier m9 only, so the plan revision key is read before and after the upgrade.
  const steps = MIGRATION_PATHS.map(path => readFileSync(path, 'utf8'));
  const root = join(scratch, 'legacy-m9-store');
  const oldStore = new Store(root, { migrations: steps.slice(0, 9) });
  observed.legacyPrimaryKeyColumns = oldStore.all('PRAGMA table_info(execution_plans)').filter(c => c.pk > 0).map(c => c.name);
  oldStore.close();
  assert.deepEqual(observed.legacyPrimaryKeyColumns, ['id'], 'The earlier m9 fixture did not key execution plans by id alone.');
  const reopened = new Store(root);
  try {
    observed.version = reopened.get('SELECT MAX(version) AS version FROM schema_migrations').version;
    observed.primaryKeyColumns = reopened.all('PRAGMA table_info(execution_plans)').filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
    assert.deepEqual(observed.primaryKeyColumns, ['id', 'plan_revision_id'], 'Opening an already migrated store did not upgrade the plan revision key.');
  } finally { reopened.close(); }
});

const report = {
  capturedAt: new Date().toISOString(), checkout, head: git(['rev-parse', 'HEAD'], checkout), scratch, inputDigests,
  changedInputs: inputPaths.filter(path => digest(path) !== inputDigests[path]),
  summary: { total: results.length, passed: results.filter(r => r.passed).length, failed: results.filter(r => !r.passed).length }, results,
};
if (process.argv[2]) writeFileSync(process.argv[2], `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.summary.failed || report.changedInputs.length ? 1 : 0;
