// P5-CLOSURE F12: one exact byte identity across Windows line-ending configurations, with the actual Git for Windows.
// The installed release, the P5 baseline, the managed clone, the sealed candidate and the reconstructed handoff all identify
// source by SHA-256 of exact bytes, and P5 reads source as committed Git blobs. A release is therefore packaged only when
// its working-tree bytes equal the committed blobs; any checkout conversion refuses instead of yielding two identities.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { actualGit } from './p5-e2e-support.mjs';
import { newScratch } from './custody-support.mjs';
import { packageRuntimeRelease } from '../host/runtimeRelease.mjs';
import { runP5GitCommand, verifyP5GitAttributes } from '../core/protectedSelfRepair.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const blobId = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const FILES = new Map([
  ['runtime/runner.mjs', Buffer.from("export const runner = 'lf';\n")],
  ['runtime/core/engine.mjs', Buffer.from("export const engine = 'lf';\n")],
  ['runtime/core/crlf.mjs', Buffer.from("export const crlf = 'committed with CRLF';\r\nexport const second = 2;\r\n")],
  ['runtime/assets/data.bin', Buffer.from([0x00, 0x0d, 0x0a, 0xff, 0x0a, 0x0d, 0x00])],
]);

test('P5-CLOSURE F12: release, baseline and candidate bytes are the committed blobs under every autocrlf setting', { timeout: 300_000 }, async () => {
  const gitTool = actualGit();
  const scratch = newScratch('p5-crlf');
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_TERMINAL_PROMPT: '0' };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('GIT_') && !['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_TERMINAL_PROMPT'].includes(key)) delete env[key];
  const git = (cwd, args, config = []) => execFileSync(gitTool.path, [...config, '-c', 'user.name=F12', '-c', 'user.email=f12@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=NUL', '-c', 'init.templateDir=', '-C', cwd, ...args], { env, windowsHide: true, encoding: 'buffer' });
  const source = (name, attributes = null) => {
    const root = join(scratch.root, name);
    mkdirSync(root, { recursive: true });
    git(root, ['init', '--quiet', '--initial-branch=main']);
    for (const [path, bytes] of FILES) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes); }
    if (attributes) writeFileSync(join(root, '.gitattributes'), attributes);
    git(root, ['add', '--all'], ['-c', 'core.autocrlf=false']);
    git(root, ['commit', '--quiet', '-m', 'F12 source'], ['-c', 'core.autocrlf=false']);
    return root;
  };
  const clone = (from, name, autocrlf) => {
    const root = join(scratch.root, name);
    git(scratch.root, ['clone', '--quiet', '--config', `core.autocrlf=${autocrlf}`, from, root]);
    return root;
  };
  const committed = (root, path) => git(root, ['cat-file', 'blob', `HEAD:${path}`]);
  const pack = (root, buildId) => packageRuntimeRelease({ sourceRoot: root, gitTool, outDir: join(scratch.root, `release-${buildId}`), buildId });

  const plain = source('plain');
  // false and input check out the exact blobs: the release identity is the committed byte identity.
  for (const setting of ['false', 'input']) {
    const checkout = clone(plain, `clone-${setting}`, setting);
    const release = await pack(checkout, `crlf-${setting}`);
    const inventory = JSON.parse(readFileSync(join(scratch.root, `release-crlf-${setting}`, '.deszo-source-inventory.json'), 'utf8'));
    for (const [path, bytes] of FILES) {
      assert.equal(inventory.files.find(item => item.path === path).sha256, sha256(bytes), `${setting}: ${path} release identity`);
      assert.ok(committed(checkout, path).equals(bytes), `${setting}: ${path} blob bytes`);
      assert.ok(readFileSync(join(scratch.root, `release-crlf-${setting}`, ...path.split('/'))).equals(bytes), `${setting}: ${path} installed bytes`);
    }
    assert.equal(release.sourceCommit, git(checkout, ['rev-parse', 'HEAD']).toString().trim());
  }
  // true converts LF blobs to CRLF in the working tree; Git calls it clean, the release is refused.
  const converted = clone(plain, 'clone-true', 'true');
  assert.equal(git(converted, ['status', '--porcelain']).toString().trim(), '', 'Git reports the converted checkout as clean');
  assert.ok(!readFileSync(join(converted, 'runtime', 'core', 'engine.mjs')).equals(FILES.get('runtime/core/engine.mjs')), 'the working tree was converted');
  await assert.rejects(pack(converted, 'crlf-true'), /differ from the committed Git blob/);
  // An eol attribute converts on checkout even with autocrlf=false: refused at packaging and by P5's attribute policy.
  const attributed = clone(source('attributed', '*.mjs text eol=crlf\n'), 'clone-attributed', 'false');
  await assert.rejects(pack(attributed, 'crlf-attributed'), /differ from the committed Git blob/);
  assert.throws(() => verifyP5GitAttributes(gitTool, attributed, ['runtime/core/engine.mjs']), error => /attribute|transform|checkout/i.test(error.message));

  // P5's pinned Git ignores a repository-local autocrlf=true: reads return exact blobs, staging stores exact bytes.
  for (const [path, bytes] of FILES) assert.ok(runP5GitCommand(gitTool, converted, ['cat-file', 'blob', `HEAD:${path}`]).equals(bytes), `pinned read ${path}`);
  const candidate = Buffer.from("export const engine = 'candidate';\r\nexport const lf = 1;\n");
  writeFileSync(join(converted, 'runtime', 'core', 'candidate.mjs'), candidate);
  runP5GitCommand(gitTool, converted, ['add', '--', 'runtime/core/candidate.mjs']);
  const staged = runP5GitCommand(gitTool, converted, ['ls-files', '-s', '--', 'runtime/core/candidate.mjs']).toString().split(/\s+/)[1];
  assert.equal(staged, blobId(candidate), 'the staged blob is the exact sealed bytes (no CRLF normalization)');
  assert.ok(runP5GitCommand(gitTool, converted, ['cat-file', 'blob', staged]).equals(candidate));
});
