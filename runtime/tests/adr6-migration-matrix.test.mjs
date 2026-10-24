// ADR-0006 migration compatibility matrix for compatible rollback. Real SQLite profile stores are created with a real
// schema_migrations history; verifyCompatibleRollback (the function the host runs before any rollback launch) must accept
// exactly the stores that the rollback executable understands, and refuse every other pair. Fixture scope: this tests the
// compatibility decision over real store files. It does not launch an executable or prove that a migration's SQL is correct.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeCompatibility, verifyCompatibleRollback } from '../host/profileRecovery.mjs';

const CHAIN = ['digest-migration-1', 'digest-migration-2', 'digest-migration-3', 'digest-migration-4', 'digest-migration-5'];

// A profile whose store carries the given migration history. An empty array means a profile with no store file yet.
function profileWith(history, rows = history.map((sha, index) => [index + 1, sha])) {
  const root = mkdtempSync(join(tmpdir(), 'deszo-migration-matrix-'));
  const profile = join(root, 'profile');
  mkdirSync(join(profile, 'store'), { recursive: true });
  if (history.length === 0 && rows.length === 0) return profile;
  const db = new DatabaseSync(join(profile, 'store', 'state.sqlite'));
  try {
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, sha256 TEXT NOT NULL)');
    for (const [version, sha] of rows) db.prepare('INSERT INTO schema_migrations (version, sha256) VALUES (?, ?)').run(version, sha);
  } finally { db.close(); }
  return profile;
}

test('ADR6 migration matrix: a store is accepted exactly when the rollback executable supports its whole history', () => {
  for (let storeVersion = 0; storeVersion <= 5; storeVersion++) {
    for (let supported = 0; supported <= 6; supported++) {
      const history = CHAIN.slice(0, storeVersion), profile = profileWith(history);
      const executable = CHAIN.slice(0, supported);
      const expected = storeVersion <= supported;
      const label = `store ${storeVersion} with executable ${supported}`;
      if (expected) {
        const decision = verifyCompatibleRollback({ profilePath: profile, supportedMigrations: executable });
        assert.equal(decision.compatible, true, label);
        assert.equal(decision.storeSchemaVersion, storeVersion, label);
        assert.equal(decision.preservedNewerWrites, true, label);
      } else {
        assert.throws(() => verifyCompatibleRollback({ profilePath: profile, supportedMigrations: executable }), /does not understand the current store history/, label);
      }
    }
  }
});

test('ADR6 migration matrix: a changed migration digest, a gap in history, or a missing executable list is refused', () => {
  const profile = profileWith(CHAIN.slice(0, 3));
  const altered = [...CHAIN.slice(0, 3)];
  altered[1] = 'digest-of-a-different-migration';
  assert.throws(() => verifyCompatibleRollback({ profilePath: profile, supportedMigrations: altered }), /does not understand/);
  assert.throws(() => verifyCompatibleRollback({ profilePath: profile, supportedMigrations: undefined }), /does not understand/);
  const gapped = profileWith(CHAIN.slice(0, 2), [[1, CHAIN[0]], [3, CHAIN[1]]]);
  assert.throws(() => verifyCompatibleRollback({ profilePath: gapped, supportedMigrations: CHAIN }), /does not understand/, 'A version gap is refused.');
});

test('ADR6 migration matrix: a profile with no store yet is compatible with any executable, and reports version zero', () => {
  const profile = profileWith([]);
  assert.equal(existsSync(join(profile, 'store', 'state.sqlite')), false);
  assert.deepEqual(storeCompatibility(profile), { schemaVersion: 0, migrations: [], empty: true });
  assert.equal(verifyCompatibleRollback({ profilePath: profile, supportedMigrations: [] }).compatible, true);
});
