import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
export const INSTALLED_HOST_CLIENT = 'C:/Program Files/Deszo Control Host/deszo-control.exe';
export const INSTALLED_HOST_PIPE = '\\\\.\\pipe\\deszo-control-host-v1';

// The protected helper verifies the pipe server against SCM and exposes its actual parent PID to the service.
export function nativeHostSocket(executable = INSTALLED_HOST_CLIENT) {
  const events = new EventEmitter();
  const child = spawn(executable, ['client'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let first = '', connected = false, closed = false, stderr = '';
  events.setEncoding = () => {};
  events.write = value => child.stdin.write(value);
  events.end = () => child.stdin.end();
  events.destroy = () => { child.stdin.destroy(); child.kill(); };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    if (connected) { events.emit('data', chunk); return; }
    first += chunk; const newline = first.indexOf('\n');
    if (first.length > 4096) { events.emit('error', new Error('The native client handshake exceeded its bound.')); events.destroy(); return; }
    if (newline < 0) return;
    let greeting;
    try { greeting = JSON.parse(first.slice(0, newline)); } catch { events.emit('error', new Error('Malformed native client handshake.')); events.destroy(); return; }
    if (greeting.event !== 'native_connected') { events.emit('error', new Error('The native client did not verify the installed service.')); events.destroy(); return; }
    connected = true; events.emit('connect');
    if (first.slice(newline + 1)) events.emit('data', first.slice(newline + 1)); first = '';
  });
  child.stderr.on('data', bytes => { if (stderr.length < 4096) stderr += bytes.toString(); });
  child.stdin.on('error', error => events.emit('error', error));
  child.on('error', error => events.emit('error', error));
  child.on('close', code => {
    if (code && !closed) events.emit('error', new Error(`Native host connection failed (${code}): ${stderr.slice(0, 4096)}`));
    if (!closed) { closed = true; events.emit('close'); }
  });
  return events;
}
