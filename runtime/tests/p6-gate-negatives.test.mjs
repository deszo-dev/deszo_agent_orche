// P5 Gate negatives (B2): three real Verification Gate runs under the existing P5 policy, each provisioned as its own installed release
// (a Repair claims the enrolled slot, so each negative needs a fresh release). Each Repair's Developer produces a candidate, and the
// trusted Gate refuses the invalid evidence in its own code path. No handoff or P6 switch may result, and the Gate's verdict is read
// from its durable failure outcome or verification record.
//   1. Invalid dependency closure: the candidate's protected subject imports a package the installed release does not contain.
//   2. Invalid running-source release: the trusted verifier the Gate runs is altered, same size, after the Repair is admitted.
//   3. Missing required causal verification: the candidate does not demonstrate the causal repair (incident-repaired fails), so the Gate
//      issues no passing verification and no causal record.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eventually } from './custody-support.mjs';
import { journal, profileQuery, sha256 } from './p5-e2e-support.mjs';
import { PARENT_WORKSPACE, SLOT_WORKSPACES, admittedSession, provisionProtectedRelease, releaseProtectedRelease } from './p5-protected-release.mjs';
import { SUBJECT, incidentModule, planText } from './p6-genuine-support.mjs';

// Runs one Repair to the Gate. `gateBarrier` names the directory of the Gate's test barrier (runtime/core/p5Gate.mjs, testGateBarrier):
// the Gate waits there before its first installed-release read, and `afterGateStarts` runs while it waits.
async function runRepairToGate(R, session, { label, plan, gateBarrier = null, afterGateStarts = null }) {
  const { call } = session;
  writeFileSync(join(R.scratch.fixtureState, 'p5-developer-plan.txt'), plan);
  const { parentPublication, profile } = { parentPublication: R.parentPublication, profile: R.profile };
  const started = await call('POST', '/api/v2/runs', { workflowId: parentPublication.workflow.workflowId,
    workflowSnapshotSha256: parentPublication.snapshotSha256, publishedVersionId: parentPublication.publishedVersionId,
    definitionDigest: parentPublication.definitionDigest, workspaceId: PARENT_WORKSPACE, requestId: randomUUID() });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const link = await eventually(() => profileQuery(profile, 'SELECT * FROM run_links WHERE parent_run_id = ?', started.body.run.runId)[0] ?? null,
    `${label}: the Judge to admit the protected Repair`, 20 * 60_000, 200);
  assert.equal(link.repair_workspace_id, SLOT_WORKSPACES[0]);
  // The Gate waits at its barrier before its first installed-release read. The test alters the release while the Gate waits there, and
  // then releases it: the Gate's own attestation is then the first check after the alteration.
  if (gateBarrier) {
    await eventually(() => existsSync(join(gateBarrier, 'reached-before-running-release')), `${label}: the Gate to start`, 30 * 60_000, 50);
    afterGateStarts();
    writeFileSync(join(gateBarrier, 'resume-before-running-release'), 'resume\n');
  }
  // Settled at the Gate: the verify node has a verification record or a failure outcome, and the Repair has no active attempt.
  const gate = await eventually(() => {
    const verifyFailure = profileQuery(profile, "SELECT outcome_json FROM failure_outcomes WHERE run_id = ? AND node_instance_id = 'verify'", link.repair_run_id)[0];
    const verified = profileQuery(profile, "SELECT COUNT(*) AS count FROM journal_events WHERE run_id = ? AND event_type = 'self_repair.verification_recorded'",
      link.repair_run_id)[0].count;
    const active = profileQuery(profile, "SELECT COUNT(*) AS count FROM attempts WHERE run_id = ? AND state IN ('running','pending','draining')",
      link.repair_run_id)[0].count;
    if (active !== 0 || (!verifyFailure && verified === 0)) return null;
    return { failure: verifyFailure ? JSON.parse(verifyFailure.outcome_json) : null,
      verified: verified > 0 ? artifactJson(profile, verificationRecordRef(profile, link.repair_run_id)) : null };
  }, `${label}: the Gate to refuse or settle the candidate`, 30 * 60_000, 1000);
  const handoffs = profileQuery(profile, "SELECT COUNT(*) AS count FROM journal_events WHERE event_type = 'self_repair.handoff_recorded'")[0].count;
  return { link, gate, handoffs, profile };
}

function verificationRecordRef(profile, repairRunId) {
  return journal(profile, repairRunId).find(item => item.type === 'self_repair.verification_recorded').payload.record;
}

function artifactJson(profile, ref) {
  const [row] = profileQuery(profile, 'SELECT relative_path, sha256 FROM artifacts WHERE id = ?', ref.artifactId);
  assert.ok(row, `artifact ${ref.artifactId} is recorded`);
  const bytes = readFileSync(join(profile, 'store', row.relative_path));
  assert.equal(sha256(bytes), ref.sha256, `artifact ${ref.artifactId} matches its reference`);
  return JSON.parse(bytes.toString('utf8'));
}

// A byte inside a line comment of the installed verifier changes, same size: the Host's attested bytes for that file no longer match.
function alterVerifierComment(aRoot) {
  const found = [];
  const pending = [aRoot];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules') pending.push(path);
      else if (entry.name === 'p5Verifier.mjs') found.push(path);
    }
  }
  assert.equal(found.length, 1, `exactly one installed verifier: ${found.join(', ')}`);
  const bytes = readFileSync(found[0]);
  const at = bytes.indexOf('//');
  assert.ok(at >= 0, 'the installed verifier has a line comment');
  const before = sha256(bytes);
  bytes[at + 2] = bytes[at + 2] === 0x78 ? 0x79 : 0x78;
  writeFileSync(found[0], bytes);
  assert.notEqual(sha256(readFileSync(found[0])), before, 'the installed verifier was altered');
}

test('P5 Gate negative 1: an invalid dependency closure is refused by the real Gate (p5_subject_external_dependency_unsupported)',
  { timeout: 60 * 60_000 }, async () => {
    const R = await provisionProtectedRelease({ label: 'gate-deps' });
    let session = null;
    try {
      session = await admittedSession(R);
      // The candidate's protected subject imports a package the installed, attested release does not contain.
      const outcome = await runRepairToGate(R, session, {
        label: 'dependency closure',
        plan: planText([['write', SUBJECT, '', `import 'deszo-s2-uninstalled-package';\n${incidentModule(1)}`]]),
      });
      assert.ok(outcome.gate.failure, 'the Gate recorded a failure for the candidate');
      assert.equal(outcome.gate.failure.rawCode, 'p5_subject_external_dependency_unsupported', JSON.stringify(outcome.gate.failure));
      assert.equal(outcome.gate.verified, null, 'no verification was recorded for the invalid closure');
      assert.equal(outcome.handoffs, 0, 'an invalid dependency closure produces no handoff');
    } finally {
      await releaseProtectedRelease(R);
    }
  });

test('P5 Gate negative 2: an invalid running-source release is refused by the real Gate (the Host rejects the altered attested bytes)',
  { timeout: 60 * 60_000 }, async () => {
    const R = await provisionProtectedRelease({ label: 'gate-source' });
    // The Engine reads this variable only where the test-fault policy allows seams (not in a packaged production build).
    const gateBarrier = join(R.scratch.root, 'gate-barrier');
    mkdirSync(gateBarrier);
    R.fixtureEnv.DESZO_TEST_GATE_BARRIER_DIR = gateBarrier;
    let session = null;
    try {
      session = await admittedSession(R);
      const outcome = await runRepairToGate(R, session, {
        label: 'running-source release',
        plan: planText([['write', SUBJECT, '', incidentModule(1)]]),
        gateBarrier,
        afterGateStarts: () => alterVerifierComment(R.aRoot),
      });
      assert.ok(outcome.gate.failure, 'the Gate recorded a failure for the candidate');
      assert.equal(outcome.gate.failure.rawCode, 'source_release_unavailable', JSON.stringify(outcome.gate.failure));
      // The outcome's summary is generic; the journaled attempt error carries the Host's sentence, which names the altered verifier.
      const hostSentence = journal(outcome.profile, outcome.link.repair_run_id).find(item => item.type === 'attempt.error'
        && /build artifact digest is invalid: .*p5Verifier\.mjs/.test(item.payload?.message ?? ''));
      assert.ok(hostSentence, 'the Gate attempt error names the altered verifier');
      assert.equal(outcome.gate.verified, null, 'no verification was recorded for the invalid running release');
      assert.equal(outcome.handoffs, 0, 'an invalid running-source release produces no handoff');
    } finally {
      await releaseProtectedRelease(R);
    }
  });

test('P5 Gate negative 3: a candidate without the required causal repair is not verified by the real Gate, so no causal record exists',
  { timeout: 60 * 60_000 }, async t => {
    const R = await provisionProtectedRelease({ label: 'gate-causal' });
    let session = null;
    try {
      session = await admittedSession(R);
      // The candidate changes the module but keeps the defect: the required causal check (incident-repaired) must fail on it.
      const outcome = await runRepairToGate(R, session, {
        label: 'causal repair',
        plan: planText([['write', SUBJECT, '', `${incidentModule(0)}// a change that repairs nothing\n`]]),
      });
      t.diagnostic(`CAUSAL-GATE ${JSON.stringify({ failure: outcome.gate.failure && { rawCode: outcome.gate.failure.rawCode,
        canonicalCode: outcome.gate.failure.canonicalCode, message: outcome.gate.failure.message },
        verified: outcome.gate.verified && { status: outcome.gate.verified.status, causal: outcome.gate.verified.causalReproduction ?? null } })}`);
      assert.equal(outcome.handoffs, 0, 'an unverified candidate produces no handoff');
      // The required causal check failed on the candidate: the Gate recorded a failed verification, refused it with that code, and issued
      // no causal record.
      assert.ok(outcome.gate.verified, 'the Gate recorded its verification outcome');
      assert.equal(outcome.gate.verified.status, 'failed', 'the Gate did not record a passed verification');
      assert.equal(outcome.gate.verified.causalReproduction ?? null, null, 'no causal record was issued');
      assert.equal(outcome.gate.failure?.rawCode, 'p5_verification_failed', 'the refusal is the failed verification');
    } finally {
      await releaseProtectedRelease(R);
    }
  });
