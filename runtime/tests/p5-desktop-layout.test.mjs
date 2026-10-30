// P5-CLOSURE §5.8 (7): the P5 package-layout check exactly as it runs inside a bundled desktop release. A small entry is
// bundled with the release's packaged define into <release>/runtime/runner.mjs, so ENGINE_ROOT is <release>/p5 and the
// running file is the bundle, as in the shipped Engine. Every payload, bundle or identity mismatch refuses admission, and a
// legacy desktop release without a payload refuses P5 while the bundle itself loads normally.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { canonicalize } from '../core/canonical.mjs';
import { newScratch } from './custody-support.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const repo = resolve(import.meta.dirname, '../..');

async function release(root, name, { payload = true } = {}) {
  const releaseRoot = join(root, name), runtimeRoot = join(releaseRoot, 'runtime'), payloadRoot = join(releaseRoot, 'p5');
  mkdirSync(runtimeRoot, { recursive: true });
  const entry = join(root, `${name}-entry.mjs`);
  writeFileSync(entry, `export { verifyP5PackageLayout } from ${JSON.stringify(join(repo, 'runtime/core/p5Support.mjs').replaceAll('\\', '/'))};\n`);
  await build({ entryPoints: [entry], outfile: join(runtimeRoot, 'runner.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22',
    define: { __DESZO_PACKAGED__: 'true' }, legalComments: 'none' });
  const identity = { buildId: 'layout-build', sourceCommit: 'a'.repeat(40), sourceDigest: 'b'.repeat(64), inputsDigest: 'c'.repeat(64) };
  if (payload) {
    mkdirSync(join(payloadRoot, 'runtime', 'verification'), { recursive: true });
    cpSync(join(repo, 'runtime/verification/p5Verifier.mjs'), join(payloadRoot, 'runtime/verification/p5Verifier.mjs'));
    writeFileSync(join(payloadRoot, 'package.json'), '{"name":"layout"}\n');
    const files = ['package.json', 'runtime/verification/p5Verifier.mjs'].map(path => {
      const bytes = readFileSync(join(payloadRoot, ...path.split('/')));
      return { path, sha256: sha256(bytes), bytes: bytes.length };
    });
    writeFileSync(join(payloadRoot, 'p5-support.json'), canonicalize({ schemaVersion: 1, kind: 'DeszoP5SupportPayload', ...identity, dependencyPackages: [],
      runtimeBundle: { path: 'runtime/runner.mjs', sha256: sha256(readFileSync(join(runtimeRoot, 'runner.mjs'))), reproducible: true }, files }));
  }
  const { verifyP5PackageLayout } = await import(`${pathToFileURL(join(runtimeRoot, 'runner.mjs')).href}?${name}`);
  return { releaseRoot, payloadRoot, runtimeRoot, verify: (overrides = {}) => verifyP5PackageLayout({ bootstrap: 'tauri', ...identity, ...overrides }) };
}

test('P5-CLOSURE desktop layout: the bundled Engine admits only its exact attested P5 support payload', { timeout: 120_000 }, async () => {
  const scratch = newScratch('p5-desktop-layout');
  try {
    const good = await release(scratch.root, 'good');
    const layout = good.verify();
    assert.equal(layout.layout, 'desktop-support'); assert.equal(resolve(layout.root), resolve(good.payloadRoot));
    assert.throws(() => good.verify({ sourceCommit: 'd'.repeat(40) }), { code: 'p5_support_payload_mismatch' }, 'another source commit');
    assert.throws(() => good.verify({ sourceDigest: 'e'.repeat(64) }), { code: 'p5_support_payload_mismatch' }, 'another source digest');
    assert.throws(() => good.verify({ buildId: 'other-build' }), { code: 'p5_support_payload_mismatch' }, 'another build');
    assert.throws(() => good.verify({ bootstrap: 'runtime' }), { code: 'p5_package_layout_unsupported' }, 'a bundle claiming a runtime-bootstrap release');

    const tampered = await release(scratch.root, 'tampered');
    writeFileSync(join(tampered.payloadRoot, 'runtime/verification/p5Verifier.mjs'), '// candidate-substituted verifier\n');
    assert.throws(() => tampered.verify(), { code: 'p5_support_payload_mismatch' }, 'a substituted trusted verifier');

    const extra = await release(scratch.root, 'extra');
    writeFileSync(join(extra.payloadRoot, 'runtime', 'shadow.mjs'), 'export {};\n');
    assert.throws(() => extra.verify(), { code: 'p5_support_payload_mismatch' }, 'an unlisted payload file');

    const rebundled = await release(scratch.root, 'rebundled');
    const manifest = JSON.parse(readFileSync(join(rebundled.payloadRoot, 'p5-support.json'), 'utf8'));
    manifest.runtimeBundle.sha256 = '0'.repeat(64);
    writeFileSync(join(rebundled.payloadRoot, 'p5-support.json'), canonicalize(manifest));
    assert.throws(() => rebundled.verify(), { code: 'p5_support_bundle_mismatch' }, 'a running bundle the payload did not reproduce');

    const legacy = await release(scratch.root, 'legacy', { payload: false });
    assert.throws(() => legacy.verify(), { code: 'p5_support_payload_missing' }, 'a legacy desktop release keeps P5 closed');
  } finally { rmSync(scratch.root, { recursive: true, force: true }); }
});
