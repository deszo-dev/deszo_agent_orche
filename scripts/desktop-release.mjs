// P5-CLOSURE §5: packages a desktop (tauri) release the Rust Lifecycle Host attests, with the trusted P5 support payload.
// Layout of the release directory (the Host's `versions/<buildId>`):
//   deszo.exe                      the desktop shell (Host-side; recorded by digest, never repairable)
//   runtime/                       desktop runtime resources; runner.mjs is rebuilt here from the payload below
//   p5/                            the attested runtime source layout and dependency closure, plus p5-support.json
//   .deszo-source-inventory.json   committed source inventory (Host-served for source attestation)
//   build.json                     bootstrap "tauri" with sourceCommit, source digest, input digest and every artifact digest
// Everything derives from one clean committed checkout (capturedReleaseSource). The Engine bundle is not taken on trust: it
// is built from the copied payload sources and rebuilt a second time; both builds must be byte-identical.
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { canonicalize, sha256 } from '../runtime/core/canonical.mjs';
import { buildInputsDigest } from '../runtime/host/installedBuilds.mjs';
import { assertReleaseSourceUnchanged, capturedReleaseSource, copyRuntimeSourceLayout, RUNTIME_API_VERSION, writeSourceInventory } from '../runtime/host/runtimeRelease.mjs';
import { SOURCE_INVENTORY_PATH } from '../runtime/host/sourceProvenance.mjs';
import { P5_SUPPORT_KIND, P5_SUPPORT_MANIFEST } from '../runtime/core/p5Support.mjs';
import { P5_SUPPORT_ROOT_NAME } from '../runtime/core/engineRoot.mjs';
import { bundleRunner } from './runtime-bundle.mjs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const refuse = message => { throw Object.assign(new Error(message), { code: 'desktop_release_refused' }); };
const portable = (root, path) => relative(root, path).split(sep).join('/');
function plainFiles(root) {
  const files = [];
  const walk = directory => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), info = lstatSync(path);
      if (info.isSymbolicLink()) refuse(`A packaged path is a reparse point: ${path}`);
      if (info.isDirectory()) walk(path); else if (info.isFile()) files.push(path); else refuse(`Unsupported packaged object: ${path}`);
    }
  };
  walk(root);
  return files;
}
const digestFile = (root, path) => ({ path: portable(root, path), sha256: sha256(readFileSync(path)), bytes: statSync(path).size });

/**
 * @param sourceRoot clean committed checkout the release is derived from
 * @param desktopExecutable the compiled desktop shell whose build identity is `buildId`
 * @param runtimeResources the desktop runtime resource directory (`dist-runtime`); its runner.mjs is replaced by the rebuild
 */
export async function packageDesktopRelease({ sourceRoot, gitTool, outDir, buildId, desktopExecutable, runtimeResources }) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(buildId || '')) refuse('A simple build identity is required.');
  const out = resolve(outDir);
  if (existsSync(out)) refuse('The release destination already exists and is never replaced.');
  for (const name of ['bridge.mjs', 'deszo-launch-shim.exe', 'runtime-manifest.json'])
    if (!existsSync(join(runtimeResources, name))) refuse(`The desktop runtime resources lack ${name}.`);
  const { root, closure, packaged, dependencyPackages } = await capturedReleaseSource({ sourceRoot, gitTool });
  const { sourceCommit, sourceDigest } = closure.source;
  const inputsDigest = buildInputsDigest(closure);
  mkdirSync(out);
  const payloadRoot = join(out, P5_SUPPORT_ROOT_NAME), runtimeRoot = join(out, 'runtime');
  mkdirSync(payloadRoot); mkdirSync(runtimeRoot);
  const payloadFiles = copyRuntimeSourceLayout({ root, packaged, dependencyPackages, out: payloadRoot });

  // The Engine bundle, built from the attested payload, then reproduced.
  const runnerPath = join(runtimeRoot, 'runner.mjs');
  await bundleRunner({ root: payloadRoot, outfile: runnerPath });
  const reproductionRoot = mkdtempSync(join(tmpdir(), 'deszo-desktop-reproduce-'));
  try {
    await bundleRunner({ root: payloadRoot, outfile: join(reproductionRoot, 'runner.mjs') });
    if (!readFileSync(runnerPath).equals(readFileSync(join(reproductionRoot, 'runner.mjs'))))
      refuse('The Engine bundle is not reproducible from the attested payload.');
  } finally { rmSync(reproductionRoot, { recursive: true, force: true }); }
  const runnerDigest = sha256(readFileSync(runnerPath));

  // The remaining desktop runtime resources, with their resource manifest describing the rebuilt bundle.
  for (const name of readdirSync(runtimeResources).sort()) {
    if (['runner.mjs', 'runtime-manifest.json'].includes(name)) continue;
    const from = join(runtimeResources, name);
    if (!lstatSync(from).isFile()) refuse(`Desktop runtime resources must be plain files: ${name}`);
    copyFileSync(from, join(runtimeRoot, name));
  }
  const resourceManifest = JSON.parse(readFileSync(join(runtimeResources, 'runtime-manifest.json'), 'utf8'));
  resourceManifest.files = Object.fromEntries(readdirSync(runtimeRoot).sort().map(name => [name, sha256(readFileSync(join(runtimeRoot, name)))]));
  resourceManifest.sourceHead = sourceCommit;
  resourceManifest.assurance = 'Desktop release resources; the Engine bundle is reproduced from the attested P5 support payload.';
  writeFileSync(join(runtimeRoot, 'runtime-manifest.json'), `${JSON.stringify(resourceManifest, null, 2)}\n`, { flag: 'wx' });
  copyFileSync(desktopExecutable, join(out, 'deszo.exe'));

  const support = { schemaVersion: 1, kind: P5_SUPPORT_KIND, buildId, sourceCommit, sourceDigest, inputsDigest,
    dependencyDigest: closure.dependencyDigest, dependencyPackages,
    runtimeBundle: { path: 'runtime/runner.mjs', sha256: runnerDigest, bytes: statSync(runnerPath).size, reproducible: true },
    // Review R2: the packager is part of the trusted build base. Its toolchain, and the desktop resources it copies rather than
    // reproduces from the payload, are recorded so P6 or an auditor can re-derive or compare them.
    builder: { node: process.version, esbuild: createRequire(import.meta.url)('esbuild/package.json').version },
    copiedResources: readdirSync(runtimeRoot).filter(name => name !== 'runner.mjs').sort()
      .map(name => ({ path: `runtime/${name}`, sha256: sha256(readFileSync(join(runtimeRoot, name))) })),
    desktopExecutable: { path: 'deszo.exe', sha256: sha256(readFileSync(join(out, 'deszo.exe'))) },
    files: payloadFiles.map(({ path, sha256: digest, bytes }) => ({ path, sha256: digest, bytes })) };
  const supportBytes = Buffer.from(canonicalize(support), 'utf8');
  writeFileSync(join(payloadRoot, P5_SUPPORT_MANIFEST), supportBytes, { flag: 'wx' });
  const inventory = writeSourceInventory(out, closure);
  const artifacts = plainFiles(out).map(path => digestFile(out, path)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest = { schemaVersion: 1, buildId, runtimeApiVersion: RUNTIME_API_VERSION, bootstrap: 'tauri',
    desktopExecutable: 'deszo.exe', desktopBuildId: buildId, sourceCommit, dirtySourceDigest: sourceDigest, inputsDigest, artifacts,
    sourceInventory: { path: SOURCE_INVENTORY_PATH, sha256: inventory.sha256 },
    p5Support: { path: `${P5_SUPPORT_ROOT_NAME}/${P5_SUPPORT_MANIFEST}`, sha256: sha256(supportBytes) } };
  writeFileSync(join(out, 'build.json'), JSON.stringify(manifest), { flag: 'wx' });
  await assertReleaseSourceUnchanged({ root, gitTool, closure });
  return { buildId, sourceCommit, sourceDigest, inputsDigest, runnerDigest, dependencyPackages, payloadFiles: payloadFiles.length,
    runnerBytes: support.runtimeBundle.bytes, manifest };
}

// Release entry point (review R1): node scripts/desktop-release.mjs --source <clean checkout> --out <new release directory>
//   --build-id <id> [--git <git.exe>] [--exe <deszo.exe>] [--resources <dist-runtime>]
// The desktop shell must have been built with DESZO_DESKTOP_BUILD_ID=<id> (npm run desktop:build) and the runtime resources
// with npm run runtime:bundle and npm run shim:build. The output is installed by the Lifecycle Host as versions/<id>.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const option = (name, fallback = null) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1]; };
  const repo = resolve(import.meta.dirname, '..');
  const gitPath = option('--git') ?? execFileSync('where.exe', ['git.exe'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0].trim();
  const gitTool = { path: gitPath, sha256: sha256(readFileSync(gitPath)) };
  const result = await packageDesktopRelease({ sourceRoot: resolve(option('--source', repo)), gitTool, outDir: resolve(option('--out')),
    buildId: option('--build-id'), desktopExecutable: resolve(option('--exe', join(repo, 'src-tauri', 'target', 'release', 'deszo.exe'))),
    runtimeResources: resolve(option('--resources', join(repo, 'dist-runtime'))) });
  process.stdout.write(`${JSON.stringify({ buildId: result.buildId, sourceCommit: result.sourceCommit, sourceDigest: result.sourceDigest,
    inputsDigest: result.inputsDigest, runnerDigest: result.runnerDigest, payloadFiles: result.payloadFiles })}\n`);
}
