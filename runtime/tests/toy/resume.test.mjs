import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createService } from '../src/api.mjs';

const fixtures = JSON.parse(readFileSync(new URL('../fixtures/tokens.json', import.meta.url), 'utf8'));
const service = () => { let n = 0; return createService({ ...fixtures, now: () => 0, createToken: () => `tok-${++n}` }); };
const call = (handle, method, path, user = 'alice') => handle({ method, path, headers: user ? { authorization: `Bearer ${user}-token` } : {} });

test('inspect and resume a paused round with a stable token', async () => {
  const handle = service();
  assert.deepEqual(call(handle, 'GET', '/rounds/r-paused'), { status: 200, body: { roundId: 'r-paused', status: 'paused' } });
  const first = call(handle, 'POST', '/rounds/r-paused/resume');
  assert.deepEqual(first, { status: 200, body: { roundId: 'r-paused', status: 'active', resumeToken: 'tok-1' } });
  const [again, concurrent] = await Promise.all([call(handle, 'POST', '/rounds/r-paused/resume'), call(handle, 'POST', '/rounds/r-paused/resume')]);
  assert.deepEqual(again, first);
  assert.deepEqual(concurrent, first);
});

test('documented errors keep their precedence', () => {
  const handle = service();
  assert.deepEqual(call(handle, 'GET', '/rounds/nope'), { status: 404, body: { error: 'round_not_found' } });
  assert.deepEqual(call(handle, 'POST', '/rounds/r-completed/resume'), { status: 409, body: { error: 'round_not_resumable' } });
  assert.deepEqual(call(handle, 'POST', '/rounds/r-expired/resume'), { status: 409, body: { error: 'round_not_resumable' } });
  assert.equal(call(handle, 'GET', '/rounds/r-completed').status, 200);
  assert.deepEqual(call(handle, 'GET', '/rounds/r-paused', 'bob'), { status: 403, body: { error: 'forbidden' } });
  assert.deepEqual(call(handle, 'GET', '/rounds/nope', null), { status: 401, body: { error: 'unauthorized' } });
});
