// Minimal JSON-RPC client for `codex app-server --listen stdio://`. It records monotonic timings for every request, response
// and notification relative to the child's spawn. It never reads or copies credential files; the CODEX_HOME it is given
// is the only state it touches. Used only by the ADR-0007 PoC runner.
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

export const CODEX_EXE = 'C:/Users/jusse/AppData/Local/OpenAI/Codex/bin/896a0166b774037a/codex.exe';

export class AppServer {
  // capabilities, when given, are declared during initialize (for example { experimentalApi: true }). They are recorded as sent.
  constructor({ name, codexHome, codexExe = CODEX_EXE, extraArgs = [], capabilities = null }) {
    Object.assign(this, { name, codexHome, codexExe, extraArgs, capabilities, events: [], pending: new Map(), nextId: 1, buffer: '', stderr: '', exit: null });
  }

  async start() {
    this.t0 = performance.now();
    this.wallStart = new Date().toISOString();
    this.child = spawn(this.codexExe, ['app-server', '--listen', 'stdio://', ...this.extraArgs], {
      env: { ...process.env, CODEX_HOME: this.codexHome }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    this.child.on('error', error => { this.spawnError = error.message; });
    this.child.stdout.on('data', chunk => this.#onStdout(chunk));
    this.child.stderr.on('data', chunk => { if (this.stderr.length < 4000) this.stderr += chunk.toString(); });
    this.child.on('exit', (code, signal) => {
      this.exit = { atMs: this.#now(), code, signal };
      for (const [, waiter] of this.pending) waiter({ ok: false, error: { message: 'app-server exited before responding' }, receivedMs: this.#now() });
      this.pending.clear();
    });
    if (this.spawnError) throw new Error(this.spawnError);
    const params = { clientInfo: { name: 'deszo-adr7-poc', title: null, version: '0.1.0' }, ...(this.capabilities ? { capabilities: this.capabilities } : {}) };
    const init = await this.call('initialize', params, 20000);
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
    return init;
  }

  #now() { return Math.round((performance.now() - this.t0) * 1000) / 1000; }

  #onStdout(chunk) {
    this.buffer += chunk.toString();
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { this.events.push({ atMs: this.#now(), kind: 'unparsed', text: line.slice(0, 300) }); continue; }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const waiter = this.pending.get(message.id); this.pending.delete(message.id); waiter(message);
      } else if (message.method) {
        this.events.push({ atMs: this.#now(), kind: 'notification', method: message.method, params: message.params });
      } else if (message.id !== undefined) {
        this.events.push({ atMs: this.#now(), kind: 'unmatched_response', id: message.id });
      }
    }
  }

  // Sends one request. Resolves with the response and timing; never throws on a protocol error, so experiments can classify it.
  call(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId++;
    const sentMs = this.#now();
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, error: { message: `timeout after ${timeoutMs} ms` }, sentMs, receivedMs: this.#now(), timedOut: true }); }, timeoutMs);
      timer.unref();
      this.pending.set(id, message => {
        clearTimeout(timer);
        const receivedMs = this.#now();
        if (message.error) resolve({ ok: false, error: message.error, sentMs, receivedMs, durationMs: receivedMs - sentMs });
        else if (message.result !== undefined) resolve({ ok: true, result: message.result, sentMs, receivedMs, durationMs: receivedMs - sentMs });
        else resolve({ ok: false, error: { message: 'response had neither result nor error' }, sentMs, receivedMs, durationMs: receivedMs - sentMs });
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  // Waits for a matching notification already recorded or arriving later. Resolves null on timeout.
  waitFor(predicate, timeoutMs = 30000, fromIndex = 0) {
    const started = performance.now();
    return new Promise(resolve => {
      const check = () => {
        const found = this.events.slice(fromIndex).find(event => event.kind === 'notification' && predicate(event));
        if (found) return resolve(found);
        if (this.exit) return resolve(null);
        if (performance.now() - started > timeoutMs) return resolve(null);
        setTimeout(check, 50);
      };
      check();
    });
  }

  notificationsSince(index) { return this.events.slice(index).filter(event => event.kind === 'notification'); }

  // Ends the child process. The exit observation is recorded; this does not stop any model turn beyond the child.
  async kill(reason) {
    if (!this.exit && this.child) {
      const exited = new Promise(resolve => this.child.once('exit', resolve));
      this.child.kill();
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
    }
    this.killReason = reason;
    return this.exit;
  }
}
