// P6-BUILD-GENUINE-E2E support. Every input here is test-owned: the installed source defects, the protected reproducer and
// authority regression, the Parent worker's probe and the Developer's edit plans. Nothing here writes P5, P6 or Host state. The
// Engine produces every P3, P4, P2, Gate, Judge, handoff, P6 build and Host record through its production paths.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { p5VerificationCommandDigest } from '../core/protectedSelfRepair.mjs';

// Two incidents in one installed Engine-core module. Each names its exported function, the arguments that reproduce it and the
// expected result. Repair one fixes the first export and Repair two fixes the second, so each Repair's causal reproduction runs
// against a baseline that still carries its own defect. One module keeps the protected reproducer to a single subject, which
// the Gate's subject binding requires (exactly one candidate entrypoint per check).
export const SUBJECT = 'runtime/core/incidentFormat.mjs';
const LABEL_DEFECT = "export function incidentLabel(code) { return String(code).split('_')[0]; }";
const LABEL_FIXED = "export function incidentLabel(code) { return String(code).split('_').join(' '); }";
const ORDER_DEFECT = 'export function incidentOrder(codes) { return [...codes]; }';
const ORDER_FIXED = 'export function incidentOrder(codes) { return [...codes].sort(); }';
const moduleText = (label, order) => ['// P3 incident formatting: failure labels and digest ordering.', label, order, ''].join('\n');

export const DEFECTS = Object.freeze([
  { subject: SUBJECT, exportName: 'incidentLabel', args: ['provider_unavailable'], expected: 'provider unavailable' },
  { subject: SUBJECT, exportName: 'incidentOrder', args: [['b', 'a']], expected: ['a', 'b'] },
]);

/** The installed module with the first `repaired` incidents fixed. Repair n's Developer writes exactly this module. */
export function incidentModule(repaired = 0) {
  return moduleText(repaired >= 1 ? LABEL_FIXED : LABEL_DEFECT, repaired >= 2 ? ORDER_FIXED : ORDER_DEFECT);
}

export const REPRODUCER_PATH = 'runtime/tests/p6-genuine/incident-reproducer.test.mjs';
export const AUTHORITY_PATH = 'runtime/tests/p6-genuine/authority-regression.test.mjs';
const CASES = DEFECTS.map(({ subject, exportName, args, expected }) => ({ subject, export: exportName, args, expected }));

// Protected reproducer, committed in the installed baseline and overlaid over every candidate. The criteria (subject, export,
// arguments, expected result) live here, in the protected file, so the captured P3 incident can only select one of them.
// `incident-captured` binds the replay to a protected criterion and proves the installed baseline fails it; `incident-repaired`
// runs the candidate's subject against the same criterion.
export function reproducerText() {
  // The subject is a static import: the Gate resolves the protected subject's closure from static imports only.
  const exportNames = [...new Set(DEFECTS.map(defect => defect.exportName))];
  return [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { readFileSync } from 'node:fs';",
    "import { resolve } from 'node:path';",
    `import { ${exportNames.join(', ')} } from '../../${SUBJECT.slice('runtime/'.length)}';`,
    `const EXPORTS = { ${exportNames.join(', ')} };`,
    `const CASES = ${JSON.stringify(CASES)};`,
    'function capturedIncident() {',
    "  const manifest = JSON.parse(readFileSync(process.env.DESZO_P5_INPUT_MANIFEST, 'utf8'));",
    '  for (const input of manifest.inputs) {',
    '    let value;',
    "    try { value = JSON.parse(readFileSync(resolve(manifest.root, input.relativePath), 'utf8')); } catch { continue; }",
    "    const line = String(value.stderrTail || '').split(/\\r?\\n/).find(item => item.startsWith('P5-INCIDENT '));",
    "    if (line) return JSON.parse(line.slice('P5-INCIDENT '.length));",
    '  }',
    '  return null;',
    '}',
    'function criterionOf(incident) { return CASES.find(item => item.subject === incident?.subject && item.export === incident?.export); }',
    "test('incident-captured', () => {",
    '  const incident = capturedIncident();',
    "  const criterion = criterionOf(incident);",
    "  assert.ok(criterion, 'the captured P3 evidence names a protected incident');",
    '  assert.deepEqual(incident.args, criterion.args); assert.deepEqual(incident.expected, criterion.expected);',
    "  assert.notDeepEqual(incident.observed, criterion.expected, 'the installed baseline failed this exact reproduction');",
    '});',
    "test('incident-repaired', async () => {",
    '  const criterion = criterionOf(capturedIncident());',
    "  assert.ok(criterion, 'the captured P3 evidence names a protected incident');",
    '  assert.deepEqual(await EXPORTS[criterion.export](...criterion.args), criterion.expected);',
    '});', ''].join('\n');
}

// Protected authority regression for the strictest tier: it executes the candidate's P5 module as future Engine code.
export const AUTHORITY_REGRESSION = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { p5VerificationReceiptId, validateP5SourcePath } from '../../core/protectedSelfRepair.mjs';",
  "test('authority-path-guard', () => {",
  "  for (const path of ['../escape.mjs', 'C:/absolute.mjs', 'a/../../b.mjs', 'a//b.mjs']) assert.throws(() => validateP5SourcePath(path), path);",
  "  assert.equal(validateP5SourcePath('src/a.mjs'), 'src/a.mjs');",
  '});',
  "test('authority-receipt-identity', () => {",
  "  const base = { candidateId: 'a'.repeat(64), verificationPolicyDigest: 'b'.repeat(64), gateAttemptId: '00000000-0000-4000-8000-000000000001', custodyId: 'c', checks: [] };",
  '  assert.equal(p5VerificationReceiptId(base), p5VerificationReceiptId({ ...base }));',
  "  assert.notEqual(p5VerificationReceiptId(base), p5VerificationReceiptId({ ...base, custodyId: 'd' }));",
  '});', ''].join('\n');

/** Every file the test source repository carries beyond the current P5 closure: the incident module and both protected checks. */
export function genuineSourceFiles() {
  return new Map([[SUBJECT, incidentModule(0)], [REPRODUCER_PATH, reproducerText()], [AUTHORITY_PATH, AUTHORITY_REGRESSION]]);
}

// The Parent worker's probe. It exercises every installed incident in order and reports the first one whose observed result
// differs from its expected result. The installed root names the exact package the probe runs against.
export function probeScript(installedRoot) {
  return [
    "import { pathToFileURL } from 'node:url';",
    "import { join } from 'node:path';",
    `const ROOT = ${JSON.stringify(installedRoot)};`,
    `const CASES = ${JSON.stringify(CASES)};`,
    'for (const item of CASES) {',
    "  const subject = await import(pathToFileURL(join(ROOT, ...item.subject.split('/'))).href);",
    '  const observed = await subject[item.export](...item.args);',
    '  if (JSON.stringify(observed) !== JSON.stringify(item.expected)) {',
    "    console.log('P5-INCIDENT ' + JSON.stringify({ ...item, observed }));",
    '    process.exitCode = 1;',
    '    break;',
    '  }',
    '}', ''].join('\n');
}

const PLAN_RECORD = String.fromCharCode(30), PLAN_FIELD = String.fromCharCode(31);
/** The Developer's edit plan for Repair n: one whole-file write of the module with incidents 1..n fixed. */
export function fixPlan(repairNumber) { return [['write', SUBJECT, '', incidentModule(repairNumber)]]; }
export function planText(operations) { return operations.map(item => item.join(PLAN_FIELD)).join(PLAN_RECORD); }

/** A protected check bound to a test-owned node executable; `overlayPaths` are the protected files the Gate overlays. */
export function protectedCheck({ checkId, stageId, path, subjectEntryPoints, expectedAssertions, environment, nodeTool }) {
  const value = { checkId, stageId, required: true, executable: nodeTool.path, executableSha256: nodeTool.sha256,
    argv: ['--test-reporter=junit', '--test', path], cwd: 'candidate-execution-tree', inputRefs: [], environment,
    subjectEntryPoints, expectedAssertions, expectedExitCodes: [0], timeoutSeconds: 200, maxOutputBytes: 65536,
    subjectBinding: 'protected-overlay', overlayPaths: [path] };
  value.commandDigest = p5VerificationCommandDigest(value);
  return value;
}

/** The Parent worker's probe written for one installed package root, as the fixture's test-owned agent input. */
export function writeProbe(fixtureState, nodePath, installedRoot) {
  writeFileSync(join(fixtureState, 'p5-probe-node.txt'), nodePath);
  writeFileSync(join(fixtureState, 'p5-probe.mjs'), probeScript(installedRoot));
}

export function writeDeveloperPlan(fixtureState, repairNumber) {
  writeFileSync(join(fixtureState, 'p5-developer-plan.txt'), planText(fixPlan(repairNumber)));
}

export function repairDefinition(workflowId, policyRef) {
  return { schemaVersion: 1, workflowId, capabilities: ['core-v1', 'loops-v1', 'pipeline-v1', 'protected-self-repair-v1'], settings: { nativeConfiguration: 'restricted' },
    nodes: [
      { id: 'request', type: 'text', config: { value: 'Repair the installed Engine defect that the captured P3 incident reproduces.' } },
      // The planned-edit fixture: it applies exactly the Developer plan this test writes (the default model writes a fixed label fix).
      { id: 'developer', type: 'agent', config: { provider: 'codex', model: 'custody-p5-developer-plan', timeoutSeconds: 240, output: { format: 'text' } } },
      { id: 'developer-result', type: 'result-viewer', config: {} },
      { id: 'verify', type: 'gate', config: { mode: 'self-repair-verify', verificationPolicy: policyRef } },
      { id: 'report', type: 'result-viewer', config: {} },
      { id: 'repair-judge', type: 'agent', config: { provider: 'codex', model: 'custody-p5-repair-judge', timeoutSeconds: 120, output: { format: 'json' }, role: 'judge' } },
    ],
    edges: [edge('request-developer', 'request', 'text', 'developer', 'prompt'), edge('developer-result', 'developer', 'text', 'developer-result', 'value'),
      edge('verify-report', 'verify', 'report', 'report', 'value')],
    after: [{ before: 'developer', after: 'verify' }], judgePolicy: p4Policy('repair-judge') };
}

export function parentDefinition(workflowId, profile) {
  return { schemaVersion: 1, workflowId, capabilities: ['core-v1', 'protected-self-repair-v1'], settings: { nativeConfiguration: 'restricted' },
    nodes: [
      { id: 'request', type: 'text', config: { value: 'Exercise the installed Engine behavior for the current incident.' } },
      { id: 'worker', type: 'agent', config: { provider: 'codex', model: 'custody-p5-parent-probe', timeoutSeconds: 120, output: { format: 'text' } } },
      { id: 'result', type: 'result-viewer', config: {} },
      { id: 'judge', type: 'agent', config: { provider: 'codex', model: 'custody-p5-parent-judge', timeoutSeconds: 120, output: { format: 'json' }, role: 'judge' } },
    ],
    edges: [edge('request-worker', 'request', 'text', 'worker', 'prompt'), edge('worker-result', 'worker', 'text', 'result', 'value')],
    after: [], judgePolicy: p4Policy('judge', [profile]) };
}

const edge = (id, source, sourcePort, target, targetPort) => ({ id, source: { nodeId: source, port: sourcePort }, target: { nodeId: target, port: targetPort } });
const p4Policy = (judgeNodeId, repairProfiles = []) => ({ version: 'workflow-judge/1', judgeNodeId, maxJudgeAttemptsPerRun: 8, maxEvidenceExpansionsPerAttention: 1, repairProfiles });

export const publicationOf = body => ({ workflowId: body.workflow.workflowId, publishedVersionId: body.publishedVersionId, version: body.version,
  snapshotSha256: body.snapshotSha256 });

/** Publishes one workflow through the Owner API: create the draft, validate it, then publish that draft. */
export async function publish(call, definition) {
  const draft = await call('PUT', `/api/v4/workflows/${definition.workflowId}/draft`, { requestId: randomUUID(), workflow: definition }, { 'If-None-Match': '*' });
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  const validation = await call('POST', `/api/v4/workflows/${definition.workflowId}/draft/validate`, {}, { 'If-Match': draft.etag });
  assert.equal(validation.status, 200, JSON.stringify(validation.body));
  assert.equal(validation.body.validation.valid, true, JSON.stringify(validation.body.validation));
  const publication = await call('POST', `/api/v4/workflows/${definition.workflowId}/publish`, { requestId: randomUUID() }, { 'If-Match': draft.etag });
  assert.equal(publication.status, 201, JSON.stringify(publication.body));
  return publication.body;
}
