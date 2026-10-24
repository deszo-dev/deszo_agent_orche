// Installed adapters for the domain lifecycle state machine. All launch identities come from the native service.
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalize } from '../core/canonical.mjs';
import { HostError, sameProcess } from './authority.mjs';
import { InstalledBuilds } from './installedBuilds.mjs';
import { ApplicationLifecycle } from './lifecycle.mjs';
import { ApplicationStop } from './applicationStop.mjs';
import { captureNativeUi } from './nativeUi.mjs';
import { ProfileRecovery, safeProfilePath, storeCompatibility, verifyCompatibleRollback } from './profileRecovery.mjs';

const required = (value, message) => { if (!value) throw new HostError(403, 'lifecycle_identity_refused', message); };
const samePath = (a,b) => typeof a === 'string' && typeof b === 'string' && resolve(a).toLowerCase() === resolve(b).toLowerCase();
export function installedLifecycle({ host, installation, native, installRoot }) {
  const builds = new InstalledBuilds({ host, buildRoot: installation.buildRoot, gitTool:installation.tools?.git??null, readGit:sourceRoot=>native('sourceMetadata',{sourceRoot}), sealDirectory: path => native('sealBuild', { path }) });
  const profiles = new ProfileRecovery({ host, allowedRoot: installation.profileRoot, isQuiescent: async path => (await native('profileQuiescent', { path })).quiescent });
  async function registerProfile(p, peer) {
    required(/^[A-Za-z0-9-]{1,100}$/.test(p.profileId), 'A profile identity is required.');
    const path = safeProfilePath(installation.profileRoot, p.path, { existing: false });
    const old = host.get('SELECT * FROM data_profiles WHERE profile_id=?', p.profileId);
    if (old) { required(samePath(old.profile_path, path), 'This profile ID belongs to a different path.'); return { registered: true, profileId: p.profileId, path }; }
    if (!existsSync(path)) mkdirSync(path);
    const current = storeCompatibility(path);
    host.run('INSERT INTO data_profiles(profile_id,profile_path,compatible_schema_min,compatible_schema_max,registration_json,registered_at) VALUES(?,?,?,?,?,?)', p.profileId, path, current.schemaVersion, current.schemaVersion, canonicalize({ registeredBy: peer, current }), new Date().toISOString());
    host.audit('profile.registered', { profileId: p.profileId, path, current }); return { registered: true, profileId: p.profileId, path };
  }
  async function validateRuntimeSource(operation, peer) {
    const intent = JSON.parse(operation.intent_json), profile = host.get('SELECT profile_path FROM data_profiles WHERE profile_id=?', intent.profile), args = peer.parentArguments;
    required(profile && Array.isArray(args), 'The actual runtime has no registered data profile or observed command line.');
    const expected = [join(installRoot, 'node.exe'), '--disable-warning=ExperimentalWarning', join(intent.buildDir, 'runtime', 'runner.mjs'), '--root', profile.profile_path,
      '--connection-file', join(profile.profile_path, 'runtime', 'connection.json'), '--bridge-file', join(intent.buildDir, 'runtime', 'bridge.mjs'), '--first-party-token-stdout', '--supervised'];
    const pathIndexes = new Set([0,2,4,6,8]);
    required(args.length === expected.length && args.every((value,index) => pathIndexes.has(index) ? samePath(value,expected[index]) : value === expected[index]), 'The actual Node arguments, script or data profile differ from the sealed application.');
  }
  function recordReady(p, connection) {
    const registration = host.requireRuntimeParty(connection.runtime, connection.runtime?.policyId, p.runtimeGeneration);
    required(sameProcess(registration.processEvidence, connection.peer.parent), 'Health belongs to a different OS process.');
    const intent = JSON.parse(host.operationRow(registration.operationId).intent_json), build = builds.get(intent.buildId), profile = host.get('SELECT * FROM data_profiles WHERE profile_id=?', intent.profile);
    required(Number.isInteger(p.port) && p.port > 0 && p.port < 65536 && /^[a-f0-9]{64}$/.test(p.token), 'Invalid runtime endpoint.');
    required(p.buildId === intent.buildId && p.protocolVersion === build.manifest.protocolVersion && p.storeSchemaVersion === build.manifest.storeSchemaVersion && samePath(p.applicationRoot, profile.profile_path), 'Build, protocol or store profile health differs.');
    required(!registration.ready, 'Runtime readiness was already registered.');
    registration.ready = { ok: true, buildId: p.buildId, protocolVersion: p.protocolVersion, storeSchemaVersion: p.storeSchemaVersion, storeId: p.storeId, runtimeInstanceId: p.runtimeInstanceId, applicationRoot: profile.profile_path };
    registration.endpoint = { port: p.port, token: p.token };
    host.audit('runtime.ready', { runtimeGeneration: p.runtimeGeneration, ...registration.ready }, { policyId: connection.runtime.policyId }); return { recorded: true };
  }
  async function restart({ connection, policyId, requestId, buildId, operation = 'app.restart' }) {
    host.requireController(connection.controller?.connectionId, policyId);
    const prior = host.get('SELECT o.* FROM operations o JOIN permits p ON p.permit_id=o.permit_id JOIN decisions d ON d.decision_id=p.decision_id WHERE d.policy_id=? AND d.request_id=?', policyId, requestId);
    if (prior) {
      const intent = JSON.parse(prior.intent_json); required(prior.kind === operation && intent.buildId === buildId, 'The request ID belongs to another lifecycle operation.');
      const evidence = JSON.parse(prior.evidence_json); return { outcome: prior.outcome === 'in_progress' ? 'reconciling' : prior.outcome, reason: prior.reason, operationId: prior.operation_id, runtimeGeneration: evidence.runtimeGeneration ?? null, replayed: true, receiptOnly: true };
    }
    const policy = JSON.parse(host.policyRow(policyId).decision_json), build = builds.get(buildId);
    required(policy.scope.verificationOnly===true || build.verification.diagnosticOnly!==true, 'A verification-only build cannot execute a production session.');
    required(policy.scope.verificationOnly===true || build.verification.sourceBuildAttestation?.verified===true, 'A production lifecycle requires independently captured source-to-build compilation evidence.');
    required(samePath(policy.scope.buildRoot, installation.buildRoot), 'The decided build root differs from the installed root.');
    const profile = host.get('SELECT * FROM data_profiles WHERE profile_id=?', policy.scope.dataProfile); required(profile, 'The policy data profile has not been registered.');
    safeProfilePath(installation.profileRoot, profile.profile_path);
    const compatibility = verifyCompatibleRollback({ profilePath: profile.profile_path, supportedMigrations: build.verification.migrations });
    const previous = host.all("SELECT evidence_json FROM operations WHERE policy_id=? AND kind IN ('app.restart','app.rollback','app.verify') ORDER BY created_at DESC", policyId).map(row => JSON.parse(row.evidence_json).launch).find(Boolean);
    const currentProcess = previous && (await native('isRunning', { process: previous })).running ? previous : null;
    const machine = new ApplicationLifecycle({ host,
      launcher: {
        stop: process => native('stopProcess', { domain: policyId, process }),
        start: ({ operationId, launchPath, registrationNonce }) => native('launch', { domain: policyId, remainingMs: Math.min(host.status(policyId).remainingMs, 86_400_000), deadlineUptimeMs: host.time.uptimeMs()+host.status(policyId).remainingMs, expiresAt: host.policyRow(policyId).expires_at, executable: launchPath, cwd: build.build_dir, arguments: [], environment: {
          DESZO_CONTROL_HOST_PIPE: '\\\\.\\pipe\\deszo-control-host-v1', DESZO_HOST_POLICY_ID: policyId, DESZO_HOST_OPERATION_ID: operationId,
          DESZO_HOST_REGISTRATION_NONCE: registrationNonce, DESZO_HOST_PROFILE_ROOT: profile.profile_path,
          DESZO_HOST_NODE_PATH: join(installRoot, 'node.exe'), DESZO_HOST_BUILD_ID: buildId, DESZO_HOST_PROTOCOL_VERSION: String(build.manifest.protocolVersion),
          WEBVIEW2_USER_DATA_FOLDER: join(profile.profile_path, 'webview2'),
        } }),
      },
      inspector: { describe: pid => native('inspect', { pid }), isRunning: async process => (await native('isRunning', { process })).running },
      healthCheck: async ({ runtimeGeneration }) => { const end = Date.now() + 15000; do { const ready = host.runtimeRegistrations.get(runtimeGeneration)?.ready; if (ready) return ready; await new Promise(r => setTimeout(r,25)); } while (Date.now()<end); return null; },
      uiCheck: ({ runtimeGeneration, process }) => captureNativeUi({ native, policyId, runtimeGeneration, process, stateRoot: installation.stateRoot }),
    });
    const result = await machine.restart({ connectionId: connection.controller.connectionId, policyId, requestId, buildRoot: policy.scope.buildRoot, buildDir: build.build_dir,
      manifest: build.manifest, profile: policy.scope.dataProfile, applicationMode: policy.scope.applicationMode, desktop: policy.scope.desktop,
      currentProcess, operation, rationale: `${operation} to exact sealed build ${buildId}`, requireUi: true });
    return { ...result, compatibility };
  }
  const stopping = new ApplicationStop({ host, native });
  const stop = (request, connectionId, options) => stopping.stop(request, connectionId, options);
  return { builds, profiles, registerProfile, validateRuntimeSource, recordReady, restart, stop };
}
