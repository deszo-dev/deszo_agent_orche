// Proof B exercises the independently compiled Rust Host and the repository's real release Tauri executable.
// WebView2's temporary loopback CDP endpoint is used only to obtain the same connection the bundled UI obtains;
// all workflow setup then uses the Engine's normal first-party API. After Host acceptance this test only observes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { buildRustFixture, desktopPackageKey, recordDesktopPackage, rustFixtureDir, verifiedDesktopPackage } from './build-cache.mjs';
import { ownedDir, trackProcess } from './test-roots.mjs';

const repo = resolve(import.meta.dirname, '../..');
const testsRoot = join(repo, '.deszo/tests');
const artifactRoot = join(testsRoot, 'desktop-host-proof-b-artifacts');
const hostExe = join(repo, 'lifecycle-host/target/debug', process.platform === 'win32' ? 'deszo-lifecycle-host.exe' : 'deszo-lifecycle-host');
const buildAId = 'build-a';
const buildBId = 'build-b';
const checkpointId = 'chk-desktop-host-proof-b';
let artifactsPromise;
// DESZO_PROOFB_KEEP_ARTIFACTS=1 keeps every installation root, so its roots are then ordinary directories, not test-owned ones.
const testRoot = prefix => (process.env.DESZO_PROOFB_KEEP_ARTIFACTS === '1' ? mkdtempSync(prefix) : ownedDir(prefix));

const agent = (id, model, extra = {}) => ({ id, type: 'agent', config: { provider: 'codex', model, timeoutSeconds: 120, output: { format: 'text' }, ...extra } });
const edge = (id, source, sourcePort, target, targetPort) => ({ id, source: { nodeId: source, port: sourcePort }, target: { nodeId: target, port: targetPort } });
const workflow = (workflowId, nodes, edges) => ({ schemaVersion: 1, workflowId, capabilities: ['core-v1'], settings: { nativeConfiguration: 'restricted' },
  nodes: [{ id: 'request', type: 'text', config: { value: `${workflowId} request` } }, ...nodes, { id: 'result', type: 'result-viewer', config: {} }], edges, after: [] });
const parentWorkflow = () => workflow('parent-host-proof-b', [agent('developer', 'fixture-echo'), agent('watcher', 'fixture-fail-once'), agent('judge', 'fixture-echo')], [
  edge('request-developer', 'request', 'text', 'developer', 'prompt'), edge('developer-watcher', 'developer', 'text', 'watcher', 'prompt'),
  edge('watcher-judge', 'watcher', 'text', 'judge', 'prompt'), edge('judge-result', 'judge', 'text', 'result', 'value'),
]);
const repairWorkflow = () => workflow('repair-host-proof-b', [agent('developer', 'fixture-echo'), agent('watcher', 'fixture-echo'),
  agent('judge', 'fixture-lifecycle-proposal', { role: 'judge' }), agent('finalize', 'fixture-echo')], [
  edge('request-developer', 'request', 'text', 'developer', 'prompt'), edge('developer-watcher', 'developer', 'text', 'watcher', 'prompt'),
  edge('watcher-judge', 'watcher', 'text', 'judge', 'prompt'), edge('judge-finalize', 'judge', 'text', 'finalize', 'prompt'),
  edge('finalize-result', 'finalize', 'text', 'result', 'value'),
]);
const slowWorkflow = () => workflow('provider-tree-host-proof-b', [agent('slow-provider', 'fixture-slow-child')], [
  edge('request-slow', 'request', 'text', 'slow-provider', 'prompt'), edge('slow-result', 'slow-provider', 'text', 'result', 'value'),
]);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
  return result;
}

async function runDesktopBuild(buildId, logPath) {
  const env = { ...process.env, DESZO_DESKTOP_BUILD_ID: buildId,
    DESZO_TAURI_CONFIG_OVERLAY: join(artifactRoot, 'tauri-proofb-debug.json') };
  const result = run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run desktop:build'], { env, timeout: 600_000, windowsHide: true });
  await writeFile(logPath, `${result.stdout || ''}\n${result.stderr || ''}`);
  assert.equal(result.status, 0, `npm run desktop:build (${buildId}) failed: ${result.error || ''}\n${result.stdout}\n${result.stderr}`);
}

async function makeDesktopArtifacts() {
  assert.equal(process.platform, 'win32', 'the real Tauri executable proof requires Windows and WebView2');
  await mkdir(testsRoot, { recursive: true });
  await mkdir(artifactRoot, { recursive: true });
  const hostBuild = run('cargo', ['build', '--manifest-path', 'lifecycle-host/Cargo.toml', '--bin', 'deszo-lifecycle-host'], { timeout: 120_000 });
  assert.equal(hostBuild.status, 0, `${hostBuild.stdout}\n${hostBuild.stderr}`);
  const fixtureSource = join(repo, 'runtime/tests/fixtures/proofb-cli.rs');
  const fixtureCli = join(rustFixtureDir(fixtureSource, join(artifactRoot, 'provider-fixture-bin')), 'codex.exe');
  buildRustFixture(fixtureSource, fixtureCli);

  const tauriConfig = JSON.parse(await readFile(join(repo, 'src-tauri/tauri.conf.json'), 'utf8'));
  tauriConfig.app.windows[0].additionalBrowserArgs = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port=0';
  await writeFile(join(artifactRoot, 'tauri-proofb-debug.json'), JSON.stringify(tauriConfig, null, 2));

  // Build A and Build B differ only in their compiled build identity, so each needs its own release build. A package built earlier from
  // exactly the same repository inputs, toolchain and overlay is reused after its executable and candidate digests are verified again.
  // DESZO_TEST_REBUILD_DESKTOP=1 always builds.
  const executable = join(repo, 'src-tauri/target/release/deszo.exe');
  const runtime = join(repo, 'dist-runtime');
  const packages = [];
  for (const [label, buildId] of [['a', buildAId], ['b', buildBId]]) {
    const packageRoot = join(artifactRoot, `desktop-build-${label}`);
    const key = desktopPackageKey({ buildId, overlay: tauriConfig });
    const reused = process.env.DESZO_TEST_REBUILD_DESKTOP === '1' ? { hit: false, reason: 'rebuild requested' } : await verifiedDesktopPackage(packageRoot, key, digestCandidate);
    if (reused.hit) {
      packages.push({ label, buildId, packageRoot, executable: join(packageRoot, 'deszo.exe'), runtime: join(packageRoot, 'runtime'),
        exeSha256: reused.exeSha256, packageDigest: reused.packageDigest, cache: { hit: true, key } });
      continue;
    }
    await rm(`${packageRoot}.cache.json`, { force: true });
    const started = Date.now();
    await runDesktopBuild(buildId, join(artifactRoot, `desktop-${label}-build.log`));
    await rm(packageRoot, { recursive: true, force: true });
    await mkdir(packageRoot, { recursive: true });
    await cp(executable, join(packageRoot, 'deszo.exe'));
    await cp(runtime, join(packageRoot, 'runtime'), { recursive: true });
    await writeFile(join(packageRoot, 'build.json'), JSON.stringify({ schemaVersion: 1, buildId, runtimeApiVersion: 2,
      bootstrap: 'tauri', desktopExecutable: 'deszo.exe', desktopBuildId: buildId }));
    const built = { label, buildId, packageRoot, executable: join(packageRoot, 'deszo.exe'), runtime: join(packageRoot, 'runtime'),
      exeSha256: await fileSha256(join(packageRoot, 'deszo.exe')), packageDigest: await digestCandidate(packageRoot),
      cache: { hit: false, key, reason: reused.reason, buildMs: Date.now() - started } };
    // Recorded for reuse only when no input changed while the build ran.
    if (desktopPackageKey({ buildId, overlay: tauriConfig }) === key)
      recordDesktopPackage(packageRoot, { key, buildId, exeSha256: built.exeSha256, packageDigest: built.packageDigest });
    packages.push(built);
  }
  assert.notEqual(packages[0].exeSha256, packages[1].exeSha256, 'build-time desktop identity changed the actual compiled executable');
  assert.notEqual(packages[0].packageDigest, packages[1].packageDigest, 'desktop package contents differ');
  return { packages, fixtureCli };
}

function desktopArtifacts() {
  artifactsPromise ??= makeDesktopArtifacts();
  return artifactsPromise;
}

async function digestCandidate(path) {
  const result = run(hostExe, ['digest-candidate', '--path', path], { timeout: 30_000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const digest = result.stdout.trim();
  assert.match(digest, /^[a-f0-9]{64}$/);
  return digest;
}

async function fileSha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function createPackage(source, destination, buildId) {
  await mkdir(destination, { recursive: true });
  await cp(source.executable, join(destination, 'deszo.exe'));
  await cp(source.runtime, join(destination, 'runtime'), { recursive: true });
  await writeFile(join(destination, 'build.json'), JSON.stringify({ schemaVersion: 1, buildId, runtimeApiVersion: 2,
    bootstrap: 'tauri', desktopExecutable: 'deszo.exe', desktopBuildId: buildId }));
}

async function prepareInstallation(tag, artifacts, { damageCandidate = null, swapCandidateExeToA = false, readyTimeoutMs, custody = false } = {}) {
  const root = testRoot(join(testsRoot, `desktop-host-proof-b-${tag}-`));
  const installation = join(root, 'installation');
  const profile = join(root, 'profile-a');
  const profileB = join(root, 'profile-b');
  const staging = join(installation, 'staging');
  const versions = join(installation, 'versions');
  const buildA = join(versions, 'build-a');
  const candidateB = join(staging, 'build-b');
  const fixtureState = join(root, 'fixture-state');
  const webviewRoot = join(root, 'webview2');
  const codexHome = join(root, 'codex-home');
  await Promise.all([mkdir(buildA, { recursive: true }), mkdir(candidateB, { recursive: true }), mkdir(profile, { recursive: true }),
    mkdir(profileB, { recursive: true }), mkdir(staging, { recursive: true }), mkdir(fixtureState, { recursive: true }),
    mkdir(webviewRoot, { recursive: true }), mkdir(codexHome, { recursive: true })]);
  await createPackage(artifacts.packages[0], buildA, 'build-a');
  await createPackage(artifacts.packages[1], candidateB, 'build-b');
  if (swapCandidateExeToA) await cp(artifacts.packages[0].executable, join(candidateB, 'deszo.exe'), { force: true });
  if (damageCandidate === 'missing-shim') await rm(join(candidateB, 'runtime/deszo-launch-shim.exe'));
  if (damageCandidate === 'broken-runner') {
    const runnerPath = join(candidateB, 'runtime/runner.mjs');
    await writeFile(runnerPath, "throw new Error('Proof B deliberately broken Engine bootstrap');\n");
    const resourceManifestPath = join(candidateB, 'runtime/runtime-manifest.json');
    const resourceManifest = JSON.parse(await readFile(resourceManifestPath, 'utf8'));
    resourceManifest.files['runner.mjs'] = await fileSha256(runnerPath);
    await writeFile(resourceManifestPath, JSON.stringify(resourceManifest, null, 2));
  }
  const candidateDigest = await digestCandidate(candidateB);
  // Custody allowlist: the only executable the Host may launch for a provider is the proof's provider fixture, by digest.
  const custodyConfig = custody ? { allowedExecutables: [{ path: artifacts.fixtureCli, sha256: await fileSha256(artifacts.fixtureCli) }] } : null;
  const hostConfig = profileRoot => ({ installationRoot: installation, profileRoot, stagingRoot: staging, nodeExecutable: process.execPath,
    initialBuildId: 'build-a', testDuplicateReceiptDelivery: true,
    ...(readyTimeoutMs ? { testEngineReadyTimeoutMs: readyTimeoutMs } : {}),
    ...(custodyConfig ? { custody: custodyConfig } : {}) });
  const configPath = join(root, 'host-config-profile-a.json');
  await writeFile(configPath, JSON.stringify(hostConfig(profile)));
  return { root, installation, profile, profileB, staging, fixtureState, webviewRoot, codexHome, buildA, candidateB,
    candidateDigest, configPath, hostConfig };
}

function hostProcess(configPath, fixtureCli, fixtureState, webviewRoot, { custody = false } = {}) {
  const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') || 'PATH';
  const env = { ...process.env,
    [pathKey]: `${join(fixtureCli, '..')}${delimiter}${process.env[pathKey] || ''}`,
    DESZO_PROOFB_FIXTURE_STATE: fixtureState,
    CODEX_HOME: join(webviewRoot, '..', 'codex-home'),
    WEBVIEW2_USER_DATA_FOLDER: webviewRoot,
    // Process Custody (PoC): the Engines of this installation launch provider CLIs through the Host's custody service.
    ...(custody ? { DESZO_PROCESS_CUSTODY: '1' } : {}),
  };
  const child = spawn(hostExe, ['run', '--config', configPath], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  trackProcess(configPath, child);
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  let stdoutText = '', stderrText = '';
  child.stdout.on('data', chunk => { stdoutText += chunk; });
  child.stderr.on('data', chunk => { stderrText += chunk; });
  return { child, get stdoutText() { return stdoutText; }, get stderrText() { return stderrText; } };
}

async function stopHost(host, timeoutMs = 25_000) {
  if (!host || host.child.exitCode !== null) return;
  host.child.stdin.write('shutdown\n');
  let timer;
  await Promise.race([
    new Promise(resolvePromise => host.child.once('exit', resolvePromise)),
    new Promise(resolvePromise => { timer = setTimeout(resolvePromise, timeoutMs); }),
  ]);
  clearTimeout(timer);
  if (host.child.exitCode === null) host.child.kill();
}

async function apiCall(connection, method, path, body, token = connection.firstPartyToken, extraHeaders = {}) {
  const response = await fetch(`http://127.0.0.1:${connection.port}${path}`, { method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(12_000) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function cdpConnection(webviewRoot, host, timeoutMs = 30_000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    if (host.child.exitCode !== null) throw new Error(`Rust Host exited before WebView2 connected (${host.child.exitCode}): ${host.stderrText}`);
    try {
      const portFile = join(webviewRoot, buildAId, 'EBWebView/DevToolsActivePort');
      const port = Number((await readFile(portFile, 'utf8')).split(/\r?\n/, 1)[0]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WebView2 DevToolsActivePort is malformed');
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl);
        if (page) {
          const socket = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise((resolvePromise, reject) => { socket.addEventListener('open', resolvePromise, { once: true }); socket.addEventListener('error', reject, { once: true }); });
          let sequence = 0;
          const invoke = expression => new Promise((resolvePromise, reject) => {
            const id = ++sequence;
            const timer = setTimeout(() => { socket.close(); reject(new Error('WebView2 UI connection invoke timed out.')); }, 15_000);
            const onMessage = event => {
              const message = JSON.parse(String(event.data));
              if (message.id !== id) return;
              socket.removeEventListener('message', onMessage); clearTimeout(timer);
              if (message.error) return reject(new Error(message.error.message));
              const result = message.result?.result;
              if (message.result?.exceptionDetails) return reject(new Error(message.result.exceptionDetails.exception?.description || 'WebView2 UI invoke failed'));
              resolvePromise(result?.value);
            };
            socket.addEventListener('message', onMessage);
            socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }));
          });
          const value = await invoke(`(async () => { if (!window.__TAURI_INTERNALS__?.invoke) throw new Error('Tauri invoke bridge is unavailable'); return await window.__TAURI_INTERNALS__.invoke('get_runner_connection'); })()`);
          socket.close();
          assert.ok(value?.firstPartyToken, 'the bundled UI returns its normal first-party Engine connection');
          return value;
        }
      }
    } catch (error) { lastError = error; }
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`Tauri WebView2 UI did not expose its normal runner connection: ${lastError || 'debug endpoint absent'}; Host: ${host.stderrText}`);
}

async function desktopConnection(profile, expectedBuildId, host, timeoutMs = 45_000) {
  const file = join(profile, 'runtime/connection.json');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (host.child.exitCode !== null) throw new Error(`Rust Host exited before ${expectedBuildId} Engine readiness (${host.child.exitCode}): ${host.stderrText}`);
    try {
      const value = JSON.parse(await readFile(file, 'utf8'));
      if (value.applicationBuildId === expectedBuildId) return value;
    } catch { /* The production Engine has not published its connection descriptor yet. */ }
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`${expectedBuildId} Engine did not publish its profile descriptor. Host: ${host.stderrText}`);
}

function hostEvents(installation) {
  try {
    const text = readFileSync(join(installation, '.deszo-host/operations.ndjson'), 'utf8').trim();
    return text ? text.split(/\r?\n/).map(line => JSON.parse(line)) : [];
  } catch { return []; }
}

async function eventually(predicate, description, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise(done => setTimeout(done, 50));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function waitForHostEvent(host, installation, predicate, timeoutMs = 30_000) {
  await eventually(() => {
    if (host.child.exitCode !== null) throw new Error(`Rust Host exited (${host.child.exitCode}): ${host.stderrText}`);
    return hostEvents(installation).some(predicate);
  }, 'the expected Rust Host journal event', timeoutMs);
  return hostEvents(installation).find(predicate);
}

async function waitForRun(connection, runId, predicate, timeoutMs = 60_000, token = connection.token) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await apiCall(connection, 'GET', `/api/v2/runs/${runId}`, undefined, token);
      if (response.status === 200 && predicate(response.body)) return response.body;
    } catch { /* The Host may be replacing the app and its loopback listener. */ }
    await new Promise(done => setTimeout(done, 120));
  }
  throw new Error(`Run ${runId} did not reach its expected state.`);
}

async function saveWorkflow(connection, definition) {
  const draft = await apiCall(connection, 'PUT', `/api/v4/workflows/${definition.workflowId}/draft`, {
    requestId: randomUUID(), workflow: definition,
  }, connection.firstPartyToken, { 'If-None-Match': '*' });
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  const validation = await apiCall(connection, 'POST', `/api/v4/workflows/${definition.workflowId}/draft/validate`, {},
    connection.firstPartyToken, { 'If-Match': draft.body.etag });
  assert.equal(validation.status, 200, JSON.stringify(validation.body));
  assert.equal(validation.body.validation.valid, true, JSON.stringify(validation.body.validation));
  const publication = await apiCall(connection, 'POST', `/api/v4/workflows/${definition.workflowId}/publish`, { requestId: randomUUID() },
    connection.firstPartyToken, { 'If-Match': draft.body.etag });
  assert.equal(publication.status, 201, JSON.stringify(publication.body));
  return publication.body;
}

async function runWorkflow(connection, saved, workspaceId) {
  const response = await apiCall(connection, 'POST', '/api/v2/runs', {
    workflowId: saved.workflow.workflowId, workflowSnapshotSha256: saved.snapshotSha256,
    publishedVersionId: saved.publishedVersionId, definitionDigest: saved.definitionDigest, workspaceId, requestId: randomUUID(),
  }, connection.firstPartyToken);
  assert.equal(response.status, 202, JSON.stringify(response.body));
  return response.body.run.runId;
}

async function setUpLinkedFlows(connection, profile, candidateDigest) {
  for (const id of ['main', 'main-repair', 'provider-tree']) {
    const created = await apiCall(connection, 'PUT', `/api/v2/workspaces/${id}`, { cwd: join(connection.scratchRoot, id) });
    assert.equal(created.status, 200, JSON.stringify(created.body));
  }
  const settings = await apiCall(connection, 'GET', '/api/v2/settings');
  assert.equal(settings.status, 200);
  const updated = await apiCall(connection, 'PUT', '/api/v2/settings', { requestId: randomUUID(), expectedRevision: settings.body.revision,
    settings: { ...settings.body.settings, globalLimit: 3, providerLimits: { codex: 3, claude: 1, antigravity: 1 } } });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));

  await writeFile(join(connection.scratchRoot, 'main-repair/candidate.json'), JSON.stringify({ candidateId: 'build-b', candidateDigest, continuationCheckpointId: checkpointId }));
  const parent = await saveWorkflow(connection, parentWorkflow());
  const repair = await saveWorkflow(connection, repairWorkflow());
  const slow = await saveWorkflow(connection, slowWorkflow());
  const parentRunId = await runWorkflow(connection, parent, 'main');
  await waitForRun(connection, parentRunId, body => body.run.state === 'waiting_for_user', 60_000, connection.firstPartyToken);

  const sideRunId = await runWorkflow(connection, slow, 'provider-tree');
  const fixtureState = join(profile, '..', 'fixture-state');
  const providerPidPath = join(fixtureState, 'slow-provider.pid');
  const descendantPidPath = join(fixtureState, 'slow-descendant.pid');
  try { await eventually(() => existsSync(providerPidPath) && existsSync(descendantPidPath), 'the contained provider child process'); }
  catch (error) {
    const db = new DatabaseSync(join(profile, 'store/state.sqlite'), { readOnly: true });
    let diagnostic;
    try {
      const attempts = db.prepare(`SELECT a.id, a.run_id, n.node_id, a.state, a.ordinal, a.exit_code, a.invocation_artifact_id
        FROM attempts a JOIN node_instances n ON n.run_id = a.run_id AND n.id = a.node_instance_id ORDER BY a.rowid`).all();
      const invocationArtifacts = attempts.filter(item => item.invocation_artifact_id).map(item => ({ attemptId: item.id,
        manifest: JSON.parse(readFileSync(join(profile, 'store', db.prepare('SELECT relative_path FROM artifacts WHERE id = ?')
          .get(item.invocation_artifact_id).relative_path), 'utf8')) }));
      diagnostic = { runs: db.prepare('SELECT id, workflow_id, workspace_id, state FROM runs ORDER BY created_at').all(), attempts,
        invocationArtifacts, recentJournal: db.prepare('SELECT event_type, envelope_json FROM journal_events ORDER BY timestamp DESC LIMIT 20').all()
          .reverse().map(item => ({ type: item.event_type, payload: JSON.parse(item.envelope_json).payload })) };
    } finally { db.close(); }
    let runnerLog = '';
    try { runnerLog = readFileSync(join(profile, 'runtime/runner.log'), 'utf8').slice(-8_000); } catch { /* Runtime log may not exist. */ }
    let fixtureFiles = [];
    try { fixtureFiles = await readdir(fixtureState); } catch { /* Fixture output may not exist. */ }
    throw new Error(`${error.message}\nProof B provider diagnostic: ${JSON.stringify({ ...diagnostic, fixtureFiles, runnerLog }, null, 2)}`);
  }
  const providerPid = Number(await readFile(providerPidPath, 'utf8'));
  const descendantPid = Number(await readFile(descendantPidPath, 'utf8'));

  const linked = await apiCall(connection, 'POST', `/api/v2/runs/${parentRunId}/linked-repair`, { requestId: randomUUID(),
    failedNodeInstanceId: 'watcher', repairWorkflowId: repair.workflow.workflowId, repairWorkflowSnapshotSha256: repair.snapshotSha256,
    repairWorkspaceId: 'main-repair', candidateDigest, continuationCheckpointId: checkpointId });
  assert.equal(linked.status, 202, JSON.stringify(linked.body));
  const repairRunId = linked.body.repairRunId;
  await waitForRun(connection, repairRunId, body => body.run.state === 'waiting_for_user'
    && body.instances.find(item => item.nodeId === 'judge')?.state === 'succeeded', 60_000, connection.firstPartyToken);
  const db = databaseView(profile);
  const operation = db.operations.find(item => item.run_id === repairRunId);
  assert.ok(operation && operation.state === 'intent', 'production Engine Judge logic persisted the lifecycle intent');
  return { parentRunId, repairRunId, sideRunId, operation, providerPid, descendantPid };
}

function databaseView(profile) {
  const db = new DatabaseSync(join(profile, 'store/state.sqlite'), { readOnly: true });
  try {
    const runs = db.prepare('SELECT id, workflow_id, workspace_id, state FROM runs ORDER BY created_at').all().map(row => ({ ...row }));
    const attempts = db.prepare(`SELECT a.id, a.run_id, n.id AS node_instance_id, n.node_id, a.state, a.ordinal, a.invocation_artifact_id IS NOT NULL AS invoked
      FROM attempts a JOIN node_instances n ON n.run_id = a.run_id AND n.id = a.node_instance_id ORDER BY a.rowid`).all().map(row => ({ ...row, invoked: Boolean(row.invoked) }));
    const operations = db.prepare('SELECT * FROM lifecycle_operations').all().map(row => {
      const artifact = db.prepare('SELECT relative_path FROM artifacts WHERE id = ?').get(row.proposal_artifact_id);
      return { ...row, proposal: JSON.parse(readFileSync(join(profile, 'store', artifact.relative_path), 'utf8')) };
    });
    const links = db.prepare('SELECT * FROM run_links').all().map(row => ({ ...row }));
    const journal = db.prepare('SELECT run_id, sequence, event_type, envelope_json FROM journal_events ORDER BY timestamp, run_id, sequence').all()
      .map(row => ({ runId: row.run_id, sequence: row.sequence, type: row.event_type, payload: JSON.parse(row.envelope_json).payload }));
    return { runs, attempts, operations, links, journal };
  } finally { db.close(); }
}

async function readHostState(installation) {
  const profileStates = join(installation, '.deszo-host/profiles');
  const keys = await readdir(profileStates);
  assert.equal(keys.length, 1, 'this installation has one profile state owner');
  return JSON.parse(await readFile(join(profileStates, keys[0], 'lifecycle.json'), 'utf8'));
}

// The OS creation time of a process, in milliseconds. PID equality alone does not identify a process instance.
function processCreationMs(pid) {
  if (!pid) return null;
  const script = `$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().ToString('o') }`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  const text = result.stdout.trim();
  return text ? Date.parse(text) : null;
}

// The Host records a process creation time as a Windows FILETIME (100 ns ticks since 1601); convert it to milliseconds.
function filetimeMs(ticks) {
  return Number(BigInt(ticks) / 10000n) - 11644473600000;
}

// The lifecycle generation each application build was spawned under, from the Host's own journal.
function appSpawnGenerations(events) {
  return Object.fromEntries(events.filter(item => item.type === 'application_spawned').map(item => [item.payload.buildId, item.payload.generation]));
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

const removeTestRoot = path => rm(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });

async function runFreshProof(iteration, artifacts, { custody = false } = {}) {
  const prepared = await prepareInstallation(`run-${iteration}`, artifacts, { custody });
  const host = hostProcess(prepared.configPath, artifacts.fixtureCli, prepared.fixtureState, prepared.webviewRoot, { custody });
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  let proofPassed = false;
  let custodyTree = null;
  try {
    const connectionFileA = await desktopConnection(prepared.profile, buildAId, host);
    const uiA = await cdpConnection(prepared.webviewRoot, host);
    const appA = hostEvents(prepared.installation).find(item => item.type === 'application_spawned' && item.payload.buildId === buildAId);
    assert.equal(connectionFileA.applicationBuildId, buildAId);
    assert.equal(uiA.applicationPid, Number(appA.payload.pid));
    assert.equal(uiA.storeId, connectionFileA.storeId);
    assert.equal(uiA.port, connectionFileA.port);
    const hostPid = host.child.pid;
    const readyA = hostEvents(prepared.installation).find(item => item.type === 'engine_ready' && item.payload.buildId === 'build-a');
    assert.ok(appA && readyA, `Tauri Build A and its production Engine reached readiness: ${host.stderrText}`);
    assert.equal(appA.payload.bootstrap, 'tauri');
    assert.equal(readyA.payload.applicationPid, appA.payload.pid);
    assert.notEqual(readyA.payload.enginePid, readyA.payload.applicationPid, 'Engine A is a child of the actual Tauri A process');

    const competitorConfig = join(prepared.root, 'host-config-profile-b.json');
    await writeFile(competitorConfig, JSON.stringify(prepared.hostConfig(prepared.profileB)));
    const competitor = run(hostExe, ['run', '--config', competitorConfig], { timeout: 10_000 });
    assert.notEqual(competitor.status, 0, 'a second profile cannot acquire desktop installation ownership');
    assert.match(competitor.stderr, /already owns this desktop installation/);
    assert.equal(existsSync(join(prepared.profileB, 'runtime')), false, 'the rejected Host did not start an Engine in Profile B');

    const flows = await setUpLinkedFlows(uiA, prepared.profile, prepared.candidateDigest);
    // The OS creation times are taken before activation, so that a later match is the same process instance, not a reused PID.
    custodyTree = custody ? { providerPid: flows.providerPid, descendantPid: flows.descendantPid, providerAtLaunchMs: processCreationMs(flows.providerPid),
      descendantAtLaunchMs: processCreationMs(flows.descendantPid) } : null;
    await waitForHostEvent(host, prepared.installation, item => item.type === 'activation_accepted' && item.payload.operationId === flows.operation.id);

    // The authenticated operation has been accepted. From here the harness only reads the Host journal, descriptors,
    // process liveness and SQLite state; the Host and Engines perform shutdown, activation, receipt and continuation.
    const appBEvent = await waitForHostEvent(host, prepared.installation, item => item.type === 'application_spawned' && item.payload.buildId === 'build-b');
    const connectionFileB = await desktopConnection(prepared.profile, buildBId, host, 60_000);
    const repairDone = await waitForRun({ ...connectionFileB, firstPartyToken: undefined }, flows.repairRunId,
      body => body.run.state === 'succeeded', 90_000, connectionFileB.token);
    const parentDone = await waitForRun({ ...connectionFileB, firstPartyToken: undefined }, flows.parentRunId,
      body => body.run.state === 'succeeded', 90_000, connectionFileB.token);
    await waitForHostEvent(host, prepared.installation, item => item.type === 'receipt_acknowledged');

    assert.equal(connectionFileB.applicationBuildId, buildBId);
    assert.equal(connectionFileB.applicationPid, appBEvent.payload.pid);
    assert.notEqual(connectionFileB.applicationPid, connectionFileA.applicationPid, 'the actual Tauri process changed');
    assert.notEqual(readyA.payload.enginePid, hostEvents(prepared.installation).find(item => item.type === 'engine_ready' && item.payload.buildId === buildBId).payload.enginePid,
      'the production Engine process changed');
    assert.equal(connectionFileB.storeId, connectionFileA.storeId, 'the SQLite store identity survived the desktop restart');
    assert.notEqual(connectionFileB.runtimeInstanceId, connectionFileA.runtimeInstanceId);
    assert.equal(isAlive(hostPid), true, 'the real Rust Host process survived Tauri A and Tauri B');
    assert.equal(isAlive(unrelated.pid), true, 'the Host job did not affect an unrelated sibling process');
    if (custody) {
      // Process Custody: the provider CLI and its descendant belong to the Host's own Job, not to Tauri A's tree.
      assert.equal(isAlive(flows.providerPid), true, 'the Custody-owned provider CLI survived the Tauri A to Tauri B replacement');
      assert.equal(isAlive(flows.descendantPid), true, 'the Custody-owned provider descendant survived with its CLI');
    } else {
      assert.equal(isAlive(flows.providerPid), false, 'the active provider CLI stopped with Tauri A');
      assert.equal(isAlive(flows.descendantPid), false, 'the provider descendant stopped with Tauri A');
    }
    assert.equal(repairDone.run.state, 'succeeded');
    assert.equal(parentDone.run.state, 'succeeded');

    const view = databaseView(prepared.profile);
    const verified = view.operations.find(item => item.id === flows.operation.id);
    assert.equal(verified.state, 'verified');
    assert.equal(verified.candidate_digest, prepared.candidateDigest);
    assert.equal(verified.target_version, 'build-b');
    assert.equal(flows.operation.proposal.engineValidatedRole, 'judge');
    assert.equal(flows.operation.proposal.kind, 'LifecycleProposal');
    assert.equal(flows.operation.proposal.operationId, flows.operation.id);
    assert.equal(flows.operation.proposal.runId, flows.repairRunId);
    assert.equal(flows.operation.proposal.candidateDigest, prepared.candidateDigest);
    assert.equal(flows.operation.proposal.targetVersion, 'build-b');
    assert.ok(view.attempts.some(item => item.id === flows.operation.proposal.attemptId && item.node_instance_id === flows.operation.proposal.nodeInstanceId
      && item.node_id === 'judge' && item.run_id === flows.repairRunId), 'the lifecycle intent references the successful production Judge attempt');
    assert.equal(view.links.find(item => item.repair_run_id === flows.repairRunId).state, 'resumed');
    assert.equal(view.journal.filter(item => item.type === 'continuation.parent_resumed').length, 1);
    assert.equal(view.journal.filter(item => item.type === 'continuation.lifecycle_verified').length, 1);
    assert.equal(view.attempts.filter(item => item.node_id === 'developer' && [flows.parentRunId, flows.repairRunId].includes(item.run_id)).length, 2,
      'committed Parent and Repair work did not repeat');
    if (custody) {
      // The concurrently active workspace is not interrupted: its attempt continues under Tauri B, bound to the same process.
      assert.notEqual(view.runs.find(item => item.id === flows.sideRunId).state, 'interrupted', 'the Custody-owned workspace continued under Tauri B');
      const bound = new DatabaseSync(join(prepared.profile, 'store/state.sqlite'), { readOnly: true });
      try {
        const rows = bound.prepare(`SELECT a.process_id FROM attempts a JOIN attempt_custody c ON c.attempt_id = a.id WHERE a.run_id = ?`).all(flows.sideRunId);
        assert.ok(rows.some(row => row.process_id === flows.providerPid), 'the provider attempt is bound to the same Host-owned process');
      } finally { bound.close(); }
    } else {
      assert.equal(view.runs.find(item => item.id === flows.sideRunId).state, 'interrupted', 'the concurrently active workspace was recovered as interrupted');
    }
    assert.equal(view.runs.filter(item => ['queued', 'running', 'draining', 'waiting_for_user', 'stopping'].includes(item.state)
      && ['main', 'main-repair'].includes(item.workspace_id)).length, 0, 'no conflicting active Parent or Repair run remains');

    const events = hostEvents(prepared.installation);
    const appSpawns = events.filter(item => item.type === 'application_spawned');
    assert.deepEqual(appSpawns.map(item => item.payload.buildId), ['build-a', 'build-b']);
    assert.equal(appSpawns[0].payload.executable, join(prepared.installation, 'versions/build-a/deszo.exe'));
    assert.equal(appSpawns[1].payload.executable, join(prepared.installation, 'versions/build-b/deszo.exe'));
    const ready = events.filter(item => item.type === 'engine_ready');
    assert.equal(ready.length, 3, 'the duplicate ready request delivered the same durable receipt');
    assert.equal(ready[1].payload.receiptId, ready[2].payload.receiptId);
    assert.equal(events.filter(item => item.type === 'candidate_activated').length, 1);
    assert.ok(events.some(item => item.type === 'managed_process_tree_stopped' && item.payload.buildId === 'build-a'));
    if (custody) {
      // Process instances: the same creation times before and after activation, cross-checked against the Host's own record.
      assert.equal(processCreationMs(flows.providerPid), custodyTree.providerAtLaunchMs, 'the CLI is the same process instance after activation');
      assert.equal(processCreationMs(flows.descendantPid), custodyTree.descendantAtLaunchMs, 'the descendant is the same process instance after activation');
      const sideBinding = new DatabaseSync(join(prepared.profile, 'store/state.sqlite'), { readOnly: true });
      let binding;
      try { binding = sideBinding.prepare('SELECT c.custody_id, a.id AS attempt_id, a.process_id FROM attempt_custody c JOIN attempts a ON a.id = c.attempt_id WHERE a.run_id = ?').all(flows.sideRunId); }
      finally { sideBinding.close(); }
      assert.equal(binding.length, 1, 'the provider attempt has exactly one Host-owned process binding');
      const hostDir = join(prepared.installation, '.deszo-host/custody/attempts');
      const readSideRecords = () => readdirSync(hostDir).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(hostDir, name), 'utf8')))
        .filter(item => item.runId === flows.sideRunId);
      // The Engine acknowledges committed output as it arrives; the record shows that acknowledgement once it is persisted.
      await eventually(() => readSideRecords().some(item => item.stdoutAcked > 0), 'the Engine to acknowledge the Host-owned CLI output after the replacement', 90_000);
      const sideRecords = readSideRecords();
      // The Tauri application writes each runtime's stderr to the profile's runner.log; across the whole replacement there must be no
      // refused custody command in it.
      const runtimeLog = existsSync(join(prepared.profile, 'runtime/runner.log')) ? readFileSync(join(prepared.profile, 'runtime/runner.log'), 'utf8') : '';
      const refusals = runtimeLog.split(/\r?\n/).filter(line => line.includes('Process Custody:'));
      assert.deepEqual(refusals, [], 'no custody command was refused by the Host during the replacement');
      assert.equal(sideRecords.length, 1, 'the Host admitted and launched the provider exactly once');
      const hostRecord = sideRecords[0];
      assert.equal(hostRecord.custodyId, binding[0].custody_id, 'the Engine binding names the Host record');
      assert.equal(hostRecord.processId, flows.providerPid, 'the Host recorded the same CLI process');
      // Output across the replacement: the Host spooled it, the Engine acknowledged only durable bytes, and the journal holds what was acknowledged.
      assert.ok(hostRecord.stdoutDurable > 0, 'the Host spooled CLI output across the replacement');
      assert.ok(hostRecord.stdoutAcked > 0 && hostRecord.stdoutAcked <= hostRecord.stdoutDurable, 'the Engine acknowledged only durable output');
      const journal = new DatabaseSync(join(prepared.profile, 'store/state.sqlite'), { readOnly: true });
      let committedStdout;
      try {
        committedStdout = journal.prepare("SELECT envelope_json FROM journal_events WHERE attempt_id = ? AND event_type = 'attempt.log_chunk'").all(binding[0].attempt_id)
          .map(row => JSON.parse(row.envelope_json).payload).filter(payload => payload.stream === 'stdout').reduce((sum, payload) => sum + payload.byteLength, 0);
      } finally { journal.close(); }
      assert.ok(committedStdout >= hostRecord.stdoutAcked && committedStdout <= hostRecord.stdoutDurable, 'the Engine journal holds what it acknowledged, and nothing beyond the durable spool');
      // Across both Engines, the committed chunks form one contiguous byte range: no gap and no repeated byte.
      const journalChunks = new DatabaseSync(join(prepared.profile, 'store/state.sqlite'), { readOnly: true });
      let chunkSpan;
      try {
        const chunks = journalChunks.prepare("SELECT envelope_json FROM journal_events WHERE attempt_id = ? AND event_type = 'attempt.log_chunk' ORDER BY sequence")
          .all(binding[0].attempt_id).map(row => JSON.parse(row.envelope_json).payload).filter(payload => payload.stream === 'stdout')
          .sort((a, b) => a.chunkIndex - b.chunkIndex);
        let expected = 0;
        chunkSpan = { chunks: chunks.length, contiguous: true, bytes: 0 };
        for (const chunk of chunks) {
          if (chunk.byteOffset !== expected) chunkSpan.contiguous = false;
          expected = chunk.byteOffset + chunk.byteLength;
        }
        chunkSpan.bytes = expected;
      } finally { journalChunks.close(); }
      assert.equal(chunkSpan.contiguous, true, 'the committed output has no gap or repeated byte across the replacement');
      assert.equal(chunkSpan.bytes, committedStdout, 'the contiguous span is exactly the committed output');
      assert.equal(Math.abs(filetimeMs(hostRecord.processCreationTime) - custodyTree.providerAtLaunchMs) <= 2, true, 'the Host creation identity matches the OS process');
      custodyTree.hostRecord = { custodyId: hostRecord.custodyId, state: hostRecord.state, processId: hostRecord.processId, stdoutDurable: hostRecord.stdoutDurable, stdoutAcked: hostRecord.stdoutAcked, spoolComplete: hostRecord.spoolComplete, admissions: sideRecords.length,
        journalChunks: chunkSpan.chunks, journalContiguous: chunkSpan.contiguous, journalStdoutBytes: chunkSpan.bytes };
      custodyTree.generations = appSpawnGenerations(events);
    }
    assert.equal((await readFile(join(prepared.installation, '.deszo-host/active.json'), 'utf8')).includes('build-b'), true);
    assert.equal(existsSync(join(prepared.fixtureState, 'provider-host-capability-leak.marker')), false, 'the lifecycle capability was removed before provider launch');

    const durable = await readHostState(prepared.installation);
    const receipt = durable.operation.receipt;
    assert.equal(durable.activeBuildId, 'build-b');
    assert.equal(receipt.operationId, flows.operation.id);
    assert.equal(receipt.candidateDigest, prepared.candidateDigest);
    assert.equal(receipt.applicationBuildId, buildBId);
    assert.equal(receipt.applicationPid, connectionFileB.applicationPid);
    assert.equal(receipt.enginePid, ready[1].payload.enginePid);
    assert.equal(receipt.runtimeInstanceId, connectionFileB.runtimeInstanceId);
    assert.equal(receipt.storeId, connectionFileB.storeId);
    assert.equal(receipt.hostPid, hostPid);
    assert.equal(receipt.actualActivation && receipt.applicationResponsive && receipt.engineReady, true);
    assert.ok(!JSON.stringify(events).includes(uiA.firstPartyToken), 'Host journal contains no first-party Engine credential');
    assert.ok(!JSON.stringify(receipt).includes(uiA.firstPartyToken), 'lifecycle receipt contains no first-party Engine credential');

    proofPassed = true;
    return { iteration, custody, custodyTree, hostPid, installationId: durable.installationId, profileRoot: prepared.profile,
      applicationPids: [appA.payload.pid, appBEvent.payload.pid], enginePids: [ready[0].payload.enginePid, ready[1].payload.enginePid],
      buildIds: appSpawns.map(item => item.payload.buildId),
      builds: artifacts.packages.map(item => ({ buildId: item.buildId, executable: item.executable, runtime: item.runtime,
        executableSha256: item.exeSha256, packageDigest: item.packageDigest })),
      candidateDigest: prepared.candidateDigest, activatedGeneration: receipt.activatedGeneration,
      operationId: flows.operation.id,
      judgeAuthorization: { kind: flows.operation.proposal.kind, engineValidatedRole: flows.operation.proposal.engineValidatedRole,
        workflowId: flows.operation.proposal.workflowId, nodeInstanceId: flows.operation.proposal.nodeInstanceId,
        attemptId: flows.operation.proposal.attemptId, proposalArtifactId: flows.operation.proposal_artifact_id,
        action: flows.operation.proposal.action, targetVersion: flows.operation.proposal.targetVersion,
        candidateDigest: flows.operation.proposal.candidateDigest,
        continuationCheckpointId: flows.operation.proposal.continuationCheckpointId },
      receipt, parentRunId: flows.parentRunId, repairRunId: flows.repairRunId,
      storeId: connectionFileB.storeId, providerPid: flows.providerPid, providerDescendantPid: flows.descendantPid,
      continuation: { repair: repairDone.run.state, parent: parentDone.run.state }, hostTrace: events };
  } finally {
    unrelated.kill();
    await stopHost(host);
    if (proofPassed) assert.ok(hostEvents(prepared.installation).some(item => item.type === 'managed_process_tree_stopped' && item.payload.buildId === buildBId),
      'the final Host shutdown contained Tauri B and its production Engine');
    // A graceful Host stop ends every Custody Job it still owns; the CLI and its descendant must be gone afterwards.
    if (proofPassed && custodyTree) {
      await eventually(() => !isAlive(custodyTree.providerPid) && !isAlive(custodyTree.descendantPid), 'the Host stop to end its Custody-owned tree', 30_000);
    }
    if (process.env.DESZO_PROOFB_KEEP_ARTIFACTS !== '1') await removeTestRoot(prepared.root);
    else console.error(`Proof B diagnostics preserved at ${prepared.root}`);
  }
}

test('Proof B: real Rust Host restarts Tauri A as Tauri B and Engine autonomously continues Parent and Repair twice',
  { timeout: 900_000 }, async () => {
    const artifacts = await desktopArtifacts();
    const evidence = [await runFreshProof(1, artifacts), await runFreshProof(2, artifacts)];
    assert.equal(evidence.length, 2);
    assert.notEqual(evidence[0].hostPid, evidence[1].hostPid);
    assert.ok(evidence.every(item => item.buildIds.join(',') === 'build-a,build-b'));
    await writeFile(join(testsRoot, 'tauri-host-proof-b-runs.json'), JSON.stringify({ platform: process.platform, artifacts: artifacts.packages, runs: evidence }, null, 2));
  });

// Process Custody on the real desktop path: the same Tauri A to Tauri B replacement, with the provider CLI launched by the Host's
// custody service. The live CLI and its descendant must survive the replacement with the same identity, and be bound to Build B.
test('Proof B with Process Custody: a Custody-owned provider CLI and its descendant survive real Tauri A to Tauri B replacement',
  { timeout: 900_000 }, async () => {
    const artifacts = await desktopArtifacts();
    const evidence = await runFreshProof(3, artifacts, { custody: true });
    assert.deepEqual(evidence.buildIds, ['build-a', 'build-b']);
    assert.equal(evidence.custody, true);
    await writeFile(join(testsRoot, 'tauri-custody-proof-b.json'), JSON.stringify({ platform: process.platform, artifacts: artifacts.packages, run: evidence }, null, 2));
  });

test('negative desktop Host case: incomplete Tauri candidate resources are refused before shutdown', { timeout: 180_000 }, async () => {
  const artifacts = await desktopArtifacts();
  const prepared = await prepareInstallation(`missing-resource-${randomUUID()}`, artifacts, { damageCandidate: 'missing-shim' });
  const host = hostProcess(prepared.configPath, artifacts.fixtureCli, prepared.fixtureState, prepared.webviewRoot);
  try {
    const connection = await cdpConnection(prepared.webviewRoot, host);
    const flows = await setUpLinkedFlows(connection, prepared.profile, prepared.candidateDigest);
    await eventually(() => databaseView(prepared.profile).journal.some(item => item.type === 'continuation.lifecycle_host_delivery_failed'),
      'the Engine to record the incomplete desktop candidate refusal');
    const events = hostEvents(prepared.installation);
    const view = databaseView(prepared.profile);
    const durable = await readHostState(prepared.installation);
    assert.equal(events.filter(item => item.type === 'activation_accepted').length, 0);
    assert.equal(events.filter(item => item.type === 'candidate_activated').length, 0);
    assert.deepEqual(events.filter(item => item.type === 'application_spawned').map(item => item.payload.buildId), ['build-a']);
    assert.equal(durable.activeBuildId, 'build-a');
    assert.equal(view.operations.find(item => item.id === flows.operation.id).state, 'intent');
    assert.equal(view.runs.find(item => item.id === flows.repairRunId).state, 'waiting_for_user');
    assert.equal(view.journal.some(item => item.type === 'continuation.lifecycle_verified'), false);
    assert.ok(isAlive(host.child.pid));
  } finally {
    await stopHost(host);
    await removeTestRoot(prepared.root);
  }
});

test('negative desktop Host case: Build B launches but its production Engine bootstrap fails without a receipt', { timeout: 180_000 }, async () => {
  const artifacts = await desktopArtifacts();
  const prepared = await prepareInstallation(`broken-runner-${randomUUID()}`, artifacts, { damageCandidate: 'broken-runner', readyTimeoutMs: 8_000 });
  const host = hostProcess(prepared.configPath, artifacts.fixtureCli, prepared.fixtureState, prepared.webviewRoot);
  try {
    const connection = await cdpConnection(prepared.webviewRoot, host);
    const flows = await setUpLinkedFlows(connection, prepared.profile, prepared.candidateDigest);
    await waitForHostEvent(host, prepared.installation, item => item.type === 'activation_accepted' && item.payload.operationId === flows.operation.id);
    try {
      await waitForHostEvent(host, prepared.installation, item => item.type === 'activation_failed' && item.payload.operationId === flows.operation.id, 45_000);
    } catch (error) {
      throw new Error(`${error.message}\nHost events: ${JSON.stringify(hostEvents(prepared.installation), null, 2)}\n` +
        `Durable state: ${JSON.stringify(await readHostState(prepared.installation), null, 2)}\nHost stderr: ${host.stderrText}`);
    }
    const events = hostEvents(prepared.installation);
    const durable = await readHostState(prepared.installation);
    const view = databaseView(prepared.profile);
    assert.deepEqual(events.filter(item => item.type === 'application_spawned').map(item => item.payload.buildId), ['build-a', 'build-b']);
    assert.equal(events.filter(item => item.type === 'engine_ready').length, 1, 'only Tauri A reached production Engine readiness');
    assert.equal(events.filter(item => item.type === 'candidate_activated').length, 1);
    assert.equal(durable.activeBuildId, 'build-b');
    assert.equal(durable.operation.phase, 'failed');
    assert.equal(durable.operation.receipt, null);
    assert.equal(view.operations.find(item => item.id === flows.operation.id).state, 'intent');
    assert.equal(view.runs.find(item => item.id === flows.repairRunId).state, 'waiting_for_user');
    assert.equal(view.runs.find(item => item.id === flows.parentRunId).state, 'waiting_for_user');
    assert.equal(view.journal.some(item => item.type === 'continuation.lifecycle_verified'), false);
    assert.equal(events.some(item => item.type === 'engine_ready' && item.payload.buildId === buildBId), false);
  } finally {
    await stopHost(host);
    if (process.env.DESZO_PROOFB_KEEP_ARTIFACTS !== '1') await removeTestRoot(prepared.root);
    else console.error(`Proof B diagnostics preserved at ${prepared.root}`);
  }
});

test('negative desktop bootstrap: manifest Build B identity cannot be satisfied by the Build A executable', { timeout: 120_000 }, async () => {
  const artifacts = await desktopArtifacts();
  const root = testRoot(join(testsRoot, `desktop-host-proof-b-identity-${randomUUID()}-`));
  const installation = join(root, 'installation');
  const profile = join(root, 'profile');
  const staging = join(installation, 'staging');
  const initial = join(installation, 'versions/build-b');
  await Promise.all([mkdir(initial, { recursive: true }), mkdir(profile, { recursive: true }), mkdir(staging, { recursive: true })]);
  await createPackage(artifacts.packages[1], initial, 'build-b');
  await cp(artifacts.packages[0].executable, join(initial, 'deszo.exe'), { force: true });
  const config = join(root, 'host-config.json');
  await writeFile(config, JSON.stringify({ installationRoot: installation, profileRoot: profile, stagingRoot: staging,
    nodeExecutable: process.execPath, initialBuildId: 'build-b' }));
  const host = hostProcess(config, artifacts.fixtureCli, join(root, 'fixture-state'), join(root, 'webview2'));
  try {
    const result = await new Promise(resolvePromise => host.child.once('exit', (code, signal) => resolvePromise({ code, signal })));
    assert.notEqual(result.code, 0);
    const events = hostEvents(installation);
    assert.ok(events.some(item => item.type === 'application_spawned' && item.payload.buildId === 'build-b'));
    assert.equal(events.filter(item => item.type === 'engine_ready').length, 0);
    assert.match(host.stderrText, /exited before readiness|build identity|bootstrap/i);
    const state = await readHostState(installation);
    assert.equal(state.activeBuildId, 'build-b');
    assert.equal(state.operation, null);
  } finally {
    await removeTestRoot(root);
  }
});

test('negative desktop Host case: unexpected Tauri exit is recorded without a successful activation', { timeout: 120_000 }, async () => {
  const artifacts = await desktopArtifacts();
  const prepared = await prepareInstallation(`unexpected-exit-${randomUUID()}`, artifacts);
  const host = hostProcess(prepared.configPath, artifacts.fixtureCli, prepared.fixtureState, prepared.webviewRoot);
  try {
    const connection = await desktopConnection(prepared.profile, buildAId, host);
    const app = hostEvents(prepared.installation).find(item => item.type === 'application_spawned' && item.payload.buildId === buildAId);
    const ready = hostEvents(prepared.installation).find(item => item.type === 'engine_ready' && item.payload.buildId === buildAId);
    assert.ok(app && ready, 'Tauri Build A and its production Engine reached readiness');
    assert.equal(connection.applicationPid, app.payload.pid);

    process.kill(app.payload.pid, 'SIGTERM');
    await eventually(() => host.child.exitCode !== null, 'the Host to report and stop after an unexpected Tauri exit', 30_000);
    const events = hostEvents(prepared.installation);
    const failure = events.find(item => item.type === 'managed_application_exited_unexpectedly');
    assert.ok(failure, 'the Host durably recorded the unexpected desktop exit');
    assert.equal(failure.payload.pid, app.payload.pid);
    assert.equal(failure.payload.buildId, buildAId);
    assert.equal(failure.payload.bootstrap, 'tauri');
    assert.notEqual(host.child.exitCode, 0);
    assert.equal(isAlive(app.payload.pid), false);
    assert.equal(isAlive(ready.payload.enginePid), false, 'the Host drained the Engine after the unexpected Tauri exit');
    assert.equal(events.some(item => item.type === 'activation_accepted' || item.type === 'candidate_activated'), false);
    const durable = await readHostState(prepared.installation);
    assert.equal(durable.activeBuildId, buildAId);
    assert.equal(durable.operation, null);
    assert.equal(events.some(item => item.type === 'receipt_created' || item.type === 'receipt_acknowledged'), false);
  } finally {
    await stopHost(host);
    await removeTestRoot(prepared.root);
  }
});

// Supervised containment on the real desktop path (ADR-0002 section 4). The writer is an ordinary agent. The runtime launches it through the Tauri
// supervisor's launch shim, so its process tree is a member of the runtime's Job Object, and it writes Git objects and refs into a repository while
// it runs. The runtime is then ended with the writer in progress: by an external kill (`engine-kill`), or by a crash in the window between the OS
// creation of the writer and the durable record of its process identity (`identity-window`, the attempt row still names no process). The desktop
// shell must end the whole tree, before anything else can run, and the repository must receive no write after that. No successor runtime can
// start in the same application process: the lifecycle capability is one-time, so a later Engine is a new application, started by the Host.
async function readWhenReady(path, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { return (await readFile(path, 'utf8')).trim(); } catch { /* Not written yet. */ }
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`${path} was not written in time`);
}

function writeLog(fixtureState) {
  const path = join(fixtureState, 'writes.log');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => {
    const [tick, millis, ok] = line.split(' ');
    return { tick: Number(tick), millis: Number(millis), ok: ok === 'true' };
  });
}

// Polls until each process is gone; returns the first time each was observed gone. A process that is never observed gone is a failure.
async function observeDeaths(pids, timeoutMs) {
  const deadAt = new Map();
  const started = Date.now();
  while (deadAt.size < pids.length) {
    for (const pid of pids) if (!deadAt.has(pid) && !isAlive(pid)) deadAt.set(pid, Date.now());
    if (deadAt.size === pids.length) break;
    if (Date.now() - started > timeoutMs) throw new Error(`process ${pids.filter(pid => !deadAt.has(pid)).join(', ')} is still alive after ${timeoutMs} ms`);
    await new Promise(done => setTimeout(done, 25));
  }
  return deadAt;
}

async function runSupervisedWriterProof(scenario) {
  const artifacts = await desktopArtifacts();
  const prepared = await prepareInstallation(`supervised-${scenario}`, artifacts, { custody: false });
  const marker = join(prepared.root, 'crash-before-identity.marker');
  // The Host passes its environment to the application and the runtime; the marker is named only for the Host that starts Tauri A.
  if (scenario === 'identity-window') process.env.DESZO_TEST_CRASH_BEFORE_IDENTITY_MARKER = marker;
  let host;
  try { host = hostProcess(prepared.configPath, artifacts.fixtureCli, prepared.fixtureState, prepared.webviewRoot); }
  finally { delete process.env.DESZO_TEST_CRASH_BEFORE_IDENTITY_MARKER; }
  try {
    await desktopConnection(prepared.profile, buildAId, host);
    // The bundled UI's own connection carries the first-party credential the API accepts (as in Proof B).
    const connection = await cdpConnection(prepared.webviewRoot, host);
    const ready = await waitForHostEvent(host, prepared.installation, item => item.type === 'engine_ready' && item.payload.buildId === buildAId);
    const enginePid = Number(ready.payload.enginePid);
    const applicationPid = Number(ready.payload.applicationPid);
    assert.ok(enginePid && enginePid !== applicationPid, 'the runtime is a child of the Tauri application');

    // The workspace is a Git repository that the writer updates; its objects and refs live only there.
    const repo = join(prepared.root, 'writer-repo');
    await mkdir(repo, { recursive: true });
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Proof'], ['config', 'user.email', 'proof@example.com'], ['commit', '-q', '--allow-empty', '-m', 'base']]) {
      assert.equal(run('git', args, { cwd: repo }).status, 0, `git ${args.join(' ')}`);
    }
    const workspace = await apiCall(connection, 'PUT', '/api/v2/workspaces/supervised-writer', { cwd: repo });
    assert.equal(workspace.status, 200, JSON.stringify(workspace.body));
    const saved = await saveWorkflow(connection, workflow('supervised-writer-proof', [agent('writer', 'fixture-git-writer', { timeoutSeconds: 300 })], [
      edge('request-writer', 'request', 'text', 'writer', 'prompt'), edge('writer-result', 'writer', 'text', 'result', 'value')]));
    // identity-window: the first launch's identity write is withheld for 8 s (the Engine keeps running meanwhile), then the runtime ends.
    // The hold lasts shorter than the supervisor's runtime-silence limit (15 s), so the Host-side supervisor does not end the writer first.
    if (scenario === 'identity-window') await writeFile(marker, '8000');
    const runId = await runWorkflow(connection, saved, 'supervised-writer');

    // Identities are taken as soon as each process exists: the identity-window runtime ends a few seconds after the writer starts.
    const writerPid = Number(await readWhenReady(join(prepared.fixtureState, 'writer.pid')));
    const writerIdentity = processCreationMs(writerPid);
    const descendantPid = Number(await readWhenReady(join(prepared.fixtureState, 'writer-descendant.pid')));
    const descendantIdentity = processCreationMs(descendantPid);
    assert.ok(writerIdentity && descendantIdentity, 'the writer and its descendant are live OS processes');
    await eventually(() => writeLog(prepared.fixtureState).length >= 4, 'the writer to write into its repository', 60_000);
    const writesBeforeEnd = writeLog(prepared.fixtureState).length;

    const db = new DatabaseSync(join(prepared.profile, 'store/state.sqlite'), { readOnly: true });
    let writerAttemptBeforeEnd;
    try { writerAttemptBeforeEnd = db.prepare("SELECT id, state, process_id FROM attempts WHERE run_id = ? AND node_instance_id = 'writer'").get(runId); }
    finally { db.close(); }

    if (scenario === 'engine-kill') {
      const killed = run('taskkill', ['/PID', String(enginePid), '/F'], {});
      assert.equal(killed.status, 0, `taskkill of the runtime: ${killed.stderr}`);
    }
    // The runtime ends (killed, or crashed in the identity window). Nothing else in this proof starts a runtime.
    await eventually(() => !isAlive(enginePid), 'the runtime to end', 60_000);
    const runtimeEndedObserved = Date.now();
    const deaths = await observeDeaths([writerPid, descendantPid], 30_000);
    const writesAtDeath = writeLog(prepared.fixtureState).length;
    await new Promise(done => setTimeout(done, 3_000));
    const writesLater = writeLog(prepared.fixtureState);
    // Measured: no repository write after the moment the tree was observed gone. Writes before that moment are reported, not asserted away.
    assert.equal(writesLater.length, writesAtDeath, 'the repository received no write after the tree was observed gone');
    const writes = writesLater;
    const lastWriteMs = Math.max(...writes.map(item => item.millis));
    assert.ok(lastWriteMs <= Math.min(deaths.get(writerPid), deaths.get(descendantPid)), 'every repository write happened before the tree was observed ended');
    assert.equal(readFileSync(join(prepared.fixtureState, 'writer.pid'), 'utf8').trim(), String(writerPid), 'the writer was not launched again');
    assert.equal(processCreationMs(writerPid), null, 'the writer is gone (the identity is no longer live)');

    const after = new DatabaseSync(join(prepared.profile, 'store/state.sqlite'), { readOnly: true });
    let writerAttemptAfter;
    try { writerAttemptAfter = after.prepare("SELECT id, state, process_id FROM attempts WHERE run_id = ? AND node_instance_id = 'writer'").get(runId); }
    finally { after.close(); }
    // The attempt row names the process the runtime launched through the shim (its PID), not the CLI it runs: the CLI is the shim's child.
    if (scenario === 'identity-window') {
      assert.equal(writerAttemptBeforeEnd.process_id, null, 'the attempt row names no process at the crash: the absent PID is not treated as evidence');
    } else {
      assert.notEqual(writerAttemptBeforeEnd.process_id, null, 'the attempt row named the launched process before the kill');
    }
    const evidence = {
      scenario, platform: process.platform, runId, applicationPid, enginePid, writer: { pid: writerPid, descendantPid, identityMs: writerIdentity, descendantIdentityMs: descendantIdentity },
      attemptAtEnd: { before: writerAttemptBeforeEnd, after: writerAttemptAfter },
      writesBeforeEnd, writesTotal: writes.length, lastWriteMs, runtimeEndedObservedMs: runtimeEndedObserved,
      observedGoneMs: { writer: deaths.get(writerPid), descendant: deaths.get(descendantPid) },
      writesAfterGone: writes.length - writesAtDeath,
    };
    return evidence;
  } finally {
    await stopHost(host);
    if (process.env.DESZO_PROOFB_KEEP_ARTIFACTS !== '1') await removeTestRoot(prepared.root);
    else console.error(`Supervised proof diagnostics preserved at ${prepared.root}`);
  }
}

test('Supervised containment (desktop): ending the runtime during a supervised Git write leaves no writer, no descendant and no further repository write',
  { timeout: 900_000 }, async () => {
    const evidence = await runSupervisedWriterProof('engine-kill');
    await writeFile(join(testsRoot, 'tauri-supervised-containment-engine-kill.json'), JSON.stringify(evidence, null, 2));
  });

test('Supervised containment (desktop): a crash between the writer\'s OS creation and its durable identity leaves no writer and no further write',
  { timeout: 900_000 }, async () => {
    const evidence = await runSupervisedWriterProof('identity-window');
    await writeFile(join(testsRoot, 'tauri-supervised-containment-identity-window.json'), JSON.stringify(evidence, null, 2));
  });
