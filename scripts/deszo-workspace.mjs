import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalHash } from '../runtime/core/canonical.mjs';
import { hash, json, writeJson, inspectProfileBindings } from './deszo-artifacts.mjs';

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
function pathIn(root, name) {
  if (typeof name !== 'string' || isAbsolute(name) || name.includes('\\') || name.includes(':') ||
    name.split('/').some(part => !part || part === '.' || part === '..' || /^\.git[ .]*$/i.test(part))) throw new Error('Invalid captured path.');
  const path = resolve(root, name);
  if (relative(root, path).startsWith('..')) throw new Error('Captured path escapes the workspace.');
  for (let parent = path; parent !== root; parent = dirname(parent)) if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw new Error('A captured path crosses a link.');
  return path;
}
export function planWorkspaceSync({ from, to, manifestPath }) {
  from = realpathSync(from); to = realpathSync(to);
  if (from.toLowerCase() === to.toLowerCase()) throw new Error('Source and captured workspace must be distinct.');
  const previous = json(manifestPath);
  if (!['FixerSourceManifest', 'DeszoSourceManifest'].includes(previous.kind)) throw new Error('Workspace ownership manifest is missing.');
  const head = git(from, 'rev-parse', 'HEAD').trim();
  if (head !== previous.head || git(to, 'rev-parse', 'HEAD').trim() !== previous.head) throw new Error('Git bases changed; reconcile explicitly without resetting local work.');
  for (const entry of [...previous.entries, ...(previous.extraInputs ?? [])])
    if (!existsSync(pathIn(to, entry.path)) || hash(readFileSync(pathIn(to, entry.path))) !== entry.sha256) throw new Error(`Preserve workspace edit: ${entry.path}`);
  const inventory = root => [...new Set(git(root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean))].sort();
  const owned = new Set(previous.entries.map(entry => entry.path));
  if (inventory(to).some(path => !owned.has(path))) throw new Error('Preserve unexpected workspace files.');
  const paths = inventory(from);
  if (previous.entries.some(entry => !paths.includes(entry.path)) || paths.some(path => !existsSync(pathIn(from, path)))) throw new Error('Source deletions require explicit reconciliation.');
  const captured = paths.map(path => { const bytes = readFileSync(pathIn(from, path)); return { path, sha256: hash(bytes), bytes: bytes.length, content: bytes }; });
  for (const entry of captured) if (hash(readFileSync(pathIn(from, entry.path))) !== entry.sha256) throw new Error('Source changed during capture.');
  const entries = captured.map(({ content, ...entry }) => entry), sourceContentSha256 = canonicalHash(entries);
  const changes = captured.filter(entry => !existsSync(pathIn(to, entry.path)) || hash(readFileSync(pathIn(to, entry.path))) !== entry.sha256).map(entry => entry.path);
  return { from, to, manifestPath: resolve(manifestPath), previous, captured, entries, changes, head, sourceContentSha256 };
}
export function syncWorkspace(input) {
  const plan = planWorkspaceSync(input);
  if (!input.sync) return { checked: true, sourceContentSha256: plan.sourceContentSha256, changes: plan.changes, written: false };
  if (!input.profile || !input.workspaceId) throw new Error('--profile and --workspace are required for synchronization.');
  const bindings = inspectProfileBindings(input.profile, { workspaceId: input.workspaceId, workspaceDirectory: plan.to });
  if (bindings.issues.length || bindings.activeRuns.length) throw new Error('Reconcile workspace binding and unfinished runs through MCP before synchronization.');
  if (!plan.changes.length) return { synchronized: true, cached: true, sourceContentSha256: plan.sourceContentSha256, changes: [], written: false };
  const snapshot = join(plan.from, '.deszo/operator/source-snapshots', plan.sourceContentSha256);
  for (const entry of plan.captured) {
    const frozen = pathIn(snapshot, entry.path); mkdirSync(dirname(frozen), { recursive: true });
    if (existsSync(frozen) && hash(readFileSync(frozen)) !== entry.sha256) throw new Error('Preserve an unexpected snapshot file.');
    if (!existsSync(frozen)) writeFileSync(frozen, entry.content);
  }
  for (const entry of plan.captured) {
    if (!plan.changes.includes(entry.path)) continue;
    const target = pathIn(plan.to, entry.path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, entry.content);
  }
  const manifest = { ...plan.previous, kind: 'DeszoSourceManifest', head: plan.head, sourceContentSha256: plan.sourceContentSha256,
    entries: plan.entries, previousSourceContentSha256: plan.previous.sourceContentSha256, snapshot };
  writeJson(plan.manifestPath, manifest); writeJson(join(snapshot, 'manifest.json'), manifest);
  return { synchronized: true, sourceContentSha256: plan.sourceContentSha256, changes: plan.changes, snapshot, written: true };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = name => { const index = process.argv.indexOf(`--${name}`); return index < 0 ? undefined : process.argv[index + 1]; };
  try { console.log(JSON.stringify(syncWorkspace({ from: option('from'), to: option('to'), manifestPath: option('manifest'),
    profile: option('profile'), workspaceId: option('workspace'), sync: process.argv.includes('--sync') }))); }
  catch (error) { console.error(JSON.stringify({ error: error.message, requiresInspection: process.argv.includes('--sync') })); process.exitCode = 1; }
}
