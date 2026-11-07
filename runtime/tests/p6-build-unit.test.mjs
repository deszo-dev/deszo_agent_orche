// P6-BUILD Layer 1: Unit and Contract Tests.
// Tests candidate scope classification, exact source reconstruction, P6BuildReceipt schema validation,
// successor profile preparation, and P5 continuation resolution.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Store } from '../core/store.mjs';
import { canonicalHash, sha256 } from '../core/canonical.mjs';
import { classifyP6CandidateScope, assertP6CandidateScope, P6ScopeError } from '../core/p6Scope.mjs';
import { reconstructCandidateSource, P6ReconstructionError } from '../core/p6Reconstruction.mjs';
import { prepareP6Successor } from '../core/p6Successor.mjs';
import { p6ContinuationReplayMatches, p6ContinuationReceiptReplayMatches, resolveP6Continuation } from '../core/p6Continuation.mjs';
import { executeP6Activation, P6ConsumerError } from '../core/p6Consumer.mjs';
import { persistP6SwitchAdmission } from '../core/p6Consumer.mjs';
import { requestEngineSwitch, createSwitchQuiescence } from '../host/p6Switch.mjs';
import { p5SourceDigest, p5BaselineId, validateP5Contract } from '../core/protectedSelfRepair.mjs';
import { buildInputsDigest, securityClosure } from '../host/installedBuilds.mjs';
import { resolveTrustedEsbuild } from '../core/p6Builder.mjs';
import { materializeVerifiedP6GitObjects } from '../core/p6GitObjectSource.mjs';
import { fetchP5EnrolledGitRefs, verifyP5GitHistoryComplete } from '../core/p5GitCandidate.mjs';

function freshStore(prefix = 'p6-unit-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const store = new Store(join(dir, 'state.sqlite'));
  return { store, dir, cleanup: () => { try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

function actualGitPath() {
  const listed = execFileSync('where.exe', ['git.exe'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  const candidates = listed.flatMap(value => [value, resolve(join(value.replace(/[\\/]git\.exe$/i, ''), '..', 'mingw64', 'bin', 'git.exe'))]);
  const result = candidates.find(value => /[\\/]mingw64[\\/]bin[\\/]git\.exe$/i.test(value) && existsSync(value));
  assert.ok(result, 'the Git object test requires the installed Git for Windows executable');
  return result;
}

function gitRunner(gitTool, root) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('GIT_')) delete env[key];
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_TERMINAL_PROMPT: '0' });
  return (args, options = {}) => execFileSync(gitTool, ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf',
    '-c', 'core.hooksPath=NUL', '-c', 'user.name=P5 Fixture', '-c', 'user.email=p5@example.invalid', '-C', root, ...args],
  { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 30_000, ...options }).toString().trim();
}

test('P6-BUILD Scope: classifies valid Engine-only changes', () => {
  const validManifest = {
    additions: ['runtime/core/newHelper.mjs'],
    modifications: ['runtime/core/engine.mjs', 'runtime/lock.mjs'],
    deletions: [],
  };
  const verdict = classifyP6CandidateScope(validManifest);
  assert.equal(verdict.supported, true);
  assert.equal(verdict.changes.length, 3);
  assert.doesNotThrow(() => assertP6CandidateScope(validManifest));
});

test('P6-BUILD Scope: strictly rejects embedded UI changes', () => {
  const uiManifest1 = { additions: ['src/components/NewWidget.vue'], modifications: [], deletions: [] };
  const verdict1 = classifyP6CandidateScope(uiManifest1);
  assert.equal(verdict1.supported, false);
  assert.equal(verdict1.reason, 'p6_scope_ui_modification');
  assert.throws(() => assertP6CandidateScope(uiManifest1), P6ScopeError);

  const uiManifest2 = { additions: [], modifications: ['index.html'], deletions: [] };
  const verdict2 = classifyP6CandidateScope(uiManifest2);
  assert.equal(verdict2.supported, false);
  assert.equal(verdict2.reason, 'p6_scope_ui_modification');
});

test('P6-BUILD Scope: strictly rejects Rust Lifecycle Host / Tauri Shell changes', () => {
  const hostManifest1 = { additions: [], modifications: ['lifecycle-host/src/main.rs'], deletions: [] };
  const verdict1 = classifyP6CandidateScope(hostManifest1);
  assert.equal(verdict1.supported, false);
  assert.equal(verdict1.reason, 'p6_scope_host_modification');

  const hostManifest2 = { additions: ['src-tauri/src/lib.rs'], modifications: [], deletions: [] };
  const verdict2 = classifyP6CandidateScope(hostManifest2);
  assert.equal(verdict2.supported, false);
  assert.equal(verdict2.reason, 'p6_scope_host_modification');
});

test('P6-BUILD Scope: strictly rejects SQLite migrations and migration engine', () => {
  const migManifest1 = { additions: ['docs/storage/m0006.sql'], modifications: [], deletions: [] };
  const verdict1 = classifyP6CandidateScope(migManifest1);
  assert.equal(verdict1.supported, false);
  assert.equal(verdict1.reason, 'p6_scope_migration_attempt');

  const migManifest2 = { additions: [], modifications: ['runtime/core/migrations.mjs'], deletions: [] };
  const verdict2 = classifyP6CandidateScope(migManifest2);
  assert.equal(verdict2.supported, false);
  assert.equal(verdict2.reason, 'p6_scope_migration_attempt');
});

test('P6-BUILD Scope: strictly rejects frozen shell resources and bridge', () => {
  const shellManifest1 = { additions: [], modifications: ['runtime/bridge.mjs'], deletions: [] };
  const verdict1 = classifyP6CandidateScope(shellManifest1);
  assert.equal(verdict1.supported, false);
  assert.equal(verdict1.reason, 'p6_scope_shell_resource_modification');

  const shellManifest2 = { additions: [], modifications: ['runtime/deszo-launch-shim.exe'], deletions: [] };
  const verdict2 = classifyP6CandidateScope(shellManifest2);
  assert.equal(verdict2.supported, false);
  assert.equal(verdict2.reason, 'p6_scope_shell_resource_modification');

  const shellManifest3 = { additions: [], modifications: ['runtime/host/runtimeRelease.mjs'], deletions: [] };
  const verdict3 = classifyP6CandidateScope(shellManifest3);
  assert.equal(verdict3.supported, false);
  assert.equal(verdict3.reason, 'p6_scope_shell_resource_modification');
});

test('P6-BUILD Scope: strictly rejects toolchain, build scripts and native files', () => {
  for (const file of ['package.json', 'package-lock.json', 'Cargo.toml', 'Cargo.lock', 'tsconfig.json']) {
    const verdict = classifyP6CandidateScope({ additions: [], modifications: [file], deletions: [] });
    assert.equal(verdict.supported, false, file);
    assert.equal(verdict.reason, 'p6_scope_toolchain_modification', file);
  }

  const scriptManifest = { additions: [], modifications: ['scripts/desktop-release.mjs'], deletions: [] };
  assert.equal(classifyP6CandidateScope(scriptManifest).reason, 'p6_scope_build_script_modification');

  const nativeManifest = { additions: ['scripts/run.ps1'], modifications: [], deletions: [] };
  assert.equal(classifyP6CandidateScope(nativeManifest).reason, 'p6_scope_build_script_modification');
});

test('P6-BUILD Scope: rejects MCP bridge behavior including case variants', () => {
  for (const path of ['mcp/bridge.mjs', 'MCP/providers/adapter.mjs']) {
    const verdict = classifyP6CandidateScope({ additions: [], modifications: [path], deletions: [] });
    assert.equal(verdict.supported, false, path);
    assert.equal(verdict.reason, 'p6_scope_mcp_bridge_modification', path);
  }
});

test('P6-BUILD Builder: inherited environment cannot enable packaged test switch routes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p6-fault-policy-'));
  const moduleDir = join(root, 'p5', 'core');
  mkdirSync(moduleDir, { recursive: true });
  writeFileSync(join(root, 'build.json'), '{}\n');
  const modulePath = join(moduleDir, 'testFaultPolicy.mjs');
  writeFileSync(modulePath, readFileSync(new URL('../core/testFaultPolicy.mjs', import.meta.url)));
  const oldValue = process.env.DESZO_TEST_FAULT_HOOKS;
  process.env.DESZO_TEST_FAULT_HOOKS = '1';
  try {
    const moduleUrl = pathToFileURL(modulePath).href;
    const policy = await import(`${moduleUrl}?case=${randomUUID()}`);
    assert.equal(policy.testFaultHooksEnabled(moduleUrl), false, 'the production package manifest wins over inherited environment');
    const consumerSource = readFileSync(new URL('../core/p6Consumer.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(consumerSource, /process\.env\.DESZO_TEST_FAULT_HOOKS/,
      'the installed consumer does not promote environment state into a test-marked successor package');
  } finally {
    if (oldValue === undefined) delete process.env.DESZO_TEST_FAULT_HOOKS;
    else process.env.DESZO_TEST_FAULT_HOOKS = oldValue;
    rmSync(root, { recursive: true, force: true });
  }
});

test('P6-BUILD Builder: esbuild resolves from the exact installed Engine dependency root', () => {
  const root = mkdtempSync(join(tmpdir(), 'p6-builder-resolution-'));
  const engineRoot = join(root, 'release', 'p5');
  const installedPackage = join(engineRoot, 'node_modules', 'esbuild');
  const ambientPackage = join(root, 'node_modules', 'esbuild');
  mkdirSync(installedPackage, { recursive: true });
  mkdirSync(ambientPackage, { recursive: true });
  writeFileSync(join(engineRoot, 'package.json'), '{}\n');
  writeFileSync(join(installedPackage, 'package.json'), JSON.stringify({ name: 'esbuild', version: 'attested', main: 'index.cjs' }));
  writeFileSync(join(installedPackage, 'index.cjs'), "exports.build = () => 'attested';\n");
  writeFileSync(join(ambientPackage, 'package.json'), JSON.stringify({ name: 'esbuild', version: 'ambient', main: 'index.cjs' }));
  writeFileSync(join(ambientPackage, 'index.cjs'), "exports.build = () => 'ambient';\n");
  try {
    const resolved = resolveTrustedEsbuild(engineRoot);
    assert.equal(resolved.manifestPath, join(installedPackage, 'package.json'));
    assert.equal(resolved.build(), 'attested', 'an ancestor esbuild package cannot substitute for the installed one');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('P6-BUILD Builder: build-input identity binds source, imports, dependencies and pinned Git tool', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p6-input-closure-'));
  const sourceRoot = join(root, 'source');
  const dependenciesRoot = join(root, 'fixed-dependencies');
  const nodeModules = join(dependenciesRoot, 'node_modules', 'fixture-dep');
  mkdirSync(join(sourceRoot, 'runtime', 'core'), { recursive: true });
  mkdirSync(nodeModules, { recursive: true });
  writeFileSync(join(sourceRoot, 'runtime', 'runner.mjs'), "import './core/control.mjs';\n");
  writeFileSync(join(sourceRoot, 'runtime', 'core', 'control.mjs'), "import 'fixture-dep';\nexport const value = 1;\n");
  writeFileSync(join(nodeModules, 'index.js'), 'export const dependency = 1;\n');
  const gitToolPath = join(root, 'git.exe');
  const alternateGitToolPath = join(root, 'git-alias.exe');
  writeFileSync(gitToolPath, 'pinned git');
  writeFileSync(alternateGitToolPath, 'pinned git');
  const commit = 'a'.repeat(40);
  const names = ['runtime/runner.mjs', 'runtime/core/control.mjs'];
  const makeReader = gitTool => async treeRoot => ({ sourceCommit: commit, names, commonDirectory: treeRoot, gitTool });
  const digest = async gitTool => buildInputsDigest(await securityClosure(sourceRoot, gitTool, makeReader(gitTool), dependenciesRoot), commit);
  try {
    const gitTool = { path: gitToolPath, sha256: sha256(readFileSync(gitToolPath)) };
    const baseline = await digest(gitTool);
    writeFileSync(join(sourceRoot, 'runtime', 'core', 'control.mjs'), "import 'fixture-dep';\nexport const value = 2;\n");
    const sourceChanged = await digest(gitTool);
    assert.notEqual(sourceChanged, baseline, 'source and control-import closure changes alter the input identity');
    writeFileSync(join(nodeModules, 'index.js'), 'export const dependency = 2;\n');
    const dependencyChanged = await digest(gitTool);
    assert.notEqual(dependencyChanged, sourceChanged, 'packaged dependency changes alter the input identity');
    const alternateGitTool = { path: alternateGitToolPath, sha256: sha256(readFileSync(alternateGitToolPath)) };
    const toolChanged = await digest(alternateGitTool);
    assert.notEqual(toolChanged, dependencyChanged, 'the pinned Git tool path is part of the input identity');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('P6-BUILD Reconstruction: exact reconstruction from immutable Store', () => {
  const { store, cleanup } = freshStore();
  const targetDir = mkdtempSync(join(tmpdir(), 'p6-reconstruct-'));
  try {
    const file1Bytes = Buffer.from('console.log("file1");\n', 'utf8');
    const file2Bytes = Buffer.from('export const foo = 42;\n', 'utf8');
    const art1 = store.putBytes(file1Bytes, 'text/javascript');
    const art2 = store.putBytes(file2Bytes, 'text/javascript');

    const entries = [
      { path: 'runtime/core/bar.mjs', type: 'regular', executable: false, byteSize: file2Bytes.length, sha256: sha256(file2Bytes), artifact: { artifactId: art2.artifactId, sha256: art2.sha256 } },
      { path: 'runtime/core/foo.mjs', type: 'regular', executable: false, byteSize: file1Bytes.length, sha256: sha256(file1Bytes), artifact: { artifactId: art1.artifactId, sha256: art1.sha256 } },
    ];
    const rawEntries = entries.map(({ artifact: _a, ...e }) => e);
    const sourceDigest = p5SourceDigest(rawEntries);
    const sourceManifest = { schemaVersion: 1, kind: 'ProtectedSelfRepairSourceManifest', sourceDigest, entries };
    const sourceManifestArt = store.putJson(sourceManifest);

    const handoff = {
      schemaVersion: 1,
      kind: 'ProtectedSelfRepairHandoff',
      handoffId: 'a'.repeat(64),
      candidateId: 'b'.repeat(64),
      candidateSourceDigest: sourceDigest,
      sourceManifest: { artifactId: sourceManifestArt.artifactId, sha256: sourceManifestArt.sha256 },
    };

    const result = reconstructCandidateSource({ store, handoff, targetDir });
    assert.equal(result.reconstructedFiles, 2);
    assert.equal(result.sourceDigest, sourceDigest);

    assert.equal(readFileSync(join(targetDir, 'runtime', 'core', 'foo.mjs'), 'utf8'), 'console.log("file1");\n');
    assert.equal(readFileSync(join(targetDir, 'runtime', 'core', 'bar.mjs'), 'utf8'), 'export const foo = 42;\n');
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
    cleanup();
  }
});

test('P6-BUILD Reconstruction: fails closed on corrupted bytes, collisions and unsafe paths', () => {
  const { store, cleanup } = freshStore();
  const targetDir = mkdtempSync(join(tmpdir(), 'p6-reconstruct-bad-'));
  try {
    const goodBytes = Buffer.from('hello', 'utf8');
    const art = store.putBytes(goodBytes, 'text/plain');

    // Byte size mismatch
    const badEntries = [{ path: 'runtime/core/bad.mjs', type: 'regular', executable: false, byteSize: 999, sha256: sha256(goodBytes), artifact: { artifactId: art.artifactId, sha256: art.sha256 } }];
    const badRaw = badEntries.map(({ artifact: _a, ...e }) => e);
    const badManifest = { schemaVersion: 1, kind: 'ProtectedSelfRepairSourceManifest', sourceDigest: 'b'.repeat(64), entries: badEntries };
    const badArt = store.putJson(badManifest);
    const badHandoff = {
      schemaVersion: 1,
      kind: 'ProtectedSelfRepairHandoff',
      handoffId: '1'.repeat(64),
      sourceManifest: { artifactId: badArt.artifactId, sha256: badArt.sha256 },
      candidateSourceDigest: badManifest.sourceDigest,
    };
    assert.throws(() => reconstructCandidateSource({ store, handoff: badHandoff, targetDir }), P6ReconstructionError);

    // Reserved Windows device name
    const deviceEntries = [{ path: 'runtime/core/nul.mjs', type: 'regular', executable: false, byteSize: goodBytes.length, sha256: sha256(goodBytes), artifact: { artifactId: art.artifactId, sha256: art.sha256 } }];
    const deviceManifest = { schemaVersion: 1, kind: 'ProtectedSelfRepairSourceManifest', sourceDigest: 'd'.repeat(64), entries: deviceEntries };
    const deviceArt = store.putJson(deviceManifest);
    const deviceHandoff = {
      schemaVersion: 1,
      kind: 'ProtectedSelfRepairHandoff',
      handoffId: '2'.repeat(64),
      sourceManifest: { artifactId: deviceArt.artifactId, sha256: deviceArt.sha256 },
      candidateSourceDigest: deviceManifest.sourceDigest,
    };
    assert.throws(() => reconstructCandidateSource({ store, handoff: deviceHandoff, targetDir }), P6ReconstructionError);

    // Case folding collision
    const colEntries = [
      { path: 'runtime/core/bar.mjs', type: 'regular', executable: false, byteSize: goodBytes.length, sha256: sha256(goodBytes), artifact: { artifactId: art.artifactId, sha256: art.sha256 } },
      { path: 'runtime/core/BAR.mjs', type: 'regular', executable: false, byteSize: goodBytes.length, sha256: sha256(goodBytes), artifact: { artifactId: art.artifactId, sha256: art.sha256 } },
    ];
    const colManifest = { schemaVersion: 1, kind: 'ProtectedSelfRepairSourceManifest', sourceDigest: 'c'.repeat(64), entries: colEntries };
    const colArt = store.putJson(colManifest);
    const collisionHandoff = {
      schemaVersion: 1,
      kind: 'ProtectedSelfRepairHandoff',
      handoffId: '3'.repeat(64),
      sourceManifest: { artifactId: colArt.artifactId, sha256: colArt.sha256 },
      candidateSourceDigest: colManifest.sourceDigest,
    };
    assert.throws(() => reconstructCandidateSource({ store, handoff: collisionHandoff, targetDir }), P6ReconstructionError);
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
    cleanup();
  }
});

test('P6-BUILD Git source: materializes the exact accepted commit, tree, blobs and modes', () => {
  const gitTool = actualGitPath();
  const root = mkdtempSync(join(tmpdir(), 'p6-git-objects-'));
  const source = join(root, 'source');
  const bare = join(root, 'materialized.git');
  mkdirSync(join(source, 'runtime', 'bin'), { recursive: true });
  try {
    const sourceGit = gitRunner(gitTool, source);
    sourceGit(['init', '--quiet', '--object-format=sha1']);
    const ordinary = Buffer.from('export const value = 2;\n');
    const executable = Buffer.from('#!/usr/bin/env node\n');
    writeFileSync(join(source, 'runtime', 'value.mjs'), 'export const value = 1;\n');
    writeFileSync(join(source, 'runtime', 'bin', 'tool.mjs'), '#!/usr/bin/env node\n');
    sourceGit(['add', '--all']);
    sourceGit(['update-index', '--chmod=+x', '--', 'runtime/bin/tool.mjs']);
    sourceGit(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'baseline']);
    const parentCommit = sourceGit(['rev-parse', 'HEAD']);
    writeFileSync(join(source, 'runtime', 'value.mjs'), ordinary);
    writeFileSync(join(source, 'runtime', 'bin', 'tool.mjs'), executable);
    sourceGit(['add', '--all']);
    sourceGit(['update-index', '--chmod=+x', '--', 'runtime/bin/tool.mjs']);
    const sourceTree = sourceGit(['write-tree']);
    const timestamp = Math.floor(Date.now() / 1000);
    const candidateId = 'a'.repeat(64);
    const commitBytes = Buffer.from([`tree ${sourceTree}`, `parent ${parentCommit}`,
      `author Deszo P5 Engine <deszo-p5-engine@invalid> ${timestamp} +0000`,
      `committer Deszo P5 Engine <deszo-p5-engine@invalid> ${timestamp} +0000`, '', `P5 candidate ${candidateId}`, ''].join('\n'));
    const candidateCommit = sourceGit(['commit-tree', sourceTree, '-p', parentCommit, '-m', `P5 candidate ${candidateId}`], {
      env: { ...process.env, GIT_AUTHOR_NAME: 'Deszo P5 Engine', GIT_AUTHOR_EMAIL: 'deszo-p5-engine@invalid',
        GIT_COMMITTER_NAME: 'Deszo P5 Engine', GIT_COMMITTER_EMAIL: 'deszo-p5-engine@invalid',
        GIT_AUTHOR_DATE: `@${timestamp} +0000`, GIT_COMMITTER_DATE: `@${timestamp} +0000` },
    });
    const objectId = bytes => sourceGit(['hash-object', '--stdin'], { input: bytes });
    const provenance = { sourceCommit: candidateCommit, sourceTree, objectFormat: 'sha1', parentCommit, commitBytes,
      gitObjects: [
        { path: 'runtime/value.mjs', executable: false, blobId: objectId(ordinary), bytes: ordinary },
        { path: 'runtime/bin/tool.mjs', executable: true, blobId: objectId(executable), bytes: executable },
      ] };
    const initBare = path => {
      mkdirSync(path, { recursive: true });
      return gitRunner(gitTool, path)(['init', '--quiet', '--bare', '--object-format=sha1']);
    };
    initBare(bare);
    const written = materializeVerifiedP6GitObjects({ gitTool: { path: gitTool }, repositoryRoot: bare, provenance });
    assert.deepEqual(written, { sourceCommit: candidateCommit, sourceTree, objectCount: 6 });
    const bareGit = gitRunner(gitTool, bare);
    assert.equal(bareGit(['cat-file', '-t', candidateCommit]), 'commit');
    assert.equal(bareGit(['rev-parse', `${candidateCommit}^{tree}`]), sourceTree);
    assert.equal(bareGit(['ls-tree', '-r', candidateCommit, '--', 'runtime/bin/tool.mjs']).split(' ')[0], '100755');

    const remoteRoot = join(root, 'enrolled-origin.git'); initBare(remoteRoot);
    sourceGit(['push', '--quiet', pathToFileURL(remoteRoot).href, `${parentCommit}:refs/heads/main`]);
    const unpublishedRoot = join(root, 'unpublished-b.git'); initBare(unpublishedRoot);
    materializeVerifiedP6GitObjects({ gitTool: { path: gitTool }, repositoryRoot: unpublishedRoot, provenance });
    assert.throws(() => verifyP5GitHistoryComplete({ gitTool: { path: gitTool }, repositoryRoot: unpublishedRoot, sourceCommit: candidateCommit }),
      error => error.code === 'p5_git_source_ancestry_incomplete', 'the local B commit alone is insufficient while its parent is absent');
    const gitSource = { schemaVersion: 1, kind: 'ProtectedSelfRepairGitSource', policy: 'managed-clone-v1', sourceRepositoryId: 'p6-unit-origin',
      remote: { remoteId: 'p6-unit-remote', url: pathToFileURL(remoteRoot).href, protocol: 'file' }, fetchRefs: ['refs/heads/main'],
      sourceCommit: parentCommit, sourceTree: sourceGit(['rev-parse', `${parentCommit}^{tree}`]), objectFormat: 'sha1',
      releaseSourceDigest: 'd'.repeat(64), credentialPolicy: 'none',
      publication: { schemaVersion: 1, kind: 'ProtectedSelfRepairGitPublicationPolicy', enabled: false, remoteId: 'p6-unit-remote',
        refNamespace: 'refs/heads/self-repair/', requireExpectedRemoteState: true, allowMerge: false } };
    assert.deepEqual(fetchP5EnrolledGitRefs({ gitTool: { path: gitTool }, repositoryRoot: unpublishedRoot, gitSource }), ['refs/heads/main']);
    assert.equal(verifyP5GitHistoryComplete({ gitTool: { path: gitTool }, repositoryRoot: unpublishedRoot, sourceCommit: candidateCommit }).historyLength, 2,
      'exact local B plus enrolled, advertised A source completes the ancestry without publishing B');
    assert.equal(gitRunner(gitTool, remoteRoot)(['ls-tree', '--name-only', 'refs/heads/main', '--', 'runtime/value.mjs']), 'runtime/value.mjs');
    assert.deepEqual(gitRunner(gitTool, unpublishedRoot)(['for-each-ref', '--format=%(refname)']).split(/\r?\n/).filter(Boolean), [],
      'fetching enrolled source refs writes no branch or candidate-controlled ref');

    const wrongBlobRoot = join(root, 'wrong-blob.git'); initBare(wrongBlobRoot);
    const wrongBlob = { ...provenance, gitObjects: provenance.gitObjects.map((item, index) => index === 0
      ? { ...item, bytes: Buffer.from('different bytes\n') } : item) };
    assert.throws(() => materializeVerifiedP6GitObjects({ gitTool: { path: gitTool }, repositoryRoot: wrongBlobRoot, provenance: wrongBlob }),
      error => error.code === 'p5_git_local_source_invalid');

    const wrongModeRoot = join(root, 'wrong-mode.git'); initBare(wrongModeRoot);
    const wrongMode = { ...provenance, gitObjects: provenance.gitObjects.map(item => ({ ...item, executable: false })) };
    assert.throws(() => materializeVerifiedP6GitObjects({ gitTool: { path: gitTool }, repositoryRoot: wrongModeRoot, provenance: wrongMode }),
      error => error.code === 'p5_git_local_source_invalid');

    const wrongTreeRoot = join(root, 'wrong-tree.git'); initBare(wrongTreeRoot);
    assert.throws(() => materializeVerifiedP6GitObjects({ gitTool: { path: gitTool }, repositoryRoot: wrongTreeRoot,
      provenance: { ...provenance, sourceTree: 'f'.repeat(40) } }), error => error.code === 'p5_git_local_source_invalid');

    const wrongCommitRoot = join(root, 'wrong-commit.git'); initBare(wrongCommitRoot);
    assert.throws(() => materializeVerifiedP6GitObjects({ gitTool: { path: gitTool }, repositoryRoot: wrongCommitRoot,
      provenance: { ...provenance, sourceCommit: 'e'.repeat(40) } }), error => error.code === 'p5_git_local_source_invalid');

    const interruptedRoot = join(root, 'interrupted.git'); initBare(interruptedRoot);
    assert.throws(() => materializeVerifiedP6GitObjects({ gitTool: { path: gitTool }, repositoryRoot: interruptedRoot,
      provenance: { ...provenance, gitObjects: provenance.gitObjects.slice(0, 1) } }), error => error.code === 'p5_git_local_source_invalid');
    const recovered = materializeVerifiedP6GitObjects({ gitTool: { path: gitTool }, repositoryRoot: interruptedRoot, provenance });
    assert.equal(recovered.sourceCommit, candidateCommit, 'a partial object write is safely completed from the immutable source bytes');

    const restartRoot = join(root, 'restart.git'); initBare(restartRoot);
    assert.equal(materializeVerifiedP6GitObjects({ gitTool: { path: gitTool }, repositoryRoot: restartRoot, provenance }).sourceCommit,
      candidateCommit, 'an absent local object cache is reconstructed after restart');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('P6-BUILD Contract: P6BuildReceipt schema validation', () => {
  const builderIdentity = { node: process.version, esbuild: '0.25.0',
    nodeExecutable: { path: process.execPath, sha256: '6'.repeat(64) },
    esbuildPackage: { path: 'C:\\test\\node_modules\\esbuild\\package.json', sha256: '7'.repeat(64) } };
  const receipt = {
    schemaVersion: 1,
    kind: 'P6BuildReceipt',
    operationId: randomUUID(),
    operationIntent: { artifactId: randomUUID(), sha256: '0'.repeat(64) },
    handoff: { artifactId: randomUUID(), sha256: 'a'.repeat(64) },
    handoffId: 'a'.repeat(64),
    candidate: { artifactId: randomUUID(), sha256: 'b'.repeat(64) },
    gitCandidate: { artifactId: randomUUID(), sha256: '9'.repeat(64) },
    candidateSourceDigest: 'c'.repeat(64),
    sourceCommit: '1234567890abcdef1234567890abcdef12345678',
    sourceTree: 'abcdef1234567890abcdef1234567890abcdef12',
    previousRelease: {
      schemaVersion: 1, kind: 'ProtectedSelfRepairRunningSourceRelease', installationId: 'a'.repeat(32),
      buildId: 'engine-a', bootstrap: 'tauri', packageSha256: 'a'.repeat(64),
      sourceCommit: '0000000000000000000000000000000000000000', sourceDigest: 'd'.repeat(64), inputsDigest: 'd'.repeat(64),
    },
    engineBuildId: 'engine-b',
    shellBuildId: 'shell-g0',
    buildInputDigest: 'e'.repeat(64),
    buildInputClosure: { schemaVersion: 1, kind: 'P6BuildInputClosure', sourceInventoryDigest: '8'.repeat(64),
      authorityClosureDigest: '9'.repeat(64), dependencyDigest: 'a'.repeat(64), hostInputsDigest: 'b'.repeat(64),
      gitTool: { path: 'C:\\Program Files\\Git\\bin\\git.exe', sha256: 'c'.repeat(64) },
      builderIdentity, dependencyPackages: ['esbuild'] },
    builderIdentity,
    successorP5Profile: { artifactId: randomUUID(), sha256: 'f'.repeat(64) },
    installedSourceDigest: '8'.repeat(64),
    manifestSha256: '1'.repeat(64),
    packageSha256: '2'.repeat(64),
    files: [{ path: 'runtime/runner.mjs', sha256: '3'.repeat(64), bytes: 1024 }],
    reproducedPackageSha256: '2'.repeat(64),
    reproducible: true,
    recordedAt: new Date().toISOString(),
  };

  assert.doesNotThrow(() => validateP5Contract('p6BuildReceipt', receipt));
});

test('P6-BUILD Contract: a Gate dependency-closure record admits the P6 Engine bootstrap', () => {
  // The trusted Gate records the Host-attested running release; in a P6 installation that release is an `engine` package.
  const record = { schemaVersion: 1, kind: 'ProtectedSelfRepairVerificationDependencyClosure', candidateId: 'a'.repeat(64),
    gateAttemptId: randomUUID(), installedRelease: { buildId: 'engine-0123456789ab', bootstrap: 'engine', packageSha256: '1'.repeat(64),
      inputsDigest: '2'.repeat(64), artifactList: 'p5-support.json', artifactListSha256: '3'.repeat(64) },
    resolutionRoot: 'candidate-execution-tree/node_modules', packages: ['ajv'],
    files: [{ path: 'node_modules/ajv/package.json', sha256: '4'.repeat(64), byteSize: 10 }], closureDigest: '5'.repeat(64) };
  assert.doesNotThrow(() => validateP5Contract('dependencyClosure', record));
  assert.throws(() => validateP5Contract('dependencyClosure', { ...record, installedRelease: { ...record.installedRelease, bootstrap: 'shell' } }));
});

test('P6-BUILD Continuation: requires the exact Host-committed switch operation', () => {
  const { store, cleanup } = freshStore();
  try {
    const operationId = randomUUID();
    const installationId = 'a'.repeat(32);
    const rootRelease = { schemaVersion: 1, kind: 'ProtectedSelfRepairRunningSourceRelease', installationId,
      buildId: 'engine-a', bootstrap: 'tauri', packageSha256: '1'.repeat(64), sourceCommit: '2'.repeat(40),
      sourceDigest: '3'.repeat(64), inputsDigest: '3'.repeat(64) };
    const rootReleaseArt = store.putJson(rootRelease);
    const rootEnrollment = { runningSourceRelease: { artifactId: rootReleaseArt.artifactId, sha256: rootReleaseArt.sha256 } };
    const sourceCommit = '5'.repeat(40);
    const builderIdentity = { node: process.version, esbuild: '0.25.0',
      nodeExecutable: { path: process.execPath, sha256: '1'.repeat(64) },
      esbuildPackage: { path: 'C:\\test\\node_modules\\esbuild\\package.json', sha256: '2'.repeat(64) } };
    const buildInputClosure = { schemaVersion: 1, kind: 'P6BuildInputClosure', sourceInventoryDigest: '6'.repeat(64),
      authorityClosureDigest: 'a'.repeat(64), dependencyDigest: 'b'.repeat(64),
      gitTool: { path: 'C:\\Program Files\\Git\\bin\\git.exe', sha256: 'c'.repeat(64) },
      dependencyPackages: ['esbuild'], builderIdentity };
    buildInputClosure.hostInputsDigest = canonicalHash({ sourceCommit, sourceDigest: buildInputClosure.sourceInventoryDigest,
      authorityClosureDigest: buildInputClosure.authorityClosureDigest, dependencyDigest: buildInputClosure.dependencyDigest,
      gitTool: buildInputClosure.gitTool });
    const buildInputDigest = canonicalHash({ hostInputsDigest: buildInputClosure.hostInputsDigest, builderIdentity });
    const runningRelease = { schemaVersion: 1, kind: 'ProtectedSelfRepairRunningSourceRelease', installationId,
      buildId: 'engine-b', bootstrap: 'engine', committedOperationId: operationId,
      packageSha256: '4'.repeat(64), sourceCommit, sourceDigest: '6'.repeat(64), inputsDigest: buildInputDigest };
    const receipt = { schemaVersion: 1, kind: 'P6BuildReceipt', operationId,
      operationIntent: { artifactId: randomUUID(), sha256: '8'.repeat(64) },
      handoff: { artifactId: randomUUID(), sha256: '9'.repeat(64) }, handoffId: '9'.repeat(64),
      candidate: { artifactId: randomUUID(), sha256: 'a'.repeat(64) }, gitCandidate: { artifactId: randomUUID(), sha256: 'b'.repeat(64) },
      candidateSourceDigest: '7'.repeat(64), sourceCommit, sourceTree: 'c'.repeat(40),
      previousRelease: rootRelease, installedSourceDigest: '6'.repeat(64), engineBuildId: 'engine-b', shellBuildId: 'shell-g0',
      buildInputDigest, buildInputClosure, builderIdentity,
      successorP5Profile: { artifactId: randomUUID(), sha256: 'd'.repeat(64) },
      manifestSha256: 'e'.repeat(64), packageSha256: runningRelease.packageSha256, files: [],
      reproducedPackageSha256: runningRelease.packageSha256, reproducible: true, recordedAt: new Date().toISOString() };
    validateP5Contract('p6BuildReceipt', receipt);
    const receiptArt = store.putJson(receipt);
    store.run('INSERT INTO command_receipts(request_id, command, payload_sha256, response_artifact_id, created_at) VALUES (?, ?, ?, ?, ?)',
      `p6-build-${receipt.handoffId}`, 'p6.build', receipt.packageSha256, receiptArt.artifactId, new Date().toISOString());
    assert.throws(() => resolveP6Continuation({ store, rootEnrollment, runningSourceRelease: runningRelease, installationId }),
      error => error.code === 'p6_continuation_host_status_mismatch');
    assert.throws(() => resolveP6Continuation({ store, rootEnrollment, runningSourceRelease: runningRelease, installationId,
      hostSwitchStatus: { operationId: randomUUID(), phase: 'verified', fromEngineBuildId: 'engine-a', toEngineBuildId: 'engine-b',
        shellBuildId: 'shell-g0', packageSha256: runningRelease.packageSha256 } }),
      error => error.code === 'p6_continuation_host_status_mismatch');
  } finally { cleanup(); }
});

test('P6-BUILD Continuation: accepts only the Host committed-to-verified phase advance on replay', () => {
  const identity = { operationId: randomUUID(), packageSha256: 'a'.repeat(64), successorRelease: { artifactId: randomUUID(), sha256: 'b'.repeat(64) },
    hostSwitchStatus: { operationId: randomUUID(), phase: 'committed', fromEngineBuildId: 'engine-a', toEngineBuildId: 'engine-b',
      shellBuildId: 'shell-g0', packageSha256: 'c'.repeat(64) } };
  const verified = { ...identity, hostSwitchStatus: { ...identity.hostSwitchStatus, phase: 'verified' } };
  assert.equal(p6ContinuationReplayMatches(identity, verified), true,
    'the immutable receipt remains valid when the same Host operation records its later verified phase');
  assert.equal(p6ContinuationReplayMatches(verified, identity), false, 'Host phase regression is refused');
  assert.equal(p6ContinuationReplayMatches(identity, { ...verified, packageSha256: 'd'.repeat(64) }), false,
    'a changed package identity is refused');
  assert.equal(p6ContinuationReplayMatches(identity, { ...verified, hostSwitchStatus: { ...verified.hostSwitchStatus,
    operationId: randomUUID() } }), false, 'a different Host operation is refused');
  const concurrentlyRecorded = { ...identity, recordedAt: new Date().toISOString() };
  assert.equal(p6ContinuationReceiptReplayMatches(concurrentlyRecorded, verified), true,
    'a concurrent first writer with committed phase and a different timestamp remains a valid immutable replay');
  assert.equal(p6ContinuationReceiptReplayMatches({ ...verified, recordedAt: new Date().toISOString() }, identity), false,
    'the durable receipt cannot regress from verified to committed');
});
test('P6-BUILD Consumer: aborts activation when Parent run is stopped or cancelled', async () => {
  const { store, cleanup } = freshStore();
  try {
    const parentRunId = randomUUID();
    const repairRunId = randomUUID();
    const linkId = randomUUID();
    const incidentId = randomUUID();

    store.run('INSERT INTO workspaces(id, cwd, cwd_identity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', 'ws', 'cwd', '0'.repeat(64), new Date().toISOString(), new Date().toISOString());
    const wfArt = store.putJson({ schemaVersion: 1, kind: 'WorkflowSnapshot', workflowId: 'wf', version: 1, capabilities: [] });
    store.run('INSERT INTO workflows(id, kind, snapshot_artifact_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', 'wf', 'system', wfArt.artifactId, new Date().toISOString(), new Date().toISOString());
    const settingsArt = store.putJson({ schemaVersion: 1, kind: 'Settings' });

    store.run(
      'INSERT INTO runs(id, workflow_id, workspace_id, workflow_snapshot_artifact_id, settings_artifact_id, execution_hash, state, last_sequence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      parentRunId, 'wf', 'ws', wfArt.artifactId, settingsArt.artifactId, '0'.repeat(64), 'canceled', 0, new Date().toISOString()
    );
    store.run(
      'INSERT INTO runs(id, workflow_id, workspace_id, workflow_snapshot_artifact_id, settings_artifact_id, execution_hash, state, last_sequence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      repairRunId, 'wf', 'ws', wfArt.artifactId, settingsArt.artifactId, '0'.repeat(64), 'running', 0, new Date().toISOString()
    );
    store.run(
      'INSERT INTO run_links(id, kind, parent_run_id, repair_run_id, parent_workspace_id, repair_workspace_id, resume_node_instance_id, checkpoint_artifact_id, state, continuation_contract, incident_id, parent_suspension_state, repair_outcome, decision_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      linkId, 'linked_repair', parentRunId, repairRunId, 'ws', 'ws', 'n1', settingsArt.artifactId, 'open', 'lifecycle', null, 'suspended_for_repair', 'succeeded', 'accepted', new Date().toISOString(), new Date().toISOString()
    );

    const mockEngine = { store };
    const result = await executeP6Activation({ engine: mockEngine, repairRunId });
    assert.equal(result.activated, false);
    assert.equal(result.reason, 'parent_stopped');
  } finally {
    cleanup();
  }
});

test('P6-BUILD Consumer: fails closed when candidate touches out-of-scope paths', async () => {
  const { store, cleanup } = freshStore();
  try {
    const parentRunId = randomUUID();
    const repairRunId = randomUUID();
    const linkId = randomUUID();
    const incidentId = randomUUID();

    store.run('INSERT INTO workspaces(id, cwd, cwd_identity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', 'ws', 'cwd', '0'.repeat(64), new Date().toISOString(), new Date().toISOString());
    const wfArt = store.putJson({ schemaVersion: 1, kind: 'WorkflowSnapshot', workflowId: 'wf', version: 1, capabilities: [] });
    store.run('INSERT INTO workflows(id, kind, snapshot_artifact_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', 'wf', 'system', wfArt.artifactId, new Date().toISOString(), new Date().toISOString());
    const settingsArt = store.putJson({ schemaVersion: 1, kind: 'Settings' });

    store.run(
      'INSERT INTO runs(id, workflow_id, workspace_id, workflow_snapshot_artifact_id, settings_artifact_id, execution_hash, state, last_sequence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      parentRunId, 'wf', 'ws', wfArt.artifactId, settingsArt.artifactId, '0'.repeat(64), 'waiting_for_user', 0, new Date().toISOString()
    );
    store.run(
      'INSERT INTO runs(id, workflow_id, workspace_id, workflow_snapshot_artifact_id, settings_artifact_id, execution_hash, state, last_sequence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      repairRunId, 'wf', 'ws', wfArt.artifactId, settingsArt.artifactId, '0'.repeat(64), 'succeeded', 0, new Date().toISOString()
    );
    store.run(
      'INSERT INTO run_links(id, kind, parent_run_id, repair_run_id, parent_workspace_id, repair_workspace_id, resume_node_instance_id, checkpoint_artifact_id, state, continuation_contract, incident_id, parent_suspension_state, repair_outcome, decision_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      linkId, 'linked_repair', parentRunId, repairRunId, 'ws', 'ws', 'n1', settingsArt.artifactId, 'open', 'lifecycle', null, 'suspended_for_repair', 'succeeded', 'accepted', new Date().toISOString(), new Date().toISOString()
    );

    const forbiddenChangeManifest = {
      schemaVersion: 1,
      kind: 'ProtectedSelfRepairChangeManifest',
      candidateId: '0'.repeat(64),
      baselineId: '0'.repeat(64),
      baseSourceDigest: '0'.repeat(64),
      candidateSourceDigest: '0'.repeat(64),
      profileDigest: '0'.repeat(64),
      verificationPolicyDigest: '0'.repeat(64),
      verificationInputsDigest: '0'.repeat(64),
      workspaceAllocationId: randomUUID(),
      parentRunId,
      repairRunId,
      linkId,
      incidentId,
      changes: [
        {
          path: 'lifecycle-host/src/lib.rs',
          operation: 'modify',
          before: { path: 'lifecycle-host/src/lib.rs', type: 'regular', byteSize: 10, sha256: '1'.repeat(64), executable: false },
          after: { path: 'lifecycle-host/src/lib.rs', type: 'regular', byteSize: 10, sha256: '2'.repeat(64), executable: false },
        },
      ],
    };
    validateP5Contract('changeManifest', forbiddenChangeManifest);
    const cmArt = store.putJson(forbiddenChangeManifest);

    const handoff = {
      schemaVersion: 1,
      kind: 'ProtectedSelfRepairHandoff',
      handoffId: '1'.repeat(64),
      candidateId: '0'.repeat(64),
      candidateSourceDigest: '0'.repeat(64),
      candidate: { artifactId: randomUUID(), sha256: '0'.repeat(64) },
      baselineId: '0'.repeat(64),
      repositoryIdentity: { enrollmentId: randomUUID(), canonicalCommonDirectory: process.cwd(), nativeDirectoryIdentity: { volumeId: '1', fileId: '1' } },
      sourceBinding: { artifactId: randomUUID(), sha256: '0'.repeat(64) },
      enrollment: { artifactId: randomUUID(), sha256: '0'.repeat(64) },
      sourceManifest: { artifactId: randomUUID(), sha256: '0'.repeat(64) },
      changeManifest: { artifactId: cmArt.artifactId, sha256: cmArt.sha256 },
      verificationPolicy: { artifactId: randomUUID(), sha256: '0'.repeat(64) },
      verificationInputs: { artifactId: randomUUID(), sha256: '0'.repeat(64) },
      verificationReceipt: { artifactId: randomUUID(), sha256: '0'.repeat(64) },
      parentRunId,
      repairRunId,
      linkId,
      incidentId,
      judgeAttemptId: randomUUID(),
      decisionId: randomUUID(),
      p2Authorization: { artifactId: randomUUID(), sha256: '0'.repeat(64) },
      p2Approval: { artifactId: randomUUID(), sha256: '0'.repeat(64) },
      p2Outcome: { artifactId: randomUUID(), sha256: '0'.repeat(64) },
      retentionRecord: { artifactId: randomUUID(), sha256: '0'.repeat(64) },
      continuationState: 'repair_accepted',
      hostProvenance: { custodyId: randomUUID(), hostIdentity: 'h', lifecycleGeneration: randomUUID(), engineEpoch: 1, invocationDigest: '0'.repeat(64), commandManifest: { artifactId: randomUUID(), sha256: '0'.repeat(64) }, executableIdentity: process.execPath, harnessClosureDigest: '0'.repeat(64), testInputManifest: { artifactId: randomUUID(), sha256: '0'.repeat(64) }, environmentDigest: '0'.repeat(64) },
      retention: { status: 'retained', revision: 1, retainedAt: new Date().toISOString(), cleanupDeferred: true },
      currentEligibility: { eligible: true, revision: 1, checkedAt: new Date().toISOString(), stage: 'p5_acceptance', candidateSourceDigest: '0'.repeat(64) },
      authority: { sourceCandidateAccepted: true, sourceApplied: false, branchPublished: false, productionBuilt: false, binaryInstalled: false, activated: false, hostModificationAuthorized: false, hostReplacementAuthorized: false, hostUpdateAuthorized: false },
    };
    validateP5Contract('handoff', handoff);
    const handoffArt = store.putJson(handoff);

    store.appendEvents(repairRunId, [
      { type: 'self_repair.handoff_recorded', payload: { record: { artifactId: handoffArt.artifactId, sha256: handoffArt.sha256 } }, nodeInstanceId: null, attemptId: null },
    ]);

    const mockEngine = { store };
    const result = await executeP6Activation({ engine: mockEngine, repairRunId });
    assert.equal(result.activated, false);
    assert.equal(result.reason, 'p6_scope_host_modification');
  } finally {
    cleanup();
  }
});

test('P6-BUILD Admission: a Stop after Host staging wins before durable switch admission', async () => {
  const { store, cleanup } = freshStore();
  try {
    const parentRunId = randomUUID(), repairRunId = randomUUID(), linkId = randomUUID(), incidentId = randomUUID();
    const operationId = randomUUID(), generation = randomUUID();
    const packageSha256 = 'a'.repeat(64), handoffId = 'b'.repeat(64), candidateId = 'c'.repeat(64);
    const now = new Date().toISOString();
    store.run('INSERT INTO workspaces(id, cwd, cwd_identity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      'ws', 'cwd', '0'.repeat(64), now, now);
    const wfArt = store.putJson({ schemaVersion: 1, kind: 'WorkflowSnapshot', workflowId: 'wf', version: 1, capabilities: [] });
    store.run('INSERT INTO workflows(id, kind, snapshot_artifact_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      'wf', 'system', wfArt.artifactId, now, now);
    const settingsArt = store.putJson({ schemaVersion: 1, kind: 'Settings' });
    for (const [id, state] of [[parentRunId, 'waiting_for_user'], [repairRunId, 'succeeded']]) {
      store.run('INSERT INTO runs(id, workflow_id, workspace_id, workflow_snapshot_artifact_id, settings_artifact_id, execution_hash, state, last_sequence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, 'wf', 'ws', wfArt.artifactId, settingsArt.artifactId, '0'.repeat(64), state, 0, now);
    }
    store.run(`INSERT INTO run_links(id, kind, parent_run_id, repair_run_id, parent_workspace_id, repair_workspace_id,
      resume_node_instance_id, checkpoint_artifact_id, state, continuation_contract, incident_id, parent_suspension_state,
      repair_outcome, decision_status, authorization_artifact_id, repair_result_node_instance_id, failed_node_retry,
      acceptance_mode, created_at, updated_at)
      VALUES (?, 'linked_repair', ?, ?, 'ws', 'ws', 'n1', ?, 'repair_accepted', 'logical_policy', ?, 'suspended_for_repair',
      'succeeded', 'accepted', ?, 'n1', 'never', 'judge_post_execution', ?, ?)`,
      linkId, parentRunId, repairRunId, settingsArt.artifactId, incidentId, settingsArt.artifactId, now, now);

    const handoff = { handoffId, candidateId };
    const handoffArtifact = store.putJson(handoff);
    const handoffRef = { artifactId: handoffArtifact.artifactId, sha256: handoffArtifact.sha256 };
    store.appendEvents(repairRunId, [{ type: 'self_repair.handoff_recorded', payload: { record: handoffRef }, nodeInstanceId: null, attemptId: null }]);
    const link = store.get('SELECT * FROM run_links WHERE id = ?', linkId);
    const engine = { store, protectedSelfRepairRunProjection: () => ({ schemaVersion: 1, kind: 'ProtectedSelfRepairRunProjection',
      parentRunId, repairRunId, linkId, stage: 'retained_for_p6', eligible: true, candidateId, handoffId, issues: [] }) };

    const makeRef = value => {
      const artifact = store.putJson(value);
      return { artifactId: artifact.artifactId, sha256: artifact.sha256 };
    };
    const operationIntent = makeRef({ kind: 'P6Operation' }), buildReceipt = makeRef({ kind: 'P6BuildReceipt' });
    const candidate = makeRef({ kind: 'ProtectedSelfRepairCandidate' }), gitCandidate = makeRef({ kind: 'ProtectedSelfRepairGitCandidate' });
    const previousRelease = { schemaVersion: 1, kind: 'ProtectedSelfRepairRunningSourceRelease', installationId: 'd'.repeat(32),
      buildId: 'engine-a', bootstrap: 'tauri', packageSha256: 'e'.repeat(64), sourceCommit: 'f'.repeat(40),
      sourceDigest: '1'.repeat(64), inputsDigest: '1'.repeat(64) };
    let stageReceiptRef = null;
    let switchCalls = 0;
    const lifecycleHost = { context: { buildId: 'engine-a', shellBuildId: 'shell-g0', generation }, p6Call: async command => {
      if (command === 'engine.stage') return { operationId, phase: 'staged', fromEngineBuildId: 'engine-a',
        toEngineBuildId: 'engine-b', packageSha256, shellBuildId: 'shell-g0' };
      if (command === 'engine.switch') { switchCalls++; return { accepted: true, phase: 'committed' }; }
      throw new Error(`unexpected Host command ${command}`);
    } };
    const quiescence = createSwitchQuiescence();
    const admissionRequestId = `p6-switch-admitted-${operationId}`;
    const expected = { operationId, operationIntent, handoff: handoffRef, buildReceipt, stageReceipt: null,
      candidate, gitCandidate, previousRelease, engineBuildId: 'engine-b', shellBuildId: 'shell-g0', generation, packageSha256 };

    await assert.rejects(requestEngineSwitch({ engine, lifecycleHost, quiescence,
      body: { operationId, targetEngineBuildId: 'engine-b', packageSha256 }, timeoutMs: 1000,
      onStaged: () => {
        const stage = store.putJson({ schemaVersion: 1, kind: 'P6StageReceipt', operationId, fromEngineBuildId: 'engine-a',
          toEngineBuildId: 'engine-b', shellBuildId: 'shell-g0', packageSha256, phase: 'staged', recordedAt: now });
        stageReceiptRef = { artifactId: stage.artifactId, sha256: stage.sha256 };
      },
      beforeSwitchAdmission: () => {
        store.run('UPDATE runs SET state = ? WHERE id = ?', 'stopping', parentRunId);
        return persistP6SwitchAdmission({ engine, requestId: admissionRequestId, command: 'p6.switch_admitted',
          packageSha256, expected, stageReceiptRef, repairRunId, link, handoffRef, handoff });
      },
    }), error => error.code === 'p6_eligibility_revoked_before_switch');

    assert.equal(switchCalls, 0, 'engine.switch is never sent when Stop wins the Store admission boundary');
    assert.equal(store.get('SELECT request_id FROM command_receipts WHERE request_id = ?', admissionRequestId), undefined,
      'no durable admission receipt is written after the Stop');
    assert.equal(quiescence.active, false, 'Host staging alone does not leave Engine admission quiesced');
  } finally {
    cleanup();
  }
});
