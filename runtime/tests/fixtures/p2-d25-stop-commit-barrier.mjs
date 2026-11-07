// Test-only preload for P2-E2E-06. It wraps the real Parent Stop callback after
// Engine's idempotent transaction has committed, then blocks before the P2 hook.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Engine } from '../../core/engine.mjs';

const barrierDir = process.env.DESZO_P2_D25_BARRIER_DIR;
if (barrierDir) {
  const original = Engine.prototype.afterLogicalParentStop;
  if (typeof original !== 'function') throw new Error('P2 D25 callback barrier could not find the installed Parent Stop hook.');
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  Engine.prototype.afterLogicalParentStop = function afterLogicalParentStopWithD25Barrier(parentRunId) {
    let targeted = false;
    const armPath = join(barrierDir, 'arm.json');
    if (existsSync(armPath)) {
      const arm = JSON.parse(readFileSync(armPath, 'utf8'));
      if (arm.parentRunId === parentRunId) {
        targeted = true;
        writeFileSync(join(barrierDir, 'callback-entered.json'), JSON.stringify({
          event: 'parent_stop_callback_entered', parentRunId, enginePid: process.pid, monotonicNs: process.hrtime.bigint().toString(),
        }));
        while (!existsSync(join(barrierDir, 'release'))) Atomics.wait(waitCell, 0, 0, 20);
        writeFileSync(join(barrierDir, 'original-callback-entered.json'), JSON.stringify({ parentRunId, enginePid: process.pid }));
      }
    }
    const result = original.call(this, parentRunId);
    if (targeted) writeFileSync(join(barrierDir, 'original-callback-completed.json'), JSON.stringify({ parentRunId, enginePid: process.pid }));
    return result;
  };
  writeFileSync(join(barrierDir, 'preload-ready.json'), JSON.stringify({ event: 'parent_stop_barrier_installed', enginePid: process.pid }));
}
