// P6-DECISION-C Phase 1 evidence (2026-11-06). Runs the REAL Shell, the REAL Rust Lifecycle Host and REAL Engine packages in a
// test-owned directory under .deszo/tests. Nothing touches an installed production release or the repository source.
//
// What it establishes, in order:
//   1. The Engine's sanctioned P6 bridge (p6Call) refuses an unlisted command, but custody() forwards ANY command to the Host.
//   2. Code running in the Engine can spawn child processes (node:child_process). Those children receive a scrubbed environment
//      (no DESZO_LIFECYCLE_* keys), yet they can open the Store, the Store directory and the profile's first-party descriptor.
//   3. A same-OS-user child can read the Host's private heap and recover the Host's lifecycle capability, then authenticate.
//   4. The Engine's direct bridge route (p6Call engine.stage then engine.switch) switches the Host to Engine B with no P5
//      acceptance, no Judge decision and no Engine-side consumer check: the Host verifies only package self-consistency.
//
// The Engine A probe is a test-only action added to a TEST CLONE of Engine A's source (never to the repository). The probe
// file is gated by the test fault policy and DESZO_TEST_ENGINE_PROBE, exactly like the existing P6-G0 probe.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { ownedDir, testsRoot } from '../../../../runtime/tests/test-roots.mjs';
import { eventually } from '../../../../runtime/tests/custody-support.mjs';
import { gitRunner } from '../../../../runtime/tests/p5-e2e-support.mjs';
import { ENGINE_A, ENGINE_B, SHELL_BUILD_ID, activeSelector, engineSources, freshDescriptor, hostDigest, hostEvents, installEngines,
  installShell, lifecycleState, probeEngine, startShellHost } from '../../../../runtime/tests/p6-g0-support.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const memscanPath = join(here, 'memscan.ps1');
const evidencePath = join(here, 'direct-route-evidence.json');

// Added to the TEST CLONE of Engine A only. Each case forwards to the production bridge object the Engine already holds.
const PROBE_CASES = `      case 'decision_c_p6_call':
        // The sanctioned P6 surface: the allowlist in lifecycleBridge.mjs p6Call, as engine.mjs:249 uses it.
        return lifecycleHost.p6Call(command.command, command.payload);
      case 'decision_c_passthrough':
        // The bridge's custody() method, which forwards any command name to the Host.
        return lifecycleHost.custody(command.command, command.payload);
      case 'decision_c_spawn': {
        // node:child_process from Engine code. The env is either the verifier's documented minimum or the Engine's own scrubbed env.
        const cp = globalThis.process.getBuiltinModule('node:child_process');
        const base = command.env === 'verifier'
          ? { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: command.scratch, TMP: command.scratch }
          : { ...process.env };
        const env = { ...base, DECISION_C_DB: command.databasePath, DECISION_C_DIR: command.storeDir, DECISION_C_CONNECTION: command.connectionPath };
        const executable = command.executable === 'powershell' ? 'powershell.exe' : process.execPath;
        const started = Date.now();
        const result = cp.spawnSync(executable, command.arguments, { env, encoding: 'utf8', timeout: 240000, windowsHide: true });
        return { status: result.status, signal: result.signal, elapsedMs: Date.now() - started,
          stdout: String(result.stdout ?? '').slice(0, 4000), stderr: String(result.stderr ?? '').slice(0, 2000),
          engineLifecycleEnvKeys: Object.keys(process.env).filter(key => key.startsWith('DESZO_LIFECYCLE') || key.startsWith('DESZO_CUSTODY')) };
      }
`;

// The store-access script a child runs. It reports only counts and booleans, never a token or a capability value.
const STORE_SCRIPT = `
const fs = require('node:fs');
const out = { childLifecycleEnvKeys: Object.keys(process.env).filter(k => k.startsWith('DESZO_LIFECYCLE') || k.startsWith('DESZO_CUSTODY')).length };
try {
  const connection = JSON.parse(fs.readFileSync(process.env.DECISION_C_CONNECTION, 'utf8'));
  out.firstPartyDescriptorReadable = true;
  out.firstPartyTokenFieldPresent = typeof connection.token === 'string' && connection.token.length > 0;
} catch (error) { out.firstPartyDescriptorError = String(error.code || error.message); }
try {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(process.env.DECISION_C_DB);
  db.exec('PRAGMA busy_timeout = 5000');
  out.storeTableCount = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get().n;
  db.exec('BEGIN IMMEDIATE');
  db.exec('ROLLBACK');
  out.storeWriteTransactionAcquiredAndRolledBack = true;
  db.close();
} catch (error) { out.storeError = String(error.code || error.message); }
try {
  const probe = process.env.DECISION_C_DIR + '/decision-c-write-probe.tmp';
  fs.writeFileSync(probe, 'probe');
  fs.rmSync(probe);
  out.storeDirectoryWritable = true;
} catch (error) { out.storeDirectoryError = String(error.code || error.message); }
console.log(JSON.stringify(out));
`;

// One authenticated request to the Host, from a process that is NOT the Engine: the same JSON-line protocol the bridge uses.
function hostRequest(address, capability, command, payload = {}) {
  const [, port] = /^127\.0\.0\.1:(\d+)$/.exec(address);
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) }, () => {
      socket.write(`${JSON.stringify({ capability, command, payload })}\n`);
    });
    let data = '';
    socket.setTimeout(10000, () => { socket.destroy(); resolve({ transport: 'timeout' }); });
    socket.on('data', chunk => {
      data += chunk.toString('utf8');
      const newline = data.indexOf('\n');
      if (newline < 0) return;
      socket.destroy();
      try { resolve(JSON.parse(data.slice(0, newline))); } catch { resolve({ transport: 'malformed' }); }
    });
    socket.on('error', error => resolve({ transport: error.code || error.message }));
    socket.on('close', () => resolve({ transport: 'closed' }));
  });
}

const evidence = { schemaVersion: 1, phase: 'P6-DECISION-C Phase 1', capturedAt: new Date().toISOString(), node: process.version,
  platform: `${process.platform} ${process.arch}`, steps: {} };
const record = (name, value) => { evidence.steps[name] = value; console.log(`${name}: ${JSON.stringify(value)}`); };

const root = ownedDir(join(testsRoot, 'p6-decision-c-direct-'));
const installation = join(root, 'installation');
const profile = join(root, 'profile');
const scratch = join(root, 'scratch');
mkdirSync(scratch, { recursive: true });
let host = null;
try {
  installShell(installation);
  const sources = await engineSources(join(root, 'sources'), { variant: 'marker' });
  // Test clone of Engine A only: add the probe actions, then commit so the packager sees a clean tree.
  const probePath = join(sources.cloneA, 'runtime/core/testEngineProbe.mjs');
  const probeText = readFileSync(probePath, 'utf8');
  const anchor = "      case 'quiescence_state':";
  if (!probeText.includes(anchor)) throw new Error('The probe anchor is missing; the probe cannot be extended.');
  writeFileSync(probePath, probeText.replace(anchor, PROBE_CASES + anchor));
  const git = gitRunner(sources.gitPath);
  git(sources.cloneA, ['add', '--all']);
  git(sources.cloneA, ['commit', '--quiet', '-m', 'P6-DECISION-C evidence probe (test clone of Engine A only)']);
  const { bRoot } = await installEngines(installation, sources, { stageB: true, testFaultHooks: true });
  const packageSha256 = hostDigest(bRoot);
  record('packages', { engineB: 'staged by the Host staging area, unmodified marker Engine', packageSha256Prefix: packageSha256.slice(0, 12) });

  host = startShellHost({ root, installation, profile, initialBuildId: ENGINE_A, testEngineProbe: true });
  const connectionA = await host.engineConnection(ENGINE_A);
  const hostPid = host.child.pid;
  const generation = lifecycleState(installation).generation;
  record('engineA', { runningAndAuthorizedToHost: connectionA.applicationBuildId === ENGINE_A, hostPid, generation });

  // 1. The sanctioned P6 allowlist refuses a non-P6 command; the custody() pass-through forwards it anyway.
  record('step1_allowlist_refuses_engine_status', await probeEngine(profile, ENGINE_A,
    { action: 'decision_c_p6_call', command: 'engine.status', payload: {} }).catch(error => ({ probeError: String(error.message) })));
  const passthrough = await probeEngine(profile, ENGINE_A, { action: 'decision_c_passthrough', command: 'engine.status', payload: {} })
    .catch(error => ({ probeError: String(error.message) }));
  record('step1_passthrough_forwards_engine_status', { ok: passthrough.ok, resultKeys: passthrough.value ? Object.keys(passthrough.value) : null });

  // 2. Child processes from Engine code: the verifier's minimal env and the Engine's own scrubbed env.
  const storeDir = join(profile, 'store');
  const databasePath = join(storeDir, 'state.sqlite');
  const connectionPath = join(profile, 'runtime', 'connection.json');
  const nodeArgs = ['-e', STORE_SCRIPT];
  const storeWithVerifierEnv = await probeEngine(profile, ENGINE_A, { action: 'decision_c_spawn', executable: 'node', arguments: nodeArgs,
    env: 'verifier', scratch, databasePath, storeDir, connectionPath });
  record('step2_child_verifier_env_store_access', { childStatus: storeWithVerifierEnv.value?.status, child: parseChild(storeWithVerifierEnv) });
  const storeWithEngineEnv = await probeEngine(profile, ENGINE_A, { action: 'decision_c_spawn', executable: 'node', arguments: nodeArgs,
    env: 'engine', scratch, databasePath, storeDir, connectionPath });
  record('step2_child_engine_env_store_access', { childStatus: storeWithEngineEnv.value?.status, child: parseChild(storeWithEngineEnv) });

  // 3. A same-user child (spawned by the Engine) reads the Host's private heap and collects every 64-hex run it finds.
  const scanOut = join(scratch, 'host-scan.json');
  const scan = await probeEngine(profile, ENGINE_A, { action: 'decision_c_spawn', executable: 'powershell',
    arguments: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', memscanPath, '-ProcessId', String(hostPid), '-OutFile', scanOut],
    env: 'engine', scratch, databasePath, storeDir, connectionPath }, 300_000);
  const scanStatus = { childStatus: scan.value?.status, stderrHead: String(scan.value?.stderr ?? '').slice(0, 300) };
  if (existsSync(scanOut)) {
    const scanned = JSON.parse(readFileSync(scanOut, 'utf8'));
    scanStatus.candidateCount = scanned.candidateCount;
    scanStatus.regionsScanned = scanned.regionsScanned;
    scanStatus.bytesScanned = scanned.bytesScanned;
    evidence.hostScanCandidates = scanned.candidates;
    rmSync(scanOut, { force: true });
  }
  record('step3_child_reads_host_heap', scanStatus);

  // 4. The direct bridge route: Engine A stages and switches to Engine B. No P5 record, Judge decision or consumer is involved.
  const operationId = randomUUID();
  const body = { operationId, fromEngineBuildId: ENGINE_A, toEngineBuildId: ENGINE_B, packageSha256, shellBuildId: SHELL_BUILD_ID, generation };
  const staged = await probeEngine(profile, ENGINE_A, { action: 'decision_c_p6_call', command: 'engine.stage', payload: body }).catch(error => ({ probeError: String(error.message) }));
  record('step4_direct_stage_from_engine_bridge', { ok: staged.ok, phase: staged.value?.phase ?? null, code: staged.code ?? null, message: staged.message ?? null });
  const switched = await probeEngine(profile, ENGINE_A, { action: 'decision_c_p6_call', command: 'engine.switch', payload: body }, 30_000)
    .catch(error => ({ probeError: String(error.message) }));
  record('step4_direct_switch_from_engine_bridge', { answeredByEngineA: switched.ok ?? null, accepted: switched.value?.accepted ?? null,
    note: switched.probeError ? 'Engine A stopped by the Host before it could answer; the Host journal is the evidence.' : null });
  await eventually(() => hostEvents(installation).some(event => event.type === 'engine_switch_verified'),
    'the Host to verify the directly switched Engine B', 600_000, 200);
  const connectionB = await freshDescriptor(profile, ENGINE_B, connectionA.runtimeInstanceId);
  const selector = activeSelector(installation);
  const operation = lifecycleState(installation).engineOperation;
  const types = hostEvents(installation).map(event => event.type);
  record('step4_outcome', { engineBServes: connectionB.engineMarker === 'engine-b', engineBPid: connectionB.applicationPid ?? null,
    activeSelectorBuild: selector.buildId, committedByOperation: selector.committedOperationId === operationId,
    operationPhase: operation.phase, fallbackAttempted: operation.fallbackAttempted,
    journalEventTypes: [...new Set(types)], p5OrJudgeEventsInHostJournal: types.filter(type => /p5|judge|self_repair|admission/i.test(type)) });
  const storeText = existsSync(databasePath) ? readFileSync(databasePath) : Buffer.alloc(0);
  const walPath = `${databasePath}-wal`;
  const walText = existsSync(walPath) ? readFileSync(walPath) : Buffer.alloc(0);
  record('step4_store_has_no_p6_admission_record', { admissionTextInStore: storeText.includes('p6.switch_admitted') || walText.includes('p6.switch_admitted') });

  // 5. A same-user process OUTSIDE any Engine, using only the recovered capability, reaches the Host's authenticated surface.
  const address = JSON.parse(readFileSync(join(installation, '.deszo-host', 'ipc-endpoint.json'), 'utf8')).address;
  const candidates = evidence.hostScanCandidates ?? [];
  let matched = null;
  for (const [index, candidate] of candidates.entries()) {
    const response = await hostRequest(address, candidate, 'engine.status');
    if (response.ok === true) { matched = { index, capability: candidate }; break; }
  }
  if (matched) {
    const afterSwitch = await hostRequest(address, matched.capability, 'engine.switch_status', { operationId: randomUUID() });
    record('step5_outside_process_authenticated', { candidatesTested: candidates.length, matchedIndex: matched.index,
      p6CommandReachedAuthenticatedHost: afterSwitch.ok === false && afterSwitch.code === 'not_found',
      refusalCode: afterSwitch.code ?? null });
    matched = { index: matched.index };
  } else {
    record('step5_outside_process_authenticated', { candidatesTested: candidates.length, matchedIndex: null });
  }
  delete evidence.hostScanCandidates;
  evidence.generatedAt = new Date().toISOString();
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`EVIDENCE WRITTEN ${evidencePath}`);
} finally {
  if (host) await host.stop();
}

function parseChild(result) {
  try { return JSON.parse(String(result.value?.stdout ?? '').trim().split(/\r?\n/).pop()); } catch { return { unparsed: true }; }
}
