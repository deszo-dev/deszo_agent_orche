// A narrowly scoped, authenticated channel from the Engine process to its independent Rust lifecycle Host.
// The one-generation capability is read once and removed before any provider CLI can be launched.
import net from 'node:net';

const ENV = [
  'DESZO_LIFECYCLE_HOST_ADDRESS', 'DESZO_LIFECYCLE_HOST_CAPABILITY', 'DESZO_LIFECYCLE_INSTALLATION_ID',
  'DESZO_LIFECYCLE_PROFILE_ROOT', 'DESZO_LIFECYCLE_GENERATION', 'DESZO_APPLICATION_BUILD_ID',
  'DESZO_LIFECYCLE_APPLICATION_PID', 'DESZO_TEST_DUPLICATE_LIFECYCLE_RECEIPT',
];

export function lifecycleBridgeFromEnvironment(env = process.env) {
  const values = Object.fromEntries(ENV.map(name => [name, env[name]]));
  for (const name of ENV) delete env[name];
  if (ENV.every(name => !values[name])) return null;
  if (ENV.some(name => !values[name])) throw new Error('Lifecycle Host bootstrap is incomplete.');
  if (!/^[a-f0-9]{64}$/i.test(values.DESZO_LIFECYCLE_HOST_CAPABILITY)) throw new Error('Lifecycle Host capability is malformed.');
  if (values.DESZO_LIFECYCLE_APPLICATION_PID !== 'self'
    && (!/^\d+$/.test(values.DESZO_LIFECYCLE_APPLICATION_PID) || Number(values.DESZO_LIFECYCLE_APPLICATION_PID) < 1)) throw new Error('Lifecycle application PID is malformed.');
  const match = /^127\.0\.0\.1:(\d+)$/.exec(values.DESZO_LIFECYCLE_HOST_ADDRESS);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) throw new Error('Lifecycle Host endpoint is not a loopback endpoint.');
  const port = Number(match[1]);
  const token = Buffer.from(values.DESZO_LIFECYCLE_HOST_CAPABILITY, 'hex');
  const context = Object.freeze({
    installationId: values.DESZO_LIFECYCLE_INSTALLATION_ID,
    profileRoot: values.DESZO_LIFECYCLE_PROFILE_ROOT,
    generation: values.DESZO_LIFECYCLE_GENERATION,
    buildId: values.DESZO_APPLICATION_BUILD_ID,
    applicationPid: values.DESZO_LIFECYCLE_APPLICATION_PID === 'self' ? process.pid : Number(values.DESZO_LIFECYCLE_APPLICATION_PID),
    testDuplicateReceiptDelivery: values.DESZO_TEST_DUPLICATE_LIFECYCLE_RECEIPT === '1',
  });

  const call = (command, payload = {}) => new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let data = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    socket.setTimeout(5_000, () => finish(new Error('Lifecycle Host IPC timed out.')));
    socket.once('error', error => finish(new Error(`Lifecycle Host IPC failed: ${error.message}`)));
    socket.once('connect', () => socket.write(`${JSON.stringify({ capability: token.toString('hex'), command, payload })}\n`));
    socket.on('data', chunk => {
      data += chunk.toString('utf8');
      if (data.length > 128 * 1024) return finish(new Error('Lifecycle Host IPC response exceeded its limit.'));
      const newline = data.indexOf('\n');
      if (newline < 0) return;
      let response;
      try { response = JSON.parse(data.slice(0, newline)); } catch { return finish(new Error('Lifecycle Host returned malformed IPC data.')); }
      if (!response.ok) return finish(new Error(response.error || 'Lifecycle Host refused the request.'));
      finish(null, response.result);
    });
  });

  return Object.freeze({
    context,
    async ready({ pid, storeId, runtimeInstanceId }) {
      return call('engine.ready', { pid, storeId, runtimeInstanceId, applicationPid: context.applicationPid, applicationBuildId: context.buildId,
        installationId: context.installationId, profileRoot: context.profileRoot, generation: context.generation });
    },
    activateCandidate(request) { return call('lifecycle.activate_candidate', request); },
    acknowledgeReceipt(receiptId) { return call('lifecycle.receipt_ack', { receiptId }); },
  });
}

