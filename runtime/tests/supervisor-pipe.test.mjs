import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { supervisorRequest } from '../../mcp/supervisor-pipe.mjs';

const endpoint = () => process.platform === 'win32' ? String.raw`\\.\pipe\deszo-test-${randomUUID()}` : join(tmpdir(), `deszo-test-${randomUUID()}.sock`);

test('an emergency request reaches the supervisor on its own line and returns its reply', async () => {
  const pipeName = endpoint();
  const seen = [];
  const server = createServer(socket => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      const request = JSON.parse(buffer.slice(0, end));
      seen.push(request);
      const reply = request.token === 'good' ? { id: request.id, result: { stopped: true, remainingMembers: 0 } } : { id: request.id, error: { code: 'unauthorized', message: 'The emergency credential does not match this run.' } };
      socket.end(`${JSON.stringify(reply)}\n`);
    });
  });
  await new Promise(done => server.listen(pipeName, done));
  try {
    const stopped = await supervisorRequest({ pipeName, operation: 'emergency_stop', payload: { runId: 'run-1', token: 'good' } });
    assert.deepEqual(stopped, { stopped: true, remainingMembers: 0 });
    await assert.rejects(supervisorRequest({ pipeName, operation: 'emergency_stop', payload: { runId: 'run-1', token: 'bad' } }), { code: 'unauthorized' });
    assert.equal(seen[0].op, 'emergency_stop');
    assert.equal(seen[0].runId, 'run-1');
  } finally { await new Promise(done => server.close(done)); }
});

test('an absent supervisor is reported as unavailable, never as a completed Stop', async () => {
  await assert.rejects(supervisorRequest({ pipeName: endpoint(), operation: 'emergency_status', payload: { runId: 'run-1', token: 't' }, timeoutMs: 2000 }), { code: 'supervisor_unavailable' });
});
