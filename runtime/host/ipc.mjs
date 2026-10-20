// Local IPC for the Local Control Host (ADR-0006 section 7): newline-delimited JSON requests over a named pipe.
//
// Authority is bound to the connection and to live state, never to identifiers in a message:
// - a controller authenticates on its own socket with a signature over a fresh nonce;
// - a launched runtime registers on its own socket with the one-time launch proof the host issued (consumed atomically);
// - a controlling runtime re-attaches only with the attach secret it received at registration, never with its generation alone;
// - a permit operation is open only to the policy's controller, or to the live runtime generation the permit names;
// - revocation is open to the authenticated controller, or to the user surface with the installation's secret.
// Credential enrollment and key management are not reachable over IPC.
//
// Peer verification: when a peerVerifier is supplied (the Windows pipe server supplies one that reads the connected
// process, token and session), registration must also match the verified peer. Without one the registration matches only
// the host-observed process, which is fixture assurance. Production assurance refuses to start without verified peer identity.
import { createConnection, createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { HostError } from './authority.mjs';

const MAX_LINE = 1024 * 1024;

export function hostPipeName(user = process.env.USERNAME || process.env.USER || 'user') {
  return process.platform === 'win32' ? `\\\\.\\pipe\\deszo-control-host-${user}` : `/tmp/deszo-control-host-${user}.sock`;
}

export function startHostServer({ host, pipeName, peerVerifier = null }) {
  const runtimeSockets = new Set();
  const handlers = {
    status: (_, p) => host.status(p.policyId),
    'session.index': (_, p) => host.sessionIndex(p.sessionId),
    'policy.propose': (_, p) => host.proposePolicy(p),
    'policy.authorize': (_, p) => host.authorizePolicy(p),
    'controller.challenge': (_, p) => host.controllerChallenge(p.policyId, p.controllerId),
    'controller.authenticate': (socket, p) => {
      const { connectionId } = host.authenticateController(p);
      socket.controller = { connectionId, policyId: host.controllerConnections.get(connectionId).policyId };
      return { authenticated: true, policyId: socket.controller.policyId };
    },
    decide: (socket, p) => host.decide(p.request, { connectionId: socket.controller?.connectionId ?? null, runtime: socket.runtime ?? null }),
    'runtime.register_initial': (socket, p) => host.registerInitialRuntime({ ...p, connectionId: socket.controller?.connectionId }),
    'runtime.register': (socket, p) => {
      const result = host.registerRuntime({ ...p, peerEvidence: socket.peer ?? null });
      socket.runtime = { policyId: p.policyId, runtimeGeneration: result.runtimeGeneration };
      runtimeSockets.add(socket);
      return result;
    },
    'runtime.attach': (socket, p) => {
      const result = host.attachRuntime(p);
      socket.runtime = { policyId: p.policyId, runtimeGeneration: p.runtimeGeneration };
      runtimeSockets.add(socket);
      return result;
    },
    'permit.request': (socket, p) => requireParty(socket, host.permitRequest(p.permitId)),
    admit: (socket, p) => { requireParty(socket, host.permitRequest(p.permitId)); return host.admit(p.permitId); },
    settle: (socket, p) => { requireParty(socket, host.permitRequest(p.permitId)); return host.settle(p.permitId, p); },
    'work.release': (socket, p) => { requireParty(socket, host.permitRequest(p.permitId)); return host.releaseWork(p.permitId, p.workRef, { evidence: p.evidence }); },
    revoke: (socket, p) => {
      if (socket.controller) return host.revoke(p.policyId, { actor: p.actor || 'controller', connectionId: socket.controller.connectionId });
      if (host.authorizeUserSurface(p.userSurfaceToken)) return host.revoke(p.policyId, { actor: p.actor || 'user surface' });
      throw new HostError(403, 'not_authorized', 'Revocation needs the authenticated controller or the user surface.');
    },
    'operation.reconcile': (socket, p) => { requireController(socket, host.operationRow(p.operationId).policy_id); return host.reconcileOperation(p.operationId, p); },
  };
  function requireController(socket, policyId) {
    if (socket.controller?.policyId !== policyId) throw new HostError(403, 'controller_not_authenticated', 'This connection is not an authenticated controller for the policy.');
  }
  // Permit operations are open to the policy's controller or to the live runtime generation the permit was decided for.
  function requireParty(socket, permit) {
    const controllerParty = socket.controller?.policyId === permit.policyId;
    const runtimeParty = socket.runtime?.policyId === permit.policyId && socket.runtime.runtimeGeneration === permit.request.runtimeGeneration;
    if (!controllerParty && !runtimeParty) throw new HostError(403, 'not_a_party', 'This connection is neither the controller nor the live runtime generation of the permit\'s policy.');
    return permit;
  }
  const previousStop = host.onStop;
  host.onStop = (permits, works = []) => {
    previousStop?.(permits, works);
    // Owned work crosses the wire as its run references; the runtime stops those runs and ignores anything else.
    const workRefs = works.map(work => work.workRef);
    for (const socket of runtimeSockets) if (!socket.destroyed) socket.write(`${JSON.stringify({ event: 'stop', permits, works: workRefs })}\n`);
  };
  const server = createServer(socket => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.peer = peerVerifier ? peerVerifier(socket) : null;
    socket.on('close', () => runtimeSockets.delete(socket));
    socket.on('error', () => runtimeSockets.delete(socket));
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > MAX_LINE) { socket.destroy(); return; }
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let message;
        try { message = JSON.parse(line); } catch { socket.write(`${JSON.stringify({ id: null, error: { status: 400, code: 'invalid_json', message: 'Malformed request.' } })}\n`); continue; }
        const handler = handlers[message.method];
        try {
          if (!handler) throw new HostError(404, 'unknown_method', `Unknown host method ${message.method}.`);
          socket.write(`${JSON.stringify({ id: message.id, result: handler(socket, message.params || {}) })}\n`);
        } catch (error) {
          socket.write(`${JSON.stringify({ id: message.id, error: { status: error.status || 500, code: error.code || 'host_error', message: error.message } })}\n`);
        }
      }
    });
  });
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(pipeName, () => resolvePromise(server));
  });
}

// A client connection. Every call is bound to this one socket; reconnecting means authenticating again.
export function connectHost(pipeName, { timeoutMs = 10_000 } = {}) {
  const events = new EventEmitter();
  const pending = new Map();
  let buffer = '';
  const socket = createConnection(pipeName);
  socket.setEncoding('utf8');
  const ready = new Promise((resolvePromise, reject) => { socket.once('connect', resolvePromise); socket.once('error', reject); });
  ready.catch(() => {});
  socket.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      if (message.event) { events.emit(message.event, message); continue; }
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(Object.assign(new HostError(message.error.status, message.error.code, message.error.message)));
      else entry.resolve(message.result);
    }
  });
  socket.on('error', () => {});
  socket.on('close', () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new HostError(503, 'host_unavailable', 'The Local Control Host connection closed.')); }
    pending.clear();
    events.emit('close');
  });
  const call = async (method, params = {}) => {
    await ready;
    const id = randomUUID();
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new HostError(504, 'host_timeout', `The host did not answer ${method}.`)); }, timeoutMs);
      pending.set(id, { resolve: resolvePromise, reject, timer });
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  };
  return {
    call, events, ready, close: () => socket.end(),
    // The engine-facing adapter: the calls a host-bound runtime makes for its own permits and provider charges.
    engineAdapter: () => ({
      permitRequest: permitId => call('permit.request', { permitId }),
      admit: permitId => call('admit', { permitId }),
      settle: (permitId, { effect, evidence, workRef = null }) => call('settle', { permitId, effect, evidence, workRef }),
      releaseWork: (permitId, workRef, evidence) => call('work.release', { permitId, workRef, evidence }),
      decide: request => call('decide', { request }),
    }),
  };
}
