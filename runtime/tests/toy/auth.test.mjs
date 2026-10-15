import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createService } from '../src/api.mjs';

const fixtures = JSON.parse(readFileSync(new URL('../fixtures/tokens.json', import.meta.url), 'utf8'));
const service = at => createService({ ...fixtures, now: () => at, createToken: () => 'tok-1' });
const get = (handle, authorization) => handle({ method: 'GET', path: '/rounds/r-paused', headers: authorization ? { authorization } : {} });

test('missing, malformed and unknown tokens return 401', () => {
  const handle = service(0);
  for (const header of [undefined, 'Basic abc', 'Bearer nobody']) assert.deepEqual(get(handle, header), { status: 401, body: { error: 'unauthorized' } });
});

test('a token is valid before expiresAt and expired at and after it', () => {
  assert.equal(get(service(999), 'Bearer alice-token').status, 200);
  assert.deepEqual(get(service(1000), 'Bearer alice-token'), { status: 401, body: { error: 'unauthorized' } });
  assert.equal(get(service(1001), 'Bearer alice-token').status, 401);
});
