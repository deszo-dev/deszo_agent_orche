// P5-E2E-1 support: a test-owned source repository built from the current working-tree source closure, a release packaged
// by runtime/host/runtimeRelease.mjs, and the real Rust Lifecycle Host `run` mode (with Process Custody) managing the
// installed Engine. Nothing here writes authoritative P5 events; the Engine produces every lifecycle record itself.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { delimiter, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildArtifacts, eventually, exited, fixtureExe, repo } from './custody-support.mjs';
import { trackProcess } from './test-roots.mjs';
import { packageRuntimeRelease, RUNTIME_RELEASE_PATTERN } from '../host/runtimeRelease.mjs';
import { packageDesktopRelease } from '../../scripts/desktop-release.mjs';

// The desktop shell compiles its build identity in, so a desktop release is installed as this build. Proof B builds and
// caches exactly this executable (tauri-host-proof-b.test.mjs); without that cache it is built here once.
export const DESKTOP_BUILD_ID = 'build-a';
const desktopArtifacts = join(repo, '.deszo', 'tests', 'desktop-host-proof-b-artifacts');

export const sha256 = value => createHash('sha256').update(value).digest('hex');

export function actualGit() {
  const listed = execFileSync('where.exe', ['git.exe'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const found = listed.flatMap(path => [path, resolve(dirname(path), '..', 'mingw64', 'bin', 'git.exe')])
    .find(path => /[\\/]mingw64[\\/]bin[\\/]git\.exe$/i.test(path) && existsSync(path));
  if (!found) throw new Error('P5-E2E-1 needs Git for Windows actual mingw64 git.exe.');
  return { path: found, sha256: sha256(readFileSync(found)) };
}

export function gitRunner(gitPath) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('GIT_')) delete env[key];
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_TERMINAL_PROMPT: '0' });
  return (cwd, args) => execFileSync(gitPath, ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'core.hooksPath=NUL', '-c', 'init.templateDir=',
    '-c', 'commit.gpgsign=false', '-c', 'user.name=P5 E2E Fixture', '-c', 'user.email=p5-e2e@example.invalid', '-c', 'protocol.file.allow=always',
    '-C', cwd, ...args], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
}

// Read-only listing of the development checkout: tracked plus untracked-but-not-ignored files, so uncommitted P5 work is
// carried into the isolated test repository without any Git write to the original checkout.
export function currentSourceClosure(gitPath) {
  const git = gitRunner(gitPath);
  const names = git(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
  // runner.mjs imports the fixture adapter on its --fixture-state path, so the source closure carries it; the package does not.
  return [...new Set(names)].filter(name => (RUNTIME_RELEASE_PATTERN.test(name) || /^runtime\/tests\/fixture-(adapters|cli)\.mjs$/.test(name))
    && existsSync(join(repo, name))).sort();
}

/** The runtime's third-party packages and their declared dependencies, read from the development checkout (read-only). */
export async function runtimeDependencyPackages() {
  const { authorityImportClosure } = await import('../host/sourceProvenance.mjs');
  const graph = authorityImportClosure(repo, ['runtime/runner.mjs', 'mcp/bridge.mjs', 'runtime/verification/p5Verifier.mjs']);
  const pending = [...new Set(graph.edges.filter(edge => edge.package)
    .map(edge => edge.package.startsWith('@') ? edge.package.split('/').slice(0, 2).join('/') : edge.package.split('/')[0]))];
  const names = new Set();
  while (pending.length) {
    const name = pending.pop();
    if (names.has(name)) continue;
    names.add(name);
    pending.push(...Object.keys(JSON.parse(readFileSync(join(repo, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')).dependencies || {}));
  }
  return [...names].sort();
}

/** Create the test-owned source repository: current closure plus `extraFiles`, committed in history root → release commit. */
export function createTestSourceRepository(root, gitPath, { extraFiles = new Map(), dependencies = [] } = {}) {
  const git = gitRunner(gitPath);
  mkdirSync(root, { recursive: true });
  git(root, ['init', '--quiet', '--initial-branch=main']);
  // The installed dependency set is ignored by Git and attested through the build-input dependency digest instead.
  writeFileSync(join(root, '.gitignore'), 'node_modules/' + String.fromCharCode(10));
  for (const name of dependencies) cpSync(join(repo, 'node_modules', ...name.split('/')), join(root, 'node_modules', ...name.split('/')), { recursive: true });
  const closure = currentSourceClosure(gitPath);
  for (const name of closure) { mkdirSync(dirname(join(root, name)), { recursive: true }); copyFileSync(join(repo, name), join(root, name)); }
  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '-m', 'P5-E2E-1 test source: current P5 implementation closure']);
  const historyRoot = git(root, ['rev-parse', 'HEAD']).trim();
  for (const [name, text] of extraFiles) { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), text); }
  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '--allow-empty', '-m', 'P5-E2E-1 installed release source']);
  return { root, historyRoot, releaseCommit: git(root, ['rev-parse', 'HEAD']).trim(), files: closure.length + extraFiles.size };
}

/** The release-built desktop shell with compiled identity `build-a` (reused from Proof B's verified cache or built once). */
export function desktopExecutable() {
  const cached = join(desktopArtifacts, `desktop-build-${DESKTOP_BUILD_ID.slice(-1)}`, 'deszo.exe');
  if (existsSync(cached)) return cached;
  const env = { ...process.env, DESZO_DESKTOP_BUILD_ID: DESKTOP_BUILD_ID };
  const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run desktop:build'], { cwd: repo, env, encoding: 'utf8',
    timeout: 900_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`npm run desktop:build failed: ${result.stdout}\n${result.stderr}`);
  mkdirSync(dirname(cached), { recursive: true });
  copyFileSync(join(repo, 'src-tauri', 'target', 'release', 'deszo.exe'), cached);
  return cached;
}

export async function packageInstalledRelease({ sourceRoot, gitTool, installation, buildId, distribution = 'runtime' }) {
  mkdirSync(join(installation, 'versions'), { recursive: true });
  mkdirSync(join(installation, 'staging'), { recursive: true });
  const outDir = join(installation, 'versions', buildId);
  if (distribution !== 'desktop') return packageRuntimeRelease({ sourceRoot, gitTool, outDir, buildId });
  for (const name of ['bridge.mjs', 'deszo-launch-shim.exe', 'runtime-manifest.json'])
    if (!existsSync(join(repo, 'dist-runtime', name))) throw new Error(`dist-runtime/${name} is missing; run npm run runtime:bundle and npm run shim:build.`);
  return packageDesktopRelease({ sourceRoot, gitTool, outDir, buildId, desktopExecutable: desktopExecutable(),
    runtimeResources: join(repo, 'dist-runtime') });
}

export function hostExecutable() { return buildArtifacts().hostExe; }

/** Start the Rust Lifecycle Host in `run` mode: it verifies the installed build and launches its Engine through runner.mjs. */
export function startLifecycleHost({ root, installation, profile, buildId, fixtureState, allowedExecutables, distribution = 'runtime', env: extraEnv = {},
  custodyTest = {} }) {
  const desktop = distribution === 'desktop';
  // A desktop release is launched exactly as the product launches it: the Host starts deszo.exe, which starts its packaged
  // Engine. The runtime-bootstrap test conveniences (stdout setup token, confirmation off) do not exist there.
  const config = { installationRoot: installation, profileRoot: profile, stagingRoot: join(installation, 'staging'), nodeExecutable: process.execPath,
    initialBuildId: buildId, ...(desktop ? {} : { devTestConfirmationOff: true, forwardRuntimeStdout: true, testSetupTokenStdout: true }),
    // Debug-build Host test hooks (e.g. testUndrainedDrainMs), exactly as the Custody safety suite uses them.
    custody: { allowedExecutables, ...custodyTest } };
  const descriptorPath = join(profile, 'runtime', 'connection.json');
  if (desktop) rmSync(descriptorPath, { force: true });
  mkdirSync(profile, { recursive: true });
  const configPath = join(root, 'host-config.json');
  writeFileSync(configPath, JSON.stringify(config));
  const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') || 'PATH';
  const env = { ...process.env, [pathKey]: `${dirname(fixtureExe)}${delimiter}${process.env[pathKey] || ''}`,
    CUSTODY_FIXTURE_STATE_DIR: fixtureState, CODEX_HOME: join(root, 'codex-home') };
  mkdirSync(env.CODEX_HOME, { recursive: true });
  for (const key of Object.keys(env)) if (key.startsWith('DESZO_CUSTODY_') || key === 'DESZO_PROCESS_CUSTODY') delete env[key];
  // One WebView2 user-data folder per Host session: the previous shell's WebView2 processes may still hold theirs while exiting.
  if (desktop) Object.assign(env, { DESZO_PROCESS_CUSTODY: '1', WEBVIEW2_USER_DATA_FOLDER: join(root, `webview2-${Date.now()}`) });
  Object.assign(env, extraEnv);
  const child = spawn(hostExecutable(), ['run', '--config', configPath], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  trackProcess(root, child);
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  let stdout = '', stderr = '';
  const tokens = [];
  child.stdout.on('data', chunk => {
    stdout += chunk;
    for (const line of chunk.split(/\r?\n/)) { try { const value = JSON.parse(line); if (value.port && value.firstPartyToken) tokens.push(value); } catch { /* not a descriptor */ } }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const host = { child, profile, installation, get stdout() { return stdout; }, get stderr() { return stderr; }, tokens };
  host.firstConnection = () => eventually(() => {
    if (exited(child)) throw new Error(`The Lifecycle Host exited (${child.exitCode}): ${stderr}`);
    if (!desktop) return tokens[0] ?? null;
    // The packaged desktop Engine publishes its normal profile descriptor; its token is the Owner credential.
    if (!existsSync(descriptorPath)) return null;
    try {
      const value = JSON.parse(readFileSync(descriptorPath, 'utf8'));
      return value.applicationBuildId === buildId ? { ...value, firstPartyToken: value.token } : null;
    } catch { return null; }
  }, 'the managed Engine first-party setup descriptor', desktop ? 180_000 : 120_000, 50);
  host.shutdown = async () => {
    if (exited(child)) return;
    child.stdin.write('shutdown\n');
    await eventually(() => exited(child), 'the Lifecycle Host to stop', 60_000, 100).catch(() => child.kill());
  };
  return host;
}

export function hostEvents(installation) {
  const path = join(installation, '.deszo-host', 'operations.ndjson');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : [];
}

export function currentDescriptor(profile) {
  const path = join(profile, 'runtime', 'connection.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

export function api(connection, token) {
  return async (method, path, body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${connection.port}${path}`, { method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, etag: response.headers.get('etag'), body: text ? JSON.parse(text) : null };
  };
}

export function profileQuery(profile, sql, ...parameters) {
  const db = new DatabaseSync(join(profile, 'store', 'state.sqlite'), { readOnly: true });
  try { return db.prepare(sql).all(...parameters).map(row => ({ ...row })); } finally { db.close(); }
}

export function journal(profile, runId) {
  return profileQuery(profile, 'SELECT sequence, event_type, envelope_json FROM journal_events WHERE run_id = ? ORDER BY sequence', runId)
    .map(row => ({ sequence: row.sequence, type: row.event_type, payload: JSON.parse(row.envelope_json).payload }));
}

/**
 * Independent P6-side reconstruction: read the handoff and only its reachable immutable Store objects into a fresh
 * directory and recompute the SHA-256 source identity. The mutable repair workspace is never consulted.
 */
export async function reconstructHandoff({ profile, handoffRef, outDir }) {
  const { Store } = await import('../core/store.mjs');
  const { p5SourceDigest, validateP5Contract } = await import('../core/protectedSelfRepair.mjs');
  const store = new Store(profile);
  try {
    store.verifyRef(handoffRef);
    const handoff = store.readJson(handoffRef.artifactId);
    validateP5Contract('handoff', handoff);
    store.verifyRef(handoff.sourceManifest);
    const manifest = store.readJson(handoff.sourceManifest.artifactId);
    validateP5Contract('sourceManifest', manifest);
    mkdirSync(outDir);
    for (const entry of manifest.entries) {
      store.verifyRef(entry.artifact);
      const bytes = store.readBytes(entry.artifact.artifactId).bytes;
      if (bytes.length !== entry.byteSize || sha256(bytes) !== entry.sha256) throw new Error(`Reconstructed object differs for ${entry.path}.`);
      const target = join(outDir, ...entry.path.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes, { flag: 'wx' });
    }
    const digest = p5SourceDigest(manifest.entries.map(({ artifact: _artifact, ...entry }) => entry));
    const gitCandidate = handoff.gitCandidate ? store.readJson(store.verifyRef(handoff.gitCandidate).artifactId) : null;
    return { handoff, manifest, digest, gitCandidate };
  } finally { store.db.close(); }
}
