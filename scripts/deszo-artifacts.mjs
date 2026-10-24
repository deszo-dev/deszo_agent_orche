import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATION_FILES } from '../runtime/core/migrations.mjs';
import { checkTransport } from './deszo-transport.mjs';

export const PROJECT = fileURLToPath(new URL('../', import.meta.url));
export const hash = value => createHash('sha256').update(value).digest('hex');
export const json = path => JSON.parse(readFileSync(path, 'utf8'));
export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n'); renameSync(temporary, path);
}
export function migrationCatalog(directory = join(PROJECT, 'docs/storage')) {
  return MIGRATION_FILES.map((file, index) => {
    const bytes = readFileSync(join(directory, file)), lf = bytes.toString('utf8').replaceAll('\r\n', '\n');
    return { version: index + 1, file, sha256: hash(bytes), lfSha256: hash(lf), crlfSha256: hash(lf.replaceAll('\n', '\r\n')) };
  });
}
export function profileCompatibility(profile, migrations) {
  const path = join(resolve(profile), 'store/state.sqlite');
  if (!existsSync(path)) return { state: 'new_profile', version: 0, supportedVersion: migrations.length, issues: [] };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const applied = db.prepare('SELECT version, sha256 FROM schema_migrations ORDER BY version').all();
    const version = applied.at(-1)?.version ?? 0, issues = [], lineEndingDifferences = [];
    if (version > migrations.length) issues.push({ code: 'store_schema_too_new', version, supportedVersion: migrations.length });
    for (const [index, row] of applied.entries()) {
      if (row.version !== index + 1) issues.push({ code: 'migration_history_gap', version: row.version });
      const expected = migrations.find(item => item.version === row.version);
      if (!expected) continue;
      if (![expected.sha256, expected.lfSha256, expected.crlfSha256].includes(row.sha256)) issues.push({ code: 'migration_history_diverged', version: row.version });
      else if (expected.sha256 !== row.sha256) lineEndingDifferences.push(row.version);
    }
    return { state: issues.length ? 'incompatible' : version < migrations.length ? 'upgrade_required' : 'compatible',
      version, supportedVersion: migrations.length, lineEndingDifferences, issues };
  } finally { db.close(); }
}
function sourcePaths() {
  return [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: PROJECT, encoding: 'utf8', windowsHide: true, timeout: 10_000 }).split('\0').filter(Boolean))].sort();
}
function isBuildInput(path, scope) {
  const runtime = /^(?:runtime\/(?!tests\/)|mcp\/(?:bridge|runtime-client|run-observer|supervisor-pipe|managed-invocation)\.mjs$|shared\/|docs\/(?:storage\/m\d+\.sql|schemas\/|authoring\/(?:client-timeouts|controller-transport|mcp-neutralizers)\.json)|scripts\/bundle-runtime\.mjs$)/;
  const desktop = /^(?:src\/|src-tauri\/(?:src\/|Cargo\.(?:toml|lock)$|tauri\.conf\.json$|build\.rs$|capabilities\/)|shared\/|scripts\/build-shim\.mjs$)/;
  const common = /^(?:package(?:-lock)?\.json|tsconfig[^/]*\.json|vite\.config\.[^/]+)$/;
  return common.test(path) || (scope === 'desktop' ? desktop : runtime).test(path);
}
export function inputFingerprint(scope) {
  const entries = sourcePaths().filter(path => isBuildInput(path, scope))
    .map(path => ({ path, sha256: existsSync(join(PROJECT, path)) ? hash(readFileSync(join(PROJECT, path))) : null }));
  return { sha256: hash(JSON.stringify(entries)), entries };
}
export function inputsMatch(scope, recorded) {
  const current = inputFingerprint(scope);
  if (current.sha256 === recorded?.sha256) return true;
  // Older local receipts also captured operator scripts which are not compiled into the app.
  // Compare every actual build input, including additions/deletions, without invalidating binaries for a doctor-only fix.
  return Array.isArray(recorded?.entries) && JSON.stringify(recorded.entries.filter(entry => isBuildInput(entry.path, scope))) === JSON.stringify(current.entries);
}
export function writeRuntimeManifest(directory = join(PROJECT, 'dist-runtime')) {
  const transport = checkTransport();
  const registry = json(join(PROJECT, 'docs/authoring/client-timeouts.json'));
  const codex = registry.entries.find(entry => entry.provider === 'codex');
  if (codex?.status === 'verified' && (!transport.valid || codex.testedVersion !== transport.identity.clientVersion))
    throw new Error('Verified Codex registry does not match the saved transport evidence.');
  const files = Object.fromEntries(readdirSync(directory, { withFileTypes: true }).filter(item => item.isFile() && item.name !== 'runtime-manifest.json')
    .map(item => [item.name, hash(readFileSync(join(directory, item.name)))]));
  const manifest = { kind: 'DeszoRuntimeBuild', version: 1, builtAt: new Date().toISOString(),
    sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT, encoding: 'utf8', windowsHide: true }).trim(),
    runtimeInputs: inputFingerprint('runtime'), migrations: migrationCatalog(directory), files,
    controllerTransport: transport.valid ? { fingerprint: transport.fingerprint, clientVersion: transport.identity.clientVersion } : null,
    assurance: 'Local build metadata; not ADR-0006 trusted build attestation or authority.' };
  writeJson(join(directory, 'runtime-manifest.json'), manifest); return manifest;
}
export function inspectRuntimeBuild(directory) {
  const manifest = json(join(directory, 'runtime-manifest.json')), issues = [];
  if (manifest.kind !== 'DeszoRuntimeBuild' || manifest.version !== 1) throw new Error('Unsupported runtime build manifest.');
  const actual = readdirSync(directory, { withFileTypes: true }).filter(item => item.name !== 'runtime-manifest.json');
  if (actual.some(item => !item.isFile()) || actual.map(item => item.name).sort().join('\0') !== Object.keys(manifest.files).sort().join('\0'))
    issues.push({ code: 'runtime_inventory_changed' });
  for (const [file, expected] of Object.entries(manifest.files)) {
    if (file.includes('/') || file.includes('\\') || file === '..') { issues.push({ code: 'invalid_manifest_path' }); continue; }
    if (!existsSync(join(directory, file)) || hash(readFileSync(join(directory, file))) !== expected) issues.push({ code: 'artifact_changed', file });
  }
  const actualCatalog = migrationCatalog(directory);
  if (JSON.stringify(manifest.migrations) !== JSON.stringify(actualCatalog)) issues.push({ code: 'migration_manifest_changed' });
  return { manifest, issues };
}
export function inspectProfileBindings(profile, { workflowId, workspaceId, workspaceDirectory } = {}) {
  const db = new DatabaseSync(join(resolve(profile), 'store/state.sqlite'), { readOnly: true });
  try {
    const workspace = workspaceId ? db.prepare('SELECT id, cwd, cwd_identity FROM workspaces WHERE id = ?').get(workspaceId) ?? null : null;
    const workflow = workflowId ? db.prepare('SELECT w.id,w.revision,a.sha256 AS snapshotSha256 FROM workflows w JOIN artifacts a ON a.id = w.snapshot_artifact_id WHERE w.id = ?').get(workflowId) ?? null : null;
    const activeRuns = db.prepare("SELECT id,state,workflow_id FROM runs WHERE state IN ('queued','running','draining','waiting_for_user','stopping')").all();
    const issues = [];
    if (workspaceId && !workspace) issues.push({ code: 'workspace_missing', workspaceId });
    if (workspaceDirectory && workspace && resolve(workspace.cwd).toLowerCase() !== resolve(workspaceDirectory).toLowerCase()) issues.push({ code: 'workspace_binding_mismatch', workspaceId });
    if (workflowId && !workflow) issues.push({ code: 'workflow_missing', workflowId });
    return { workspace, workflow, activeRuns, issues, note: 'Read-only inventory; approvals and runtime authority must be verified through MCP.' };
  } finally { db.close(); }
}
