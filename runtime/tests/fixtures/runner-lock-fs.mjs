// Test-only `node:fs` for runtime/lock.mjs. With RUNNER_LOCK_FS_LOG set, every write, rename and removal that touches the marker (or its
// temporary file) is appended to that log as "<pid> <operation> <path>" before it is performed.
import * as real from 'node:fs';

export * from 'node:fs';

const log = process.env.RUNNER_LOCK_FS_LOG;
const record = (operation, ...paths) => {
  if (log && paths.some(path => /runner\.lock(\.|$)/.test(String(path)) && !String(path).endsWith('.db'))) real.appendFileSync(log, `${process.pid} ${operation} ${paths.join(' -> ')}\n`);
};

export function writeFileSync(path, ...rest) { record('write', path); return real.writeFileSync(path, ...rest); }
export function renameSync(from, to) { record('rename', from, to); return real.renameSync(from, to); }
export function unlinkSync(path) { record('unlink', path); return real.unlinkSync(path); }
