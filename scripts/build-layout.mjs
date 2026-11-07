// Where the desktop build chain (build-begin, runtime:bundle, tauri build, build-finish) writes its outputs.
// Production writes the repository's shared outputs. A Node test build must name a test-owned root with DESZO_BUILD_ROOT,
// inside .deszo/tests, so no test can replace the production set. Test-hook bundles (DESZO_TEST_FAULT_HOOKS=1) need both a
// test process and such a root, and are refused anywhere else.
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const PROJECT = resolve(import.meta.dirname, '..');
export const TESTS_ROOT = join(PROJECT, '.deszo', 'tests');

const folded = value => (process.platform === 'win32' ? value.toLowerCase() : value);
const isInside = (child, parent) => folded(child) === folded(parent) || folded(child).startsWith(folded(parent) + sep);

function layoutAt(root, { test }) {
  const cargoTarget = test ? join(root, 'cargo-target') : join(PROJECT, 'src-tauri', 'target');
  const release = join(cargoTarget, 'release');
  const runtime = test ? join(root, 'dist-runtime') : join(PROJECT, 'dist-runtime');
  return {
    root, test, cargoTarget, release,
    exe: join(release, 'deszo.exe'),
    shim: join(release, 'deszo-launch-shim.exe'),
    receipt: join(release, 'deszo-build.json'),
    inputs: join(cargoTarget, 'deszo-build-inputs.json'),
    runtime,
    runtimeShim: join(runtime, 'deszo-launch-shim.exe'),
    // The frontend the Shell embeds: production keeps Tauri's configured ../dist, a test build writes its own copy.
    frontend: test ? join(root, 'frontend-dist') : join(PROJECT, 'dist'),
    // Environment for the cargo invocations of this build; production adds nothing.
    env: test ? { CARGO_TARGET_DIR: cargoTarget } : {},
  };
}

// A junction or symbolic link anywhere on the way from .deszo/tests to the root, or at one of the directories the build writes,
// would redirect the outputs into the production tree, so each is refused. The real location must stay inside the real tests root.
function assertTestOwnedLocation(absolute) {
  let current = TESTS_ROOT;
  for (const part of relative(TESTS_ROOT, absolute).split(sep)) {
    current = join(current, part);
    if (isSymbolicLink(current))
      throw new Error(`${current} is a link or junction; a test build root must be a plain directory inside ${TESTS_ROOT}.`);
  }
  if (isSymbolicLink(join(PROJECT, '.deszo')))
    throw new Error(`${join(PROJECT, '.deszo')} is a link or junction; refusing to build through it.`);
  if (isSymbolicLink(TESTS_ROOT))
    throw new Error(`${TESTS_ROOT} is a link or junction; refusing to build through it.`);
  let probe = absolute;
  while (!existsSync(probe)) probe = dirname(probe);
  const real = realpathSync.native(probe);
  const realTests = existsSync(TESTS_ROOT) ? realpathSync.native(TESTS_ROOT) : TESTS_ROOT;
  if (!isInside(join(real, relative(probe, absolute)), realTests))
    throw new Error(`${absolute} resolves outside ${realTests}; refusing to build through it.`);
}

// lstat, not existsSync: a dangling link is still a link.
function isSymbolicLink(path) {
  try { return lstatSync(path).isSymbolicLink(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// Every directory the build chain writes into (and the outputs it removes or replaces) must be a plain directory, or absent. Each
// build stage calls this before it writes, so a junction created earlier in the chain is refused where it would take effect.
export function assertPlainDirectories(layout) {
  // lstat, not existsSync: a dangling link is still a link, and existsSync would skip it.
  const entry = path => { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  for (const directory of [PROJECT, join(PROJECT, 'src-tauri'), layout.cargoTarget, layout.release, layout.runtime, layout.frontend].filter(Boolean)) {
    const info = entry(directory);
    if (!info) continue;
    if (info.isSymbolicLink()) throw new Error(`${directory} is a link or junction; the desktop build writes only plain directories.`);
    if (!info.isDirectory()) throw new Error(`${directory} is not a directory.`);
  }
  for (const file of [layout.exe, layout.shim, layout.receipt, layout.inputs, layout.runtimeShim]) {
    const info = entry(file);
    if (info?.isSymbolicLink()) throw new Error(`${file} is a link or junction; the desktop build replaces only plain files.`);
  }
}

// The layout for a named test-owned root. Refuses any directory that is not strictly inside .deszo/tests.
export function testLayout(root) {
  const absolute = resolve(root);
  const within = relative(TESTS_ROOT, absolute);
  if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within))
    throw new Error(`DESZO_BUILD_ROOT must be a directory inside ${TESTS_ROOT}; refusing ${absolute}`);
  assertTestOwnedLocation(absolute);
  const layout = layoutAt(absolute, { test: true });
  assertPlainDirectories(layout);
  return layout;
}

// The layout for the current process. Tests can never reach the production layout.
export function buildLayout(env = process.env) {
  const hooks = env.DESZO_TEST_FAULT_HOOKS;
  if (hooks && hooks !== '1') throw new Error('DESZO_TEST_FAULT_HOOKS accepts only the test builder value "1".');
  if (hooks === '1' && !env.NODE_TEST_CONTEXT) throw new Error('DESZO_TEST_FAULT_HOOKS is reserved for test-owned bundles built by Node tests.');
  if (!env.DESZO_BUILD_ROOT) {
    if (env.NODE_TEST_CONTEXT) throw new Error('A Node test build must set DESZO_BUILD_ROOT to a test-owned directory inside .deszo/tests; tests never write the shared outputs.');
    // Production writes the operator package under .deszo as well, so the same link refusal applies to it.
    if (isSymbolicLink(join(PROJECT, '.deszo'))) throw new Error(`${join(PROJECT, '.deszo')} is a link or junction; refusing to write the desktop build through it.`);
    return layoutAt(PROJECT, { test: false });
  }
  return testLayout(env.DESZO_BUILD_ROOT);
}
