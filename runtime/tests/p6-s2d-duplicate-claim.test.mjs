// P5 S2-D: a second protected Repair admission against a slot already claimed in the same installed release is refused by the
// production Judge-driven admission path with p5_workspace_claimed. Two Parent incidents run against one release. The first Repair
// claims the enrolled slot and fails at its Developer (no plan is written), so it never produces a handoff and never triggers a P6
// switch: the claim stays, and the release stays the running Engine. The second Parent incident reaches the same admission path and
// is refused before any link, Repair Run, P6 operation or staging exists. Controlled provider responses only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eventually } from './custody-support.mjs';
import { journal, profileQuery, sha256 } from './p5-e2e-support.mjs';
import { hostEvents, lifecycleState } from './p6-g0-support.mjs';
import { PARENT_WORKSPACE, PARENT_WORKSPACE_TWO, SLOT_WORKSPACES, admittedSession, provisionProtectedRelease, releaseProtectedRelease } from './p5-protected-release.mjs';

test('P5-S2-D: a second protected Repair admission against the claimed slot of one release is refused by p5_workspace_claimed',
  { timeout: 60 * 60_000 }, async () => {
    const R = await provisionProtectedRelease({ label: 's2d' });
    const observed = { phases: {} };
    let session = null;
    try {
      session = await admittedSession(R);
      const { call } = session;
      const { parentPublication, profile, installation } = { parentPublication: R.parentPublication, profile: R.profile, installation: R.installation };

      // First admission: Parent one's Judge admits the Repair; the link opens and the enrolled slot is claimed.
      const started = await call('POST', '/api/v2/runs', { workflowId: parentPublication.workflow.workflowId,
        workflowSnapshotSha256: parentPublication.snapshotSha256, publishedVersionId: parentPublication.publishedVersionId,
        definitionDigest: parentPublication.definitionDigest, workspaceId: PARENT_WORKSPACE, requestId: randomUUID() });
      assert.equal(started.status, 202, JSON.stringify(started.body));
      const parentRunId = started.body.run.runId;
      const linkOne = await eventually(() => profileQuery(profile, 'SELECT * FROM run_links WHERE parent_run_id = ?', parentRunId)[0] ?? null,
        'the first protected Repair to be admitted by the Judge', 20 * 60_000, 500);
      assert.equal(linkOne.repair_workspace_id, SLOT_WORKSPACES[0], 'the first Repair claims the enrolled slot of this release');
      assert.equal(linkOne.continuation_contract, 'logical_policy');
      observed.phases.firstClaim = { linkId: linkOne.id, parentRunId, repairRunId: linkOne.repair_run_id, slot: linkOne.repair_workspace_id };

      // The first Repair's Developer fails (no plan), so its Judge is blocked and the Run waits for the user without a candidate. The
      // wait is for that settled state: the Developer's failure outcome is durable and the Run has stopped progressing.
      const repairOneState = await eventually(() => {
        const row = profileQuery(profile, 'SELECT state FROM runs WHERE id = ?', linkOne.repair_run_id)[0];
        const failed = profileQuery(profile, "SELECT COUNT(*) AS count FROM journal_events WHERE run_id = ? AND event_type = 'attempt.failure_outcome'",
          linkOne.repair_run_id)[0].count;
        const active = profileQuery(profile, "SELECT COUNT(*) AS count FROM attempts WHERE run_id = ? AND state IN ('running','pending','draining')",
          linkOne.repair_run_id)[0].count;
        return failed > 0 && active === 0 && ['waiting_for_user', 'failed', 'succeeded', 'canceled', 'interrupted'].includes(row?.state)
          ? row.state : null;
      }, 'the first Repair Run to settle without a candidate', 20 * 60_000, 1000);
      observed.phases.firstRepairState = repairOneState;
      assert.equal(profileQuery(profile, "SELECT COUNT(*) AS count FROM journal_events WHERE event_type = 'self_repair.handoff_recorded'")[0].count, 0,
        'the consumed slot never produced a handoff, so no P6 switch was triggered');
      assert.equal(hostEvents(installation).filter(event => event.type === 'engine_switch_accepted').length, 0);

      // Second admission against the same consumed slot, in the same installed release: a second Parent incident reaches the same
      // Judge-driven Repair admission path, and the claim check refuses it before any link, Repair Run or P6 operation exists.
      const startedTwo = await call('POST', '/api/v2/runs', { workflowId: parentPublication.workflow.workflowId,
        workflowSnapshotSha256: parentPublication.snapshotSha256, publishedVersionId: parentPublication.publishedVersionId,
        definitionDigest: parentPublication.definitionDigest, workspaceId: PARENT_WORKSPACE_TWO, requestId: randomUUID() });
      assert.equal(startedTwo.status, 202, JSON.stringify(startedTwo.body));
      const parentRunTwo = startedTwo.body.run.runId;
      // Settled: the second Parent has no active attempt (its Judge has finished, whether it applied or refused) and has stopped progressing.
      const settled = await eventually(() => {
        const state = profileQuery(profile, 'SELECT state FROM runs WHERE id = ?', parentRunTwo)[0]?.state;
        const active = profileQuery(profile, "SELECT COUNT(*) AS count FROM attempts WHERE run_id = ? AND state IN ('running','pending','draining')",
          parentRunTwo)[0].count;
        const judged = journal(profile, parentRunTwo).some(item => item.type === 'judge.attention_opened');
        return judged && active === 0 && ['waiting_for_user', 'failed', 'succeeded', 'canceled', 'interrupted'].includes(state) ? { state } : null;
      }, 'the second Parent incident to settle at its Judge admission', 20 * 60_000, 1000);
      observed.phases.secondParent = { parentRunId: parentRunTwo, state: settled.state,
        journal: journal(profile, parentRunTwo).map(item => [item.sequence, item.type]),
        // The journal names each Judge decision by its artifact; the artifact carries the decision's effect.
        decisions: journal(profile, parentRunTwo).filter(item => item.type === 'judge.decision_applied' || item.type === 'judge.decision_rejected')
          .map(item => artifactJson(profile, item.payload.record)) };

      // The second Parent's Judge applied no repair: no link, no Repair Run in the slot, no P6 operation, one claim.
      const linksForTwo = profileQuery(profile, 'SELECT COUNT(*) AS count FROM run_links WHERE parent_run_id = ?', parentRunTwo)[0].count;
      const claimsOnSlot = profileQuery(profile, 'SELECT COUNT(*) AS count FROM run_links WHERE repair_workspace_id = ?', SLOT_WORKSPACES[0])[0].count;
      const runsInSlot = profileQuery(profile, 'SELECT COUNT(*) AS count FROM runs WHERE workspace_id = ?', SLOT_WORKSPACES[0])[0].count;
      observed.phases.duplicateAttempt = { linksForTwo, claimsOnSlot, runsInSlot };
      assert.equal(linksForTwo, 0, 'the refused admission writes no link');
      assert.equal(claimsOnSlot, 1, 'the slot has exactly one claim: the first');
      assert.equal(runsInSlot, 1, 'no second Repair Run is created in the claimed slot');
      assert.equal(lifecycleState(installation).engineOperation ?? null, null, 'no P6 operation or staging was started');
      // After the second admission: still no handoff and no Host switch, and no Engine switch was accepted for the consumed slot.
      assert.equal(profileQuery(profile, "SELECT COUNT(*) AS count FROM journal_events WHERE event_type = 'self_repair.handoff_recorded'")[0].count, 0,
        'no handoff exists after the second admission');
      assert.equal(hostEvents(installation).filter(event => event.type === 'engine_switch_accepted' || event.type === 'engine_staged').length, 0,
        'the Host recorded no switch request or staging after the second admission');
      assert.equal(noRepairEffect(observed.phases.secondParent.decisions), true, 'the Judge decision applied no repair effect');

      // The production refusal: the Judge attempt failed with the admission's own code, p5_workspace_claimed, recorded as the raw code of
      // its failure outcome (the canonical attempt code stays in the attempt vocabulary).
      const outcomes = profileQuery(profile, 'SELECT node_instance_id, outcome_json FROM failure_outcomes WHERE run_id = ?', parentRunTwo)
        .map(row => ({ node: row.node_instance_id, ...JSON.parse(row.outcome_json) }));
      const refusal = outcomes.find(item => item.rawCode === 'p5_workspace_claimed');
      observed.phases.refusal = refusal ? { node: refusal.node, rawCode: refusal.rawCode, canonicalCode: refusal.canonicalCode } : null;
      assert.ok(refusal, `the second admission was refused with p5_workspace_claimed; recorded outcomes: ${JSON.stringify(outcomes.map(item => [item.node, item.rawCode, item.canonicalCode]))}`);
      assert.equal(refusal.node, 'judge', 'the refusal is recorded on the Judge attempt that carried the admission');
      // The journaled attempt error carries the admission's own sentence; the outcome's summary is generic.
      const judgeError = journal(profile, parentRunTwo).find(item => item.type === 'attempt.error' && /already claimed by a linked Repair/.test(item.payload?.message ?? ''));
      assert.ok(judgeError, 'the Judge attempt error journals the admission refusal sentence');
    } finally {
      writeFileSync(join(R.scratch.root, 's2d-observations.json'), `${JSON.stringify(observed, null, 2)}\n`);
      await releaseProtectedRelease(R);
    }
  });

// The second incident's Judge decisions applied no repair effect: none of the decision artifacts carries a repair effect.
function noRepairEffect(decisions) {
  return !decisions.some(decision => decision?.effect?.type === 'repair');
}

function artifactJson(profile, ref) {
  const [row] = profileQuery(profile, 'SELECT relative_path, sha256 FROM artifacts WHERE id = ?', ref.artifactId);
  assert.ok(row, `artifact ${ref.artifactId} is recorded`);
  const bytes = readFileSync(join(profile, 'store', row.relative_path));
  assert.equal(sha256(bytes), ref.sha256, `artifact ${ref.artifactId} matches its reference`);
  return JSON.parse(bytes.toString('utf8'));
}
