import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalBytes, canonicalHash, compareText, parseStrictJson, sha256 } from './canonical.mjs';
import { assertValid } from './schemas.mjs';
import { workspaceRootsOverlap } from './workspaceIsolation.mjs';
import { ProtectedSelfRepairError, inventoryP5Source, inventoryP5SourceWithHost, p5SourceDigest,
  runP5GitCommand, runP5GitCommandAsync, validateP5Contract, validateP5SourcePath, verifyP5GitAttributes, verifyP5GitToolIdentity } from './protectedSelfRepair.mjs';
import { assertP5HostBoundary, deriveP5HostProtection, readP5HostProtection } from './p5HostBoundary.mjs';

// sanitized-seed-v1 (§24) remains readable for historical candidates; managed-clone-v1 (§25) is the target policy.
export const P5_GIT_SEED_POLICY = 'sanitized-seed-v1';
export const P5_GIT_CLONE_POLICY = 'managed-clone-v1';
export const P5_GIT_POLICIES = Object.freeze([P5_GIT_SEED_POLICY, P5_GIT_CLONE_POLICY]);
const isClone = value => value === P5_GIT_CLONE_POLICY;
const ENGINE_AUTHOR = 'Deszo P5 Engine';
const ENGINE_EMAIL = 'deszo-p5-engine@invalid';
const EMPTY_TEMPLATE = 'git-template-empty';
const WINDOWS = process.platform === 'win32';
const REF_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SHA256 = /^[a-f0-9]{64}$/;
const asRef = value => ({ artifactId: value.artifactId, sha256: value.sha256 });
const fail = (code, message) => { throw new ProtectedSelfRepairError(code, message); };
const pathKey = value => WINDOWS ? resolve(value).replaceAll('/', '\\').toLowerCase() : resolve(value);

function gitBytes(gitTool, root, args, options = {}) {
  return runP5GitCommand(gitTool, root, args, options);
}

function gitText(gitTool, root, args) {
  return gitBytes(gitTool, root, args).toString('utf8').replace(/[\r\n]+$/, '');
}

function gitHash(gitTool, root, args) {
  const value = gitText(gitTool, root, args);
  if (!REF_SHA.test(value)) fail('p5_git_object_invalid', `Pinned Git returned a malformed object ID for ${args[0]}.`);
  return value;
}

function assertPlainDirectory(path, code = 'p5_git_repository_unsafe') {
  let info;
  try { info = lstatSync(path, { bigint: true }); }
  catch { fail(code, `The P5 Git directory is unavailable: "${path}".`); }
  if (!info.isDirectory() || info.isSymbolicLink()) fail(code, `The P5 Git path is not a plain directory: "${path}".`);
  let canonical;
  try { canonical = realpathSync.native(path); }
  catch { fail(code, `The P5 Git directory cannot be resolved: "${path}".`); }
  if (pathKey(canonical) !== pathKey(path)) fail(code, `The P5 Git directory is redirected: "${path}".`);
  return { info, canonical };
}

function inside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function assertNoOverlap(workspaceRoot, roots) {
  for (const root of roots.filter(value => typeof value === 'string' && value)) {
    if (!isAbsolute(root)) fail('p5_git_workspace_invalid', 'Protected P5 roots must be absolute paths.');
    if (workspaceRootsOverlap(resolve(workspaceRoot), resolve(root)))
      fail('p5_git_workspace_overlap', `The P5 candidate workspace overlaps a protected source, Store or installation root: "${root}".`);
  }
}

function branchForLink(linkId, gitTool, root) {
  if (typeof linkId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(linkId))
    fail('p5_git_link_invalid', 'P5 Git branch identity requires the durable P2 Repair link UUID.');
  const branch = `self-repair/${linkId.replaceAll('-', '').toLowerCase().slice(0, 12)}`;
  if (gitText(gitTool, root, ['check-ref-format', '--branch', branch]) !== branch)
    fail('p5_git_branch_invalid', 'The deterministic P5 Repair branch name is not a valid Git ref.');
  return branch;
}

function sourceEntries(sourceManifest) {
  validateP5Contract('sourceManifest', sourceManifest);
  const entries = sourceManifest.entries.map(({ artifact: _artifact, ...entry }) => entry);
  if (p5SourceDigest(entries) !== sourceManifest.sourceDigest
    || canonicalHash(entries) !== canonicalHash([...entries].sort((a, b) => compareText(a.path, b.path))))
    fail('p5_git_source_manifest_invalid', 'The sealed P5 source manifest has an invalid digest or ordering.');
  return entries;
}

function verifyStoredSource(store, sourceManifest) {
  const entries = sourceEntries(sourceManifest);
  const bytesByPath = new Map();
  for (const entry of sourceManifest.entries) {
    validateP5SourcePath(entry.path);
    store.verifyRef(entry.artifact);
    const bytes = store.readBytes(entry.artifact.artifactId).bytes;
    if (bytes.length !== entry.byteSize || sha256(bytes) !== entry.sha256 || entry.artifact.sha256 !== entry.sha256)
      fail('p5_git_source_object_mismatch', `The sealed P5 source object for "${entry.path}" does not match its manifest.`);
    bytesByPath.set(entry.path, bytes);
  }
  return { entries, bytesByPath };
}

function assertSourceTree(root, expectedEntries, budgets, nativeSourceReader, identityReader = null) {
  const modes = new Map(expectedEntries.map(entry => [entry.path, entry.executable]));
  const options = { maxFiles: budgets.maxSourceFiles, maxBytes: budgets.maxSourceBytes,
    include: ['**'], exclude: ['.git/**'], identityReader, executableFor: path => modes.get(path) ?? false };
  return (async () => {
    const inventory = nativeSourceReader
      ? await inventoryP5SourceWithHost(root, { ...options, nativeSourceReader })
      : inventoryP5Source(root, options);
    if (canonicalHash(inventory.entries) !== canonicalHash(expectedEntries))
      fail('p5_git_source_mismatch', 'The private Git working tree does not contain exactly the sealed P5 source paths, bytes and modes.');
    return inventory;
  })();
}

async function nativeRootIdentity(nativeSourceReader, root) {
  if (WINDOWS && typeof nativeSourceReader !== 'function')
    fail('p5_native_identity_unavailable', 'Windows P5 Git repositories require the authenticated Rust Host native identity reader.');
  if (typeof nativeSourceReader !== 'function') {
    const { info, canonical } = assertPlainDirectory(root);
    return { canonicalRoot: canonical, rootIdentity: { volumeId: String(info.dev), fileId: String(info.ino) },
      snapshotDigest: canonicalHash({ canonical, device: String(info.dev), inode: String(info.ino) }) };
  }
  let result;
  try { result = await nativeSourceReader({ root, include: [], exclude: [], maxFiles: 0, maxBytes: 0 }); }
  catch (error) { fail('p5_native_identity_unavailable', `The Rust Host could not inspect the private Git directory${error?.code ? ` (${error.code})` : ''}.`); }
  if (result?.refused || !result?.rootIdentity || !SHA256.test(result.snapshotDigest || '')
    || typeof result.canonicalRoot !== 'string')
    fail('p5_native_identity_unavailable', `The Rust Host refused or returned incomplete identity for the private Git directory (${result?.code ?? 'invalid'}).`);
  if (pathKey(result.canonicalRoot) !== pathKey(root)) fail('p5_native_identity_mismatch', 'The Rust Host resolved a different private Git directory.');
  return result;
}

async function nativeStorageScan(nativeSourceReader, root) {
  if (WINDOWS && typeof nativeSourceReader !== 'function')
    fail('p5_native_identity_unavailable', 'Windows P5 Git metadata requires the authenticated Rust Host topology scanner.');
  if (typeof nativeSourceReader !== 'function') {
    const inventory = inventoryP5Source(root, { maxFiles: 20_000, maxBytes: 536_870_912, include: ['**'], exclude: [] });
    return { canonicalRoot: inventory.root, rootIdentity: inventory.rootIdentity,
      pathDigest: canonicalHash(inventory.entries.map(entry => entry.path)), contentDigest: inventory.sourceDigest,
      snapshotDigest: canonicalHash({ rootIdentity: inventory.rootIdentity, entries: inventory.entries }),
      fileCount: inventory.entries.length, totalBytes: inventory.totalBytes };
  }
  let result;
  try { result = await nativeSourceReader({ root, include: ['**'], exclude: [], maxFiles: 20_000, maxBytes: 536_870_912 }); }
  catch (error) { fail('p5_native_identity_unavailable', `The Rust Host could not scan private Git metadata${error?.code ? ` (${error.code})` : ''}.`); }
  if (result?.refused || !result?.rootIdentity || !SHA256.test(result.pathDigest || '')
    || !SHA256.test(result.contentDigest || '') || !SHA256.test(result.snapshotDigest || '')
    || !Number.isSafeInteger(result.fileCount) || !Number.isSafeInteger(result.totalBytes)
    || pathKey(result.canonicalRoot || '') !== pathKey(root))
    fail('p5_native_identity_unavailable', `The Rust Host refused or returned incomplete private Git metadata (${result?.code ?? 'invalid'}).`);
  return result;
}

function ensureDirectory(path) {
  try { mkdirSync(path); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  return assertPlainDirectory(path).canonical;
}

function writeExclusive(path, bytes) {
  let fd;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') return false; fail('p5_git_marker_write_failed', `The P5 Git preparation marker could not be created (${error.code || 'error'}).`); }
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) fail('p5_git_marker_write_failed', 'The P5 Git preparation marker write stopped early.');
      offset += written;
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  return true;
}

function gitConfigEntries(gitTool, root) {
  const bytes = gitBytes(gitTool, root, ['config', '--local', '--null', '--list']);
  const values = bytes.toString('utf8').split('\0').filter(Boolean);
  const entries = values.map(field => {
    const split = field.indexOf('\n');
    if (split < 1) fail('p5_git_config_invalid', 'Pinned Git returned malformed local configuration.');
    return [field.slice(0, split).toLowerCase(), field.slice(split + 1)];
  }).sort((a, b) => compareText(`${a[0]}\0${a[1]}`, `${b[0]}\0${b[1]}`));
  if (new Set(entries.map(([key]) => key)).size !== entries.length)
    fail('p5_git_config_unsupported', 'P5 refuses duplicate Git configuration keys.');
  return entries;
}

function validateConfigEntries(entries, objectFormat, { allowMissing = false } = {}) {
  const allowed = new Set(['core.repositoryformatversion', 'core.filemode', 'core.symlinks', 'core.bare', 'core.logallrefupdates',
    'core.ignorecase', 'core.hookspath', 'user.name', 'user.email', 'commit.gpgsign', 'extensions.objectformat']);
  const expected = new Map([
    ['core.bare', 'false'], ['core.logallrefupdates', 'true'], ['core.hookspath', 'NUL'],
    ['user.name', ENGINE_AUTHOR], ['user.email', ENGINE_EMAIL], ['commit.gpgsign', 'false'],
  ]);
  for (const [key, value] of entries) {
    if (!allowed.has(key)) fail('p5_git_config_unsupported', `P5 refuses unapproved repository configuration "${key}".`);
    if (expected.has(key) && expected.get(key) !== value)
      fail('p5_git_config_unsupported', `P5 refuses modified repository configuration "${key}".`);
    if (key === 'core.filemode' && !['true', 'false'].includes(value)) fail('p5_git_config_unsupported', 'P5 refuses an invalid core.filemode setting.');
    if (key === 'core.symlinks' && !['true', 'false'].includes(value)) fail('p5_git_config_unsupported', 'P5 refuses an invalid core.symlinks setting.');
    if (key === 'core.ignorecase' && !['true', 'false'].includes(value)) fail('p5_git_config_unsupported', 'P5 refuses an invalid core.ignorecase setting.');
    if (key === 'core.repositoryformatversion' && value !== (objectFormat === 'sha256' ? '1' : '0'))
      fail('p5_git_config_unsupported', 'P5 repository config does not match its Git object format.');
    if (key === 'extensions.objectformat' && (objectFormat !== 'sha256' || value !== 'sha256'))
      fail('p5_git_config_unsupported', 'P5 repository object-format config is inconsistent.');
  }
  const map = new Map(entries);
  for (const [key, value] of expected) {
    if (!allowMissing && map.get(key) !== value) fail('p5_git_config_unsupported', `P5 repository config is missing its controlled "${key}" setting.`);
    if (allowMissing && map.has(key) && map.get(key) !== value) fail('p5_git_config_unsupported', `P5 repository config conflicts at "${key}".`);
  }
  return canonicalHash(entries);
}

function setConfig(gitTool, root, key, value) {
  gitBytes(gitTool, root, ['config', '--local', '--replace-all', key, value]);
}

function ensureSafeConfig(gitTool, root, objectFormat) {
  let entries = gitConfigEntries(gitTool, root);
  validateConfigEntries(entries, objectFormat, { allowMissing: true });
  const current = new Map(entries);
  for (const [key, value] of [['core.hooksPath', 'NUL'], ['user.name', ENGINE_AUTHOR], ['user.email', ENGINE_EMAIL], ['commit.gpgsign', 'false']])
    if (!current.has(key.toLowerCase())) setConfig(gitTool, root, key, value);
  entries = gitConfigEntries(gitTool, root);
  return validateConfigEntries(entries, objectFormat);
}

function assertMetadataLayout(commonDirectory) {
  for (const path of ['objects/info/alternates', 'objects/info/http-alternates', 'commondir', 'shallow', 'info/grafts',
    'config.worktree', 'refs/replace', 'objects/info/commit-graph', 'objects/info/commit-graphs', 'objects/pack/multi-pack-index', 'objects/pack/multi-pack-index.d']) {
    if (existsSync(join(commonDirectory, path))) fail('p5_git_metadata_unsupported', `P5 refuses unsafe Git metadata at "${path}".`);
  }
  const top = readdirSync(commonDirectory).sort(compareText);
  const allowed = new Set(['HEAD', 'config', 'description', 'hooks', 'info', 'objects', 'refs', 'logs', 'branches', 'index', 'packed-refs', 'COMMIT_EDITMSG']);
  const unexpected = top.find(name => !allowed.has(name));
  if (unexpected) fail('p5_git_metadata_unsupported', `P5 refuses unexpected Git metadata entry "${unexpected}" in the private common directory.`);
  const hooks = join(commonDirectory, 'hooks');
  if (existsSync(hooks)) {
    assertPlainDirectory(hooks);
    if (readdirSync(hooks).length) fail('p5_git_hooks_unsupported', 'P5 refuses Git hook files in the private candidate repository.');
  }
}

function repositoryDetails(gitTool, root, objectFormat, branch) {
  const gitDirText = gitText(gitTool, root, ['rev-parse', '--path-format=absolute', '--git-dir']);
  const commonText = gitText(gitTool, root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const gitDirectory = resolve(gitDirText);
  const commonDirectory = resolve(commonText);
  if (pathKey(gitDirectory) !== pathKey(join(root, '.git')) || pathKey(commonDirectory) !== pathKey(gitDirectory))
    fail('p5_git_repository_shared', 'P5 requires an independent ordinary .git directory with no worktree/common-directory indirection.');
  assertPlainDirectory(gitDirectory);
  assertMetadataLayout(commonDirectory);
  const reportedFormat = gitText(gitTool, root, ['rev-parse', '--show-object-format=storage']);
  if (reportedFormat !== objectFormat) fail('p5_git_object_format_unsupported', 'The private Git object format differs from the enrolled source baseline.');
  const currentBranch = gitText(gitTool, root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (currentBranch !== branch) fail('p5_git_branch_mismatch', 'The private Git repository is not on its exact P5 Self-Repair branch.');
  const refsText = gitText(gitTool, root, ['for-each-ref', '--format=%(refname)%09%(objectname)']);
  const refs = refsText ? refsText.split(/\r?\n/).map(line => {
    const [name, objectId] = line.split('\t');
    if (!name || !REF_SHA.test(objectId || '')) fail('p5_git_ref_invalid', 'Pinned Git returned malformed reference data.');
    return { name, objectId };
  }).sort((a, b) => compareText(a.name, b.name)) : [];
  if (refs.some(ref => ref.name !== `refs/heads/${branch}`))
    fail('p5_git_ref_unsupported', 'P5 refuses any Git ref outside its one enrolled Self-Repair branch.');
  if (gitText(gitTool, root, ['remote'])) fail('p5_git_remote_unsupported', 'P5 refuses any configured Git remote.');
  const configDigest = validateConfigEntries(gitConfigEntries(gitTool, root), objectFormat);
  return { gitDirectory, commonDirectory, refs, configDigest };
}

function readCommitInfo(gitTool, root, commit) {
  const raw = gitText(gitTool, root, ['show', '-s', '--format=%H%x00%T%x00%P%x00%an%x00%ae%x00%cn%x00%ce%x00%at%x00%ct%x00%s', commit]);
  const fields = raw.split('\0');
  if (fields.length !== 10) fail('p5_git_commit_invalid', 'Pinned Git returned malformed commit identity.');
  const [commitId, tree, parents, author, authorEmail, committer, committerEmail, authorTimestampText, committerTimestampText, subject] = fields;
  const authorTimestamp = Number(authorTimestampText), committerTimestamp = Number(committerTimestampText);
  if (!REF_SHA.test(commitId) || !REF_SHA.test(tree) || !Number.isSafeInteger(authorTimestamp) || !Number.isSafeInteger(committerTimestamp))
    fail('p5_git_commit_invalid', 'Pinned Git returned malformed commit/tree identities or timestamps.');
  return { commitId, tree, parents: parents ? parents.split(' ') : [], author, authorEmail, committer, committerEmail,
    authorTimestamp, committerTimestamp, subject };
}

function parseTree(bytes) {
  const records = [];
  let start = 0;
  for (let index = 0; index <= bytes.length; index++) {
    if (index < bytes.length && bytes[index] !== 0) continue;
    if (index === start) { start = index + 1; continue; }
    const record = bytes.subarray(start, index), tab = record.indexOf(0x09);
    if (tab < 0) fail('p5_git_tree_invalid', 'Pinned Git returned malformed tree data.');
    const head = /^([0-7]{6}) (blob|commit|tree) ([a-f0-9]{40,64})\s+(-|\d+)$/.exec(record.subarray(0, tab).toString('ascii'));
    const pathBytes = record.subarray(tab + 1);
    if (!head || !pathBytes.every(byte => byte >= 0x20 && byte <= 0x7e)) fail('p5_git_tree_invalid', 'P5 refuses non-portable Git tree paths.');
    const path = pathBytes.toString('ascii');
    validateP5SourcePath(path);
    records.push({ mode: head[1], type: head[2], objectId: head[3], byteSize: head[4] === '-' ? null : Number(head[4]), path });
    start = index + 1;
  }
  return records.sort((a, b) => compareText(a.path, b.path));
}

function readBlobBatch(gitTool, root, records) {
  const ids = [...new Set(records.map(record => record.objectId))];
  const input = Buffer.from(`${ids.join('\n')}\n`, 'ascii');
  const result = gitBytes(gitTool, root, ['cat-file', '--batch'], { input,
    maxBuffer: Math.max(64 * 1024 * 1024, records.reduce((sum, record) => sum + (record.byteSize ?? 0), 0) + ids.length * 128) });
  const objects = new Map(); let offset = 0;
  for (const id of ids) {
    const headerEnd = result.indexOf(0x0a, offset);
    if (headerEnd < 0) fail('p5_git_object_invalid', 'Pinned Git returned a truncated source blob header.');
    const [reportedId, type, rawSize] = result.subarray(offset, headerEnd).toString('ascii').split(' ');
    const size = Number(rawSize), contentStart = headerEnd + 1, contentEnd = contentStart + size;
    if (reportedId !== id || type !== 'blob' || !Number.isSafeInteger(size) || size < 0 || contentEnd >= result.length
      || result[contentEnd] !== 0x0a) fail('p5_git_object_invalid', 'Pinned Git returned an unsupported or malformed source object.');
    objects.set(id, Buffer.from(result.subarray(contentStart, contentEnd)));
    offset = contentEnd + 1;
  }
  if (offset !== result.length) fail('p5_git_object_invalid', 'Pinned Git returned unrequested trailing source objects.');
  return objects;
}

function verifyCommitTree(gitTool, root, commit, expectedEntries) {
  const tree = gitHash(gitTool, root, ['rev-parse', '--verify', `${commit}^{tree}`]);
  const records = parseTree(gitBytes(gitTool, root, ['ls-tree', '-rz', '--full-tree', '-l', commit]));
  if (records.length !== expectedEntries.length) fail('p5_git_tree_mismatch', 'The private Git commit contains a different number of files than the sealed source manifest.');
  for (let index = 0; index < records.length; index++) {
    const record = records[index], expected = expectedEntries[index];
    const expectedMode = expected.executable ? '100755' : '100644';
    if (record.path !== expected.path || record.mode !== expectedMode || record.type !== 'blob' || record.byteSize !== expected.byteSize)
      fail('p5_git_tree_mismatch', `The private Git commit differs from the sealed source manifest at "${expected.path ?? record.path}".`);
  }
  const blobs = readBlobBatch(gitTool, root, records);
  for (const record of records) {
    const expected = expectedEntries.find(entry => entry.path === record.path), bytes = blobs.get(record.objectId);
    if (!expected || !bytes || bytes.length !== expected.byteSize || sha256(bytes) !== expected.sha256)
      fail('p5_git_blob_mismatch', `The private Git blob for "${record.path}" differs from the sealed SHA-256 source object.`);
  }
  return tree;
}

function unreachableObjects(gitTool, root, objectFormat) {
  const objectLength = objectFormat === 'sha1' ? 40 : 64;
  const allIds = gitBytes(gitTool, root, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname)']).toString('ascii').split(/\r?\n/).filter(Boolean);
  const reachable = new Set(gitBytes(gitTool, root, ['rev-list', '--objects', '--all', '--no-object-names']).toString('ascii').split(/\r?\n/).filter(Boolean));
  if (allIds.some(id => id.length !== objectLength || !REF_SHA.test(id)) || new Set(allIds).size !== allIds.length)
    fail('p5_git_object_invalid', 'Pinned Git returned a malformed private object-store inventory.');
  return allIds.filter(id => !reachable.has(id)).sort(compareText);
}

function assertOnlyReachableObjects(gitTool, root, objectFormat, allowedUnreachable = null) {
  if (allowedUnreachable) {
    const allowed = new Set(allowedUnreachable);
    if (unreachableObjects(gitTool, root, objectFormat).some(id => !allowed.has(id)))
      fail('p5_git_unreachable_objects', 'P5 refuses private Git objects outside the fetched installed history and the Engine candidate branch.');
    return;
  }
  const objectLength = objectFormat === 'sha1' ? 40 : 64;
  const allBytes = gitBytes(gitTool, root, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname)']);
  const allIds = allBytes.toString('ascii').split(/\r?\n/).filter(Boolean);
  const reachableBytes = gitBytes(gitTool, root, ['rev-list', '--objects', '--all', '--no-object-names']);
  const reachableIds = reachableBytes.toString('ascii').split(/\r?\n/).filter(Boolean);
  if ([...allIds, ...reachableIds].some(id => id.length !== objectLength || !REF_SHA.test(id)))
    fail('p5_git_object_invalid', 'Pinned Git returned a malformed private object-store inventory.');
  const all = new Set(allIds), reachable = new Set(reachableIds);
  if (all.size !== allIds.length || reachable.size !== reachableIds.length || all.size !== reachable.size
    || [...all].some(id => !reachable.has(id)))
    fail('p5_git_unreachable_objects', 'P5 refuses private Git objects outside the exact seed and candidate branch history.');
}

function decodePathList(bytes, label) {
  const paths = [];
  for (const field of bytes.toString('utf8').split('\0').filter(Boolean)) {
    if (!/^[\x20-\x7e]+$/.test(field)) fail('p5_git_path_unsupported', `P5 refuses a non-portable ${label} Git path.`);
    validateP5SourcePath(field);
    paths.push(field);
  }
  return [...new Set(paths)].sort(compareText);
}

function workingPathLists(gitTool, root, baseCommit) {
  const tracked = decodePathList(gitBytes(gitTool, root, ['diff', '--no-renames', '--name-only', '-z', baseCommit, '--']), 'changed');
  const untracked = decodePathList(gitBytes(gitTool, root, ['ls-files', '--others', '--exclude-standard', '-z']), 'untracked');
  const ignored = decodePathList(gitBytes(gitTool, root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']), 'ignored');
  return { paths: [...new Set([...tracked, ...untracked, ...ignored])].sort(compareText), ignored };
}

function commitChangedPaths(gitTool, root, baseCommit, candidateCommit) {
  return decodePathList(gitBytes(gitTool, root, ['diff', '--no-renames', '--name-only', '-z', baseCommit, candidateCommit, '--']), 'commit-diff');
}

function assertCommitIdentity(gitTool, root, commit, { tree, parent = null, subject, timestamp = null }) {
  const value = readCommitInfo(gitTool, root, commit);
  if (value.commitId !== commit || value.tree !== tree || value.parents.length !== (parent ? 1 : 0)
    || parent && value.parents[0] !== parent || value.author !== ENGINE_AUTHOR || value.authorEmail !== ENGINE_EMAIL
    || value.committer !== ENGINE_AUTHOR || value.committerEmail !== ENGINE_EMAIL || value.subject !== subject
    || timestamp !== null && (value.authorTimestamp !== timestamp || value.committerTimestamp !== timestamp))
    fail('p5_git_commit_identity_mismatch', 'The P5 Git commit does not have the exact Engine-controlled identity, parent and subject.');
  return value;
}

function addExactPaths(gitTool, root, values) {
  const paths = [...new Set(values.map(value => validateP5SourcePath(typeof value === 'string' ? value : value.path)))].sort(compareText);
  if (!paths.length) fail('p5_git_source_manifest_invalid', 'P5 cannot create a Git tree from an empty source manifest.');
  const input = Buffer.from(`${paths.join('\0')}\0`, 'ascii');
  gitBytes(gitTool, root, ['--literal-pathspecs', 'add', '--all', '--force', '--pathspec-from-file=-', '--pathspec-file-nul'], { input });
}

function readMarker(path, expected) {
  const bytes = canonicalBytes(expected);
  if (!existsSync(path)) {
    writeExclusive(path, bytes);
    return expected;
  }
  let info;
  try { info = lstatSync(path, { bigint: true }); } catch { fail('p5_git_marker_invalid', 'The P5 Git preparation marker cannot be inspected.'); }
  if (!info.isFile() || info.isSymbolicLink()) fail('p5_git_marker_invalid', 'The P5 Git preparation marker is not a plain file.');
  const actual = readFileSync(path);
  let value;
  try { value = parseStrictJson(actual.toString('utf8')); } catch { fail('p5_git_marker_invalid', 'The P5 Git preparation marker is malformed.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('p5_git_marker_invalid', 'The P5 Git preparation marker is not a JSON object.');
  const allowedKeys = Object.keys(expected).sort(compareText);
  if (canonicalHash(Object.keys(value).sort(compareText)) !== canonicalHash(allowedKeys)
    || typeof value.preparedAt !== 'string' || !Number.isFinite(Date.parse(value.preparedAt))
    || new Date(value.preparedAt).toISOString() !== value.preparedAt)
    fail('p5_git_marker_invalid', 'The P5 Git preparation marker has an unsupported shape or timestamp.');
  if (canonicalHash(value) !== canonicalHash(expected))
    fail('p5_git_marker_conflict', 'The P5 Git preparation marker belongs to a different durable repair identity.');
  return value;
}

function journalHas(store, runId, type, ref) {
  const matches = store.readEvents(runId).filter(event => event.type === type);
  if (matches.length > 1) fail('p5_git_journal_conflict', `P5 found duplicate ${type} records.`);
  return matches.length === 1 && canonicalHash(matches[0].payload?.record) === canonicalHash(ref);
}

function readPreparationRecord(store, intent, intentRef) {
  const rows = store.readEvents(intent.repairRunId).filter(event => event.type === 'self_repair.workspace_prepared');
  if (rows.length > 1) fail('p5_git_journal_conflict', 'P5 found more than one prepared-workspace event for this Repair.');
  if (!rows.length) return null;
  const ref = rows[0].payload?.record;
  if (!ref) fail('p5_git_journal_corrupt', 'The P5 workspace-prepared event has no record reference.');
  store.verifyRef(ref);
  const record = store.readJson(ref.artifactId);
  validateP5Contract('workspacePreparation', record);
  const baseline = store.readJson(intent.baselineManifest.artifactId);
  if (canonicalHash(record) !== ref.sha256 || canonicalHash(record.intent) !== canonicalHash(intentRef)
    || record.baselineId !== baseline.baselineId || record.sourceDigest !== baseline.effectiveSourceDigest
    || pathKey(record.workspaceRoot) !== pathKey(intent.workspace.canonicalRoot)
    || pathKey(record.sourceRoot) !== pathKey(join(intent.workspace.canonicalRoot, 'source')) || !record.gitRepository)
    fail('p5_git_prepared_record_mismatch', 'The durable workspace-prepared record does not bind the exact Git preparation intent.');
  validateP5Contract('gitRepository', record.gitRepository);
  return { ref, record, gitRepository: record.gitRepository };
}

async function assertDurablePreparation(store, intentRef) {
  store.verifyRef(intentRef);
  const intent = store.readJson(intentRef.artifactId);
  validateP5Contract('preparationIntent', intent);
  if (canonicalHash(intent) !== intentRef.sha256 || !journalHas(store, intent.repairRunId, 'self_repair.preparation_intent', intentRef))
    fail('p5_preparation_intent_missing', 'P5 Git preparation requires its exact durable P2 preparation intent.');
  for (const ref of [intent.enrollment, intent.baselineManifest, intent.sourceManifest, intent.sourceBinding, intent.verificationInputs]) store.verifyRef(ref);
  const enrollment = store.readJson(intent.enrollment.artifactId);
  const baseline = store.readJson(intent.baselineManifest.artifactId);
  const sourceManifest = store.readJson(intent.sourceManifest.artifactId);
  validateP5Contract('enrollment', enrollment);
  validateP5Contract('baselineManifest', baseline);
  if (!P5_GIT_POLICIES.includes(enrollment.gitCandidatePolicy))
    fail('p5_git_policy_unenrolled', 'This P5 enrollment did not explicitly approve a versioned Git candidate policy.');
  if (isClone(enrollment.gitCandidatePolicy)) assertGitSourceEnrollment(store, enrollment, baseline);
  if (canonicalHash(enrollment.baselineManifest) !== canonicalHash(intent.baselineManifest)
    || canonicalHash(baseline.sourceManifest) !== canonicalHash(intent.sourceManifest)
    || enrollment.baselineId !== baseline.baselineId || baseline.baseCommit !== enrollment.baseCommit
    || baseline.baseTree !== enrollment.baseTree || baseline.gitObjectFormat !== enrollment.gitObjectFormat
    || baseline.effectiveSourceDigest !== enrollment.effectiveSourceDigest
    || sourceManifest.sourceDigest !== enrollment.effectiveSourceDigest
    || canonicalHash(enrollment.workspace) !== canonicalHash(intent.workspace))
    fail('p5_git_baseline_mismatch', 'The Git preparation intent differs from the exact enrolled source baseline or workspace allocation.');
  if (!journalHas(store, intent.parentRunId, 'self_repair.source_bound', intent.sourceBinding))
    fail('p5_source_binding_missing', 'P5 Git preparation requires the exact Parent source-binding event.');
  const preparation = readPreparationRecord(store, intent, intentRef);
  return { intent, enrollment, baseline, sourceManifest, preparation };
}

function markerFor(intentRef, intent, enrollment, baseline, branch, preparedAt) {
  return { schemaVersion: 1, kind: 'ProtectedSelfRepairGitPreparationMarker', intent: asRef(intentRef),
    allocationId: intent.workspace.allocationId, parentRunId: intent.parentRunId, repairRunId: intent.repairRunId,
    linkId: intent.linkId, enrollmentId: enrollment.enrollmentId, baselineId: baseline.baselineId,
    sourceBaseCommit: baseline.baseCommit, sourceDigest: baseline.effectiveSourceDigest,
    policy: enrollment.gitCandidatePolicy, repairBranch: branch, preparedAt };
}

function validateNoGitRedirects(gitDirectory) {
  assertPlainDirectory(gitDirectory);
  for (const rel of ['objects/info/alternates', 'objects/info/http-alternates', 'commondir', 'config.worktree', 'shallow', 'info/grafts']) {
    if (existsSync(join(gitDirectory, rel))) fail('p5_git_repository_shared', `P5 refuses shared or alternate Git storage at "${rel}".`);
  }
}

function ensureCommitSubject(gitTool, root, commit, expected, timestamp) {
  const actual = readCommitInfo(gitTool, root, commit);
  if (actual.commitId !== commit || actual.parents.length || actual.author !== ENGINE_AUTHOR || actual.authorEmail !== ENGINE_EMAIL
    || actual.committer !== ENGINE_AUTHOR || actual.committerEmail !== ENGINE_EMAIL || actual.subject !== expected
    || actual.authorTimestamp !== timestamp || actual.committerTimestamp !== timestamp)
    fail('p5_git_seed_mismatch', 'The private Git seed commit is not the exact Engine-created sanitized baseline.');
  return actual;
}

function setEmptyExclude(commonDirectory) {
  ensureDirectory(join(commonDirectory, 'info'));
  const path = join(commonDirectory, 'info', 'exclude');
  if (existsSync(path)) {
    const info = lstatSync(path, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink()) fail('p5_git_metadata_unsupported', 'P5 refuses a redirected Git exclude file.');
    if (readFileSync(path).length !== 0) fail('p5_git_metadata_unsupported', 'P5 refuses a non-empty Git exclude file and leaves it unchanged.');
    return sha256(readFileSync(path));
  }
  if (!writeExclusive(path, Buffer.alloc(0))) fail('p5_git_metadata_unsupported', 'P5 could not exclusively create its empty Git exclude file.');
  return sha256(readFileSync(path));
}

function readExcludeDigest(commonDirectory) {
  const path = join(commonDirectory, 'info', 'exclude');
  let info;
  try { info = lstatSync(path, { bigint: true }); } catch { fail('p5_git_metadata_unsupported', 'The private Git exclude file is missing.'); }
  if (!info.isFile() || info.isSymbolicLink()) fail('p5_git_metadata_unsupported', 'P5 refuses a redirected Git exclude file.');
  return sha256(readFileSync(path));
}

function assertSeedWorktreeClean(gitTool, root) {
  const status = gitBytes(gitTool, root, ['status', '--porcelain=v2', '--untracked-files=all', '--ignored=matching', '-z']);
  if (status.length) fail('p5_git_seed_dirty', 'The private Git seed worktree is not clean after baseline commit.');
}

function assertGitSourceEnrollment(store, enrollment, baseline) {
  const source = enrollment.gitSource;
  if (!source) fail('p5_git_source_unenrolled', 'managed-clone-v1 requires an installation-owned enrolled Git source.');
  validateP5Contract('gitSource', source);
  store.verifyRef(enrollment.runningSourceRelease);
  const release = store.readJson(enrollment.runningSourceRelease.artifactId);
  validateP5Contract('runningSourceRelease', release);
  if (source.policy !== P5_GIT_CLONE_POLICY || source.sourceCommit !== enrollment.baseCommit || source.sourceTree !== enrollment.baseTree
    || source.objectFormat !== enrollment.gitObjectFormat || baseline.baseCommit !== source.sourceCommit || baseline.baseTree !== source.sourceTree
    || release.sourceCommit !== source.sourceCommit || release.sourceDigest !== source.releaseSourceDigest)
    fail('p5_git_source_provenance_mismatch', 'The enrolled Git source differs from the installed release commit, tree, object format or source digest.');
  assertSafeRemote(source.remote);
  return { source, release };
}

function assertSafeRemote(remote) {
  let url;
  try { url = new URL(remote.url); } catch { fail('p5_git_remote_invalid', 'The enrolled Git remote is not an absolute URL.'); }
  const expected = { file: 'file:', https: 'https:' }[remote.protocol];
  if (!expected || url.protocol !== expected || url.username || url.password || url.search || url.hash
    || remote.protocol === 'https' && !url.hostname)
    fail('p5_git_remote_invalid', 'The enrolled Git remote must be a credential-free file or https URL of its declared protocol.');
  return url;
}

function fetchArgs(remote, refspecs) {
  return ['-c', 'protocol.allow=never', '-c', `protocol.${remote.protocol}.allow=always`, '-c', 'credential.helper=',
    '-c', 'core.askPass=', '-c', 'http.followRedirects=false', '-c', 'transfer.fsckObjects=true', '-c', 'fetch.fsckObjects=true',
    '-c', 'fetch.writeCommitGraph=false', '-c', 'submodule.recurse=false',
    'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', remote.url, ...refspecs];
}

function commitPresent(gitTool, root, commit) {
  try { return gitText(gitTool, root, ['cat-file', '-t', commit]) === 'commit'; } catch { return false; }
}

// Fetch only the exact installed commit's history. A server that refuses an object-ID want is asked for the
// enrolled refs instead, but no ref is written locally and a moved ref can never replace the installed commit.
function fetchInstalledCommit(gitTool, root, source, resultPath, intentRef) {
  // The marker-owned control directory keeps the first fetch's strategy so pre-journal recovery records what really happened.
  if (existsSync(resultPath)) {
    const info = lstatSync(resultPath);
    if (!info.isFile() || info.isSymbolicLink()) fail('p5_git_fetch_result_invalid', 'The P5 Git fetch result is not a plain file.');
    let value;
    try { value = parseStrictJson(readFileSync(resultPath, 'utf8')); } catch { fail('p5_git_fetch_result_invalid', 'The P5 Git fetch result is malformed.'); }
    if (value?.kind !== 'ProtectedSelfRepairGitFetchResult' || canonicalHash(value.intent) !== canonicalHash(asRef(intentRef))
      || !['commit', 'enrolled-refs'].includes(value.strategy) || !Array.isArray(value.refspecs) || Object.keys(value).length !== 5)
      fail('p5_git_fetch_result_invalid', 'The P5 Git fetch result belongs to another durable intent or has an unsupported shape.');
    if (!commitPresent(gitTool, root, source.sourceCommit))
      fail('p5_git_source_commit_unavailable', 'The recorded fetch no longer provides the installed source commit; it was not refetched.');
    return { strategy: value.strategy, refspecs: value.refspecs };
  }
  if (commitPresent(gitTool, root, source.sourceCommit)) return { strategy: 'present', refspecs: [] };
  let strategy = 'commit', refspecs = [source.sourceCommit];
  try { gitBytes(gitTool, root, fetchArgs(source.remote, refspecs)); }
  catch {
    strategy = 'enrolled-refs'; refspecs = [...source.fetchRefs];
    try { gitBytes(gitTool, root, fetchArgs(source.remote, refspecs)); }
    catch { fail('p5_git_source_fetch_failed', 'The enrolled Git remote could not provide the installed source history.'); }
  }
  if (!commitPresent(gitTool, root, source.sourceCommit))
    fail('p5_git_source_commit_unavailable', 'The enrolled remote does not contain the exact installed source commit; no other revision is substituted.');
  writeExclusive(resultPath, canonicalBytes({ schemaVersion: 1, kind: 'ProtectedSelfRepairGitFetchResult', intent: asRef(intentRef), strategy, refspecs }));
  return { strategy, refspecs };
}

function releaseDigestForTree(gitTool, root, commit) {
  const records = parseTree(gitBytes(gitTool, root, ['ls-tree', '-rz', '--full-tree', '-l', commit]));
  const blobs = readBlobBatch(gitTool, root, records);
  const byPath = new Map(records.map(record => [record.path, record]));
  // Mirrors runtime/host/sourceProvenance.mjs: default-sorted portable paths with each file's SHA-256.
  const files = [...byPath.keys()].sort().map(path => ({ path, sha256: sha256(blobs.get(byPath.get(path).objectId)) }));
  return canonicalHash(files);
}

function verifyInstalledCommit(gitTool, root, source, baselineEntries) {
  const info = readCommitInfo(gitTool, root, source.sourceCommit);
  if (info.commitId !== source.sourceCommit || info.tree !== source.sourceTree)
    fail('p5_git_source_provenance_mismatch', 'The fetched installed commit does not have the enrolled source tree.');
  if (gitText(gitTool, root, ['rev-parse', '--show-object-format=storage']) !== source.objectFormat)
    fail('p5_git_object_format_unsupported', 'The managed repository object format differs from the installed source commit.');
  // The P5 baseline must be the complete committed source closure; parseTree also refuses gitlinks and symlinks.
  let tree;
  try { tree = verifyCommitTree(gitTool, root, source.sourceCommit, baselineEntries); }
  catch (error) { fail('p5_git_source_closure_mismatch', `The installed commit tree differs from the complete enrolled P5 source manifest (${error.code}).`); }
  if (tree !== source.sourceTree) fail('p5_git_source_closure_mismatch', 'The installed commit tree identity changed during verification.');
  if (releaseDigestForTree(gitTool, root, source.sourceCommit) !== source.releaseSourceDigest)
    fail('p5_git_source_provenance_mismatch', 'The fetched commit bytes do not reproduce the installed release source digest.');
  // Full ancestry is retained: a shallow boundary is refused by the metadata layout check, and every parent must be present.
  const history = gitText(gitTool, root, ['rev-list', '--parents', source.sourceCommit]).split(/\r?\n/).filter(Boolean);
  const present = new Set(history.map(line => line.split(' ')[0]));
  for (const line of history) for (const parent of line.split(' ').slice(1))
    if (!present.has(parent)) fail('p5_git_source_ancestry_incomplete', 'The managed repository lacks part of the installed commit ancestry.');
  return { tree: info.tree, historyLength: history.length };
}

function ensureRepairBranch(gitTool, root, branch, sourceCommit, objectFormat, preparation) {
  const ref = `refs/heads/${branch}`;
  let current = null;
  try { current = gitText(gitTool, root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); } catch { current = null; }
  if (!current) {
    if (preparation) fail('p5_git_branch_missing', 'A journaled P5 repair branch is missing; it was not recreated.');
    gitBytes(gitTool, root, ['update-ref', '--no-deref', '-m', 'P5 repair branch from installed source', ref, sourceCommit,
      '0'.repeat(objectFormat === 'sha1' ? 40 : 64)]);
    current = sourceCommit;
  }
  if (!preparation && current !== sourceCommit)
    fail('p5_git_branch_conflict', 'The P5 repair branch exists with a different base; it was left untouched.');
  if (preparation) {
    try { gitBytes(gitTool, root, ['merge-base', '--is-ancestor', sourceCommit, current]); }
    catch { fail('p5_git_branch_moved', 'The prepared Self-Repair branch no longer descends from the installed source commit.'); }
  }
  return current;
}

function ensureCloneIndex(gitTool, root, gitDirectory, sourceCommit) {
  // Populating a missing index is non-destructive; an existing index must already describe a clean tree.
  if (!existsSync(join(gitDirectory, 'index'))) gitBytes(gitTool, root, ['read-tree', sourceCommit]);
  assertSeedWorktreeClean(gitTool, root);
}

function putVerified(store, value) { const artifact = store.putJson(value); store.verifyRef(artifact); return asRef(artifact); }

function readFetchProvenance(store, ref) {
  store.verifyRef(ref);
  const value = store.readJson(ref.artifactId);
  validateP5Contract('gitFetchProvenance', value);
  if (canonicalHash(value) !== ref.sha256) fail('p5_git_fetch_provenance_invalid', 'The recorded Git fetch provenance is not immutable.');
  return value;
}

/** Objects a managed clone may hold outside the repair branch: exactly the fetched installed history recorded at preparation. */
function allowedUnreachableFor(store, repository) {
  return isClone(repository.policy) ? readFetchProvenance(store, repository.fetchProvenance).unreachableObjects : null;
}

/**
 * Prepare a private independent repository from the already sealed source manifest. No source
 * repository objects, remotes or commit ancestry are copied. Existing durable preparation intents
 * may resume only a marker-owned, fully validated empty/seeded repository; partial unknown state is
 * retained and refused rather than deleted or adopted.
 */
export async function prepareP5GitRepositoryFromIntent({ store, intentRef, sourceRoot, workspaceRoot, nativeSourceReader,
  nativeToolIdentityReader, identityReader = null, protectedRoots = [] }) {
  if (!store || !intentRef || !sourceRoot || !workspaceRoot) fail('p5_git_preparation_invalid', 'P5 Git preparation requires its durable intent and exact workspace roots.');
  const { intent, enrollment, baseline, sourceManifest, preparation } = await assertDurablePreparation(store, intentRef);
  const slot = resolve(workspaceRoot), root = resolve(sourceRoot);
  if (pathKey(slot) !== pathKey(intent.workspace.canonicalRoot) || pathKey(root) !== pathKey(join(slot, 'source'))
    || pathKey(realpathSync.native(slot)) !== pathKey(slot) || pathKey(realpathSync.native(root)) !== pathKey(root))
    fail('p5_git_workspace_mismatch', 'The Git repository must be the exact prepared <allocation>/source directory.');
  assertNoOverlap(slot, [baseline.repositoryRoot, baseline.repositoryIdentity.canonicalCommonDirectory, store.root, ...protectedRoots]);
  if (!inside(slot, root)) fail('p5_git_workspace_mismatch', 'The private Git repository is outside its exact workspace allocation.');
  assertPlainDirectory(slot);
  assertPlainDirectory(root);
  const gitRows = enrollment.toolIdentities.filter(item => item.name === 'git');
  if (gitRows.length !== 1) fail('p5_git_tool_unavailable', 'The P5 enrollment must pin exactly one Git executable.');
  const gitTool = { path: gitRows[0].path, sha256: gitRows[0].sha256 };
  const gitIdentity = await verifyP5GitToolIdentity({ gitTool, identityReader, nativeToolIdentityReader });
  if (gitIdentity.sha256 !== gitRows[0].sha256) fail('p5_git_tool_mismatch', 'The P5 Git executable differs from its captured enrollment identity.');
  const { entries: baselineEntries } = verifyStoredSource(store, sourceManifest);
  if (sourceManifest.sourceDigest !== baseline.effectiveSourceDigest || p5SourceDigest(baselineEntries) !== baseline.effectiveSourceDigest)
    fail('p5_git_baseline_mismatch', 'The sealed baseline source manifest differs from enrollment.');
  if (!preparation) await assertSourceTree(root, baselineEntries, enrollment.budgets, nativeSourceReader, identityReader);
  const branch = branchForLink(intent.linkId, gitTool, root);
  const expectedPreparationTime = preparation?.gitRepository?.preparedAt ?? intent.createdAt;
  const expectedMarker = markerFor(intentRef, intent, enrollment, baseline, branch, expectedPreparationTime);
  const markerRoot = join(slot, '.p5', 'control');
  ensureDirectory(join(slot, '.p5'));
  ensureDirectory(markerRoot);
  const markerPath = join(markerRoot, 'git-repository-intent.json');
  const gitDirectory = join(root, '.git');
  const gitExists = existsSync(gitDirectory);
  if (preparation && !gitExists)
    fail('p5_git_seed_missing', 'A journaled P5 Git repository lost its seed; no repository was recreated.');
  if (gitExists && !existsSync(markerPath)) fail('p5_git_unknown_repository', 'P5 found a Git directory without its durable local preparation marker and left it untouched.');
  const marker = readMarker(markerPath, expectedMarker);
  const preparationTime = marker.preparedAt;
  if (gitExists) await nativeStorageScan(nativeSourceReader, gitDirectory);
  if (!gitExists) {
    const template = join(markerRoot, EMPTY_TEMPLATE);
    ensureDirectory(template);
    if (readdirSync(template).length) fail('p5_git_template_unsafe', 'The controlled empty Git template directory is not empty.');
    const init = gitBytes(gitTool, root, ['init', '--quiet', `--object-format=${baseline.gitObjectFormat}`,
      `--initial-branch=${branch}`, `--template=${template}`]);
    void init;
    validateNoGitRedirects(gitDirectory);
    await nativeStorageScan(nativeSourceReader, gitDirectory);
    ensureSafeConfig(gitTool, root, baseline.gitObjectFormat);
    setEmptyExclude(gitDirectory);
  } else if (!preparation) {
    // A crash may leave a marker-owned, initialized .git directory before the prepared event.
    // Complete only the allowlisted settings and empty exclude file; conflicts remain untouched.
    ensureSafeConfig(gitTool, root, baseline.gitObjectFormat);
    setEmptyExclude(gitDirectory);
  }
  verifyP5GitAttributes(gitTool, root, baselineEntries.map(entry => entry.path));
  const repo = repositoryDetails(gitTool, root, baseline.gitObjectFormat, branch);
  validateNoGitRedirects(repo.commonDirectory);
  const excludeFileDigest = readExcludeDigest(repo.commonDirectory);
  if (excludeFileDigest !== sha256(Buffer.alloc(0))) fail('p5_git_metadata_unsupported', 'The private Git exclude file is not the controlled empty file.');

  const objectFormatLength = baseline.gitObjectFormat === 'sha1' ? 40 : 64;
  if (baseline.baseCommit.length !== objectFormatLength || baseline.baseTree.length !== objectFormatLength)
    fail('p5_git_baseline_mismatch', 'The enrolled source commit/tree length does not match its Git object format.');
  const branchHead = repo.refs[0]?.objectId ?? null;
  const seedSubject = `P5 sanitized baseline ${baseline.baselineId}`;
  const seedTimestamp = Math.floor(Date.parse(intent.createdAt) / 1000);
  if (!Number.isSafeInteger(seedTimestamp)) fail('p5_git_preparation_invalid', 'The durable preparation intent has no usable creation time for the synthetic seed.');
  const clone = isClone(enrollment.gitCandidatePolicy);
  let seedCommit = null, seedTree = null, fetchProvenance = null, hostProtection = null, allowedUnreachable = null;
  if (clone) {
    // managed-clone-v1: real installed history from the enrolled remote; the branch starts at the exact installed commit.
    const { source } = assertGitSourceEnrollment(store, enrollment, baseline);
    const fetched = preparation ? null : fetchInstalledCommit(gitTool, root, source, join(markerRoot, 'git-fetch-result.json'), intentRef);
    if (!commitPresent(gitTool, root, source.sourceCommit))
      fail('p5_git_source_commit_unavailable', 'The managed repository no longer holds the installed source commit; it was not refetched.');
    verifyInstalledCommit(gitTool, root, source, baselineEntries);
    ensureRepairBranch(gitTool, root, branch, source.sourceCommit, baseline.gitObjectFormat, preparation);
    if (!preparation) ensureCloneIndex(gitTool, root, gitDirectory, source.sourceCommit);
    seedCommit = source.sourceCommit; seedTree = source.sourceTree;
    if (preparation) {
      fetchProvenance = preparation.gitRepository.fetchProvenance; hostProtection = preparation.gitRepository.hostProtection;
      if (!fetchProvenance || !hostProtection) fail('p5_git_prepared_record_mismatch', 'The journaled managed clone lacks its fetch provenance or Host closure.');
      readP5HostProtection(store, hostProtection);
      allowedUnreachable = readFetchProvenance(store, fetchProvenance).unreachableObjects;
    } else {
      hostProtection = putVerified(store, await deriveP5HostProtection({ sourceRoot: root, sourceCommit: source.sourceCommit }));
      allowedUnreachable = unreachableObjects(gitTool, root, baseline.gitObjectFormat);
      fetchProvenance = putVerified(store, { schemaVersion: 1, kind: 'ProtectedSelfRepairGitFetchProvenance', policy: P5_GIT_CLONE_POLICY,
        sourceRepositoryId: source.sourceRepositoryId, remoteId: source.remote.remoteId, remoteUrl: source.remote.url,
        protocol: source.remote.protocol, strategy: fetched.strategy, refspecs: fetched.refspecs, sourceCommit: source.sourceCommit,
        sourceTree: source.sourceTree, objectFormat: source.objectFormat, releaseSourceDigest: source.releaseSourceDigest,
        unreachableObjects: allowedUnreachable, recordedAt: marker.preparedAt });
    }
  } else if (branchHead) {
    seedCommit = preparation?.gitRepository?.seedCommit ?? branchHead;
    const info = ensureCommitSubject(gitTool, root, seedCommit, seedSubject, seedTimestamp);
    seedTree = info.tree;
    if (verifyCommitTree(gitTool, root, seedCommit, baselineEntries) !== seedTree)
      fail('p5_git_seed_mismatch', 'The sanitized Git seed tree differs from the sealed source baseline.');
    if (preparation) {
      try { gitBytes(gitTool, root, ['merge-base', '--is-ancestor', seedCommit, branchHead]); }
      catch { fail('p5_git_branch_moved', 'The prepared Self-Repair branch no longer descends from its pinned synthetic seed.'); }
    } else {
      if (branchHead !== seedCommit) fail('p5_git_seed_mismatch', 'A private repository without a durable prepared record has an unexpected branch tip.');
      assertSeedWorktreeClean(gitTool, root);
    }
  } else {
    if (preparation) fail('p5_git_seed_missing', 'A journaled P5 Git repository lost its seed commit; no branch was reset or recreated.');
    addExactPaths(gitTool, root, baselineEntries);
    const expectedTree = verifyIndexTree(gitTool, root, baselineEntries);
    gitBytes(gitTool, root, ['-c', `user.name=${ENGINE_AUTHOR}`, '-c', `user.email=${ENGINE_EMAIL}`,
      '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--no-verify', '-m', seedSubject],
      { env: { GIT_AUTHOR_DATE: `@${seedTimestamp} +0000`, GIT_COMMITTER_DATE: `@${seedTimestamp} +0000` } });
    seedCommit = gitHash(gitTool, root, ['rev-parse', '--verify', 'HEAD^{commit}']);
    const info = assertCommitIdentity(gitTool, root, seedCommit, { tree: expectedTree, parent: null, subject: seedSubject, timestamp: seedTimestamp });
    seedTree = info.tree;
    verifyCommitTree(gitTool, root, seedCommit, baselineEntries);
    assertSeedWorktreeClean(gitTool, root);
  }
  const afterRefs = repositoryDetails(gitTool, root, baseline.gitObjectFormat, branch).refs;
  if (afterRefs.length !== 1 || afterRefs[0].name !== `refs/heads/${branch}` || !preparation && afterRefs[0].objectId !== seedCommit)
    fail('p5_git_seed_mismatch', 'P5 repository preparation found an unexpected branch tip or Git ref.');
  assertOnlyReachableObjects(gitTool, root, baseline.gitObjectFormat, allowedUnreachable);
  const gitDirectoryIdentity = await nativeRootIdentity(nativeSourceReader, repo.commonDirectory);
  const storage = await nativeStorageScan(nativeSourceReader, repo.commonDirectory);
  const finalRepo = repositoryDetails(gitTool, root, baseline.gitObjectFormat, branch);
  if (pathKey(finalRepo.commonDirectory) !== pathKey(repo.commonDirectory)
    || finalRepo.configDigest !== repo.configDigest || readExcludeDigest(finalRepo.commonDirectory) !== excludeFileDigest)
    fail('p5_git_repository_drift', 'The private Git metadata changed during repository preparation.');
  const finalStorage = await nativeStorageScan(nativeSourceReader, finalRepo.commonDirectory);
  if (canonicalHash(finalStorage.rootIdentity) !== canonicalHash(storage.rootIdentity)
    || finalStorage.snapshotDigest !== storage.snapshotDigest || finalStorage.pathDigest !== storage.pathDigest
    || finalStorage.contentDigest !== storage.contentDigest)
    fail('p5_git_repository_drift', 'The Rust Host Git metadata identity changed during repository preparation.');
  if (preparation?.gitRepository) {
    const old = preparation.gitRepository;
    if (old.seedCommit !== seedCommit || old.seedTree !== seedTree || old.repairBranch !== branch
      || old.allocationId !== intent.workspace.allocationId || pathKey(old.commonDirectory) !== pathKey(repo.commonDirectory)
      || canonicalHash(old.nativeDirectoryIdentity) !== canonicalHash(gitDirectoryIdentity.rootIdentity)
      || old.configurationDigest !== repo.configDigest || old.excludeFileDigest !== excludeFileDigest)
      fail('p5_git_prepared_record_mismatch', 'The repeated P5 preparation does not match the same private Git repository identity.');
    return old;
  }
  const record = { schemaVersion: 1, kind: 'ProtectedSelfRepairGitRepository', policy: enrollment.gitCandidatePolicy,
    allocationId: intent.workspace.allocationId, repositoryRoot: root, commonDirectory: repo.commonDirectory,
    nativeDirectoryIdentity: gitDirectoryIdentity.rootIdentity, sourceRepositoryIdentity: baseline.repositoryIdentity,
    sourceBaseCommit: baseline.baseCommit, seedCommit, seedTree, repairBranch: branch,
    objectFormat: baseline.gitObjectFormat, sourceAncestryVerified: clone, seedAncestryVerified: true,
    configurationDigest: repo.configDigest, excludeFileDigest, storageSnapshotDigest: finalStorage.snapshotDigest,
    preparedAt: marker.preparedAt, ...(clone ? { fetchProvenance, hostProtection } : {}) };
  validateP5Contract('gitRepository', record);
  return record;
}

function verifyIndexTree(gitTool, root, expectedEntries) {
  const tree = gitHash(gitTool, root, ['write-tree']);
  const records = parseTree(gitBytes(gitTool, root, ['ls-tree', '-rz', '--full-tree', '-l', tree]));
  if (records.length !== expectedEntries.length) fail('p5_git_index_mismatch', 'The private Git index contains an unexpected source path.');
  const blobs = readBlobBatch(gitTool, root, records);
  for (let index = 0; index < records.length; index++) {
    const record = records[index], entry = expectedEntries[index], blob = blobs.get(record.objectId);
    if (!entry || record.path !== entry.path || record.mode !== (entry.executable ? '100755' : '100644')
      || record.type !== 'blob' || record.byteSize !== entry.byteSize || !blob || blob.length !== entry.byteSize || sha256(blob) !== entry.sha256)
      fail('p5_git_index_mismatch', `The private Git index differs from the sealed source manifest at "${entry?.path ?? record.path}".`);
  }
  return tree;
}

function readIntentAndCandidate(store, candidateRef) {
  store.verifyRef(candidateRef);
  const candidate = store.readJson(candidateRef.artifactId);
  validateP5Contract('candidate', candidate);
  if (canonicalHash(candidate) !== candidateRef.sha256 || candidate.gitCandidate)
    fail('p5_git_candidate_invalid', 'Git commit creation requires the exact sealed source candidate without a prior Git binding.');
  for (const ref of [candidate.enrollment, candidate.baselineRef, candidate.sourceManifest, candidate.changeManifest,
    candidate.sourceBinding, candidate.selfRepairProfile, candidate.verificationPolicy, candidate.verificationInputs]) store.verifyRef(ref);
  const sourceManifest = store.readJson(candidate.sourceManifest.artifactId);
  const changeManifest = store.readJson(candidate.changeManifest.artifactId);
  validateP5Contract('sourceManifest', sourceManifest);
  validateP5Contract('changeManifest', changeManifest);
  if (sourceManifest.sourceDigest !== candidate.candidateSourceDigest || changeManifest.candidateId !== candidate.candidateId
    || changeManifest.candidateSourceDigest !== candidate.candidateSourceDigest || changeManifest.baselineId !== candidate.baselineId
    || changeManifest.linkId !== candidate.linkId || changeManifest.repairRunId !== candidate.repairRunId)
    fail('p5_git_candidate_invalid', 'The sealed candidate source and change manifests do not share exact candidate identity.');
  const source = verifyStoredSource(store, sourceManifest);
  return { candidate, sourceManifest, changeManifest, source };
}

async function verifyGitRepositoryBinding({ store, preparationRef, preparationIntentRef, intent, candidate, gitTool, nativeSourceReader, nativeToolIdentityReader,
  identityReader }) {
  store.verifyRef(preparationRef);
  const prepared = store.readJson(preparationRef.artifactId);
  validateP5Contract('workspacePreparation', prepared);
  if (canonicalHash(prepared) !== preparationRef.sha256 || !prepared.gitRepository
    || !journalHas(store, intent.repairRunId, 'self_repair.workspace_prepared', preparationRef)
    || canonicalHash(prepared.intent) !== canonicalHash(preparationIntentRef)
    || prepared.baselineId !== candidate.baselineId || prepared.gitRepository.allocationId !== candidate.workspace.allocationId
    || pathKey(prepared.sourceRoot) !== pathKey(candidate.workspace.sourceRoot))
    fail('p5_git_prepared_record_mismatch', 'The candidate does not refer to its exact prepared private Git workspace.');
  validateP5Contract('gitRepository', prepared.gitRepository);
  assertRepositoryPolicy(store, prepared.gitRepository, candidate);
  const gitInfo = await verifyP5GitToolIdentity({ gitTool, identityReader, nativeToolIdentityReader });
  if (gitInfo.sha256 !== gitTool.sha256) fail('p5_git_tool_mismatch', 'The Git executable identity changed after enrollment.');
  const liveGitDirectory = await nativeRootIdentity(nativeSourceReader, prepared.gitRepository.commonDirectory);
  if (canonicalHash(liveGitDirectory.rootIdentity) !== canonicalHash(prepared.gitRepository.nativeDirectoryIdentity))
    fail('p5_git_repository_identity_mismatch', 'The private Git directory identity changed after the prepared workspace was journaled.');
  return { prepared, repository: prepared.gitRepository };
}

/** Policy invariants of a prepared repository: a synthetic seed never claims ancestry; a managed clone starts at the installed commit. */
function assertRepositoryPolicy(store, repository, candidate) {
  const enrollment = store.readJson(candidate.enrollment.artifactId);
  const baseline = store.readJson(candidate.baselineRef.artifactId);
  const clone = isClone(repository.policy);
  if (repository.policy !== enrollment.gitCandidatePolicy || repository.sourceBaseCommit !== candidate.baseCommit
    || repository.objectFormat !== baseline.gitObjectFormat || repository.sourceAncestryVerified !== clone
    || clone && (repository.seedCommit !== candidate.baseCommit || repository.seedTree !== baseline.baseTree
      || !repository.fetchProvenance || !repository.hostProtection)
    || !clone && (repository.fetchProvenance || repository.hostProtection))
    fail('p5_git_prepared_record_mismatch', 'The Git preparation identity does not match its enrolled versioned candidate policy.');
  return clone;
}

/** Host boundary for a Git candidate: static rules, the base closure recorded at preparation, and the live candidate closure. */
async function assertGitHostBoundary(store, repository, root, changes) {
  const protection = repository.hostProtection ? readP5HostProtection(store, repository.hostProtection) : null;
  const candidateClosure = repository.hostProtection ? await deriveP5HostProtection({ sourceRoot: root, sourceCommit: repository.seedCommit }) : null;
  return assertP5HostBoundary({ changes, protection, candidateClosure });
}

function gitCommitIntentBody({ candidateRef, preparationRef, repository, candidate }) {
  const base = { schemaVersion: 1, kind: 'ProtectedSelfRepairGitCommitIntent',
    candidateManifest: asRef(candidateRef), workspacePreparation: asRef(preparationRef), gitRepository: repository,
    candidateId: candidate.candidateId, candidateSourceDigest: candidate.candidateSourceDigest,
    sourceManifest: candidate.sourceManifest, changeManifest: candidate.changeManifest,
    parentRunId: candidate.parentRunId, repairRunId: candidate.repairRunId, linkId: candidate.linkId,
    incidentId: candidate.incidentId, enrollment: candidate.enrollment, allocationId: candidate.workspace.allocationId,
    repairBranch: repository.repairBranch, seedCommit: repository.seedCommit, seedTree: repository.seedTree,
    commitTimestamp: Math.floor(Date.now() / 1000) };
  return { ...base, intentId: canonicalHash(base) };
}

function indexChangedPaths(gitTool, root, seedCommit) {
  return decodePathList(gitBytes(gitTool, root, ['diff', '--cached', '--no-renames', '--name-only', '-z', seedCommit, '--']), 'staged');
}

function assertWorkingDiffMatches(gitTool, root, seedCommit, changes) {
  const actual = workingPathLists(gitTool, root, seedCommit);
  const expected = [...new Set(changes.map(change => validateP5SourcePath(change.path)))].sort(compareText);
  if (actual.ignored.some(path => !expected.includes(path)) || canonicalHash(actual.paths) !== canonicalHash(expected))
    fail('p5_git_change_manifest_mismatch', 'The live Git diff and untracked paths do not match the Engine-derived P5 change manifest.');
}

/** Create the durable commit intent before any Engine staging or commit write occurs. */
export async function createP5GitCommitIntent({ store, candidateRef, preparationRef, gitTool, nativeSourceReader,
  nativeToolIdentityReader, identityReader = null }) {
  const { candidate, changeManifest, source } = readIntentAndCandidate(store, candidateRef);
  store.verifyRef(preparationRef);
  const prepared = store.readJson(preparationRef.artifactId);
  validateP5Contract('workspacePreparation', prepared);
  if (canonicalHash(prepared) !== preparationRef.sha256 || !prepared.intent)
    fail('p5_git_prepared_record_mismatch', 'The P5 Git commit requires its exact immutable prepared-workspace artifact.');
  const preparation = await assertDurablePreparation(store, prepared.intent);
  const { repository } = await verifyGitRepositoryBinding({ store, preparationRef, preparationIntentRef: asRef(prepared.intent),
    intent: preparation.intent, candidate, gitTool,
    nativeSourceReader, nativeToolIdentityReader, identityReader });
  const root = candidate.workspace.sourceRoot;
  const details = repositoryDetails(gitTool, root, repository.objectFormat, repository.repairBranch);
  if (details.refs.length !== 1 || details.refs[0].objectId !== repository.seedCommit)
    fail('p5_git_branch_moved', 'P5 commit intent requires the Engine-created seed at the exact Self-Repair branch tip.');
  assertCurrentRepairLink(store, candidate);
  if (indexChangedPaths(gitTool, root, repository.seedCommit).length)
    fail('p5_git_developer_index_write', 'P5 refuses Developer-authored Git staging before the Engine commit intent.');
  const actual = await assertSourceTree(root, source.entries, preparation.enrollment.budgets, nativeSourceReader, identityReader);
  if (actual.sourceDigest !== candidate.candidateSourceDigest) fail('p5_git_source_drift', 'The live source does not match the already sealed candidate.');
  assertWorkingDiffMatches(gitTool, root, repository.seedCommit, changeManifest.changes);
  verifyP5GitAttributes(gitTool, root, source.entries.map(entry => entry.path));
  await assertGitHostBoundary(store, repository, root, changeManifest.changes);
  const body = gitCommitIntentBody({ candidateRef, preparationRef, repository, candidate });
  validateP5Contract('gitCommitIntent', body);
  const existing = store.readEvents(candidate.repairRunId).filter(event => event.type === 'self_repair.git_commit_intent');
  if (existing.length > 1) fail('p5_git_journal_conflict', 'P5 found duplicate durable Git commit intents.');
  if (existing.length === 1) {
    const existingIntent = validateCommitIntent(store, existing[0].payload?.record);
    const { intentId: _existingId, commitTimestamp: _existingTimestamp, ...existingStable } = existingIntent;
    const { intentId: _newId, commitTimestamp: _newTimestamp, ...newStable } = body;
    if (canonicalHash(existingStable) !== canonicalHash(newStable))
      fail('p5_git_journal_conflict', 'A different Git commit intent already owns this P2 Repair candidate.');
    return { intent: existingIntent, intentRef: asRef(existing[0].payload.record) };
  }
  const artifact = store.putJson(body); store.verifyRef(artifact);
  const intentRef = asRef(artifact);
  store.transaction(() => {
    const current = store.readEvents(candidate.repairRunId).filter(event => event.type === 'self_repair.git_commit_intent');
    if (current.length > 1) fail('p5_git_journal_conflict', 'P5 found duplicate durable Git commit intents.');
    if (current.length === 1) {
      if (canonicalHash(current[0].payload?.record) !== canonicalHash(intentRef))
        fail('p5_git_journal_conflict', 'A different Git commit intent already owns this P2 Repair candidate.');
      return;
    }
    store.appendEvents(candidate.repairRunId, [{ type: 'self_repair.git_commit_intent', payload: { record: intentRef }, nodeInstanceId: null, attemptId: null }]);
  });
  return { intent: body, intentRef };
}

function validateCommitIntent(store, intentRef) {
  store.verifyRef(intentRef);
  const intent = store.readJson(intentRef.artifactId);
  validateP5Contract('gitCommitIntent', intent);
  if (canonicalHash(intent) !== intentRef.sha256 || !journalHas(store, intent.repairRunId, 'self_repair.git_commit_intent', intentRef))
    fail('p5_git_commit_intent_missing', 'P5 Git commit requires its exact durable, journaled Engine intent.');
  for (const ref of [intent.candidateManifest, intent.workspacePreparation, intent.enrollment]) store.verifyRef(ref);
  const { intentId, ...body } = intent;
  if (intentId !== canonicalHash(body)) fail('p5_git_commit_intent_mismatch', 'The durable Git commit intent identity is invalid.');
  return intent;
}

function assertCurrentRepairLink(store, candidate) {
  const link = store.get('SELECT * FROM run_links WHERE id = ? AND parent_run_id = ? AND repair_run_id = ?',
    candidate.linkId, candidate.parentRunId, candidate.repairRunId);
  const parent = store.get('SELECT state FROM runs WHERE id = ?', candidate.parentRunId);
  const repair = store.get('SELECT state FROM runs WHERE id = ?', candidate.repairRunId);
  if (!link || link.state !== 'open' || link.continuation_contract !== 'logical_policy'
    || !['suspension_requested', 'suspended_for_repair'].includes(link.parent_suspension_state)
    || link.incident_id !== candidate.incidentId || !parent || !repair || repair.state !== 'running'
    || !['running', 'waiting_for_user'].includes(parent.state))
    fail('p5_git_p2_authority_changed', 'P2 Repair or Parent authority changed before the private Git candidate commit.');
  return link;
}

async function currentGitState({ store, intent, nativeSourceReader, gitTool, nativeToolIdentityReader, identityReader }) {
  const { candidate, sourceManifest, changeManifest, source } = readIntentAndCandidate(store, intent.candidateManifest);
  assertCurrentRepairLink(store, candidate);
  store.verifyRef(intent.workspacePreparation);
  const preparation = store.readJson(intent.workspacePreparation.artifactId);
  validateP5Contract('workspacePreparation', preparation);
  if (canonicalHash(preparation) !== intent.workspacePreparation.sha256 || !preparation.gitRepository
    || canonicalHash(preparation.gitRepository) !== canonicalHash(intent.gitRepository))
    fail('p5_git_prepared_record_mismatch', 'The durable commit intent differs from the exact prepared Git repository.');
  const enrollment = store.readJson(candidate.enrollment.artifactId);
  validateP5Contract('enrollment', enrollment);
  if (enrollment.gitCandidatePolicy !== intent.gitRepository.policy || intent.candidateId !== candidate.candidateId
    || intent.candidateSourceDigest !== candidate.candidateSourceDigest || intent.parentRunId !== candidate.parentRunId
    || intent.repairRunId !== candidate.repairRunId || intent.linkId !== candidate.linkId || intent.incidentId !== candidate.incidentId
    || intent.allocationId !== candidate.workspace.allocationId || canonicalHash(intent.enrollment) !== canonicalHash(candidate.enrollment)
    || intent.repairBranch !== intent.gitRepository.repairBranch || intent.seedCommit !== intent.gitRepository.seedCommit
    || intent.seedTree !== intent.gitRepository.seedTree || intent.sourceManifest.sha256 !== candidate.sourceManifest.sha256
    || intent.changeManifest.sha256 !== candidate.changeManifest.sha256)
    fail('p5_git_commit_intent_mismatch', 'The durable Git commit intent no longer matches its exact P2 candidate lineage.');
  const gitInfo = await verifyP5GitToolIdentity({ gitTool, identityReader, nativeToolIdentityReader });
  if (gitInfo.sha256 !== gitTool.sha256 || gitTool.sha256 !== enrollment.toolIdentities.find(item => item.name === 'git')?.sha256)
    fail('p5_git_tool_mismatch', 'The pinned Git executable changed after candidate capture.');
  const root = candidate.workspace.sourceRoot;
  const details = repositoryDetails(gitTool, root, intent.gitRepository.objectFormat, intent.repairBranch);
  validateNoGitRedirects(details.commonDirectory);
  if (pathKey(details.commonDirectory) !== pathKey(intent.gitRepository.commonDirectory)
    || pathKey(details.gitDirectory) !== pathKey(intent.gitRepository.repositoryRoot + `${sep}.git`)
    || details.configDigest !== intent.gitRepository.configurationDigest
    || readExcludeDigest(details.commonDirectory) !== intent.gitRepository.excludeFileDigest)
    fail('p5_git_repository_identity_mismatch', 'The private Git common directory, controlled config or exclude file changed.');
  const nativeDirectory = await nativeRootIdentity(nativeSourceReader, details.commonDirectory);
  if (canonicalHash(nativeDirectory.rootIdentity) !== canonicalHash(intent.gitRepository.nativeDirectoryIdentity))
    fail('p5_git_repository_identity_mismatch', 'The private Git directory was replaced after preparation.');
  return { candidate, sourceManifest, changeManifest, source, preparation, enrollment, root, details };
}

function assertCandidateCommit(gitTool, root, intent, candidate, source, expectedChangePaths, allowedUnreachable = null) {
  const refs = repositoryDetails(gitTool, root, intent.gitRepository.objectFormat, intent.repairBranch).refs;
  if (refs.length !== 1 || refs[0].name !== `refs/heads/${intent.repairBranch}`)
    fail('p5_git_ref_unsupported', 'P5 refuses an unexpected ref in the private candidate repository.');
  const commit = refs[0].objectId;
  const info = readCommitInfo(gitTool, root, commit);
  if (info.subject !== `P5 candidate ${candidate.candidateId}` || info.parents.length !== 1 || info.parents[0] !== intent.seedCommit)
    fail('p5_git_branch_moved', 'The existing Self-Repair branch tip is not the exact Engine candidate commit for this intent.');
  const tree = verifyCommitTree(gitTool, root, commit, source.entries);
  assertCommitIdentity(gitTool, root, commit, { tree, parent: intent.seedCommit, subject: `P5 candidate ${candidate.candidateId}`,
    timestamp: intent.commitTimestamp });
  if (canonicalHash(commitChangedPaths(gitTool, root, intent.seedCommit, commit))
    !== canonicalHash(expectedChangePaths))
    fail('p5_git_change_manifest_mismatch', 'The existing Git commit diff differs from the sealed P5 change manifest.');
  assertOnlyReachableObjects(gitTool, root, intent.gitRepository.objectFormat, allowedUnreachable);
  return { candidateCommit: commit, candidateTree: tree };
}

/** Engine-owned stage/commit with recovery that recognizes the same exact already-created commit. */
export async function ensureP5GitCandidateCommit({ store, intentRef, nativeSourceReader, nativeToolIdentityReader,
  identityReader = null, faultPoint = null }) {
  const intent = validateCommitIntent(store, intentRef);
  const gitTool = { path: store.readJson(intent.enrollment.artifactId)?.toolIdentities?.find(item => item.name === 'git')?.path,
    sha256: store.readJson(intent.enrollment.artifactId)?.toolIdentities?.find(item => item.name === 'git')?.sha256 };
  if (!gitTool.path || !SHA256.test(gitTool.sha256 || '')) fail('p5_git_tool_unavailable', 'The durable Git commit intent has no pinned Git executable.');
  const state = await currentGitState({ store, intent, nativeSourceReader, gitTool, nativeToolIdentityReader, identityReader });
  const allowedUnreachable = allowedUnreachableFor(store, intent.gitRepository);
  const expectedPaths = [...new Set(state.changeManifest.changes.map(change => validateP5SourcePath(change.path)))].sort(compareText);
  const refs = state.details.refs;
  if (refs.length !== 1 || refs[0].name !== `refs/heads/${intent.repairBranch}`)
    fail('p5_git_ref_unsupported', 'P5 refuses a ref outside the exact Self-Repair branch.');
  const branchHead = refs[0].objectId;
  assertCurrentRepairLink(store, state.candidate);
  if (branchHead !== intent.seedCommit) {
    const live = await assertSourceTree(state.root, state.source.entries, state.enrollment.budgets, nativeSourceReader, identityReader);
    if (live.sourceDigest !== state.candidate.candidateSourceDigest)
      fail('p5_git_source_drift', 'The live private source changed after its Store-sealed Git candidate was committed.');
    const status = gitBytes(gitTool, state.root, ['status', '--porcelain=v2', '--untracked-files=all', '--ignored=matching', '-z']);
    if (status.length) fail('p5_git_source_drift', 'The committed private Git worktree is no longer clean.');
    const committed = assertCandidateCommit(gitTool, state.root, intent, state.candidate, state.source, expectedPaths, allowedUnreachable);
    return { ...committed, gitTool, state, recovered: true };
  }

  const live = await assertSourceTree(state.root, state.source.entries, state.enrollment.budgets, nativeSourceReader, identityReader);
  if (live.sourceDigest !== state.candidate.candidateSourceDigest)
    fail('p5_git_source_drift', 'The live private source changed after its Store-sealed P5 candidate was captured.');
  assertWorkingDiffMatches(gitTool, state.root, intent.seedCommit, state.changeManifest.changes);
  verifyP5GitAttributes(gitTool, state.root, state.source.entries.map(entry => entry.path));
  await assertGitHostBoundary(store, intent.gitRepository, state.root, state.changeManifest.changes);
  faultPoint?.('p5_before_git_commit');
  assertCurrentRepairLink(store, state.candidate);
  addExactPaths(gitTool, state.root, [...state.source.entries, ...state.changeManifest.changes.map(change => change.path)]);
  const candidateTree = verifyIndexTree(gitTool, state.root, state.source.entries);
  gitBytes(gitTool, state.root, ['-c', `user.name=${ENGINE_AUTHOR}`, '-c', `user.email=${ENGINE_EMAIL}`,
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--no-verify', '-m', `P5 candidate ${state.candidate.candidateId}`],
    { env: { GIT_AUTHOR_DATE: `@${intent.commitTimestamp} +0000`, GIT_COMMITTER_DATE: `@${intent.commitTimestamp} +0000` } });
  const candidateCommit = gitHash(gitTool, state.root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  faultPoint?.('p5_after_git_commit');
  assertCommitIdentity(gitTool, state.root, candidateCommit, { tree: candidateTree, parent: intent.seedCommit,
    subject: `P5 candidate ${state.candidate.candidateId}`, timestamp: intent.commitTimestamp });
  verifyCommitTree(gitTool, state.root, candidateCommit, state.source.entries);
  if (canonicalHash(commitChangedPaths(gitTool, state.root, intent.seedCommit, candidateCommit)) !== canonicalHash(expectedPaths))
    fail('p5_git_change_manifest_mismatch', 'The Engine-created Git diff differs from the sealed P5 change manifest.');
  assertSeedWorktreeClean(gitTool, state.root);
  assertCurrentRepairLink(store, state.candidate);
  const finalDetails = repositoryDetails(gitTool, state.root, intent.gitRepository.objectFormat, intent.repairBranch);
  if (finalDetails.refs.length !== 1 || finalDetails.refs[0].objectId !== candidateCommit)
    fail('p5_git_branch_moved', 'The private Self-Repair branch changed during Engine candidate commit creation.');
  const nativeDirectory = await nativeRootIdentity(nativeSourceReader, finalDetails.commonDirectory);
  if (canonicalHash(nativeDirectory.rootIdentity) !== canonicalHash(intent.gitRepository.nativeDirectoryIdentity))
    fail('p5_git_repository_identity_mismatch', 'The private Git directory was replaced during Engine candidate commit creation.');
  assertOnlyReachableObjects(gitTool, state.root, intent.gitRepository.objectFormat, allowedUnreachable);
  return { candidateCommit, candidateTree, gitTool, state, recovered: false };
}

function candidateGitIdentityId(body) {
  const { candidateGitId: _ignored, ...identity } = body;
  return canonicalHash(identity);
}

/** Persist the acyclic Git binding after a verified commit; repeated recovery reuses the same commit. */
export async function bindP5GitCandidate({ store, intentRef, nativeSourceReader, nativeToolIdentityReader,
  identityReader = null, capturedAt = null, faultPoint = null }) {
  const commitResult = await ensureP5GitCandidateCommit({ store, intentRef, nativeSourceReader, nativeToolIdentityReader, identityReader, faultPoint });
  const commitIntent = validateCommitIntent(store, intentRef);
  const { candidate, sourceManifest, changeManifest, source } = readIntentAndCandidate(store, commitIntent.candidateManifest);
  const gitTool = commitResult.gitTool, state = commitResult.state, root = state.root;
  const expectedChangePaths = [...new Set(changeManifest.changes.map(change => validateP5SourcePath(change.path)))].sort(compareText);
  const commit = assertCandidateCommit(gitTool, root, commitIntent, candidate, source, expectedChangePaths,
    allowedUnreachableFor(store, commitIntent.gitRepository));
  const storage = await nativeStorageScan(nativeSourceReader, state.details.commonDirectory);
  if (canonicalHash(storage.rootIdentity) !== canonicalHash(commitIntent.gitRepository.nativeDirectoryIdentity))
    fail('p5_git_repository_identity_mismatch', 'The private Git directory identity changed before the candidate binding was sealed.');
  const detailsAfter = repositoryDetails(gitTool, root, commitIntent.gitRepository.objectFormat, commitIntent.repairBranch);
  if (detailsAfter.refs.length !== 1 || detailsAfter.refs[0].objectId !== commit.candidateCommit
    || detailsAfter.configDigest !== commitIntent.gitRepository.configurationDigest
    || readExcludeDigest(detailsAfter.commonDirectory) !== commitIntent.gitRepository.excludeFileDigest)
    fail('p5_git_branch_moved', 'The private branch or Git metadata changed before the Git candidate binding was sealed.');
  const storageAfter = await nativeStorageScan(nativeSourceReader, detailsAfter.commonDirectory);
  if (canonicalHash(storageAfter.rootIdentity) !== canonicalHash(storage.rootIdentity)
    || storageAfter.snapshotDigest !== storage.snapshotDigest || storageAfter.pathDigest !== storage.pathDigest
    || storageAfter.contentDigest !== storage.contentDigest)
    fail('p5_git_repository_drift', 'The private Git storage changed while the candidate binding was being sealed.');
  const repository = commitIntent.gitRepository;
  const git = { historyPolicy: repository.policy, sourceBaseCommit: candidate.baseCommit,
    seedCommit: repository.seedCommit, seedTree: repository.seedTree, repairBranch: repository.repairBranch,
    candidateCommit: commit.candidateCommit, candidateTree: commit.candidateTree, objectFormat: repository.objectFormat,
    sourceAncestryVerified: isClone(repository.policy), seedAncestryVerified: true,
    storageSnapshotDigest: storage.snapshotDigest, storagePathDigest: storage.pathDigest, storageContentDigest: storage.contentDigest,
    configurationDigest: detailsAfter.configDigest, excludeFileDigest: readExcludeDigest(detailsAfter.commonDirectory) };
  const body = { schemaVersion: 1, kind: 'ProtectedSelfRepairGitCandidate', candidateGitId: '0'.repeat(64),
    candidateId: candidate.candidateId, baseCandidate: commitIntent.candidateManifest, commitIntent: asRef(intentRef),
    enrollment: candidate.enrollment, repository, sourceRepositoryIdentity: candidate.repositoryIdentity,
    parentPublication: candidate.parentPublication, repairPublication: candidate.repairPublication,
    parentRunId: candidate.parentRunId, repairRunId: candidate.repairRunId, linkId: candidate.linkId, incidentId: candidate.incidentId,
    git, source: { baselineId: candidate.baselineId, baselineDigest: candidate.baseSourceDigest,
      candidateDigest: candidate.candidateSourceDigest, sourceManifest: candidate.sourceManifest, changeManifest: candidate.changeManifest },
    ...(repository.hostProtection ? { hostProtection: repository.hostProtection } : {}),
    capturedAt: capturedAt ?? candidate.capturedAt };
  body.candidateGitId = candidateGitIdentityId(body);
  validateP5Contract('gitCandidate', body);
  const existingBinding = store.readEvents(candidate.repairRunId).filter(event => event.type === 'self_repair.candidate_captured')
    .map(event => event.payload?.record).filter(Boolean);
  if (existingBinding.length > 1) fail('p5_git_candidate_conflict', 'P5 found duplicate candidate capture records.');
  const gitArtifact = store.putJson(body); store.verifyRef(gitArtifact);
  const finalCandidate = { ...candidate, gitCandidate: asRef(gitArtifact) };
  validateP5Contract('candidate', finalCandidate);
  const candidateArtifact = store.putJson(finalCandidate); store.verifyRef(candidateArtifact);
  return { gitCandidate: body, gitCandidateArtifact: asRef(gitArtifact), candidate: finalCandidate,
    candidateArtifact: asRef(candidateArtifact), candidateCommit: commit.candidateCommit, candidateTree: commit.candidateTree,
    sourceManifest, changeManifest, recovered: commitResult.recovered };
}

/** Verify an immutable committed candidate and refuse a moved branch or changed working tree. */
export async function verifyP5GitCandidateCurrent({ store, candidateRef, nativeSourceReader, nativeToolIdentityReader,
  identityReader = null, expectedGitCandidateRef = null }) {
  store.verifyRef(candidateRef);
  const candidate = store.readJson(candidateRef.artifactId);
  validateP5Contract('candidate', candidate);
  if (canonicalHash(candidate) !== candidateRef.sha256 || !candidate.gitCandidate)
    fail('p5_git_candidate_missing', 'The P5 source candidate has no Git candidate binding.');
  if (expectedGitCandidateRef && canonicalHash(expectedGitCandidateRef) !== canonicalHash(candidate.gitCandidate))
    fail('p5_git_candidate_mismatch', 'The candidate Git binding differs from the captured verification subject.');
  store.verifyRef(candidate.gitCandidate);
  const binding = store.readJson(candidate.gitCandidate.artifactId);
  validateP5Contract('gitCandidate', binding);
  if (canonicalHash(binding) !== candidate.gitCandidate.sha256 || binding.candidateId !== candidate.candidateId
    || binding.candidateGitId !== candidateGitIdentityId(binding)
    || binding.source.candidateDigest !== candidate.candidateSourceDigest || binding.source.baselineDigest !== candidate.baseSourceDigest
    || binding.source.baselineId !== candidate.baselineId || canonicalHash(binding.source.sourceManifest) !== canonicalHash(candidate.sourceManifest)
    || canonicalHash(binding.source.changeManifest) !== canonicalHash(candidate.changeManifest)
    || binding.parentRunId !== candidate.parentRunId || binding.repairRunId !== candidate.repairRunId
    || binding.linkId !== candidate.linkId || binding.incidentId !== candidate.incidentId
    || canonicalHash(binding.sourceRepositoryIdentity) !== canonicalHash(candidate.repositoryIdentity)
    || canonicalHash(binding.enrollment) !== canonicalHash(candidate.enrollment)
    || canonicalHash(binding.parentPublication) !== canonicalHash(candidate.parentPublication)
    || canonicalHash(binding.repairPublication) !== canonicalHash(candidate.repairPublication))
    fail('p5_git_candidate_mismatch', 'The Git candidate binding differs from the exact source candidate, enrollment or P2 publication identities.');
  store.verifyRef(candidate.enrollment);
  const enrollment = store.readJson(candidate.enrollment.artifactId);
  validateP5Contract('enrollment', enrollment);
  const gitRows = enrollment.toolIdentities.filter(item => item.name === 'git');
  if (gitRows.length !== 1) fail('p5_git_tool_unavailable', 'P5 candidate enrollment must retain exactly one pinned Git executable.');
  const gitTool = { path: gitRows[0].path, sha256: gitRows[0].sha256 };
  await verifyP5GitToolIdentity({ gitTool, identityReader, nativeToolIdentityReader });
  const root = candidate.workspace.sourceRoot, repository = binding.repository, git = binding.git;
  if (pathKey(root) !== pathKey(repository.repositoryRoot) || repository.allocationId !== candidate.workspace.allocationId
    || canonicalHash(repository.sourceRepositoryIdentity) !== canonicalHash(candidate.repositoryIdentity)
    || repository.seedCommit !== git.seedCommit || repository.seedTree !== git.seedTree
    || repository.repairBranch !== git.repairBranch || repository.objectFormat !== git.objectFormat
    || git.historyPolicy !== repository.policy || git.sourceBaseCommit !== candidate.baseCommit
    || git.sourceAncestryVerified !== isClone(repository.policy)
    || canonicalHash(binding.hostProtection ?? null) !== canonicalHash(repository.hostProtection ?? null))
    fail('p5_git_repository_identity_mismatch', 'The Git candidate repository does not match its source allocation and versioned history policy.');
  assertRepositoryPolicy(store, repository, candidate);
  const details = repositoryDetails(gitTool, root, git.objectFormat, git.repairBranch);
  validateNoGitRedirects(details.commonDirectory);
  if (pathKey(details.commonDirectory) !== pathKey(repository.commonDirectory)
    || details.configDigest !== git.configurationDigest || readExcludeDigest(details.commonDirectory) !== git.excludeFileDigest)
    fail('p5_git_repository_identity_mismatch', 'The private Git common directory, controlled config or exclude file changed after candidate capture.');
  const currentRootIdentity = await nativeRootIdentity(nativeSourceReader, details.commonDirectory);
  if (canonicalHash(currentRootIdentity.rootIdentity) !== canonicalHash(repository.nativeDirectoryIdentity))
    fail('p5_git_repository_identity_mismatch', 'The private Git directory identity differs from the exact directory prepared for this P5 allocation.');
  if (details.refs.length !== 1 || details.refs[0].name !== `refs/heads/${git.repairBranch}`
    || details.refs[0].objectId !== git.candidateCommit)
    fail('p5_git_branch_moved', 'The exact Self-Repair branch no longer points at the captured candidate commit.');
  const commitIntent = validateCommitIntent(store, binding.commitIntent);
  if (canonicalHash(commitIntent.candidateManifest) !== canonicalHash(binding.baseCandidate)
    || commitIntent.candidateId !== candidate.candidateId || commitIntent.candidateSourceDigest !== candidate.candidateSourceDigest
    || commitIntent.gitRepository.seedCommit !== git.seedCommit || commitIntent.gitRepository.repairBranch !== git.repairBranch)
    fail('p5_git_candidate_mismatch', 'The immutable Git candidate is not bound to its journaled Engine commit intent.');
  const { candidate: baseCandidate } = readIntentAndCandidate(store, binding.baseCandidate);
  const { gitCandidate: _gitCandidate, ...sourceCandidate } = candidate;
  if (canonicalHash(baseCandidate) !== canonicalHash(sourceCandidate))
    fail('p5_git_candidate_mismatch', 'The Git candidate does not bind the complete immutable source candidate it extends.');
  const commit = assertCommitIdentity(gitTool, root, git.candidateCommit, { tree: git.candidateTree, parent: git.seedCommit,
    subject: `P5 candidate ${candidate.candidateId}`, timestamp: commitIntent.commitTimestamp });
  const sourceManifest = store.readJson(candidate.sourceManifest.artifactId);
  const expected = verifyStoredSource(store, sourceManifest);
  const tree = verifyCommitTree(gitTool, root, git.candidateCommit, expected.entries);
  if (tree !== git.candidateTree || commit.tree !== git.candidateTree)
    fail('p5_git_tree_mismatch', 'The immutable candidate commit/tree differs from the Git candidate binding.');
  const live = await assertSourceTree(root, expected.entries, enrollment.budgets,
    nativeSourceReader, identityReader);
  if (live.sourceDigest !== candidate.candidateSourceDigest)
    fail('p5_git_source_drift', 'The live private Git worktree no longer matches the committed and sealed candidate.');
  const changedPaths = commitChangedPaths(gitTool, root, git.seedCommit, git.candidateCommit);
  const changeManifest = store.readJson(candidate.changeManifest.artifactId);
  const expectedChanges = [...new Set(changeManifest.changes.map(change => validateP5SourcePath(change.path)))].sort(compareText);
  if (canonicalHash(changedPaths) !== canonicalHash(expectedChanges))
    fail('p5_git_change_manifest_mismatch', 'The committed Git diff differs from the Engine-derived P5 change manifest.');
  const status = gitBytes(gitTool, root, ['status', '--porcelain=v2', '--untracked-files=all', '--ignored=matching', '-z']);
  if (status.length) fail('p5_git_source_drift', 'The committed private Git working tree is no longer clean.');
  if (isClone(repository.policy)) {
    try { gitBytes(gitTool, root, ['merge-base', '--is-ancestor', git.sourceBaseCommit, git.candidateCommit]); }
    catch { fail('p5_git_source_ancestry_mismatch', 'The candidate commit does not descend from the installed source commit.'); }
  }
  await assertGitHostBoundary(store, repository, root, changeManifest.changes);
  assertOnlyReachableObjects(gitTool, root, git.objectFormat, allowedUnreachableFor(store, repository));
  const storage = await nativeStorageScan(nativeSourceReader, details.commonDirectory);
  if (canonicalHash(storage.rootIdentity) !== canonicalHash(repository.nativeDirectoryIdentity))
    fail('p5_git_repository_identity_mismatch', 'The private Git directory identity differs from the prepared workspace repository.');
  if (storage.snapshotDigest !== git.storageSnapshotDigest || storage.pathDigest !== git.storagePathDigest
    || storage.contentDigest !== git.storageContentDigest)
    fail('p5_git_metadata_drift', 'The verified private Git metadata changed after the Engine candidate commit.');
  const finalDetails = repositoryDetails(gitTool, root, git.objectFormat, git.repairBranch);
  if (finalDetails.refs.length !== 1 || finalDetails.refs[0].name !== `refs/heads/${git.repairBranch}`
    || finalDetails.refs[0].objectId !== git.candidateCommit)
    fail('p5_git_branch_moved', 'The private Self-Repair branch moved while its candidate was being verified.');
  if (finalDetails.configDigest !== git.configurationDigest || readExcludeDigest(finalDetails.commonDirectory) !== git.excludeFileDigest)
    fail('p5_git_metadata_drift', 'The private Git configuration or exclude file changed while its candidate was being verified.');
  const finalStorage = await nativeStorageScan(nativeSourceReader, finalDetails.commonDirectory);
  if (canonicalHash(finalStorage.rootIdentity) !== canonicalHash(storage.rootIdentity)
    || finalStorage.snapshotDigest !== storage.snapshotDigest || finalStorage.pathDigest !== storage.pathDigest
    || finalStorage.contentDigest !== storage.contentDigest)
    fail('p5_git_metadata_drift', 'The private Git metadata changed while its candidate was being verified.');
  return { candidate, gitCandidate: binding, gitCandidateRef: candidate.gitCandidate,
    candidateCommit: git.candidateCommit, candidateTree: git.candidateTree,
    sourceDigest: candidate.candidateSourceDigest, storageSnapshotDigest: storage.snapshotDigest };
}


// P5-FINAL §8.2: authorized repair-branch publication, a separately requested external side effect that never follows from a
// model decision. It writes exactly one ref (refs/heads/self-repair/<link>) on exactly the enrolled remote, create-only: the
// push carries a lease whose expected value is "absent", so an existing ref is never overwritten, and no force, merge or main
// update exists. A durable intent precedes the push; an uncertain outcome is reconciled by reading that remote ref, never by
// repeating the write. The Owner grants publication through the installation-owned enrollment policy only.
export const P5_GIT_PUBLICATION_EVENTS = Object.freeze(['self_repair.publication_intent', 'self_repair.publication_recorded']);

export function evaluateP5GitPublication({ store, handoffRef, observedRemoteObjectId = null, eligibility }) {
  const reasons = [];
  store.verifyRef(handoffRef);
  const handoff = store.readJson(handoffRef.artifactId);
  validateP5Contract('handoff', handoff);
  if (!handoff.gitCandidate) return { authorized: false, reasons: ['no_git_candidate'], plan: null };
  store.verifyRef(handoff.gitCandidate);
  const binding = store.readJson(handoff.gitCandidate.artifactId);
  validateP5Contract('gitCandidate', binding);
  store.verifyRef(handoff.enrollment);
  const enrollment = store.readJson(handoff.enrollment.artifactId);
  validateP5Contract('enrollment', enrollment);
  const policy = enrollment.gitSource?.publication;
  if (!isClone(binding.git.historyPolicy) || !policy) reasons.push('policy_unenrolled');
  else {
    if (policy.enabled !== true) reasons.push('publication_disabled');
    if (policy.remoteId !== enrollment.gitSource.remote.remoteId) reasons.push('remote_not_authorized');
    if (policy.requireExpectedRemoteState !== true || policy.allowMerge !== false) reasons.push('publication_policy_unsupported');
  }
  const ref = `refs/heads/${binding.git.repairBranch}`;
  if (!ref.startsWith(policy?.refNamespace ?? 'refs/heads/self-repair/') || !/^refs\/heads\/self-repair\/[a-f0-9]{12}$/.test(ref)) reasons.push('ref_outside_namespace');
  if (handoff.authority.sourceCandidateAccepted !== true || handoff.authority.branchPublished !== false) reasons.push('acceptance_missing');
  if (handoff.authority.hostModificationAuthorized !== false || handoff.authority.hostUpdateAuthorized !== false) reasons.push('host_authority_claimed');
  if (handoff.currentEligibility?.eligible !== true || handoff.currentEligibility?.candidateCommit !== binding.git.candidateCommit) reasons.push('eligibility_mismatch');
  if (!handoff.p2Approval || !handoff.verificationReceipt) reasons.push('approval_or_receipt_missing');
  // The live Engine eligibility, not the historical handoff alone: an invalidated, stopped or uncertain repair never publishes.
  if (!eligibility || eligibility.stage !== 'retained_for_p6' || eligibility.issues?.length || eligibility.parentStopped !== false
    || eligibility.handoffId !== handoff.handoffId) reasons.push('handoff_not_current');
  if (observedRemoteObjectId !== null && observedRemoteObjectId !== binding.git.candidateCommit) reasons.push('remote_ref_conflict');
  const plan = reasons.length ? null : { remoteId: policy.remoteId, remoteUrl: enrollment.gitSource.remote.url, protocol: enrollment.gitSource.remote.protocol,
    ref, commit: binding.git.candidateCommit, tree: binding.git.candidateTree, handoffId: handoff.handoffId, candidateId: handoff.candidateId,
    alreadyPublished: observedRemoteObjectId === binding.git.candidateCommit };
  return { authorized: reasons.length === 0, reasons, plan, handoff, binding };
}

function remoteGitArgs(protocol) {
  return ['-c', 'protocol.allow=never', '-c', `protocol.${protocol}.allow=always`, '-c', 'credential.helper=', '-c', 'core.askPass=',
    '-c', 'http.followRedirects=false', '-c', 'push.gpgSign=false', '-c', 'push.recurseSubmodules=no'];
}

/** The exact object the remote ref names now, or null when the ref is absent. Read-only, never blocking the Engine. */
async function observeRemoteRef(gitTool, root, plan) {
  const text = (await runP5GitCommandAsync(gitTool, root, [...remoteGitArgs(plan.protocol), 'ls-remote', '--refs', plan.remoteUrl, plan.ref]))
    .toString('utf8');
  const rows = text.split(/\r?\n/).filter(Boolean).map(line => line.split('\t'));
  if (rows.length > 1 || rows.some(([oid, name]) => name !== plan.ref || !REF_SHA.test(oid)))
    fail('p5_publication_remote_unreadable', 'The authorized remote returned an unexpected ref listing.');
  return rows[0]?.[0] ?? null;
}

function publicationRecords(store, repairRunId) {
  const events = store.readEvents(repairRunId);
  const read = type => events.filter(item => item.type === type).map(item => ({ event: item, ref: item.payload.record, value: store.readJson(item.payload.record.artifactId) }));
  const intents = read('self_repair.publication_intent'), results = read('self_repair.publication_recorded');
  const open = intents.find(item => !results.some(result => canonicalHash(result.value.intent) === canonicalHash(item.ref))) ?? null;
  return { intents, results, open };
}

function settlePublication(store, appendEvent, intentRef, intent, status, remoteObjectId, { pushed, reconciled, reason = null }) {
  const result = { schemaVersion: 1, kind: 'ProtectedSelfRepairGitPublicationResult', intent: asRef(intentRef), handoffId: intent.handoffId,
    remoteId: intent.remoteId, ref: intent.ref, commit: intent.commit, status, remoteObjectId, pushed, reconciled,
    ...(reason ? { reason } : {}), recordedAt: new Date().toISOString() };
  validateP5Contract('gitPublicationResult', result);
  const resultRef = putVerified(store, result);
  appendEvent({ type: 'self_repair.publication_recorded', payload: { record: resultRef }, nodeInstanceId: null, attemptId: null });
  return { ...result, resultRef };
}

/**
 * P5-CLOSURE F9, admission (no network I/O): validate the exact accepted candidate, live eligibility and the private branch,
 * then durably journal the create-only publication intent. A recorded publication is replayed, never repeated; an open
 * intent is returned for reconciliation. Execution is `executeP5GitPublication`, independent of the requesting connection.
 */
export async function requestP5GitPublication({ store, repairRunId, handoffRef, gitTool, eligibility, appendEvent, verifyCurrent }) {
  if (typeof verifyCurrent !== 'function') fail('p5_publication_refused', 'Publication requires the live Git candidate verification of the Engine.');
  const evaluation = evaluateP5GitPublication({ store, handoffRef, eligibility });
  const prior = publicationRecords(store, repairRunId);
  // Replay: a recorded publication of this handoff is returned as it is (historical, with today's eligibility); never pushed again.
  const published = prior.results.find(item => item.value.status === 'published');
  if (published) {
    if (published.value.handoffId !== evaluation.handoff?.handoffId
      || evaluation.binding && published.value.commit !== evaluation.binding.git.candidateCommit)
      fail('p5_publication_conflict', 'A different handoff or commit was already published for this Repair.');
    return { ...published.value, resultRef: published.ref, replay: true, currentlyEligible: evaluation.authorized };
  }
  if (!evaluation.handoff) fail('p5_publication_refused', `P5 publication is not authorized: ${evaluation.reasons.join(', ')}.`);
  // A conflict recorded for this remote ref is final: a different object there is never overwritten.
  store.verifyRef(evaluation.handoff.enrollment);
  const remoteUrl = store.readJson(evaluation.handoff.enrollment.artifactId).gitSource?.remote?.url;
  if (prior.results.some(item => item.value.status === 'conflict' && store.readJson(item.value.intent.artifactId).remoteUrl === remoteUrl))
    fail('p5_publication_conflict', 'The authorized remote holds a different commit at this repair ref; it is never overwritten.');
  // An earlier write may or may not have landed: the open intent is reconciled by its executor, never superseded.
  if (prior.open) return { status: 'intent_recorded', intentRef: prior.open.ref, ref: prior.open.value.ref, commit: prior.open.value.commit, reconcile: true };
  if (!evaluation.authorized) fail('p5_publication_refused', `P5 publication is not authorized: ${evaluation.reasons.join(', ')}.`);
  const { plan } = evaluation;
  store.verifyRef(evaluation.handoff.candidate);
  const sourceRoot = store.readJson(evaluation.handoff.candidate.artifactId).workspace.sourceRoot;
  // The full live Git candidate check (config allowlist, storage snapshot, branch, commit and tree) precedes the intent.
  await verifyCurrent();
  if (gitText(gitTool, sourceRoot, ['rev-parse', '--verify', `${plan.ref}^{commit}`]) !== plan.commit
    || gitText(gitTool, sourceRoot, ['rev-parse', '--verify', `${plan.commit}^{tree}`]) !== plan.tree)
    fail('p5_publication_source_mismatch', 'The private repair branch no longer names the exact accepted commit and tree.');
  const intent = { schemaVersion: 1, kind: 'ProtectedSelfRepairGitPublicationIntent', handoff: asRef(handoffRef), handoffId: plan.handoffId,
    candidateId: plan.candidateId, remoteId: plan.remoteId, remoteUrl: plan.remoteUrl, ref: plan.ref, commit: plan.commit, tree: plan.tree,
    expectedRemoteState: 'absent', requestedAt: new Date().toISOString() };
  validateP5Contract('gitPublicationIntent', intent);
  const intentRef = putVerified(store, intent);
  appendEvent({ type: 'self_repair.publication_intent', payload: { record: intentRef }, nodeInstanceId: null, attemptId: null });
  return { status: 'intent_recorded', intentRef, ref: plan.ref, commit: plan.commit, reconcile: false };
}

/**
 * Execute or reconcile the one open publication intent of this Repair. The remote ref is read first: the exact commit is
 * recorded as published, any other object as a conflict (never overwritten). Only an absent ref is written, create-only, and
 * only if the Repair is still eligible immediately before the write (`currentEligibility()`, re-evaluated here), so a Stop
 * that lands while the request waits prevents the push. A recorded success is never revoked; a write whose outcome is
 * unknown is reconciled by reading the ref again, now or after an Engine restart. `faultAfterPush` is a test fault point.
 */
export async function executeP5GitPublication({ store, repairRunId, handoffRef, gitTool, currentEligibility, appendEvent, verifyCurrent,
  faultAfterPush = null }) {
  const prior = publicationRecords(store, repairRunId);
  if (!prior.open) return prior.results.at(-1) ? { ...prior.results.at(-1).value, resultRef: prior.results.at(-1).ref } : null;
  const intent = prior.open.value, intentRef = prior.open.ref;
  store.verifyRef(handoffRef);
  const handoff = store.readJson(handoffRef.artifactId);
  validateP5Contract('handoff', handoff);
  if (handoff.handoffId !== intent.handoffId) fail('p5_publication_conflict', 'The open publication intent belongs to another handoff.');
  store.verifyRef(handoff.enrollment);
  const enrollment = store.readJson(handoff.enrollment.artifactId);
  if (intent.remoteUrl !== enrollment.gitSource.remote.url) fail('p5_publication_conflict', 'The open publication intent names another remote.');
  store.verifyRef(handoff.candidate);
  const sourceRoot = store.readJson(handoff.candidate.artifactId).workspace.sourceRoot;
  const plan = { protocol: enrollment.gitSource.remote.protocol, remoteUrl: intent.remoteUrl, ref: intent.ref };
  const settle = (status, observed, options) => settlePublication(store, appendEvent, intentRef, intent, status, observed, options);
  const before = await observeRemoteRef(gitTool, sourceRoot, plan);
  if (before === intent.commit) return settle('published', before, { pushed: false, reconciled: true });
  if (before !== null) return settle('conflict', before, { pushed: false, reconciled: true });
  // Absent: write only for a still-eligible handoff, with the live Git candidate checked again just before the write.
  const evaluation = evaluateP5GitPublication({ store, handoffRef, eligibility: currentEligibility() });
  if (!evaluation.authorized || evaluation.plan.commit !== intent.commit || evaluation.plan.ref !== intent.ref)
    return settle('not_published', null, { pushed: false, reconciled: true,
      reason: `The repair is no longer eligible for publication: ${evaluation.reasons.join(', ') || 'intent_mismatch'}.` });
  await verifyCurrent();
  // Stop may land during the asynchronous live check: eligibility is decided again, synchronously, right before the write.
  const final = evaluateP5GitPublication({ store, handoffRef, eligibility: currentEligibility() });
  if (!final.authorized)
    return settle('not_published', null, { pushed: false, reconciled: true, reason: `The repair is no longer eligible for publication: ${final.reasons.join(', ')}.` });
  let pushError = null;
  try {
    await runP5GitCommandAsync(gitTool, sourceRoot, [...remoteGitArgs(plan.protocol), 'push', '--porcelain', '--no-verify', '--atomic',
      `--force-with-lease=${intent.ref}:`, intent.remoteUrl, `${intent.commit}:${intent.ref}`]);
  } catch (error) { pushError = error; }
  if (faultAfterPush) await faultAfterPush({ pushError });
  const observed = await observeRemoteRef(gitTool, sourceRoot, plan);
  return settle(observed === intent.commit ? 'published' : observed === null ? 'not_published' : 'conflict', observed,
    { pushed: pushError === null, reconciled: pushError !== null });
}

/** The durable publication state of a Repair, for the Owner API. `executing` is whether this Engine is running its intent. */
export function p5GitPublicationStatus({ store, repairRunId, executing = false }) {
  const prior = publicationRecords(store, repairRunId);
  const last = prior.results.at(-1) ?? null;
  if (prior.open) return { state: executing ? 'executing' : 'held_uncertain', intent: prior.open.ref, ref: prior.open.value.ref,
    commit: prior.open.value.commit, result: null };
  if (!last) return { state: 'not_requested', intent: null, result: null };
  return { state: last.value.status, intent: last.value.intent, ref: last.value.ref, commit: last.value.commit, result: last.ref,
    pushed: last.value.pushed, reconciled: last.value.reconciled, reason: last.value.reason ?? null };
}

/** Request and execute in one awaited call (bounded suites and tools). The Engine route admits and executes separately. */
export async function publishP5GitCandidate({ store, repairRunId, handoffRef, gitTool, eligibility, appendEvent, verifyCurrent, faultAfterPush = null }) {
  const admitted = await requestP5GitPublication({ store, repairRunId, handoffRef, gitTool, eligibility, appendEvent, verifyCurrent });
  if (admitted.replay) return admitted;
  return executeP5GitPublication({ store, repairRunId, handoffRef, gitTool, currentEligibility: () => eligibility, appendEvent, verifyCurrent, faultAfterPush });
}
