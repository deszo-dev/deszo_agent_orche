import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { adoptRoot } from './test-roots.mjs';

test('release defaults, v2 retirement, approval identity, and saved opt-outs survive the full HTTP lifecycle', async () => {
  const result = await promisify(execFile)(process.execPath, ['--disable-warning=ExperimentalWarning',
    resolve(import.meta.dirname, '../../scripts/authoring-release-check.mjs'), '--confirmation', 'on', '--v2', 'retired'],
  { cwd: resolve(import.meta.dirname, '../..'), windowsHide: true, timeout: 30_000 });
  const report = JSON.parse(result.stdout.trim());
  // The script's runner root is disposable once its report is read.
  adoptRoot(report.root);
  assert.equal(report.passed, true);
  assert.equal(report.results.length, 4);
  assert.ok(report.results.every(check => check.passed));
});
