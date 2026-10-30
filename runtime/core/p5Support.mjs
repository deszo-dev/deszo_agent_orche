// P5-CLOSURE §5: which installed package layouts can run the trusted P5 Gate. A runtime-bootstrap release runs its attested
// source layout directly. A bundled desktop (tauri) release runs the one-file `runtime/runner.mjs` and carries the same
// attested source layout and dependency closure as its support payload `p5/`, described by `p5/p5-support.json`. The payload
// is inside the Host-attested package digest; this check binds it to the running release and to the running bundle itself.
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { canonicalHash, compareText, sha256 } from './canonical.mjs';
import { ENGINE_PACKAGED, ENGINE_RELEASE_ROOT, ENGINE_ROOT, RUNNING_ENGINE_FILE } from './engineRoot.mjs';

export const P5_SUPPORT_MANIFEST = 'p5-support.json';
const SOURCE_INVENTORY_FILE = '.deszo-source-inventory.json';
const MAX_SOURCE_INVENTORY_BYTES = 32 * 1024 * 1024;

/**
 * The installed release's committed source inventory (inside the Host-verified package). It is authenticated by the caller
 * against the Host-attested source digest; an unreadable file returns null so the Host-batched path is used instead.
 */
export function readInstalledSourceInventory() {
  const path = join(ENGINE_RELEASE_ROOT, SOURCE_INVENTORY_FILE);
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SOURCE_INVENTORY_BYTES) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch { return null; }
}
export const P5_SUPPORT_KIND = 'DeszoP5SupportPayload';
const VERIFIER = ['runtime', 'verification', 'p5Verifier.mjs'];
const MAX_SUPPORT_MANIFEST_BYTES = 16 * 1024 * 1024;

function refuse(code, message) { throw Object.assign(new Error(message), { code }); }
const pathKey = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);

function payloadFiles(root) {
  const files = [];
  const walk = directory => {
    for (const name of readdirSync(directory).sort(compareText)) {
      const path = join(directory, name), info = lstatSync(path);
      if (info.isSymbolicLink()) refuse('p5_support_payload_unsafe', `The P5 support payload contains a reparse point: ${relative(root, path)}`);
      if (info.isDirectory()) walk(path);
      else if (info.isFile()) files.push(relative(root, path).split(sep).join('/'));
      else refuse('p5_support_payload_unsafe', `The P5 support payload contains an unsupported object: ${relative(root, path)}`);
    }
  };
  walk(root);
  return files;
}

/**
 * Verify the running package can host the trusted Gate. Returns the layout identity, or throws a coded refusal. A legacy
 * desktop package without a payload refuses here, so P5 stays disabled while ordinary operation continues.
 */
export function verifyP5PackageLayout(release) {
  if (!ENGINE_PACKAGED) {
    if (release?.bootstrap !== 'runtime' || !existsSync(resolve(ENGINE_ROOT, ...VERIFIER)))
      refuse('p5_package_layout_unsupported', 'This source-layout Engine is not a runtime-bootstrap release with the installed P5 verifier.');
    return { layout: 'runtime-source', root: ENGINE_ROOT };
  }
  if (release?.bootstrap !== 'tauri') refuse('p5_package_layout_unsupported', 'A bundled Engine runs only inside a desktop (tauri) release.');
  const manifestPath = join(ENGINE_ROOT, P5_SUPPORT_MANIFEST);
  let info, bytes, manifest;
  try {
    info = lstatSync(manifestPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SUPPORT_MANIFEST_BYTES || pathKey(realpathSync.native(manifestPath)) !== pathKey(manifestPath))
      refuse('p5_support_payload_missing', 'The desktop release P5 support manifest is not a bounded plain file.');
    bytes = readFileSync(manifestPath);
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error.code?.startsWith?.('p5_')) throw error;
    refuse('p5_support_payload_missing', 'This desktop release has no P5 support payload; Protected Self-Repair stays disabled.');
  }
  if (manifest?.schemaVersion !== 1 || manifest.kind !== P5_SUPPORT_KIND || manifest.buildId !== release.buildId
    || manifest.sourceCommit !== release.sourceCommit || manifest.sourceDigest !== release.sourceDigest
    || manifest.inputsDigest !== release.inputsDigest || !Array.isArray(manifest.files) || !manifest.runtimeBundle)
    refuse('p5_support_payload_mismatch', 'The P5 support payload does not describe the Host-attested running release.');
  // The running Engine is the bundle the packager reproduced from exactly this payload's sources.
  const bundlePath = resolve(ENGINE_RELEASE_ROOT, ...String(manifest.runtimeBundle.path).split('/'));
  if (manifest.runtimeBundle.path !== 'runtime/runner.mjs' || manifest.runtimeBundle.reproducible !== true
    || pathKey(bundlePath) !== pathKey(RUNNING_ENGINE_FILE) || sha256(readFileSync(RUNNING_ENGINE_FILE)) !== manifest.runtimeBundle.sha256)
    refuse('p5_support_bundle_mismatch', 'The running desktop Engine bundle is not the bundle reproduced from the attested P5 payload.');
  const listed = [...manifest.files].sort((left, right) => compareText(left.path, right.path));
  const actual = payloadFiles(ENGINE_ROOT).filter(path => path !== P5_SUPPORT_MANIFEST).sort(compareText);
  if (canonicalHash(actual) !== canonicalHash(listed.map(file => file.path)))
    refuse('p5_support_payload_mismatch', 'The P5 support payload files differ from its manifest.');
  for (const file of listed)
    if (sha256(readFileSync(join(ENGINE_ROOT, ...file.path.split('/')))) !== file.sha256)
      refuse('p5_support_payload_mismatch', `P5 support payload bytes differ from the manifest: ${file.path}.`);
  if (!listed.some(file => file.path === VERIFIER.join('/')))
    refuse('p5_support_payload_mismatch', 'The P5 support payload has no trusted verifier.');
  return { layout: 'desktop-support', root: ENGINE_ROOT, supportSha256: sha256(bytes), bundleSha256: manifest.runtimeBundle.sha256 };
}
