import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_MARKER = '.deszo-test-fault-hooks';
const TEST_MARKER_CONTENT = 'DESZO_TEST_FAULT_HOOKS_V1\n';
const PACKAGED = typeof __DESZO_PACKAGED__ !== 'undefined' && __DESZO_PACKAGED__;
const BUNDLED_TEST_FAULTS = typeof __DESZO_TEST_FAULT_HOOKS__ !== 'undefined' && __DESZO_TEST_FAULT_HOOKS__;

function packagePolicy(moduleUrl) {
  let directory;
  try { directory = dirname(fileURLToPath(moduleUrl)); }
  catch { return { found: false, enabled: false }; }
  for (;;) {
    if (existsSync(join(directory, 'build.json')) || existsSync(join(directory, 'p5-support.json'))) {
      try { return { found: true, enabled: readFileSync(join(directory, TEST_MARKER), 'utf8') === TEST_MARKER_CONTENT }; }
      catch { return { found: true, enabled: false }; }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return { found: false, enabled: false };
}

// Raw production releases carry package manifests; the marker is part of their verified artifact set only in
// test-owned packages. A manifest takes precedence over globals and environment state. Source/debug runs and
// explicitly test-built bundles keep their fault seams for deterministic recovery tests.
export function testFaultHooksEnabled(moduleUrl = import.meta.url) {
  const policy = packagePolicy(moduleUrl);
  if (policy.found) return policy.enabled;
  if (PACKAGED) return BUNDLED_TEST_FAULTS;
  return true;
}
