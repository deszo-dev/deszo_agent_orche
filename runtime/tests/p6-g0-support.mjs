// P6-G0 native support. Everything here is real: one stable Tauri Shell compiled with its own identity, Engine packages built by
// the trusted packager from test-owned clean Git clones, and the real Rust Lifecycle Host that installs and runs them. Nothing
// here writes lifecycle authority; the Host and the Engines produce every state record themselves.
import { spawn, spawnSync } from 'node:child_process';
import { testLayout } from '../../scripts/build-layout.mjs';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { delimiter, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildArtifacts, eventually, exited, repo } from './custody-support.mjs';
import { actualGit, createTestSourceRepository, gitRunner, runtimeDependencyPackages, sha256 } from './p5-e2e-support.mjs';
import { packageEngineRelease, packageShellRelease } from '../../scripts/desktop-release.mjs';
import { inputFingerprint } from '../../scripts/deszo-artifacts.mjs';
import { testsRoot, trackProcess } from './test-roots.mjs';

export const SHELL_BUILD_ID = 'shell-g0';
export const ENGINE_A = 'engine-a';
export const ENGINE_B = 'engine-b';
export const artifactsRoot = join(testsRoot, 'p6-g0-artifacts');
const MARKER_FILE = 'runtime/p6-g0-engine-marker.mjs';

export const fileSha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');

/**
 * The stable Shell release: one `deszo.exe` compiled with DESZO_DESKTOP_BUILD_ID=shell-g0, plus the frozen runtime resources it
 * shares with every Engine. Built once with `npm run desktop:build` and reused while the receipt still matches the inputs.
 */
export function shellRelease() {
  const cached = join(artifactsRoot, 'shell');
  const receiptPath = join(cached, 'deszo-build.json');
  const exe = join(cached, 'deszo.exe');
  const resources = join(cached, 'runtime');
  // The Shell is compiled into a test-owned root, so no test build can replace the production outputs.
  const layout = testLayout(join(artifactsRoot, 'build-root'));
  const releaseExe = layout.exe;
  const usable = () => {
    try {
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      const manifest = readFileSync(join(resources, 'runtime-manifest.json'));
      return receipt.schemaVersion === 1 && receipt.desktopBuildId === SHELL_BUILD_ID && receipt.testFaultHooks === false
        && receipt.exeSha256 === fileSha256(exe) && receipt.runtimeManifestSha256 === sha256(manifest)
        && receipt.desktopInputsSha256 === inputFingerprint('desktop').sha256;
    } catch { return false; }
  };
  if (process.env.DESZO_P6_G0_REBUILD_SHELL !== '1' && existsSync(exe) && usable()) return { exe, receiptPath, resources };
  buildArtifacts();
  const build = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run desktop:build'], { cwd: repo, encoding: 'utf8',
    env: { ...process.env, DESZO_BUILD_ROOT: layout.root, DESZO_DESKTOP_BUILD_ID: SHELL_BUILD_ID }, timeout: 1_500_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (build.status !== 0) throw new Error(`npm run desktop:build (${SHELL_BUILD_ID}) failed:\n${build.stdout}\n${build.stderr}`);
  rmSync(cached, { recursive: true, force: true });
  mkdirSync(resources, { recursive: true });
  copyFileSync(releaseExe, exe);
  copyFileSync(layout.receipt, receiptPath);
  for (const name of readdirSync(layout.runtime)) {
    const from = join(layout.runtime, name);
    if (lstatSync(from).isFile()) copyFileSync(from, join(resources, name));
  }
  if (!usable()) throw new Error('The freshly built Shell does not match its own build receipt.');
  return { exe, receiptPath, resources };
}

/** Packages the stable Shell into `installation/shell` (the only place the Host ever reads it from). */
export function installShell(installation) {
  mkdirSync(installation, { recursive: true });
  const shell = shellRelease();
  return packageShellRelease({ shellBuildId: SHELL_BUILD_ID, desktopExecutable: shell.exe, desktopBuildReceipt: shell.receiptPath,
    runtimeResources: shell.resources, outDir: join(installation, 'shell') });
}

/**
 * The packager attests every file under a clone's node_modules and refuses reparse points, so a junction to the development
 * dependencies is not an option. The runtime's own dependency closure is copied as real files (the P5 harness does the same).
 */
function copyDependencies(clone, names) {
  for (const name of names) {
    const from = join(repo, 'node_modules', ...name.split('/'));
    const to = join(clone, 'node_modules', ...name.split('/'));
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true, dereference: false, errorOnExist: true, force: false });
  }
}

/**
 * Test-owned clean clones: `base` carries the current source closure as one committed release; engine A is that commit and
 * engine B is the same commit plus one Engine-only marker (the observable code difference of the G0 proof).
 */
export async function engineSources(root, { variant = 'marker' } = {}) {
  const gitPath = actualGit().path;
  const git = gitRunner(gitPath);
  const base = createTestSourceRepository(join(root, 'base'), gitPath);
  const dependencies = await runtimeDependencyPackages();
  const clone = name => {
    const path = join(root, name);
    git(root, ['clone', '--quiet', base.root, path]);
    copyDependencies(path, dependencies);
    return path;
  };
  const cloneA = clone('source-a');
  const cloneB = clone('source-b');
  const markerText = variant === 'failing'
    ? "throw new Error('P6-G0 deliberately failing Engine B: its maintenance preflight cannot start.');\n"
    : `export const P6_G0_ENGINE_MARKER = 'engine-b';\n`;
  if (variant === 'exits-after-preflight') {
    // The candidate reports its preflight, then ends before the Host's decision: the Host must not commit it.
    writeFileSync(join(cloneB, MARKER_FILE), `export const P6_G0_ENGINE_MARKER = 'engine-b';\n`);
    const runnerPath = join(cloneB, 'runtime/runner.mjs');
    const runner = readFileSync(runnerPath, 'utf8');
    const edited = runner
      .replace("import { acquireRuntimeLock } from './lock.mjs';", "import { acquireRuntimeLock } from './lock.mjs';\nimport { P6_G0_ENGINE_MARKER } from './p6-g0-engine-marker.mjs';")
      .replace("descriptor = { descriptorVersion: 1, apiVersions: ['v2', 'v3', 'v4'],", "descriptor = { descriptorVersion: 1, engineMarker: P6_G0_ENGINE_MARKER, apiVersions: ['v2', 'v3', 'v4'],");
    if (edited === runner) throw new Error('The G0 engine marker could not be placed in runner.mjs.');
    writeFileSync(runnerPath, edited);
    const preflightPath = join(cloneB, 'runtime/host/p6Maintenance.mjs');
    const preflight = readFileSync(preflightPath, 'utf8');
    const exited = preflight.replace("  // The one decision the candidate may act on.", "  process.exit(3); // G0 negative: the candidate ends after its preflight report.\n  // The one decision the candidate may act on.");
    if (exited === preflight) throw new Error('The G0 exit-after-preflight edit could not be placed.');
    writeFileSync(preflightPath, exited);
    git(cloneB, ['add', '--all']);
    git(cloneB, ['commit', '--quiet', '-m', `P6-G0 ${variant} engine B`]);
    return { gitPath, cloneA, cloneB, baseCommit: base.releaseCommit };
  }
  if (variant === 'failing') {
    writeFileSync(join(cloneB, 'runtime/p6-g0-engine-marker.mjs'), markerText);
    const runnerPath = join(cloneB, 'runtime/runner.mjs');
    writeFileSync(runnerPath, `import './p6-g0-engine-marker.mjs';\n${readFileSync(runnerPath, 'utf8')}`);
  } else {
    writeFileSync(join(cloneB, MARKER_FILE), markerText);
    const runnerPath = join(cloneB, 'runtime/runner.mjs');
    const runner = readFileSync(runnerPath, 'utf8');
    const edited = runner
      .replace("import { acquireRuntimeLock } from './lock.mjs';", "import { acquireRuntimeLock } from './lock.mjs';\nimport { P6_G0_ENGINE_MARKER } from './p6-g0-engine-marker.mjs';")
      .replace("descriptor = { descriptorVersion: 1, apiVersions: ['v2', 'v3', 'v4'],", "descriptor = { descriptorVersion: 1, engineMarker: P6_G0_ENGINE_MARKER, apiVersions: ['v2', 'v3', 'v4'],");
    if (edited === runner) throw new Error('The G0 engine marker could not be placed in runner.mjs.');
    writeFileSync(runnerPath, edited);
  }
  git(cloneB, ['add', '--all']);
  git(cloneB, ['commit', '--quiet', '-m', `P6-G0 ${variant} engine B`]);
  return { gitPath, cloneA, cloneB, baseCommit: base.releaseCommit };
}

/**
 * Packages Engine A and Engine B against the installed Shell; both are real desktop Engine packages with their own identities.
 * Engine A is installed as the selected release. Engine B is staged (the Host's staging area) when `stageB` is set: a switch
 * must stage it through the Host, and staging is what proves the package is independently verified.
 */
export async function installEngines(installation, sources, { engineB = ENGINE_B, shell = null, stageB = false, testFaultHooks = false } = {}) {
  const shellRecord = shell ?? JSON.parse(readFileSync(join(installation, 'shell', 'shell.json'), 'utf8'));
  const resources = shellRelease().resources;
  const gitTool = { path: sources.gitPath, sha256: sha256(readFileSync(sources.gitPath)) };
  mkdirSync(join(installation, 'versions'), { recursive: true });
  mkdirSync(join(installation, 'staging'), { recursive: true });
  // A test-owned package is built with the test fault-hook marker. The builder value is set only for these two calls.
  const previous = process.env.DESZO_TEST_FAULT_HOOKS;
  if (testFaultHooks) process.env.DESZO_TEST_FAULT_HOOKS = '1';
  try {
    const a = await packageEngineRelease({ sourceRoot: sources.cloneA, gitTool, outDir: join(installation, 'versions', ENGINE_A),
      engineBuildId: ENGINE_A, shell: shellRecord, runtimeResources: resources, testFaultHooks });
    const bRoot = join(installation, stageB ? 'staging' : 'versions', engineB);
    const b = await packageEngineRelease({ sourceRoot: sources.cloneB, gitTool, outDir: bRoot,
      engineBuildId: engineB, shell: shellRecord, runtimeResources: resources, testFaultHooks });
    return { a, b, bRoot };
  } finally {
    if (previous === undefined) delete process.env.DESZO_TEST_FAULT_HOOKS;
    else process.env.DESZO_TEST_FAULT_HOOKS = previous;
  }
}

/** Starts the real Rust Lifecycle Host over one P6 installation. The Shell's window starts the Engine as the product does. */
export function startShellHost({ root, installation, profile, initialBuildId, custody = null, testSwitchCrashAt = null,
  testTerminationUncertain = false, testProofUncertain = false, testEngineProbe = false, testFenceWindowMs = null, env: extraEnv = {},
  testSwitchBarrierDir = null }) {
  mkdirSync(profile, { recursive: true });
  const configPath = join(root, `host-config-${initialBuildId}-${Date.now()}.json`);
  const config = { installationRoot: installation, profileRoot: profile, stagingRoot: join(installation, 'staging'),
    nodeExecutable: process.execPath, initialBuildId, ...(custody ? { custody } : {}), ...(testSwitchCrashAt ? { testSwitchCrashAt } : {}),
    ...(testTerminationUncertain ? { testSwitchTerminationUncertain: true } : {}), ...(testProofUncertain ? { testSwitchProofUncertain: true } : {}),
    ...(testFenceWindowMs ? { testSwitchFencePauseMs: testFenceWindowMs } : {}),
    ...(testSwitchBarrierDir ? { testSwitchBarrierDir } : {}) };
  writeFileSync(configPath, JSON.stringify(config));
  const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') || 'PATH';
  const env = { ...process.env, DESZO_PROCESS_CUSTODY: custody ? '1' : '0',
    WEBVIEW2_USER_DATA_FOLDER: join(root, `webview2-${initialBuildId}-${Date.now()}`), [pathKey]: process.env[pathKey] || '' };
  // The Engine probe is requested per Host: an inherited value from the test runner never enables it by accident.
  if (testEngineProbe) env.DESZO_TEST_ENGINE_PROBE = '1';
  else delete env.DESZO_TEST_ENGINE_PROBE;
  // A caller's variables (a provider fixture's state directory and PATH) reach the Host and, through it, the managed Engine.
  Object.assign(env, extraEnv);
  const child = spawn(buildArtifacts().hostExe, ['run', '--config', configPath], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  trackProcess(root, child);
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const host = { child, profile, installation, get stdout() { return stdout; }, get stderr() { return stderr; } };
  host.engineConnection = (buildId, timeoutMs = 180_000) => eventually(() => {
    if (exited(child)) throw new Error(`The Lifecycle Host exited (${child.exitCode}): ${stderr}`);
    const path = join(profile, 'runtime', 'connection.json');
    if (!existsSync(path)) return null;
    try {
      const value = JSON.parse(readFileSync(path, 'utf8'));
      return value.applicationBuildId === buildId ? { ...value, firstPartyToken: value.token } : null;
    } catch { return null; }
  }, `the ${buildId} Engine to publish its profile descriptor`, timeoutMs, 100);
  host.stop = async () => {
    if (exited(child)) return;
    child.stdin.write('shutdown\n');
    await eventually(() => exited(child), 'the Lifecycle Host to stop', 90_000, 100).catch(() => child.kill());
  };
  return host;
}

/** The Host's own digest of a package directory (the same bytes the Host verifies), never the test's guess. */
export function hostDigest(path) {
  const result = spawnSync(buildArtifacts().hostExe, ['digest-candidate', '--path', path], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  if (result.status !== 0) throw new Error(`digest-candidate refused ${path}: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * Writes one evidence record when DESZO_P6_G0_EVIDENCE_DIR names a directory. A test calls it only after its own assertions pass, so a
 * record exists only for an outcome that was observed. Nothing reads these records back; the final report cites them.
 */
export function recordEvidence(name, record) {
  const directory = process.env.DESZO_P6_G0_EVIDENCE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  const body = { schemaVersion: 1, evidence: name, capturedAt: new Date().toISOString(), node: process.version,
    platform: `${process.platform} ${process.arch}`, ...record };
  writeFileSync(join(directory, `2026-11-01-p6-g0-final-${name}.json`), `${JSON.stringify(body, null, 2)}\n`);
}

export function hostEvents(installation) {
  const path = join(installation, '.deszo-host', 'operations.ndjson');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : [];
}

/** The profile's published Engine descriptor, or null while none exists or it is being replaced. */
export function currentDescriptor(profile) {
  const path = join(profile, 'runtime', 'connection.json');
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/** The runtime instance the profile's descriptor names now (null when none). Read it before a restart to exclude it later. */
export function descriptorInstance(profile) {
  return currentDescriptor(profile)?.runtimeInstanceId ?? null;
}

/**
 * The descriptor of a newly started Engine of `buildId`. A descriptor left by an earlier, ended Engine is never returned: its
 * runtime instance is excluded, so a port from a dead process cannot be mistaken for the live one.
 */
export async function freshDescriptor(profile, buildId, staleInstance = null, timeoutMs = 300_000) {
  const { eventually } = await import('./custody-support.mjs');
  return eventually(() => {
    const value = currentDescriptor(profile);
    if (!value || value.applicationBuildId !== buildId || value.runtimeInstanceId === staleInstance) return null;
    return { ...value, firstPartyToken: value.token };
  }, `a fresh ${buildId} Engine descriptor`, timeoutMs, 200);
}

export function activeSelector(installation) {
  return JSON.parse(readFileSync(join(installation, '.deszo-host', 'active.json'), 'utf8'));
}

export function readProfileDb(profile, sql, ...parameters) {
  const db = new DatabaseSync(join(profile, 'store', 'state.sqlite'), { readOnly: true });
  try { return db.prepare(sql).all(...parameters).map(row => ({ ...row })); } finally { db.close(); }
}

// The durable P6 operation record of an installation's Host state (lifecycle.json under the Host's profile directory).
export function lifecycleState(installation) {
  const profileStates = join(installation, '.deszo-host', 'profiles');
  const key = readdirSync(profileStates)[0];
  return JSON.parse(readFileSync(join(profileStates, key, 'lifecycle.json'), 'utf8'));
}

// Drives one Engine build's probe (runtime/core/testEngineProbe.mjs): writes its next numbered command and waits for the result.
const probeNumbers = new Map();
export async function probeEngine(profile, buildId, command, timeoutMs = 300_000) {
  const key = `${profile}|${buildId}`;
  const number = (probeNumbers.get(key) ?? 0) + 1;
  probeNumbers.set(key, number);
  const file = join(profile, 'p6-probe', `cmd-${buildId}-${number}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify(command));
  renameSync(`${file}.tmp`, file);
  const result = join(profile, 'p6-probe', `res-${buildId}-${number}.json`);
  await eventually(() => existsSync(result), `the ${buildId} probe to answer command ${number}`, timeoutMs, 50);
  return JSON.parse(readFileSync(result, 'utf8'));
}

export function processAlive(pid) {
  if (!pid) return false;
  const result = spawnSync('tasklist', ['/FI', `PID eq ${Number(pid)}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  return result.stdout.includes(`"${Number(pid)}"`);
}
