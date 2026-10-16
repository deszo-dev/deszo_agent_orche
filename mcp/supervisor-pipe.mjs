import { createConnection } from 'node:net';

// The bridge's direct line to the native supervisor (ADR-0002 section 4). It does not use the runtime's HTTP event loop,
// so a hung runtime cannot block an emergency Stop. Requests are newline-delimited JSON, one reply per connection.
export function supervisorRequest({ pipeName, operation, payload = {}, timeoutMs = 15_000, connect = createConnection }) {
  return new Promise((resolve, reject) => {
    let socket;
    try { socket = connect(pipeName); }
    catch (error) { reject(Object.assign(error, { code: 'supervisor_unavailable' })); return; }
    let buffer = '';
    let settled = false;
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => settle(Object.assign(new Error('The supervisor did not answer in time.'), { code: 'supervisor_timeout' })), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: 1, op: operation, ...payload })}\n`));
    socket.on('data', chunk => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      let reply;
      try { reply = JSON.parse(buffer.slice(0, end)); }
      catch { settle(Object.assign(new Error('The supervisor sent an unreadable reply.'), { code: 'supervisor_error' })); return; }
      if (reply.error) settle(Object.assign(new Error(reply.error.message || 'The supervisor refused the request.'), { code: reply.error.code || 'supervisor_error' }));
      else settle(null, reply.result ?? null);
    });
    socket.on('error', error => settle(Object.assign(error, { code: 'supervisor_unavailable' })));
    socket.on('close', () => settle(Object.assign(new Error('The supervisor closed the connection before replying.'), { code: 'supervisor_unavailable' })));
  });
}
