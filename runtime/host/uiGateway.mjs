// The product can request or reduce authority, but cannot mint it. Confirmation belongs to the installed broker.
import { connectHost } from './ipc.mjs';
import { INSTALLED_HOST_PIPE } from './nativeClient.mjs';
export async function autonomyGateway(operation, body = null, boundClient = null) {
  const client = boundClient || connectHost(INSTALLED_HOST_PIPE, { timeoutMs: 5000 });
  try {
    if (operation === 'status') {
      const [state, options, controller, worker] = await Promise.all([client.call('host.overview'), client.call('host.scope-options'), client.call('worker.identity'), client.call('worker.status')]);
      return { available: true, ...state, options, controller, worker };
    }
    const methods = { propose: 'policy.propose', revoke: 'policy.revoke_user', open: 'consent.open' };
    if (!methods[operation]) throw new Error('Unknown autonomy UI request.');
    return await client.call(methods[operation], body || {});
  } finally { if (!boundClient) client.close(); }
}
