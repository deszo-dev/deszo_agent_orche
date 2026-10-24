// Shared helpers for the ADR-0007 PoC runner: run roots, sanitization and result records. Isolated homes live outside the
// repository and outside Windows Temp, because the desktop app's packaged AppData redirection would otherwise relocate them.
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const EVIDENCE_DIR = join(HERE, '..');
export const RESULTS_DIR = join(EVIDENCE_DIR, 'results');
export const RUN_ROOT = process.env.DESZO_POC_ROOT || 'C:/DeszoPoC/adr7-poc-run';
export const WORKSPACE = `${RUN_ROOT}/workspace`;
export const ECHO_MCP = join(HERE, 'poc-echo-mcp.mjs').replaceAll('\\', '/');
export const USER_PROFILE = 'C:\\Users\\jusse';

export function ensureDirs() {
  for (const dir of [RUN_ROOT, WORKSPACE, RESULTS_DIR]) mkdirSync(dir, { recursive: true });
}

export function home(name) {
  const dir = `${RUN_ROOT}/home-${name}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Removes the user's profile path and the run root from anything written to the repository.
const REDACTIONS = [
  [RUN_ROOT, '<POC_ROOT>'], [RUN_ROOT.replaceAll('/', '\\'), '<POC_ROOT>'],
  [USER_PROFILE, '<USER_PROFILE>'], [USER_PROFILE.replaceAll('\\', '/'), '<USER_PROFILE>'],
];
export function sanitize(value) {
  if (typeof value === 'string') return REDACTIONS.reduce((text, [from, to]) => text.replaceAll(from, to), value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
  return value;
}

export function writeResult(id, record) {
  const path = join(RESULTS_DIR, `${id}.json`);
  writeFileSync(path, `${JSON.stringify(sanitize(record), null, 2)}\n`);
  return path;
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// Finds files by name under a directory (names only; never reads contents).
export function listNames(dir, predicate = () => true, depth = 6) {
  const out = [];
  if (!existsSync(dir)) return out;
  const walk = (current, level) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      const isDir = statSync(full).isDirectory();
      if (!isDir && predicate(entry)) out.push(full);
      if (isDir && level < depth) walk(full, level + 1);
    }
  };
  walk(dir, 0);
  return out;
}

// Result envelope: the status is one of PASS, FAIL, BLOCKED, INCONCLUSIVE, and checks decide PASS or FAIL.
export function verdict(checks, { blocked = null, inconclusive = null } = {}) {
  if (blocked) return 'BLOCKED';
  if (checks.some(check => check.pass === false)) return 'FAIL';
  if (inconclusive) return 'INCONCLUSIVE';
  return 'PASS';
}

export const check = (name, pass, detail = null) => ({ name, pass: Boolean(pass), detail });
