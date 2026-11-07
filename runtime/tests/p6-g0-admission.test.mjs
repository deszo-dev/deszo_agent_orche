// P6-G0 admission fence (ADR-0010 section 5). While an Engine switch quiesces, this Engine refuses every owner mutation with the
// stable code `switch_in_progress`; reads stay open, and a refused switch reopens admission. The Lifecycle Host is a test double
// here, so this proves the Engine's side only. The native recovery and packaged switch tests prove the real Host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startTestRunner } from './helpers.mjs';

async function until(predicate, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}.`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test('P6-G0 admission: a quiescing Engine refuses owner mutations, and a refused switch reopens admission', { timeout: 120_000 }, async () => {
  let release;
  const stageReleased = new Promise(resolve => { release = resolve; });
  const commands = [];
  const lifecycleHostBridge = {
    context: { buildId: 'engine-a', shellBuildId: 'shell-g0', generation: 'g0-admission', applicationPid: process.pid },
    ready: async () => ({}),
    acknowledgeReceipt: async () => ({}),
    activateCandidate: async () => ({}),
    p6Call: async command => {
      commands.push(command);
      if (command === 'engine.stage') {
        await stageReleased;
        return { phase: 'staged' };
      }
      return { accepted: false, phase: 'rolled_back' };
    },
  };
  const api = await startTestRunner({ runner: { lifecycleHostBridge } });
  const { port, token } = api.runner.connection;
  const send = (method, path, body) => fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    const switching = send('POST', '/api/v4/lifecycle/engine-switch', { operationId: randomUUID(), targetEngineBuildId: 'engine-b', packageSha256: 'a'.repeat(64) });
    await until(() => commands.includes('engine.stage'), 'the switch to start staging');

    // Quiescing: every owner mutation is refused before its body is read, including the run and chat admissions.
    const run = await send('POST', '/api/v2/runs', {});
    assert.equal(run.status, 503);
    assert.equal((await run.json()).code, 'switch_in_progress');
    const chat = await send('POST', `/api/v2/context-bindings/${randomUUID()}/messages`, { text: 'hello' });
    assert.equal(chat.status, 503, 'a chat message admits no Run while the Engine is being replaced');
    assert.equal((await chat.json()).code, 'switch_in_progress');
    const reads = await send('GET', '/api/v2/settings');
    assert.equal(reads.status, 200, 'reads stay open while the Engine is being replaced');
    await reads.text();

    // The Host refuses the switch; the Engine is not replaced and admits owner mutations again.
    release();
    const refused = await switching;
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).code, 'switch_refused');
    assert.deepEqual(commands, ['engine.stage', 'engine.switch']);
    const reopened = await send('POST', '/api/v2/runs', {});
    assert.notEqual(reopened.status, 503, 'a refused switch reopens admission');
    assert.notEqual((await reopened.json()).code, 'switch_in_progress');
  } finally {
    release();
    await api.close();
  }
});
