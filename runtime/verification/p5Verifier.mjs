// Trusted launcher for the initial P5 protected-overlay verification profile.
// Candidate test output is captured from the test child and never forwarded to this process's
// control stdout. The Node JUnit reporter supplies the structured test completion stream.
import { spawn } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalHash, canonicalize, sha256 } from '../core/canonical.mjs';
import { assertP5VerificationPolicy, p5CheckInputDigest, p5VerificationCommandDigest,
  P5_VERIFICATION_INPUT_MANIFEST_ENV, P5_VERIFICATION_CANDIDATE_ENTRYPOINT_ENV } from '../core/protectedSelfRepair.mjs';

const MAX_PLAN_BYTES = 4 * 1024 * 1024;
const MAX_RESULT_BYTES = 56 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;
const FORBIDDEN_ENV = /^(?:NODE_OPTIONS|NODE_PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA)$/i;
const ROOT_NAMES = new Set(['candidate-source', 'candidate-execution-tree', 'verify-scratch', 'installed-control']);
const MAX_CHECK_INPUT_BYTES = 64 * 1024 * 1024;
const CANDIDATE_SYNTAX_DRIVER = resolve(dirname(fileURLToPath(import.meta.url)), 'p5CandidateSyntaxCheck.test.mjs');

export class P5VerifierError extends Error {
  constructor(code, message) { super(message); this.name = 'P5VerifierError'; this.code = code; }
}

function fail(code, message) { throw new P5VerifierError(code, message); }
function ordinal(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function samePath(a, b) { return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; }
function withinPath(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function pathsOverlap(left, right) { return withinPath(left, right) || withinPath(right, left); }

function strictExecutableIdentity(path, expectedSha256) {
  if (typeof path !== 'string' || !isAbsolute(path) || !/^[a-f0-9]{64}$/.test(expectedSha256 || ''))
    fail('p5_verifier_tool_invalid', 'A P5 check executable must have an absolute path and captured SHA-256 identity.');
  let info, canonical;
  try { info = lstatSync(path); canonical = realpathSync.native(path); }
  catch { fail('p5_verifier_tool_unavailable', `P5 check executable is unavailable: ${path}`); }
  if (!info.isFile() || info.isSymbolicLink() || !samePath(resolve(path), resolve(canonical)))
    fail('p5_verifier_tool_unsafe', 'A P5 check executable must be a canonical regular file.');
  const actual = sha256(readFileSync(canonical));
  if (actual !== expectedSha256) fail('p5_verifier_tool_changed', `P5 check executable changed after enrollment: ${path}`);
  return { path: canonical, sha256: actual };
}

function xmlDecode(value) {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, entity => {
    if (entity === '&amp;') return '&';
    if (entity === '&lt;') return '<';
    if (entity === '&gt;') return '>';
    if (entity === '&quot;') return '"';
    if (entity === '&apos;') return "'";
    const numeric = /^&#(x[0-9a-f]+|\d+);$/i.exec(entity);
    if (!numeric) fail('p5_verifier_report_invalid', 'The Node JUnit report contains an unsupported XML entity.');
    const code = numeric[1][0].toLowerCase() === 'x' ? Number.parseInt(numeric[1].slice(1), 16) : Number(numeric[1]);
    if (!Number.isSafeInteger(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
      fail('p5_verifier_report_invalid', 'The Node JUnit report contains an invalid XML code point.');
    return String.fromCodePoint(code);
  });
}

function xmlAttributes(source) {
  const attributes = {};
  let rest = source.trim();
  while (rest) {
    const match = /^([A-Za-z_:][A-Za-z0-9_.:-]*)="([^"<]*)"(?:\s+|$)/.exec(rest);
    if (!match || Object.hasOwn(attributes, match[1])) fail('p5_verifier_report_invalid', 'The Node JUnit report has malformed or duplicate attributes.');
    attributes[match[1]] = xmlDecode(match[2]);
    rest = rest.slice(match[0].length).trimStart();
  }
  return attributes;
}

/** Parse only the XML vocabulary emitted by Node's JUnit reporter; DTDs and custom entities are refused. */
export function parseP5JUnitReport(text, expectedAssertions) {
  if (typeof text !== 'string' || text.length > MAX_RESULT_BYTES || /<!DOCTYPE|<!ENTITY/i.test(text))
    fail('p5_verifier_report_invalid', 'The Node JUnit report is missing, oversized or contains a DTD/entity declaration.');
  const document = text.replace(/^\uFEFF/, '').trim();
  const root = /^<\?xml version="1\.0" encoding="utf-8"\?>\s*<testsuites>([\s\S]*)<\/testsuites>$/.exec(document);
  if (!root) fail('p5_verifier_report_invalid', 'The check did not return a complete Node JUnit testsuites document.');
  let body = root[1];
  const cases = [];
  const casePattern = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  body = body.replace(casePattern, (_whole, selfAttrs, nested = '') => {
    const attrs = xmlAttributes(selfAttrs);
    if (typeof attrs.name !== 'string' || !attrs.name || attrs.name.length > 4096)
      fail('p5_verifier_report_invalid', 'A Node JUnit test case has no bounded name.');
    let failed = false;
    let inner = nested;
    const nestedTags = /<\/?([A-Za-z][A-Za-z0-9-]*)(?:\s[^<>]*?)?\/?>/g;
    for (const tag of inner.matchAll(nestedTags)) {
      const name = tag[1];
      if (!['failure', 'error', 'skipped', 'system-out', 'system-err'].includes(name))
        fail('p5_verifier_report_invalid', `The Node JUnit report contains unsupported nested element <${name}>.`);
      if (['failure', 'error', 'skipped'].includes(name) && /^<(?:failure|error|skipped)(?:\s|\/|>)/.test(tag[0])) failed = true;
    }
    inner = inner.replace(/<(failure|error|skipped|system-out|system-err)\b[^>]*>[\s\S]*?<\/\1>|<(failure|error|skipped)\b[^>]*\/>/g, '')
      .replace(nestedTags, '').replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, '');
    if (inner.trim()) fail('p5_verifier_report_invalid', 'The Node JUnit report contains unstructured text inside a test case.');
    cases.push({ name: attrs.name, className: attrs.classname ?? '', failed });
    return '';
  });
  body = body.replace(/<testsuite\b[^>]*>|<\/testsuite>/g, '').replace(/<!--[\s\S]*?-->/g, '').trim();
  if (body) fail('p5_verifier_report_invalid', 'The Node JUnit report contains unsupported or unparsed XML.');
  if (new Set(cases.map(item => `${item.className}\0${item.name}`)).size !== cases.length)
    fail('p5_verifier_report_invalid', 'The Node JUnit report contains duplicate test case identities.');

  if (!Array.isArray(expectedAssertions) || !expectedAssertions.length || expectedAssertions.some(item => typeof item !== 'string' || !item))
    fail('p5_verifier_assertions_invalid', 'A P5 protected-overlay check must declare one or more exact expected test names.');
  const expected = [...expectedAssertions];
  const names = new Map();
  for (const item of cases) {
    const list = names.get(item.name) ?? [];
    list.push(item);
    names.set(item.name, list);
  }
  const completed = [];
  for (const assertion of expected) {
    const qualified = assertion.includes('::') ? assertion.split('::', 2) : null;
    const matches = qualified
      ? cases.filter(item => item.className === qualified[0] && item.name === qualified[1])
      : names.get(assertion) ?? [];
    if (matches.length !== 1) continue;
    if (!matches[0].failed) completed.push(assertion);
  }
  return { cases, completedAssertions: completed.sort(ordinal), expectedAssertions: [...expected].sort(ordinal),
    allCasesPassed: cases.length > 0 && cases.every(item => !item.failed),
    expectedAssertionsComplete: canonicalHash(completed.sort(ordinal)) === canonicalHash([...expected].sort(ordinal)) };
}

function validatePlan(plan) {
  if (!plan || plan.schemaVersion !== 1 || plan.kind !== 'ProtectedSelfRepairVerifierPlan'
    || typeof plan.candidateId !== 'string' || !/^[a-f0-9]{64}$/.test(plan.candidateId)
    || typeof plan.candidateSourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(plan.candidateSourceDigest)
    || typeof plan.baselineId !== 'string' || !/^[a-f0-9]{64}$/.test(plan.baselineId)
    || typeof plan.gateAttemptId !== 'string' || !Array.isArray(plan.requiredCheckIds)
    || !Array.isArray(plan.checks) || !plan.checks.length || !Number.isSafeInteger(plan.aggregateTimeoutSeconds)
    || plan.aggregateTimeoutSeconds < 1 || plan.aggregateTimeoutSeconds > 7200
    || !plan.roots || typeof plan.roots !== 'object')
    fail('p5_verifier_plan_invalid', 'The P5 verifier plan is malformed.');
  const roots = {};
  for (const name of ROOT_NAMES) {
    const path = plan.roots[name];
    if (typeof path !== 'string' || !isAbsolute(path)) fail('p5_verifier_root_invalid', `The verifier plan is missing an absolute ${name} root.`);
    let canonical, info;
    try { canonical = realpathSync.native(path); info = lstatSync(path); }
    catch { fail('p5_verifier_root_unavailable', `The verifier plan's ${name} root is unavailable.`); }
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(resolve(path), resolve(canonical)))
      fail('p5_verifier_root_unsafe', `The verifier plan's ${name} root is not a canonical ordinary directory.`);
    roots[name] = canonical;
  }
  const rootEntries = Object.entries(roots);
  for (let index = 0; index < rootEntries.length; index++) {
    for (let next = index + 1; next < rootEntries.length; next++) {
      const [leftName, leftPath] = rootEntries[index];
      const [rightName, rightPath] = rootEntries[next];
      if (pathsOverlap(leftPath, rightPath))
        fail('p5_verifier_roots_overlap', `The verifier roots ${leftName} and ${rightName} overlap.`);
    }
  }
  const allowedCwds = new Set(['candidate-source', 'candidate-execution-tree', 'verify-scratch', 'installed-control']);
  const ids = new Set();
  let aggregateCapture = 0;
  for (const check of plan.checks) {
    if (!check || typeof check.checkId !== 'string' || ids.has(check.checkId) || !Array.isArray(check.argv)
      || !Array.isArray(check.expectedAssertions) || !Array.isArray(check.expectedExitCodes)
      || !Number.isSafeInteger(check.timeoutSeconds) || !Number.isSafeInteger(check.maxOutputBytes)
      || !allowedCwds.has(check.cwd) || !['protected-overlay', 'candidate-entrypoint'].includes(check.subjectBinding)
      || !Array.isArray(check.subjectEntryPoints) || check.subjectEntryPoints.length !== 1
      || !Array.isArray(check.overlayPaths)
      || (check.subjectBinding === 'protected-overlay' && !check.overlayPaths.length)
      || (check.subjectBinding === 'candidate-entrypoint' && (check.overlayPaths.length || check.expectedAssertions.length !== 1
        || check.expectedAssertions[0] !== 'candidate-entrypoint-syntax'))
      || !check.environment || typeof check.environment !== 'object' || Array.isArray(check.environment))
      fail('p5_verifier_check_unsupported', 'This P5 verifier supports bounded protected-overlay checks and the installed candidate-entrypoint syntax check.');
    ids.add(check.checkId);
    aggregateCapture += check.maxOutputBytes;
    if (aggregateCapture > MAX_CAPTURE_BYTES) fail('p5_verifier_output_bound_exceeded', 'The captured P5 check output budget exceeds this verifier profile limit.');
    if (check.commandDigest !== p5VerificationCommandDigest(check))
      fail('p5_verifier_command_mismatch', `P5 check "${check.checkId}" differs from its captured command digest.`);
    if (check.executionRoot !== undefined) {
      let canonical, info;
      try { canonical = realpathSync.native(check.executionRoot); info = lstatSync(check.executionRoot); }
      catch { fail('p5_verifier_execution_root_unavailable', `P5 check "${check.checkId}" execution tree is unavailable.`); }
      if (!info.isDirectory() || info.isSymbolicLink() || !samePath(resolve(check.executionRoot), resolve(canonical))
        || samePath(canonical, roots['candidate-execution-tree']) || !withinPath(roots['candidate-execution-tree'], canonical))
        fail('p5_verifier_execution_root_unsafe', `P5 check "${check.checkId}" execution tree is not a canonical child of the captured candidate execution root.`);
      check.executionRoot = canonical;
    }
    if (check.cwd !== 'candidate-execution-tree')
      fail('p5_verifier_subject_cwd_unsupported', `P5 check "${check.checkId}" does not run from its candidate execution tree.`);
    if (!check.argv.includes('--test') || !check.argv.includes('--test-reporter=junit'))
      fail('p5_verifier_reporter_unsupported', `P5 check "${check.checkId}" must use Node's structured JUnit test reporter.`);
    if (check.subjectBinding === 'candidate-entrypoint') {
      const expectedArgv = ['--test-reporter=junit', '--test', CANDIDATE_SYNTAX_DRIVER];
      const entrypoint = resolve(roots['candidate-source'], ...check.subjectEntryPoints[0].split('/'));
      if (canonicalHash(check.argv) !== canonicalHash(expectedArgv)
        || check.expectedExitCodes.length !== 1 || check.expectedExitCodes[0] !== 0
        || !withinPath(roots['installed-control'], CANDIDATE_SYNTAX_DRIVER)
        || check.runtimeEnvironment?.[P5_VERIFICATION_CANDIDATE_ENTRYPOINT_ENV] !== entrypoint)
        fail('p5_verifier_candidate_entrypoint_command_invalid', `P5 check "${check.checkId}" is not the exact installed syntax-check command bound to its candidate entrypoint.`);
      assertRegularFileUnder(roots['candidate-source'], entrypoint, `P5 candidate entrypoint for ${check.checkId}`);
    }
    if (!samePath(resolve(check.executable), resolve(process.execPath)))
      fail('p5_verifier_runtime_unsupported', `P5 check "${check.checkId}" must use the installed Node runtime that launched the trusted verifier.`);
    if (Object.keys(check.environment ?? {}).some(key => FORBIDDEN_ENV.test(key)))
      fail('p5_verifier_environment_unsupported', `P5 check "${check.checkId}" includes an environment value that can load user or unpinned Node configuration.`);
    if (Object.entries(check.environment).some(([key, value]) => !/^[A-Z_][A-Z0-9_]{0,63}$/.test(key) || typeof value !== 'string'))
      fail('p5_verifier_environment_invalid', `P5 check "${check.checkId}" has a malformed explicit environment.`);
    for (const name of ['TEMP', 'TMP', 'TMPDIR']) {
      const value = check.environment[name];
      if (value !== undefined && (typeof value !== 'string' || !isAbsolute(value) || !withinPath(roots['verify-scratch'], value)))
        fail('p5_verifier_environment_unsupported', `P5 check "${check.checkId}" may use only its protected verification scratch directory for temporary files.`);
    }
    if (!check.expectedExitCodes.includes(0))
      fail('p5_verifier_exit_policy_unsupported', `P5 check "${check.checkId}" must accept zero as its successful exit code.`);
    strictExecutableIdentity(check.executable, check.executableSha256);
  }
  const required = plan.checks.filter(check => check.required).map(check => check.checkId).sort(ordinal);
  if (!required.length || canonicalHash(required) !== canonicalHash([...plan.requiredCheckIds].sort(ordinal)))
    fail('p5_verifier_required_set_mismatch', 'The verifier plan required-check set differs from its captured check definitions.');
  const policy = plan.policy;
  if (!policy) fail('p5_verifier_policy_missing', 'The verifier plan has no captured P5 verification policy.');
  assertP5VerificationPolicy(policy);
  if (plan.verificationInputs && (plan.verificationInputs.kind !== 'ProtectedSelfRepairVerificationInputs'
    || !Array.isArray(plan.verificationInputs.inputs)))
    fail('p5_verifier_inputs_invalid', 'The verifier plan has a malformed captured incident-input record.');
  if (canonicalHash(plan.checks.map(item => item.commandDigest)) !== canonicalHash(policy.checks.map(item => item.commandDigest)))
    fail('p5_verifier_policy_mismatch', 'The verifier plan commands differ from the exact captured policy order.');
  const commandManifest = plan.commandManifest;
  if (commandManifest) {
    if (commandManifest.kind !== 'ProtectedSelfRepairCommandManifest' || commandManifest.schemaVersion !== 1
      || commandManifest.candidateId !== plan.candidateId || commandManifest.candidateSourceDigest !== plan.candidateSourceDigest
      || commandManifest.gateAttemptId !== plan.gateAttemptId || !Array.isArray(commandManifest.checks)
      || commandManifest.verificationPolicy?.sha256 !== canonicalHash(plan.policy)
      || canonicalHash(commandManifest.roots) !== canonicalHash({ candidateSource: roots['candidate-source'],
        executionRoot: roots['candidate-execution-tree'], verifyScratch: roots['verify-scratch'], installedControl: roots['installed-control'] }))
      fail('p5_verifier_command_manifest_mismatch', 'The trusted verifier command manifest differs from its exact candidate, Attempt or roots.');
    if (commandManifest.checks.length !== plan.checks.length)
      fail('p5_verifier_command_manifest_mismatch', 'The trusted verifier command manifest omits or duplicates a check.');
  }
  for (const check of plan.checks) {
    const hasMaterializedInputs = Boolean(check.materializedInputManifest);
    if (hasMaterializedInputs) {
      const command = commandManifest?.checks.find(item => item.checkId === check.checkId);
      const effectiveEnvironment = { ...check.environment, [P5_VERIFICATION_INPUT_MANIFEST_ENV]: check.inputManifestPath };
      if (check.subjectBinding === 'candidate-entrypoint')
        effectiveEnvironment[P5_VERIFICATION_CANDIDATE_ENTRYPOINT_ENV] = resolve(roots['candidate-source'], ...check.subjectEntryPoints[0].split('/'));
      const expectedBinding = { checkId: check.checkId, commandDigest: check.commandDigest, executable: check.executable,
        executableSha256: check.executableSha256, argv: check.argv, cwdKind: check.cwd, cwd: check.executionRoot,
        environment: effectiveEnvironment, environmentDigest: canonicalHash(effectiveEnvironment), inputDigest: check.inputDigest,
        inputManifest: check.inputManifestArtifact, inputManifestPath: check.inputManifestPath,
        inputManifestDigest: check.inputManifestSha256 };
      if (!plan.verificationInputs || !command || canonicalHash(command) !== canonicalHash(expectedBinding)
        || canonicalHash(check.runtimeEnvironment) !== canonicalHash(effectiveEnvironment))
        fail('p5_verifier_command_manifest_mismatch', `P5 check "${check.checkId}" has no exact Engine-bound command/input manifest.`);
    } else if (check.inputRefs.length || plan.verificationInputs?.inputs?.length
      || Object.hasOwn(check.environment, P5_VERIFICATION_INPUT_MANIFEST_ENV)) {
      fail('p5_verifier_inputs_unbound', `P5 check "${check.checkId}" has captured inputs but no Engine-bound materialization manifest.`);
    }
  }
  return roots;
}

function assertRegularFileUnder(root, path, label) {
  let info, canonical;
  try { info = lstatSync(path); canonical = realpathSync.native(path); }
  catch { fail('p5_verifier_input_unavailable', `${label} is unavailable.`); }
  if (!info.isFile() || info.isSymbolicLink() || !withinPath(root, canonical) || !samePath(resolve(path), resolve(canonical)))
    fail('p5_verifier_input_unsafe', `${label} is not a canonical regular file under verification scratch.`);
  return canonical;
}

/** Verify the Engine-authored artifact map and every staged input before and after each check. */
function verifyMaterializedInputs(plan, check, roots) {
  const manifest = check.materializedInputManifest;
  if (!manifest) return true;
  const expectedDigest = p5CheckInputDigest({ candidate: { candidateId: plan.candidateId,
    candidateSourceDigest: plan.candidateSourceDigest, baselineId: plan.baselineId }, check,
  verificationInputs: plan.verificationInputs });
  if (check.inputDigest !== expectedDigest || manifest.schemaVersion !== 1
    || manifest.kind !== 'ProtectedSelfRepairMaterializedCheckInputs' || manifest.candidateId !== plan.candidateId
    || manifest.candidateSourceDigest !== plan.candidateSourceDigest || manifest.baselineId !== plan.baselineId
    || manifest.checkId !== check.checkId || manifest.inputDigest !== expectedDigest
    || !samePath(resolve(manifest.root), resolve(roots['verify-scratch']))
    || !Array.isArray(manifest.inputs) || !manifest.inputs.length || manifest.inputs.length > 128)
    fail('p5_verifier_input_manifest_mismatch', `P5 check "${check.checkId}" input manifest does not match its candidate and captured input digest.`);
  const manifestPath = check.inputManifestPath;
  const canonicalManifestPath = assertRegularFileUnder(roots['verify-scratch'], manifestPath, 'The P5 input manifest');
  const bytes = readFileSync(canonicalManifestPath);
  if (bytes.length > 1024 * 1024 || sha256(bytes) !== check.inputManifestSha256
    || canonicalHash(JSON.parse(bytes.toString('utf8'))) !== canonicalHash(manifest)
    || !Buffer.from(canonicalize(manifest), 'utf8').equals(bytes))
    fail('p5_verifier_input_manifest_mismatch', `P5 check "${check.checkId}" staged input manifest bytes differ from the Engine-bound manifest.`);
  const expectedInputs = [
    ...[...check.inputRefs].sort((left, right) => ordinal(left.artifactId, right.artifactId) || ordinal(left.sha256, right.sha256))
      .map(artifact => ({ source: 'policy', artifact })),
    ...[...plan.verificationInputs.inputs].sort((left, right) => ordinal(left.selector, right.selector)
      || ordinal(left.sourceOutcomeId, right.sourceOutcomeId) || left.sourceRevision - right.sourceRevision
      || ordinal(left.artifact.artifactId, right.artifact.artifactId))
      .map(input => ({ source: 'incident', selector: input.selector, sourceOutcomeId: input.sourceOutcomeId,
        sourceRevision: input.sourceRevision, artifact: input.artifact })),
  ];
  if (manifest.inputs.length !== expectedInputs.length)
    fail('p5_verifier_input_manifest_mismatch', `P5 check "${check.checkId}" input manifest omits a policy or incident artifact.`);
  if (resolve(manifestPath) !== resolve(roots['verify-scratch'], 'inputs', check.checkId, 'manifest.json'))
    fail('p5_verifier_input_binding_mismatch', `P5 check "${check.checkId}" input manifest is not in its reserved check-specific scratch path.`);
  let total = 0;
  for (let index = 0; index < expectedInputs.length; index++) {
    const expected = expectedInputs[index], actual = manifest.inputs[index];
    const relativePath = `inputs/${check.checkId}/input-${String(index).padStart(4, '0')}.bin`;
    const { byteSize: _byteSize, ...actualIdentity } = actual;
    const expectedRow = { ...expected, relativePath, sha256: expected.artifact.sha256 };
    if (!Number.isSafeInteger(actual.byteSize) || actual.byteSize < 0
      || canonicalHash(actualIdentity) !== canonicalHash(expectedRow))
      fail('p5_verifier_input_manifest_mismatch', `P5 check "${check.checkId}" input row ${index} differs from the captured policy/outcome refs.`);
    const path = resolve(roots['verify-scratch'], ...relativePath.split('/'));
    const canonicalPath = assertRegularFileUnder(roots['verify-scratch'], path, `P5 check input ${index}`);
    const inputBytes = readFileSync(canonicalPath);
    if (inputBytes.length !== actual.byteSize || inputBytes.length > MAX_CHECK_INPUT_BYTES || sha256(inputBytes) !== actual.sha256)
      fail('p5_verifier_input_drift', `P5 check "${check.checkId}" staged input ${index} differs from its sealed Store digest.`);
    total += inputBytes.length;
    if (total > MAX_CHECK_INPUT_BYTES) fail('p5_verifier_input_budget_exceeded', `P5 check "${check.checkId}" staged inputs exceed the verifier limit.`);
  }
  if (check.runtimeEnvironment?.[P5_VERIFICATION_INPUT_MANIFEST_ENV] !== manifestPath
    || !withinPath(roots['verify-scratch'], manifestPath))
    fail('p5_verifier_input_binding_mismatch', `P5 check "${check.checkId}" does not receive its exact scratch input manifest.`);
  return true;
}

function runCommand(check, cwd, remainingMs) {
  return new Promise(resolvePromise => {
    const startedAt = new Date().toISOString();
    const out = [], err = [];
    let outBytes = 0, errBytes = 0, captureStatus = 'complete', timedOut = false;
    let settled = false;
    const append = (list, chunk, stream) => {
      const room = Math.max(0, check.maxOutputBytes - outBytes - errBytes);
      const kept = chunk.subarray(0, room);
      if (kept.length) list.push(Buffer.from(kept));
      if (stream === 'stdout') outBytes += kept.length; else errBytes += kept.length;
      if (kept.length !== chunk.length) {
        captureStatus = 'truncated';
        try { child?.kill('SIGKILL'); } catch { /* Host Custody remains authoritative for the process tree. */ }
      }
    };
    let child;
    let timer;
    const finish = (code, signal, launchError = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(out), stderr = Buffer.concat(err);
      let parsed = null;
      if (!launchError && captureStatus === 'complete') {
        try { parsed = parseP5JUnitReport(stdout.toString('utf8'), check.expectedAssertions); }
        catch (error) { launchError = error; }
      }
      const exitExpected = check.expectedExitCodes.includes(code);
      let status = 'incomplete';
      if (captureStatus === 'complete' && !launchError && !timedOut) {
        status = exitExpected && parsed?.allCasesPassed && parsed?.expectedAssertionsComplete ? 'passed' : 'failed';
      }
      resolvePromise({ checkId: check.checkId, stageId: check.stageId, required: check.required,
        commandDigest: check.commandDigest, startedAt, endedAt: new Date().toISOString(), status,
        exitCode: Number.isInteger(code) ? code : null, expectedAssertions: [...check.expectedAssertions].sort(ordinal),
        completedAssertions: parsed?.completedAssertions ?? [], captureStatus,
        stdoutBase64: stdout.toString('base64'), stderrBase64: stderr.toString('base64'),
        stdoutSha256: sha256(stdout), stderrSha256: sha256(stderr),
        reporter: parsed ? { testCaseCount: parsed.cases.length, allCasesPassed: parsed.allCasesPassed,
          expectedAssertionsComplete: parsed.expectedAssertionsComplete } : null,
        ...(launchError ? { error: `${launchError.code || 'p5_verifier_check_error'}: ${launchError.message}`.slice(0, 2048) } : {}),
        ...(signal ? { signal } : {}), ...(timedOut ? { timedOut: true } : {}) });
    };
    try {
      const timeout = Math.max(1, Math.min(check.timeoutSeconds * 1000, remainingMs));
      child = spawn(check.executable, check.argv, { cwd, env: check.runtimeEnvironment ?? check.environment, shell: false, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', chunk => append(out, chunk, 'stdout'));
      child.stderr.on('data', chunk => append(err, chunk, 'stderr'));
      child.once('error', error => finish(null, null, Object.assign(error, { code: error.code || 'p5_verifier_spawn_failed' })));
      child.once('close', (code, signal) => finish(code, signal));
      timer = setTimeout(() => {
        timedOut = true;
        captureStatus = 'timeout';
        try { child.kill('SIGKILL'); } catch { /* Host Custody owns whole-tree Stop and terminal proof. */ }
      }, timeout);
    } catch (error) { finish(null, null, error); }
  });
}

/** Execute the captured protected-overlay plan as a single Custody-owned launcher invocation. */
export async function executeP5VerifierPlan(plan) {
  const roots = validatePlan(plan);
  for (const check of plan.checks) verifyMaterializedInputs(plan, check, roots);
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + plan.aggregateTimeoutSeconds * 1000;
  const observations = [];
  const definitions = new Map(plan.policy.checks.map(item => [item.checkId, item]));
  for (const check of plan.checks) {
    const policyCheck = definitions.get(check.checkId);
    if (!policyCheck || policyCheck.commandDigest !== check.commandDigest)
      fail('p5_verifier_check_missing', `P5 check "${check.checkId}" is not in the captured policy.`);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      observations.push({ checkId: check.checkId, stageId: check.stageId, required: check.required,
        commandDigest: check.commandDigest, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
        status: 'incomplete', exitCode: null, expectedAssertions: [...check.expectedAssertions].sort(ordinal), completedAssertions: [],
        captureStatus: 'not_started', stdoutBase64: '', stderrBase64: '', stdoutSha256: sha256(Buffer.alloc(0)), stderrSha256: sha256(Buffer.alloc(0)),
        reporter: null, error: 'P5 aggregate deadline elapsed before this check started.' });
      continue;
    }
    verifyMaterializedInputs(plan, check, roots);
    const observation = await runCommand(check, check.executionRoot || roots[check.cwd], remainingMs);
    observation.inputDigest = check.inputDigest ?? null;
    if (check.materializedInputManifest) {
      try { verifyMaterializedInputs(plan, check, roots); }
      catch (error) {
        observation.status = 'incomplete';
        observation.inputCaptureStatus = 'changed';
        observation.error = `${error.code || 'p5_verifier_input_drift'}: ${error.message}`.slice(0, 2048);
      }
    }
    const after = strictExecutableIdentity(check.executable, check.executableSha256);
    if (after.sha256 !== check.executableSha256) {
      observation.status = 'incomplete';
      observation.error = 'The P5 check executable changed during verification.';
    }
    observations.push(observation);
  }
  const required = observations.filter(item => item.required);
  const status = required.every(item => item.status === 'passed') ? 'passed'
    : required.some(item => item.status === 'failed') ? 'failed' : 'incomplete';
  const result = { schemaVersion: 1, kind: 'ProtectedSelfRepairVerifierResult', candidateId: plan.candidateId,
    candidateSourceDigest: plan.candidateSourceDigest, baselineId: plan.baselineId, gateAttemptId: plan.gateAttemptId,
    status, startedAt, endedAt: new Date().toISOString(), captureStatus: 'complete', checks: observations };
  const serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized) > MAX_RESULT_BYTES)
    fail('p5_verifier_result_too_large', 'The structured P5 verifier result exceeds its bounded control-output size.');
  return result;
}

async function readPlanFromStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_PLAN_BYTES) fail('p5_verifier_plan_too_large', 'The P5 verifier plan exceeds its input bound.');
    chunks.push(chunk);
  }
  let plan;
  try { plan = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch (error) { fail('p5_verifier_plan_invalid', `The P5 verifier plan is not valid JSON: ${error.message}`); }
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await executeP5VerifierPlan(await readPlanFromStdin());
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.code || 'p5_verifier_error'}: ${error.message}\n`);
    process.exitCode = 2;
  }
}
