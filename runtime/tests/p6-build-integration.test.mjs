// Focused builder trust-boundary integration tests. The packaged build and real Host switch are
// covered by p6-build-e2e; these cases prove the builder refuses hand-authored provenance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../core/store.mjs';
import { ownedDir, testsRoot } from './test-roots.mjs';
import { buildAndAttestEnginePackage } from '../core/p6Builder.mjs';

const fakeRef = () => ({ artifactId: randomUUID(), sha256: 'a'.repeat(64) });
const ref = value => ({ artifactId: value.artifactId, sha256: value.sha256 });

function fixture() {
  const root = ownedDir(join(testsRoot, 'p6-build-int-'));
  const store = new Store(join(root, 'state.sqlite'));
  const handoff = {
    schemaVersion: 1, kind: 'ProtectedSelfRepairHandoff', handoffId: '1'.repeat(64),
    candidateId: '2'.repeat(64), candidateSourceDigest: '3'.repeat(64), candidate: fakeRef(),
    gitCandidate: fakeRef(), sourceManifest: { entries: [] }, changeManifest: fakeRef(), enrollment: fakeRef(),
  };
  const handoffArtifact = store.putJson(handoff);
  const handoffRef = ref(handoffArtifact);
  const previousRelease = {
    schemaVersion: 1, kind: 'ProtectedSelfRepairRunningSourceRelease', installationId: 'b'.repeat(32),
    buildId: 'engine-a', bootstrap: 'runtime', packageSha256: 'c'.repeat(64), sourceCommit: 'd'.repeat(40),
    sourceDigest: 'e'.repeat(64), inputsDigest: 'f'.repeat(64),
  };
  const operation = {
    schemaVersion: 1, kind: 'P6Operation', operationId: randomUUID(), handoff: handoffRef,
    handoffId: handoff.handoffId, candidate: handoff.candidate, gitCandidate: handoff.gitCandidate,
    candidateId: handoff.candidateId, candidateSourceDigest: handoff.candidateSourceDigest,
    previousRelease, engineBuildId: 'engine-b', shellBuildId: 'shell-a', generation: 'fixture-generation',
    enrollmentRoot: handoff.enrollment, createdAt: new Date().toISOString(),
  };
  const operationIntentRef = ref(store.putJson(operation));
  return { root, store, handoff, handoffRef, operation, operationIntentRef, previousRelease };
}

function buildInput(f, handoff = f.handoff) {
  const scratch = join(f.root, 'unused-source');
  mkdirSync(scratch, { recursive: true });
  return {
    store: f.store, handoff, handoffRef: f.handoffRef, reconstructedSourceRoot1: scratch,
    reconstructedSourceRoot2: scratch, shell: { kind: 'DeszoShellRelease', shellBuildId: 'shell-a' },
    runtimeResources: null, outDir: join(f.root, 'unused-output'), engineBuildId: 'engine-b',
    operationId: f.operation.operationId, operationIntentRef: f.operationIntentRef,
    previousRelease: f.previousRelease, prepareSuccessor: async () => { throw new Error('must not run'); },
  };
}

test('P6-BUILD Integration: refuses a handoff whose candidate and Git refs are not immutable Store objects', async () => {
  const f = fixture();
  try {
    await assert.rejects(() => buildAndAttestEnginePackage(buildInput(f)), error => {
      assert.equal(error.code, 'p6_reconstruction_git_provenance_invalid');
      return true;
    });
  } finally { f.store.close(); }
});

test('P6-BUILD Integration: refuses a dereferenced handoff that differs from the exact Store artifact', async () => {
  const f = fixture();
  try {
    const altered = { ...f.handoff, candidateSourceDigest: '9'.repeat(64) };
    await assert.rejects(() => buildAndAttestEnginePackage(buildInput(f, altered)), error => {
      assert.equal(error.code, 'p6_reconstruction_git_provenance_invalid');
      return true;
    });
  } finally { f.store.close(); }
});
