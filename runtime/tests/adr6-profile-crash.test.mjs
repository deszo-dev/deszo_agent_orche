// ADR-0006 data-preserving recovery under a real hot-WAL crash. A writer process commits transactions into a WAL-mode
// profile store with checkpointing disabled, opens one more transaction and is killed with SIGKILL before it commits.
// The restore path (ProfileRecovery.fork, the same code the host runs) must produce a copy with exactly the committed
// rows, leave the source bytes unchanged, replay idempotently, and refuse a source that is not proven quiescent.
// Fixture scope: the kill is a real process death against real SQLite WAL files; native quiescence is injected, because the
// installed native proof is a separate verification. The original profile is never opened for writing by this test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ControlHost } from '../host/authority.mjs';
import { manualTimeSource } from '../host/timeSource.mjs';
import { ProfileRecovery } from '../host/profileRecovery.mjs';

const WRITER = `import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]);
db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE IF NOT EXISTS records (id INTEGER PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, sha256 TEXT NOT NULL);');
db.prepare('INSERT OR IGNORE INTO schema_migrations (version, sha256) VALUES (?, ?)').run(1, 'fixture-migration-1');
for (let txn = 1; txn <= 5; txn++) {
  db.exec('BEGIN IMMEDIATE');
  for (let i = 0; i < 10; i++) db.prepare('INSERT INTO records (body) VALUES (?)').run('committed-' + txn + '-' + i);
  db.exec('COMMIT');
  console.log('committed ' + txn);
}
db.exec('BEGIN IMMEDIATE');
for (let i = 0; i < 10; i++) db.prepare('INSERT INTO records (body) VALUES (?)').run('in-flight-' + i);
console.log('open');
setInterval(() => {}, 1000);
`;

const digestTree = root => {
  const out = {};
  const walk = dir => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const full = join(dir, entry.name); if (entry.isDirectory()) walk(full); else out[relative(root, full).split('\\').join('/')] = createHash('sha256').update(readFileSync(full)).digest('hex'); } };
  walk(root);
  return out;
};

// Starts the writer, waits until its uncommitted transaction is open, and kills it.
async function crashWriterMidTransaction(dir, dbPath) {
  writeFileSync(join(dir, 'writer.mjs'), WRITER);
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(dir, 'writer.mjs'), dbPath], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  const deadline = Date.now() + 20000;
  while (!output.includes('open') && Date.now() < deadline) await new Promise(done => setTimeout(done, 25));
  assert.ok(output.includes('open'), `the writer reached its open transaction: ${output}`);
  const exited = new Promise(done => child.once('exit', done));
  child.kill('SIGKILL');
  await exited;
  return output.split('\n').filter(line => line.startsWith('committed')).length;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'deszo-profile-crash-'));
  const profiles = join(root, 'profiles');
  const source = join(profiles, 'source');
  mkdirSync(join(source, 'store'), { recursive: true });
  mkdirSync(join(source, 'store', 'objects'), { recursive: true });
  writeFileSync(join(source, 'store', 'objects', 'artifact.txt'), 'artifact written before the crash');
  const host = new ControlHost({ root: join(root, 'host'), time: manualTimeSource() });
  host.run(`INSERT INTO data_profiles(profile_id, profile_path, compatible_schema_min, compatible_schema_max, registration_json, registered_at) VALUES (?, ?, 1, 1, '{}', ?)`,
    'source', source, new Date().toISOString());
  return { root, profiles, source, host };
}

test('ADR6-12 hot WAL: a SIGKILL during an open transaction restores exactly the committed rows and leaves the source untouched', async () => {
  const ctx = fixture();
  try {
    const dbPath = join(ctx.source, 'store', 'state.sqlite');
    const committed = await crashWriterMidTransaction(ctx.source, dbPath);
    assert.equal(committed, 5, 'Five transactions committed before the crash.');
    const walPath = `${dbPath}-wal`;
    assert.ok(existsSync(walPath) && statSync(walPath).size > 0, 'The store is hot: committed frames remain in the WAL.');
    const before = digestTree(ctx.source);

    const recovery = new ProfileRecovery({ host: ctx.host, allowedRoot: ctx.profiles, isQuiescent: async () => true });
    const destination = join(ctx.profiles, 'restored');
    const restored = await recovery.fork({ restoreId: randomUUID(), sourceProfileId: 'source', destinationProfileId: 'restored', destinationPath: destination });
    assert.equal(restored.state, 'verified');
    assert.equal(restored.sourcePreserved, true);
    assert.equal(restored.newConsentRequired, true, 'A restored profile never inherits host authority.');

    const copy = new DatabaseSync(join(destination, 'store', 'state.sqlite'), { readOnly: true });
    try {
      assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM records').get().n, 50, 'Exactly the five committed transactions are restored.');
      assert.equal(copy.prepare(`SELECT COUNT(*) AS n FROM records WHERE body LIKE 'in-flight-%'`).get().n, 0, 'The uncommitted transaction is absent.');
    } finally { copy.close(); }
    assert.equal(readFileSync(join(destination, 'store', 'objects', 'artifact.txt'), 'utf8'), 'artifact written before the crash', 'Objects are copied.');
    // The -shm wal-index is volatile: SQLite rewrites it on every open, even read-only, and it is rebuilt from the WAL. Its
    // content is not user data, so it is excluded here. The database, the WAL and every object must be byte-identical.
    const dataOnly = digest => Object.fromEntries(Object.entries(digest).filter(([path]) => !path.endsWith('state.sqlite-shm')));
    assert.deepEqual(dataOnly(digestTree(ctx.source)), dataOnly(before), 'The original profile data, WAL and objects are unchanged.');

    const replay = await recovery.fork({ restoreId: restored.restoreId, sourceProfileId: 'source', destinationProfileId: 'restored', destinationPath: destination });
    assert.equal(replay.replayed, true, 'A replay returns the original receipt without a second copy.');
  } finally { ctx.host.close(); }
});

test('ADR6-12 hot WAL: a source that is not proven quiescent is refused before any copy is made', async () => {
  const ctx = fixture();
  try {
    await crashWriterMidTransaction(ctx.source, join(ctx.source, 'store', 'state.sqlite'));
    const recovery = new ProfileRecovery({ host: ctx.host, allowedRoot: ctx.profiles, isQuiescent: async () => false });
    await assert.rejects(recovery.fork({ restoreId: randomUUID(), sourceProfileId: 'source', destinationProfileId: 'refused', destinationPath: join(ctx.profiles, 'refused') }),
      /Native proof of a stopped profile is required/);
    assert.equal(existsSync(join(ctx.profiles, 'refused')), false, 'No destination was created.');
  } finally { ctx.host.close(); }
});
