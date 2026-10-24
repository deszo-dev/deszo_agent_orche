import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const tauriCli = join(repo, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const args = ['build', '--no-bundle'];
const configOverlay = process.env.DESZO_TAURI_CONFIG_OVERLAY;
if (configOverlay) args.push('--config', resolve(configOverlay));

const result = spawnSync(process.execPath, [tauriCli, ...args], {
  cwd: repo,
  env: process.env,
  stdio: 'inherit',
});

if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
