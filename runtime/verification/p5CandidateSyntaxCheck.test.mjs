// Installed independent syntax check for candidate test/driver files that are replaced by a
// protected baseline overlay in the main verification suite. It never imports or executes the
// candidate file; Node's parser checks the exact Engine-bound source path.
import assert from 'node:assert/strict';
import test from 'node:test';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ENTRYPOINT_ENV = 'DESZO_P5_CANDIDATE_ENTRYPOINT';

test('candidate-entrypoint-syntax', () => {
  const entrypoint = process.env[ENTRYPOINT_ENV];
  assert.equal(typeof entrypoint, 'string', 'Engine did not bind a candidate entrypoint path.');
  assert.ok(isAbsolute(entrypoint), 'Candidate entrypoint must be absolute.');
  const info = lstatSync(entrypoint);
  assert.ok(info.isFile() && !info.isSymbolicLink(), 'Candidate entrypoint must be a regular file.');
  assert.equal(resolve(realpathSync.native(entrypoint)), resolve(entrypoint), 'Candidate entrypoint must be canonical.');
  const result = spawnSync(process.execPath, ['--check', entrypoint], {
    cwd: process.cwd(), shell: false, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024,
    env: Object.fromEntries(Object.entries({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR })
      .filter(([, value]) => typeof value === 'string')),
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, (result.stderr || result.stdout || 'Node rejected the candidate entrypoint syntax.').slice(0, 4096));
});
