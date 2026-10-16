// One approved check keeps npm setup and all checks in the same disposable candidate directory.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const uiOnly = process.argv.includes('--ui-only');
const evidenceOption = process.argv.indexOf('--evidence-dir');
assert.ok(evidenceOption < 0 || process.argv[evidenceOption + 1], '--evidence-dir needs a relative directory.');
const evidencePath = evidenceOption < 0 ? '.deszo/ui' : process.argv[evidenceOption + 1];
const evidenceRoot = resolve(root, evidencePath);
const evidenceRelative = relative(root, evidenceRoot);
assert.ok(evidenceRelative && !evidenceRelative.startsWith('..') && !isAbsolute(evidenceRelative), 'Evidence directory must be inside the candidate.');
const lockBefore = readFileSync(resolve(root, 'package-lock.json'));
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
assert.ok(typeof manifest.scripts?.['test:ui'] === 'string' && manifest.scripts['test:ui'].trim(),
  'The approved candidate must include a real test:ui script.');
const commands = uiOnly
  ? [['ci', '--no-audit', '--no-fund'], ['run', 'build'], ['run', 'test:ui']]
  : [['ci', '--no-audit', '--no-fund'], ['run', 'build'], ['test'], ['run', 'docs:check'], ['run', 'test:ui'], ['run', 'runtime:bundle']];
const env = { ...process.env, DESZO_UI_EVIDENCE_DIR: evidencePath };
for (const args of commands) {
  console.log(`\n[pilot-check] npm ${args.join(' ')}`);
  // All arguments are static program literals. cmd is required to launch npm.cmd on Windows.
  const result = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`], { cwd: root, stdio: 'inherit', windowsHide: true, env })
    : spawnSync('npm', args, { cwd: root, stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
assert.ok(lockBefore.equals(readFileSync(resolve(root, 'package-lock.json'))), 'Checks must not change the approved lockfile.');
assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Frontend build output is missing.');
const report = JSON.parse(readFileSync(resolve(evidenceRoot, 'report.json'), 'utf8'));
assert.equal(report.schemaVersion, 1);
assert.ok(Array.isArray(report.scenarios) && report.scenarios.length > 0, 'UI scenarios are missing.');
assert.ok(report.scenarios.every(item => typeof item.id === 'string' && item.id && item.status === 'passed'), 'Every recorded UI scenario must pass.');
for (const name of ['main.png', 'dialogs.png', 'small-window.png']) {
  assert.ok(Array.isArray(report.screenshots) && report.screenshots.includes(name), `Report must reference ${name}.`);
  const screenshot = readFileSync(resolve(evidenceRoot, name));
  assert.ok(screenshot.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `Expected real PNG data: ${name}.`);
}
console.log(`[pilot-check] UI evidence: ${JSON.stringify(report)}`);
console.log('[pilot-check] All approved automated commands passed. Desktop smoke is a separate operator check.');
