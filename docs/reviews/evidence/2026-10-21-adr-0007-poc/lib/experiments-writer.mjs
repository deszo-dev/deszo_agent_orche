// POC-05: single-writer enforcement. The owner process stays alive while the other paths are tried, so every refusal or
// acceptance is observed while a writer is genuinely holding the session. Each check states a requirement; the raw
// observations are kept in measurements.
import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppServer } from './codex-app-server.mjs';
import { check, verdict, home, listNames, WORKSPACE, ensureDirs, writeResult } from './poc-common.mjs';
import { DEFAULT_CODEX_HOME } from './experiments-session.mjs';

const developerItem = text => ({ type: 'message', role: 'developer', content: [{ type: 'input_text', text }] });
const marker = tag => `DESZO_ADR7_POC_${tag}_${Math.random().toString(36).slice(2, 10)}`;

export async function poc05() {
  ensureDirs();
  const checks = [], measurements = {};
  const shared = home('poc05-shared');

  // The owner (generation 1) creates the session and keeps running, holding its home's writer lock.
  const owner = new AppServer({ name: 'owner-generation-1', codexHome: shared });
  await owner.start();
  const created = await owner.call('thread/start', { cwd: WORKSPACE });
  const threadId = created.result.thread.id, rolloutPath = created.result.thread.path;
  const ownerSeed = await owner.call('thread/inject_items', { threadId, items: [developerItem(marker('SEED'))] });
  measurements.ownerSeedWriteOk = ownerSeed.ok;

  // S1: a second process in the same home, while the owner is alive.
  const second = new AppServer({ name: 'second-process-same-home', codexHome: shared });
  await second.start();
  const secondResume = await second.call('thread/resume', { threadId });
  let secondWrite = null;
  if (secondResume.ok) secondWrite = await second.call('thread/inject_items', { threadId, items: [developerItem(marker('SECOND'))] });
  measurements.S1 = { resumeAccepted: secondResume.ok, resumeError: secondResume.error?.message ?? null, writeAccepted: secondWrite?.ok ?? null, writeError: secondWrite?.error?.message ?? null };
  checks.push(check('S1 a second writable admission in the same home is refused while the owner is alive', !(secondResume.ok && secondWrite?.ok), `resume=${secondResume.ok} write=${secondWrite?.ok ?? 'not attempted'}`));
  await second.kill('end S1');

  // S2: the owner's generation is superseded by an explicit takeover recorded by Deszo. The old owner still runs and writes.
  const ledger = { generation1: 'superseded by takeover (Deszo ledger, not Codex state)', generation2: 'takeover recorded' };
  const staleWrite = await owner.call('thread/inject_items', { threadId, items: [developerItem(marker('STALE'))] });
  measurements.S2 = { ledger, staleWriteAccepted: staleWrite.ok, error: staleWrite.error?.message ?? null };
  checks.push(check('S2 a write from a superseded owner generation is refused by the client', !staleWrite.ok, staleWrite.ok ? 'accepted: Codex has no owner generation' : staleWrite.error?.message));

  // S3a: another profile without the experimental capability tries to load the same rollout by path, owner still alive.
  const plain = new AppServer({ name: 'other-profile-without-experimental-api', codexHome: home('poc05-other-plain') });
  await plain.start();
  const plainPath = await plain.call('thread/resume', { threadId, path: rolloutPath });
  measurements.S3a = { pathResumeAccepted: plainPath.ok, error: plainPath.error?.message ?? null };
  checks.push(check('S3a a profile without experimental capability cannot load the session by path', !plainPath.ok, plainPath.error?.message ?? 'loaded by path'));
  await plain.kill('end S3a');

  // S3b: another profile that declares experimentalApi loads the same rollout by path while the owner is still alive.
  const other = new AppServer({ name: 'other-profile-experimental-api', codexHome: home('poc05-other-experimental'), capabilities: { experimentalApi: true } });
  await other.start();
  const byPath = await other.call('thread/resume', { threadId, path: rolloutPath });
  let crossWrite = null, crossPersisted = null;
  if (byPath.ok) {
    const crossMarker = marker('CROSS');
    crossWrite = await other.call('thread/inject_items', { threadId, items: [developerItem(crossMarker)] });
    crossPersisted = crossWrite.ok && readFileSync(rolloutPath, 'utf8').includes(crossMarker);
  }
  measurements.S3b = { pathResumeAccepted: byPath.ok, error: byPath.error?.message ?? null, writeAccepted: crossWrite?.ok ?? null, writePersistedToOwnersRollout: crossPersisted };
  checks.push(check('S3b a second profile cannot write the session by path while the owner is alive', !(byPath.ok && crossWrite?.ok), byPath.ok ? `loaded by path; write=${crossWrite?.ok}` : byPath.error?.message));
  await other.kill('end S3b');

  // S3c: a same-user process copies the owner's rollout file into another home's session store and resumes it by identifier.
  // This is a file-level bypass of the session index, tested only inside the PoC homes; the owner stays alive throughout.
  const cloneHome = home('poc05-clone-target');
  const relative = rolloutPath.replace(/^.*?\\home-poc05-shared\\/, '').replaceAll('\\', '/');
  mkdirSync(dirname(`${cloneHome}/${relative}`), { recursive: true });
  copyFileSync(rolloutPath, `${cloneHome}/${relative}`);
  const clone = new AppServer({ name: 'clone-target-profile', codexHome: cloneHome });
  await clone.start();
  const cloneResume = await clone.call('thread/resume', { threadId });
  let cloneWrite = null;
  if (cloneResume.ok) cloneWrite = await clone.call('thread/inject_items', { threadId, items: [developerItem(marker('CLONE'))] });
  measurements.S3c = { copiedRolloutResumeAccepted: cloneResume.ok, resumeError: cloneResume.error?.message ?? null, cloneWriteAccepted: cloneWrite?.ok ?? null };
  checks.push(check('S3c a copied rollout cannot be resumed as the same session in another profile while the owner is alive', !(cloneResume.ok && cloneWrite?.ok), cloneResume.ok ? `resumed as clone; write=${cloneWrite?.ok}` : cloneResume.error?.message));
  await clone.kill('end S3c');

  // The owner exits. Whether the same-home lock is released and a takeover succeeds is measured, not assumed.
  await owner.kill('owner process ends');
  const takeover = new AppServer({ name: 'takeover-same-home-after-owner-exit', codexHome: shared });
  await takeover.start();
  const afterExit = await takeover.call('thread/resume', { threadId });
  measurements.takeoverAfterOwnerExit = { resumeAccepted: afterExit.ok, error: afterExit.error?.message ?? null };
  await takeover.kill('end takeover');

  // S4: the user's default profile is read by file names only. No process is started in it and no file is opened.
  const defaultRollouts = listNames(`${DEFAULT_CODEX_HOME}/sessions`, name => name.endsWith('.jsonl'));
  const threadInDefault = defaultRollouts.some(path => path.includes(threadId));
  measurements.S4 = { defaultProfileRolloutFilesCounted: defaultRollouts.length, dedicatedRolloutFound: threadInDefault };
  checks.push(check('S4 the dedicated session rollout is absent from the default profile session store (names only)', !threadInDefault));

  const record = {
    experiment: 'POC-05', title: 'Single-writer enforcement', status: verdict(checks), checks, measurements,
    ids: { threadId },
    notes: [
      'S1 shows Codex refuses a second writable admission to a session that a live process holds in the same home. The mechanism is a per-thread writer lock in thread-writer-locks/, with OS file locking. Lock files persist as zero-length files after exit, so their presence is not evidence that a lock is held.',
      'S2 shows the stale owner keeps writing: Codex has no owner generation, so a superseded holder is stopped only by Deszo terminating or fencing it.',
      'S3a and S3b are the isolation question. A profile without the experimental capability is refused by a capability gate (not by ownership). A profile that declares it is tested while the owner is alive, because the writer lock belongs to the holder\'s home, not to the rollout.',
      'The default profile was not started or written. Only file names were listed.',
    ],
  };
  writeResult('POC-05', record);
  return record;
}
