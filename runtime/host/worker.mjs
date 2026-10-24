// Installed deterministic controller. No model/CLI, dynamic imports, general shell/file tools or application token
// exists in its supported request profile. Workflow development/review stays in the saved engine workflow.
import { connectHost } from './ipc.mjs';
import { INSTALLED_HOST_PIPE } from './nativeClient.mjs';
import { inspectObservation } from './observation.mjs';

const pause = ms => new Promise(r => setTimeout(r, ms));
const parentPid = process.ppid;
const parentAlive = () => { try { process.kill(parentPid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const client = connectHost(INSTALLED_HOST_PIPE, { timeoutMs: 3_650_000 });
client.events.once('close', () => process.exit(0));
try {
  await client.ready;
  for (;;) {
    if (!parentAlive()) break;
    const turn = await client.call('worker.poll', { mode: 'deterministic', provider: 'none', model: 'none', effort: 'none', billing: 'no-worker-model-calls' });
    if (turn.claim) {
      // No instructions from a workflow are evaluated here. The service dispatches only the typed, consent-scoped
      // step it has durably leased to this independently observed process. Unknown effects are not retried.
      let result = await client.call('worker.execute', { itemId: turn.claim.itemId, lease: turn.claim.lease });
      while (result.state === 'waiting') {
        const snapshot = await client.call('worker.watch', { itemId: turn.claim.itemId, lease: turn.claim.lease });
        if (snapshot.finished) { result=snapshot.finished; break; }
        const observation = inspectObservation(snapshot.page, snapshot);
        result = await client.call('worker.observed', { itemId: turn.claim.itemId, lease: turn.claim.lease, observation });
      }
      if (result.state === 'reconciling') await pause(1500);
    } else await pause(1000);
  }
} catch (error) { process.stderr.write(`Restricted controller stopped: ${error.code || 'error'}: ${error.message}\n`); process.exitCode = 1; }
finally { client.close(); }
