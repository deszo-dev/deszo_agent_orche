// P6-G0 maintenance preflight (ADR-0010 section 8). It runs in a candidate Engine before any ordinary startup: it opens only
// the Host's disposable copy, read-only, checks the migration history and the copy's integrity, and reports the exact facts to
// the Host. Then it waits, in this same process, for the Host's commit decision. It never opens the production Store and never
// starts a Run, a provider, a recovery or the HTTP API.
// This module imports nothing from runtime/core (see p6Switch.mjs): the migration catalogue is passed in by the runner.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// The product's own migration-history rule (scripts/deszo-artifacts.mjs profileCompatibility): a recorded digest may be the
// raw, LF or CRLF form of the migration file.
function expectedMigrations({ files, paths }) {
  return files.map((file, index) => {
    const bytes = readFileSync(paths[index]);
    const lf = bytes.toString('utf8').replaceAll('\r\n', '\n');
    return { version: index + 1, file, accepted: [sha256(bytes), sha256(lf), sha256(lf.replaceAll('\n', '\r\n'))] };
  });
}

/** `migrations` is the installed catalogue: `{ files, paths }` from the Engine's own migration module. */
export async function runP6MaintenancePreflight({ bridge, operationId, preflightStore, migrations, pollMs = 100 }) {
  if (!bridge) throw new Error('The maintenance preflight requires its Lifecycle Host bootstrap.');
  if (!migrations?.files?.length || migrations.files.length !== migrations.paths?.length) throw new Error('The installed migration catalogue is unavailable.');
  if (!operationId || !preflightStore || !existsSync(preflightStore)) throw new Error('The disposable Store copy is unavailable.');
  // The copy's bytes are hashed before SQLite opens them, so the Host can match the exact file it made.
  const copySha256 = sha256(readFileSync(preflightStore));
  const expected = expectedMigrations(migrations);
  const db = new DatabaseSync(preflightStore, { readOnly: true });
  let applied;
  let quickCheck;
  try {
    applied = db.prepare('SELECT version, sha256 FROM schema_migrations ORDER BY version').all();
    quickCheck = db.prepare('PRAGMA quick_check').get().quick_check;
  } finally {
    db.close();
  }
  if (quickCheck !== 'ok') throw new Error(`The disposable Store copy failed its integrity check: ${quickCheck}`);
  if (applied.length !== expected.length) throw new Error('The disposable Store copy does not hold the installed migration catalog.');
  for (const [index, row] of applied.entries()) {
    const known = expected[index];
    if (row.version !== known.version || !known.accepted.includes(row.sha256)) {
      throw new Error(`The disposable Store copy's migration history diverges at version ${row.version}.`);
    }
  }
  const { pid, context } = { pid: process.pid, context: bridge.context };
  await bridge.p6Call('engine.maintenance_ready', { operationId, pid, applicationPid: context.applicationPid,
    engineBuildId: context.buildId, shellBuildId: context.shellBuildId, generation: context.generation, copySha256,
    storeSchemaVersion: applied.at(-1)?.version ?? 0, migrationCount: applied.length, quickCheck });
  // The one decision the candidate may act on. Anything but `commit` ends this process before it can open the Store.
  for (;;) {
    const { decision } = await bridge.p6Call('engine.maintenance_wait', { operationId });
    if (decision === 'commit') return { copySha256, storeSchemaVersion: applied.at(-1)?.version ?? 0 };
    if (decision !== 'pending') throw new Error('The Lifecycle Host ended the maintenance preflight without a commit.');
    await sleep(pollMs);
  }
}
