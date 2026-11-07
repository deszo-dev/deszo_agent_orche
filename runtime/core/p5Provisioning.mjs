// Installation-owned P5 enrollment install. This is the Owner/installation setup step, outside every workflow: no Developer,
// Judge or Repair can reach it. It is Engine-owned, not part of the Lifecycle Host service closure, so the P5 modules it reuses
// stay repairable Engine source. It validates the complete acyclic enrollment graph against the managed profile Store and
// the release record the Owner read from GET /api/v2/installation/source-release, then writes profile/p5/enrollment.json
// exactly once. The caller-supplied record is not itself proof: at every startup the Engine refuses the enrollment unless
// the Lifecycle Host's live attestation of the running package equals the enrolled release.
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalHash, canonicalize, sha256 } from './canonical.mjs';
import { resolveWorkspaceRoot, workspaceRootsOverlap } from './workspaceIsolation.mjs';
import { assertP5EnrollmentCurrent, assertP5RootEnrollment, assertP5VerificationPolicy, assertP5WorkspacePool, P5_ENROLLMENT_RELATIVE_PATH,
  p5EnrollmentWorkspacePool, ProtectedSelfRepairError, validateP5Contract } from './protectedSelfRepair.mjs';

const refuse = message => { throw new ProtectedSelfRepairError('p5_enrollment_install_refused', message); };

// `hostWorkspaceIdentities` maps each enrolled slot to the native identity the Lifecycle Host attested for it at setup. When it is
// given, every pool entry must equal the attested identity, so a slot is enrolled only as the Host sees it.
export function installP5Enrollment({ profileRoot, store, enrollment, attestedRelease, hostWorkspaceIdentities = null }) {
  validateP5Contract('enrollment', enrollment);
  validateP5Contract('runningSourceRelease', attestedRelease);
  assertP5RootEnrollment(enrollment);
  for (const ref of [enrollment.baselineManifest, enrollment.runningSourceRelease, enrollment.profile, enrollment.verificationPolicy]) store.verifyRef(ref);
  const storedRelease = store.readJson(enrollment.runningSourceRelease.artifactId);
  if (canonicalHash(storedRelease) !== enrollment.runningSourceRelease.sha256 || canonicalHash(storedRelease) !== canonicalHash(attestedRelease))
    refuse('The enrolled running release is not the Lifecycle Host attestation of this installation.');
  assertP5WorkspacePool(enrollment);
  const registered = store.all('SELECT id, cwd FROM workspaces');
  for (const entry of p5EnrollmentWorkspacePool(enrollment)) {
    const row = store.get('SELECT cwd FROM workspaces WHERE id = ?', entry.workspaceId);
    if (!row || resolve(row.cwd).toLowerCase() !== resolve(entry.canonicalRoot).toLowerCase())
      refuse(`Enrolled slot "${entry.workspaceId}" is not the registered workspace at its canonical root.`);
    // The enrolled root is the slot's real path: a junction, subst or alias root would hide the slot from the overlap checks.
    let realRoot;
    try { realRoot = realpathSync.native(entry.canonicalRoot); }
    catch { refuse(`Enrolled slot "${entry.workspaceId}" is not a directory.`); }
    if (realRoot.toLowerCase() !== resolve(entry.canonicalRoot).toLowerCase())
      refuse(`Enrolled slot "${entry.workspaceId}" is not at its real path; an alias or junction root cannot be enrolled.`);
    if (readdirSync(entry.canonicalRoot).length)
      refuse(`Enrolled slot "${entry.workspaceId}" is not empty; a single-use slot is enrolled empty.`);
    if (hostWorkspaceIdentities && canonicalHash(hostWorkspaceIdentities[entry.workspaceId]) !== canonicalHash(entry.nativeIdentity))
      refuse(`Enrolled slot "${entry.workspaceId}" differs from its Host-attested native identity.`);
    // No other registered workspace, and no other slot, may overlap an enrolled slot's real directory (nested, junctioned or aliased).
    for (const other of registered.filter(item => item.id !== entry.workspaceId)) {
      let otherRoot;
      try { otherRoot = resolveWorkspaceRoot(other.cwd); } catch { continue; }
      if (workspaceRootsOverlap(entry.canonicalRoot, otherRoot))
        refuse(`Registered workspace "${other.id}" overlaps enrolled slot "${entry.workspaceId}"; an enrolled slot is isolated from every other workspace.`);
    }
  }
  const profile = store.readJson(enrollment.profile.artifactId);
  assertP5EnrollmentCurrent({ store, enrollment, profile, parentPublication: enrollment.parentPublication,
    repairPublication: enrollment.repairPublication, sourceRelease: enrollment.runningSourceRelease,
    currentRepositoryIdentity: enrollment.repositoryIdentity });
  const policy = store.readJson(enrollment.verificationPolicy.artifactId);
  assertP5VerificationPolicy(policy);
  if (policy.harnessClosureDigest !== enrollment.harnessClosureDigest || enrollment.harnessClosureDigest !== attestedRelease.inputsDigest)
    refuse('The verification harness closure must be the Host-attested build-input digest.');
  for (const publication of [enrollment.parentPublication, enrollment.repairPublication]) {
    const row = store.get(`SELECT p.*, a.sha256 AS snapshot_sha256 FROM workflow_publications p JOIN artifacts a ON a.id = p.snapshot_artifact_id
      WHERE p.id = ? AND p.workflow_id = ? AND p.runnable = 1`, publication.publishedVersionId, publication.workflowId);
    if (!row || row.version !== publication.version || row.snapshot_sha256 !== publication.snapshotSha256)
      refuse(`The enrolled publication ${publication.workflowId} v${publication.version} is not a runnable publication of this profile.`);
  }
  const directory = join(profileRoot, 'p5');
  mkdirSync(directory, { recursive: true });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) refuse('The P5 enrollment directory is not a plain directory.');
  const bytes = Buffer.from(`${canonicalize(enrollment)}\n`, 'utf8');
  const path = join(profileRoot, P5_ENROLLMENT_RELATIVE_PATH);
  let fd;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (error) { refuse(error.code === 'EEXIST' ? 'A P5 enrollment is already installed; it is never replaced in place.' : `The enrollment cannot be written (${error.code}).`); }
  try { let offset = 0; while (offset < bytes.length) offset += writeSync(fd, bytes, offset); fsyncSync(fd); } finally { closeSync(fd); }
  return { path, fileSha256: sha256(bytes), enrollmentDigest: canonicalHash(enrollment) };
}
