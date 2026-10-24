// Builds the native launch shim (ADR-0002 section 4). Every supervised process starts through it, so the desktop app
// refuses to start without it. A release build also copies it into dist-runtime, which Tauri bundles beside the runtime.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeRuntimeManifest } from './deszo-artifacts.mjs';

const root = resolve(import.meta.dirname, '..');
const release = process.argv.includes('--release');
const manifest = resolve(root, 'src-tauri/Cargo.toml');
const built = resolve(root, 'src-tauri/target', release ? 'release' : 'debug', 'deszo-launch-shim.exe');

const result = spawnSync('cargo', ['build', '--manifest-path', manifest, '--bin', 'deszo-launch-shim', ...(release ? ['--release'] : [])], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);

if (release) {
  mkdirSync(resolve(root, 'dist-runtime'), { recursive: true });
  copyFileSync(built, resolve(root, 'dist-runtime/deszo-launch-shim.exe'));
  writeRuntimeManifest(resolve(root, 'dist-runtime'));
}
console.log(`Launch shim built at ${built}${release ? ' and copied to dist-runtime' : ''}`);
