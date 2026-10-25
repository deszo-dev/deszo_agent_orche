// Test-only `node:sqlite` for runtime/lock.mjs. With RUNNER_LOCK_BARRIER_DIR and RUNNER_LOCK_BARRIER_COUNT set, the first open of the lock
// database marks this process ready and waits (bounded) until that many contenders are ready, so that all of them try the lock together.
import * as real from 'node:sqlite';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';

export * from 'node:sqlite';

const dir = process.env.RUNNER_LOCK_BARRIER_DIR, count = Number(process.env.RUNNER_LOCK_BARRIER_COUNT || 0);
const pause = new Int32Array(new SharedArrayBuffer(4));
let arrived = false;

function barrier() {
  if (!dir || !count || arrived) return;
  arrived = true;
  writeFileSync(`${dir}/ready-${process.pid}`, String(Date.now()));
  const until = Date.now() + 30_000;
  while (!existsSync(dir) || readdirSync(dir).filter(name => name.startsWith('ready-')).length < count) {
    if (Date.now() > until) throw new Error(`runner.lock barrier timed out in ${process.pid}`);
    Atomics.wait(pause, 0, 0, 5);
  }
  writeFileSync(`${dir}/released-${process.pid}`, String(Date.now()));
}

export class DatabaseSync extends real.DatabaseSync {
  constructor(path, ...options) {
    if (String(path).endsWith('runner.lock.db')) barrier();
    super(path, ...options);
  }
}
