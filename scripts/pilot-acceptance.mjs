// Independent business checks over the exported delivery; does not modify its files.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';

const candidate = resolve(process.argv[2]);
const reportPath = process.argv[3] && resolve(process.argv[3]);
const { createService } = await import(pathToFileURL(join(candidate, 'src/api.mjs')));
const results = [];
const check = async (name, body) => {
  try { await body(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, message: error.message }); }
};
const prepare = (clock = 999) => {
  let tokenAllocations = 0;
  const handle = createService({
    tokens: [{ token: 'alice-token', userId: 'alice', expiresAt: 1000 }, { token: 'bob-token', userId: 'bob', expiresAt: 1000 }],
    rounds: [{ roundId: 'paused', owner: 'alice', status: 'paused', resumeToken: null }, { roundId: 'completed', owner: 'alice', status: 'completed', resumeToken: null }, { roundId: 'expired', owner: 'alice', status: 'expired', resumeToken: null }],
    now: () => clock, createToken: () => `recovery-${++tokenAllocations}`,
  });
  return { handle, allocations: () => tokenAllocations };
};
const request = (handle, method, round = 'paused', authorization = 'Bearer alice-token') => handle({ method, path: `/rounds/${round}${method === 'POST' ? '/resume' : ''}`, headers: authorization === null ? {} : { authorization } });
for (const authorization of [null, '', 'alice-token', 'Bearer unknown', 'Bearer alice-token extra']) {
  await check(`Reject invalid authentication: ${String(authorization)}`, () => assert.deepEqual(request(prepare().handle, 'GET', 'paused', authorization), { status: 401, body: { error: 'unauthorized' } }));
}
for (const clock of [999, 1000, 1001]) {
  await check(`Expiration boundary ${clock}`, () => assert.equal(request(prepare(clock).handle, 'GET').status, clock < 1000 ? 200 : 401));
}
await check('Inspect owned paused round', () => assert.deepEqual(request(prepare().handle, 'GET'), { status: 200, body: { roundId: 'paused', status: 'paused' } }));
for (const method of ['GET', 'POST']) await check(`Wrong owner ${method}`, () => assert.deepEqual(request(prepare().handle, method, 'paused', 'Bearer bob-token'), { status: 403, body: { error: 'forbidden' } }));
for (const method of ['GET', 'POST']) await check(`Unknown round ${method}`, () => assert.deepEqual(request(prepare().handle, method, 'missing'), { status: 404, body: { error: 'round_not_found' } }));
for (const round of ['completed', 'expired']) {
  await check(`Inspect owned ${round} round`, () => assert.deepEqual(request(prepare().handle, 'GET', round), { status: 200, body: { roundId: round, status: round } }));
  await check(`Cannot resume ${round} round`, () => assert.deepEqual(request(prepare().handle, 'POST', round), { status: 409, body: { error: 'round_not_resumable' } }));
}
await check('Authentication precedes round lookup', () => assert.deepEqual(request(prepare().handle, 'POST', 'missing', 'Bearer unknown'), { status: 401, body: { error: 'unauthorized' } }));
await check('Ownership precedes recovery state', () => assert.deepEqual(request(prepare().handle, 'POST', 'completed', 'Bearer bob-token'), { status: 403, body: { error: 'forbidden' } }));
await check('Sequential recovery keeps one token and one round', () => {
  const p = prepare();
  const first = request(p.handle, 'POST');
  assert.deepEqual(first, { status: 200, body: { roundId: 'paused', status: 'active', resumeToken: 'recovery-1' } });
  for (let i = 0; i < 10; i++) assert.deepEqual(request(p.handle, 'POST'), first);
  assert.equal(p.allocations(), 1);
  assert.deepEqual(request(p.handle, 'GET'), { status: 200, body: { roundId: 'paused', status: 'active' } });
});
await check('Concurrent recovery keeps one token', async () => {
  const p = prepare();
  const responses = await Promise.all(Array.from({ length: 20 }, () => Promise.resolve().then(() => request(p.handle, 'POST'))));
  for (const response of responses) assert.deepEqual(response, responses[0]);
  assert.equal(responses[0].status, 200);
  assert.equal(responses[0].body.resumeToken, 'recovery-1');
  assert.equal(p.allocations(), 1);
});
const report = { candidate, passed: results.every(result => result.passed), checks: results.length, results };
if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (!report.passed) process.exitCode = 1;
