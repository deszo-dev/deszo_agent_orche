import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SUPERVISOR_ENV, supervisorFromEnvironment } from '../core/supervisor-client.mjs';
import { ownedDir } from './test-roots.mjs';

const testsRoot = resolve(import.meta.dirname, '../../.deszo/tests');

test('no supervisor variables means a headless runtime', () => {
  assert.equal(supervisorFromEnvironment({}), null);
});

test('a missing launch shim refuses to start supervision, and the token is still removed from the environment', () => {
  mkdirSync(testsRoot, { recursive: true });
  const env = { DESZO_SUPERVISOR_PIPE: '\\\\.\\pipe\\deszo-test', DESZO_SUPERVISOR_TOKEN: 'secret', DESZO_LAUNCH_SHIM: join(testsRoot, 'absent', 'deszo-launch-shim.exe') };
  assert.throws(() => supervisorFromEnvironment(env), /launch shim is missing/);
  for (const key of SUPERVISOR_ENV) assert.equal(key in env, false, `${key} is removed after it is read`);
});

test('a present launch shim yields a client that keeps its token in memory', () => {
  mkdirSync(testsRoot, { recursive: true });
  const directory = ownedDir(join(testsRoot, 'shim-'));
  const shim = join(directory, 'deszo-launch-shim.exe');
  writeFileSync(shim, '');
  const env = { DESZO_SUPERVISOR_PIPE: '\\\\.\\pipe\\deszo-test', DESZO_SUPERVISOR_TOKEN: 'secret', DESZO_LAUNCH_SHIM: shim };
  const client = supervisorFromEnvironment(env);
  assert.equal(client.shimPath, shim);
  assert.equal(client.token, 'secret');
  assert.equal(env.DESZO_SUPERVISOR_TOKEN, undefined);
});

test('only the launch shim\'s own failure codes are spawn failures; every other exit code is the CLI\'s result', async () => {
  const { shimFailureOf } = await import('../core/supervisor-client.mjs');
  assert.equal(shimFailureOf(0x7DE50120), 'rendezvous_failed');
  assert.equal(shimFailureOf(0x7DE50121), 'assignment_failed');
  assert.equal(shimFailureOf(0x7DE50122), 'spawn_failed');
  assert.equal(shimFailureOf(0), null);
  assert.equal(shimFailureOf(120), null, 'a CLI that exits 120 is not mistaken for a shim failure');
  assert.equal(shimFailureOf(1), null);
});
