import { spawn } from 'node:child_process';

// Certifies this caller, not an arbitrary desktop MCP host or model turn latency.
export const CONTROLLER_TRANSPORT = Object.freeze({
  clientVersion: 'deszo-stdio-controller/1', protocolVersion: '2025-03-26',
  maxWatchWaitMs: 20_000, bridgeHttpTimeoutMs: 30_000, toolTimeoutMs: 45_000, enclosingToolTimeoutMs: 55_000,
});

export async function openBridge({ script, args = [], command = process.execPath, env = process.env,
  timeoutMs = CONTROLLER_TRANSPORT.toolTimeoutMs, maxResponseBytes = 4 * 1024 * 1024 }) {
  const child = spawn(command, ['--disable-warning=ExperimentalWarning', script, ...args], {
    env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let sequence = 0, buffer = '', stderr = '', closed = false;
  const pending = new Map();
  const fail = error => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  const ended = new Promise(done => child.once('close', () => { closed = true; done(); }));
  child.stdin.on('error', () => {});
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', text => { stderr = (stderr + text).slice(-2000); });
  child.stdout.on('data', text => {
    buffer += text;
    if (Buffer.byteLength(buffer) > maxResponseBytes) { fail(new Error('MCP response exceeded its byte bound.')); child.kill(); return; }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let message;
      try { message = JSON.parse(line); } catch { fail(new Error('Non-JSON MCP response.')); child.kill(); return; }
      const item = pending.get(message.id);
      if (!item) continue;
      pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) item.reject(Object.assign(new Error(message.error.message), { rpcError: message.error }));
      else item.resolve(message.result);
    }
  });
  child.once('error', fail);
  child.once('close', code => fail(new Error(`MCP bridge closed (${code}).`)));
  const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    if (closed) { reject(new Error('MCP bridge is closed.')); return; }
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      send({ method: 'notifications/cancelled', params: { requestId: id, reason: 'Controller transport deadline' } });
      reject(Object.assign(new Error(`MCP request exceeded ${timeoutMs}ms: ${method}`), { code: 'controller_transport_timeout' }));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer }); send({ id, method, params });
  });
  const close = async () => {
    if (closed) return;
    fail(new Error('MCP client closed.'));
    const timer = setTimeout(() => child.kill(), 1000);
    child.stdin.end();
    try { await ended; } finally { clearTimeout(timer); }
  };
  try {
    const initialized = await request('initialize', { protocolVersion: CONTROLLER_TRANSPORT.protocolVersion,
      capabilities: {}, clientInfo: { name: 'deszo-controller', version: CONTROLLER_TRANSPORT.clientVersion } });
    send({ method: 'notifications/initialized' });
    return { initialized, request, call: (name, input = {}) => request('tools/call', { name, arguments: input }),
      close, pid: child.pid, diagnostics: () => stderr };
  } catch (error) { await close(); throw error; }
}
