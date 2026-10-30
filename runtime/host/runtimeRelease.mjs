// Packages a `runtime`-bootstrap release that the Rust Lifecycle Host can attest. The release is derived only from a
// clean, committed source checkout: its source commit, SHA-256 source inventory and build-input digest come from the same
// securityClosure the protected build staging uses, and every packaged byte is checked against that inventory.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { canonicalHash, canonicalize, sha256 } from '../core/canonical.mjs';
import { HostError } from './authority.mjs';
import { buildInputsDigest, plainFiles, securityClosure } from './installedBuilds.mjs';
import { SOURCE_INVENTORY_PATH } from './sourceProvenance.mjs';

const refuse = message => { throw new HostError(403, 'runtime_release_refused', message); };
// Source paths a runtime-bootstrap package carries; tests, test fixtures, UI sources and build tooling stay out of it.
export const RUNTIME_RELEASE_PATTERN = /^(runtime\/(?!tests\/)|mcp\/|shared\/|docs\/(schemas|storage|authoring)\/|docs\/examples\/(m1-context-chain|reference-delivery|managed-task)\/|package\.json$)/;
export const RUNTIME_API_VERSION = 2;

function git(sourceRoot, gitTool, args, encoding = 'utf8') {
  return execFileSync(gitTool.path, ['--no-pager', '-c', `safe.directory=${resolve(sourceRoot).replace(/\\/g, '/')}`, '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=NUL', '-C', sourceRoot, ...args], {
    encoding, windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024, env: { SystemRoot: process.env.SystemRoot || process.env.WINDIR || '',
      PATH: dirname(gitTool.path), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_OPTIONAL_LOCKS: '0' } });
}
const gitStatus = (sourceRoot, gitTool) => git(sourceRoot, gitTool, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=no']);

/**
 * P5-CLOSURE F12: one byte identity. Release bytes must be the committed blob bytes, never a working-tree conversion (Windows
 * `core.autocrlf`, `.gitattributes` eol/text/filter). Git reports such a checkout as clean, so every packaged file is hashed
 * as a Git blob from its actual bytes and compared with the commit's tree. A conversion refuses the release instead of
 * producing an installed source identity that differs from the Git source P5 verifies and repairs.
 */
function assertWorkingTreeEqualsCommittedBlobs(root, gitTool, paths) {
  const listing = git(root, gitTool, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'], null);
  const blobs = new Map();
  for (const record of listing.toString('utf8').split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t'), [mode, type, oid] = record.slice(0, tab).split(' ');
    if (type === 'blob' && /^100(644|755)$/.test(mode)) blobs.set(record.slice(tab + 1), oid);
  }
  const algorithm = [...blobs.values()][0]?.length === 64 ? 'sha256' : 'sha1';
  for (const path of paths) {
    const bytes = readFileSync(join(root, ...path.split('/')));
    const oid = createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (blobs.get(path) !== oid)
      refuse(`Release bytes of ${path} differ from the committed Git blob (line-ending or filter conversion); package from a checkout with core.autocrlf=false and no eol/filter attributes.`);
  }
}

// Files Node never loads at runtime stay out of the shipped dependency closure; a package used only through its main
// entry (the TypeScript compiler API) ships just that entry and its manifest.
const NON_RUNTIME_FILE = /\.(d\.[cm]?ts|map|md|markdown|[cm]?ts|tsx)$/i;
const ENTRY_ONLY_PACKAGES = Object.freeze({ typescript: ['package.json', 'lib/typescript.js'] });
const shippedPackageFiles = (root, name) => {
  const base = join(root, 'node_modules', ...name.split('/'));
  const entryOnly = ENTRY_ONLY_PACKAGES[name];
  return plainFiles(base).filter(path => {
    const inside = relative(base, path).split(sep).join('/');
    return entryOnly ? entryOnly.includes(inside) : !NON_RUNTIME_FILE.test(inside);
  });
};

const packageName = specifier => specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];

/**
 * The runtime's third-party closure: every bare package the attested runtime import graph names, plus their declared
 * dependencies, resolved from the checkout's node_modules (whose bytes are already part of the attested inputsDigest).
 * The package ships them so the installed Engine never resolves an unattested ambient module.
 */
function runtimeDependencyClosure(root, closure) {
  const pending = [...new Set(closure.importGraph.edges.filter(edge => edge.package).map(edge => packageName(edge.package)))];
  const names = new Set();
  while (pending.length) {
    const name = pending.pop();
    if (names.has(name)) continue;
    const manifestPath = join(root, 'node_modules', ...name.split('/'), 'package.json');
    if (!existsSync(manifestPath)) refuse(`The runtime dependency "${name}" is not installed in the release checkout.`);
    names.add(name);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    // Review F17: installed optional and peer dependencies are loadable too, so they ship (and are attested) as well.
    pending.push(...Object.keys(manifest.dependencies || {}), ...Object.keys({ ...manifest.optionalDependencies, ...manifest.peerDependencies })
      .filter(item => existsSync(join(root, 'node_modules', ...item.split('/'), 'package.json'))));
  }
  return [...names].sort();
}

/**
 * The clean committed checkout and its captured security closure, the identity every release format derives from.
 * Refuses a dirty checkout, a missing inventory file or a source without the runtime entry points.
 */
export async function capturedReleaseSource({ sourceRoot, gitTool }) {
  const root = resolve(sourceRoot);
  if (gitStatus(root, gitTool).trim()) refuse('A release is packaged only from a clean committed checkout.');
  const closure = await securityClosure(root, gitTool);
  if (closure.source.files.some(file => file.absent)) refuse('The committed source inventory has a missing file.');
  const packaged = closure.source.files.filter(file => RUNTIME_RELEASE_PATTERN.test(file.path));
  if (!packaged.some(file => file.path === 'runtime/runner.mjs') || !packaged.some(file => file.path === 'runtime/core/engine.mjs'))
    refuse('The source does not contain the runtime entry points.');
  assertWorkingTreeEqualsCommittedBlobs(root, gitTool, closure.source.files.map(file => file.path));
  return { root, closure, packaged, dependencyPackages: runtimeDependencyClosure(root, closure) };
}

/**
 * Copy the attested runtime source layout and its shipped dependency closure into `out` (a fresh directory). Every source
 * byte is checked against the committed inventory. Returns the copied files with their digests.
 */
export function copyRuntimeSourceLayout({ root, packaged, dependencyPackages, out }) {
  const copied = [];
  const copy = (relativePath, expectedSha256 = null) => {
    const from = join(root, ...relativePath.split('/')), to = join(out, ...relativePath.split('/'));
    const info = lstatSync(from);
    if (!info.isFile() || info.isSymbolicLink()) refuse(`A packaged path is not a plain file: ${relativePath}`);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    const digest = sha256(readFileSync(to));
    if (expectedSha256 && digest !== expectedSha256) refuse(`Packaged bytes differ from the source inventory: ${relativePath}`);
    if (digest !== sha256(readFileSync(from))) refuse(`Packaged bytes changed while copying: ${relativePath}`);
    copied.push({ path: relativePath, sha256: digest, bytes: statSync(to).size });
  };
  for (const file of packaged) copy(file.path, file.sha256);
  for (const name of dependencyPackages)
    for (const path of shippedPackageFiles(root, name)) copy(relative(root, path).split(sep).join('/'));
  return copied;
}

/** The release's source inventory artifact, written once into the package root. */
export function writeSourceInventory(out, closure) {
  const { sourceCommit, sourceDigest, files } = closure.source;
  const inventory = { schemaVersion: 1, kind: 'DeszoBuildSourceInventory', sourceCommit, sourceDigest, files };
  if (canonicalHash(files) !== sourceDigest) refuse('The captured source inventory digest is inconsistent.');
  const inventoryBytes = Buffer.from(canonicalize(inventory), 'utf8');
  writeFileSync(join(out, SOURCE_INVENTORY_PATH), inventoryBytes, { flag: 'wx' });
  return { path: SOURCE_INVENTORY_PATH, sha256: sha256(inventoryBytes), bytes: inventoryBytes.length };
}

/** The source and dependency closure must be unchanged after packaging finished. */
export async function assertReleaseSourceUnchanged({ root, gitTool, closure }) {
  const after = await securityClosure(root, gitTool);
  if (after.digest !== closure.digest || after.dependencyDigest !== closure.dependencyDigest
    || after.source.sourceDigest !== closure.source.sourceDigest || after.source.sourceCommit !== closure.source.sourceCommit)
    refuse('The source or dependency closure changed while the release was packaged.');
}

export async function packageRuntimeRelease({ sourceRoot, gitTool, outDir, buildId }) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(buildId || '')) refuse('A simple build identity is required.');
  const out = resolve(outDir);
  if (existsSync(out)) refuse('The release destination already exists and is never replaced.');
  const { root, closure, packaged, dependencyPackages } = await capturedReleaseSource({ sourceRoot, gitTool });
  const { sourceCommit, sourceDigest } = closure.source;
  mkdirSync(out);
  const copied = copyRuntimeSourceLayout({ root, packaged, dependencyPackages, out });
  const inventoryArtifact = writeSourceInventory(out, closure);
  const artifacts = [...copied, inventoryArtifact].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const inputsDigest = buildInputsDigest(closure);
  const manifest = { schemaVersion: 1, buildId, runtimeApiVersion: RUNTIME_API_VERSION, bootstrap: 'runtime', sourceCommit,
    dirtySourceDigest: sourceDigest, inputsDigest, artifacts, sourceInventory: { path: SOURCE_INVENTORY_PATH, sha256: inventoryArtifact.sha256 } };
  writeFileSync(join(out, 'build.json'), JSON.stringify(manifest), { flag: 'wx' });
  await assertReleaseSourceUnchanged({ root, gitTool, closure });
  return { buildId, sourceCommit, sourceDigest, inputsDigest, dependencyDigest: closure.dependencyDigest, dependencyPackages,
    packagedFiles: packaged.length, packagedDependencyFiles: copied.length - packaged.length, manifest };
}
