// The production artifact set that no Node test may change: the runtime resources, the Shell and its receipts, the launch shim,
// and the frontend the Shell embeds. A file is recorded by its SHA-256; a file that does not exist is recorded as 'absent'.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PROJECT } from '../../scripts/build-layout.mjs';

const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');

function filesUnder(directory) {
  if (!existsSync(directory)) return [];
  const found = [];
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) found.push(path);
    }
  };
  walk(directory);
  return found;
}

export function productionArtifactSnapshot(project = PROJECT) {
  const paths = [
    ...filesUnder(join(project, 'dist-runtime')),
    ...filesUnder(join(project, 'dist')),
    join(project, 'src-tauri', 'target', 'release', 'deszo.exe'),
    join(project, 'src-tauri', 'target', 'release', 'deszo-launch-shim.exe'),
    join(project, 'src-tauri', 'target', 'release', 'deszo-build.json'),
    join(project, 'src-tauri', 'target', 'deszo-build-inputs.json'),
  ];
  return Object.fromEntries(paths.sort().map(path => [relative(project, path).replaceAll('\\', '/'), existsSync(path) ? sha256(path) : 'absent']));
}

// The changed entries between two snapshots, for a readable failure.
export function snapshotChanges(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].sort().filter(key => before[key] !== after[key]).map(key => `${key}: ${before[key] ?? 'absent'} -> ${after[key] ?? 'absent'}`);
}
