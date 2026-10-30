import { builtinModules } from 'node:module';
import ts from 'typescript';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalHash, canonicalize, sha256 } from './canonical.mjs';
import { assertValid } from './schemas.mjs';
import { nowIso } from './store.mjs';
import { jsonValue, ref } from './utilities.mjs';
import {
  assertP5VerificationPolicy, inventoryP5SourceWithHost, materializeP5VerificationOverlay,
  p5CheckInputDigest, p5ExecutionTreeDigest, p5VerificationReceiptId, validateP5Contract,
  verifyP5GitBaselineCurrent, verifyP5OverlayManifest, verifyP5Receipt, verifyP5RunningSourceInventory, verifyP5VerificationInputsCurrent,
  P5_VERIFICATION_INPUT_MANIFEST_ENV, P5_VERIFICATION_CANDIDATE_ENTRYPOINT_ENV,
  materializeP5BaselineReproducerTree, P5_BASELINE_TREE_DIRECTORY,
} from './protectedSelfRepair.mjs';
import { verifyP5GitCandidateCurrent } from './p5GitCandidate.mjs';
import { custodyCrashOnce } from './custody.mjs';
import { ENGINE_PACKAGED, ENGINE_ROOT } from './engineRoot.mjs';
import { P5_TRUSTED_CONTROL_PATHS } from './p5HostBoundary.mjs';
import { readInstalledSourceInventory, verifyP5PackageLayout } from './p5Support.mjs';

const P5_PROVIDER = 'p5-verifier';
const VERIFIER_RELATIVE = 'runtime/verification/p5Verifier.mjs';
const VERIFIER_PATH = resolve(ENGINE_ROOT, VERIFIER_RELATIVE);
const CANDIDATE_SYNTAX_DRIVER_RELATIVE = 'runtime/verification/p5CandidateSyntaxCheck.test.mjs';
const CANDIDATE_SYNTAX_DRIVER = resolve(ENGINE_ROOT, CANDIDATE_SYNTAX_DRIVER_RELATIVE);
const MAX_P5_CHECK_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_P5_GATE_INPUT_BYTES = 128 * 1024 * 1024;
// One list for attestation (here) and mutation tiers (p5HostBoundary.mjs), so they can never disagree (review F5).
export const TRUSTED_SOURCE_PATHS = P5_TRUSTED_CONTROL_PATHS;
if (!TRUSTED_SOURCE_PATHS.includes(VERIFIER_RELATIVE) || !TRUSTED_SOURCE_PATHS.includes(CANDIDATE_SYNTAX_DRIVER_RELATIVE))
  throw new Error('The P5 trusted control closure must include the installed verifier and syntax driver.');
const COMPATIBLE_BUILTINS = new Set(builtinModules.flatMap(name => [name, name.replace(/^node:/, '')]));
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const asRef = artifact => ({ artifactId: artifact.artifactId, sha256: artifact.sha256 });

function fail(code, message) { throw Object.assign(new Error(message), { code }); }

function verifyP5ActiveSourceInventory(engine, currentRunningSourceRelease) {
  return verifyP5RunningSourceInventory({ store: engine.store, enrollment: engine.protectedSelfRepairEnrollment,
    currentRunningSourceRelease, generation: engine.lifecycleHost?.generation, installedInventory: readInstalledSourceInventory(),
    readBatch: paths => engine.lifecycleClient.runningSourceInventory({ pid: process.pid, paths }) });
}

function verifyRef(store, artifactRef, name) {
  if (!artifactRef?.artifactId || !artifactRef?.sha256) fail('p5_artifact_missing', `P5 ${name} reference is missing.`);
  store.verifyRef(artifactRef);
  return artifactRef;
}

function readRecord(store, artifactRef, name) {
  verifyRef(store, artifactRef, name);
  const record = store.readJson(artifactRef.artifactId);
  validateP5Contract(name, record);
  return record;
}

function sortedSourceEntries(manifest) {
  if (!manifest || !Array.isArray(manifest.entries)) fail('p5_source_manifest_invalid', 'The sealed candidate source manifest is malformed.');
  return [...manifest.entries].sort((left, right) => compareText(left.path, right.path));
}

function executableForManifest(manifest) {
  const byPath = new Map(sortedSourceEntries(manifest).map(entry => [entry.path, entry.executable]));
  return path => byPath.get(path) ?? false;
}

function sourceEntriesMatch(actual, manifest) {
  const expected = sortedSourceEntries(manifest).map(({ artifact: _artifact, ...entry }) => entry);
  return canonicalHash([...actual].sort((left, right) => compareText(left.path, right.path))) === canonicalHash(expected);
}

function assertRealDirectory(path, label) {
  let info, canonical;
  try { info = lstatSync(path); canonical = realpathSync.native(path); }
  catch { fail('p5_directory_unavailable', `P5 ${label} directory is unavailable.`); }
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(resolve(path), resolve(canonical)))
    fail('p5_directory_unsafe', `P5 ${label} directory is not a canonical ordinary directory.`);
  return canonical;
}

function ensureDirectory(path) {
  try { mkdirSync(path); }
  catch (error) { if (error.code !== 'EEXIST') fail('p5_directory_create_failed', `P5 could not create a verification directory (${error.code || 'error'}).`); }
  return assertRealDirectory(path, 'verification');
}

function safeChildPath(root, portablePath) {
  const parts = portablePath.split('/');
  const absolute = resolve(root, ...parts);
  const rel = relative(root, absolute);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    fail('p5_path_escape', 'A P5 source path escaped its materialized root.');
  return absolute;
}

function createDirectoriesForFile(root, absolute) {
  let current = root;
  for (const part of relative(root, dirname(absolute)).split(sep).filter(Boolean)) {
    current = join(current, part);
    ensureDirectory(current);
  }
}

function writeOrVerifyP5File({ path, bytes, mode, allowExisting, conflictCode, failedCode, label }) {
  try {
    writeFileSync(path, bytes, { flag: 'wx', mode });
    return false;
  } catch (error) {
    if (error.code !== 'EEXIST') fail(failedCode, `${label} could not be materialized (${error.code || 'error'}).`);
    if (!allowExisting) fail(conflictCode, `${label} path was already occupied.`);
    let info, canonical;
    try { info = lstatSync(path); canonical = realpathSync.native(path); }
    catch { fail(conflictCode, `${label} path could not be safely inspected.`); }
    if (!info.isFile() || info.isSymbolicLink() || !samePath(resolve(path), resolve(canonical)))
      fail(conflictCode, `${label} path is not a canonical regular file.`);
    const existing = readFileSync(path);
    if (existing.length !== bytes.length || sha256(existing) !== sha256(bytes))
      fail(conflictCode, `${label} path already contains different bytes.`);
    return true;
  }
}

function assertMaterializedTreeLayout(root, paths, code, label, directories = []) {
  const expectedFiles = new Set(paths), expectedDirectories = new Set(directories);
  for (const path of expectedFiles) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) expectedDirectories.add(parts.slice(0, index).join('/'));
  }
  const actualFiles = new Set(), actualDirectories = new Set();
  const walk = (directory, relativeDirectory = '') => {
    let names;
    try { names = readdirSync(directory).sort(compareText); }
    catch { fail(code, `${label} directory could not be enumerated safely.`); }
    for (const name of names) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const absolute = join(directory, name);
      let info, canonical;
      try { info = lstatSync(absolute); canonical = realpathSync.native(absolute); }
      catch { fail(code, `${label} entry "${relativePath}" could not be inspected.`); }
      if (info.isDirectory() && !info.isSymbolicLink() && samePath(resolve(absolute), resolve(canonical))) {
        if (!expectedDirectories.has(relativePath)) fail(code, `${label} contains unexpected directory "${relativePath}".`);
        actualDirectories.add(relativePath);
        walk(absolute, relativePath);
      } else if (info.isFile() && !info.isSymbolicLink() && samePath(resolve(absolute), resolve(canonical))) {
        if (!expectedFiles.has(relativePath)) fail(code, `${label} contains unexpected file "${relativePath}".`);
        actualFiles.add(relativePath);
      } else fail(code, `${label} contains an unsafe or unsupported entry "${relativePath}".`);
    }
  };
  assertRealDirectory(root, label);
  walk(root);
  if (canonicalHash([...actualFiles].sort(compareText)) !== canonicalHash([...expectedFiles].sort(compareText))
    || canonicalHash([...actualDirectories].sort(compareText)) !== canonicalHash([...expectedDirectories].sort(compareText)))
    fail(code, `${label} does not contain the exact expected file and directory layout.`);
}

function materializeCandidateSource({ store, candidate, sourceManifest, root, allowExisting = false }) {
  ensureDirectory(root);
  for (const entry of sortedSourceEntries(sourceManifest)) {
    const path = safeChildPath(root, entry.path);
    createDirectoriesForFile(root, path);
    verifyRef(store, entry.artifact, `candidate source object ${entry.path}`);
    const bytes = store.readBytes(entry.artifact.artifactId).bytes;
    if (bytes.length !== entry.byteSize || sha256(bytes) !== entry.sha256)
      fail('p5_candidate_object_mismatch', `Sealed candidate object "${entry.path}" failed its content digest.`);
    writeOrVerifyP5File({ path, bytes, mode: entry.executable ? 0o700 : 0o600, allowExisting,
      conflictCode: 'p5_candidate_materialization_conflict', failedCode: 'p5_candidate_materialization_failed',
      label: `Candidate materialization "${entry.path}"` });
    if (process.platform !== 'win32' && entry.executable) chmodSync(path, 0o700);
  }
  assertRealDirectory(root, 'candidate source');
  assertMaterializedTreeLayout(root, sortedSourceEntries(sourceManifest).map(entry => entry.path),
    'p5_candidate_materialization_conflict', 'Candidate materialization');
  return root;
}

export function materializeP5CheckInputs({ store, candidate, check, verificationInputs, inputDigest, scratchRoot, aggregateBytes,
  allowExisting = false }) {
  const relativeManifestPath = `inputs/${check.checkId}/manifest.json`;
  const manifestPath = safeChildPath(scratchRoot, relativeManifestPath);
  createDirectoriesForFile(scratchRoot, manifestPath);
  const ordered = [
    ...[...check.inputRefs].sort((left, right) => compareText(left.artifactId, right.artifactId) || compareText(left.sha256, right.sha256))
      .map(artifact => ({ source: 'policy', artifact })),
    ...[...verificationInputs.inputs].sort((left, right) => compareText(left.selector, right.selector)
      || compareText(left.sourceOutcomeId, right.sourceOutcomeId) || left.sourceRevision - right.sourceRevision
      || compareText(left.artifact.artifactId, right.artifact.artifactId))
      .map(input => ({ source: 'incident', selector: input.selector, sourceOutcomeId: input.sourceOutcomeId,
        sourceRevision: input.sourceRevision, artifact: input.artifact })),
  ];
  if (!ordered.length || ordered.length > 128)
    fail('p5_verification_input_materialization_invalid', `P5 check "${check.checkId}" has no bounded materializable inputs.`);
  let checkBytes = 0;
  const inputs = ordered.map((item, index) => {
    verifyRef(store, item.artifact, `verification input for ${check.checkId}`);
    const bytes = store.readBytes(item.artifact.artifactId).bytes;
    if (sha256(bytes) !== item.artifact.sha256 || bytes.length > MAX_P5_CHECK_INPUT_BYTES)
      fail('p5_verification_input_object_mismatch', `P5 check "${check.checkId}" input object failed its digest or size bound.`);
    checkBytes += bytes.length;
    if (checkBytes > MAX_P5_CHECK_INPUT_BYTES || aggregateBytes.value + checkBytes > MAX_P5_GATE_INPUT_BYTES)
      fail('p5_verification_input_budget_exceeded', 'P5 materialized check inputs exceed the enrolled verification input byte ceiling.');
    const relativePath = `inputs/${check.checkId}/input-${String(index).padStart(4, '0')}.bin`;
    const absolutePath = safeChildPath(scratchRoot, relativePath);
    createDirectoriesForFile(scratchRoot, absolutePath);
    writeOrVerifyP5File({ path: absolutePath, bytes, mode: 0o400, allowExisting,
      conflictCode: 'p5_verification_input_conflict', failedCode: 'p5_verification_input_materialization_failed',
      label: `P5 input "${relativePath}"` });
    const actual = readFileSync(absolutePath);
    if (actual.length !== bytes.length || sha256(actual) !== item.artifact.sha256)
      fail('p5_verification_input_materialization_mismatch', `P5 input path "${relativePath}" differs from its verified Store object.`);
    return { source: item.source, ...(item.selector ? { selector: item.selector,
      sourceOutcomeId: item.sourceOutcomeId, sourceRevision: item.sourceRevision } : {}),
      artifact: { artifactId: item.artifact.artifactId, sha256: item.artifact.sha256 }, relativePath,
      sha256: item.artifact.sha256, byteSize: bytes.length };
  });
  aggregateBytes.value += checkBytes;
  const manifest = { schemaVersion: 1, kind: 'ProtectedSelfRepairMaterializedCheckInputs',
    candidateId: candidate.candidateId, candidateSourceDigest: candidate.candidateSourceDigest,
    baselineId: candidate.baselineId, checkId: check.checkId, inputDigest, root: scratchRoot, inputs };
  validateP5Contract('materializedCheckInputs', manifest);
  const manifestBytes = Buffer.from(canonicalize(manifest), 'utf8');
  const manifestDigest = sha256(manifestBytes);
  const manifestRef = asRef(store.putJson(manifest));
  if (manifestRef.sha256 !== manifestDigest)
    fail('p5_verification_input_manifest_mismatch', 'P5 materialized-input manifest Store digest differs from its canonical bytes.');
  writeOrVerifyP5File({ path: manifestPath, bytes: manifestBytes, mode: 0o400, allowExisting,
    conflictCode: 'p5_verification_input_conflict', failedCode: 'p5_verification_input_materialization_failed',
    label: `P5 input manifest "${relativeManifestPath}"` });
  if (sha256(readFileSync(manifestPath)) !== manifestDigest)
    fail('p5_verification_input_materialization_mismatch', 'P5 materialized-input manifest differs from its verified Store object.');
  assertMaterializedTreeLayout(safeChildPath(scratchRoot, `inputs/${check.checkId}`),
    [...inputs.map(item => item.relativePath.slice(`inputs/${check.checkId}/`.length)), 'manifest.json'],
    'p5_verification_input_conflict', `P5 inputs for check "${check.checkId}"`);
  return { manifest, manifestRef, relativeManifestPath, absoluteManifestPath: manifestPath, manifestDigest, checkBytes };
}

function verifyMaterializedP5InputsCurrent({ store, checks, scratchRoot }) {
  for (const check of checks) {
    const relativeManifestPath = `inputs/${check.checkId}/manifest.json`;
    const expectedManifestPath = safeChildPath(scratchRoot, relativeManifestPath);
    const manifestInfo = lstatSync(expectedManifestPath);
    const manifestRealPath = realpathSync.native(expectedManifestPath);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || !samePath(manifestRealPath, expectedManifestPath))
      fail('p5_verification_input_drift', `P5 input manifest for check "${check.checkId}" is no longer a regular file at its enrolled scratch path.`);
    const manifestBytes = readFileSync(manifestRealPath);
    if (sha256(manifestBytes) !== check.inputManifestSha256
      || canonicalHash(JSON.parse(manifestBytes.toString('utf8'))) !== canonicalHash(check.materializedInputManifest))
      fail('p5_verification_input_drift', `P5 input manifest for check "${check.checkId}" changed during verification.`);
    for (const input of check.materializedInputManifest.inputs) {
      const absolutePath = safeChildPath(scratchRoot, input.relativePath);
      const info = lstatSync(absolutePath);
      const realPath = realpathSync.native(absolutePath);
      if (!info.isFile() || info.isSymbolicLink() || !samePath(realPath, absolutePath))
        fail('p5_verification_input_drift', `P5 check input "${input.relativePath}" is no longer a regular file at its enrolled scratch path.`);
      verifyRef(store, input.artifact, `verification input ${input.relativePath}`);
      const expectedBytes = store.readBytes(input.artifact.artifactId).bytes;
      const actualBytes = readFileSync(realPath);
      if (actualBytes.length !== expectedBytes.length || sha256(actualBytes) !== input.sha256
        || sha256(expectedBytes) !== input.artifact.sha256)
        fail('p5_verification_input_drift', `P5 check input "${input.relativePath}" changed during verification.`);
    }
  }
  return true;
}

function readCandidateModule(store, entry) {
  verifyRef(store, entry.artifact, `candidate source object ${entry.path}`);
  const bytes = store.readBytes(entry.artifact.artifactId).bytes;
  if (bytes.length !== entry.byteSize || sha256(bytes) !== entry.sha256)
    fail('p5_candidate_object_mismatch', `Candidate module "${entry.path}" failed its sealed digest.`);
  return bytes.toString('utf8');
}

// Executable resolution the recorded closure cannot follow (review F14). `node:module` may be imported only for these
// read-only names and is never re-exported. Loader entry points are refused as syntax (identifiers and property names, never
// text inside strings or comments), so an alias or re-export of the loader cannot reach a module outside the closure.
const LOADER_MODULES = new Set(['module', 'node:module']);
const SAFE_LOADER_BINDINGS = new Set(['builtinModules', 'isBuiltin']);
const CODE_LOADING_BUILTINS = new Set(['vm', 'worker_threads', 'wasi'].flatMap(name => [name, `node:${name}`]));
const LOADER_NAMES = new Set(['require', 'createRequire', '_load', '_resolveFilename', 'getBuiltinModule']);
const PROCESS_LOADERS = new Set(['binding', '_linkedBinding', 'dlopen', 'getBuiltinModule', 'mainModule']);
const CODE_EVALUATORS = new Set(['eval', 'Function']);
const GLOBAL_OWNERS = new Set(['process', 'globalThis', 'global']);

export function importSpecifiers(source, label) {
  if (/\.json$/i.test(label)) return [];
  const refuse = what => fail('p5_subject_resolver_unsupported', `P5 cannot statically resolve ${what} in "${label}".`);
  const file = ts.createSourceFile(label, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (file.parseDiagnostics.length) refuse('a module that does not parse');
  const specifiers = new Set();
  const nameOf = node => ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : null;
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (!ts.isStringLiteral(node.moduleSpecifier)) refuse('a computed module specifier');
      const specifier = node.moduleSpecifier.text;
      if (CODE_LOADING_BUILTINS.has(specifier)) refuse(`an import of the code-loading builtin "${specifier}"`);
      if (LOADER_MODULES.has(specifier)) {
        const clause = ts.isImportDeclaration(node) ? node.importClause : null;
        const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : null;
        if (!clause || clause.name || !named || named.some(item => !SAFE_LOADER_BINDINGS.has((item.propertyName ?? item.name).text)))
          refuse('a module-loader import or re-export');
      }
      specifiers.add(specifier);
    }
    if (ts.isImportEqualsDeclaration(node)) refuse('an import-equals declaration');
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) refuse('a dynamic import');
    if (ts.isMetaProperty(node) && ts.isPropertyAccessExpression(node.parent) && node.parent.name.text === 'resolve') refuse('import.meta.resolve');
    if (ts.isIdentifier(node) && LOADER_NAMES.has(node.text)) refuse(`the module loader "${node.text}"`);
    // Code evaluation reaches modules outside the closure as well (review R4).
    if (ts.isIdentifier(node) && CODE_EVALUATORS.has(node.text)) refuse(`the code evaluator "${node.text}"`);
    if ((ts.isElementAccessExpression(node) || ts.isPropertyAccessExpression(node)) && ts.isIdentifier(node.expression)
      && GLOBAL_OWNERS.has(node.expression.text)) {
      const key = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : null;
      if (key === null) refuse(`a computed member of "${node.expression.text}"`);
      // `globalThis.eval`, `globalThis['process'].binding`, `process['dlopen']`: the same references by another spelling.
      if (GLOBAL_OWNERS.has(key) || CODE_EVALUATORS.has(key)) refuse(`an indirect "${key}" reference`);
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const property = ts.isPropertyAccessExpression(node) ? nameOf(node.name) : nameOf(node.argumentExpression);
      const owner = ts.isIdentifier(node.expression) ? node.expression.text : null;
      if (property && (LOADER_NAMES.has(property) || owner === 'process' && PROCESS_LOADERS.has(property)))
        refuse(`the module loader "${property}"`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...specifiers];
}

const packageNameOf = specifier => specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];

/**
 * Third-party packages of the installed control release. Candidate source never carries dependencies (package manifests and
 * lockfiles are Host build inputs and node_modules is outside the source policy), so a subject's bare imports are served
 * only from the running release, whose bytes the Lifecycle Host covers by the attested package digest.
 */
function installedDependencyClosure(names) {
  const pending = [...names], closure = new Set();
  while (pending.length) {
    const name = pending.pop();
    if (closure.has(name)) continue;
    const manifestPath = resolve(ENGINE_ROOT, 'node_modules', ...name.split('/'), 'package.json');
    if (!existsSync(manifestPath)) fail('p5_subject_external_dependency_unsupported', `P5 subject dependency "${name}" is not part of the installed release.`);
    closure.add(name);
    let manifest;
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
    catch { fail('p5_subject_external_dependency_unsupported', `The installed manifest of "${name}" is unreadable.`); }
    // Review F17: what Node can load from this package includes its installed optional and peer dependencies.
    pending.push(...Object.keys(manifest.dependencies || {}), ...Object.keys({ ...manifest.optionalDependencies, ...manifest.peerDependencies })
      .filter(item => existsSync(resolve(ENGINE_ROOT, 'node_modules', ...item.split('/'), 'package.json'))));
  }
  return [...closure].sort(compareText);
}

function listPlainFiles(root) {
  const out = [];
  const visit = directory => {
    for (const name of readdirSync(directory).sort(compareText)) {
      const path = join(directory, name), info = lstatSync(path);
      if (info.isSymbolicLink()) fail('p5_subject_dependency_unsafe', `An installed dependency contains a reparse point: ${relative(ENGINE_ROOT, path)}`);
      if (info.isDirectory()) visit(path); else if (info.isFile()) out.push(path);
    }
  };
  visit(root);
  return out;
}

/**
 * Materialize the installed packages a protected subject imports beside the per-check execution trees
 * (<verify>/execution/node_modules), where Node resolves them and outside every Host-scanned candidate tree. Bytes are
 * copied from installed control only; an existing file must already hold identical bytes (recovery), never different ones.
 */
/** The exact installed dependency files (portable path under node_modules/ and installed bytes) for the named packages. */
function installedDependencyFiles(names) {
  const files = [];
  for (const name of installedDependencyClosure(names)) {
    const source = resolve(ENGINE_ROOT, 'node_modules', ...name.split('/'));
    for (const from of listPlainFiles(source))
      files.push({ path: ['node_modules', ...name.split('/'), ...relative(source, from).split(sep)].join('/'), from });
  }
  return files.sort((left, right) => compareText(left.path, right.path));
}

function materializeInstalledDependencies(executionParent, names) {
  if (!names.length) return [];
  ensureDirectory(join(executionParent, 'node_modules'));
  for (const file of installedDependencyFiles(names)) {
    const parts = file.path.split('/');
    let current = executionParent;
    for (const part of parts.slice(0, -1)) current = ensureDirectory(join(current, part));
    writeOrVerifyP5File({ path: join(executionParent, ...parts), bytes: readFileSync(file.from), mode: 0o644, allowExisting: true,
      conflictCode: 'p5_subject_dependency_conflict', failedCode: 'p5_subject_dependency_failed', label: `Installed dependency ${parts[1]}` });
  }
  return installedDependencyFiles(names).map(file => file.path);
}

/**
 * After the checks ran: the materialized dependency set still equals the installed bytes, file for file, with nothing added.
 * Candidate code under verification runs as the same user and could otherwise rewrite a package a later check imports.
 */
function verifyInstalledDependenciesCurrent(executionParent, names) {
  const target = join(executionParent, 'node_modules');
  if (!names.length) return existsSync(target) ? 'An unexpected dependency directory appeared beside the execution trees.' : null;
  const expected = installedDependencyFiles(names);
  const actual = listPlainFiles(target).map(path => relative(executionParent, path).split(sep).join('/')).sort(compareText);
  if (canonicalHash(actual) !== canonicalHash(expected.map(file => file.path))) return 'The materialized installed dependency set changed during verification.';
  for (const file of expected)
    if (sha256(readFileSync(join(executionParent, ...file.path.split('/')))) !== sha256(readFileSync(file.from)))
      return `Installed dependency bytes changed during verification: ${file.path}.`;
  return null;
}

/**
 * P5-CLOSURE F2: the installed release's own artifact list (runtime `build.json`; desktop `p5/p5-support.json`), inside the
 * Host-attested package, names every shipped dependency file and its digest. Served dependency bytes must equal it.
 */
function installedReleaseArtifacts(release) {
  const name = ENGINE_PACKAGED ? 'p5-support.json' : 'build.json';
  const path = resolve(ENGINE_ROOT, name);
  let bytes, value;
  try { bytes = readFileSync(path); value = JSON.parse(bytes.toString('utf8')); }
  catch { fail('p5_dependency_release_unattested', `The installed release artifact list ${name} is unavailable.`); }
  const rows = ENGINE_PACKAGED ? value.files : value.artifacts;
  if (!Array.isArray(rows) || value.buildId !== release.buildId || value.sourceCommit !== release.sourceCommit
    || value.inputsDigest !== release.inputsDigest)
    fail('p5_dependency_release_unattested', `The installed release artifact list ${name} does not describe the Host-attested running release.`);
  return { name, sha256: sha256(bytes), byPath: new Map(rows.map(row => [row.path, row.sha256])) };
}

function dependencyClosureRecord({ names, candidate, gateAttemptId, release }) {
  const files = installedDependencyFiles(names).map(file => {
    const bytes = readFileSync(file.from);
    return { path: file.path, sha256: sha256(bytes), byteSize: bytes.length };
  });
  const listed = installedReleaseArtifacts(release);
  for (const file of files)
    if (listed.byPath.get(file.path) !== file.sha256)
      fail('p5_dependency_release_mismatch', `Installed dependency "${file.path}" differs from the attested release artifact list.`);
  const packages = installedDependencyClosure(names);
  const record = { schemaVersion: 1, kind: 'ProtectedSelfRepairVerificationDependencyClosure', candidateId: candidate.candidateId,
    gateAttemptId, installedRelease: { buildId: release.buildId, bootstrap: release.bootstrap, packageSha256: release.packageSha256,
      inputsDigest: release.inputsDigest, artifactList: listed.name, artifactListSha256: listed.sha256 },
    resolutionRoot: 'candidate-execution-tree/node_modules', packages, files, closureDigest: canonicalHash({ packages, files }) };
  validateP5Contract('dependencyClosure', record);
  return record;
}

function resolveRelativeImport(fromPath, specifier, candidateByPath, overlayBytes, installedPackages = null) {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    const normalized = specifier.replace(/^node:/, '');
    if (specifier.startsWith('node:') || COMPATIBLE_BUILTINS.has(normalized)) return null;
    if (installedPackages && !specifier.startsWith('/') && existsSync(resolve(ENGINE_ROOT, 'node_modules', ...packageNameOf(specifier).split('/'), 'package.json'))) {
      installedPackages.add(packageNameOf(specifier));
      return null;
    }
    fail('p5_subject_external_dependency_unsupported', `P5 subject closure contains an uncaptured external dependency "${specifier}".`);
  }
  const base = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
  if (base === '..' || base.startsWith('../') || base.startsWith('/')) fail('p5_subject_path_escape', `Subject import "${specifier}" escapes the captured source root.`);
  const candidates = [base, `${base}.mjs`, `${base}.js`, `${base}.cjs`, `${base}.json`,
    `${base}/index.mjs`, `${base}/index.js`, `${base}/index.cjs`];
  const found = candidates.filter(path => overlayBytes.has(path) || candidateByPath.has(path));
  if (found.length !== 1) fail('p5_subject_import_unresolved', `P5 subject import "${specifier}" from "${fromPath}" does not resolve to exactly one captured source file.`);
  return found[0];
}

function resolveProtectedSubject({ store, candidate, sourceManifest, policyRef, inputsRef, inputs, check, overlayManifest }) {
  if (!['protected-overlay', 'candidate-entrypoint'].includes(check.subjectBinding) || check.subjectEntryPoints.length !== 1
    || (check.subjectBinding === 'candidate-entrypoint' && (check.overlayPaths.length || overlayManifest)))
    fail('p5_subject_binding_unsupported', `P5 check "${check.checkId}" requires one supported candidate entrypoint and a matching protected subject mode.`);
  const candidateEntries = sortedSourceEntries(sourceManifest);
  const candidateByPath = new Map(candidateEntries.map(entry => [entry.path, entry]));
  const entrypoint = check.subjectEntryPoints[0];
  if (!candidateByPath.has(entrypoint)) fail('p5_subject_entrypoint_missing', `Candidate subject entrypoint "${entrypoint}" is absent from the sealed candidate.`);
  const overlayBytes = new Map();
  for (const item of overlayManifest?.entries ?? []) {
    verifyRef(store, item.protectedArtifact, `protected overlay ${item.path}`);
    overlayBytes.set(item.path, store.readBytes(item.protectedArtifact.artifactId).bytes.toString('utf8'));
  }

  const visited = new Set();
  const installedPackages = new Set();
  const candidateClosure = new Set();
  const reachedSubjects = new Set();
  const visit = (path, textOverride = null) => {
    if (visited.has(path)) return;
    visited.add(path);
    const candidateEntry = candidateByPath.get(path);
    if (candidateEntry) candidateClosure.add(path);
    if (path === entrypoint) reachedSubjects.add(path);
    const source = textOverride ?? (overlayBytes.has(path) ? overlayBytes.get(path)
      : candidateEntry ? readCandidateModule(store, candidateEntry) : null);
    if (source === null) fail('p5_subject_import_unresolved', `Protected test input reaches uncaptured path "${path}".`);
    for (const specifier of importSpecifiers(source, path)) {
      const next = resolveRelativeImport(path, specifier, candidateByPath, overlayBytes, installedPackages);
      if (next !== null) visit(next);
    }
  };
  for (const path of check.overlayPaths) {
    if (!overlayBytes.has(path)) fail('p5_subject_overlay_missing', `Protected overlay "${path}" has no captured baseline bytes.`);
    visit(path, overlayBytes.get(path));
  }
  if (!reachedSubjects.has(entrypoint)) fail('p5_subject_not_exercised', `Protected check "${check.checkId}" does not import its exact declared candidate subject entrypoint.`);
  const resolvedFiles = [...candidateClosure].map(path => {
    const entry = candidateByPath.get(path);
    return { path, sha256: entry.sha256, byteSize: entry.byteSize, executable: entry.executable };
  }).sort((left, right) => compareText(left.path, right.path));
  const assertionBindings = [...check.expectedAssertions].sort(compareText).map(assertion => ({ assertion, sourcePath: entrypoint }));
  const inputDigest = p5CheckInputDigest({ candidate, check, verificationInputs: inputs });
  const resolution = { schemaVersion: 1, kind: 'ProtectedSelfRepairSubjectResolution', candidateId: candidate.candidateId,
    candidateSourceDigest: candidate.candidateSourceDigest, baselineId: candidate.baselineId, checkId: check.checkId,
    verificationPolicy: policyRef, verificationInputs: inputsRef, inputDigest,
    driverIdentity: check.executable, driverSha256: check.executableSha256, entryPoints: [...check.subjectEntryPoints],
    resolvedFiles, sourceClosureDigest: canonicalHash(resolvedFiles), assertionBindings,
    ...(installedPackages.size ? { installedPackages: [...installedPackages].sort(compareText) } : {}) };
  validateP5Contract('subjectResolution', resolution);
  return { resolution, ref: asRef(store.putJson(resolution)), inputDigest };
}

function createP5Parser() {
  const state = { terminal: false, finalText: null, error: null, protocolError: false, diagnostics: [] };
  let result = null;
  return { state, get result() { return result; }, feed(value) {
    if (state.terminal) { state.error ||= 'The trusted P5 verifier emitted more than one control record.'; return {}; }
    if (!value || value.kind !== 'ProtectedSelfRepairVerifierResult' || value.schemaVersion !== 1) {
      state.error = 'The trusted P5 verifier emitted an unsupported control record.';
      return {};
    }
    result = value;
    state.terminal = true;
    state.finalText = JSON.stringify(value);
    return {};
  } };
}

function custodyTerminalIsComplete(engine, runId, attempt, record, outcome) {
  const status = record.child?.terminalStatus;
  const binding = engine.custodyBindingOf(attempt.id);
  const row = engine.store.get('SELECT process_id,process_start_identity FROM attempts WHERE id = ?', attempt.id);
  const offsets = ['stdoutAcked', 'stdoutDurable', 'stderrAcked', 'stderrDurable'].every(key => Number.isSafeInteger(status?.[key]) && status[key] >= 0);
  return Boolean(binding && status && record.child?.custody === true
    && status.custodyId === binding.custody_id && status.attemptId === attempt.id && status.runId === runId
    && status.terminal === true && status.state === 'exited' && status.processTreeEnded === true
    && status.spoolComplete === true && status.tailGapPossible === false && status.exitCode === outcome.code
    && Number.isSafeInteger(status.processId) && status.processId === row?.process_id
    && row?.process_start_identity && `custody:${status.processCreationTime}` === row.process_start_identity
    && status.invocationDigest === record.child.invocationDigest && status.executableSha256 === record.child.executableSha256
    && offsets && status.stdoutAcked === status.stdoutDurable && status.stderrAcked === status.stderrDurable
    && outcome.streams?.stdout?.integrity === 'complete' && outcome.streams?.stderr?.integrity === 'complete');
}

function canonicalWorkspaceRoots(candidate, gateAttemptId) {
  const slot = assertRealDirectory(candidate.workspace.canonicalRoot, 'candidate slot');
  const verify = ensureDirectory(join(slot, '.p5')) && ensureDirectory(join(slot, '.p5', 'verify'));
  const candidateSource = resolve(verify, 'source');
  const scratch = resolve(verify, 'scratch', gateAttemptId);
  const executionRoot = resolve(verify, 'execution');
  const relativeToSlot = [candidateSource, scratch, executionRoot].map(path => relative(slot, path));
  if (relativeToSlot.some(path => !path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)))
    fail('p5_verification_root_escape', 'A P5 verification root escaped the reserved workspace slot.');
  return { slot, verify, candidateSource, scratch, executionRoot };
}

function checkReceiptResult(result, policy, candidate, gateAttemptId, verificationInputs, verifierPlan = null) {
  if (verifierPlan && (canonicalHash(result?.dependencyClosureDigest ?? null) !== canonicalHash(verifierPlan.dependencyClosure?.closureDigest ?? null)
    || policy.causalReproduction && result?.causalReproduction?.checkId !== policy.causalReproduction.checkId))
    fail('p5_verifier_result_mismatch', 'Trusted verifier result omits the planned baseline reproduction or dependency closure.');
  if (!result || result.kind !== 'ProtectedSelfRepairVerifierResult' || result.schemaVersion !== 1
    || result.candidateId !== candidate.candidateId || result.candidateSourceDigest !== candidate.candidateSourceDigest
    || result.baselineId !== candidate.baselineId || result.gateAttemptId !== gateAttemptId
    || !Array.isArray(result.checks)) fail('p5_verifier_result_mismatch', 'Trusted verifier result does not identify the exact Gate Attempt and sealed candidate.');
  const ids = result.checks.map(check => check.checkId);
  const expected = policy.checks.map(check => check.checkId);
  if (new Set(ids).size !== ids.length || canonicalHash([...ids].sort(compareText)) !== canonicalHash([...expected].sort(compareText)))
    fail('p5_verifier_check_set_mismatch', 'Trusted verifier did not return exactly one observation for every captured check.');
  const byId = new Map(result.checks.map(check => [check.checkId, check]));
  for (const definition of policy.checks) {
    const observation = byId.get(definition.checkId);
    if (!observation || observation.stageId !== definition.stageId || observation.required !== definition.required
      || observation.commandDigest !== definition.commandDigest
      || observation.inputDigest !== p5CheckInputDigest({ candidate, check: definition, verificationInputs })
      || canonicalHash([...observation.expectedAssertions].sort(compareText)) !== canonicalHash([...definition.expectedAssertions].sort(compareText)))
      fail('p5_verifier_observation_mismatch', `Trusted observation for check "${definition.checkId}" differs from the captured policy.`);
    const stdout = Buffer.from(observation.stdoutBase64 || '', 'base64');
    const stderr = Buffer.from(observation.stderrBase64 || '', 'base64');
    if (stdout.toString('base64') !== observation.stdoutBase64 || stderr.toString('base64') !== observation.stderrBase64
      || sha256(stdout) !== observation.stdoutSha256 || sha256(stderr) !== observation.stderrSha256)
      fail('p5_verifier_output_mismatch', `Trusted observation output for check "${definition.checkId}" failed its digest.`);
    if (definition.required && (observation.status !== 'passed' || !definition.expectedExitCodes.includes(observation.exitCode)
      || observation.captureStatus !== 'complete'
      || canonicalHash([...observation.completedAssertions].sort(compareText)) !== canonicalHash([...definition.expectedAssertions].sort(compareText))))
      return { status: 'failed', byId };
    if (definition.required && (observation.timedOut || observation.signal || !observation.reporter?.allCasesPassed))
      return { status: 'failed', byId };
  }
  return { status: result.status === 'passed' ? 'passed' : result.status === 'failed' ? 'failed' : 'incomplete', byId };
}

export function loadProtectedSelfRepairGateRecoveryBindings({ store, policy, testInputManifest }) {
  validateP5Contract('testInputManifest', testInputManifest);
  if (!Array.isArray(policy?.checks) || !policy.checks.length)
    fail('p5_gate_recovery_plan_invalid', 'P5 Gate recovery has no captured check policy.');
  const rows = new Map();
  for (const row of testInputManifest.checks) {
    if (rows.has(row.checkId)) fail('p5_gate_recovery_plan_invalid', `P5 Gate recovery contains duplicate check "${row.checkId}".`);
    rows.set(row.checkId, row);
  }
  if (rows.size !== policy.checks.length || policy.checks.some(check => !rows.has(check.checkId)))
    fail('p5_gate_recovery_plan_invalid', 'P5 Gate recovery inputs do not match the captured check set.');

  const bindings = new Map();
  for (const check of policy.checks) {
    const inputRow = rows.get(check.checkId);
    if (!['protected-overlay', 'candidate-entrypoint'].includes(check.subjectBinding))
      fail('p5_gate_recovery_subject_unsupported', `P5 Gate recovery cannot restore check "${check.checkId}" subject mode.`);
    const subjectResolution = readRecord(store, inputRow.subjectResolution, 'subjectResolution');
    if (subjectResolution.candidateId !== testInputManifest.candidateId
      || subjectResolution.candidateSourceDigest !== testInputManifest.candidateSourceDigest
      || subjectResolution.baselineId !== testInputManifest.baselineId || subjectResolution.checkId !== check.checkId
      || canonicalHash(subjectResolution.verificationPolicy) !== canonicalHash(testInputManifest.verificationPolicy)
      || canonicalHash(subjectResolution.verificationInputs) !== canonicalHash(testInputManifest.verificationInputs)
      || subjectResolution.inputDigest !== inputRow.inputDigest)
      fail('p5_gate_recovery_subject_mismatch', `P5 Gate recovery subject for check "${check.checkId}" differs from the captured candidate or input set.`);
    const requiresOverlay = check.subjectBinding === 'protected-overlay';
    if (requiresOverlay !== Boolean(inputRow.overlayManifest) || (!requiresOverlay && check.overlayPaths.length))
      fail('p5_gate_recovery_overlay_mismatch', `P5 Gate recovery overlay reference for check "${check.checkId}" disagrees with its subject mode.`);
    const overlayManifest = requiresOverlay ? readRecord(store, inputRow.overlayManifest, 'overlayManifest') : null;
    if (overlayManifest && (overlayManifest.candidateId !== testInputManifest.candidateId
      || overlayManifest.candidateSourceDigest !== testInputManifest.candidateSourceDigest
      || overlayManifest.baselineId !== testInputManifest.baselineId || overlayManifest.checkId !== check.checkId))
      fail('p5_gate_recovery_overlay_mismatch', `P5 Gate recovery overlay for check "${check.checkId}" is bound to another subject.`);
    bindings.set(check.checkId, { inputRow, subjectResolution, overlayManifest,
      overlayManifestRef: inputRow.overlayManifest ?? null });
  }
  return bindings;
}

export function installProtectedSelfRepairGate(Engine) {
  const P = Engine.prototype;

  P.protectedSelfRepairGateAuthorization = function protectedSelfRepairGateAuthorization(state, node, attempt) {
    if (this.protectedSelfRepairAdmissionEnabled !== true) fail('p5_admission_unavailable', 'Protected Self-Repair remains disabled until every required lifecycle checkpoint is verified.');
    const enrollment = this.protectedSelfRepairEnrollment;
    const enrollmentFile = this.protectedSelfRepairEnrollmentFile;
    if (!enrollment || !enrollmentFile || !this.protectedSelfRepairEnrollmentArtifact || !this.lifecycleClient
      || !this.custodyHost || this.custodyUnavailable || !Number.isSafeInteger(this.custodyEpoch))
      fail('p5_enrollment_unavailable', this.protectedSelfRepairUnavailableReason || 'The installed P5 enrollment and Process Custody Host are unavailable.');
    if (node.type !== 'gate' || node.config?.mode !== 'self-repair-verify'
      || node.id !== enrollmentProfileNodeId(this, state.id) || attempt.run_id !== state.id || attempt.node_instance_id !== node.id
      || state.workflow.capabilities?.includes('protected-self-repair-v1') !== true)
      fail('p5_gate_authority_invalid', 'P5 Verification Gate is not the exact top-level enrolled Gate Attempt.');
    const link = this.logicalRepairLinkForRun(state.id);
    const authorization = link && this.parentRepairAuthorization(link);
    if (!link || link.state !== 'open' || link.repair_run_id !== state.id
      || !this.logicalRepairLinkIntact(link, this.store.get('SELECT * FROM runs WHERE id = ?', state.id))
      || authorization?.p5Enrollment?.artifactId !== this.protectedSelfRepairEnrollmentArtifact.artifactId
      || authorization?.selfRepairProfile?.artifactId !== enrollment.profile.artifactId
      || authorization?.verificationInputs?.artifactId == null
      || canonicalHash(node.config.verificationPolicy) !== canonicalHash(enrollment.verificationPolicy))
      fail('p5_gate_link_invalid', 'P5 Verification Gate is not bound to the exact enrolled P2 Repair link and policy.');
    const profile = readRecord(this.store, enrollment.profile, 'profile');
    const policy = readRecord(this.store, enrollment.verificationPolicy, 'verificationPolicy');
    assertP5VerificationPolicy(policy);
    if (profile.verificationNodeId !== node.id || profile.enrollmentId !== enrollment.enrollmentId
      || canonicalHash(profile.verificationPolicy) !== canonicalHash(enrollment.verificationPolicy)
      || canonicalHash(profile.requiredCheckIds) !== canonicalHash(policy.requiredCheckIds)
      || this.store.get('SELECT published_version_id FROM runs WHERE id = ?', state.id)?.published_version_id !== enrollment.repairPublication.publishedVersionId)
      fail('p5_gate_profile_mismatch', 'P5 Gate, enrolled profile, policy and published Repair do not agree.');
    const candidateEvents = this.store.readEvents(state.id).filter(event => event.type === 'self_repair.candidate_captured');
    if (candidateEvents.length !== 1 || !candidateEvents[0].payload?.record)
      fail('p5_candidate_missing', 'P5 verification requires exactly one durably captured candidate for this Repair.');
    const projection = this.protectedSelfRepairRunProjection?.(state.id);
    if (!projection || projection.issues.length || projection.stage !== 'captured')
      fail('p5_projection_unavailable', 'P5 verification requires the current journal projection to identify one intact captured candidate.');
    const candidateRef = candidateEvents[0].payload.record;
    const candidate = readRecord(this.store, candidateRef, 'candidate');
    if (['sanitized-seed-v1', 'managed-clone-v1'].includes(enrollment.gitCandidatePolicy) && !candidate.gitCandidate)
      fail('p5_git_candidate_missing', 'The enrolled P5 policy requires the exact committed Git candidate binding.');
    const developer = this.store.get('SELECT * FROM attempts WHERE id = ? AND run_id = ?', candidate.developerAttemptId, state.id);
    if (!developer || developer.state !== 'succeeded' || candidate.repairRunId !== state.id || candidate.parentRunId !== link.parent_run_id
      || candidate.linkId !== link.id || candidate.incidentId !== link.incident_id
      || candidateEvents[0].attemptId !== null || developer.node_instance_id !== profile.developerNodeId)
      fail('p5_candidate_lineage_mismatch', 'Sealed candidate is not the exact successful Developer result for this enrolled Repair.');
    if (canonicalHash(candidate.verificationPolicy) !== canonicalHash(enrollment.verificationPolicy)
      || canonicalHash(candidate.verificationInputs) !== canonicalHash(authorization.verificationInputs)
      || canonicalHash(candidate.selfRepairProfile) !== canonicalHash(authorization.selfRepairProfile)
      || canonicalHash(candidate.enrollment) !== canonicalHash(authorization.p5Enrollment)
      || canonicalHash(candidate.sourceBinding) !== canonicalHash(authorization.p5SourceBinding))
      fail('p5_candidate_policy_mismatch', 'Sealed candidate policy and incident inputs differ from the exact P2 authorization.');
    const verificationInputs = readRecord(this.store, candidate.verificationInputs, 'verificationInputs');
    verifyP5VerificationInputsCurrent({ store: this.store, enrollment, profile,
      parentRunId: link.parent_run_id, inputs: verificationInputs });
    const priorStarts = this.store.readEvents(state.id).filter(event => event.type === 'self_repair.verification_started');
    if (priorStarts.length) fail('p5_gate_already_started', 'A durable P5 Gate start already exists; this Attempt cannot rematerialize or launch a second verifier.');
    if (!['scheduled', 'waiting'].includes(attempt.state) || attempt.invocation_artifact_id != null
      || this.store.get('SELECT custody_id FROM attempt_custody WHERE attempt_id = ?', attempt.id))
      fail('p5_gate_prestart_state_invalid', 'P5 preparation reuse is allowed only before the Attempt has an invocation artifact or Host Custody binding.');
    const sourceManifest = readRecord(this.store, candidate.sourceManifest, 'sourceManifest');
    if (sourceManifest.sourceDigest !== candidate.candidateSourceDigest)
      fail('p5_candidate_source_digest_mismatch', 'The sealed candidate source manifest does not match its candidate identity.');
    return { link, authorization, profile, policy, candidate, candidateRef, verificationInputs, preStartRecovery: true };
  };

  P.dispatchProtectedSelfRepairGate = function dispatchProtectedSelfRepairGate(state, scope, node, attempt) {
    if (scope.prefix || attempt.node_instance_id !== node.id || this.runState(state.id) !== 'running')
      return this.failAttempt(state, attempt, 'p5_gate_scope_invalid', 'P5 Verification Gate must run as its exact top-level Attempt.');
    let authorized;
    try { authorized = this.protectedSelfRepairGateAuthorization(state, node, attempt); }
    catch (error) { return this.failAttempt(state, attempt, error.code || 'p5_gate_ineligible', error.message); }
    const workspace = this.workspaceOf(state);
    if (!workspace || workspace.id !== authorized.candidate.workspace.workspaceId
      || !samePath(resolve(workspace.cwd), resolve(authorized.candidate.workspace.canonicalRoot)))
      return this.failAttempt(state, attempt, 'p5_workspace_mismatch', 'P5 Gate workspace differs from the enrolled single-use candidate slot.');
    const key = `cwd:${workspace.cwd_identity}`;
    const hold = this.custodyHoldOverlapping(workspace.cwd);
    if (this.locks.has(key) || hold || this.custodyLaunchOverlapping(workspace.cwd) || this.custodyDeliveryOverlapping(workspace.cwd)) {
      if (attempt.state === 'scheduled') this.store.transaction(() => this.store.appendEvents(state.id,
        this.attemptTransition(attempt, 'waiting', 'P5 Gate is waiting for the enrolled workspace and Host Custody holds to clear.')));
      return;
    }
    const record = { runId: state.id, loops: [], provider: P5_PROVIDER, keys: [key], child: null, stopRequested: false,
      timedOut: false, launched: false, p5ProtectedGate: true, custodyCwd: workspace.cwd };
    this.protectedSelfRepairGateRecords.add(record);
    record.exited = new Promise(done => { record.resolveExit = done; });
    this.locks.add(key);
    this.store.run('INSERT INTO resource_locks(resource_key,run_id,attempt_id,acquired_at) VALUES(?,?,?,?)', key, state.id, attempt.id, nowIso());
    this.processes.set(attempt.id, record);
    this.executeProtectedSelfRepairGate(state, node, attempt, workspace, record, authorized)
      .catch(error => {
        try { this.failAttempt(state, this.store.get('SELECT * FROM attempts WHERE id = ?', attempt.id), error.code || 'p5_verification_failed', error.message); }
        catch (journalError) { this.storageUnavailable(journalError); }
      }).finally(() => this.releaseAgent(state, attempt, record));
  };

  P.prepareProtectedSelfRepairGate = async function prepareProtectedSelfRepairGate(state, node, attempt, workspace, authorized) {
    const { store } = this;
    const { link, profile, policy, candidate, candidateRef, verificationInputs } = authorized;
    const installedEnrollment = await this.verifyProtectedSelfRepairEnrollmentFileCurrent();
    if (canonicalHash(installedEnrollment) !== canonicalHash(this.protectedSelfRepairEnrollment))
      fail('p5_enrollment_changed', 'Installed P5 enrollment changed before trusted verification.');
    const currentRunningSourceRelease = await this.lifecycleClient.runningSourceRelease({ pid: process.pid });
    const readers = this.protectedSelfRepairHostReaders();
    await verifyP5GitBaselineCurrent({ store, enrollment: this.protectedSelfRepairEnrollment, currentRunningSourceRelease, ...readers });
    await verifyP5ActiveSourceInventory(this, currentRunningSourceRelease);
    const packageLayout = verifyP5PackageLayout(currentRunningSourceRelease);
    const release = store.readJson(this.protectedSelfRepairEnrollment.runningSourceRelease.artifactId);
    if (policy.harnessClosureDigest !== this.protectedSelfRepairEnrollment.harnessClosureDigest
      || policy.harnessClosureDigest !== release.inputsDigest
      || currentRunningSourceRelease.inputsDigest !== policy.harnessClosureDigest)
      fail('p5_harness_closure_unsupported', 'This verifier profile must bind its harness closure to the Host-attested build-input digest, including the authority import and dependency closure.');
    const hostInventory = await this.lifecycleClient.runningSourceInventory({ pid: process.pid, paths: [...TRUSTED_SOURCE_PATHS] });
    if (!hostInventory || hostInventory.sourceDigest !== release.sourceDigest || hostInventory.generation !== this.lifecycleHost.generation)
      fail('p5_harness_source_unavailable', 'The Lifecycle Host did not attest the installed trusted verifier source closure.');
    const attestedByPath = new Map((hostInventory.entries || []).filter(item => item && typeof item.path === 'string' && item.sha256).map(item => [item.path, item]));
    for (const path of TRUSTED_SOURCE_PATHS) {
      const entry = attestedByPath.get(path);
      const localPath = resolve(ENGINE_ROOT, ...path.split('/'));
      if (!entry || !existsSync(localPath) || sha256(readFileSync(localPath)) !== entry.sha256)
        fail('p5_harness_source_mismatch', `Running trusted control source "${path}" differs from the Host-attested installed package.`);
    }
    if (!samePath(resolve(VERIFIER_PATH), resolve(ENGINE_ROOT, ...VERIFIER_RELATIVE.split('/'))))
      fail('p5_harness_path_mismatch', 'The P5 trusted verifier path is not the expected installed source module.');

    const nodeTool = this.protectedSelfRepairEnrollment.toolIdentities.filter(item => item.name === 'node');
    if (nodeTool.length !== 1 || !samePath(resolve(nodeTool[0].path), resolve(process.execPath))
      || sha256(readFileSync(process.execPath)) !== nodeTool[0].sha256)
      fail('p5_node_identity_mismatch', 'P5 enrollment does not pin the exact Node runtime used for its verifier and candidate checks.');
    const nativeTool = await readers.nativeToolIdentityReader({ path: process.execPath });
    if (!nativeTool || nativeTool.refused || nativeTool.linkCount !== 1 || !samePath(resolve(nativeTool.canonicalPath), resolve(process.execPath)))
      fail('p5_node_native_identity_unavailable', 'Rust Host did not establish the exact single-link Node executable identity.');
    if (nativeTool.generation !== this.lifecycleHost.generation || nativeTool.epoch !== this.custodyEpoch
      || nativeTool.hostPid !== this.custodyHostPid)
      fail('p5_node_native_identity_stale', 'Rust Host Node identity evidence is not from the attached Host generation, process and epoch.');
    if (nativeTool.byteSize !== readFileSync(process.execPath).length)
      fail('p5_node_native_identity_mismatch', 'Rust Host Node file identity size differs from the running executable bytes.');

    const sourceManifest = readRecord(store, candidate.sourceManifest, 'sourceManifest');
    const candidateCapture = readRecord(store, candidate.sourceCaptureEvidence, 'sourceCaptureEvidence');
    const roots = canonicalWorkspaceRoots(candidate, attempt.id);
    const actualCandidate = await inventoryP5SourceWithHost(candidate.workspace.sourceRoot, { nativeSourceReader: readers.nativeSourceReader,
      maxFiles: this.protectedSelfRepairEnrollment.budgets.maxSourceFiles,
      maxBytes: this.protectedSelfRepairEnrollment.budgets.maxSourceBytes, include: ['**'],
      exclude: candidate.gitCandidate ? ['.git/**'] : [], executableFor: executableForManifest(sourceManifest) });
    if (!sourceEntriesMatch(actualCandidate.entries, sourceManifest)
      || canonicalHash(actualCandidate.nativeEvidence.rootIdentity) !== canonicalHash(candidateCapture.rootIdentity)
      || actualCandidate.nativeEvidence.generation !== this.lifecycleHost.generation || actualCandidate.nativeEvidence.epoch !== this.custodyEpoch)
      fail('p5_candidate_source_drift', 'Live candidate source differs from the sealed candidate before verification.');
    if (candidate.gitCandidate) await verifyP5GitCandidateCurrent({ store, candidateRef,
      nativeSourceReader: readers.nativeSourceReader, nativeToolIdentityReader: readers.nativeToolIdentityReader,
      expectedGitCandidateRef: candidate.gitCandidate });
    materializeCandidateSource({ store, candidate, sourceManifest, root: roots.candidateSource,
      allowExisting: authorized.preStartRecovery === true });
    const freshCapture = await inventoryP5SourceWithHost(roots.candidateSource, { nativeSourceReader: readers.nativeSourceReader,
      maxFiles: this.protectedSelfRepairEnrollment.budgets.maxSourceFiles,
      maxBytes: this.protectedSelfRepairEnrollment.budgets.maxSourceBytes, include: ['**'], exclude: [], executableFor: executableForManifest(sourceManifest) });
    if (!sourceEntriesMatch(freshCapture.entries, sourceManifest))
      fail('p5_candidate_materialization_mismatch', 'Fresh candidate reconstruction differs from the sealed immutable Store source.');
    ensureDirectory(dirname(roots.scratch));
    ensureDirectory(roots.scratch);
    ensureDirectory(roots.executionRoot);

    const policyRef = candidate.verificationPolicy;
    const inputsRef = candidate.verificationInputs;
    const checkPlans = [], inputRows = [], commandRows = [], resolutions = new Map(), overlays = new Map(), dependencyFiles = new Set();
    const aggregateInputBytes = { value: 0 };
    for (const check of policy.checks) {
      if (!['protected-overlay', 'candidate-entrypoint'].includes(check.subjectBinding))
        fail('p5_check_subject_unsupported', `P5 check "${check.checkId}" uses a subject-binding mode unsupported by the trusted Gate.`);
      for (const inputRef of check.inputRefs) verifyRef(store, inputRef, `check input ${check.checkId}`);
      let materialized = null;
      if (check.subjectBinding === 'protected-overlay') {
        materialized = await materializeP5VerificationOverlay({ store, candidateRef, check,
          budgets: this.protectedSelfRepairEnrollment.budgets, nativeSourceReader: readers.nativeSourceReader,
          allowPartialReuse: authorized.preStartRecovery === true });
        for (const item of materialized.overlayManifest.entries) {
          if (!item.candidateBefore || canonicalHash(item.candidateBefore) === canonicalHash(item.protectedReplacement)) continue;
          const independent = policy.checks.some(other => other.checkId !== check.checkId
            && other.required && other.subjectBinding === 'candidate-entrypoint' && other.subjectEntryPoints.includes(item.path));
          if (!independent)
            fail('p5_overlay_changed_subject_unverified', `P5 check "${check.checkId}" overlays candidate-edited test "${item.path}" without an independent non-overlay candidate-entrypoint check.`);
        }
      } else {
        if (check.overlayPaths.length || check.expectedAssertions.length !== 1
          || check.expectedAssertions[0] !== 'candidate-entrypoint-syntax')
          fail('p5_candidate_entrypoint_policy_unsupported', `P5 candidate-entrypoint check "${check.checkId}" does not match the installed syntax-check profile.`);
      }
      const subject = resolveProtectedSubject({ store, candidate, sourceManifest, policyRef, inputsRef, inputs: verificationInputs,
        check, overlayManifest: materialized?.overlayManifest ?? null });
      for (const path of materializeInstalledDependencies(roots.executionRoot, subject.resolution.installedPackages ?? [])) dependencyFiles.add(path);
      const checkInputs = materializeP5CheckInputs({ store, candidate, check, verificationInputs,
        inputDigest: subject.inputDigest, scratchRoot: roots.scratch, aggregateBytes: aggregateInputBytes,
        allowExisting: authorized.preStartRecovery === true });
      const executionRoot = resolve(roots.executionRoot, check.checkId);
      if (!materialized) {
        try { mkdirSync(executionRoot); }
        catch (error) {
          let recoveredEmptyDirectory = false;
          if (error.code === 'EEXIST' && authorized.preStartRecovery === true) {
            assertRealDirectory(executionRoot, 'candidate-entrypoint execution');
            let entries;
            try { entries = readdirSync(executionRoot); }
            catch { fail('p5_execution_tree_conflict', `P5 candidate-entrypoint execution directory for "${check.checkId}" could not be inspected.`); }
            if (entries.length === 0) recoveredEmptyDirectory = true;
            else fail('p5_execution_tree_conflict', `P5 candidate-entrypoint execution directory for "${check.checkId}" contains unexpected entries.`);
          }
          if (!recoveredEmptyDirectory) {
            if (error.code === 'EEXIST') fail('p5_execution_tree_conflict', `P5 candidate-entrypoint execution directory for "${check.checkId}" was already occupied.`);
            fail('p5_execution_tree_create_failed', `P5 candidate-entrypoint execution directory could not be created (${error.code || 'error'}).`);
          }
        }
        assertRealDirectory(executionRoot, 'candidate-entrypoint execution');
      }
      const executionTreeDigest = p5ExecutionTreeDigest({ candidate, checkId: check.checkId, subjectResolution: subject.ref,
        inputDigest: subject.inputDigest, overlayManifest: materialized?.overlayManifestRef ?? null });
      const runtimeEnvironment = { ...check.environment,
        [P5_VERIFICATION_INPUT_MANIFEST_ENV]: checkInputs.absoluteManifestPath };
      if (check.subjectBinding === 'candidate-entrypoint')
        runtimeEnvironment[P5_VERIFICATION_CANDIDATE_ENTRYPOINT_ENV] = safeChildPath(roots.candidateSource, check.subjectEntryPoints[0]);
      const checkPlan = { ...check, executionRoot, runtimeEnvironment,
        inputDigest: subject.inputDigest, inputManifestArtifact: checkInputs.manifestRef,
        materializedInputManifest: checkInputs.manifest,
        inputManifestPath: checkInputs.absoluteManifestPath, inputManifestSha256: checkInputs.manifestDigest };
      checkPlans.push(checkPlan);
      resolutions.set(check.checkId, subject);
      overlays.set(check.checkId, materialized);
      commandRows.push({ checkId: check.checkId, commandDigest: check.commandDigest,
        executable: check.executable, executableSha256: check.executableSha256, argv: [...check.argv], cwdKind: check.cwd,
        cwd: executionRoot, environment: runtimeEnvironment, environmentDigest: canonicalHash(runtimeEnvironment),
        inputDigest: subject.inputDigest, inputManifest: checkInputs.manifestRef,
        inputManifestPath: checkInputs.absoluteManifestPath, inputManifestDigest: checkInputs.manifestDigest });
      inputRows.push({ checkId: check.checkId, inputDigest: subject.inputDigest, subjectResolution: subject.ref,
        executionTreeDigest, materializedInputs: checkInputs.manifestRef,
        materializedInputPath: checkInputs.relativeManifestPath, materializedInputDigest: checkInputs.manifestDigest,
        overlayManifest: materialized?.overlayManifestRef ?? null });
    }
    // P5-FINAL §5.2 (review F4): every sensitive changed path must be executed by at least one check its tier requires, so a
    // tier is verification of that code, not only a configuration flag.
    const changeManifest = store.readJson(verifyRef(store, candidate.changeManifest, 'change manifest').artifactId);
    for (const entry of changeManifest.mutationClassification?.entries ?? []) {
      if (entry.tier === 'ordinary') continue;
      const tierChecks = (policy.mutationTiers ?? []).find(tier => tier.tierId === entry.tier)?.requiredCheckIds ?? [];
      // Only a protected-overlay check (installed protected test over the candidate) counts; a syntax-only check does not.
      if (!tierChecks.some(id => policy.checks.find(item => item.checkId === id)?.subjectBinding === 'protected-overlay'
        && resolutions.get(id)?.resolution.resolvedFiles.some(file => file.path === entry.path)))
        fail('p5_mutation_tier_unverified', `Sensitive ${entry.tier} change "${entry.path}" is not executed by any check its verification tier requires.`);
    }
    // P5-CLOSURE §6: the installed baseline B as its own Host-scanned execution tree for the causal reproducer R(B).
    let causalPlan = null;
    if (policy.causalReproduction) {
      const causalCheck = policy.checks.find(item => item.checkId === policy.causalReproduction.checkId);
      const tree = await materializeP5BaselineReproducerTree({ store, candidateRef, check: causalCheck,
        budgets: this.protectedSelfRepairEnrollment.budgets, nativeSourceReader: readers.nativeSourceReader,
        allowPartialReuse: authorized.preStartRecovery === true });
      const baselineRecord = readRecord(store, candidate.baselineRef, 'baselineManifest');
      const baselineSourceManifest = readRecord(store, baselineRecord.sourceManifest, 'sourceManifest');
      const baselineSubject = resolveProtectedSubject({ store, candidate, sourceManifest: baselineSourceManifest, policyRef, inputsRef,
        inputs: verificationInputs, check: causalCheck, overlayManifest: overlays.get(causalCheck.checkId)?.overlayManifest ?? null });
      for (const path of materializeInstalledDependencies(roots.executionRoot, baselineSubject.resolution.installedPackages ?? [])) dependencyFiles.add(path);
      for (const entry of tree.inventory) dependencyFiles.add(`${P5_BASELINE_TREE_DIRECTORY}/${causalCheck.checkId}/${entry.path}`);
      causalPlan = { checkId: causalCheck.checkId, executionRoot: tree.root, baselineMustPass: [...policy.causalReproduction.baselineMustPass].sort(compareText),
        baselineMustFail: [...policy.causalReproduction.baselineMustFail].sort(compareText), baselineCommit: tree.baselineCommit,
        baselineSourceDigest: tree.baselineSourceDigest, capture: tree.capture, inventoryDigest: tree.inventoryDigest,
        fileCount: tree.inventory.length, subject: tree.subject, installedPackages: baselineSubject.resolution.installedPackages ?? [] };
    }
    const dependencyNames = [...new Set([...[...resolutions.values()].flatMap(item => item.resolution.installedPackages ?? []),
      ...(causalPlan?.installedPackages ?? [])])].sort(compareText);
    // The closure record is materialized in the verify scratch and named in the plan by path and digest: the plan itself must
    // fit one bounded Custody admission, while the verifier needs every planned dependency digest.
    let dependencyPlan = null;
    if (dependencyNames.length) {
      const closure = dependencyClosureRecord({ names: dependencyNames, candidate, gateAttemptId: attempt.id, release: currentRunningSourceRelease });
      const bytes = Buffer.from(canonicalize(closure), 'utf8');
      const manifestPath = join(roots.scratch, 'dependency-closure.json');
      writeOrVerifyP5File({ path: manifestPath, bytes, mode: 0o644, allowExisting: authorized.preStartRecovery === true,
        conflictCode: 'p5_dependency_closure_conflict', failedCode: 'p5_dependency_closure_failed', label: 'The dependency closure manifest' });
      dependencyPlan = { packages: closure.packages, closureDigest: closure.closureDigest, manifestPath, manifestSha256: sha256(bytes),
        record: asRef(store.putJson(closure)) };
    }
    const expectedInputPaths = checkPlans.flatMap(plan => [
      `${plan.checkId}/manifest.json`,
      ...plan.materializedInputManifest.inputs.map(item => `${plan.checkId}/${item.relativePath.slice(`inputs/${plan.checkId}/`.length)}`),
    ]);
    assertMaterializedTreeLayout(roots.scratch, [...expectedInputPaths.map(path => `inputs/${path}`), ...(dependencyPlan ? ['dependency-closure.json'] : [])],
      'p5_verification_input_conflict', 'P5 Gate scratch materialization');
    const expectedExecutionFiles = [...dependencyFiles], expectedExecutionDirectories = [];
    for (const check of policy.checks) {
      expectedExecutionDirectories.push(check.checkId);
      const overlay = overlays.get(check.checkId);
      if (overlay) for (const entry of overlay.overlayManifest.executionInventory)
        expectedExecutionFiles.push(`${check.checkId}/${entry.path}`);
    }
    assertMaterializedTreeLayout(roots.executionRoot, expectedExecutionFiles,
      'p5_execution_tree_conflict', 'P5 Gate execution trees', expectedExecutionDirectories);
    const commandManifestRoots = { candidateSource: roots.candidateSource, executionRoot: roots.executionRoot,
      verifyScratch: roots.scratch, installedControl: ENGINE_ROOT };
    const commandManifest = { schemaVersion: 1, kind: 'ProtectedSelfRepairCommandManifest', candidateId: candidate.candidateId,
      candidateSourceDigest: candidate.candidateSourceDigest, verificationPolicy: policyRef, gateAttemptId: attempt.id,
      roots: commandManifestRoots, checks: commandRows };
    validateP5Contract('commandManifest', commandManifest);
    const commandManifestRef = asRef(store.putJson(commandManifest));
    const testInputManifest = { schemaVersion: 1, kind: 'ProtectedSelfRepairTestInputManifest', candidateId: candidate.candidateId,
      candidateSourceDigest: candidate.candidateSourceDigest, baselineId: candidate.baselineId, verificationPolicy: policyRef,
      verificationInputs: inputsRef, harnessClosureDigest: policy.harnessClosureDigest, checks: inputRows };
    validateP5Contract('testInputManifest', testInputManifest);
    const testInputManifestRef = asRef(store.putJson(testInputManifest));
    const verifierPlan = { schemaVersion: 1, kind: 'ProtectedSelfRepairVerifierPlan', candidateId: candidate.candidateId,
      candidateSourceDigest: candidate.candidateSourceDigest, baselineId: candidate.baselineId, gateAttemptId: attempt.id,
      requiredCheckIds: [...policy.requiredCheckIds], aggregateTimeoutSeconds: policy.aggregateTimeoutSeconds,
      roots: { 'candidate-source': roots.candidateSource, 'candidate-execution-tree': roots.executionRoot,
        'verify-scratch': roots.scratch, 'installed-control': ENGINE_ROOT },
      policy, verificationInputs, commandManifest, checks: checkPlans,
      ...(causalPlan ? { causalReproduction: causalPlan } : {}), ...(dependencyPlan ? { dependencyClosure: dependencyPlan } : {}),
      packageLayoutDigest: canonicalHash(packageLayout) };
    const verifierPlanRef = asRef(store.putJson(verifierPlan));
    const stdin = canonicalize(verifierPlan);
    const stdinArtifact = asRef(store.putText(stdin));
    const environment = {};
    for (const key of ['PATH', 'SystemRoot', 'WINDIR']) if (typeof process.env[key] === 'string') environment[key] = process.env[key];
    for (const key of ['TEMP', 'TMP']) environment[key] = roots.scratch;
    const timeoutSeconds = this.protectedSelfRepairEnrollment.budgets.verificationTimeoutSeconds;
    if (timeoutSeconds < policy.aggregateTimeoutSeconds)
      fail('p5_verification_budget_mismatch', 'Captured P5 verifier aggregate deadline exceeds the enrolled verification timeout budget.');
    const invocation = { command: process.execPath, args: [VERIFIER_PATH], cwd: workspace.cwd, env: environment, stdin };
    const invocationManifest = { schemaVersion: 1, runId: state.id, attemptId: attempt.id, provider: P5_PROVIDER,
      requestedModel: 'protected-self-repair/1', requestedEffort: 'low', cliExecutable: invocation.command, cliVersion: process.version,
      arguments: invocation.args, cwd: invocation.cwd, cwdIdentity: workspace.cwd_identity, nativeConfiguration: 'restricted',
      configurationHash: canonicalHash(verifierPlan), environmentPolicy: 'captured-p5-policy',
      managedToolIsolation: { mechanism: 'protected-p5-verifier', runtimeInstanceId: this.runtimeInstanceId,
        checkedScopes: ['protected-overlay'], bridgeEntries: [] }, stdin: stdinArtifact, timeoutSeconds, nativeSessionBefore: null };
    assertValid('attempt-record.schema.json', 'invocation', invocationManifest, 'P5 Gate invocation manifest');
    const invocationRef = asRef(store.putJson(invocationManifest));
    const startedAt = nowIso();
    const startRecord = { schemaVersion: 1, kind: 'ProtectedSelfRepairVerificationStarted', runId: state.id,
      repairRunId: state.id, parentRunId: link.parent_run_id, linkId: link.id, incidentId: link.incident_id,
      gateNodeId: node.id, gateAttemptId: attempt.id, candidateId: candidate.candidateId,
      candidateSourceDigest: candidate.candidateSourceDigest, candidateManifest: candidateRef,
      ...(candidate.gitCandidate ? { gitCandidate: candidate.gitCandidate } : {}),
      verificationPolicy: policyRef, verificationInputs: inputsRef, verifierPlan: verifierPlanRef,
      commandManifest: commandManifestRef, testInputManifest: testInputManifestRef, invocation: invocationRef,
      candidateSourceRoot: candidate.workspace.sourceRoot, candidateSourceBefore: actualCandidate.nativeEvidence.contentDigest,
      freshSourceRoot: roots.candidateSource, executionRoot: roots.executionRoot, verifyScratch: roots.scratch,
      environmentDigest: canonicalHash(environment),
      harnessClosureDigest: policy.harnessClosureDigest, lifecycleGeneration: this.lifecycleHost.generation,
      engineEpoch: this.custodyEpoch, startedAt };
    validateP5Contract('verificationStarted', startRecord);
    const startArtifactRef = asRef(store.putJson(startRecord));
    return { candidate, candidateRef, policy, policyRef, verificationInputs, inputsRef, sourceManifest, roots,
      verifierPlan, verifierPlanRef, invocation, invocationManifest, invocationRef, commandManifest, commandManifestRef,
      testInputManifest, testInputManifestRef, startRecord, startArtifactRef, resolutions, overlays, startedAt,
      harnessSourceDigest: release.sourceDigest, harnessSourceEntries: attestedByPath,
      nodeToolIdentity: nativeTool, nodeToolSha256: nodeTool[0].sha256, packageLayout };
  };

  P.executeProtectedSelfRepairGate = async function executeProtectedSelfRepairGate(state, node, attempt, workspace, record, authorized) {
    let prepared;
    try { prepared = await this.prepareProtectedSelfRepairGate(state, node, attempt, workspace, authorized); }
    catch (error) {
      if (record.stopRequested || this.runState(state.id) === 'stopping') return this.store.transaction(() => this.store.appendEvents(state.id,
        this.attemptTransition(this.store.get('SELECT * FROM attempts WHERE id = ?', attempt.id), 'canceled', 'P5 Gate preparation was superseded by Root Stop.')));
      return this.failAttempt(state, this.store.get('SELECT * FROM attempts WHERE id = ?', attempt.id), error.code || 'p5_verification_incomplete', error.message);
    }
    if (record.stopRequested || this.runState(state.id) !== 'running')
      return this.store.transaction(() => this.store.appendEvents(state.id,
        this.attemptTransition(this.store.get('SELECT * FROM attempts WHERE id = ?', attempt.id), 'canceled', 'P5 Gate was stopped before Host admission.')));
    this.store.transaction(() => {
      const current = this.store.get('SELECT * FROM attempts WHERE id = ?', attempt.id);
      if (!current || !['scheduled', 'waiting'].includes(current.state) || this.store.get('SELECT custody_id FROM attempt_custody WHERE attempt_id = ?', attempt.id))
        fail('p5_gate_attempt_stale', 'P5 Gate Attempt changed before its one-time Host invocation was committed.');
      if (current.invocation_artifact_id != null
        || this.store.readEvents(state.id).some(event => event.type === 'self_repair.verification_started'))
        fail('p5_gate_already_started', 'A P5 Gate invocation or durable start already exists; a second verifier launch is refused.');
      this.store.run('UPDATE attempts SET invocation_artifact_id = ? WHERE id = ?', prepared.invocationRef.artifactId, attempt.id);
      const events = [this.commitInputs(state, current, {}),
        { type: 'attempt.invocation_committed', nodeInstanceId: current.node_instance_id, attemptId: current.id, payload: { manifest: prepared.invocationRef } },
        { type: 'self_repair.verification_started', payload: { record: prepared.startArtifactRef }, nodeInstanceId: null, attemptId: null }];
      this.store.appendEvents(state.id, events);
    });
    const current = this.store.get('SELECT * FROM attempts WHERE id = ?', attempt.id);
    record.parser = createP5Parser();
    const executionNode = { ...node, config: { ...node.config, provider: P5_PROVIDER, timeoutSeconds: prepared.verifierPlan.aggregateTimeoutSeconds } };
    const outcome = await this.runProcess(state, current, executionNode, prepared.invocation, record);
    await this.settleProtectedSelfRepairGate(state, executionNode, current, workspace, record, prepared, outcome);
  };

  P.settleProtectedSelfRepairGate = async function settleProtectedSelfRepairGate(state, node, attempt, workspace, record, prepared, outcome) {
    const current = this.store.get('SELECT * FROM attempts WHERE id = ?', attempt.id);
    if (!current || ['succeeded', 'failed', 'canceled', 'interrupted'].includes(current.state)) return;
    const terminal = record.child?.terminalStatus;
    const stdoutRef = outcome.streams?.stdout?.manifestRef || null;
    const stderrRef = outcome.streams?.stderr?.manifestRef || null;
    const complete = outcome.launched && !outcome.captureError && custodyTerminalIsComplete(this, state.id, current, record, outcome);
    const result = record.parser?.result ?? null;
    const terminalEvidence = terminal ? { schemaVersion: 1, kind: 'ProtectedSelfRepairGateTerminalEvidence',
      runId: state.id, attemptId: current.id, custodyId: terminal.custodyId ?? this.custodyBindingOf(current.id)?.custody_id,
      hostIdentity: String(this.custodyHostPid ?? 'unknown'), lifecycleGeneration: this.lifecycleHost?.generation ?? 'unknown',
      engineEpoch: this.custodyEpoch ?? 0, processId: terminal.processId ?? null, processCreationTime: String(terminal.processCreationTime ?? ''),
      invocationDigest: terminal.invocationDigest ?? record.child?.invocationDigest ?? '', executable: terminal.executable ?? process.execPath,
      executableSha256: terminal.executableSha256 ?? record.child?.executableSha256 ?? '', state: terminal.state ?? 'unknown',
      terminal: terminal.terminal === true, processTreeEnded: terminal.processTreeEnded === true,
      spoolComplete: terminal.spoolComplete === true, tailGapPossible: terminal.tailGapPossible === true,
      stdoutDurable: terminal.stdoutDurable ?? 0, stdoutAcked: terminal.stdoutAcked ?? 0,
      stderrDurable: terminal.stderrDurable ?? 0, stderrAcked: terminal.stderrAcked ?? 0,
      exitCode: terminal.exitCode ?? null, observedAt: nowIso() } : null;
    const terminalRef = terminalEvidence ? asRef(this.store.putJson(terminalEvidence)) : null;
    const streamEvidenceRef = stdoutRef && stderrRef ? asRef(this.store.putJson({ schemaVersion: 1, kind: 'ProtectedSelfRepairGateStreamEvidence',
      stdout: stdoutRef, stderr: stderrRef, complete, processTreeEnded: terminal?.processTreeEnded === true,
      spoolComplete: terminal?.spoolComplete === true, tailGapPossible: terminal?.tailGapPossible === true })) : null;
    let launchOrCaptureProblem = !complete ? (outcome.error || outcome.signal || record.captureError?.message
      || 'Host terminal, process-tree, spool, acknowledgement or stream evidence is incomplete.') : null;
    if (complete && (!samePath(resolve(terminal.executable), resolve(process.execPath))
      || terminal.executableSha256 !== prepared.nodeToolSha256))
      launchOrCaptureProblem ||= 'Host terminal executable identity differs from the enrollment-pinned Node runtime.';
    let classified = { status: 'incomplete', byId: new Map() };
    if (complete && result) {
      try { classified = checkReceiptResult(result, prepared.policy, prepared.candidate, current.id, prepared.verificationInputs, prepared.verifierPlan); }
      catch (error) { launchOrCaptureProblem = error.message; }
    } else if (!launchOrCaptureProblem) launchOrCaptureProblem = 'Trusted verifier did not produce one bounded structured result.';

    const readers = this.protectedSelfRepairHostReaders();
    let sourceAfter = null;
    try {
      sourceAfter = await inventoryP5SourceWithHost(prepared.candidate.workspace.sourceRoot, { nativeSourceReader: readers.nativeSourceReader,
        maxFiles: this.protectedSelfRepairEnrollment.budgets.maxSourceFiles,
        maxBytes: this.protectedSelfRepairEnrollment.budgets.maxSourceBytes, include: ['**'],
        exclude: prepared.candidate.gitCandidate ? ['.git/**'] : [], executableFor: executableForManifest(prepared.sourceManifest) });
      if (!sourceEntriesMatch(sourceAfter.entries, prepared.sourceManifest)) launchOrCaptureProblem ||= 'Candidate source drifted during trusted verification.';
      if (prepared.candidate.gitCandidate) await verifyP5GitCandidateCurrent({ store: this.store,
        candidateRef: prepared.candidateRef, nativeSourceReader: readers.nativeSourceReader,
        nativeToolIdentityReader: readers.nativeToolIdentityReader, expectedGitCandidateRef: prepared.candidate.gitCandidate });
      const freshAfter = await inventoryP5SourceWithHost(prepared.roots.candidateSource, { nativeSourceReader: readers.nativeSourceReader,
        maxFiles: this.protectedSelfRepairEnrollment.budgets.maxSourceFiles,
        maxBytes: this.protectedSelfRepairEnrollment.budgets.maxSourceBytes, include: ['**'], exclude: [], executableFor: executableForManifest(prepared.sourceManifest) });
      if (!sourceEntriesMatch(freshAfter.entries, prepared.sourceManifest)) launchOrCaptureProblem ||= 'Fresh candidate source materialization drifted during verification.';
      for (const check of prepared.policy.checks) {
        const overlay = prepared.overlays.get(check.checkId);
        if (check.subjectBinding === 'candidate-entrypoint') {
          const executionRoot = resolve(prepared.roots.executionRoot, check.checkId);
          assertRealDirectory(executionRoot, 'candidate-entrypoint execution');
          if (readdirSync(executionRoot).length !== 0)
            launchOrCaptureProblem ||= `Candidate-entrypoint check "${check.checkId}" wrote into its protected execution directory.`;
          continue;
        }
        const proof = verifyP5OverlayManifest({ store: this.store, overlayManifestRef: overlay.overlayManifestRef,
          candidateRef: prepared.candidateRef, check, execution: { lifecycleGeneration: prepared.startRecord.lifecycleGeneration,
            engineEpoch: prepared.startRecord.engineEpoch } });
        const tree = await inventoryP5SourceWithHost(proof.capture.rootPath, { nativeSourceReader: readers.nativeSourceReader,
          maxFiles: this.protectedSelfRepairEnrollment.budgets.maxSourceFiles,
          maxBytes: this.protectedSelfRepairEnrollment.budgets.maxSourceBytes, include: ['**'], exclude: [],
          executableFor: executableForManifest({ entries: proof.completeExecutionInventory }) });
        if (!sourceEntriesMatch(tree.entries, { entries: proof.completeExecutionInventory }))
          launchOrCaptureProblem ||= `Derived execution tree for check "${check.checkId}" changed during verification.`;
      }
      if (complete) verifyMaterializedP5InputsCurrent({ store: this.store,
        checks: prepared.verifierPlan.checks, scratchRoot: prepared.roots.scratch });
      const currentRelease = await this.lifecycleClient.runningSourceRelease({ pid: process.pid });
      await verifyP5GitBaselineCurrent({ store: this.store, enrollment: this.protectedSelfRepairEnrollment,
        currentRunningSourceRelease: currentRelease, ...readers });
      await verifyP5ActiveSourceInventory(this, currentRelease);
      const causalPlan = prepared.verifierPlan.causalReproduction ?? null;
      if (causalPlan) {
        const baselineRecord = readRecord(this.store, prepared.candidate.baselineRef, 'baselineManifest');
        const baselineSourceManifest = readRecord(this.store, baselineRecord.sourceManifest, 'sourceManifest');
        const tree = await inventoryP5SourceWithHost(causalPlan.executionRoot, { nativeSourceReader: readers.nativeSourceReader,
          maxFiles: this.protectedSelfRepairEnrollment.budgets.maxSourceFiles,
          maxBytes: this.protectedSelfRepairEnrollment.budgets.maxSourceBytes, include: ['**'], exclude: [],
          executableFor: executableForManifest(baselineSourceManifest) });
        if (canonicalHash(tree.entries) !== causalPlan.inventoryDigest)
          launchOrCaptureProblem ||= 'The baseline reproduction tree changed during verification.';
      }
      const dependencyNames = prepared.verifierPlan.dependencyClosure?.packages
        ?? [...new Set([...prepared.resolutions.values()].flatMap(item => item.resolution.installedPackages ?? []))];
      launchOrCaptureProblem ||= verifyInstalledDependenciesCurrent(prepared.roots.executionRoot, dependencyNames);
      const harnessAfter = await this.lifecycleClient.runningSourceInventory({ pid: process.pid, paths: [...TRUSTED_SOURCE_PATHS] });
      const harnessAfterByPath = new Map((harnessAfter.entries || []).filter(item => item && typeof item.path === 'string' && item.sha256).map(item => [item.path, item]));
      if (currentRelease.inputsDigest !== prepared.policy.harnessClosureDigest
        || harnessAfter.sourceDigest !== prepared.harnessSourceDigest
        || TRUSTED_SOURCE_PATHS.some(path => harnessAfterByPath.get(path)?.sha256 !== prepared.harnessSourceEntries.get(path)?.sha256
          || sha256(readFileSync(resolve(ENGINE_ROOT, ...path.split('/')))) !== prepared.harnessSourceEntries.get(path)?.sha256))
        launchOrCaptureProblem ||= 'Host-attested verifier source closure changed during verification.';
      if (canonicalHash(verifyP5PackageLayout(currentRelease)) !== prepared.verifierPlan.packageLayoutDigest)
        launchOrCaptureProblem ||= 'The installed P5 package layout changed during verification.';
      const nativeToolAfter = await readers.nativeToolIdentityReader({ path: process.execPath });
      if (nativeToolAfter?.refused || nativeToolAfter?.generation !== this.lifecycleHost.generation || nativeToolAfter?.epoch !== this.custodyEpoch
        || nativeToolAfter?.hostPid !== this.custodyHostPid || nativeToolAfter?.linkCount !== 1
        || canonicalHash(nativeToolAfter.identity) !== canonicalHash(prepared.nodeToolIdentity.identity)
        || sha256(readFileSync(process.execPath)) !== prepared.nodeToolSha256)
        launchOrCaptureProblem ||= 'Pinned Node runtime identity changed during trusted verification.';
    } catch (error) { launchOrCaptureProblem ||= error.message; }

    const stopped = record.stopRequested || this.runState(state.id) === 'stopping';
    const passed = complete && !launchOrCaptureProblem && !stopped && classified.status === 'passed'
      && result?.status === 'passed' && terminalRef && streamEvidenceRef && sourceAfter;
    const checkRows = [];
    if (passed) {
      for (const definition of prepared.policy.checks) {
        const raw = classified.byId.get(definition.checkId);
        const stdout = Buffer.from(raw.stdoutBase64, 'base64'), stderr = Buffer.from(raw.stderrBase64, 'base64');
        const stdoutArtifact = asRef(this.store.putBytes(stdout, 'application/octet-stream'));
        const stderrArtifact = asRef(this.store.putBytes(stderr, 'application/octet-stream'));
        const subject = prepared.resolutions.get(definition.checkId);
        const overlay = prepared.overlays.get(definition.checkId);
        const inputRow = prepared.testInputManifest.checks.find(item => item.checkId === definition.checkId);
        const evidence = { schemaVersion: 1, kind: 'ProtectedSelfRepairCheckObservation', candidateId: prepared.candidate.candidateId,
          candidateSourceDigest: prepared.candidate.candidateSourceDigest, baselineId: prepared.candidate.baselineId,
          checkId: definition.checkId, commandDigest: definition.commandDigest, inputDigest: subject.inputDigest,
          subjectResolution: subject.ref, executionTreeDigest: inputRow.executionTreeDigest,
          startedAt: raw.startedAt, endedAt: raw.endedAt, status: raw.status, exitCode: raw.exitCode,
          expectedAssertions: [...definition.expectedAssertions].sort(compareText),
          completedAssertions: [...raw.completedAssertions].sort(compareText), stdout: stdoutArtifact, stderr: stderrArtifact, captureStatus: 'complete' };
        validateP5Contract('checkObservationEvidence', evidence);
        const evidenceRef = asRef(this.store.putJson(evidence));
        checkRows.push({ checkId: definition.checkId, stageId: definition.stageId, required: definition.required,
          commandDigest: definition.commandDigest, toolIdentities: [definition.executable], inputDigest: subject.inputDigest,
          subjectResolution: subject.ref, executionTreeDigest: inputRow.executionTreeDigest,
          overlayManifest: overlay?.overlayManifestRef ?? null, startedAt: raw.startedAt, endedAt: raw.endedAt,
          status: raw.status, exitCode: raw.exitCode, expectedAssertions: [...definition.expectedAssertions].sort(compareText),
          completedAssertions: [...raw.completedAssertions].sort(compareText), stdout: stdoutArtifact, stderr: stderrArtifact, observations: evidenceRef });
      }
    }

    // The causal record is issued only for a passing verification: R(B) showed the expected defect and R(C) passed.
    const causalPlan = prepared.verifierPlan.causalReproduction ?? null;
    const dependencyRef = prepared.verifierPlan.dependencyClosure?.record ?? null;
    let causalRef = null;
    if (passed && causalPlan) {
      const reproduced = result.causalReproduction;
      const stdout = Buffer.from(reproduced.stdoutBase64 || '', 'base64'), stderr = Buffer.from(reproduced.stderrBase64 || '', 'base64');
      const definition = prepared.policy.checks.find(item => item.checkId === causalPlan.checkId);
      const inputRow = prepared.testInputManifest.checks.find(item => item.checkId === causalPlan.checkId);
      const row = checkRows.find(item => item.checkId === causalPlan.checkId);
      const record = { schemaVersion: 1, kind: 'ProtectedSelfRepairCausalReproduction', candidateId: prepared.candidate.candidateId,
        candidateSourceDigest: prepared.candidate.candidateSourceDigest, baselineId: prepared.candidate.baselineId,
        baselineCommit: causalPlan.baselineCommit, baselineSourceDigest: causalPlan.baselineSourceDigest, gateAttemptId: current.id,
        incidentId: prepared.candidate.incidentId, outcomeId: prepared.verificationInputs.outcomeId,
        outcomeRevision: prepared.verificationInputs.outcomeRevision, verificationPolicy: prepared.policyRef, verificationInputs: prepared.inputsRef,
        checkId: causalPlan.checkId, commandDigest: definition.commandDigest, inputDigest: inputRow.inputDigest, inputManifest: inputRow.materializedInputs,
        baselineMustPass: causalPlan.baselineMustPass, baselineMustFail: causalPlan.baselineMustFail,
        baselineExecutionTree: { capture: causalPlan.capture, inventoryDigest: causalPlan.inventoryDigest, fileCount: causalPlan.fileCount },
        baselineSubject: causalPlan.subject,
        baselineObservation: { status: reproduced.status, exitCode: reproduced.exitCode, harnessPassed: reproduced.harnessPassed,
          defectFailed: reproduced.defectFailed, stdout: asRef(this.store.putBytes(stdout, 'application/octet-stream')),
          stderr: asRef(this.store.putBytes(stderr, 'application/octet-stream')), startedAt: reproduced.startedAt, endedAt: reproduced.endedAt,
          reason: reproduced.reason ?? null },
        candidateObservation: { status: 'passed', completedAssertions: row.completedAssertions, executionTreeDigest: row.executionTreeDigest },
        dependencyClosureDigest: prepared.verifierPlan.dependencyClosure?.closureDigest ?? null, recordedAt: nowIso() };
      if (sha256(stdout) !== reproduced.stdoutSha256 || sha256(stderr) !== reproduced.stderrSha256)
        return this.failAttempt(state, current, 'p5_verification_incomplete', 'The baseline reproduction output failed its digest.');
      validateP5Contract('causalReproduction', record);
      causalRef = asRef(this.store.putJson(record));
    }
    const outcomeBody = { schemaVersion: 1, kind: 'ProtectedSelfRepairVerificationOutcome',
      status: stopped || (!passed && launchOrCaptureProblem) ? 'incomplete' : passed ? 'passed' : classified.status,
      candidateManifest: prepared.candidateRef, candidateId: prepared.candidate.candidateId,
      ...(prepared.candidate.gitCandidate ? { gitCandidate: prepared.candidate.gitCandidate } : {}),
      candidateSourceDigest: prepared.candidate.candidateSourceDigest, baselineId: prepared.candidate.baselineId,
      repairRunId: state.id, linkId: prepared.candidate.linkId, incidentId: prepared.candidate.incidentId,
      gateAttemptId: current.id, verificationPolicy: prepared.policyRef, verificationInputs: prepared.inputsRef,
      verifierResult: result ? asRef(this.store.putJson(result)) : null, terminalEvidence: terminalRef,
      streamEvidence: streamEvidenceRef, captureStatus: complete ? 'complete' : 'incomplete',
      reason: stopped ? 'Root Stop superseded P5 Gate verification.' : launchOrCaptureProblem,
      checks: checkRows, causalReproduction: causalRef, dependencyClosure: dependencyRef, recordedAt: nowIso() };
    validateP5Contract('verificationOutcome', outcomeBody);
    const outcomeRef = asRef(this.store.putJson(outcomeBody));

    if (stopped) {
      return this.store.transaction(() => {
        this.store.appendEvents(state.id, [{ type: 'self_repair.verification_recorded', payload: { record: outcomeRef }, nodeInstanceId: null, attemptId: null }]);
        const latest = this.store.get('SELECT * FROM attempts WHERE id = ?', current.id);
        if (latest && !['canceled', 'failed', 'succeeded', 'interrupted'].includes(latest.state))
          this.store.appendEvents(state.id, this.attemptTransition(latest, 'canceled', 'Root Stop superseded P5 Gate verification.', null,
            { source: 'external_control', code: 'interrupted', causeKnowledge: 'direct_fact', executionCertainty: 'completed', sideEffectCertainty: 'unknown',
              observedState: { hostState: terminal?.state || 'unknown', processTreeEnded: terminal?.processTreeEnded === true,
                spoolComplete: terminal?.spoolComplete === true, ...(Number.isInteger(outcome.code) ? { exitCode: outcome.code } : {}) } }));
      });
    }

    if (!passed) {
      const reason = launchOrCaptureProblem || `Mandatory P5 verification returned ${classified.status}; no passing receipt was issued.`;
      return this.store.transaction(() => {
        this.store.appendEvents(state.id, [{ type: 'self_repair.verification_recorded', payload: { record: outcomeRef }, nodeInstanceId: null, attemptId: null }]);
        const latest = this.store.get('SELECT * FROM attempts WHERE id = ?', current.id);
        if (latest && !['failed', 'canceled', 'succeeded', 'interrupted'].includes(latest.state))
          this.failAttempt(state, latest, complete ? 'p5_verification_failed' : 'p5_verification_incomplete', reason,
            { evidence: streamEvidenceRef || outcomeRef, source: complete ? 'workflow' : 'host', executionCertainty: complete ? 'completed' : 'unresolved',
              sideEffectCertainty: 'unknown', observedState: { hostState: terminal?.state || 'unknown', processTreeEnded: terminal?.processTreeEnded === true,
                ...(typeof terminal?.spoolComplete === 'boolean' ? { spoolComplete: terminal.spoolComplete } : {}), ...(Number.isInteger(outcome.code) ? { exitCode: outcome.code } : {}) } });
      });
    }

    const binding = this.custodyBindingOf(current.id);
    const hostIdentity = String(this.custodyHostPid ?? '');
    if (!binding || !hostIdentity || !Number.isSafeInteger(this.custodyEpoch) || !this.lifecycleHost?.generation)
      return this.failAttempt(state, current, 'p5_verification_incomplete', 'P5 Gate terminal evidence has no current Host identity, generation, epoch or Custody binding.');
    // The execution is the Host invocation admitted and launched under the durable verification-start record. A
    // replacement Engine that reattaches it settles the same execution, so the receipt binds the admitting epoch.
    if (prepared.startRecord.lifecycleGeneration !== this.lifecycleHost.generation || !Number.isSafeInteger(prepared.startRecord.engineEpoch))
      return this.failAttempt(state, current, 'p5_verification_incomplete', 'P5 Gate execution crossed a Lifecycle generation; its receipt is not issued.');
    const execution = { custodyId: binding.custody_id, hostIdentity, lifecycleGeneration: this.lifecycleHost.generation,
      engineEpoch: prepared.startRecord.engineEpoch, invocationDigest: terminal.invocationDigest,
      commandManifest: prepared.commandManifestRef, executableIdentity: process.execPath,
      harnessClosureDigest: prepared.policy.harnessClosureDigest, testInputManifest: prepared.testInputManifestRef,
      environmentDigest: prepared.environmentDigest ?? canonicalHash(prepared.invocation.env) };
    const now = nowIso();
    const receipt = { schemaVersion: 1, kind: 'ProtectedSelfRepairVerificationReceipt',
      receiptId: '0'.repeat(64), status: 'passed', candidateId: prepared.candidate.candidateId,
      candidateSourceDigest: prepared.candidate.candidateSourceDigest, baselineId: prepared.candidate.baselineId,
      candidateManifest: prepared.candidateRef, changeManifest: prepared.candidate.changeManifest,
      ...(prepared.candidate.gitCandidate ? { gitCandidate: prepared.candidate.gitCandidate } : {}),
      selfRepairProfile: prepared.candidate.selfRepairProfile, verificationPolicy: prepared.policyRef,
      verificationInputs: prepared.inputsRef, repairRunId: state.id, linkId: prepared.candidate.linkId,
      incidentId: prepared.candidate.incidentId, verificationNodeId: node.id, gateAttemptId: current.id,
      execution, checks: checkRows,
      requiredCheckSetDigest: canonicalHash([...prepared.policy.requiredCheckIds].sort(compareText)),
      completedCheckSetDigest: canonicalHash(checkRows.map(item => item.checkId).sort(compareText)),
      sourceBeforeDigest: prepared.candidate.candidateSourceDigest, sourceAfterDigest: prepared.candidate.candidateSourceDigest,
      liveCandidateDigest: prepared.candidate.candidateSourceDigest, harnessAfterDigest: prepared.policy.harnessClosureDigest,
      terminalEvidence: terminalRef, captureStatus: 'complete', startedAt: prepared.startedAt, completedAt: now,
      observationJournalCursor: this.requireRun(state.id).last_sequence + checkRows.length,
      issuedJournalCursor: this.requireRun(state.id).last_sequence + checkRows.length + 2,
      ...(causalRef ? { causalReproduction: causalRef } : {}), ...(dependencyRef ? { dependencyClosure: dependencyRef } : {}) };
    receipt.receiptId = p5VerificationReceiptId({ candidateId: receipt.candidateId,
      verificationPolicyDigest: prepared.policyRef.sha256, gateAttemptId: current.id,
      custodyId: binding.custody_id, checks: receipt.checks, causalReproduction: causalRef, dependencyClosure: dependencyRef });
    try { verifyP5Receipt(receipt, { store: this.store, candidateRef: prepared.candidateRef,
      gateAttemptId: current.id, terminalEvidenceRef: terminalRef }); }
    catch (error) { return this.failAttempt(state, current, error.code || 'p5_receipt_invalid', error.message); }
    const receiptRef = asRef(this.store.putJson(receipt));
    const report = { schemaVersion: 1, kind: 'ProtectedSelfRepairVerificationReport', status: 'passed',
      candidateId: receipt.candidateId, candidateSourceDigest: receipt.candidateSourceDigest,
      gateAttemptId: current.id, receipt: receiptRef, requiredCheckIds: prepared.policy.requiredCheckIds,
      completedCheckIds: checkRows.map(item => item.checkId), custodyId: binding.custody_id };
    const reportValue = jsonValue(this.store.putJson(report));
    const executionEvidence = { schemaVersion: 1, kind: 'ExecutionEvidence', attemptId: current.id,
      nodeInstanceId: current.node_instance_id, outcome: 'passed', exitCode: outcome.code,
      startedAt: prepared.startedAt, endedAt: now, command: prepared.invocationRef,
      streams: { stdout: stdoutRef, stderr: stderrRef }, captureVerdict: 'complete', reason: 'All required enrolled P5 verification checks passed with complete Host Custody evidence.' };
    const executionEvidenceRef = asRef(this.store.putJson(executionEvidence));
    custodyCrashOnce('p5_before_gate_receipt');
    const issued = this.store.transaction(() => {
      const latestRun = this.requireRun(state.id);
      const latestAttempt = this.store.get('SELECT * FROM attempts WHERE id = ?', current.id);
      const latestLink = this.logicalRepairLinkForRun(state.id);
      const parent = latestLink && this.store.get('SELECT state FROM runs WHERE id = ?', latestLink.parent_run_id);
      if (latestRun.state !== 'running' || latestAttempt?.state !== 'running' || latestLink?.state !== 'open'
        || !['running', 'waiting_for_user'].includes(parent?.state)
        || !this.logicalRepairLinkIntact(latestLink, latestRun)) {
        const revokedOutcome = { ...outcomeBody, status: 'incomplete',
          reason: 'P5 eligibility changed before the receipt transaction; no passing receipt was committed.' };
        validateP5Contract('verificationOutcome', revokedOutcome);
        const revokedOutcomeRef = asRef(this.store.putJson(revokedOutcome));
        this.store.appendEvents(state.id, [{ type: 'self_repair.verification_recorded', payload: { record: revokedOutcomeRef },
          nodeInstanceId: null, attemptId: null }]);
        if (latestAttempt && !['failed', 'canceled', 'succeeded', 'interrupted'].includes(latestAttempt.state)) {
          const stopped = latestRun.state === 'stopping' || latestLink?.state === 'parent_stopped'
            || !['running', 'waiting_for_user'].includes(parent?.state);
          this.store.appendEvents(state.id, this.attemptTransition(latestAttempt, stopped ? 'canceled' : 'failed',
            stopped ? 'Root Stop or Parent suspension revoked P5 verification before receipt issuance.'
              : 'P5 Repair authority changed before receipt issuance.', null,
            stopped ? undefined : { source: 'workflow', code: 'p5_gate_authority_changed', executionCertainty: 'completed',
              sideEffectCertainty: 'unknown', observedState: { verificationStatus: 'passed', receiptCommitted: false } }));
        }
        return false;
      }
      const events = [];
      for (const check of checkRows) events.push({ type: 'attempt.execution_evidence', nodeInstanceId: current.node_instance_id,
        attemptId: current.id, payload: { evidence: check.observations, outcome: 'passed', checkId: check.checkId } });
      const recorded = this.store.appendEvents(state.id, events);
      const observationCursor = recorded.at(-1)?.sequence ?? this.requireRun(state.id).last_sequence;
      const issueCursor = this.requireRun(state.id).last_sequence + 2;
      if (receipt.observationJournalCursor !== observationCursor || receipt.issuedJournalCursor !== issueCursor)
        fail('p5_receipt_cursor_race', 'P5 Gate journal cursor changed before its atomic receipt transaction.');
      this.store.appendEvents(state.id, [{ type: 'attempt.execution_evidence', nodeInstanceId: current.node_instance_id,
        attemptId: current.id, payload: { evidence: executionEvidenceRef, outcome: 'passed' } },
      { type: 'self_repair.verification_recorded', payload: { record: receiptRef }, nodeInstanceId: null, attemptId: null },
      this.commitOutputs(state, current, { report: reportValue }),
      ...this.attemptTransition(this.store.get('SELECT * FROM attempts WHERE id = ?', current.id), 'succeeded', 'Trusted P5 verification completed and the Engine issued a candidate-bound receipt.')]);
      return true;
    });
    if (!issued) return;
  };

  P.protectedSelfRepairGatePlanForAttempt = function protectedSelfRepairGatePlanForAttempt(runId, attemptId) {
    const events = this.store.readEvents(runId).filter(event => event.type === 'self_repair.verification_started' && event.attemptId === null);
    const matches = events.filter(event => event.payload?.record);
    if (matches.length !== 1) return null;
    this.store.verifyRef(matches[0].payload.record);
    const start = this.store.readJson(matches[0].payload.record.artifactId);
    validateP5Contract('verificationStarted', start);
    if (start.kind !== 'ProtectedSelfRepairVerificationStarted' || start.runId !== runId || start.gateAttemptId !== attemptId
      || !start.verifierPlan || !start.invocation || !start.candidateManifest) return null;
    for (const artifactRef of [start.verifierPlan, start.invocation, start.candidateManifest, start.verificationPolicy,
      start.verificationInputs, start.commandManifest, start.testInputManifest]) this.store.verifyRef(artifactRef);
    return { start, startRef: matches[0].payload.record };
  };

  P.protectedSelfRepairGateCanResume = function protectedSelfRepairGateCanResume(state, node, attempt, record) {
    try {
      if (this.protectedSelfRepairAdmissionEnabled !== true || !this.custodyHost || this.custodyUnavailable || !this.protectedSelfRepairEnrollment
        || node.type !== 'gate' || node.config?.mode !== 'self-repair-verify' || node.id !== enrollmentProfileNodeId(this, state.id)
        || record.p5ProtectedGate !== true || record.custodyResume !== true) return false;
      const stored = this.protectedSelfRepairGatePlanForAttempt(state.id, attempt.id);
      if (!stored || attempt.invocation_artifact_id !== stored.start.invocation.artifactId) return false;
      const invocation = this.store.readJson(stored.start.invocation.artifactId);
      return invocation.runId === state.id && invocation.attemptId === attempt.id && invocation.provider === P5_PROVIDER
        && invocation.cliExecutable === process.execPath && invocation.arguments.length === 1
        && invocation.arguments[0] === VERIFIER_PATH && this.custodyBindingOf(attempt.id) !== null;
    } catch { return false; }
  };

  P.resumeProtectedSelfRepairGate = async function resumeProtectedSelfRepairGate(state, node, attempt, workspace, record) {
    const stored = this.protectedSelfRepairGatePlanForAttempt(state.id, attempt.id);
    if (!stored || !this.protectedSelfRepairGateCanResume(state, node, attempt, record))
      fail('p5_gate_resume_plan_missing', 'P5 Gate recovery cannot prove the exact persisted invocation and candidate plan.');
    const { start } = stored;
    const candidate = readRecord(this.store, start.candidateManifest, 'candidate');
    if (canonicalHash(start.gitCandidate ?? null) !== canonicalHash(candidate.gitCandidate ?? null))
      fail('p5_gate_resume_plan_mismatch', 'Recovered P5 Gate Git candidate differs from the exact captured candidate binding.');
    const policy = readRecord(this.store, start.verificationPolicy, 'verificationPolicy');
    const inputs = readRecord(this.store, start.verificationInputs, 'verificationInputs');
    const verifierPlan = this.store.readJson(start.verifierPlan.artifactId);
    const commandManifest = readRecord(this.store, start.commandManifest, 'commandManifest');
    const testInputManifest = readRecord(this.store, start.testInputManifest, 'testInputManifest');
    const sourceManifest = readRecord(this.store, candidate.sourceManifest, 'sourceManifest');
    const invocation = this.store.readJson(start.invocation.artifactId);
    assertValid('attempt-record.schema.json', 'invocation', invocation, 'Recovered P5 Gate invocation manifest');
    verifyRef(this.store, invocation.stdin, 'recovered verifier plan stdin');
    const recoveredStdin = this.store.readBytes(invocation.stdin.artifactId).bytes.toString('utf8');
    if (verifierPlan.kind !== 'ProtectedSelfRepairVerifierPlan' || verifierPlan.schemaVersion !== 1
      || verifierPlan.candidateId !== candidate.candidateId || verifierPlan.candidateSourceDigest !== candidate.candidateSourceDigest
      || verifierPlan.baselineId !== candidate.baselineId || verifierPlan.gateAttemptId !== attempt.id
      || canonicalHash(verifierPlan.policy) !== canonicalHash(policy)
      || canonicalHash(verifierPlan.verificationInputs) !== canonicalHash(inputs)
      || canonicalHash(verifierPlan.commandManifest) !== canonicalHash(commandManifest)
      || recoveredStdin !== canonicalize(verifierPlan) || invocation.configurationHash !== canonicalHash(verifierPlan)
      || verifierPlan.roots?.['verify-scratch'] !== start.verifyScratch
      || verifierPlan.roots?.['candidate-source'] !== start.freshSourceRoot
      || verifierPlan.roots?.['candidate-execution-tree'] !== start.executionRoot
      || invocation.runId !== state.id || invocation.attemptId !== attempt.id || invocation.provider !== P5_PROVIDER
      || invocation.cliExecutable !== process.execPath || !samePath(resolve(invocation.cwd), resolve(candidate.workspace.canonicalRoot))
      || invocation.arguments.length !== 1 || invocation.arguments[0] !== VERIFIER_PATH
      || commandManifest.candidateId !== candidate.candidateId || commandManifest.gateAttemptId !== attempt.id
      || canonicalHash(commandManifest.verificationPolicy) !== canonicalHash(start.verificationPolicy)
      || commandManifest.roots?.candidateSource !== start.freshSourceRoot
      || commandManifest.roots?.executionRoot !== start.executionRoot
      || commandManifest.roots?.verifyScratch !== start.verifyScratch
      || testInputManifest.candidateId !== candidate.candidateId || testInputManifest.candidateSourceDigest !== candidate.candidateSourceDigest
      || testInputManifest.baselineId !== candidate.baselineId
      || canonicalHash(testInputManifest.verificationPolicy) !== canonicalHash(start.verificationPolicy)
      || canonicalHash(testInputManifest.verificationInputs) !== canonicalHash(start.verificationInputs)
      || testInputManifest.harnessClosureDigest !== policy.harnessClosureDigest)
      fail('p5_gate_resume_plan_mismatch', 'Recovered P5 Gate plan, command, input manifest and invocation do not bind to the exact candidate Attempt.');
    const prepared = { candidate, candidateRef: start.candidateManifest, policy, policyRef: start.verificationPolicy,
      verificationInputs: inputs, inputsRef: start.verificationInputs, verifierPlan, verifierPlanRef: start.verifierPlan,
      commandManifest, commandManifestRef: start.commandManifest, testInputManifest, testInputManifestRef: start.testInputManifest,
      sourceManifest, startRecord: start, environmentDigest: start.environmentDigest,
      invocation: { command: invocation.cliExecutable, args: invocation.arguments, cwd: invocation.cwd, env: {}, stdin: null },
      invocationRef: start.invocation, startedAt: start.startedAt, roots: { candidateSource: start.freshSourceRoot,
        executionRoot: start.executionRoot, scratch: start.verifyScratch }, resolutions: new Map(), overlays: new Map() };
    const recoveryBindings = loadProtectedSelfRepairGateRecoveryBindings({ store: this.store, policy, testInputManifest });
    for (const check of policy.checks) {
      const binding = recoveryBindings.get(check.checkId);
      prepared.resolutions.set(check.checkId, { resolution: binding.subjectResolution, ref: binding.inputRow.subjectResolution,
        inputDigest: binding.inputRow.inputDigest });
      prepared.overlays.set(check.checkId, binding.overlayManifest
        ? { overlayManifest: binding.overlayManifest, overlayManifestRef: binding.overlayManifestRef } : null);
    }
    const recoverySourceRelease = await this.lifecycleClient.runningSourceRelease({ pid: process.pid });
    const readers = this.protectedSelfRepairHostReaders();
    await verifyP5GitBaselineCurrent({ store: this.store, enrollment: this.protectedSelfRepairEnrollment,
      currentRunningSourceRelease: recoverySourceRelease, ...readers });
    if (recoverySourceRelease.inputsDigest !== start.harnessClosureDigest)
      fail('p5_gate_resume_harness_mismatch', 'Recovered P5 Gate build-input closure differs from its durable start record.');
    await verifyP5ActiveSourceInventory(this, recoverySourceRelease);
    record.provider = P5_PROVIDER;
    record.parser = createP5Parser();
    record.custodyResume = true;
    const executionNode = { ...node, config: { ...node.config, provider: P5_PROVIDER, timeoutSeconds: verifierPlan.aggregateTimeoutSeconds } };
    const outcome = await this.runProcess(state, this.store.get('SELECT * FROM attempts WHERE id = ?', attempt.id), executionNode, null, record);
    const currentRelease = await this.lifecycleClient.runningSourceRelease({ pid: process.pid });
    await verifyP5GitBaselineCurrent({ store: this.store, enrollment: this.protectedSelfRepairEnrollment,
      currentRunningSourceRelease: currentRelease, ...readers });
    await verifyP5ActiveSourceInventory(this, currentRelease);
    const hostInventory = await this.lifecycleClient.runningSourceInventory({ pid: process.pid, paths: [...TRUSTED_SOURCE_PATHS] });
    const attestedByPath = new Map((hostInventory?.entries || []).filter(item => item && typeof item.path === 'string' && item.sha256)
      .map(item => [item.path, item]));
    if (currentRelease.inputsDigest !== start.harnessClosureDigest || hostInventory?.sourceDigest !== currentRelease.sourceDigest
      || hostInventory?.generation !== this.lifecycleHost?.generation
      || TRUSTED_SOURCE_PATHS.some(path => !attestedByPath.has(path)
        || !existsSync(resolve(ENGINE_ROOT, ...path.split('/')))
        || sha256(readFileSync(resolve(ENGINE_ROOT, ...path.split('/')))) !== attestedByPath.get(path).sha256))
      fail('p5_gate_resume_harness_mismatch', 'Recovered P5 Gate does not match its Host-attested verifier source closure.');
    const nodeTool = this.protectedSelfRepairEnrollment.toolIdentities.filter(item => item.name === 'node');
    const nodeToolIdentity = nodeTool.length === 1 ? await readers.nativeToolIdentityReader({ path: process.execPath }) : null;
    if (nodeTool.length !== 1 || !samePath(resolve(nodeTool[0].path), resolve(process.execPath))
      || nodeTool[0].sha256 !== sha256(readFileSync(process.execPath)) || nodeToolIdentity?.refused
      || nodeToolIdentity?.linkCount !== 1 || nodeToolIdentity?.generation !== this.lifecycleHost?.generation
      || nodeToolIdentity?.epoch !== this.custodyEpoch || nodeToolIdentity?.hostPid !== this.custodyHostPid
      || nodeToolIdentity?.byteSize !== readFileSync(process.execPath).length)
      fail('p5_gate_resume_runtime_mismatch', 'Recovered P5 Gate cannot reestablish its enrolled native Node runtime identity.');
    prepared.harnessSourceEntries = attestedByPath;
    prepared.harnessSourceDigest = currentRelease.sourceDigest;
    prepared.nodeToolIdentity = nodeToolIdentity;
    prepared.nodeToolSha256 = nodeTool[0].sha256;
    await this.settleProtectedSelfRepairGate(state, executionNode, attempt, workspace, record, prepared, outcome);
  };
}

function enrollmentProfileNodeId(engine, runId) {
  const link = engine.logicalRepairLinkForRun(runId);
  const authorization = link && engine.parentRepairAuthorization(link);
  if (!authorization?.selfRepairProfile) return null;
  try {
    engine.store.verifyRef(authorization.selfRepairProfile);
    return engine.store.readJson(authorization.selfRepairProfile.artifactId).verificationNodeId;
  } catch { return null; }
}
