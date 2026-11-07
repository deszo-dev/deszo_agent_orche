import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, copyFileSync, writeFileSync, readFileSync, readdirSync, chmodSync, lstatSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve, isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { canonicalHash, compareText, sha256 } from './canonical.mjs';
import { check } from './schemas.mjs';
import { nowIso } from './store.mjs';

const ZERO_OID = '0000000000000000000000000000000000000000';
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const KILL_GRACE_MS = 2000;
const STOPPED_DIAGNOSTICS = 'Delivery was stopped before the verified commit was published; the target ref was not updated.';
const slash = path => path.replace(/\\/g, '/');
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

function createTemporaryHooksDirectory(prefix) {
  const parent = realpathSync.native(tmpdir());
  const path = mkdtempSync(join(parent, prefix));
  const info = lstatSync(path);
  return { path, prefix, identity: { dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs } };
}

function releaseTemporaryHooksDirectory({ path, prefix, identity }) {
  const parent = realpathSync.native(tmpdir());
  const absolute = resolve(path);
  const name = basename(absolute);
  if (!samePath(dirname(absolute), parent) || !name.startsWith(prefix) || !/^[A-Za-z0-9]{6}$/.test(name.slice(prefix.length))) {
    return { removed: false, reason: 'refused: path is outside the operation-owned temporary hooks location' };
  }
  let info;
  try { info = lstatSync(absolute); }
  catch (error) { return error.code === 'ENOENT' ? { removed: true, reason: 'already absent' } : { removed: false, reason: `${error.code ?? 'error'}: ${error.message}` }; }
  if (info.isSymbolicLink() || !info.isDirectory()) return { removed: false, reason: 'refused: temporary hooks path is not a real directory' };
  if (info.dev !== identity.dev || info.ino !== identity.ino || info.birthtimeMs !== identity.birthtimeMs) {
    return { removed: false, reason: 'refused: temporary hooks path identity changed after allocation' };
  }
  try {
    if (!samePath(realpathSync.native(absolute), absolute)) return { removed: false, reason: 'refused: temporary hooks path resolves through an alias' };
    rmSync(absolute, { recursive: true, force: false, maxRetries: 5, retryDelay: 100 });
    return { removed: true, reason: null };
  } catch (error) {
    return { removed: false, reason: `${error.code ?? 'error'}: ${error.message}` };
  }
}

// Stops a child and its descendants. On Windows taskkill /T walks the tree; elsewhere the child leads its own group.
function killTree(child) {
  if (child.pid === undefined) return Promise.resolve({ error: null });
  if (process.platform === 'win32') {
    return new Promise(resolvePromise => {
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) { try { child.kill(); } catch { /* already exited */ } }
        resolvePromise({ error });
      };
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const output = { stdout: '', stderr: '' };
      for (const name of ['stdout', 'stderr']) killer[name].on('data', chunk => {
        output[name] = (output[name] + chunk.toString('utf8')).slice(-4096);
      });
      const timer = setTimeout(() => {
        try { killer.kill(); } catch { /* already exited */ }
        finish(new Error(`taskkill did not finish within ${KILL_GRACE_MS} ms`));
      }, KILL_GRACE_MS);
      killer.once('error', error => finish(error));
      killer.once('close', (status, signal) => {
        const detail = (output.stderr || output.stdout).trim();
        finish(status === 0 ? null : new Error(`taskkill exited with ${status ?? signal ?? 'unknown status'}${detail ? `: ${detail}` : ''}`));
      });
    });
  }
  try { process.kill(-child.pid, 'SIGKILL'); return Promise.resolve({ error: null }); }
  catch (error) {
    try { child.kill('SIGKILL'); } catch { /* already exited */ }
    return Promise.resolve({ error });
  }
}

// Runs a child process without blocking the event loop (audit A1). Output is captured up to a bound and reported
// as truncated; a timeout or an abort kills the child tree and resolves with the reason.
// The process runner is exported for lifecycle-focused tests that wrap a specific Git transport while retaining this
// production runner's cancellation, output bounds and process-settlement behavior.
export function runBranchDeliveryProcess(command, args, { cwd, env, timeoutMs = 30000, signal, encoding = 'utf8', waitForTermination = false } = {}) {
  return new Promise(resolvePromise => {
    const outcome = { status: null, signal: null, timedOut: false, aborted: false, truncated: false, error: null };
    if (signal?.aborted) {
      resolvePromise({ ...outcome, aborted: true, stdout: encoding === 'buffer' ? Buffer.alloc(0) : '', stderr: '' });
      return;
    }
    const child = spawn(command, args, {
      cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    const chunks = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    const collect = name => chunk => {
      const room = MAX_OUTPUT_BYTES - sizes[name];
      if (chunk.length > room) outcome.truncated = true;
      if (room <= 0) return;
      const kept = chunk.subarray(0, Math.min(room, chunk.length));
      chunks[name].push(kept);
      sizes[name] += kept.length;
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));

    let settled = false;
    let timer = null;
    let grace = null;
    let terminationPromise = null;
    let terminationError = null;
    const settle = extra => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      signal?.removeEventListener('abort', onAbort);
      const text = name => {
        const bytes = Buffer.concat(chunks[name]);
        return encoding === 'buffer' ? bytes : bytes.toString('utf8');
      };
      resolvePromise({ ...outcome, ...extra, stdout: text('stdout'), stderr: text('stderr') });
    };
    const terminate = () => {
      terminationPromise = killTree(child).then(result => {
        terminationError = result.error;
        return result;
      }, error => {
        terminationError = error;
        return { error };
      });
      // Git may still be using its operation-owned hooks path after cancellation. Let its
      // whole process tree settle before Branch Delivery releases that path. If the bounded
      // kill request or close wait fails, the caller preserves the path and reports why.
      grace = setTimeout(() => settle(waitForTermination
        ? { processActive: child.exitCode === null && child.signalCode === null, terminationError: terminationError ?? new Error(`Git process tree did not settle within ${KILL_GRACE_MS} ms after termination.`) }
        : {}), KILL_GRACE_MS);
    };
    const onAbort = () => { outcome.aborted = true; terminate(); };
    timer = setTimeout(() => { outcome.timedOut = true; terminate(); }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', error => settle({ error }));
    child.on('close', (status, childSignal) => {
      const complete = result => settle({ status, signal: childSignal, ...(result?.error ? { terminationError: result.error } : {}) });
      if (waitForTermination && terminationPromise) terminationPromise.then(complete, error => complete({ error }));
      else settle({ status, signal: childSignal });
    });
  });
}

const git = (args, cwd, options = {}) => runBranchDeliveryProcess('git', args, { cwd, ...options });
const hooksOverride = dir => ['-c', `core.hooksPath=${slash(dir)}`];

// The source repository is written by `fetch` (objects) and `update-ref` (the target ref). A `fetch` can end with `git maintenance run --auto`,
// and that may detach a `git gc` which keeps repacking the repository after the fetch has returned. The delivery does not wait for a detached
// process, so the source-repository fetch disables automatic maintenance. Its arguments are exported so that the proof runs these exact values.
export const SOURCE_FETCH_CONFIG = ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false'];
export const SOURCE_FETCH_OPTIONS = ['--no-auto-gc', '--no-auto-maintenance'];

// Preconditions that hold before preparation and again immediately before publication (ADR-0005, audit A6).
// Returns null when satisfied, otherwise the status and diagnostics of the refusal.
async function publicationPreconditions(plan, repoPath, runGit = git) {
  const head = await runGit(['symbolic-ref', '-q', 'HEAD'], repoPath);
  if (head.status === 0 && head.stdout.trim() === plan.targetBranchRef) {
    return {
      status: 'precondition_failed',
      diagnostics: `Target branch "${plan.targetBranchRef}" is currently checked out in repository "${repoPath}". Delivery to an active checkout is prohibited to preserve caller working tree state.`,
    };
  }
  const worktrees = await runGit(['worktree', 'list', '--porcelain'], repoPath);
  if (worktrees.status !== 0) {
    return { status: 'precondition_failed', diagnostics: `Could not list worktrees to prove the target is not checked out: ${worktrees.stderr}` };
  }
  if (worktrees.stdout.split(/\r?\n/).some(line => line.trim() === `branch ${plan.targetBranchRef}`)) {
    return {
      status: 'precondition_failed',
      diagnostics: `Target branch "${plan.targetBranchRef}" is currently checked out in a linked worktree. Delivery to an active checkout is prohibited.`,
    };
  }

  const current = await runGit(['rev-parse', '--verify', plan.targetBranchRef], repoPath);
  const branchExists = current.status === 0;
  const currentCommit = branchExists ? current.stdout.trim() : null;
  if (plan.branchExpectedOldValue === null) {
    if (branchExists) {
      return { status: 'precondition_failed', diagnostics: `Destination collision: branch "${plan.targetBranchRef}" already exists (${currentCommit}).` };
    }
  } else {
    if (!branchExists) {
      return { status: 'precondition_failed', diagnostics: `Target branch "${plan.targetBranchRef}" does not exist; expected old commit ${plan.branchExpectedOldValue}.` };
    }
    if (currentCommit !== plan.branchExpectedOldValue) {
      return { status: 'ref_conflict', diagnostics: `Target branch "${plan.targetBranchRef}" has moved: expected ${plan.branchExpectedOldValue}, observed ${currentCommit}.` };
    }
    // F3: the declared base must be the branch head the candidate was built on.
    if (plan.baseCommit !== plan.branchExpectedOldValue) {
      return {
        status: 'precondition_failed',
        diagnostics: `Declared baseCommit "${plan.baseCommit}" does not match target branch expected head "${plan.branchExpectedOldValue}". Retargeting base without recaptured candidate is prohibited.`,
      };
    }
    // R5: the base must be an ancestor of the expected head (or equal to it).
    const ancestor = await runGit(['merge-base', '--is-ancestor', plan.baseCommit, plan.branchExpectedOldValue], repoPath);
    if (ancestor.status !== 0) {
      return { status: 'precondition_failed', diagnostics: `Base commit "${plan.baseCommit}" is not an ancestor of expected branch head "${plan.branchExpectedOldValue}".` };
    }
  }

  const base = await runGit(['rev-parse', '--verify', `${plan.baseCommit}^{commit}`], repoPath);
  if (base.status !== 0) {
    return { status: 'precondition_failed', diagnostics: `Base commit "${plan.baseCommit}" not found in repository.` };
  }
  return null;
}

// Executes verified feature branch delivery pipeline (ADR-0005 & reviews R2-R7, F1-F9, audit A1-A6).
// Every Git and verification process is awaited, so callbacks and timers run while it works. Aborting `signal`
// stops the in-flight process, returns status "stopped" and prevents the ref from being published.
export async function executeBranchDelivery({
  plan,
  candidateFiles = [], // [{ path, content }]
  cloneDir, // Temporary isolated directory for delivery clone
  signal,
  processRunner = runBranchDeliveryProcess,
  onPhase = async () => {},
}) {
  const planIssues = check('delivery-plan.schema.json', '', plan);
  if (planIssues.length) {
    throw new Error(`Invalid DeliveryPlan: ${planIssues.map(i => i.message).join('; ')}`);
  }

  candidateFiles = candidateFiles.map(file => ({ ...file, path: typeof file?.path === 'string' ? slash(file.path) : file?.path }));
  const evidence = [];
  let hooksCleanupBlockedReason = null;
  const invoke = async (command, args, options = {}) => {
    const result = await processRunner(command, args, options);
    if (result.evidence) evidence.push(result.evidence);
    if (options.waitForTermination && (result.processActive || result.terminationError)) {
      hooksCleanupBlockedReason = result.terminationError?.message ?? 'the Git process tree did not settle';
    }
    if (result.truncated && !result.error) result.error = new Error('Command output exceeded its bounded protocol buffer; captured logs remain available.');
    if (result.error || result.timedOut || result.truncated || result.captureComplete === false) result.status = null;
    return result;
  };
  const git = (args, cwd, options = {}) => invoke('git', args, { cwd, signal, category: 'git', attemptCost: 0, waitForTermination: true, ...options });
  const resultId = `DELIV-${randomUUID()}`;
  const repoPath = resolve(plan.repositoryPath);

  if (!existsSync(repoPath)) {
    return failResult(plan, resultId, 'precondition_failed', 'Repository path does not exist.');
  }

  // R2: Validate cloneDir ownership and refuse existing directories or containment collisions
  const resolvedClone = resolve(cloneDir);
  if (resolvedClone === repoPath || resolvedClone.startsWith(repoPath + sep)) {
    return failResult(plan, resultId, 'precondition_failed', 'Clone directory cannot reside inside the repository.');
  }
  if (existsSync(cloneDir)) {
    return failResult(
      plan,
      resultId,
      'precondition_failed',
      `Destination directory already exists: "${cloneDir}". Arbitrary directory deletion is prohibited.`
    );
  }

  // R3: Validate candidate file paths against path traversal, absolute paths, and git metadata escapes
  const seenPaths = new Set();
  for (const file of candidateFiles) {
    if (typeof file.path !== 'string' || file.path.length === 0) {
      return failResult(plan, resultId, 'precondition_failed', 'Candidate file path must be a non-empty string.');
    }
    if (isAbsolute(file.path) || /^[a-zA-Z]:/.test(file.path) || /^\\\\/.test(file.path)) {
      return failResult(plan, resultId, 'precondition_failed', `Candidate file path must be relative: "${file.path}".`);
    }
    const norm = file.path.replace(/\\/g, '/');
    const identity = process.platform === 'win32' ? norm.toLowerCase() : norm;
    if (seenPaths.has(identity)) return failResult(plan, resultId, 'precondition_failed', 'Candidate paths collide.');
    seenPaths.add(identity);
    const segments = norm.split('/');
    if (segments.some(s => s === '..' || s === '.' || s === '')) {
      return failResult(plan, resultId, 'precondition_failed', `Path traversal or invalid segment in candidate path: "${file.path}".`);
    }
    if (segments.some(segment => segment.toLowerCase() === '.git' || /[:<>"|?*\x00-\x1f]/.test(segment) || /[. ]$/.test(segment))) {
      return failResult(plan, resultId, 'precondition_failed', `Candidate path cannot write to git metadata: "${file.path}".`);
    }
    const targetPath = resolve(resolvedClone, file.path);
    if (!targetPath.startsWith(resolvedClone + sep) && targetPath !== resolvedClone) {
      return failResult(plan, resultId, 'precondition_failed', `Candidate path escapes clone directory: "${file.path}".`);
    }
  }

  // R4: the candidate manifest is canonical and independent of the clone.
  const canonicalManifestDigest = deliveryManifestDigest(candidateFiles, plan.manifestVersion || 1);

  let hookJournal = 'none';
  const hookReceipt = () => ({
    status: hookJournal === 'none' ? 'none' : 'executed',
    journal: `Hooks policy: ${hookJournal}; host ref publication runs with hooks disabled`,
  });
  let operationResult = null;
  const fail = (status, diagnostics, overrides = {}) => {
    operationResult = failResult(plan, resultId, status, diagnostics, {
      canonicalManifestDigest,
      hookExecution: hookReceipt(),
      ...overrides,
    });
    return operationResult;
  };
  const stopped = () => fail('stopped', STOPPED_DIAGNOSTICS);

  // F4 and R5/F3: refuse an active target checkout, a moved target, a mismatched base or a missing base.
  const preflight = await publicationPreconditions(plan, repoPath, git);
  if (signal?.aborted) return stopped();
  if (preflight) return fail(preflight.status, preflight.diagnostics);

  if (plan.candidateDigest && plan.candidateDigest !== canonicalManifestDigest) {
    return fail(
      'precondition_failed',
      `Candidate manifest digest mismatch: computed ${canonicalManifestDigest}, plan specified ${plan.candidateDigest}.`
    );
  }

  await onPhase('intent', { plan, cloneDir, canonicalManifestDigest });

  // F5: Prepare hook policy before clone and checkout to prevent ambient checkout hooks from running
  const ownedHooksDirectories = [];
  const emptyHooksPrefix = 'deszo-empty-hooks-';
  const emptyHooksResource = createTemporaryHooksDirectory(emptyHooksPrefix);
  const emptyHooksDir = emptyHooksResource.path;
  ownedHooksDirectories.push(emptyHooksResource);
  try {
  let effectiveHooksDir = emptyHooksDir;

  if (plan.hookPolicy.installHooks) {
    if (!plan.hookPolicy.hookSource || !existsSync(plan.hookPolicy.hookSource)) {
      return fail('precondition_failed', `Configured hookSource directory does not exist: "${plan.hookPolicy.hookSource}".`);
    }
    const isolatedHooksPrefix = 'deszo-hooks-';
    const isolatedHooksResource = createTemporaryHooksDirectory(isolatedHooksPrefix);
    const isolatedHooksDir = isolatedHooksResource.path;
    ownedHooksDirectories.push(isolatedHooksResource);
    const hookEntries = readdirSync(plan.hookPolicy.hookSource, { withFileTypes: true });
    for (const entry of hookEntries) {
      if (entry.isFile()) {
        const src = join(plan.hookPolicy.hookSource, entry.name);
        const dst = join(isolatedHooksDir, entry.name);
        copyFileSync(src, dst);
        try { chmodSync(dst, 0o755); } catch {}
      }
    }
    effectiveHooksDir = isolatedHooksDir;
    hookJournal = 'installed';
  }

  // Clone and checkout run with the effective hooks path. The host-side publication below uses the empty path.
  const cloneHooks = hooksOverride(effectiveHooksDir);
  const hostHooks = hooksOverride(emptyHooksDir);

  if (signal?.aborted) return stopped();

  // 2. Create isolated separate clone (--reference --dissociate) with effective hooks configured (F5)
  mkdirSync(cloneDir, { recursive: true });
  const cloneRes = await git([...cloneHooks, 'clone', '--reference', repoPath, '--dissociate', repoPath, cloneDir], repoPath, { signal });
  if (signal?.aborted) return stopped();
  if (cloneRes.status !== 0) {
    return fail('delivery_failed', `Failed to create isolated delivery clone: ${cloneRes.stderr}`);
  }
  await git(['config', 'core.hooksPath', slash(effectiveHooksDir)], cloneDir, { signal });

  // R5: Checkout start commit: if delivering to existing branch, build on expectedOld; else baseCommit
  const startCommit = plan.branchExpectedOldValue !== null ? plan.branchExpectedOldValue : plan.baseCommit;
  const checkoutRes = await git([...cloneHooks, 'checkout', startCommit], cloneDir, { signal });
  if (signal?.aborted) return stopped();
  if (checkoutRes.status !== 0) {
    return fail('delivery_failed', `Failed to checkout start commit ${startCommit} in delivery clone: ${checkoutRes.stderr}`);
  }

  // 4. Apply candidate files and stage them; a staging failure or an ignored path fails delivery (F1)
  for (const file of candidateFiles) {
    const fullPath = join(cloneDir, file.path);
    mkdirSync(resolve(fullPath, '..'), { recursive: true });
    let cursor = cloneDir;
    for (const segment of file.path.split('/')) {
      cursor = join(cursor, segment);
      if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) return fail('precondition_failed', 'Symbolic links are unsupported delivery inputs.');
    }
    if (file.operation === 'delete') { if (existsSync(fullPath)) unlinkSync(fullPath); }
    else writeFileSync(fullPath, file.content);
  }
  for (const file of candidateFiles) {
    const addRes = await git([...cloneHooks, 'add', '--', file.path], cloneDir, { signal });
    if (signal?.aborted) return stopped();
    if (addRes.status !== 0) {
      return fail('delivery_failed', `Failed to stage candidate file "${file.path}": ${addRes.stderr || addRes.stdout}`);
    }
    if (file.operation === 'delete') continue;
    if (file.mode === '100755') await git(['update-index', '--chmod=+x', '--', file.path], cloneDir);
    const lsCheck = await git(['ls-files', '--error-unmatch', '--', file.path], cloneDir, { signal });
    if (lsCheck.status !== 0) {
      return fail('delivery_failed', `Candidate file "${file.path}" was omitted from index (possibly ignored by .gitignore).`);
    }
  }

  const preSmokeTreeRes = await git(['write-tree'], cloneDir, { signal });
  if (signal?.aborted) return stopped();
  if (preSmokeTreeRes.status !== 0) {
    return fail('delivery_failed', `git write-tree failed: ${preSmokeTreeRes.stderr}`);
  }
  const preSmokeTreeId = preSmokeTreeRes.stdout.trim();
  if (plan.manifestVersion === 2) {
    const tree = await git(['ls-tree', '-rz', '--full-tree', preSmokeTreeId], cloneDir);
    if (tree.status !== 0) return fail('delivery_failed', 'The staged candidate tree could not be inspected.');
    const entries = tree.stdout.split('\0').filter(Boolean).map(line => {
      const [metadata, path] = line.split('\t');
      const [mode, type] = metadata.split(' ');
      return { path, mode, type };
    });
    const expected = new Map(candidateFiles.filter(file => file.operation !== 'delete').map(file => [file.path, file]));
    if (entries.length !== expected.size || entries.some(entry => entry.type !== 'blob' || !expected.has(entry.path) || entry.mode !== (expected.get(entry.path).mode || '100644'))) {
      return fail('delivery_failed', 'The full staged source tree differs from the approved candidate paths or modes.');
    }
  }

  // 5. Environment verification / smoke checks inside isolated clone (R7). Each runs as an awaited, bounded child.
  let smokePassed = true;
  let smokeExit = 0;
  let smokeDiag = 'All checks passed.';
  for (const checkSpec of plan.verificationChecks) {
    if (signal?.aborted) return stopped();
    const timeoutMs = checkSpec.timeoutMs || 30000;
    const run = await invoke(checkSpec.command, checkSpec.args, { cwd: cloneDir, timeoutMs, signal, category: 'smoke', attemptCost: 1, checkId: checkSpec.id, expectedExitCode: checkSpec.expectedExitCode });
    if (run.aborted) return stopped();
    if (run.error || run.timedOut) {
      smokePassed = false;
      smokeExit = 124;
      smokeDiag = `Verification check "${checkSpec.id}" timed out or errored: ${run.error ? run.error.message : `exceeded ${timeoutMs} ms`}`;
      break;
    }
    if (run.status !== checkSpec.expectedExitCode) {
      smokePassed = false;
      smokeExit = run.status ?? 1;
      smokeDiag = `Verification check "${checkSpec.id}" failed: exit ${run.status}.\n${run.stderr || run.stdout}`;
      break;
    }
  }

  if (!smokePassed) {
    return fail('verification_failed', smokeDiag, {
      environmentSmokeReport: { passed: false, exitCode: smokeExit, diagnostics: smokeDiag },
    });
  }

  // R4: Post-smoke working tree integrity check: verify smoke did not mutate working tree or candidate files
  for (const file of candidateFiles) {
    if (file.operation === 'delete') { if (existsSync(join(cloneDir, file.path))) return fail('verification_failed', 'Smoke recreated a deleted candidate path.'); continue; }
    const onDisk = readFileSync(join(cloneDir, file.path));
    if (!onDisk.equals(Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8'))) {
      return fail('verification_failed', `Verification checks mutated candidate file "${file.path}". Working tree mutation rejected.`);
    }
  }

  // F2: Robust porcelain check without trim stripping leading status characters
  const postSmokeStatus = await git(['status', '--porcelain=v1', '-z'], cloneDir, { signal });
  if (signal?.aborted) return stopped();
  if (postSmokeStatus.status !== 0) {
    return fail('verification_failed', `git status failed after verification checks: ${postSmokeStatus.stderr || postSmokeStatus.stdout}`);
  }
  if (postSmokeStatus.stdout.length > 0) {
    const lines = postSmokeStatus.stdout.split('\0').filter(line => line.length > 0);
    const candidatePathSet = new Set(candidateFiles.map(f => f.path.replace(/\\/g, '/')));
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const code = line.slice(0, 2);
      const filePath = line.slice(3).replace(/\\/g, '/');
      if (code[1] !== ' ' || code.startsWith('??')) {
        return fail('verification_failed', `Verification checks generated undeclared or mutated files: "${line}".`);
      }
      if (!candidatePathSet.has(filePath)) {
        return fail('verification_failed', `Verification checks generated undeclared or mutated files: "${filePath}".`);
      }
      if (/[RC]/.test(code[0])) { if (!candidatePathSet.has(lines[++index])) return fail('verification_failed', 'An undeclared rename/copy source was staged.'); }
    }
  }
  const postSmokeTree = await git(['write-tree'], cloneDir);
  if (postSmokeTree.status !== 0 || postSmokeTree.stdout.trim() !== preSmokeTreeId) return fail('verification_failed', 'Verification changed the recorded candidate index.');

  // 6. Commit and verify committed content
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: plan.commitPolicy.authorName,
    GIT_AUTHOR_EMAIL: plan.commitPolicy.authorEmail,
    GIT_COMMITTER_NAME: plan.commitPolicy.authorName,
    GIT_COMMITTER_EMAIL: plan.commitPolicy.authorEmail,
  };
  const commitRes = await git([...cloneHooks, 'commit', '-m', plan.commitPolicy.message], cloneDir, { env, signal });
  if (signal?.aborted) return stopped();
  if (commitRes.status !== 0) {
    return fail('delivery_failed', `git commit failed: ${commitRes.stderr || commitRes.stdout}`);
  }

  const commitSha = (await git(['rev-parse', 'HEAD'], cloneDir, { signal })).stdout.trim();
  const parentSha = (await git(['rev-parse', 'HEAD^'], cloneDir, { signal })).stdout.trim();
  const actualTree = (await git(['rev-parse', 'HEAD^{tree}'], cloneDir, { signal })).stdout.trim();

  // R4: Verify committed tree matches staged candidate tree exactly
  if (actualTree !== preSmokeTreeId) {
    return fail(
      'delivery_failed',
      `Committed tree "${actualTree}" does not match recorded staged candidate tree "${preSmokeTreeId}". Hook mutation detected.`,
      { treeId: preSmokeTreeId }
    );
  }
  const postCommitStatus = await git(['status', '--porcelain=v1', '-z'], cloneDir);
  if (postCommitStatus.status !== 0 || postCommitStatus.stdout.length) return fail('delivery_failed', 'Commit hooks left unreviewed working-tree changes.');

  // F1: Verify every candidate blob is byte-identical to the approved candidate content
  for (const file of candidateFiles.filter(file => file.operation !== 'delete')) {
    const blob = await git(['cat-file', 'blob', `${commitSha}:${file.path}`], cloneDir, { encoding: 'buffer', signal });
    if (signal?.aborted) return stopped();
    if (blob.status !== 0) {
      return fail('delivery_failed', `Candidate file "${file.path}" missing from committed tree ${commitSha}.`);
    }
    if (blob.truncated || !blob.stdout.equals(Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8'))) {
      return fail(
        'delivery_failed',
        `Committed blob for candidate file "${file.path}" differs from approved candidate content. Undeclared Git conversions (e.g. CRLF/LF) rejected without captured transformation policy.`
      );
    }
  }

  await onPhase('commit', { commitSha, parentSha, actualTree, canonicalManifestDigest });

  // R5: Verify parent relationship matches expectedOldValue
  if (plan.branchExpectedOldValue !== null) {
    if (parentSha !== plan.branchExpectedOldValue) {
      return fail('delivery_failed', `Parent commit "${parentSha}" does not match expected old value "${plan.branchExpectedOldValue}".`);
    }
    const ancestorVerification = await git(['merge-base', '--is-ancestor', plan.branchExpectedOldValue, commitSha], cloneDir, { signal });
    if (signal?.aborted) return stopped();
    if (ancestorVerification.status !== 0) {
      return fail('delivery_failed', `Previous branch head "${plan.branchExpectedOldValue}" is not an ancestor of delivery commit "${commitSha}".`);
    }
  }

  // 7. Publication. The preconditions are checked again immediately before the host is touched (A6), so a checkout
  // or ref move during smoke is refused here. Host Git runs with the empty hooks path (A3). The update is a
  // compare-and-swap; a checkout that starts after this re-check is an external race that Git cannot prevent.
  const published = { verifiedCommitId: commitSha, treeId: actualTree, parentCommitId: parentSha };
  const fetched = await git([...hostHooks, ...SOURCE_FETCH_CONFIG, 'fetch', ...SOURCE_FETCH_OPTIONS, cloneDir, commitSha], repoPath, { signal });
  if (signal?.aborted) return stopped();
  if (fetched.status !== 0) {
    return fail('delivery_failed', `Failed to fetch the verified commit into the host repository: ${fetched.stderr}`, { ...published });
  }
  const late = await publicationPreconditions(plan, repoPath, git);
  if (signal?.aborted) return stopped();
  if (late) return fail(late.status, late.diagnostics, { ...published });

  // The abort check above is the last point at which Stop can prevent publication; the update itself is atomic.
  const expectedOld = plan.branchExpectedOldValue ?? ZERO_OID;
  await onPhase('publish-intent', { commitSha, parentSha, actualTree, expectedOld, targetBranchRef: plan.targetBranchRef });
  if (signal?.aborted) return stopped();
  const updateRefRes = await git([...hostHooks, 'update-ref', plan.targetBranchRef, commitSha, expectedOld], repoPath);
  if (updateRefRes.status !== 0 && (updateRefRes.aborted || updateRefRes.timedOut || updateRefRes.error)) {
    return fail('publication_uncertain', 'The ref update outcome could not be established. Reconcile the saved operation before retrying.', { ...published, refUpdated: null });
  }
  if (updateRefRes.status !== 0) {
    return fail('ref_conflict', `Target branch "${plan.targetBranchRef}" could not be updated: ${updateRefRes.stderr}`, {
      ...published,
      environmentSmokeReport: { passed: true, exitCode: 0, diagnostics: 'Smoke passed before ref race.' },
    });
  }

  await onPhase('published', { commitSha, parentSha, actualTree, targetBranchRef: plan.targetBranchRef });
  if (signal?.aborted) return fail('stopped', 'Stop raced with publication: the recorded ref was updated; readiness was not published.', { ...published, refUpdated: true });

  // 8. Publish READY_FOR_MERGE delivery result
  const deliveryResult = {
    schemaVersion: 1,
    kind: 'DeliveryResult',
    deliveryResultId: resultId,
    deliveryPlanId: plan.deliveryPlanId,
    status: 'READY_FOR_MERGE',
    sourceCommit: plan.baseCommit,
    verifiedCommitId: commitSha,
    treeId: actualTree,
    parentCommitId: parentSha,
    targetBranchRef: plan.targetBranchRef,
    refUpdated: true,
    canonicalManifestDigest,
    environmentSmokeReport: {
      passed: true,
      exitCode: 0,
      diagnostics: 'Environment verification passed.',
    },
    hookExecution: hookReceipt(),
    commandEvidence: evidence,
    readyForMerge: true,
    completedAt: nowIso(),
  };

  const issues = check('delivery-result.schema.json', '', deliveryResult);
  if (issues.length) {
    throw new Error(`Generated invalid DeliveryResult: ${issues.map(i => i.message).join('; ')}`);
  }

  operationResult = deliveryResult;
  return operationResult;
  } finally {
    const cleanupFailures = [];
    if (hooksCleanupBlockedReason) {
      cleanupFailures.push(`preserved because owned Git process termination was not confirmed (${hooksCleanupBlockedReason})`);
    } else {
      for (const directory of ownedHooksDirectories) {
        let cleanup;
        try { cleanup = releaseTemporaryHooksDirectory(directory); }
        catch (error) { cleanup = { removed: false, reason: `${error.code ?? 'error'}: ${error.message}` }; }
        if (!cleanup.removed) cleanupFailures.push(`${cleanup.reason}: ${directory.path}`);
      }
    }
    if (cleanupFailures.length) {
      const action = hooksCleanupBlockedReason ? 'deferred' : 'failed';
      const diagnostic = `Temporary Git hooks directory cleanup ${action}: ${cleanupFailures.join('; ')}`;
      if (operationResult?.environmentSmokeReport) {
        operationResult.environmentSmokeReport.diagnostics = `${operationResult.environmentSmokeReport.diagnostics}\n${diagnostic}`;
      } else {
        try { process.emitWarning(diagnostic, { code: 'BRANCH_DELIVERY_HOOK_CLEANUP_FAILED' }); } catch { /* preserve the operation's original error */ }
      }
    }
  }
}

function failResult(plan, resultId, status, diagnostics, overrides = {}) {
  const result = {
    schemaVersion: 1,
    kind: 'DeliveryResult',
    deliveryResultId: resultId,
    deliveryPlanId: plan.deliveryPlanId,
    status,
    sourceCommit: plan.baseCommit,
    verifiedCommitId: null,
    treeId: null,
    parentCommitId: null,
    targetBranchRef: plan.targetBranchRef,
    refUpdated: false,
    canonicalManifestDigest: '0000000000000000000000000000000000000000000000000000000000000000',
    environmentSmokeReport: { passed: false, exitCode: 1, diagnostics },
    hookExecution: { status: 'none', journal: 'Hooks: none' },
    readyForMerge: false,
    completedAt: nowIso(),
    ...overrides,
  };

  const issues = check('delivery-result.schema.json', '', result);
  if (issues.length) {
    throw new Error(`Generated invalid DeliveryResult (failResult): ${issues.map(i => i.message).join('; ')}`);
  }

  return result;
}

export function deliveryManifestDigest(files, version = 1) {
  const entries = files.map(file => version === 1 ? { path: slash(file.path), digest: canonicalHash(file.content) } : {
    path: slash(file.path), operation: file.operation || 'write', mode: file.mode || '100644',
    digest: file.operation === 'delete' ? null : sha256(Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8')),
  }).sort((a, b) => version === 1 ? a.path.localeCompare(b.path) : compareText(a.path, b.path));
  return canonicalHash(entries);
}
