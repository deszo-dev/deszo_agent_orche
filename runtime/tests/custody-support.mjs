// Process Custody test support. Every process here is real: the Rust Lifecycle Host's custody service, Engine runtimes started
// from runtime/runner.mjs, and the deterministic provider fixture (runtime/tests/fixtures/custody-cli.rs). Nothing is mocked.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { delimiter, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildRustFixture, rustFixtureDir } from './build-cache.mjs';
import { isOwned, ownedDir, releaseOwnedDir, testsRoot, trackProcess } from './test-roots.mjs';

export const repo = resolve(import.meta.dirname, '../..');
export { testsRoot };
const artifactsRoot = join(testsRoot, 'custody-artifacts');
export const hostExe = join(repo, 'lifecycle-host/target/debug', 'deszo-lifecycle-host.exe');
const fixtureSource = join(repo, 'runtime/tests/fixtures/custody-cli.rs');
// The fixture lives in a directory named by its source and compiler, so a build never overwrites an executable another test process runs.
export const fixtureDir = rustFixtureDir(fixtureSource, join(artifactsRoot, 'provider-bin'));
export const fixtureExe = join(fixtureDir, 'codex.exe');

let artifacts = null;

// Builds the Host (Cargo decides what is current) and the provider fixture (reused when its digest-named build exists) once per test
// process. A failed build fails the test that needs it.
export function buildArtifacts() {
  if (artifacts) return artifacts;
  const host = spawnSync('cargo', ['build', '--manifest-path', 'lifecycle-host/Cargo.toml', '--bin', 'deszo-lifecycle-host'], { cwd: repo, encoding: 'utf8', timeout: 240_000 });
  if (host.status !== 0) throw new Error(`The Rust Lifecycle Host did not build:\n${host.stdout}\n${host.stderr}`);
  const fixtureSha256 = buildRustFixture(fixtureSource, fixtureExe);
  artifacts = { hostExe, fixtureExe, fixtureSha256 };
  return artifacts;
}

// Windows reports a killed child as a signal, not an exit code; either means the process is gone.
export function exited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function isAlive(pid) {
  if (!pid) return false;
  const result = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', windowsHide: true });
  return result.stdout.includes(String(pid));
}

export async function eventually(predicate, description, timeoutMs = 30_000, interval = 100) {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${description}.`);
    await sleep(interval);
  }
}

export function killProcessTree(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
}

// One authenticated request to the custody service, exactly as an Engine sends it (JSON line, capability, command, payload).
export async function custodyRequest(host, command, payload = {}) {
  const net = await import('node:net');
  return new Promise((resolvePromise, reject) => {
    const [address, port] = host.address.split(':');
    const socket = net.createConnection({ host: address, port: Number(port) });
    let data = '';
    const timeoutMs = command === 'custody.reserve' || command === 'custody.launch' ? 120_000
      : command === 'custody.source_identity' || command === 'custody.tool_identity' ? 60_000 : 10_000;
    socket.setTimeout(timeoutMs, () => { socket.destroy(); reject(new Error(`custody ${command} timed out`)); });
    socket.once('error', reject);
    // A Host that crashes mid-request closes the connection without a reply; the caller learns that at once.
    socket.once('close', () => reject(new Error(`custody ${command}: the Host closed the connection without a reply`)));
    socket.once('connect', () => socket.write(`${JSON.stringify({ capability: host.capability, command, payload })}\n`));
    socket.on('data', chunk => {
      data += chunk.toString('utf8');
      const newline = data.indexOf('\n');
      if (newline < 0) return;
      socket.destroy();
      const response = JSON.parse(data.slice(0, newline));
      if (response.ok) resolvePromise(response.result);
      else resolvePromise({ refused: true, code: response.code, message: response.error });
    });
  });
}

// The custody service: the Rust Host's custody component, started on its own with a known capability (a debug-build test hook).
export async function startCustodyHost(root, { generation = 'gen-1', permitTtlMs, spoolLimitBytes, testCrashAfterSpawn = false, testCrashAfterSpoolBytes, allowedExecutables = null,
  testFailRunningRecordAfterMs, testUndrainedDrainMs } = {}) {
  const { hostExe: exe, fixtureExe: fixture, fixtureSha256 } = buildArtifacts();
  const state = join(root, 'custody-state');
  mkdirSync(state, { recursive: true });
  const capability = randomBytes(32).toString('hex');
  const config = join(root, `custody-config-${randomUUID()}.json`);
  writeFileSync(config, JSON.stringify({ stateRoot: state, generation, capability, custody: {
    allowedExecutables: allowedExecutables ?? [{ path: fixture, sha256: fixtureSha256 }],
    ...(permitTtlMs === undefined ? {} : { permitTtlMs }), ...(spoolLimitBytes === undefined ? {} : { spoolLimitBytes }),
    ...(testCrashAfterSpawn ? { testCrashAfterSpawn: true } : {}), ...(testCrashAfterSpoolBytes === undefined ? {} : { testCrashAfterSpoolBytes }),
    ...(testFailRunningRecordAfterMs === undefined ? {} : { testFailRunningRecordAfterMs }), ...(testUndrainedDrainMs === undefined ? {} : { testUndrainedDrainMs }) } }));
  const endpoint = join(state, 'endpoint.json');
  if (existsSync(endpoint)) unlinkSync(endpoint);
  const child = spawn(exe, ['custody-serve', '--config', config], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  trackProcess(root, child);
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const address = await eventually(() => {
    if (exited(child)) throw new Error(`The custody Host exited (${child.exitCode ?? child.signalCode}): ${stderr}`);
    return existsSync(endpoint) ? JSON.parse(readFileSync(endpoint, 'utf8')).address : null;
  }, 'the custody Host endpoint', 45_000);
  const host = { child, address, capability, state, generation, pid: child.pid, stderr: () => stderr };
  host.request = (command, payload) => custodyRequest(host, command, payload);
  host.shutdown = async () => {
    if (exited(child)) return;
    child.stdin.write('shutdown\n');
    await eventually(() => exited(child), 'the custody Host to stop gracefully', 20_000);
  };
  host.crash = () => { if (!exited(child)) child.kill(); };
  return host;
}

// Attaches as a new Engine generation (epoch) and returns its epoch; every later command of the older generation is refused.
export async function attachEngine(host, runtimeInstanceId = randomUUID()) {
  const attached = await host.request('custody.attach', { generation: host.generation, runtimeInstanceId });
  if (attached.refused) throw new Error(`attach refused: ${attached.code} ${attached.message}`);
  return attached.epoch;
}

// A real Engine runtime. It is started from runtime/runner.mjs, reads its custody bootstrap from the environment, and
// publishes a connection descriptor. Its provider fixture is found on PATH.
export async function startEngine(root, host, { custody = true, fixtureStateDir, extraEnv = {}, fixtureProvider = true, isolateCodexHome = true,
  devTestConfirmationOff = false, extraArgs = [] } = {}) {
  const connectionFile = join(root, 'runtime', 'connection.json');
  mkdirSync(join(root, 'runtime'), { recursive: true });
  if (existsSync(connectionFile)) unlinkSync(connectionFile);
  // The provider's configuration home is an empty directory for the test: the managed-tool isolation check reads it, and the
  // developer's own configuration (which may hold Deszo bridge entries) must not decide the outcome of a fixture run.
  const codexHome = join(root, 'codex-home');
  mkdirSync(codexHome, { recursive: true });
  const env = { ...process.env, DESZO_PROCESS_CUSTODY: custody ? '1' : '0', ...extraEnv };
  if (fixtureProvider) env.PATH = `${fixtureDir}${delimiter}${process.env.PATH}`;
  if (fixtureStateDir) env.CUSTODY_FIXTURE_STATE_DIR = fixtureStateDir;
  else delete env.CUSTODY_FIXTURE_STATE_DIR;
  if (isolateCodexHome) env.CODEX_HOME = codexHome;
  if (custody) Object.assign(env, { DESZO_CUSTODY_ADDRESS: host.address, DESZO_CUSTODY_CAPABILITY: host.capability, DESZO_CUSTODY_GENERATION: host.generation });
  else for (const name of ['DESZO_CUSTODY_ADDRESS', 'DESZO_CUSTODY_CAPABILITY', 'DESZO_CUSTODY_GENERATION']) delete env[name];
  const args = ['--disable-warning=ExperimentalWarning', ...extraArgs, join(repo, 'runtime/runner.mjs'), '--root', root, '--connection-file', connectionFile,
    ...(devTestConfirmationOff ? ['--dev-test-confirmation-off'] : [])];
  const child = spawn(process.execPath, args,
    { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  trackProcess(root, child);
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', () => {});
  const connection = await eventually(() => {
    if (exited(child)) throw new Error(`The Engine exited (${child.exitCode ?? child.signalCode}): ${stderr}`);
    if (!existsSync(connectionFile)) return null;
    try { return JSON.parse(readFileSync(connectionFile, 'utf8')); } catch { return null; }
  }, 'the Engine connection descriptor', 60_000);
  const engine = { child, root, connection, pid: child.pid, stderr: () => stderr };
  engine.api = async (method, path, body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${connection.port}${path}`, { method,
      headers: { Authorization: `Bearer ${connection.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, etag: response.headers.get('etag'), body: text ? JSON.parse(text) : null };
  };
  engine.stop = async () => {
    if (exited(child)) return;
    child.stdin.write('{"command":"shutdown"}\n');
    await eventually(() => exited(child), 'the Engine to stop', 20_000).catch(() => killProcessTree(child.pid));
  };
  engine.kill = () => { if (!exited(child)) killProcessTree(child.pid); };
  return engine;
}

export function database(root) {
  return new DatabaseSync(join(root, 'store/state.sqlite'), { readOnly: true });
}

export function attemptsOf(root, runId) {
  const db = database(root);
  try {
    return db.prepare('SELECT id, state, process_id, process_start_identity FROM attempts WHERE run_id = ? ORDER BY rowid').all(runId).map(row => ({ ...row }));
  } finally { db.close(); }
}

export function custodyBindings(root, runId) {
  const db = database(root);
  try {
    return db.prepare('SELECT attempt_id, custody_id FROM attempt_custody WHERE run_id = ?').all(runId).map(row => ({ ...row }));
  } finally { db.close(); }
}

// The committed output chunks of one attempt stream, read from the Engine's own journal.
export function committedChunks(root, attemptId, stream) {
  const db = database(root);
  try {
    return db.prepare("SELECT envelope_json FROM journal_events WHERE attempt_id = ? AND event_type = 'attempt.log_chunk' ORDER BY sequence").all(attemptId)
      .map(row => JSON.parse(row.envelope_json).payload).filter(payload => payload.stream === stream)
      .sort((a, b) => a.chunkIndex - b.chunkIndex);
  } finally { db.close(); }
}

export function runEventTypes(root, runId) {
  const db = database(root);
  try {
    return db.prepare('SELECT event_type, attempt_id, envelope_json FROM journal_events WHERE run_id = ? ORDER BY sequence').all(runId)
      .map(row => ({ type: row.event_type, attemptId: row.attempt_id, payload: JSON.parse(row.envelope_json).payload }));
  } finally { db.close(); }
}

// Saves, validates and publishes one single-agent workflow, then starts a Run of its exact published version.
export async function startAgentRun(engine, { workflowId, model, requestText, workspaceId = 'main', workspaceCwd, timeoutSeconds = 120 }) {
  const ws = await engine.api('PUT', `/api/v2/workspaces/${workspaceId}`, { cwd: workspaceCwd });
  if (ws.status !== 200) throw new Error(`workspace refused: ${JSON.stringify(ws.body)}`);
  const definition = {
    schemaVersion: 1, workflowId, capabilities: ['core-v1'], settings: { nativeConfiguration: 'restricted' },
    nodes: [{ id: 'request', type: 'text', config: { value: requestText } },
      { id: 'agent', type: 'agent', config: { provider: 'codex', model, timeoutSeconds, output: { format: 'text' } } },
      { id: 'result', type: 'result-viewer', config: {} }],
    edges: [{ id: 'request-agent', source: { nodeId: 'request', port: 'text' }, target: { nodeId: 'agent', port: 'prompt' } },
      { id: 'agent-result', source: { nodeId: 'agent', port: 'text' }, target: { nodeId: 'result', port: 'value' } }],
    after: [],
  };
  const draft = await engine.api('PUT', `/api/v4/workflows/${workflowId}/draft`, { requestId: randomUUID(), workflow: definition }, { 'If-None-Match': '*' });
  if (draft.status !== 200) throw new Error(`draft refused: ${JSON.stringify(draft.body)}`);
  const validation = await engine.api('POST', `/api/v4/workflows/${workflowId}/draft/validate`, {}, { 'If-Match': draft.etag });
  if (validation.status !== 200 || validation.body.validation.valid !== true) throw new Error(`validation refused: ${JSON.stringify(validation.body)}`);
  const publication = await engine.api('POST', `/api/v4/workflows/${workflowId}/publish`, { requestId: randomUUID() }, { 'If-Match': draft.etag });
  if (publication.status !== 201) throw new Error(`publication refused: ${JSON.stringify(publication.body)}`);
  const started = await engine.api('POST', '/api/v2/runs', { workflowId, workflowSnapshotSha256: publication.body.snapshotSha256,
    publishedVersionId: publication.body.publishedVersionId, definitionDigest: publication.body.definitionDigest, workspaceId, requestId: randomUUID() });
  if (started.status !== 202) throw new Error(`run refused: ${JSON.stringify(started.body)}`);
  return { runId: started.body.run.runId, publishedVersionId: publication.body.publishedVersionId };
}

export async function runState(engine, runId) {
  const response = await engine.api('GET', `/api/v2/runs/${runId}`);
  return response.body?.run?.state ?? null;
}

export async function waitForRunState(engine, runId, states, timeoutMs = 60_000) {
  return eventually(async () => { const state = await runState(engine, runId); return states.includes(state) ? state : null; },
    `run ${runId} to reach ${states.join(' or ')}`, timeoutMs, 150);
}

export function readInvocations(fixtureStateDir) {
  const path = join(fixtureStateDir, 'invocations.log');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => { const [pid, model] = line.split(' '); return { pid: Number(pid), model }; });
}

export function newScratch(label) {
  mkdirSync(testsRoot, { recursive: true });
  const root = ownedDir(join(testsRoot, `custody-${label}-`));
  const fixtureState = join(root, 'fixture-state');
  mkdirSync(fixtureState, { recursive: true });
  mkdirSync(join(root, 'workspace'), { recursive: true });
  return { root, fixtureState, workspace: join(root, 'workspace') };
}

// A test-owned root goes through the verified removal (its tracked processes must have exited); a failure is reported at teardown.
export function cleanup(path) {
  if (isOwned(path)) { releaseOwnedDir(path); return; }
  try { rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* A held file is reported by the proof, not hidden here. */ }
}

export function copyFixtureFor(dir) { copyFileSync(fixtureExe, join(dir, 'codex.exe')); }

// The OS creation time of a process. A PID can be reused; the creation time is what identifies one process instance.
export function processIdentity(pid) {
  if (!pid) return null;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().ToString('o') }`],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return result.stdout.trim() || null;
}

// Saves, validates and publishes a complete workflow definition; returns the publication that a Run must name.
export async function publishDefinition(engine, definition) {
  const workflowId = definition.workflowId;
  const draft = await engine.api('PUT', `/api/v4/workflows/${workflowId}/draft`, { requestId: randomUUID(), workflow: definition }, { 'If-None-Match': '*' });
  if (draft.status !== 200) throw new Error(`draft refused: ${JSON.stringify(draft.body)}`);
  const validation = await engine.api('POST', `/api/v4/workflows/${workflowId}/draft/validate`, {}, { 'If-Match': draft.etag });
  if (validation.status !== 200 || validation.body.validation.valid !== true) throw new Error(`validation refused: ${JSON.stringify(validation.body)}`);
  const publication = await engine.api('POST', `/api/v4/workflows/${workflowId}/publish`, { requestId: randomUUID() }, { 'If-Match': draft.etag });
  if (publication.status !== 201) throw new Error(`publication refused: ${JSON.stringify(publication.body)}`);
  return publication.body;
}

// A single-agent workflow whose failing or launching node carries a stable identity.
export function agentDefinition({ workflowId, nodeId = 'agent', model, requestText, role = null }) {
  return {
    schemaVersion: 1, workflowId, capabilities: ['core-v1'], settings: { nativeConfiguration: 'restricted' },
    nodes: [{ id: 'request', type: 'text', config: { value: requestText } },
      { id: nodeId, type: 'agent', config: { provider: 'codex', model, timeoutSeconds: 120, output: { format: 'text' }, ...(role ? { role } : {}) } },
      { id: 'result', type: 'result-viewer', config: {} }],
    edges: [{ id: 'request-agent', source: { nodeId: 'request', port: 'text' }, target: { nodeId, port: 'prompt' } },
      { id: 'agent-result', source: { nodeId, port: 'text' }, target: { nodeId: 'result', port: 'value' } }],
    after: [],
  };
}

export async function registerWorkspace(engine, workspaceId, cwd) {
  mkdirSync(cwd, { recursive: true });
  const response = await engine.api('PUT', `/api/v2/workspaces/${workspaceId}`, { cwd });
  if (response.status !== 200) throw new Error(`workspace ${workspaceId} refused: ${JSON.stringify(response.body)}`);
}

export async function startPublishedRun(engine, publication, workspaceId) {
  const started = await engine.api('POST', '/api/v2/runs', { workflowId: publication.workflow.workflowId, workflowSnapshotSha256: publication.snapshotSha256,
    publishedVersionId: publication.publishedVersionId, definitionDigest: publication.definitionDigest, workspaceId, requestId: randomUUID() });
  if (started.status !== 202) throw new Error(`run refused: ${JSON.stringify(started.body)}`);
  return started.body.run.runId;
}

// Sets the provider capacity the scheduler honours. A Run's provider slot is held while its CLI runs.
export async function setCodexCapacity(engine, { codex, global }) {
  const current = await engine.api('GET', '/api/v2/settings');
  if (current.status !== 200) throw new Error('settings unavailable');
  const updated = await engine.api('PUT', '/api/v2/settings', { requestId: randomUUID(), expectedRevision: current.body.revision,
    settings: { ...current.body.settings, globalLimit: global, providerLimits: { ...current.body.settings.providerLimits, codex, claude: 1, antigravity: 1 } } });
  if (updated.status !== 200) throw new Error(`settings refused: ${JSON.stringify(updated.body)}`);
}

// Every custody record the Host has written, read from its durable state (names and states only, never credentials).
export function hostRecords(host) {
  const dir = join(host.state, 'custody', 'attempts');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(dir, name), 'utf8')));
}

// A directory alias as Windows creates it (a junction, which needs no elevation), replacing whatever the alias pointed to.
export function retargetJunction(alias, target) {
  if (existsSync(alias)) rmSync(alias, { recursive: true, force: true });
  const result = spawnSync('cmd', ['/c', 'mklink', '/J', alias, target], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`junction could not be created: ${result.stderr || result.stdout}`);
}
