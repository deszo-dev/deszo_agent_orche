// ADR-0006 compilation attestation: a routine build stages only with the attestation of its actual commands, bound to the
// captured closure and to the manifest. These are fixture tests with a fixture executor and a fixture host. They establish
// the verifier and the staging refusal logic; native bounded-command evidence is a separate verification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { sha256 } from '../core/canonical.mjs';
import { ControlHost } from '../host/authority.mjs';
import { InstalledBuilds, securityClosure } from '../host/installedBuilds.mjs';
import { createBuildManifest } from '../host/lifecycle.mjs';
import { ALLOWED_BUILD_COMMANDS, commandAllowed, toolIdentity, verifyBuildAttestation } from '../host/buildAttestation.mjs';
import { fixtureProcessExecutor, runAttestedBuild } from '../host/buildRunner.mjs';
import { FIXTURE_BUILD, FIXTURE_ARTIFACT, attestFixtureBuild } from './attestation-fixture.mjs';

const gitPath = process.platform === 'win32' ? execFileSync('where.exe', ['git.exe'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0] : execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const gitTool = { path: gitPath, sha256: sha256(readFileSync(gitPath)) };

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'deszo-attestation-')), root = join(base, 'source');
  mkdirSync(root);
  const write = (name, text) => { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), text); };
  write('runtime/main.mjs', "export { allow } from '../config/rules.mjs';\n");
  write('config/rules.mjs', 'export const allow = true;\n');
  const git = args => execFileSync(gitPath, ['-c', 'core.autocrlf=false', '-C', root, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  git(['init', '--quiet']);
  git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture baseline']);
  return { base, root, write, git, head: git(['rev-parse', 'HEAD']).trim() };
}

function host(c) { return new ControlHost({ root: join(c.base, 'host') }); }

test('ADR6 attestation: only the repository build commands are allowed, and the list is fixed', () => {
  assert.ok(ALLOWED_BUILD_COMMANDS.some(argv => argv.join(' ') === 'npm run runtime:bundle'));
  assert.equal(commandAllowed(['node', '-e', 'process.exit(0)']), false, 'An inline script is never an allowed build command.');
  assert.equal(commandAllowed(['npm', 'run', 'runtime:bundle', '--', 'extra']), false, 'Extra arguments are refused.');
  assert.equal(commandAllowed(['npm', 'run', 'runtime:bundle']), true);
});

test('ADR6 attestation: a routine build stages only with the attestation of its actual run, and records its digest', async () => {
  const c = fixture(), h = host(c), outputs = join(c.base, 'artifacts'), buildRoot = join(c.base, 'builds');
  mkdirSync(buildRoot);
  const builds = new InstalledBuilds({ host: h, buildRoot, gitTool, sealDirectory: async () => ({ immutable: true, assurance: 'fixture' }), allowedBuildCommands: [FIXTURE_BUILD] });
  try {
    const attestation = await attestFixtureBuild({ sourceRoot: c.root, gitTool, outputsDir: outputs });
    assert.equal(attestation.commands[0].exitCode, 0);
    assert.equal(attestation.closureAfterDigest, attestation.closureDigest, 'The closure did not change while the build ran.');
    const baseline = await builds.stage({ buildId: 'baseline', sourceDir: outputs, sourceRoot: c.root, sourceCommit: c.head, protocolVersion: 1, storeSchemaVersion: 11, launchEntry: 'deszo.exe', operatorBaseline: true, sourceBuildAttestation: attestation });
    assert.equal(baseline.verification.sourceBuildAttestation.attestationDigest, attestation.attestationDigest);
    const routine = await builds.stage({ buildId: 'routine', sourceDir: outputs, sourceRoot: c.root, sourceCommit: c.head, protocolVersion: 1, storeSchemaVersion: 11, launchEntry: 'deszo.exe', sourceBuildAttestation: attestation });
    assert.equal(routine.verification.sourceBuildAttestation.executor, 'fixture-child-process');
  } finally { h.close(); }
});

test('ADR6 attestation: a routine build without its attestation is refused, and a diagnostic build stays unpromotable', async () => {
  const c = fixture(), h = host(c), outputs = join(c.base, 'artifacts'), buildRoot = join(c.base, 'builds');
  mkdirSync(outputs); mkdirSync(buildRoot);
  writeFileSync(join(outputs, 'deszo.exe'), FIXTURE_ARTIFACT);
  const builds = new InstalledBuilds({ host: h, buildRoot, gitTool, sealDirectory: async () => ({ immutable: true, assurance: 'fixture' }), allowedBuildCommands: [FIXTURE_BUILD] });
  const args = { sourceDir: outputs, sourceRoot: c.root, sourceCommit: c.head, protocolVersion: 1, storeSchemaVersion: 11, launchEntry: 'deszo.exe' };
  try {
    await assert.rejects(builds.stage({ ...args, buildId: 'no-attestation', operatorBaseline: true }), /compilation attestation is required/);
    assert.equal(existsSync(join(buildRoot, 'no-attestation')), false, 'Nothing was staged.');
    const diagnostic = await builds.stage({ ...args, buildId: 'diagnostic', diagnosticOnly: true, operatorBaseline: true });
    assert.equal(diagnostic.verification.sourceBuildAttestation, null);
    await assert.rejects(builds.stage({ ...args, buildId: 'diagnostic-promotion', diagnosticOnly: false }), /protected operator baseline|compilation attestation|cannot be promoted/);
  } finally { h.close(); }
});

test('ADR6 attestation: a command outside the allowlist is refused before anything runs', async () => {
  const c = fixture(), outputs = join(c.base, 'artifacts');
  let ran = false;
  const executor = { name: 'fixture-child-process', run: async () => { ran = true; return { exitCode: 0, stdout: '', stderr: '' }; } };
  await assert.rejects(runAttestedBuild({ sourceRoot: c.root, gitTool, commands: [['node', '-e', 'process.exit(0)']], executor, outputsDir: outputs, toolIdentities: [toolIdentity({ name: 'node', path: process.execPath, version: process.version })], allowedCommands: [FIXTURE_BUILD] }),
    /not allowed/);
  assert.equal(ran, false, 'No command ran.');
});

test('ADR6 attestation: a source change while the build runs refuses the attestation', async () => {
  const c = fixture(), outputs = join(c.base, 'artifacts');
  const base = fixtureProcessExecutor({ env: { PATH: process.env.PATH ?? '', DESZO_BUILD_OUT: outputs } });
  const executor = { name: 'fixture-child-process', run: async args => { const result = await base.run(args); c.write('config/rules.mjs', 'export const allow = false;\n'); return result; } };
  mkdirSync(join(c.root, 'scripts'), { recursive: true });
  writeFileSync(join(c.root, 'scripts', 'build-fixture.mjs'), 'process.exit(0);\n');
  await assert.rejects(runAttestedBuild({ sourceRoot: c.root, gitTool, commands: [[...FIXTURE_BUILD]], executor, outputsDir: outputs, toolIdentities: [toolIdentity({ name: 'node', path: process.execPath, version: process.version })], allowedCommands: [FIXTURE_BUILD] }),
    /changed during the build/);
});

test('ADR6 attestation: a failed build command is recorded and the staging refuses it', async () => {
  const c = fixture(), h = host(c), outputs = join(c.base, 'artifacts'), buildRoot = join(c.base, 'builds');
  mkdirSync(outputs); mkdirSync(buildRoot);
  writeFileSync(join(outputs, 'deszo.exe'), FIXTURE_ARTIFACT);
  const failing = { name: 'fixture-child-process', run: async () => ({ exitCode: 3, stdout: 'partial', stderr: 'compiler error' }) };
  const attestation = await attestFixtureBuild({ sourceRoot: c.root, gitTool, outputsDir: outputs, executor: failing });
  assert.equal(attestation.commands[0].exitCode, 3, 'The failure is recorded, not hidden.');
  const builds = new InstalledBuilds({ host: h, buildRoot, gitTool, sealDirectory: async () => ({ immutable: true, assurance: 'fixture' }), allowedBuildCommands: [FIXTURE_BUILD] });
  try {
    await assert.rejects(builds.stage({ buildId: 'failed', sourceDir: outputs, sourceRoot: c.root, sourceCommit: c.head, protocolVersion: 1, storeSchemaVersion: 11, launchEntry: 'deszo.exe', operatorBaseline: true, sourceBuildAttestation: attestation }),
      /did not succeed/);
    assert.equal(existsSync(join(buildRoot, 'failed')), false);
  } finally { h.close(); }
});

test('ADR6 attestation: an output changed after attestation is refused, because it is not the attested artifact', async () => {
  const c = fixture(), h = host(c), outputs = join(c.base, 'artifacts'), buildRoot = join(c.base, 'builds');
  mkdirSync(buildRoot);
  const attestation = await attestFixtureBuild({ sourceRoot: c.root, gitTool, outputsDir: outputs });
  writeFileSync(join(outputs, 'deszo.exe'), 'substituted after the build');
  const builds = new InstalledBuilds({ host: h, buildRoot, gitTool, sealDirectory: async () => ({ immutable: true, assurance: 'fixture' }), allowedBuildCommands: [FIXTURE_BUILD] });
  try {
    await assert.rejects(builds.stage({ buildId: 'substituted', sourceDir: outputs, sourceRoot: c.root, sourceCommit: c.head, protocolVersion: 1, storeSchemaVersion: 11, launchEntry: 'deszo.exe', operatorBaseline: true, sourceBuildAttestation: attestation }),
      /is not an attested output/);
    assert.equal(existsSync(join(buildRoot, 'substituted')), false);
  } finally { h.close(); }
});

test('ADR6 attestation: production provenance needs the native bounded-command executor, and a tampered digest is refused', async () => {
  const c = fixture(), outputs = join(c.base, 'artifacts');
  const attestation = await attestFixtureBuild({ sourceRoot: c.root, gitTool, outputsDir: outputs });
  const closure = await securityClosure(c.root, gitTool);
  const manifest = createBuildManifest({ buildDir: outputs, buildId: 'verify', sourceCommit: c.head, inputsDigest: 'e'.repeat(64), protocolVersion: 1, storeSchemaVersion: 11, launchEntry: 'deszo.exe', createdAt: new Date().toISOString() });
  assert.throws(() => verifyBuildAttestation(attestation, { closure, manifest, allowedCommands: [FIXTURE_BUILD], requireNative: true }), /native bounded-command executor/);
  assert.equal(verifyBuildAttestation(attestation, { closure, manifest, allowedCommands: [FIXTURE_BUILD], requireNative: false }).verified, true);
  assert.throws(() => verifyBuildAttestation({ ...attestation, executor: 'native-bounded-command' }, { closure, manifest, allowedCommands: [FIXTURE_BUILD], requireNative: true }), /digest does not verify/);
});

test('ADR6 attestation: a tool identity must be a plain installed file with a digest', () => {
  assert.throws(() => toolIdentity({ name: 'missing', path: join(tmpdir(), 'no-such-tool.exe'), version: '0' }), /not a plain installed file/);
  assert.throws(() => toolIdentity({ name: 'relative', path: 'node', version: '0' }), /not a plain installed file/);
});
