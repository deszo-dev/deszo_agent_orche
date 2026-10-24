// Compatible executable rollback keeps the current store. A data restore always creates a new profile;
// no live profile, newer write, consent record, revocation or host ledger is overwritten.
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, constants } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalHash, canonicalize, sha256 } from '../core/canonical.mjs';
import { HostError } from './authority.mjs';

const fail = message => { throw new HostError(409, 'incompatible_restore', message); };
export function safeProfilePath(allowedRoot, path, { existing = true } = {}) {
  const root = resolve(allowedRoot), full = resolve(path), rel = relative(root, full);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) fail('The profile must be a distinct child of its registered root.');
  let current = root;
  for (const part of rel.split(sep)) {
    // Resolve the opened directory handle on Windows. The JavaScript fallback lstats every ancestor (including
    // the user's private AppData), although the service is granted access only to its dedicated profile root.
    // Final canonical-path equality still rejects junctions in any ancestor; no parent ACL is broadened.
    if (existsSync(current) && (lstatSync(current).isSymbolicLink() || resolve(realpathSync.native(current)).toLowerCase() !== current.toLowerCase())) fail('Profile paths cannot use reparse points.');
    current = join(current, part);
  }
  if ((existing && !existsSync(full)) || (existsSync(full) && (lstatSync(full).isSymbolicLink() || !statSync(full).isDirectory()))) fail('The registered profile is not a plain directory.');
  return full;
}
export function storeCompatibility(profilePath) {
  const path = join(profilePath, 'store', 'state.sqlite');
  if (!existsSync(path)) return { schemaVersion: 0, migrations: [], empty: true };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') fail('The current store is corrupt.');
    const migrations = db.prepare('SELECT version,sha256 FROM schema_migrations ORDER BY version').all();
    return { schemaVersion: migrations.at(-1)?.version ?? 0, migrations, empty: false };
  } finally { db.close(); }
}
export function verifyCompatibleRollback({ profilePath, supportedMigrations }) {
  const store = storeCompatibility(profilePath);
  if (!Array.isArray(supportedMigrations) || store.schemaVersion > supportedMigrations.length || store.migrations.some((m, i) => m.version !== i + 1 || m.sha256 !== supportedMigrations[i])) fail('The rollback executable does not understand the current store history. A separate verified profile is required.');
  return { compatible: true, strategy: 'keep-current-data', storeSchemaVersion: store.schemaVersion, preservedNewerWrites: true, profilePath: resolve(profilePath) };
}
function contentFiles(root) {
  const files = [];
  function walk(dir) { for (const item of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, item.name); if (item.isSymbolicLink()) fail('Profile contents contain a reparse point.'); if (item.isDirectory()) walk(path); else if (item.isFile()) files.push(path); else fail('Unsupported profile object.'); } }
  for (const part of ['store', 'workdirs']) if (existsSync(join(root, part))) walk(join(root, part));
  return files.sort().filter(path => !/state\.sqlite-(wal|shm)$/.test(path));
}
const inventory = root => contentFiles(root).map(path => ({ path: relative(root, path).split(sep).join('/'), sha256: sha256(readFileSync(path)), bytes: statSync(path).size }));
const quoteIdentifier = name => `"${name.replaceAll('"','""')}"`;
export function logicalStoreDigest(profilePath) {
  const path = join(profilePath, 'store', 'state.sqlite'); if (!existsSync(path)) return canonicalHash({ empty: true });
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('BEGIN');
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_autoindex%' ORDER BY type,name").all();
    const tables = schema.filter(s => s.type === 'table').map(table => {
      const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(table.name)})`).all().map(c => c.name);
      const rows = [];
      for (const row of db.prepare(`SELECT ${columns.map(c => `quote(${quoteIdentifier(c)}) AS ${quoteIdentifier(c)}`).join(',')} FROM ${quoteIdentifier(table.name)}`).iterate()) rows.push(canonicalHash(row));
      return { name: table.name, rows: rows.sort() };
    });
    const digest = canonicalHash({ schema, tables }); db.exec('COMMIT'); return digest;
  } finally { db.close(); }
}
function sourceStamp(root) {
  const wal = join(root, 'store', 'state.sqlite-wal');
  // Opening a read-only connection to a closed WAL-mode store can itself create empty WAL/SHM sidecars. They
  // contain no committed writes. Treat an absent and a zero-byte WAL alike; retain hashes for every nonempty WAL
  // and the independent logical digest so an actual concurrent write still refuses the restore.
  return { files: inventory(root), walSha256: existsSync(wal)&&statSync(wal).size>0 ? sha256(readFileSync(wal)) : null, logicalStoreDigest: logicalStoreDigest(root) };
}

export class ProfileRecovery {
  constructor({ host, allowedRoot, isQuiescent }) { if (typeof isQuiescent !== 'function') throw new Error('Native quiescence verification is required.'); Object.assign(this, { host, allowedRoot: resolve(allowedRoot), isQuiescent }); }
  async fork({ restoreId, sourceProfileId, destinationProfileId, destinationPath }) {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(restoreId) || !/^[a-zA-Z0-9-]{1,100}$/.test(destinationProfileId)) fail('A stable restore and destination identity are required.');
    const source = this.host.get('SELECT * FROM data_profiles WHERE profile_id=?', sourceProfileId); if (!source) fail('The source profile is not registered.');
    const sourcePath = safeProfilePath(this.allowedRoot, source.profile_path), target = safeProfilePath(this.allowedRoot, destinationPath, { existing: false });
    const old = this.host.get('SELECT * FROM profile_restores WHERE restore_id=?', restoreId);
    if (old) {
      const receipt = JSON.parse(old.receipt_json);
      if (old.source_profile_id !== sourceProfileId || old.destination_profile_id !== destinationProfileId || receipt.destinationPath !== target) fail('The restore ID belongs to different inputs.');
      return { ...receipt, state: old.state, replayed: true };
    }
    if (existsSync(target) || this.host.get('SELECT profile_id FROM data_profiles WHERE profile_id=?', destinationProfileId)) fail('An existing destination cannot be overwritten.');
    if (!(await this.isQuiescent(sourcePath))) fail('Native proof of a stopped profile is required.');
    // A consistent SQLite snapshot includes committed WAL writes. Checkpoint is deliberately unnecessary.
    const stamp = sourceStamp(sourcePath), before = stamp.files, sourceDigest = canonicalHash(stamp), store = storeCompatibility(sourcePath);
    const receipt = { restoreId, sourceProfileId, destinationProfileId, destinationPath: target, sourceDigest, sourceSchemaVersion: store.schemaVersion, sourcePreserved: true, newConsentRequired: true };
    this.host.transaction(() => {
      this.host.run("INSERT INTO profile_restores(restore_id,source_profile_id,destination_profile_id,source_digest,state,receipt_json,created_at) VALUES(?,?,?,?,'prepared',?,?)", restoreId, sourceProfileId, destinationProfileId, sourceDigest, canonicalize(receipt), new Date(this.host.time.wallNow()).toISOString());
      this.host.audit('profile.restore_intent', receipt);
    });
    try {
      mkdirSync(target); mkdirSync(join(target, 'store'), { recursive: true });
      for (const file of before) {
        if (file.path === 'store/state.sqlite') continue;
        const destination = join(target, file.path); mkdirSync(resolve(destination, '..'), { recursive: true });
        copyFileSync(join(sourcePath, file.path), destination, constants.COPYFILE_EXCL);
        if (sha256(readFileSync(destination)) !== file.sha256) fail('A copied object changed during restore.');
      }
      if (!store.empty) {
        const db = new DatabaseSync(join(sourcePath, 'store', 'state.sqlite'), { readOnly: true });
        try { db.exec(`VACUUM INTO '${join(target, 'store', 'state.sqlite').replaceAll("'", "''")}'`); } finally { db.close(); }
      }
      if (!(await this.isQuiescent(sourcePath)) || canonicalHash(sourceStamp(sourcePath)) !== sourceDigest || logicalStoreDigest(target) !== stamp.logicalStoreDigest || canonicalHash(storeCompatibility(target)) !== canonicalHash(store)) fail('The source changed or the destination store differs.');
      const destinationDigest = canonicalHash(inventory(target)), complete = { ...receipt, destinationDigest, verification: { complete: true, strategy: 'fork-current-profile' } };
      this.host.transaction(() => {
        this.host.run("UPDATE profile_restores SET state='verified',destination_digest=?,receipt_json=? WHERE restore_id=?", destinationDigest, canonicalize(complete), restoreId);
        this.host.run('INSERT INTO data_profiles(profile_id,profile_path,compatible_schema_min,compatible_schema_max,registration_json,registered_at) VALUES(?,?,?,?,?,?)', destinationProfileId, target, store.schemaVersion, store.schemaVersion, canonicalize({ restoreId, newConsentRequired: true }), new Date(this.host.time.wallNow()).toISOString());
        this.host.audit('profile.restore_verified', complete);
      });
      return { ...complete, state: 'verified', replayed: false };
    } catch (error) {
      this.host.run("UPDATE profile_restores SET state='reconciling',receipt_json=? WHERE restore_id=?", canonicalize({ ...receipt, error: error.message, partialDestinationRetained: true }), restoreId);
      throw error;
    }
  }
}
