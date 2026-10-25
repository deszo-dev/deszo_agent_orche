import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// One Engine owns a runtime root for its whole life. Ownership is an exclusive SQLite lock on a dedicated database next to the marker
// (`runner.lock.db`), never on the runtime store: in EXCLUSIVE locking mode the connection keeps the file lock it took for its first write
// until it is closed, and the operating system releases it when the process ends, however it ends. Nothing is ever judged stale and nothing
// is deleted to take ownership. A second starter's attempt fails at once (SQLITE_BUSY) and it never reaches the Engine.
// `runner.lock` ({ pid, id }) is a marker for diagnostics and for the Windows interactive launcher, which reads it. Only the owner writes it,
// after taking the lock, replacing a marker that a crashed owner left behind; it is not proof of ownership, and its absence admits nobody.
// Verified on Windows, where SQLite opens the database without delete sharing, so it cannot be removed while held. On POSIX the lock is an
// fcntl lock: removing or renaming `runner.lock.db` (or its directory) while an Engine runs would let a second one lock a new file, any other
// open and close of the file inside the owning process would drop the lock, and network file systems may not honour it. None of this is tested.
const PACKAGED = typeof __DESZO_PACKAGED__ !== 'undefined' && __DESZO_PACKAGED__;
const CONTENDED = new Set([5, 6]); // SQLITE_BUSY, SQLITE_LOCKED (primary codes)
const DAMAGED = new Set([11, 26]); // SQLITE_CORRUPT, SQLITE_NOTADB
const ATTEMPTS = 5;
const OWNED = 'A runtime already owns this data directory. Close the other instance (desktop app or npm run runner) first.';
// Every owning connection stays strongly referenced here until its release closes it, so ownership never depends on a caller keeping the
// release closure alive (a collected connection would be closed, and its lock released).
const held = new Set();

// Test-only crash points around the marker write. Inert unless the variable names one, and absent from the packaged runtime.
function testFault(point) {
  if (!PACKAGED && process.env.DESZO_RUNNER_LOCK_TEST_FAULT === point) process.exit(97);
}

const sleep = ms => new Promise(done => setTimeout(done, ms));

// Takes the exclusive lock, or returns null when another connection holds the database. Two starters that meet in SQLite's lock ladder can
// both be refused; a refused attempt holds nothing once its connection is closed, so the caller may try again. A retry can never admit a
// second owner: every attempt is decided by the file lock itself. Every owner's id is recorded (append-only) before its marker can exist, so a
// marker whose id is recorded was written by an owner of this database. Returns the connection, the marker found, and whether it is one.
function tryOwn(path, owner, markerFile) {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode = DELETE; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE');
    let existing, recorded;
    try {
      db.exec('CREATE TABLE IF NOT EXISTS owners (id TEXT PRIMARY KEY, pid INTEGER NOT NULL, acquired_at TEXT NOT NULL)');
      db.prepare('INSERT INTO owners (id, pid, acquired_at) VALUES (?, ?, ?)').run(owner.id, owner.pid, new Date().toISOString());
      existing = readMarker(markerFile);
      recorded = typeof existing?.id === 'string' && Boolean(db.prepare('SELECT 1 AS found FROM owners WHERE id = ?').get(existing.id));
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch { /* No transaction is open. */ } throw error; }
    return { db, existing, recorded };
  } catch (error) {
    db.close();
    const code = error.errcode & 0xff;
    if (CONTENDED.has(code)) return null;
    if (DAMAGED.has(code)) throw new Error(`The runtime lock ${path} is damaged (${error.message}). Once no Deszo runtime is running, delete that file and start again.`);
    throw new Error(`The runtime lock ${path} could not be taken: ${error.message}`);
  }
}

// A marker replaced while another process reads it (the launcher opens it without delete sharing) is retried briefly.
async function retryingSharing(action) {
  for (let attempt = 1; ; attempt++) {
    try { return action(); } catch (error) {
      if (attempt >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      await sleep(25);
    }
  }
}

// The marker as written, null when there is none, undefined when it cannot be read as one.
function readMarker(filename) {
  try { const marker = JSON.parse(readFileSync(filename, 'utf8')); return marker && typeof marker === 'object' ? marker : undefined; }
  catch (error) { return error.code === 'ENOENT' ? null : undefined; }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export async function acquireRuntimeLock(filename) {
  const owner = { pid: process.pid, id: randomUUID() };
  let owned = null;
  for (let attempt = 1; !owned; attempt++) {
    owned = tryOwn(`${filename}.db`, owner, filename);
    if (!owned && attempt >= ATTEMPTS) throw new Error(OWNED);
    if (!owned) await sleep(20 + Math.floor(Math.random() * 60));
  }
  const { db, existing, recorded } = owned;
  held.add(db);
  try {
    // A runtime from before this lock holds only the marker. A marker that no owner of this database wrote, naming a live process, is such a
    // runtime (or a reused PID, as before this lock): it is not replaced, and this start is refused. A marker any owner of this database wrote
    // is never a reason, whatever crashed since. An unreadable marker is replaced.
    if (existing && !recorded && Number.isInteger(existing.pid) && existing.pid > 0 && alive(existing.pid)) throw new Error(OWNED);
    testFault('after-ownership');
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(owner), { flag: 'wx' });
    try { await retryingSharing(() => renameSync(temporary, filename)); } catch (error) { try { unlinkSync(temporary); } catch { /* Already gone. */ } throw error; }
    testFault('after-marker');
  } catch (error) { held.delete(db); db.close(); throw error; }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      // The marker is removed only while it is still this owner's; an unreadable one is left alone. A marker that cannot be removed is
      // reported and left: it is not authoritative, and the lock is released regardless (last).
      if (readMarker(filename)?.id === owner.id) await retryingSharing(() => { try { unlinkSync(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; } });
    } catch (error) {
      process.stderr.write(`The runtime marker ${filename} was left in place: ${error.message}\n`);
    } finally { held.delete(db); db.close(); }
  };
}
