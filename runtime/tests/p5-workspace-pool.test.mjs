// P5 single-use slot pool and root-bound Parent identity (2026-11-04 contract amendment): the pure helpers every P5 and P6 path
// shares. The live claim, successor selection and exhaustion are exercised by the packaged genuine E2E.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertP5RootEnrollment, assertP5WorkspacePool, enrolledParentProfile, nextP5WorkspaceSlot, p5EnrollmentWorkspacePool,
  poolEntryForProfileWorkspace, profileWorkspaceOf } from '../core/protectedSelfRepair.mjs';

const slot = number => ({ workspaceId: `p5-slot-${number}`, canonicalRoot: `C:\\deszo\\slots\\slot-${number}`,
  allocationId: `00000000-0000-4000-8000-00000000000${number}`, nativeIdentity: { volumeId: 'v1', fileId: `f${number}` } });
const enrollmentWith = pool => ({ workspace: pool[0], ...(pool.length > 1 ? { workspacePool: pool } : {}),
  profile: { artifactId: '11111111-1111-4111-8111-111111111111', sha256: 'a'.repeat(64) } });

test('a single-slot enrollment carries a pool of one; an ordered pool is returned in order', () => {
  assert.deepEqual(p5EnrollmentWorkspacePool({ workspace: slot(1) }), [slot(1)]);
  assert.deepEqual(p5EnrollmentWorkspacePool(enrollmentWith([slot(1), slot(2), slot(3)])).map(item => item.workspaceId),
    ['p5-slot-1', 'p5-slot-2', 'p5-slot-3']);
});

test('an ordered pool of distinct slots is accepted when its first entry is the enrolled workspace', () => {
  assert.doesNotThrow(() => assertP5WorkspacePool(enrollmentWith([slot(1), slot(2), slot(3)])));
  assert.doesNotThrow(() => assertP5WorkspacePool({ workspace: slot(1) }));
});

test('a pool whose first entry is not the enrolled workspace is refused', () => {
  assert.throws(() => assertP5WorkspacePool({ workspace: slot(2), workspacePool: [slot(1), slot(2)] }), { code: 'p5_workspace_pool_invalid' });
});

test('two pool entries sharing a workspace, allocation or canonical root are refused, case-insensitively for roots', () => {
  assert.throws(() => assertP5WorkspacePool(enrollmentWith([slot(1), { ...slot(2), workspaceId: 'p5-slot-1' }])), { code: 'p5_workspace_pool_invalid' });
  assert.throws(() => assertP5WorkspacePool(enrollmentWith([slot(1), { ...slot(2), allocationId: slot(1).allocationId }])), { code: 'p5_workspace_pool_invalid' });
  assert.throws(() => assertP5WorkspacePool(enrollmentWith([slot(1), { ...slot(2), canonicalRoot: slot(1).canonicalRoot.toUpperCase() }])),
    { code: 'p5_workspace_pool_invalid' });
});

test('slots that nest or overlap are refused, so one Repair never reaches another slot\'s retained content', () => {
  assert.throws(() => assertP5WorkspacePool(enrollmentWith([slot(1), { ...slot(2), canonicalRoot: `${slot(1).canonicalRoot}\\nested` }])),
    { code: 'p5_workspace_pool_invalid' });
  assert.throws(() => assertP5WorkspacePool(enrollmentWith([{ ...slot(1), canonicalRoot: 'C:\\deszo\\slots' }, slot(2)])),
    { code: 'p5_workspace_pool_invalid' });
});

test('a root enrollment never carries rootProfile; only a verified P6 continuation derives it', () => {
  assert.doesNotThrow(() => assertP5RootEnrollment({ workspace: slot(1) }));
  assert.throws(() => assertP5RootEnrollment({ workspace: slot(1), rootProfile: { artifactId: 'x', sha256: 'c'.repeat(64) } }),
    { code: 'p5_enrollment_invalid' });
});

test('the successor takes the next pool entry after the slot its release runs on, and none after the last', () => {
  const pool = [slot(1), slot(2), slot(3)];
  assert.deepEqual(nextP5WorkspaceSlot({ workspace: pool[0], workspacePool: pool }), pool[1]);
  assert.deepEqual(nextP5WorkspaceSlot({ workspace: pool[1], workspacePool: pool }), pool[2]);
  assert.equal(nextP5WorkspaceSlot({ workspace: pool[2], workspacePool: pool }), null, 'an exhausted pool has no successor slot');
  assert.equal(nextP5WorkspaceSlot({ workspace: pool[0] }), null, 'a single-slot enrollment has no successor slot');
});

test('the Parent publication binds the root profile identity, and a successor effective profile never replaces it', () => {
  const root = { artifactId: 'root', sha256: 'a'.repeat(64) };
  const successor = { artifactId: 'successor', sha256: 'b'.repeat(64) };
  assert.deepEqual(enrolledParentProfile({ profile: root }), root);
  assert.deepEqual(enrolledParentProfile({ profile: successor, rootProfile: root }), root);
});

test('a successor profile workspace resolves to its enrolled slot only when allocation and canonical root both match', () => {
  const pool = [slot(1), slot(2), slot(3)];
  const enrollment = enrollmentWith(pool);
  assert.deepEqual(poolEntryForProfileWorkspace(enrollment, profileWorkspaceOf(slot(2))), slot(2));
  assert.equal(poolEntryForProfileWorkspace(enrollment, { ...profileWorkspaceOf(slot(2)), allocationId: slot(3).allocationId }), null);
  assert.equal(poolEntryForProfileWorkspace(enrollment, { ...profileWorkspaceOf(slot(2)), canonicalRoot: 'C:\\deszo\\elsewhere' }), null);
  assert.equal(poolEntryForProfileWorkspace(enrollment, profileWorkspaceOf({ ...slot(9), workspaceId: 'p5-slot-9' })), null);
});

test('the profile form of a slot is single-use and clean-committed, as every enrolled profile requires', () => {
  assert.deepEqual(profileWorkspaceOf(slot(1)), { workspaceId: 'p5-slot-1', allocationId: slot(1).allocationId,
    canonicalRoot: slot(1).canonicalRoot, singleUse: true, cleanCommitted: true });
});
