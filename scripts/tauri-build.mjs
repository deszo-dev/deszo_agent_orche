import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { assertPlainDirectories, buildLayout, PROJECT } from './build-layout.mjs';

const repo = PROJECT;
const tauriCli = join(repo, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const layout = buildLayout();
assertPlainDirectories(layout);
const args = ['build', '--no-bundle'];
const configOverlay = process.env.DESZO_TAURI_CONFIG_OVERLAY;
if (layout.test) {
  // A test build compiles its own Shell: the embedded frontend and the runtime resources come from the test-owned root.
  const config = configOverlay ? JSON.parse(readFileSync(resolve(configOverlay), 'utf8'))
    : JSON.parse(readFileSync(join(repo, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  // The frontend path reaches the shell command line unquoted, so only plain path characters are accepted.
  if (!/^[A-Za-z0-9._:\\\/-]+$/.test(layout.frontend)) throw new Error(`The test build root may contain only letters, digits, '.', '_', ':', '\\', '/' and '-': ${layout.root}`);
  // Tauri resolves configured paths against the Tauri project (src-tauri), as it does for the production '../dist' and '../dist-runtime'.
  // An absolute frontend path embedded no assets: the test Shell opened a blank window, its runtime never started, and Engines were
  // never ready. A project-relative path to the same directory is the production form.
  const fromProject = path => relative(join(repo, 'src-tauri'), path).split(sep).join('/');
  config.build = { ...config.build, frontendDist: fromProject(layout.frontend),
    beforeBuildCommand: `npm run build -- --outDir ${layout.frontend} --emptyOutDir` };
  config.bundle = { ...config.bundle, resources: { [`${fromProject(layout.runtime)}/`]: 'runtime/' } };
  mkdirSync(layout.root, { recursive: true });
  const generated = join(layout.root, 'tauri-build-config.json');
  writeFileSync(generated, JSON.stringify(config, null, 2));
  args.push('--config', generated);
} else if (configOverlay) throw new Error('DESZO_TAURI_CONFIG_OVERLAY is a test-only configuration; production builds use src-tauri/tauri.conf.json.');

const result = spawnSync(process.execPath, [tauriCli, ...args], {
  cwd: repo,
  env: { ...process.env, ...layout.env },
  stdio: 'inherit',
});

if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
