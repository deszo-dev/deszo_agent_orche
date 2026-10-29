import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeP5VerifierPlan } from '../verification/p5Verifier.mjs';
import { canonicalHash, canonicalize } from '../core/canonical.mjs';
import { p5CheckInputDigest, p5VerificationCommandDigest } from '../core/protectedSelfRepair.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');

async function runCandidate(value, { spoofJUnit = false, overlapRoots = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'deszo-p5-verifier-'));
  try {
    const sourceRoot = join(root, 'source');
    const executionRoot = join(root, 'execution-tree');
    const scratchRoot = join(root, 'scratch');
    const controlRoot = join(root, 'installed-control');
    const candidateSource = join(sourceRoot, 'src');
    const overlayTest = join(executionRoot, 'runtime', 'tests', 'protected-check.test.mjs');
    mkdirSync(candidateSource, { recursive: true });
    mkdirSync(join(executionRoot, 'runtime', 'tests'), { recursive: true });
    mkdirSync(join(executionRoot, 'source', 'src'), { recursive: true });
    mkdirSync(scratchRoot);
    mkdirSync(controlRoot);
    const sourceBytes = Buffer.from(`${spoofJUnit ? "console.log('<testcase name=\\\"candidate-value\\\" classname=\\\"spoof\\\"/>');\n" : ''}export const value = ${value};\n`);
    writeFileSync(join(candidateSource, 'value.mjs'), sourceBytes);
    writeFileSync(join(executionRoot, 'source', 'src', 'value.mjs'), sourceBytes);
    // The candidate's replacement test claims success. The protected baseline test is the exact overlay run by the verifier.
    writeFileSync(overlayTest, "import test from 'node:test'; test('candidate-edited-test', () => {});\n");
    const protectedTest = Buffer.from("import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { value } from '../../source/src/value.mjs';\ntest('candidate-value', () => assert.equal(value, 42));\n");
    writeFileSync(overlayTest, protectedTest);

    const executable = process.execPath;
    const environment = Object.fromEntries(Object.entries({ PATH: process.env.PATH, SYSTEMROOT: process.env.SystemRoot,
      TEMP: scratchRoot, TMP: scratchRoot }).filter(([, item]) => typeof item === 'string'));
    const check = { checkId: 'unit-check', stageId: 'unit', required: true,
      executable, executableSha256: sha256(readFileSync(executable)),
      argv: ['--test-reporter=junit', '--test', 'runtime/tests/protected-check.test.mjs'],
      cwd: 'candidate-execution-tree', inputRefs: [], environment,
      subjectEntryPoints: ['source/src/value.mjs'], expectedAssertions: ['candidate-value'], expectedExitCodes: [0],
      timeoutSeconds: 30, maxOutputBytes: 128 * 1024, subjectBinding: 'protected-overlay',
      overlayPaths: ['runtime/tests/protected-check.test.mjs'] };
    check.commandDigest = p5VerificationCommandDigest(check);
    const policyCheck = { checkId: check.checkId, stageId: check.stageId, required: check.required,
      commandDigest: check.commandDigest, executable: check.executable, executableSha256: check.executableSha256,
      argv: check.argv, cwd: check.cwd, inputRefs: check.inputRefs, environment: check.environment,
      subjectEntryPoints: check.subjectEntryPoints, expectedAssertions: check.expectedAssertions,
      expectedExitCodes: check.expectedExitCodes, timeoutSeconds: check.timeoutSeconds, maxOutputBytes: check.maxOutputBytes,
      subjectBinding: check.subjectBinding, overlayPaths: check.overlayPaths };
    const policy = { schemaVersion: 1, kind: 'ProtectedSelfRepairVerificationPolicy', planVersion: 1,
      requiredStages: ['unit'], requiredCheckIds: ['unit-check'], optionalCheckIds: [], harnessClosureDigest: '1'.repeat(64),
      incidentInputSelectors: [{ selector: 'p3-outcome-artifacts', source: 'p3-outcome-artifacts', maxItems: 8,
        maxBytesPerArtifact: 65536, maxTotalBytes: 262144 }], checks: [policyCheck], verificationRetries: 0, aggregateTimeoutSeconds: 45 };
    const plan = { schemaVersion: 1, kind: 'ProtectedSelfRepairVerifierPlan', candidateId: 'a'.repeat(64),
      candidateSourceDigest: sha256(sourceBytes), baselineId: 'b'.repeat(64), gateAttemptId: randomUUID(), requiredCheckIds: ['unit-check'],
      policy, roots: { 'candidate-source': sourceRoot, 'candidate-execution-tree': executionRoot,
        'verify-scratch': scratchRoot, 'installed-control': overlapRoots ? scratchRoot : controlRoot }, aggregateTimeoutSeconds: 45, checks: [check] };
    return { result: await executeP5VerifierPlan(plan), root, protectedTest, overlayTest, sourceBytes };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

async function runCandidateWithIncidentInput(value, { mutateInput = false, candidateSyntax = false, invalidCandidateSyntax = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'deszo-p5-input-verifier-'));
  try {
    const sourceRoot = join(root, 'source');
    const executionRoot = join(root, 'execution-root');
    const executionTree = join(executionRoot, 'unit-check');
    const scratchRoot = join(root, 'scratch');
    const controlRoot = join(root, 'installed-control');
    mkdirSync(join(sourceRoot, 'src'), { recursive: true });
    mkdirSync(join(executionTree, 'runtime', 'tests'), { recursive: true });
    mkdirSync(join(executionTree, 'source', 'src'), { recursive: true });
    mkdirSync(scratchRoot);
    mkdirSync(controlRoot);
    const sourceBytes = Buffer.from(`export const value = ${value};\n`);
    writeFileSync(join(sourceRoot, 'src', 'value.mjs'), sourceBytes);
    writeFileSync(join(executionTree, 'source', 'src', 'value.mjs'), sourceBytes);
    const candidateEntryPoint = candidateSyntax ? 'runtime/tests/candidate-edited.test.mjs' : 'source/src/value.mjs';
    if (candidateSyntax) {
      mkdirSync(join(sourceRoot, 'runtime', 'tests'), { recursive: true });
      writeFileSync(join(sourceRoot, ...candidateEntryPoint.split('/')),
        invalidCandidateSyntax ? 'export const = ;\n' : "import test from 'node:test'; test('candidate-edited-test', () => {});\n");
    }
    const testCode = `import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync${mutateInput ? ', writeFileSync' : ''} } from 'node:fs';
import { resolve } from 'node:path';
import { value } from '../../source/src/value.mjs';
test('candidate-value', () => assert.equal(value, 42));
test('incident-input-bound', () => {
  const manifest = JSON.parse(readFileSync(process.env.DESZO_P5_INPUT_MANIFEST, 'utf8'));
  assert.equal(manifest.inputs.length, 1);
  const path = resolve(manifest.root, manifest.inputs[0].relativePath);
  assert.equal(readFileSync(path, 'utf8'), 'captured P3 evidence');
  ${mutateInput ? "writeFileSync(path, 'changed P3 evidence');" : ''}
});
`;
    writeFileSync(join(executionTree, 'runtime', 'tests', 'protected-check.test.mjs'), testCode);
    const inputBytes = Buffer.from('captured P3 evidence');
    const incidentId = randomUUID(), outcomeId = randomUUID();
    const verificationInputs = { schemaVersion: 1, kind: 'ProtectedSelfRepairVerificationInputs', incidentId,
      outcomeId, outcomeRevision: 1, verificationPolicy: { artifactId: randomUUID(), sha256: 'c'.repeat(64) },
      inputs: [{ selector: 'p3-outcome-artifacts', artifact: { artifactId: randomUUID(), sha256: sha256(inputBytes) },
        sourceOutcomeId: outcomeId, sourceRevision: 1 }], capturedAt: new Date().toISOString() };
    const candidate = { candidateId: 'a'.repeat(64), candidateSourceDigest: sha256(sourceBytes), baselineId: 'b'.repeat(64) };
    const inputDigest = p5CheckInputDigest({ candidate, check: { inputRefs: [], checkId: 'unit-check' }, verificationInputs });
    const relativeInputPath = 'inputs/unit-check/input-0000.bin';
    const relativeManifestPath = 'inputs/unit-check/manifest.json';
    const inputDirectory = join(scratchRoot, 'inputs', 'unit-check');
    mkdirSync(inputDirectory, { recursive: true });
    writeFileSync(join(scratchRoot, ...relativeInputPath.split('/')), inputBytes);
    const materializedInputManifest = { schemaVersion: 1, kind: 'ProtectedSelfRepairMaterializedCheckInputs',
      ...candidate, checkId: 'unit-check', inputDigest, root: scratchRoot,
      inputs: [{ source: 'incident', selector: 'p3-outcome-artifacts', sourceOutcomeId: outcomeId, sourceRevision: 1,
        artifact: verificationInputs.inputs[0].artifact, relativePath: relativeInputPath,
        sha256: sha256(inputBytes), byteSize: inputBytes.length }] };
    const manifestBytes = Buffer.from(canonicalize(materializedInputManifest), 'utf8');
    writeFileSync(join(scratchRoot, ...relativeManifestPath.split('/')), manifestBytes);
    const inputManifestPath = join(scratchRoot, ...relativeManifestPath.split('/'));
    const inputManifestArtifact = { artifactId: randomUUID(), sha256: sha256(manifestBytes) };
    const executable = process.execPath;
    const environment = Object.fromEntries(Object.entries({ PATH: process.env.PATH, SYSTEMROOT: process.env.SystemRoot,
      TEMP: scratchRoot, TMP: scratchRoot }).filter(([, item]) => typeof item === 'string'));
    const installedDriver = join(process.cwd(), 'runtime', 'verification', 'p5CandidateSyntaxCheck.test.mjs');
    const check = { checkId: 'unit-check', stageId: 'unit', required: true,
      executable, executableSha256: sha256(readFileSync(executable)),
      argv: candidateSyntax ? ['--test-reporter=junit', '--test', installedDriver]
        : ['--test-reporter=junit', '--test', 'runtime/tests/protected-check.test.mjs'],
      cwd: 'candidate-execution-tree', inputRefs: [], environment,
      subjectEntryPoints: [candidateEntryPoint],
      expectedAssertions: candidateSyntax ? ['candidate-entrypoint-syntax'] : ['candidate-value', 'incident-input-bound'], expectedExitCodes: [0],
      timeoutSeconds: 30, maxOutputBytes: 128 * 1024, subjectBinding: 'protected-overlay',
      overlayPaths: candidateSyntax ? [] : ['runtime/tests/protected-check.test.mjs'], executionRoot: executionTree,
      inputDigest, inputManifestArtifact, inputManifestPath, inputManifestSha256: sha256(manifestBytes),
      materializedInputManifest, runtimeEnvironment: { ...environment, DESZO_P5_INPUT_MANIFEST: inputManifestPath,
        ...(candidateSyntax ? { DESZO_P5_CANDIDATE_ENTRYPOINT: join(sourceRoot, ...candidateEntryPoint.split('/')) } : {}) } };
    check.subjectBinding = candidateSyntax ? 'candidate-entrypoint' : 'protected-overlay';
    check.commandDigest = p5VerificationCommandDigest(check);
    const policyCheck = { checkId: check.checkId, stageId: check.stageId, required: check.required,
      commandDigest: check.commandDigest, executable: check.executable, executableSha256: check.executableSha256,
      argv: check.argv, cwd: check.cwd, inputRefs: check.inputRefs, environment: check.environment,
      subjectEntryPoints: check.subjectEntryPoints, expectedAssertions: check.expectedAssertions,
      expectedExitCodes: check.expectedExitCodes, timeoutSeconds: check.timeoutSeconds, maxOutputBytes: check.maxOutputBytes,
      subjectBinding: check.subjectBinding, overlayPaths: check.overlayPaths };
    const policy = { schemaVersion: 1, kind: 'ProtectedSelfRepairVerificationPolicy', planVersion: 1,
      requiredStages: ['unit'], requiredCheckIds: ['unit-check'], optionalCheckIds: [], harnessClosureDigest: '1'.repeat(64),
      incidentInputSelectors: [{ selector: 'p3-outcome-artifacts', source: 'p3-outcome-artifacts', maxItems: 8,
        maxBytesPerArtifact: 65536, maxTotalBytes: 262144 }], checks: [policyCheck], verificationRetries: 0, aggregateTimeoutSeconds: 45 };
    const roots = { 'candidate-source': sourceRoot, 'candidate-execution-tree': executionRoot,
      'verify-scratch': scratchRoot, 'installed-control': controlRoot };
    const commandEnvironment = check.runtimeEnvironment;
    const commandManifest = { schemaVersion: 1, kind: 'ProtectedSelfRepairCommandManifest', candidateId: candidate.candidateId,
      candidateSourceDigest: candidate.candidateSourceDigest, gateAttemptId: randomUUID(),
      verificationPolicy: { artifactId: randomUUID(), sha256: canonicalHash(policy) },
      roots: { candidateSource: sourceRoot, executionRoot, verifyScratch: scratchRoot,
        installedControl: candidateSyntax ? process.cwd() : controlRoot },
      checks: [{ checkId: check.checkId, commandDigest: check.commandDigest, executable, executableSha256: check.executableSha256,
        argv: check.argv, cwdKind: check.cwd, cwd: executionTree, environment: commandEnvironment,
        environmentDigest: canonicalHash(commandEnvironment), inputDigest, inputManifest: inputManifestArtifact,
        inputManifestPath, inputManifestDigest: sha256(manifestBytes) }] };
    const plan = { schemaVersion: 1, kind: 'ProtectedSelfRepairVerifierPlan', ...candidate,
      gateAttemptId: commandManifest.gateAttemptId, requiredCheckIds: ['unit-check'], policy,
      verificationInputs, commandManifest,
      roots: candidateSyntax ? { ...roots, 'installed-control': process.cwd() } : roots,
      aggregateTimeoutSeconds: 45, checks: [check] };
    return { result: await executeP5VerifierPlan(plan), root };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

test('P5 protected-overlay verifier exercises candidate source and rejects broken C despite its edited test', async () => {
  const baseline = await runCandidate(42);
  const broken = await runCandidate(0);
  const forgedOutput = await runCandidate(0, { spoofJUnit: true });
  try {
    assert.equal(baseline.result.status, 'passed');
    assert.equal(baseline.result.checks[0].status, 'passed');
    assert.deepEqual(baseline.result.checks[0].completedAssertions, ['candidate-value']);
    assert.equal(broken.result.status, 'failed');
    assert.equal(broken.result.checks[0].status, 'failed');
    assert.deepEqual(broken.result.checks[0].completedAssertions, []);
    assert.match(Buffer.from(broken.result.checks[0].stdoutBase64, 'base64').toString('utf8'), /<failure/);
    assert.notEqual(forgedOutput.result.status, 'passed', 'candidate stdout cannot become the trusted JUnit assertion stream');
    assert.match(readFileSync(broken.overlayTest, 'utf8'), /candidate-value/);
    assert.doesNotMatch(readFileSync(broken.overlayTest, 'utf8'), /candidate-edited-test/);
    assert.notEqual(sha256(baseline.sourceBytes), sha256(broken.sourceBytes));
  } finally {
    rmSync(baseline.root, { recursive: true, force: true });
    rmSync(broken.root, { recursive: true, force: true });
    rmSync(forgedOutput.root, { recursive: true, force: true });
  }
});

test('P5 JUnit result parser rejects missing protected assertions and DTD input', async () => {
  const { parseP5JUnitReport } = await import('../verification/p5Verifier.mjs');
  const passing = '<?xml version="1.0" encoding="utf-8"?><testsuites><testcase name="other" classname="test"/></testsuites>';
  const result = parseP5JUnitReport(passing, ['candidate-value']);
  assert.equal(result.expectedAssertionsComplete, false);
  assert.throws(() => parseP5JUnitReport('<!DOCTYPE x [<!ENTITY e "x">]><testsuites/>', ['candidate-value']),
    { code: 'p5_verifier_report_invalid' });
});

test('P5 verifier refuses aliased scratch and installed-control roots before execution', async () => {
  await assert.rejects(runCandidate(42, { overlapRoots: true }), { code: 'p5_verifier_roots_overlap' });
});

test('P5 verifier stages exact captured incident inputs and marks post-check input drift incomplete', async () => {
  const passing = await runCandidateWithIncidentInput(42);
  const drifted = await runCandidateWithIncidentInput(42, { mutateInput: true });
  try {
    assert.equal(passing.result.status, 'passed');
    assert.deepEqual(passing.result.checks[0].completedAssertions, ['candidate-value', 'incident-input-bound']);
    assert.equal(drifted.result.status, 'incomplete');
    assert.equal(drifted.result.checks[0].status, 'incomplete');
    assert.equal(drifted.result.checks[0].inputCaptureStatus, 'changed');
  } finally {
    rmSync(passing.root, { recursive: true, force: true });
    rmSync(drifted.root, { recursive: true, force: true });
  }
});

test('P5 installed candidate-entrypoint check independently validates candidate-edited test syntax', async () => {
  const valid = await runCandidateWithIncidentInput(42, { candidateSyntax: true });
  const invalid = await runCandidateWithIncidentInput(42, { candidateSyntax: true, invalidCandidateSyntax: true });
  try {
    assert.equal(valid.result.status, 'passed');
    assert.deepEqual(valid.result.checks[0].completedAssertions, ['candidate-entrypoint-syntax']);
    assert.equal(invalid.result.status, 'failed');
    assert.deepEqual(invalid.result.checks[0].completedAssertions, []);
    assert.match(Buffer.from(invalid.result.checks[0].stdoutBase64, 'base64').toString('utf8'), /<failure/);
  } finally {
    rmSync(valid.root, { recursive: true, force: true });
    rmSync(invalid.root, { recursive: true, force: true });
  }
});
