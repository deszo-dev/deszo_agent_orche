// P5 slot reservation at the Run admission boundary (security review S2-A and S2-E). An ordinary Run is refused in a workspace whose
// junction, directly or through a chain, reaches an enrolled slot, and it is admitted in a workspace that reaches nothing. The
// enrollment is the installed file in the profile, which the runtime reads without a Lifecycle Host, so no Host is needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startTestRunner } from './helpers.mjs';
import { P5_ENROLLMENT_RELATIVE_PATH } from '../core/protectedSelfRepair.mjs';

const ALIAS = process.platform === 'win32' ? 'junction' : 'dir';

function ordinaryWorkflow(workflowId) {
  return { schemaVersion: 1, workflowId, capabilities: ['core-v1'], settings: { nativeConfiguration: 'restricted' }, nodes: [
    { id: 'request', type: 'text', config: { value: `${workflowId} request` } }, { id: 'result', type: 'result-viewer', config: {} }],
  edges: [{ id: 'request-result', source: { nodeId: 'request', port: 'text' }, target: { nodeId: 'result', port: 'value' } }], after: [] };
}

async function register(api, id, cwd) {
  await mkdir(cwd, { recursive: true });
  const result = await api.call('PUT', `/api/v2/workspaces/${id}`, { cwd });
  assert.equal(result.status, 200, JSON.stringify(result.body));
}

// The enrolled slot the installed file names: a real directory holding retained Repair content.
async function installEnrollment(api, slot) {
  await mkdir(slot, { recursive: true });
  await writeFile(join(slot, 'retained.txt'), 'retained Repair content');
  const enrolled = { workspaceId: 'p5-slot-1', canonicalRoot: slot, allocationId: '00000000-0000-4000-8000-000000000001',
    nativeIdentity: { volumeId: 'volume-1', fileId: 'file-1' } };
  const profile = api.runner.engine.store.root;
  await mkdir(join(profile, 'p5'), { recursive: true });
  await writeFile(join(profile, P5_ENROLLMENT_RELATIVE_PATH), JSON.stringify({ workspace: enrolled, workspacePool: [enrolled] }));
}

test('S2-A and S2-E: an ordinary Run is refused in a workspace whose junction reaches an enrolled slot, and admitted elsewhere', async () => {
  const api = await startTestRunner();
  try {
    const scratch = api.runner.connection.scratchRoot;
    const slot = join(scratch, 'enrolled-slot');
    const aliasWorkspace = join(scratch, 'alias-workspace');
    const freeWorkspace = join(scratch, 'free-workspace');
    await installEnrollment(api, slot);
    await mkdir(aliasWorkspace, { recursive: true });
    await symlink(slot, join(aliasWorkspace, 'into-slot'), ALIAS);
    await register(api, 'alias-workspace', aliasWorkspace);
    await register(api, 'free-workspace', freeWorkspace);

    const refused = await api.run(ordinaryWorkflow('p5-s2a-alias'), 'alias-workspace');
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'p5_workspace_reserved', JSON.stringify(refused.body));
    assert.equal(api.runner.engine.store.get('SELECT COUNT(*) AS count FROM runs WHERE workspace_id = ?', 'alias-workspace').count, 0,
      'the refused Run creates no Run');

    const admitted = await api.run(ordinaryWorkflow('p5-s2a-free'), 'free-workspace');
    assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
    await api.waitFor(admitted.body.run.runId);
  } finally { await api.close(); }
});

// A generic linked Repair (ADR-0008, not a P5 admission) aimed at an enrolled slot is refused before any link or Run is written.
function failingParentWorkflow() {
  return { schemaVersion: 1, workflowId: 'p5-s2c-parent', capabilities: ['core-v1'], settings: { nativeConfiguration: 'restricted' }, nodes: [
    { id: 'request', type: 'text', config: { value: 'parent request' } },
    { id: 'watcher', type: 'agent', config: { provider: 'claude', model: 'fixture-fail', timeoutSeconds: 30, output: { format: 'text' } } },
    { id: 'result', type: 'result-viewer', config: {} }],
  edges: [{ id: 'request-watcher', source: { nodeId: 'request', port: 'text' }, target: { nodeId: 'watcher', port: 'prompt' } },
    { id: 'watcher-result', source: { nodeId: 'watcher', port: 'text' }, target: { nodeId: 'result', port: 'value' } }], after: [] };
}

test('S2-C: a generic linked Repair is refused in an enrolled slot before any link or Run is written', async () => {
  const api = await startTestRunner();
  try {
    const scratch = api.runner.connection.scratchRoot;
    const slot = join(scratch, 'enrolled-slot-generic');
    const parentWorkspace = join(scratch, 'generic-parent');
    await installEnrollment(api, slot);
    await mkdir(parentWorkspace, { recursive: true });
    await register(api, 'generic-parent', parentWorkspace);
    await register(api, 'generic-slot', slot);

    const started = await api.run(failingParentWorkflow(), 'generic-parent');
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await api.waitFor(started.body.run.runId, run => run.state === 'waiting_for_user');
    const repair = await api.save(ordinaryWorkflow('p5-s2c-repair'));
    const response = await api.call('POST', `/api/v2/runs/${started.body.run.runId}/linked-repair`, {
      requestId: randomUUID(), failedNodeInstanceId: 'watcher', repairWorkflowId: repair.workflow.workflowId,
      repairWorkflowSnapshotSha256: repair.snapshotSha256, repairWorkspaceId: 'generic-slot', candidateDigest: 'a'.repeat(64),
      continuationCheckpointId: 'chk-s2c' });
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.code, 'p5_workspace_enrolled', JSON.stringify(response.body));
    const store = api.runner.engine.store;
    assert.equal(store.get('SELECT COUNT(*) AS count FROM run_links').count, 0, 'the refused generic Repair writes no link');
    assert.equal(store.get('SELECT COUNT(*) AS count FROM runs WHERE workspace_id = ?', 'generic-slot').count, 0,
      'the refused generic Repair creates no Run in the slot');
  } finally { await api.close(); }
});

// The claim is read from the real Store, with real rows and real SQL: a P5 link claims its slot, a generic P2 link claims nothing, and
// the claim outlives the installed enrollment file (P5-08). The rows are the Engine's own logical-policy link shape.
async function logicalLink(api, { parentWorkspace, repairWorkspace, authorization, label }) {
  const store = api.runner.engine.store;
  const at = new Date().toISOString();
  const parentRun = await api.run(ordinaryWorkflow(`p5-real-parent-${label}`), parentWorkspace);
  assert.equal(parentRun.status, 202, JSON.stringify(parentRun.body));
  await api.waitFor(parentRun.body.run.runId);
  const repairRun = await api.run(ordinaryWorkflow(`p5-real-repair-${label}`), repairWorkspace);
  assert.equal(repairRun.status, 202, JSON.stringify(repairRun.body));
  await api.waitFor(repairRun.body.run.runId);
  const checkpoint = store.putJson({ kind: 'real-store-checkpoint', label });
  const auth = store.putJson(authorization);
  const linkId = randomUUID();
  store.run(`INSERT INTO run_links(id, kind, parent_run_id, repair_run_id, parent_workspace_id, repair_workspace_id,
    resume_node_instance_id, candidate_digest, checkpoint_artifact_id, state, continuation_contract, incident_id,
    parent_suspension_state, repair_outcome, decision_status, authorization_artifact_id, repair_result_node_instance_id,
    expected_repair_result_sha256, failed_node_retry, acceptance_mode, repair_result_sha256, repair_approval_artifact_id, created_at, updated_at)
    VALUES (?, 'linked_repair', ?, ?, ?, ?, 'watcher', NULL, ?, 'open', 'logical_policy', ?, 'suspended_for_repair', NULL, 'pending', ?,
      'developer', NULL, 'never', 'judge_post_execution', NULL, NULL, ?, ?)`,
  linkId, parentRun.body.run.runId, repairRun.body.run.runId, parentWorkspace, repairWorkspace, checkpoint.artifactId,
  `incident-${linkId}`, auth.artifactId, at, at);
  return linkId;
}

test('the P5 claim is read from the real Store: a P5 link claims its slot, a generic P2 link claims nothing, and the claim outlives the installed file', async () => {
  const api = await startTestRunner();
  try {
    const scratch = api.runner.connection.scratchRoot;
    const claimedSlot = join(scratch, 'real-claimed-slot');
    const p2Slot = join(scratch, 'real-p2-slot');
    const parentA = join(scratch, 'real-parent-a');
    const parentB = join(scratch, 'real-parent-b');
    const alias = join(scratch, 'real-alias-workspace');
    for (const dir of [claimedSlot, p2Slot, parentA, parentB, alias]) await mkdir(dir, { recursive: true });
    await register(api, 'real-claimed-slot', claimedSlot);
    await register(api, 'real-p2-slot', p2Slot);
    await register(api, 'real-parent-a', parentA);
    await register(api, 'real-parent-b', parentB);
    await register(api, 'real-alias-workspace', alias);
    await symlink(claimedSlot, join(alias, 'into-claimed'), ALIAS);

    const p5Auth = { profile: { selfRepair: { artifactId: 'a'.repeat(32), sha256: 'a'.repeat(64) } } };
    await logicalLink(api, { parentWorkspace: 'real-parent-a', repairWorkspace: 'real-claimed-slot', authorization: p5Auth, label: 'p5' });
    await logicalLink(api, { parentWorkspace: 'real-parent-b', repairWorkspace: 'real-p2-slot', authorization: { profile: {} }, label: 'p2' });

    const engine = api.runner.engine;
    assert.deepEqual(engine.protectedSelfRepairP5ClaimedSlots().map(item => item.workspaceId), ['real-claimed-slot'],
      'only the P5 link claims a slot');
    assert.equal(engine.protectedSelfRepairWorkspaceClaimed('real-claimed-slot'), true);
    // The single-use predicate counts any link, P2 included, so no protected Repair can reuse a workspace some link already took (P5-08).
    assert.equal(engine.protectedSelfRepairWorkspaceClaimed('real-p2-slot'), true);

    // No installed enrollment file exists in this profile: the P5 claim alone reserves its slot and anything aliasing it.
    const refusedAlias = await api.run(ordinaryWorkflow('p5-real-alias'), 'real-alias-workspace');
    assert.equal(refusedAlias.status, 409, JSON.stringify(refusedAlias.body));
    assert.equal(refusedAlias.body.code, 'p5_workspace_reserved');
    const admittedP2 = await api.run(ordinaryWorkflow('p5-real-p2-free'), 'real-p2-slot');
    assert.equal(admittedP2.status, 202, 'a generic P2 claim does not reserve an ordinary workspace (P5-08 is enforced at P5 admission)');
    await api.waitFor(admittedP2.body.run.runId);

    // The claimed slot keeps its root with no installed file: a rebind to another directory is refused, and re-stating its own root is not.
    const other = join(scratch, 'real-rebind-target');
    await mkdir(other, { recursive: true });
    const rebound = await api.call('PUT', '/api/v2/workspaces/real-claimed-slot', { cwd: other });
    assert.equal(rebound.status, 409, JSON.stringify(rebound.body));
    assert.equal(rebound.body.code, 'p5_workspace_enrolled');
    const restated = await api.call('PUT', '/api/v2/workspaces/real-claimed-slot', { cwd: claimedSlot });
    assert.equal(restated.status, 200, JSON.stringify(restated.body));
    const unclaimedRebind = await api.call('PUT', '/api/v2/workspaces/real-alias-workspace', { cwd: other });
    assert.equal(unclaimedRebind.status, 200, 'an unclaimed workspace may still be rebound');
  } finally { await api.close(); }
});

test('with an unreadable installed enrollment, every rebind is refused with a P5 code, and restating a root is not', async () => {
  const api = await startTestRunner();
  try {
    const scratch = api.runner.connection.scratchRoot;
    const ws = join(scratch, 'malformed-unclaimed');
    const other = join(scratch, 'malformed-other');
    await mkdir(ws, { recursive: true });
    await mkdir(other, { recursive: true });
    await register(api, 'malformed-unclaimed', ws);
    const profile = api.runner.engine.store.root;
    await mkdir(join(profile, 'p5'), { recursive: true });
    await writeFile(join(profile, P5_ENROLLMENT_RELATIVE_PATH), '{"workspace": ');
    const rebound = await api.call('PUT', '/api/v2/workspaces/malformed-unclaimed', { cwd: other });
    assert.equal(rebound.status, 409, JSON.stringify(rebound.body));
    assert.equal(rebound.body.code, 'p5_workspace_enrolled', 'an unknown enrollment locks every rebind (fail closed)');
    const restated = await api.call('PUT', '/api/v2/workspaces/malformed-unclaimed', { cwd: ws });
    assert.equal(restated.status, 200, JSON.stringify(restated.body));
  } finally { await api.close(); }
});

test('S2-E: a chain of junctions through an unrelated directory reaches an enrolled slot, and the Run is still refused', async () => {
  const api = await startTestRunner();
  try {
    const scratch = api.runner.connection.scratchRoot;
    const slot = join(scratch, 'enrolled-slot-chain');
    const middle = join(scratch, 'chain-middle');
    const chainWorkspace = join(scratch, 'chain-workspace');
    await installEnrollment(api, slot);
    await mkdir(middle, { recursive: true });
    await mkdir(chainWorkspace, { recursive: true });
    await symlink(middle, join(chainWorkspace, 'hop-one'), ALIAS);
    await symlink(slot, join(middle, 'hop-two'), ALIAS);
    await register(api, 'chain-workspace', chainWorkspace);

    const refused = await api.run(ordinaryWorkflow('p5-s2e-chain'), 'chain-workspace');
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'p5_workspace_reserved', JSON.stringify(refused.body));
  } finally { await api.close(); }
});
