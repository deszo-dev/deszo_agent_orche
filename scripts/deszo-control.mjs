import { spawn } from 'node:child_process';
import { constants, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT, hash, json, writeJson, migrationCatalog, profileCompatibility, inputFingerprint, inputsMatch,
  inspectProfileBindings, inspectRuntimeBuild, writeRuntimeManifest } from './deszo-artifacts.mjs';
import { checkTransport } from './deszo-transport.mjs';
import { assertPlainDirectories, buildLayout } from './build-layout.mjs';

const desktopReceipt = join(PROJECT, 'src-tauri/target/release/deszo-build.json');
const buildInputs = join(PROJECT, 'src-tauri/target/deszo-build-inputs.json');
const binary = join(PROJECT, 'src-tauri/target/release/deszo.exe');
const runtime = join(PROJECT, 'dist-runtime');
const problem = (code, error) => ({ code, ...(error ? { message: error.message } : {}) });
export async function doctor({ profile, build, workflowId, workspaceId, workspaceDirectory, live = false }) {
  if (!profile) throw new Error('--profile is required; do not guess the store.');
  const issues = [], transport = checkTransport();
  let compatibility, bindings, artifact, selected;
  try {
    artifact = build ? inspectRuntimeBuild(join(resolve(build), 'runtime')) : null;
    if (artifact) issues.push(...artifact.issues);
    compatibility = profileCompatibility(profile, artifact?.manifest.migrations ?? migrationCatalog());
    issues.push(...compatibility.issues);
  } catch (error) { issues.push(problem('artifact_or_profile_unreadable', error)); }
  if (existsSync(join(profile, 'store/state.sqlite'))) {
    try { bindings = inspectProfileBindings(profile, { workflowId, workspaceId, workspaceDirectory }); issues.push(...bindings.issues); }
    catch (error) { issues.push(problem('profile_inventory_unreadable', error)); }
  }
  if (!transport.valid) issues.push(problem('transport_verification_missing'));
  if (build && artifact) {
    try {
      const packaged = json(join(build, 'package-manifest.json'));
      if (packaged.kind !== 'DeszoOperatorPackage' || packaged.version !== 1) issues.push(problem('unsupported_package_manifest'));
      if (packaged.testFaultHooks !== false) issues.push(problem('test_fault_hooks_enabled'));
      if (packaged.runtimeManifestSha256 !== hash(readFileSync(join(build, 'runtime/runtime-manifest.json')))) issues.push(problem('runtime_manifest_changed'));
      if (packaged.exeSha256 !== hash(readFileSync(join(build, 'deszo.exe')))) issues.push(problem('desktop_artifact_changed'));
      if (packaged.desktopInputsSha256 !== inputFingerprint('desktop').sha256 || !inputsMatch('runtime', artifact.manifest.runtimeInputs))
        issues.push(problem('source_changed_since_build'));
      if (artifact.manifest.controllerTransport?.fingerprint !== transport.fingerprint) issues.push(problem('build_transport_mismatch'));
    } catch (error) { issues.push(problem('package_manifest_missing', error)); }
  }
  if (live) {
    try {
      const descriptor = json(join(profile, 'runtime/connection.json'));
      if (!Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535 || typeof descriptor.token !== 'string') throw new Error('Invalid descriptor.');
      const response = await fetch(`http://127.0.0.1:${descriptor.port}/api/v3/authoring/contract`, {
        headers: { Authorization: `Bearer ${descriptor.token}` }, redirect: 'error', signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) throw new Error(`Runtime refused health check (${response.status}).`);
      const contract = await response.json();
      const normalize = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
      if (contract.storeId !== descriptor.storeId || contract.runtimeInstanceId !== descriptor.runtimeInstanceId || normalize(contract.applicationRoot) !== normalize(profile))
        throw new Error('Descriptor, requested profile and authenticated runtime disagree.');
      selected = { storeId: contract.storeId, runtimeInstanceId: contract.runtimeInstanceId, applicationRoot: contract.applicationRoot,
        bridgeScript: descriptor.bridgeScript, nodeExecutable: descriptor.nodeExecutable, processContainment: descriptor.processContainment };
      if (build && resolve(descriptor.bridgeScript).toLowerCase() !== resolve(build, 'runtime/bridge.mjs').toLowerCase()) issues.push(problem('runtime_selection_mismatch'));
    } catch { issues.push(problem('runtime_unavailable_or_identity_mismatch')); }
  }
  return { kind: 'DeszoPreflight', inspectedAt: new Date().toISOString(), profile: resolve(profile), build: build ? resolve(build) : null,
    state: issues.length ? 'blocked' : live ? 'ready_to_connect' : 'compatible_offline', issues, compatibility, bindings,
    controller: { verified: transport.valid, fingerprint: transport.fingerprint, clientVersion: transport.identity.clientVersion }, selected,
    nextAction: issues.length ? 'resolve_reported_blockers_before_build_or_launch' : live ? 'connect_MCP_and_verify_exact_grant_and_request' : 'prepare_or_open_reviewed_build',
    authorityGranted: false, modelCalls: 0 };
}
async function buildDesktop() {
  const child = process.platform === 'win32' ? spawn('cmd.exe', ['/d', '/s', '/c', 'npm run desktop:build'], { cwd: PROJECT, windowsHide: true, stdio: 'inherit' })
    : spawn('npm', ['run', 'desktop:build'], { cwd: PROJECT, stdio: 'inherit' });
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
  if (code !== 0) throw new Error(`Desktop build failed (${code}).`);
}
export async function prepare({ profile, out }) {
  if (!out) throw new Error('--out is required.');
  if (process.env.DESZO_TEST_FAULT_HOOKS === '1') throw new Error('Test-enabled fault hooks cannot be prepared as an operator package.');
  if (existsSync(resolve(out))) {
    const existing = await doctor({ profile, build: out });
    const selected = json(join(resolve(out), 'package-manifest.json'));
    if (existing.state !== 'blocked' && resolve(selected.profileAtPreparation).toLowerCase() === resolve(profile).toLowerCase())
      return { prepared: true, cached: true, build: resolve(out), exe: join(resolve(out), 'deszo.exe'), authorityGranted: false, modelCalls: 0 };
    throw Object.assign(new Error('An existing build is incompatible; preserve it and select a new output directory.'), { preflight: existing });
  }
  const preflight = await doctor({ profile });
  if (preflight.state === 'blocked') throw Object.assign(new Error('Preflight blocked preparation.'), { preflight });
  if (preflight.bindings?.activeRuns.length) throw new Error('The profile has unfinished runs. Reconcile them through MCP before preparing its replacement.');
  const insideProfile = relative(resolve(profile), resolve(out));
  if (!insideProfile || (!insideProfile.startsWith('..') && !/^[a-z]:/i.test(insideProfile))) throw new Error('Build output must stay outside the selected data profile.');
  let desktop;
  try { desktop = json(desktopReceipt); } catch { /* No proven reusable desktop. */ }
  const currentRuntimeManifestSha256 = existsSync(join(runtime, 'runtime-manifest.json'))
    ? hash(readFileSync(join(runtime, 'runtime-manifest.json'))) : null;
  if (!desktop || desktop.schemaVersion !== 1 || desktop.testFaultHooks !== false
    || desktop.runtimeManifestSha256 !== currentRuntimeManifestSha256
    || desktop.desktopInputsSha256 !== inputFingerprint('desktop').sha256 || !existsSync(binary) || desktop.exeSha256 !== hash(readFileSync(binary))) {
    await buildDesktop(); desktop = json(desktopReceipt);
  } else {
    let previous; try { previous = inspectRuntimeBuild(runtime); } catch { /* Rebundle only. */ }
    if (!previous || previous.issues.length || !inputsMatch('runtime', previous.manifest.runtimeInputs)) {
      const child = spawn(process.execPath, [join(PROJECT, 'scripts/bundle-runtime.mjs')], { cwd: PROJECT, windowsHide: true, stdio: 'inherit' });
      const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
      if (code !== 0) throw new Error('Runtime bundling failed.');
    }
  }
  if (desktop.testFaultHooks !== false) throw new Error('The desktop build receipt enables test fault hooks; the operator package was not prepared.');
  const check = inspectRuntimeBuild(runtime);
  if (desktop.runtimeManifestSha256 !== hash(readFileSync(join(runtime, 'runtime-manifest.json'))))
    throw new Error('The desktop build receipt does not match the runtime resources; the operator package was not prepared.');
  if (check.issues.length || !inputsMatch('runtime', check.manifest.runtimeInputs)) throw new Error('Runtime inputs changed during preparation.');
  const destination = resolve(out), staging = destination + '.preparing';
  if (existsSync(staging)) throw new Error('An earlier preparation exists. Inspect it; it is not removed automatically.');
  assertPlainDirectories(buildLayout());
  mkdirSync(staging, { recursive: true }); cpSync(runtime, join(staging, 'runtime'), { recursive: true });
  cpSync(binary, join(staging, 'deszo.exe'));
  writeJson(join(staging, 'package-manifest.json'), { kind: 'DeszoOperatorPackage', version: 1, testFaultHooks: false, preparedAt: new Date().toISOString(),
    exeSha256: desktop.exeSha256, desktopInputsSha256: desktop.desktopInputsSha256, profileAtPreparation: resolve(profile),
    runtimeManifestSha256: hash(readFileSync(join(staging, 'runtime/runtime-manifest.json'))), authorityGranted: false });
  const final = await doctor({ profile, build: staging });
  if (final.state === 'blocked') throw Object.assign(new Error('Packaged preflight failed; staging is preserved.'), { preflight: final });
  renameSync(staging, destination);
  writeJson(join(PROJECT, '.deszo/operator/current-package.json'), { build: destination, profile: resolve(profile),
    preparedAt: new Date().toISOString(), assurance: 'Public locator only; run doctor and verify live MCP identity before use.' });
  return { prepared: true, build: destination, exe: join(destination, 'deszo.exe'), authorityGranted: false, modelCalls: 0 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = name => { const index = process.argv.indexOf(`--${name}`); return index < 0 ? undefined : process.argv[index + 1]; };
  try {
    const command = process.argv[2]; let result;
    if (command === 'doctor') result = await doctor({ profile: option('profile'), build: option('build'), workflowId: option('workflow'),
      workspaceId: option('workspace'), workspaceDirectory: option('workspace-dir'), live: process.argv.includes('--live') });
    else if (command === 'prepare') result = await prepare({ profile: option('profile'), out: option('out') });
    else if (command === 'build-begin') {
      const layout = buildLayout();
      assertPlainDirectories(layout);
      const testFaultHooks = process.env.DESZO_TEST_FAULT_HOOKS === '1';
      // Outputs of an earlier build are removed first, so build-finish can only publish what this build produced.
      for (const path of [layout.receipt, layout.exe, layout.shim, layout.runtimeShim]) rmSync(path, { force: true });
      result = { schemaVersion: 1, desktopBuildId: process.env.DESZO_DESKTOP_BUILD_ID ?? null, testFaultHooks,
        desktopInputsSha256: inputFingerprint('desktop').sha256, runtimeInputsSha256: inputFingerprint('runtime').sha256 };
      writeJson(layout.inputs, result);
    }
    else if (command === 'build-finish') {
      const layout = buildLayout();
      assertPlainDirectories(layout);
      const before = json(layout.inputs);
      const testFaultHooks = process.env.DESZO_TEST_FAULT_HOOKS === '1';
      if (before.desktopBuildId !== (process.env.DESZO_DESKTOP_BUILD_ID ?? null) || before.testFaultHooks !== testFaultHooks
        || before.desktopInputsSha256 !== inputFingerprint('desktop').sha256 || before.runtimeInputsSha256 !== inputFingerprint('runtime').sha256)
        throw new Error('Build inputs or mode changed during compilation; no desktop receipt is published.');
      // One compilation publishes the shim: tauri build compiled it with deszo.exe, and that copy is the one the runtime ships.
      if (!existsSync(layout.shim) || !existsSync(layout.exe)) throw new Error('The desktop build did not produce deszo.exe and the launch shim; no receipt is published.');
      mkdirSync(layout.runtime, { recursive: true });
      // The directories are checked again right before this write (a link created after the first check is refused here).
      assertPlainDirectories(layout);
      // A stale or redirected entry is removed first, so the copy creates a new file and never writes through an existing link.
      rmSync(layout.runtimeShim, { force: true });
      copyFileSync(layout.shim, layout.runtimeShim, constants.COPYFILE_EXCL);
      const publishedShim = hash(readFileSync(layout.runtimeShim));
      if (publishedShim !== hash(readFileSync(layout.shim))) throw new Error('The published launch shim differs from the compiled one; no receipt is published.');
      const manifest = writeRuntimeManifest(layout.runtime, { testFaultHooks });
      result = { ...before, runtimeManifestSha256: hash(readFileSync(join(layout.runtime, 'runtime-manifest.json'))),
        runtimeFiles: manifest.files, exeSha256: hash(readFileSync(layout.exe)), launchShimSha256: publishedShim, builtAt: new Date().toISOString() };
      writeJson(layout.receipt, result);
    } else throw new Error('Use doctor --profile PATH [--build PATH] [--live], or prepare --profile PATH --out NEW_PATH.');
    if (option('out') && command === 'doctor') writeJson(resolve(option('out')), result);
    console.log(JSON.stringify(result)); if (result.state === 'blocked') process.exitCode = 1;
  } catch (error) { console.error(JSON.stringify({ error: error.message, ...(error.preflight ? { preflight: error.preflight } : {}) })); process.exitCode = 1; }
}
