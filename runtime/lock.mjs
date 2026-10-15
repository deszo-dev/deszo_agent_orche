import { open, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export async function acquireRuntimeLock(filename) {
  const owner = { pid: process.pid, id: randomUUID() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(filename, 'wx');
      try { await handle.writeFile(JSON.stringify(owner)); } finally { await handle.close(); }
      return async () => {
        try {
          const current = JSON.parse(await readFile(filename, 'utf8'));
          if (current.id === owner.id) await unlink(filename);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let current;
      try { current = JSON.parse(await readFile(filename, 'utf8')); }
      catch { throw new Error('The runtime is already starting. Try again in a few seconds.'); }
      let alive = true;
      if (Number.isInteger(current.pid) && current.pid > 0) {
        try { process.kill(current.pid, 0); } catch (error) { alive = error.code !== 'ESRCH'; }
      }
      if (alive) throw new Error('A runtime already owns this data directory. Close the other instance (desktop app or npm run runner) first.');
      try { await unlink(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  throw new Error('Could not acquire the runtime lock.');
}
