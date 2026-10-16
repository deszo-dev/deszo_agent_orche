import { createConnection } from 'node:net';
import { existsSync } from 'node:fs';

// Client of the Tauri supervisor's control pipe (ADR-0002 section 4). Requests are newline-delimited JSON. The control
// token stays in this process's memory: it is never written to a child environment, a manifest or a model-visible result.
export const SUPERVISOR_ENV = ['DESZO_SUPERVISOR_PIPE', 'DESZO_SUPERVISOR_TOKEN', 'DESZO_LAUNCH_SHIM'];

export class SupervisorClient {
  constructor({ pipeName, token, shimPath, connect = createConnection, requestTimeoutMs = 15_000 }) {
    Object.assign(this, { pipeName, token, shimPath, connect, requestTimeoutMs });
    this.socket = null; this.buffer = ''; this.nextId = 1; this.pending = new Map();
  }

  // One socket serves every request; a lost socket fails the pending requests and the next request reconnects.
  ensureSocket() {
    if (this.socket && !this.socket.destroyed) return this.socket;
    const socket = this.connect(this.pipeName);
    this.socket = socket; this.buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        let reply;
        try { reply = JSON.parse(line); } catch { continue; }
        const waiter = this.pending.get(reply.id);
        if (!waiter) continue;
        this.pending.delete(reply.id);
        clearTimeout(waiter.timer);
        if (reply.error) waiter.reject(Object.assign(new Error(reply.error.message || 'The supervisor refused the request.'), { code: reply.error.code || 'supervisor_error' }));
        else waiter.resolve(reply.result ?? null);
      }
    });
    const lost = () => {
      for (const [id, waiter] of this.pending) { clearTimeout(waiter.timer); this.pending.delete(id); waiter.reject(Object.assign(new Error('The supervisor connection was lost.'), { code: 'supervisor_unavailable' })); }
    };
    socket.on('error', lost);
    socket.on('close', lost);
    return socket;
  }

  request(op, body = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`The supervisor did not answer ${op} within ${this.requestTimeoutMs} ms.`), { code: 'supervisor_timeout' }));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ensureSocket().write(`${JSON.stringify({ id, token: this.token, op, ...body })}\n`); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(Object.assign(error, { code: 'supervisor_unavailable' })); }
    });
  }

  armRun(runId, deadlines) { return this.request('arm', { runId, ...deadlines }); }
  disarmRun(runId) { return this.request('disarm', { runId }); }
  heartbeat(runId) { return this.request('heartbeat', { runId }); }
  // The runtime's own liveness, sent on a clock separate from the controller's acknowledgements.
  runtimeAlive() { return this.request('runtime_alive', {}); }
  // A first-party extension of the escalation deadline; resolves only once the supervisor confirms the new deadline.
  extendRun(runId, extensionMs) { return this.request('extend', { runId, extensionMs }); }
  // The supervisor's own view of the run: whether it escalated, and how stale its last acknowledgement is.
  status(runId) { return this.request('status', { runId }); }
  // Drops the run Job once it has no members. A run with members stays until its Stop is proven.
  releaseRun(runId) { return this.request('release', { runId }); }
  bindShim(runId, rendezvousId, pid) { return this.request('bind_shim', { runId, rendezvousId, pid }); }

  // The supervisor terminates the run Job and reports its active members; zero members is the containment proof.
  async proveStopped(runId, pids = []) {
    const result = await this.request('prove_stopped', { runId, pids });
    const known = Number.isInteger(result.remainingMembers);
    if (!known) return { containment: 'windows-job', confirmed: false, remainingMembers: null,
      reason: 'The supervisor has no record of this run Job, so nothing proves that its members stopped.' };
    return { containment: 'windows-job', confirmed: result.remainingMembers === 0, remainingMembers: result.remainingMembers,
      reason: result.remainingMembers === 0 ? 'The native run Job reports zero active members.' : `The native run Job still reports ${result.remainingMembers} member(s).` };
  }

  close() {
    if (this.socket) this.socket.end();
    this.socket = null;
  }
}

// Exit codes the launch shim reports for its own failures (src-tauri/src/bin/launch_shim.rs). A process that exits with one
// of these never ran its CLI, so it is a spawn failure, not a result.
export const SHIM_FAILURES = new Map([[0x7DE50120, 'rendezvous_failed'], [0x7DE50121, 'assignment_failed'], [0x7DE50122, 'spawn_failed']]);
export const shimFailureOf = code => SHIM_FAILURES.get(code) ?? null;

// Built from the environment Tauri set for this runtime only. Absent variables mean no supervisor: headless runs.
// The variables are read once and removed from the environment, so no later spawn path can copy the token.
export function supervisorFromEnvironment(env = process.env, options = {}) {
  const pipeName = env.DESZO_SUPERVISOR_PIPE, token = env.DESZO_SUPERVISOR_TOKEN, shimPath = env.DESZO_LAUNCH_SHIM;
  for (const key of SUPERVISOR_ENV) delete env[key];
  if (!pipeName || !token || !shimPath) return null;
  if (!existsSync(shimPath)) throw new Error(`The launch shim is missing at ${shimPath}; no supervised process can be contained.`);
  return new SupervisorClient({ pipeName, token, shimPath, ...options });
}
