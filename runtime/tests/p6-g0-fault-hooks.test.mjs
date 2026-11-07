import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { newScratch } from './custody-support.mjs';

const repo = resolve(import.meta.dirname, '../..');
const custodyPath = resolve(repo, 'runtime/core/custody.mjs');
const custodySpecifier = custodyPath.replaceAll('\\', '/');
const custody = pathToFileURL(custodyPath).href;

function rawRuntimePackage(root, { support = false, testFaultHooks = false } = {}) {
  const packageRoot = support ? join(root, 'p5') : root;
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(join(packageRoot, 'runtime'), { recursive: true });
  mkdirSync(join(packageRoot, 'shared'), { recursive: true });
  mkdirSync(join(packageRoot, 'docs/schemas'), { recursive: true });
  mkdirSync(join(packageRoot, 'docs/storage'), { recursive: true });
  cpSync(resolve(repo, 'runtime/core'), join(packageRoot, 'runtime/core'), { recursive: true });
  cpSync(resolve(repo, 'runtime/host'), join(packageRoot, 'runtime/host'), { recursive: true });
  cpSync(resolve(repo, 'runtime/lock.mjs'), join(packageRoot, 'runtime/lock.mjs'));
  cpSync(resolve(repo, 'shared/effort.mjs'), join(packageRoot, 'shared/effort.mjs'));
  cpSync(resolve(repo, 'docs/schemas'), join(packageRoot, 'docs/schemas'), { recursive: true });
  for (const name of ['host-h1.sql', 'host-h2.sql', 'host-h3.sql', 'host-h4.sql', 'host-h5.sql'])
    cpSync(resolve(repo, 'docs/storage', name), join(packageRoot, 'docs/storage', name));
  const artifacts = [];
  if (testFaultHooks) {
    const markerPath = join(packageRoot, '.deszo-test-fault-hooks');
    const markerBytes = 'DESZO_TEST_FAULT_HOOKS_V1\n';
    writeFileSync(markerPath, markerBytes);
    artifacts.push({ path: '.deszo-test-fault-hooks', sha256: createHash('sha256').update(markerBytes).digest('hex'), bytes: Buffer.byteLength(markerBytes) });
  }
  const manifest = { schemaVersion: 1, artifacts };
  if (support) writeFileSync(join(packageRoot, 'p5-support.json'), JSON.stringify(manifest));
  else writeFileSync(join(packageRoot, 'build.json'), JSON.stringify(manifest));
  return {
    custody: pathToFileURL(join(packageRoot, 'runtime/core/custody.mjs')).href,
    lock: pathToFileURL(join(packageRoot, 'runtime/lock.mjs')).href,
    lifecycle: pathToFileURL(join(packageRoot, 'runtime/host/lifecycleBridge.mjs')).href,
    binding: pathToFileURL(join(packageRoot, 'runtime/host/runtimeBinding.mjs')).href,
  };
}

test('P6-G0 production bundles ignore environment fault hooks while source tests retain them', { timeout: 120_000 }, async () => {
  const scratch = newScratch('p6-g0-fault-hooks');
  try {
    const debugFault = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { custodyFaultPoint } from ${JSON.stringify(custody)}; custodyFaultPoint('g0-proof'); console.log('continued');`], {
      cwd: repo, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, DESZO_CUSTODY_TEST_FAULT: 'g0-proof' },
    });
    assert.equal(debugFault.status, 97, 'source/debug build executes the named authorized fault');

    const oneShot = join(scratch.root, 'one-shot.txt');
    const transient = join(scratch.root, 'transient.txt');
    const outage = join(scratch.root, 'outage.flag');
    const refusal = join(scratch.root, 'refusal.flag');
    const crashIdentity = join(scratch.root, 'crash-identity.flag');
    for (const path of [oneShot, transient, outage, refusal, crashIdentity]) writeFileSync(path, 'g0-proof');

    const entry = join(scratch.root, 'production-fault-probe.mjs');
    const output = join(scratch.root, 'production-fault-probe.bundle.mjs');
    writeFileSync(entry, `import { custodyFaultPoint, custodyCrashOnce, custodyTransientFault, crashBeforeIdentityPoint, custodyOutageActive, custodyRefusalActive, installCustody } from ${JSON.stringify(custodySpecifier)};
class Engine {}
installCustody(Engine);
const engine = new Engine();
engine.custodyHost = { context: { generation: 'g0' }, custody: async () => ({ launched: true }) };
engine.custodyEpoch = 1;
engine.custodyLaunchReplyLost = false;
custodyFaultPoint('g0-proof');
custodyCrashOnce('g0-proof');
custodyTransientFault('g0-proof');
const identityFault = crashBeforeIdentityPoint();
const outageFault = custodyOutageActive();
const refusalFault = custodyRefusalActive('g0', 'custody.status');
const launch = await engine.custodyCall('custody.launch', {});
process.stdout.write(JSON.stringify({ identityFault, outageFault, refusalFault, launch }) + '\\n');
`);
    await build({ entryPoints: [entry], outfile: output, bundle: true, platform: 'node', format: 'esm', target: 'node22',
      define: { __DESZO_PACKAGED__: 'true' }, legalComments: 'none' });

    const production = spawnSync(process.execPath, [output], {
      cwd: repo, encoding: 'utf8', windowsHide: true,
      env: {
        ...process.env,
        DESZO_CUSTODY_TEST_FAULT: 'g0-proof',
        DESZO_P5_TEST_CRASH_ONCE: oneShot,
        DESZO_P5_TEST_TRANSIENT_CAPTURE: transient,
        DESZO_TEST_CRASH_BEFORE_IDENTITY_MARKER: crashIdentity,
        DESZO_CUSTODY_TEST_OUTAGE_FILE: outage,
        DESZO_CUSTODY_TEST_REFUSE_FILE: refusal,
        DESZO_CUSTODY_TEST_DROP_LAUNCH_REPLY: '1',
      },
    });
    assert.equal(production.status, 0, production.stderr);
    assert.deepEqual(JSON.parse(production.stdout.trim()), {
      identityFault: false, outageFault: false, refusalFault: false, launch: { launched: true },
    });
    assert.equal(existsSync(oneShot), true, 'production hook does not consume the crash-once marker');
    assert.equal(readFileSync(oneShot, 'utf8'), 'g0-proof');
    assert.equal(existsSync(`${refusal}.calls`), false, 'production hook does not append refusal evidence');

    const debugLaunch = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { installCustody } from ${JSON.stringify(custody)}; class Engine {}; installCustody(Engine); const e = new Engine(); e.custodyHost = { context: { generation: 'g0' }, custody: async () => ({ launched: true }) }; e.custodyEpoch = 1; e.custodyLaunchReplyLost = false; await e.custodyCall('custody.launch', {});`], {
      cwd: repo, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, DESZO_CUSTODY_TEST_DROP_LAUNCH_REPLY: '1' },
    });
    assert.equal(debugLaunch.status, 1, 'source/debug build retains the lost-launch-reply test seam');
    assert.match(debugLaunch.stderr, /Injected fault: the launch reply was lost/);
  } finally {
    if (existsSync(scratch.root)) rmSync(scratch.root, { recursive: true, force: true });
  }
});

test('P6-G0 raw runtime and P5 support source close fault hooks in production packages', { timeout: 120_000 }, () => {
  const scratch = newScratch('p6-g0-raw-fault-hooks');
  try {
    const productionRuntime = rawRuntimePackage(join(scratch.root, 'production-runtime'));
    const productionSupport = rawRuntimePackage(join(scratch.root, 'production-desktop'), { support: true });
    const testPackage = rawRuntimePackage(join(scratch.root, 'test-runtime'), { testFaultHooks: true });
    const probe = (source, moduleUrl, env) => spawnSync(process.execPath, ['--input-type=module', '-e', source(moduleUrl)], {
      cwd: repo, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env },
    });

    const custodyProbe = url => `import { custodyFaultPoint } from ${JSON.stringify(url)}; custodyFaultPoint('g0-proof'); console.log('continued');`;
    const lockProbe = url => `import { acquireRuntimeLock } from ${JSON.stringify(url)}; await acquireRuntimeLock(${JSON.stringify(join(scratch.root, 'raw-lock'))}); console.log('continued');`;
    const bridgeProbe = url => `import { lifecycleBridgeFromEnvironment } from ${JSON.stringify(url)};
const env = { DESZO_LIFECYCLE_HOST_ADDRESS: '127.0.0.1:32123', DESZO_LIFECYCLE_HOST_CAPABILITY: 'a'.repeat(64),
  DESZO_LIFECYCLE_INSTALLATION_ID: 'installation', DESZO_LIFECYCLE_PROFILE_ROOT: 'profile', DESZO_LIFECYCLE_GENERATION: 'generation',
  DESZO_APPLICATION_BUILD_ID: 'build', DESZO_LIFECYCLE_APPLICATION_PID: 'self', DESZO_TEST_DUPLICATE_LIFECYCLE_RECEIPT: '1' };
const bridge = lifecycleBridgeFromEnvironment(env); console.log(String(bridge.context.testDuplicateReceiptDelivery));`;
    const bindingProbe = url => `import { fixtureHostAllowed } from ${JSON.stringify(url)};
console.log(String(fixtureHostAllowed({ DESZO_ALLOW_FIXTURE_HOST: '1' })) + ',' + String(fixtureHostAllowed({ DESZO_ALLOW_FIXTURE_HOST: '1' }, { packaged: true })));`;

    for (const packageSet of [productionRuntime, productionSupport]) {
      const productionEnv = {
        DESZO_CUSTODY_TEST_FAULT: 'g0-proof',
        DESZO_RUNNER_LOCK_TEST_FAULT: 'after-ownership',
        DESZO_TEST_DUPLICATE_LIFECYCLE_RECEIPT: '1',
        DESZO_ALLOW_FIXTURE_HOST: '1',
      };
      const production = probe(custodyProbe, packageSet.custody, productionEnv);
      assert.equal(production.status, 0, production.stderr);
      assert.equal(production.stdout.trim(), 'continued');
      const lock = probe(lockProbe, packageSet.lock, productionEnv);
      assert.equal(lock.status, 0, lock.stderr);
      assert.equal(lock.stdout.trim(), 'continued', 'raw production lock source ignores environment crash points');
      const lifecycle = probe(bridgeProbe, packageSet.lifecycle, productionEnv);
      assert.equal(lifecycle.status, 0, lifecycle.stderr);
      assert.equal(lifecycle.stdout.trim(), 'false', 'raw production lifecycle source ignores duplicate-receipt injection');
      const binding = probe(bindingProbe, packageSet.binding, productionEnv);
      assert.equal(binding.status, 0, binding.stderr);
      assert.equal(binding.stdout.trim(), 'false,false', 'raw production source refuses fixture Host assurance');
    }

    const testEnv = {
      DESZO_CUSTODY_TEST_FAULT: 'g0-proof',
      DESZO_RUNNER_LOCK_TEST_FAULT: 'after-ownership',
      DESZO_TEST_DUPLICATE_LIFECYCLE_RECEIPT: '1',
      DESZO_ALLOW_FIXTURE_HOST: '1',
    };
    const debug = probe(custodyProbe, testPackage.custody, testEnv);
    assert.equal(debug.status, 97, 'the test-owned package marker keeps the authorized seam available');
    const debugLock = probe(lockProbe, testPackage.lock, testEnv);
    assert.equal(debugLock.status, 97, 'the test-owned package marker keeps lock crash points available');
    const debugLifecycle = probe(bridgeProbe, testPackage.lifecycle, testEnv);
    assert.equal(debugLifecycle.status, 0, debugLifecycle.stderr);
    assert.equal(debugLifecycle.stdout.trim(), 'true', 'the test-owned package marker keeps duplicate receipt coverage available');
    const debugBinding = probe(bindingProbe, testPackage.binding, testEnv);
    assert.equal(debugBinding.status, 0, debugBinding.stderr);
    assert.equal(debugBinding.stdout.trim(), 'true,false');
  } finally {
    if (existsSync(scratch.root)) rmSync(scratch.root, { recursive: true, force: true });
  }
});
