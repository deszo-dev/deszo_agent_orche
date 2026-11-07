// P6 Fixed Trusted Builder (ADR-0010 Section 3-4, Contracts Section 3-4).
// Builds the Engine candidate using fixed installed builder tools (Node.js + esbuild + bundleRunner).
// Executes NO candidate scripts, plugins, or npm install commands.
// Performs two independent builds into separate isolated directories and asserts byte-for-byte reproducibility.
// Generates schema 2 build.json with exact Shell binding.
// Emits immutable P6BuildReceipt/1 artifact into the Store.

import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { canonicalBytes, canonicalHash, canonicalize, sha256 } from './canonical.mjs';
import { P5_SUPPORT_KIND, P5_SUPPORT_MANIFEST } from './p5Support.mjs';
import { ENGINE_ROOT, P5_SUPPORT_ROOT_NAME } from './engineRoot.mjs';
import { SOURCE_INVENTORY_PATH } from '../host/sourceProvenance.mjs';
import { buildInputsDigest, securityClosure } from '../host/installedBuilds.mjs';
import { RUNTIME_API_VERSION } from '../host/runtimeRelease.mjs';
import { validateP5Contract } from './protectedSelfRepair.mjs';
import { verifyP6SourceGitProvenance } from './p6Reconstruction.mjs';

export const SHELL_RELEASE_KIND = 'DeszoShellRelease';
export const ENGINE_MANIFEST_SCHEMA = 2;

const RUNNER_BANNER = "import { createRequire as __createRequire } from 'node:module'; import {fileURLToPath as __runnerFileURLToPath} from 'node:url'; import {dirname as __runnerDirname} from 'node:path'; const require = __createRequire(import.meta.url); const __filename=__runnerFileURLToPath(import.meta.url), __dirname=__runnerDirname(__filename);";

const TYPESCRIPT_FROM_P5_SUPPORT = `import { createRequire as __p5CreateRequire } from 'node:module';
import { fileURLToPath as __p5FileURLToPath } from 'node:url';
import { dirname as __p5Dirname, join as __p5Join } from 'node:path';
let loaded = null;
const load = () => loaded ??= __p5CreateRequire(__p5Join(__p5Dirname(__p5FileURLToPath(import.meta.url)), '..', 'p5', 'package.json'))('typescript');
export default new Proxy({}, { get: (_target, key) => load()[key] });
`;

const packagedRunner = root => ({
  name: 'deszo-packaged-runner',
  setup(builder) {
    builder.onResolve({ filter: /^typescript$/ }, () => ({ path: 'typescript', namespace: 'deszo-p5-support' }));
    builder.onLoad({ filter: /.*/, namespace: 'deszo-p5-support' }, () => ({ contents: TYPESCRIPT_FROM_P5_SUPPORT, loader: 'js', resolveDir: root }));
    builder.onResolve({ filter: /[\\/]fixture-adapters\.mjs$/ }, args => ({ path: args.path, external: true }));
  },
});

/** Resolve the builder only from the supplied installed Engine root's attested dependency payload. */
export function resolveTrustedEsbuild(engineRoot = ENGINE_ROOT) {
  const requireFromEngine = createRequire(join(resolve(engineRoot), 'package.json'));
  const manifestPath = requireFromEngine.resolve('esbuild/package.json');
  const { build } = requireFromEngine('esbuild');
  if (typeof build !== 'function') throw new Error('The installed esbuild package does not expose its build API.');
  return { build, manifestPath };
}

async function bundleRunner({ root, outfile, testFaultHooks = false }) {
  if (typeof testFaultHooks !== 'boolean') throw new TypeError('testFaultHooks must be boolean.');
  const { build: esbuildBuild } = resolveTrustedEsbuild();
  await esbuildBuild({
    entryPoints: [`${root}/runtime/runner.mjs`], outfile, absWorkingDir: root,
    bundle: true, platform: 'node', format: 'esm', target: 'node22', legalComments: 'none',
    banner: { js: RUNNER_BANNER }, define: { __DESZO_PACKAGED__: 'true', __DESZO_TEST_FAULT_HOOKS__: String(testFaultHooks) }, plugins: [packagedRunner(root)],
    external: ['esbuild'],
  });
}

export class P6BuildError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'P6BuildError';
    this.code = code;
    this.details = details;
  }
}

const portable = (root, path) => relative(root, path).split(sep).join('/');

export function calculateCandidateDigest(packageDir) {
  const files = [];
  function walk(current) {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        throw new P6BuildError('p6_build_symlink_forbidden', `Symlink forbidden in package: ${full}`);
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile()) {
        const rel = relative(packageDir, full).split(sep).join('/');
        files.push({ rel, full });
      }
    }
  }
  walk(packageDir);
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  const hash = createHash('sha256');
  for (const { rel, full } of files) {
    const bytes = readFileSync(full);
    const nameBytes = Buffer.from(rel, 'utf8');
    const nameLen = Buffer.alloc(8);
    nameLen.writeBigUInt64BE(BigInt(nameBytes.length));
    const byteLen = Buffer.alloc(8);
    byteLen.writeBigUInt64BE(BigInt(bytes.length));

    hash.update(nameLen);
    hash.update(nameBytes);
    hash.update(byteLen);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

function collectPlainFiles(root) {
  const files = [];
  function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) throw new P6BuildError('p6_build_symlink_forbidden', `Symlink forbidden: ${full}`);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) files.push(full);
    }
  }
  walk(root);
  return files;
}

function dependencyPackageNames(dependenciesSourceDir) {
  const root = join(dependenciesSourceDir, 'node_modules');
  if (!existsSync(root)) throw new P6BuildError('p6_build_dependency_closure_missing', 'The installed Engine dependency closure is unavailable.');
  const names = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('@')) {
      for (const scoped of readdirSync(join(root, entry.name), { withFileTypes: true }))
        if (scoped.isDirectory()) names.push(`${entry.name}/${scoped.name}`);
    } else if (entry.name !== '.bin') names.push(entry.name);
  }
  return names.sort();
}

async function candidateBuildInputClosure({ store, handoff, sourceRoot, sourceManifest, provenance, dependenciesSourceDir }) {
  if (!dependenciesSourceDir) throw new P6BuildError('p6_build_dependency_closure_missing', 'The installed Engine dependency closure is unavailable.');
  store.verifyRef(handoff.enrollment);
  const enrollment = store.readJson(handoff.enrollment.artifactId);
  validateP5Contract('enrollment', enrollment);
  const gitTools = (enrollment.toolIdentities || []).filter(item => item.name === 'git');
  if (gitTools.length !== 1 || !gitTools[0]?.path || !/^[a-f0-9]{64}$/.test(gitTools[0]?.sha256 || ''))
    throw new P6BuildError('p6_build_git_tool_identity_missing', 'The exact enrolled Git tool identity is required for the build-input closure.');
  const gitTool = { path: gitTools[0].path, sha256: gitTools[0].sha256 };
  const names = sourceManifest.entries.map(entry => entry.path);
  const readVerifiedGitMetadata = async root => ({ sourceCommit: provenance.sourceCommit, names,
    commonDirectory: root, gitTool });
  const closure = await securityClosure(sourceRoot, gitTool, readVerifiedGitMetadata, dependenciesSourceDir);
  if (closure.source.sourceCommit !== provenance.sourceCommit || closure.source.sourceDigest !== provenance.sourceDigest)
    throw new P6BuildError('p6_build_input_source_mismatch', 'The trusted build-input inventory differs from the verified P5 source tree.');
  const packages = dependencyPackageNames(dependenciesSourceDir);
  const { manifestPath: esbuildManifestPath } = resolveTrustedEsbuild();
  const esbuildVersion = JSON.parse(readFileSync(esbuildManifestPath, 'utf8')).version;
  const esbuildRoot = dirname(esbuildManifestPath);
  const esbuildFiles = collectPlainFiles(esbuildRoot).map(path => ({ path: portable(esbuildRoot, path), sha256: sha256(readFileSync(path)) }));
  const builderIdentity = {
    node: process.version,
    esbuild: esbuildVersion,
    nodeExecutable: { path: resolve(process.execPath), sha256: sha256(readFileSync(process.execPath)) },
    esbuildPackage: { path: resolve(esbuildManifestPath), sha256: canonicalHash(esbuildFiles) },
  };
  const hostInputsDigest = buildInputsDigest(closure, provenance.sourceCommit);
  return {
    buildInputDigest: canonicalHash({ hostInputsDigest, builderIdentity }),
    buildInputClosure: {
      schemaVersion: 1,
      kind: 'P6BuildInputClosure',
      sourceInventoryDigest: closure.source.sourceDigest,
      authorityClosureDigest: closure.digest,
      dependencyDigest: closure.dependencyDigest,
      gitTool,
      hostInputsDigest,
      builderIdentity,
      dependencyPackages: packages,
    },
    builderIdentity,
    dependencyPackages: packages,
    dependencyFiles: closure.dependencies,
    dependencyDigest: closure.dependencyDigest,
  };
}

/**
 * Builds an Engine package from reconstructed candidate source into outDir.
 */
async function buildSingleEnginePackage({
  reconstructedSourceRoot,
  shell,
  runtimeResources,
  outDir,
  engineBuildId,
  sourceCommit,
  candidateSourceDigest,
  installedSourceDigest,
  buildInputDigest,
  dependencyDigest,
  dependencyPackages,
  dependencyFiles,
  builderIdentity,
  sourceManifest,
  dependenciesSourceDir,
  testFaultHooks = false,
}) {
  if (existsSync(outDir)) {
    rmSync(outDir, { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });

  const payloadRoot = join(outDir, P5_SUPPORT_ROOT_NAME);
  const runtimeRoot = join(outDir, 'runtime');
  mkdirSync(payloadRoot);
  mkdirSync(runtimeRoot);

  // 1. Copy reconstructed runtime sources into p5/
  const payloadFiles = [];
  function copyToPayload(relPath, srcPath, expected = null) {
    const dest = join(payloadRoot, ...relPath.split('/'));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(srcPath, dest);
    const bytes = readFileSync(dest);
    if (expected && (bytes.length !== expected.byteSize && expected.byteSize !== undefined
      || sha256(bytes) !== expected.sha256)) {
      throw new P6BuildError('p6_build_input_changed', `Build input changed while packaging: ${relPath}`);
    }
    payloadFiles.push({ path: relPath, sha256: sha256(bytes), bytes: bytes.length });
  }

  // Copy candidate runtime sources from reconstructedSourceRoot
  const sourceFiles = collectPlainFiles(reconstructedSourceRoot);
  const expectedSources = new Map((sourceManifest?.entries || []).map(entry => [entry.path, entry]));
  if (sourceFiles.length !== expectedSources.size)
    throw new P6BuildError('p6_build_source_file_set_mismatch', 'The materialized source file set differs from the accepted P5 manifest.');
  for (const full of sourceFiles) {
    const rel = portable(reconstructedSourceRoot, full);
    const expected = expectedSources.get(rel);
    if (!expected) throw new P6BuildError('p6_build_source_file_set_mismatch', `Unexpected materialized source file: ${rel}`);
    copyToPayload(rel, full, expected);
  }

  // Copy dependencies into p5/node_modules if provided
  const dependencyRoot = dependenciesSourceDir ? join(dependenciesSourceDir, 'node_modules') : null;
  if (dependencyRoot && existsSync(dependencyRoot)) {
    const depFiles = collectPlainFiles(dependencyRoot);
    const expectedDependencies = new Map((dependencyFiles || []).map(entry => [entry.path, entry]));
    if (depFiles.length !== expectedDependencies.size)
      throw new P6BuildError('p6_build_dependency_file_set_mismatch', 'The installed dependency file set changed during the reproducible build.');
    for (const full of depFiles) {
      const rel = `node_modules/${portable(dependencyRoot, full)}`;
      const expected = expectedDependencies.get(rel);
      if (!expected) throw new P6BuildError('p6_build_dependency_file_set_mismatch', `Unexpected installed dependency file: ${rel}`);
      copyToPayload(rel, full, expected);
    }
  }

  // 2. Bundle runner.mjs from payloadRoot
  const runnerPath = join(runtimeRoot, 'runner.mjs');
  try {
    await bundleRunner({ root: payloadRoot, outfile: runnerPath, testFaultHooks });
  } catch (error) {
    throw new P6BuildError('p6_build_bundle_failed', `Failed to bundle runner.mjs: ${error.message}`);
  }
  const runnerBytes = readFileSync(runnerPath);
  const runnerDigest = sha256(runnerBytes);

  // 3. Copy runtime resources (frozen resources from shell, bridge, shim, etc.)
  for (const name of readdirSync(runtimeResources).sort()) {
    if (['runner.mjs', 'runtime-manifest.json'].includes(name)) continue;
    const from = join(runtimeResources, name);
    if (!lstatSync(from).isFile()) continue;
    copyFileSync(from, join(runtimeRoot, name));
  }

  // Verify frozen resources match Shell
  if (shell?.frozenResources) {
    for (const frozen of shell.frozenResources) {
      const frozenRel = frozen.path.replace(/^runtime\//, '');
      const actualPath = join(runtimeRoot, frozenRel);
      if (!existsSync(actualPath)) {
        throw new P6BuildError('p6_build_missing_frozen_resource', `Frozen resource missing: ${frozen.path}`);
      }
      const actualDigest = sha256(readFileSync(actualPath));
      if (actualDigest !== frozen.sha256) {
        throw new P6BuildError(
          'p6_build_frozen_resource_mismatch',
          `Frozen resource ${frozen.path} digest ${actualDigest} does not match Shell ${frozen.sha256}`
        );
      }
    }
  }

  // 4. Write runtime-manifest.json
  let resourceManifest = {};
  const baseManifestPath = join(runtimeResources, 'runtime-manifest.json');
  if (existsSync(baseManifestPath)) {
    try {
      resourceManifest = JSON.parse(readFileSync(baseManifestPath, 'utf8'));
    } catch { /* fallback */ }
  }
  resourceManifest.kind = 'DeszoRuntimeBuild';
  resourceManifest.version = 1;
  resourceManifest.files = Object.fromEntries(
    readdirSync(runtimeRoot).sort().map(name => [name, sha256(readFileSync(join(runtimeRoot, name)))])
  );
  resourceManifest.sourceHead = sourceCommit;
  resourceManifest.testFaultHooks = testFaultHooks;
  resourceManifest.assurance = 'P6 Engine package; bundle reproduced from attested P5 support payload.';
  writeFileSync(join(runtimeRoot, 'runtime-manifest.json'), `${JSON.stringify(resourceManifest, null, 2)}\n`, { flag: 'wx' });

  // 5. Write p5-support.json
  const support = {
    schemaVersion: 1,
    kind: P5_SUPPORT_KIND,
    buildId: engineBuildId,
    sourceCommit,
    sourceDigest: installedSourceDigest,
    inputsDigest: buildInputDigest,
    dependencyDigest,
    dependencyPackages,
    runtimeBundle: {
      path: 'runtime/runner.mjs',
      sha256: runnerDigest,
      bytes: runnerBytes.length,
      reproducible: true,
    },
    builder: builderIdentity,
    copiedResources: readdirSync(runtimeRoot)
      .filter(name => name !== 'runner.mjs')
      .sort()
      .map(name => ({ path: `runtime/${name}`, sha256: sha256(readFileSync(join(runtimeRoot, name))) })),
    files: payloadFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
  const supportBytes = Buffer.from(canonicalize(support), 'utf8');
  writeFileSync(join(payloadRoot, P5_SUPPORT_MANIFEST), supportBytes, { flag: 'wx' });

  // 6. Write .deszo-source-inventory.json
  const inventoryFiles = (sourceManifest?.entries || []).map(e => ({
    path: e.path,
    sha256: e.sha256,
  })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const inventorySourceDigest = inventoryFiles.length ? canonicalHash(inventoryFiles) : candidateSourceDigest;
  const inventory = {
    schemaVersion: 1,
    kind: 'DeszoBuildSourceInventory',
    sourceCommit,
    sourceDigest: inventorySourceDigest,
    files: inventoryFiles,
  };
  const inventoryBytes = Buffer.from(canonicalize(inventory), 'utf8');
  writeFileSync(join(outDir, SOURCE_INVENTORY_PATH), inventoryBytes, { flag: 'wx' });

  // 7. Write .deszo-test-fault-hooks if enabled
  if (testFaultHooks) {
    writeFileSync(join(outDir, '.deszo-test-fault-hooks'), 'DESZO_TEST_FAULT_HOOKS_V1\n', { flag: 'wx' });
  }

  // 8. Write build.json schema 2
  const artifacts = collectPlainFiles(outDir)
    .map(p => ({
      path: portable(outDir, p),
      sha256: sha256(readFileSync(p)),
      bytes: statSync(p).size,
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const manifest = {
    schemaVersion: ENGINE_MANIFEST_SCHEMA,
    buildId: engineBuildId,
    engineBuildId,
    shellBuildId: shell.shellBuildId,
    runtimeApiVersion: RUNTIME_API_VERSION,
    bootstrap: 'engine',
    sourceCommit,
    dirtySourceDigest: inventorySourceDigest,
    inputsDigest: buildInputDigest,
    artifacts,
    sourceInventory: { path: SOURCE_INVENTORY_PATH, sha256: sha256(inventoryBytes) },
    p5Support: { path: `${P5_SUPPORT_ROOT_NAME}/${P5_SUPPORT_MANIFEST}`, sha256: sha256(supportBytes) },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  writeFileSync(join(outDir, 'build.json'), manifestBytes, { flag: 'wx' });

  const packageSha256 = calculateCandidateDigest(outDir);
  return {
    engineBuildId,
    shellBuildId: shell.shellBuildId,
    packageSha256,
    manifestSha256: sha256(manifestBytes),
    sourceDigest: inventorySourceDigest,
    buildInputDigest,
    artifacts,
    outDir,
  };
}

/**
 * Executes the complete trusted two-build reproducible packaging and produces P6BuildReceipt/1.
 * @param {Object} options
 * @param {Object} options.store Store instance
 * @param {Object} options.handoff Accepted ProtectedSelfRepairHandoff/1
 * @param {Object} options.handoffRef Exact Store reference from self_repair.handoff_recorded
 * @param {string} options.reconstructedSourceRoot1 First source materialization
 * @param {string} options.reconstructedSourceRoot2 Second source materialization (for reproduction)
 * @param {Object} options.shell Installed DeszoShellRelease
 * @param {string} options.runtimeResources Runtime resources directory (frozen resources)
 * @param {string} options.outDir Final package destination
 * @param {string} options.engineBuildId Engine B build identity
 * @param {string} options.operationId Unique P6 operation UUID
 * @param {Object} options.operationIntentRef Exact immutable P6Operation/1 reference
 * @param {Function} options.prepareSuccessor Creates successor artifacts after package identity is known
 * @param {Object} options.previousRelease Previous running source release
 * @param {string} [options.dependenciesSourceDir] Dependencies source dir
 * @param {boolean} [options.testFaultHooks=false] Test fault hooks flag
 * @returns {Promise<{ receipt: Object, receiptArtifact: Object, packageSha256: string, engineBuildId: string }>}
 */
export async function buildAndAttestEnginePackage({
  store,
  handoff,
  handoffRef,
  reconstructedSourceRoot1,
  reconstructedSourceRoot2,
  shell,
  runtimeResources,
  outDir,
  engineBuildId,
  operationId,
  operationIntentRef,
  previousRelease,
  prepareSuccessor,
  dependenciesSourceDir = null,
  testFaultHooks = false,
}) {
  // A successor carries the test-fault marker only inside a Node test process (second review, F).
  if (typeof testFaultHooks !== 'boolean') throw new P6BuildError('p6_build_invalid_hooks', 'The test-fault flag must be a boolean.');
  if (testFaultHooks && !process.env.NODE_TEST_CONTEXT) {
    throw new P6BuildError('p6_build_test_hooks_refused', 'A successor with test fault hooks is refused outside a Node test process.');
  }
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(engineBuildId || '')) {
    throw new P6BuildError('p6_build_invalid_id', 'A simple Engine build identity is required.');
  }
  if (!shell || shell.kind !== SHELL_RELEASE_KIND) {
    throw new P6BuildError('p6_build_invalid_shell', 'Engine package must be bound to a valid Shell release.');
  }
  if (typeof prepareSuccessor !== 'function') {
    throw new P6BuildError('p6_build_successor_unavailable', 'A successor profile must be prepared from the verified package identity.');
  }
  try { validateP5Contract('runningSourceRelease', previousRelease); }
  catch (error) { throw new P6BuildError('p6_build_previous_release_invalid', `The Host-attested predecessor release is invalid: ${error.message}`); }
  try {
    store.verifyRef(operationIntentRef);
    const operationIntent = store.readJson(operationIntentRef.artifactId);
    validateP5Contract('p6Operation', operationIntent);
    if (operationIntent.operationId !== operationId || operationIntent.engineBuildId !== engineBuildId
      || operationIntent.shellBuildId !== shell.shellBuildId || canonicalHash(operationIntent.previousRelease) !== canonicalHash(previousRelease)
      || canonicalHash(operationIntent.handoff) !== canonicalHash(handoffRef) || operationIntent.handoffId !== handoff.handoffId)
      throw new Error('operation intent identity differs from the build inputs');
  } catch (error) {
    throw new P6BuildError('p6_build_operation_intent_invalid', `The immutable P6 operation intent is invalid: ${error.message}`);
  }

  // Load source manifest
  let sourceManifest = handoff.sourceManifest;
  if (!sourceManifest?.entries && sourceManifest?.artifactId) {
    store.verifyRef(sourceManifest);
    sourceManifest = store.readJson(sourceManifest.artifactId);
  }

  const provenance = verifyP6SourceGitProvenance({ store, handoff, handoffRef });
  const { sourceCommit, sourceTree, candidateSourceDigest } = provenance;
  const inputClosure1 = await candidateBuildInputClosure({ store, handoff, sourceRoot: reconstructedSourceRoot1,
    sourceManifest, provenance, dependenciesSourceDir });
  const inputClosure2 = await candidateBuildInputClosure({ store, handoff, sourceRoot: reconstructedSourceRoot2,
    sourceManifest, provenance, dependenciesSourceDir });
  if (inputClosure1.buildInputDigest !== inputClosure2.buildInputDigest
    || canonicalHash(inputClosure1.buildInputClosure) !== canonicalHash(inputClosure2.buildInputClosure)) {
    throw new P6BuildError('p6_build_input_closure_not_reproducible', 'Independent source materializations produced different build-input closures.');
  }

  // Build 1: Primary destination
  const build1 = await buildSingleEnginePackage({
    reconstructedSourceRoot: reconstructedSourceRoot1,
    shell,
    runtimeResources,
    outDir,
    engineBuildId,
    sourceCommit,
    candidateSourceDigest,
    installedSourceDigest: provenance.sourceDigest,
    buildInputDigest: inputClosure1.buildInputDigest,
    dependencyDigest: inputClosure1.dependencyDigest,
    dependencyPackages: inputClosure1.dependencyPackages,
    dependencyFiles: inputClosure1.dependencyFiles,
    builderIdentity: inputClosure1.builderIdentity,
    sourceManifest,
    dependenciesSourceDir,
    testFaultHooks,
  });
  if (build1.sourceDigest !== provenance.sourceDigest) {
    throw new P6BuildError('p6_build_inventory_identity_mismatch', 'The Host source inventory digest differs from the verified P5 source entries.');
  }

  // Build 2: Reproduction directory
  const reproDir = mkdtempSync(join(tmpdir(), 'deszo-p6-repro-'));
  try {
    const build2 = await buildSingleEnginePackage({
      reconstructedSourceRoot: reconstructedSourceRoot2,
      shell,
      runtimeResources,
      outDir: reproDir,
      engineBuildId,
      sourceCommit,
      candidateSourceDigest,
      installedSourceDigest: provenance.sourceDigest,
      buildInputDigest: inputClosure2.buildInputDigest,
      dependencyDigest: inputClosure2.dependencyDigest,
      dependencyPackages: inputClosure2.dependencyPackages,
      dependencyFiles: inputClosure2.dependencyFiles,
      builderIdentity: inputClosure2.builderIdentity,
      sourceManifest,
      dependenciesSourceDir,
      testFaultHooks,
    });
    if (build2.sourceDigest !== provenance.sourceDigest) {
      throw new P6BuildError('p6_build_inventory_identity_mismatch', 'The reproduction source inventory digest differs from the verified P5 source entries.');
    }

    // Assert exact byte reproduction
    if (build1.packageSha256 !== build2.packageSha256) {
      throw new P6BuildError(
        'p6_build_not_reproducible',
        `Package digests differ between independent builds: ${build1.packageSha256} vs ${build2.packageSha256}`
      );
    }
    if (build1.manifestSha256 !== build2.manifestSha256) {
      throw new P6BuildError('p6_build_manifest_not_reproducible', 'build.json digests differ between independent builds.');
    }

    // Verify all files byte-for-byte
    const files1 = collectPlainFiles(outDir);
    const files2 = collectPlainFiles(reproDir);
    if (files1.length !== files2.length) {
      throw new P6BuildError('p6_build_file_count_mismatch', `File counts differ: ${files1.length} vs ${files2.length}`);
    }
    for (const f1 of files1) {
      const rel = portable(outDir, f1);
      const f2 = join(reproDir, ...rel.split('/'));
      if (!existsSync(f2) || !readFileSync(f1).equals(readFileSync(f2))) {
        throw new P6BuildError('p6_build_file_byte_mismatch', `File "${rel}" differs between independent builds.`);
      }
    }
  } finally {
    rmSync(reproDir, { recursive: true, force: true });
  }

  const successor = await prepareSuccessor({
    operationId,
    candidateSourceDigest,
    packageSha256: build1.packageSha256,
    sourceCommit,
    sourceTree,
    sourceDigest: provenance.sourceDigest,
    buildInputDigest: inputClosure1.buildInputDigest,
    buildInputClosure: inputClosure1.buildInputClosure,
    dependencyDigest: inputClosure1.dependencyDigest,
    dependencyPackages: inputClosure1.dependencyPackages,
    previousRelease,
  });
  const successorP5ProfileRef = successor?.successorProfileRef;
  if (!successorP5ProfileRef?.artifactId || !successorP5ProfileRef?.sha256) {
    throw new P6BuildError('p6_build_successor_invalid', 'Successor preparation did not return an immutable P5 profile reference.');
  }

  // Construct P6BuildReceipt/1
  const receipt = {
    schemaVersion: 1,
    kind: 'P6BuildReceipt',
    operationId,
    operationIntent: operationIntentRef,
    handoff: handoffRef,
    handoffId: handoff.handoffId,
    candidate: provenance.candidateRef,
    gitCandidate: provenance.gitCandidateRef,
    candidateSourceDigest,
    sourceCommit,
    sourceTree,
    previousRelease,
    engineBuildId,
    shellBuildId: shell.shellBuildId,
    buildInputDigest: inputClosure1.buildInputDigest,
    buildInputClosure: inputClosure1.buildInputClosure,
    builderIdentity: inputClosure1.builderIdentity,
    successorP5Profile: successorP5ProfileRef,
    installedSourceDigest: provenance.sourceDigest,
    manifestSha256: build1.manifestSha256,
    packageSha256: build1.packageSha256,
    files: build1.artifacts.map(a => ({ path: a.path, sha256: a.sha256, bytes: a.bytes })),
    reproducedPackageSha256: build1.packageSha256,
    reproducible: true,
    recordedAt: new Date().toISOString(),
  };

  validateP5Contract('p6BuildReceipt', receipt);
  const receiptArtifact = store.putJson(receipt);
  store.verifyRef({ artifactId: receiptArtifact.artifactId, sha256: receiptArtifact.sha256 });

  return {
    receipt,
    receiptArtifact,
    packageSha256: build1.packageSha256,
    engineBuildId,
    successor,
  };
}
