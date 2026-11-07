// Boot identity and elapsed time for the Local Control Host (ADR-0006 "Time and expiry").
//
// Elapsed authority time is measured with the OS uptime counter, which on Windows is GetTickCount64: it is
// monotonic within one boot and keeps counting through sleep and hibernation, so suspended time consumes the
// authorized lifetime. Wall-clock time is used only as an additional upper bound; a clock rollback can shorten
// nothing and extend nothing. A different boot identity, or an identity that cannot be read, means continuity is
// uncertain and dispatch under the previous policy is blocked.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { uptime } from 'node:os';

const PREFETCH_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters';

function windowsBootId() {
  const result = spawnSync('reg', ['query', PREFETCH_KEY, '/v', 'BootId'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  if (result.status !== 0) return null;
  const match = /BootId\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(result.stdout);
  return match ? `windows-bootid:${parseInt(match[1], 16)}` : null;
}

function linuxBootId() {
  const path = '/proc/sys/kernel/random/boot_id';
  return existsSync(path) ? `linux-bootid:${readFileSync(path, 'utf8').trim()}` : null;
}

export function systemTimeSource() {
  // The boot identity cannot change while this process runs, so it is read once.
  const bootId = process.platform === 'win32' ? windowsBootId() : linuxBootId();
  return {
    bootId: () => bootId,
    uptimeMs: () => Math.floor(uptime() * 1000),
    wallNow: () => Date.now(),
    description: process.platform === 'win32'
      ? 'Windows BootId counter; GetTickCount64 uptime including sleep and hibernation'
      : 'Kernel boot_id; system uptime',
  };
}

// A controllable source for tests and bounded state exploration.
export function manualTimeSource({ bootId = 'test-boot:1', uptimeMs = 1_000_000, wallMs = Date.parse('2026-10-20T10:00:00.000Z') } = {}) {
  const state = { bootId, uptimeMs, wallMs };
  return {
    state,
    bootId: () => state.bootId,
    uptimeMs: () => state.uptimeMs,
    wallNow: () => state.wallMs,
    advance(ms) { state.uptimeMs += ms; state.wallMs += ms; },
    sleep(ms) { state.uptimeMs += ms; state.wallMs += ms; },
    setWall(ms) { state.wallMs = ms; },
    reboot(nextBootId) { state.bootId = nextBootId; state.uptimeMs = 5_000; },
    description: 'manual test time source',
  };
}

// Remaining authority for a policy anchored at issue time. Returns { valid, remainingMs, reason }.
export function remainingAuthority(policy, time) {
  const bootId = time.bootId();
  if (!bootId) return { valid: false, remainingMs: 0, reason: 'boot_identity_unavailable' };
  if (bootId !== policy.boot_id) return { valid: false, remainingMs: 0, reason: 'reboot_requires_fresh_consent' };
  const elapsed = time.uptimeMs() - policy.uptime_anchor_ms;
  if (elapsed < 0) return { valid: false, remainingMs: 0, reason: 'time_continuity_uncertain' };
  const byMonotonic = policy.duration_ms - elapsed;
  const byWall = Date.parse(policy.expires_at) - time.wallNow();
  const remainingMs = Math.min(byMonotonic, byWall);
  if (remainingMs <= 0) return { valid: false, remainingMs: 0, reason: 'expired' };
  return { valid: true, remainingMs, reason: 'valid' };
}
