// Shared transport helpers for deterministic and explicitly authorized live authoring checks.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { createParser } from '../runtime/core/adapters.mjs';
import { killTree } from '../runtime/core/processes.mjs';

export function temporaryUserMcpRegistration(provider, name, server) {
  assert.match(name, /^[a-zA-Z0-9_-]+$/);
  const path = provider === 'codex' ? join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml')
    : provider === 'claude' ? join(homedir(), '.claude.json') : join(homedir(), '.gemini', 'config', 'mcp_config.json');
  const existed = existsSync(path); mkdirSync(dirname(path), { recursive: true });
  const original = existed ? readFileSync(path, 'utf8') : '';
  if (provider === 'codex') {
    const block = `\n# Deszo acceptance registration ${name}\n[mcp_servers.${name}]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\nenabled = true\nstartup_timeout_sec = 20\ntool_timeout_sec = 30\n`;
    assert.ok(!original.includes(`[mcp_servers.${name}]`)); writeFileSync(path, original + block);
    return () => {
      const current = readFileSync(path, 'utf8'); assert.ok(current.includes(block), 'Temporary Codex registration changed.');
      const next = current.replace(block, ''); if (!existed && !next) unlinkSync(path); else writeFileSync(path, next);
    };
  }
  const parsed = original.trim() ? JSON.parse(original) : {}; parsed.mcpServers ||= {};
  assert.ok(!Object.hasOwn(parsed.mcpServers, name)); parsed.mcpServers[name] = server;
  writeFileSync(path, JSON.stringify(parsed, null, 2));
  return () => {
    const current = JSON.parse(readFileSync(path, 'utf8')); assert.deepEqual(current.mcpServers?.[name], server, 'Temporary registration changed.');
    delete current.mcpServers[name]; if (!Object.keys(current.mcpServers).length) delete current.mcpServers;
    if (!existed && !Object.keys(current).length) unlinkSync(path);
    else if (existed && !original.trim() && !Object.keys(current).length) writeFileSync(path, original);
    else writeFileSync(path, JSON.stringify(current, null, 2));
  };
}

export async function nativeInvocation(invocation, { provider, prefix, timeoutMs = 180_000, secrets = [] } = {}) {
  const child = spawn(invocation.command, invocation.args, { cwd: invocation.cwd, env: invocation.env,
    windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void killTree(child.pid); }, timeoutMs);
  child.stdout.on('data', bytes => { stdout += bytes; if (stdout.length > 20 * 1024 * 1024) void killTree(child.pid); });
  child.stderr.on('data', bytes => { stderr += bytes; if (stderr.length > 4 * 1024 * 1024) void killTree(child.pid); });
  child.stdin.on('error', () => {});
  child.once('spawn', () => child.stdin.end(invocation.stdin ?? ''));
  const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }).finally(() => clearTimeout(timer));
  const redact = text => secrets.filter(Boolean).reduce((s, secret) => s.replaceAll(secret, '[redacted]'), text);
  stdout = redact(stdout); stderr = redact(stderr);
  if (prefix) { writeFileSync(`${prefix}.stdout.jsonl`, stdout); writeFileSync(`${prefix}.stderr.txt`, stderr); }
  const parser = createParser(provider);
  for (const line of stdout.split(/\r?\n/)) { try { parser.feed(JSON.parse(line)); } catch { /* Native diagnostic line. */ } }
  return { exitCode, timedOut, ...parser.state, stdout, stderr };
}

export async function openBridge({ script, args, env = process.env, timeoutMs = 20_000 }) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', script, ...args], {
    env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
  });
  let sequence = 0, buffer = '', stderr = '';
  const pending = new Map();
  const fail = error => { for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); } pending.clear(); };
  child.stdout.on('data', bytes => {
    buffer += bytes;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let message;
      try { message = JSON.parse(line); } catch { fail(new Error('Bridge emitted non-JSON protocol output.')); continue; }
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(Object.assign(new Error(message.error.message), { rpcError: message.error }));
      else request.resolve(message.result);
    }
  });
  child.stderr.on('data', bytes => { stderr += bytes; });
  child.stdin.on('error', () => {});
  child.once('error', fail);
  child.once('close', code => fail(new Error(`Bridge closed (${code}): ${stderr.slice(-2000)}`)));
  const send = value => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Bridge timed out during ${method}: ${stderr.slice(-1000)}`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer }); send({ id, method, params });
  });
  try {
    const initialized = await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'deszo-acceptance', version: '1.0.0' } });
    send({ method: 'notifications/initialized' });
    return { initialized, request, call: (name, args = {}) => request('tools/call', { name, arguments: args }),
      async close() { child.stdin.end(); await Promise.race([new Promise(r => child.once('close', r)), new Promise(r => setTimeout(r, 1000))]); if (child.exitCode === null) await killTree(child.pid); },
      diagnostics: () => stderr };
  } catch (error) { await killTree(child.pid); throw error; }
}
