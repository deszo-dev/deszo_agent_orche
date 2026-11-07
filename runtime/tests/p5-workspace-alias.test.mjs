// P5 workspace isolation against aliases and unbound runtimes (security review S2-1 to S2-3, S4-1). A junction or symbolic link inside
// an ordinary workspace reaches its target through that workspace, so root overlap alone does not reserve a slot it reaches. The
// successor build checks the registered row of its slot, and an unbound runtime still reads the installed enrollment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownedDir, releaseOwnedDir, testsRoot } from './test-roots.mjs';
import { installLinkedRepair } from '../core/linkedRepair.mjs';
import { P5_ENROLLMENT_RELATIVE_PATH } from '../core/protectedSelfRepair.mjs';
import { P5_TRUSTED_CONTROL_PATHS } from '../core/p5HostBoundary.mjs';
import { P6ConsumerError, assertSuccessorSlotRegistered } from '../core/p6Consumer.mjs';
import { ALIAS_WALK_ENTRY_LIMIT, workspaceAliasOverlap, workspaceRootsOverlap } from '../core/workspaceIsolation.mjs';

// The reservation and the enrolled-slot reader are Engine prototype methods; a stub Engine receives them without a database.
const Engine = { prototype: {} };
installLinkedRepair(Engine, { ApiError: class ApiError extends Error {} });

// A directory with a slot, an unrelated directory, and an ordinary workspace; each test adds the alias it needs.
function fixture(prefix) {
  const root = ownedDir(join(testsRoot, prefix));
  const parent = join(root, 'slots');
  const slot = join(parent, 'slot-1');
  const unrelated = join(root, 'unrelated');
  const workspace = join(root, 'workspace');
  mkdirSync(join(slot, 'sub'), { recursive: true });
  writeFileSync(join(slot, 'sub', 'retained.txt'), 'retained');
  mkdirSync(unrelated); mkdirSync(workspace);
  writeFileSync(join(workspace, 'source.txt'), 'source');
  return { root, parent, slot, unrelated, workspace, cleanup: () => releaseOwnedDir(root) };
}

// A Windows junction needs no privilege; a file symlink may be refused by policy, so the test records that case as skipped.
const junction = (target, link) => symlinkSync(target, link, 'junction');

test('a junction inside a workspace that reaches an enrolled slot is an alias overlap, though the roots do not overlap', t => {
  const f = fixture('p5-alias-junction-');
  try {
    junction(f.slot, join(f.workspace, 'into-slot'));
    // The gap the walk closes: the workspace's own real directory does not overlap the slot, so a root comparison alone admits it.
    assert.equal(workspaceRootsOverlap(f.workspace, f.slot), false);
    assert.equal(workspaceAliasOverlap(f.workspace, [f.slot]), true, 'the workspace reaches retained slot content through its junction');
  } finally { f.cleanup(); }
});

test('a junction to an unrelated directory is not an overlap, and an ordinary workspace has none', t => {
  const f = fixture('p5-alias-unrelated-');
  try {
    assert.equal(workspaceAliasOverlap(f.workspace, [f.slot]), false, 'no alias: the ordinary workspace is not reserved');
    junction(f.unrelated, join(f.workspace, 'elsewhere'));
    assert.equal(workspaceAliasOverlap(f.workspace, [f.slot]), false, 'an alias to an unrelated directory is allowed');
  } finally { f.cleanup(); }
});

test('a junction to a directory that contains an enrolled slot overlaps it: the workspace reaches the slot through the container', t => {
  const f = fixture('p5-alias-container-');
  try {
    junction(f.parent, join(f.workspace, 'container'));
    assert.equal(workspaceAliasOverlap(f.workspace, [f.slot]), true);
  } finally { f.cleanup(); }
});

test('an alias nested deeper in the workspace is found, and the walk never follows an alias into another directory', t => {
  const f = fixture('p5-alias-nested-');
  try {
    const deeper = join(f.workspace, 'a', 'b');
    mkdirSync(deeper, { recursive: true });
    junction(f.slot, join(deeper, 'reach'));
    assert.equal(workspaceAliasOverlap(f.workspace, [f.slot]), true);
    // Following the junction from a would loop back into the workspace; the walk must still terminate and report the slot once.
    junction(f.workspace, join(f.workspace, 'a', 'loop'));
    assert.equal(workspaceAliasOverlap(f.workspace, [f.slot]), true);
  } finally { f.cleanup(); }
});

test('an alias chain through an unrelated directory reaches an enrolled slot, and the workspace is refused', () => {
  const f = fixture('p5-alias-chain-');
  try {
    // The first hop leads to a directory that overlaps no slot; that directory holds the second hop into the slot.
    const middle = join(f.root, 'middle');
    mkdirSync(middle);
    junction(middle, join(f.workspace, 'hop-one'));
    junction(f.slot, join(middle, 'hop-two'));
    assert.equal(workspaceRootsOverlap(f.workspace, f.slot), false, 'the roots alone admit the chain');
    assert.equal(workspaceAliasOverlap(f.workspace, [f.slot]), true, 'the chain reaches retained slot content');
  } finally { f.cleanup(); }
});

test('an alias chain that ends outside every slot is not an overlap, and an alias back into the workspace ends the walk', () => {
  const f = fixture('p5-alias-chain-clean-');
  try {
    const middle = join(f.root, 'middle');
    mkdirSync(middle);
    junction(middle, join(f.workspace, 'hop-one'));
    junction(f.unrelated, join(middle, 'hop-two'));
    junction(f.workspace, join(f.workspace, 'self'));
    assert.equal(workspaceAliasOverlap(f.workspace, [f.slot]), false, 'no hop reaches a slot');
  } finally { f.cleanup(); }
});

test('a walk past its entry budget refuses the workspace rather than admitting an unproven one', t => {
  const f = fixture('p5-alias-budget-');
  try {
    for (let index = 0; index < 4; index += 1) writeFileSync(join(f.workspace, `file-${index}.txt`), 'x');
    assert.equal(workspaceAliasOverlap(f.workspace, [f.slot], { maxEntries: 3 }), true, 'an unfinished walk is never a clean result');
    assert.equal(workspaceAliasOverlap(f.workspace, [f.slot], { maxEntries: 100 }), false);
    assert.equal(ALIAS_WALK_ENTRY_LIMIT, 250_000);
  } finally { f.cleanup(); }
});

test('an alias whose target does not exist counts by its declared target, so a target created later cannot slip past', t => {
  const f = fixture('p5-alias-dangling-');
  try {
    try { junction(join(f.slot, 'not-yet'), join(f.workspace, 'dangling')); }
    catch (error) { t.skip(`dangling junctions are not creatable here: ${error.code}`); return; }
    assert.equal(workspaceAliasOverlap(f.workspace, [f.slot]), true, 'the declared target lies inside the slot');
  } finally { f.cleanup(); }
});

test('the workspace reservation refuses an ordinary workspace that reaches an enrolled slot by an alias, and admits one that does not', () => {
  const f = fixture('p5-alias-reserved-');
  try {
    const engine = { protectedSelfRepairEnrolledSlots: () => [{ workspaceId: 'p5-slot-1', canonicalRoot: f.slot }],
      protectedSelfRepairP5ClaimedSlots: () => [] };
    const reserved = Engine.prototype.protectedSelfRepairWorkspaceReserved;
    assert.equal(reserved.call(engine, 'ordinary', f.workspace), false, 'a workspace with no alias and no overlap is admitted');
    junction(f.slot, join(f.workspace, 'into-slot'));
    assert.equal(reserved.call(engine, 'ordinary', f.workspace), true, 'the alias reserves the workspace, so the Run is refused');
    assert.equal(reserved.call(engine, 'p5-slot-1', f.slot), true, 'an enrolled slot itself stays reserved by identity');
  } finally { f.cleanup(); }
});

test('an unbound runtime reads the enrolled slots from the installed enrollment in its profile', () => {
  const f = fixture('p5-alias-unbound-');
  try {
    const profile = f.root;
    const slot = { workspaceId: 'p5-slot-1', canonicalRoot: f.slot, allocationId: '00000000-0000-4000-8000-000000000001',
      nativeIdentity: { volumeId: 'v1', fileId: 'f1' } };
    const second = { ...slot, workspaceId: 'p5-slot-2', canonicalRoot: f.unrelated, allocationId: '00000000-0000-4000-8000-000000000002',
      nativeIdentity: { volumeId: 'v1', fileId: 'f2' } };
    mkdirSync(join(profile, 'p5'), { recursive: true });
    writeFileSync(join(profile, P5_ENROLLMENT_RELATIVE_PATH), JSON.stringify({ workspace: slot, workspacePool: [slot, second] }));
    // No Lifecycle Host and no loaded enrollment: the Store root is the profile, so both enrolled slots stay reserved.
    const unbound = { lifecycleHost: null, protectedSelfRepairEnrollment: null, store: { root: profile } };
    unbound.protectedSelfRepairEnrolledSlots = Engine.prototype.protectedSelfRepairEnrolledSlots;
    unbound.protectedSelfRepairP5ClaimedSlots = () => [];
    const pool = Engine.prototype.protectedSelfRepairEnrolledSlots.call(unbound);
    assert.deepEqual(pool.map(entry => entry.workspaceId), ['p5-slot-1', 'p5-slot-2']);
    // An ordinary workspace aimed at the second slot is refused by root overlap, without any Host.
    assert.equal(Engine.prototype.protectedSelfRepairWorkspaceReserved.call(unbound, 'ordinary', f.unrelated), true);
    // A profile with no installed enrollment reads as no enrolled slots.
    assert.deepEqual(Engine.prototype.protectedSelfRepairEnrolledSlots.call({ lifecycleHost: null, protectedSelfRepairEnrollment: null,
      store: { root: join(f.root, 'elsewhere') } }), []);
  } finally { f.cleanup(); }
});

test('the successor slot must be the registered workspace at its enrolled root before any P6 state is written', () => {
  const slot = { workspaceId: 'p5-slot-2', canonicalRoot: 'C:\\deszo\\slots\\slot-2' };
  const store = row => ({ get: () => row });
  assert.doesNotThrow(() => assertSuccessorSlotRegistered(store({ cwd: slot.canonicalRoot }), slot));
  assert.throws(() => assertSuccessorSlotRegistered(store(undefined), slot), { code: 'p6_successor_slot_unverified' });
  assert.throws(() => assertSuccessorSlotRegistered(store({ cwd: 'C:\\deszo\\slots\\slot-3' }), slot),
    { code: 'p6_successor_slot_unverified', name: 'P6ConsumerError' });
  // A row whose cwd differs only by case still names the enrolled root (Windows paths are case-insensitive).
  assert.doesNotThrow(() => assertSuccessorSlotRegistered(store({ cwd: slot.canonicalRoot.toUpperCase() }), slot));
  assert.ok(new P6ConsumerError('p6_successor_slot_unverified', 'x') instanceof Error);
});

test('a slot a P5 link has claimed stays reserved, by identity and by root, when the installed enrollment file is absent', () => {
  const f = fixture('p5-alias-claimed-');
  try {
    // A Parent link whose authorization names a protected profile claims the slot; the installed file is gone.
    const link = { repair_workspace_id: 'p5-slot-1', continuation_contract: 'logical_policy', authorization_artifact_id: 'auth-1' };
    const store = { all: () => [link], get: (sql, id) => (id === 'p5-slot-1' ? { cwd: f.slot } : undefined) };
    const engine = { store, protectedSelfRepairEnrollment: null, lifecycleHost: null,
      parentRepairAuthorization: () => ({ profile: { selfRepair: { artifactId: 'p', sha256: 'a'.repeat(64) } } }),
      protectedSelfRepairEnrolledSlots: () => [] };
    engine.protectedSelfRepairP5ClaimedSlots = Engine.prototype.protectedSelfRepairP5ClaimedSlots;
    const reserved = Engine.prototype.protectedSelfRepairWorkspaceReserved;
    assert.equal(reserved.call(engine, 'p5-slot-1', f.slot), true, 'the claimed slot itself stays reserved');
    junction(f.slot, join(f.workspace, 'into-claimed-slot'));
    assert.equal(reserved.call(engine, 'ordinary', f.workspace), true, 'an ordinary workspace that reaches the claimed slot is refused');
    assert.equal(reserved.call(engine, 'ordinary', f.unrelated), false, 'an unrelated workspace is still admitted');
    // With no claim at all, nothing is reserved once the file is gone.
    engine.store = { all: () => [], get: () => undefined };
    assert.equal(reserved.call(engine, 'ordinary', f.workspace), false, 'no claim and no file: no reservation');
  } finally { f.cleanup(); }
});

test('the claim predicate names a slot as claimed by any link on it, whatever its state, so a consumed slot is never claimed again', () => {
  const store = { get: (sql, id) => (id === 'p5-slot-1' ? { id: 'link-any-state' } : undefined) };
  const claimed = Engine.prototype.protectedSelfRepairWorkspaceClaimed;
  assert.equal(claimed.call({ store }, 'p5-slot-1'), true, 'a slot with a link is claimed');
  assert.equal(claimed.call({ store }, 'p5-slot-2'), false, 'a slot with no link is free');
  assert.equal(claimed.call({ store }, ''), false, 'no workspace id claims nothing');
});

test('a malformed installed enrollment reads as unknown, so every workspace is reserved (fail closed), not an unmapped error', () => {
  const f = fixture('p5-alias-malformed-');
  try {
    const profile = f.root;
    mkdirSync(join(profile, 'p5'), { recursive: true });
    const entry = (number, root) => ({ workspaceId: `p5-slot-${number}`, canonicalRoot: root,
      allocationId: `00000000-0000-4000-8000-00000000000${number}`, nativeIdentity: { volumeId: 'v1', fileId: `f${number}` } });
    const first = entry(1, 'C:\\deszo\\slots\\slot-1');
    const second = entry(2, 'C:\\deszo\\slots\\slot-2');
    const malformed = ['{}', '[]', '[{"workspaceId": 1}]', JSON.stringify({ workspace: first, workspacePool: [] }),
      JSON.stringify({ workspace: first, workspacePool: [second, first] })];
    const unbound = { lifecycleHost: null, protectedSelfRepairEnrollment: null, store: { root: profile } };
    for (const body of malformed) {
      writeFileSync(join(profile, P5_ENROLLMENT_RELATIVE_PATH), body);
      assert.equal(Engine.prototype.protectedSelfRepairEnrolledSlots.call(unbound), null, `${body} is not a pool`);
    }
    // A schema-valid pool led by the enrolled workspace reads back in order: the validation adds no refusal for a valid file.
    writeFileSync(join(profile, P5_ENROLLMENT_RELATIVE_PATH), JSON.stringify({ workspace: first, workspacePool: [first, second] }));
    assert.deepEqual(Engine.prototype.protectedSelfRepairEnrolledSlots.call(unbound).map(item => item.workspaceId), ['p5-slot-1', 'p5-slot-2']);
  } finally { f.cleanup(); }
});

test('a claimed slot whose directory was removed still reserves its id, and does not refuse an unrelated ordinary workspace', () => {
  const f = fixture('p5-alias-removed-');
  try {
    const gone = join(f.root, 'gone-slot'); // the Owner removed it; the claim row remains
    const store = { all: () => [{ repair_workspace_id: 'p5-slot-1', authorization_artifact_id: 'auth-1' }],
      get: (sql, id) => (id === 'p5-slot-1' ? { cwd: gone } : undefined) };
    const engine = { store, protectedSelfRepairEnrollment: null, lifecycleHost: null,
      parentRepairAuthorization: () => ({ profile: { selfRepair: { artifactId: 'p', sha256: 'a'.repeat(64) } } }),
      protectedSelfRepairEnrolledSlots: () => [] };
    engine.protectedSelfRepairP5ClaimedSlots = Engine.prototype.protectedSelfRepairP5ClaimedSlots;
    const reserved = Engine.prototype.protectedSelfRepairWorkspaceReserved;
    assert.equal(reserved.call(engine, 'p5-slot-1', gone), true, 'the claim reserves its slot by identity');
    assert.equal(reserved.call(engine, 'ordinary', f.unrelated), false, 'an unrelated workspace is not refused for the removed directory');
  } finally { f.cleanup(); }
});

test('a removed claimed directory is still protected: a dangling junction to its declared path, or to the parent that holds it, is refused', () => {
  const f = fixture('p5-alias-removed-reach-');
  try {
    const gone = join(f.parent, 'gone-slot'); // inside the existing slots directory; the directory itself was removed
    const otherWorkspace = join(f.root, 'workspace-two');
    mkdirSync(otherWorkspace);
    const store = { all: () => [{ repair_workspace_id: 'p5-slot-1', authorization_artifact_id: 'auth-1' }],
      get: (sql, id) => (id === 'p5-slot-1' ? { cwd: gone } : undefined) };
    const engine = { store, protectedSelfRepairEnrollment: null, lifecycleHost: null,
      parentRepairAuthorization: () => ({ profile: { selfRepair: { artifactId: 'p', sha256: 'a'.repeat(64) } } }),
      protectedSelfRepairEnrolledSlots: () => [] };
    engine.protectedSelfRepairP5ClaimedSlots = Engine.prototype.protectedSelfRepairP5ClaimedSlots;
    const reserved = Engine.prototype.protectedSelfRepairWorkspaceReserved;
    junction(gone, join(f.workspace, 'to-declared-path'));
    assert.equal(reserved.call(engine, 'ordinary', f.workspace), true, 'a dangling junction to the declared path reaches the claimed root');
    junction(f.parent, join(otherWorkspace, 'to-parent'));
    assert.equal(reserved.call(engine, 'ordinary', otherWorkspace), true, 'a junction to the directory holding the claimed root reaches it');
  } finally { f.cleanup(); }
});

test('a claimed root that is a regular file reserves the workspace (it is not a directory, so the declared-path fallback does not apply)', () => {
  const f = fixture('p5-alias-file-root-');
  try {
    const notADirectory = join(f.root, 'plain-file');
    writeFileSync(notADirectory, 'not a directory');
    const store = { all: () => [{ repair_workspace_id: 'p5-slot-1', authorization_artifact_id: 'auth-1' }],
      get: (sql, id) => (id === 'p5-slot-1' ? { cwd: notADirectory } : undefined) };
    const engine = { store, protectedSelfRepairEnrollment: null, lifecycleHost: null,
      parentRepairAuthorization: () => ({ profile: { selfRepair: { artifactId: 'p', sha256: 'a'.repeat(64) } } }),
      protectedSelfRepairEnrolledSlots: () => [] };
    engine.protectedSelfRepairP5ClaimedSlots = Engine.prototype.protectedSelfRepairP5ClaimedSlots;
    assert.equal(Engine.prototype.protectedSelfRepairWorkspaceReserved.call(engine, 'ordinary', f.workspace), true,
      'a claim that cannot be resolved as a directory reserves the workspace (fail closed)');
  } finally { f.cleanup(); }
});

test('an unreadable authorization claims its slot, so a lost artifact cannot release a Repair slot', () => {
  const f = fixture('p5-alias-unreadable-');
  try {
    const store = { all: () => [{ repair_workspace_id: 'p5-slot-1', authorization_artifact_id: 'lost' }],
      get: (sql, id) => (id === 'p5-slot-1' ? { cwd: f.slot } : undefined) };
    const engine = { store, protectedSelfRepairEnrollment: null, lifecycleHost: null, parentRepairAuthorization: () => null,
      protectedSelfRepairEnrolledSlots: () => [] };
    engine.protectedSelfRepairP5ClaimedSlots = Engine.prototype.protectedSelfRepairP5ClaimedSlots;
    const reserved = Engine.prototype.protectedSelfRepairWorkspaceReserved;
    assert.equal(reserved.call(engine, 'p5-slot-1', f.slot), true, 'the claim reserves its slot by identity');
    junction(f.slot, join(f.workspace, 'into-claimed-slot'));
    assert.equal(reserved.call(engine, 'ordinary', f.workspace), true, 'an ordinary workspace that reaches the claimed slot is refused');
  } finally { f.cleanup(); }
});

test('a readable authorization is read once per Engine however many links name it, and a generic P2 link claims nothing', () => {
  let reads = 0;
  const links = [{ repair_workspace_id: 'p5-slot-1', authorization_artifact_id: 'same' },
    { repair_workspace_id: 'p5-slot-2', authorization_artifact_id: 'same' }];
  const engine = { store: { all: () => links, get: () => ({ cwd: 'C:\\deszo\\slots\\slot-x' }) },
    parentRepairAuthorization: () => { reads += 1; return { profile: { selfRepair: { artifactId: 'p', sha256: 'a'.repeat(64) } } }; } };
  const claimed = Engine.prototype.protectedSelfRepairP5ClaimedSlots;
  assert.equal(claimed.call(engine).length, 2);
  assert.equal(claimed.call(engine).length, 2);
  assert.equal(reads, 1, 'one read of the content-addressed authorization serves every call');
  const generic = { store: { all: () => [{ repair_workspace_id: 'p2-ws', authorization_artifact_id: 'p2' }], get: () => ({ cwd: 'C:\\x' }) },
    parentRepairAuthorization: () => ({ profile: {} }) };
  assert.equal(claimed.call(generic).length, 0, 'a generic P2 Repair claims no P5 slot');
});

test('every installed P6 core module is in the trusted control closure, so the Gate attests its bytes', () => {
  const coreDir = fileURLToPath(new URL('../core/', import.meta.url));
  const p6Modules = readdirSync(coreDir).filter(name => /^p6[A-Z][A-Za-z]*\.mjs$/.test(name));
  assert.ok(p6Modules.length >= 7, 'the P6 core modules are present');
  const missing = p6Modules.filter(name => !P5_TRUSTED_CONTROL_PATHS.includes(`runtime/core/${name}`));
  assert.deepEqual(missing, [], 'no P6 trust module is left outside the trusted closure');
});
