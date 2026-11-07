// Source snapshot for P6-FINAL-ACCEPTANCE. Method (documented in the acceptance report): every path listed by
// `git ls-files --cached --others --exclude-standard` (tracked, plus untracked and not ignored), excluding `.deszo/` (test-owned
// state) and `docs/reviews/evidence/` (mutable evidence written by the test runs), sorted by path; each entry is
// `path NUL sha256(bytes) newline`; the snapshot digest is the SHA-256 of the concatenation. Usage: node freeze.mjs <repo> <outManifest>
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repo = resolve(process.argv[2]);
const out = resolve(process.argv[3]);
const GIT = 'C:\\Program Files\\Git\\cmd\\git.exe';
const EXCLUDED = [/^\.deszo\//, /^docs\/reviews\/evidence\//];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const git = args => execFileSync(GIT, args, { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28 });

const listed = git(['ls-files', '--cached', '--others', '--exclude-standard']).split('\n').filter(Boolean)
  .map(path => path.replaceAll('\\', '/'));
const included = [...new Set(listed)].filter(path => !EXCLUDED.some(rx => rx.test(path))).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const files = included.map(path => {
  const absolute = join(repo, ...path.split('/'));
  const bytes = readFileSync(absolute);
  return { path, bytes: bytes.length, sha256: sha256(bytes) };
});
const digest = sha256(Buffer.from(files.map(file => `${file.path}\0${file.sha256}\n`).join(''), 'utf8'));

const tracked = git(['ls-files']).split('\n').filter(Boolean);
const modified = git(['diff', '--name-only']).split('\n').filter(Boolean);
const untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
const head = git(['rev-parse', 'HEAD']).trim();
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
const artifact = path => (existsSync(join(repo, path)) ? { path, sha256: sha256(readFileSync(join(repo, path))) } : { path, missing: true });
const dist = ['dist-runtime/runner.mjs', 'dist-runtime/bridge.mjs', 'dist-runtime/host.mjs', 'dist-runtime/deszo-launch-shim.exe'];
const tiers = readFileSync(join(repo, 'runtime/tests/tiers.json'));

const manifest = {
  schemaVersion: 1, kind: 'P6FinalAcceptanceSourceSnapshot', method: 'sorted git ls-files --cached --others --exclude-standard; excluded .deszo/ and docs/reviews/evidence/; path NUL sha256 newline',
  branch, head, trackedFileCount: tracked.length, modifiedTrackedCount: modified.length, modifiedTracked: modified.sort(),
  untrackedFileCount: untracked.length, untracked: untracked.sort(),
  snapshotFileCount: files.length, snapshotDigest: digest, files,
  artifacts: { host: artifact('lifecycle-host/target/release/deszo-lifecycle-host.exe'), shell: artifact('src-tauri/target/release/deszo.exe'),
    launchShim: artifact('src-tauri/target/release/deszo-launch-shim.exe'), distRuntime: dist.map(artifact) },
  testTierCatalogSha256: sha256(tiers),
};
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ branch, head, snapshotFileCount: files.length, snapshotDigest: digest, trackedFileCount: tracked.length,
  modifiedTrackedCount: modified.length, untrackedFileCount: untracked.length, hostSha256: manifest.artifacts.host.sha256,
  shellSha256: manifest.artifacts.shell.sha256, tierSha256: manifest.testTierCatalogSha256 }, null, 2));
