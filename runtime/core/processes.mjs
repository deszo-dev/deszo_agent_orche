import { spawn } from 'node:child_process';
import { capture } from './adapters.mjs';
import { SUPERVISOR_ENV } from './supervisor-client.mjs';

// Owned process trees are terminated explicitly; the Rust Job Object is the crash backstop.
export async function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') await capture('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeout: 15_000, env: process.env });
  else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone. */ } } }
}

export function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// Start identity guards against killing a reused PID during standalone recovery.
export async function processStartTime(pid) {
  if (process.platform !== 'win32') return null;
  const result = await capture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().ToString('o') }`], { timeout: 15_000, env: process.env });
  const text = result.stdout.trim();
  return text ? Date.parse(text) : null;
}

export function launch({ command, args, cwd, env, stdin }) {
  // The supervisor's pipe and token never reach a shim or a CLI: the CLI would inherit them as its environment.
  const inherited = Object.fromEntries(Object.entries(env ?? process.env).filter(([key]) => !SUPERVISOR_ENV.includes(key)));
  const child = spawn(command, args, { cwd, env: inherited, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  child.stdin.on('error', () => {}); // A CLI may exit before consuming its prompt.
  child.once('spawn', () => child.stdin.end(stdin ?? ''));
  return child;
}
