// Compiles the native launch shim on its own (ADR-0002 section 4) for development (`npm run shim:dev`) or a standalone compile check
// (`npm run shim:build`). It never publishes a shim to the runtime. The shipped shim is the one `tauri build` compiles together with
// deszo.exe, and build-finish copies exactly that copy into the runtime. A separate compilation has different feature flags and
// therefore different bytes, so a second copy here would be a second, unreceipted identity.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { assertPlainDirectories, buildLayout, PROJECT } from './build-layout.mjs';

const release = process.argv.includes('--release');
const manifest = resolve(PROJECT, 'src-tauri/Cargo.toml');
const layout = buildLayout();
const built = release ? layout.shim : resolve(PROJECT, 'src-tauri/target/debug', 'deszo-launch-shim.exe');

if (release) assertPlainDirectories(layout);
const result = spawnSync('cargo', ['build', '--manifest-path', manifest, '--bin', 'deszo-launch-shim', ...(release ? ['--release'] : [])],
  { stdio: 'inherit', env: { ...process.env, ...(release ? layout.env : {}) } });
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Launch shim compiled at ${built}; it is not published to the runtime (npm run desktop:build publishes the shipped shim).`);
