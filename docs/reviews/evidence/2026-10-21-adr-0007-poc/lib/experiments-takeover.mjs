// POC-06: takeover, fencing and ambiguous turn start. The takeover is a physical move of the session file, not a ledger entry,
// because only a move removes the stale owner's access. The owner must be fenced (stopped) before the move succeeds.
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppServer } from './codex-app-server.mjs';
import { check, verdict, home, WORKSPACE, ensureDirs, writeResult } from './poc-common.mjs';

const developerItem = text => ({ type: 'message', role: 'developer', content: [{ type: 'input_text', text }] });
const textItem = text => [{ type: 'text', text, text_elements: [] }];
const marker = tag => `DESZO_ADR7_POC_${tag}_${Math.random().toString(36).slice(2, 10)}`;
const relativeSessionPath = (rolloutPath, homeName) => rolloutPath.split(new RegExp(`${homeName}[\\\\/]`))[1];

export async function poc06() {
  ensureDirs();
  const checks = [], measurements = {};

  // Takeover by physical move. The worker (generation 1) owns the session; the successor (generation 2) must receive it.
  const workerHome = home('poc06-worker'), successorHome = home('poc06-successor');
  const worker = new AppServer({ name: 'worker-generation-1', codexHome: workerHome });
  await worker.start();
  const thread = (await worker.call('thread/start', { cwd: WORKSPACE })).result.thread;
  const threadId = thread.id, rolloutPath = thread.path;
  await worker.call('thread/inject_items', { threadId, items: [developerItem(marker('SEED'))] });
  const relative = relativeSessionPath(rolloutPath, 'home-poc06-worker');
  const destination = join(successorHome, relative);

  let movedWhileOwnerAlive = false;
  try { mkdirSync(dirname(destination), { recursive: true }); renameSync(rolloutPath, destination); movedWhileOwnerAlive = true; }
  catch (error) { measurements.moveWhileOwnerAlive = { succeeded: false, error: error.code ?? error.message }; }
  if (movedWhileOwnerAlive) measurements.moveWhileOwnerAlive = { succeeded: true, error: null };
  checks.push(check('a takeover cannot move the session file out from under a live owner', !movedWhileOwnerAlive, movedWhileOwnerAlive ? 'the move succeeded while the owner was alive' : measurements.moveWhileOwnerAlive.error));

  if (movedWhileOwnerAlive) {
    // The file is gone from the owner's path; the live owner's later write is observed to see where it lands.
    const stale = await worker.call('thread/inject_items', { threadId, items: [developerItem(marker('STALE-AFTER-MOVE'))] });
    measurements.staleWriteAfterMove = { accepted: stale.ok, landedInMovedFile: existsSync(destination) && readFileSync(destination, 'utf8').includes('STALE-AFTER-MOVE') };
    checks.push(check('a live owner cannot write the session after its file was moved away', !(stale.ok && measurements.staleWriteAfterMove.landedInMovedFile)));
  }

  // Fence the owner by stopping it, then perform the move and hand the session to the successor.
  await worker.kill('fence: stale owner stopped before takeover');
  if (!movedWhileOwnerAlive) { mkdirSync(dirname(destination), { recursive: true }); renameSync(rolloutPath, destination); }
  const successor = new AppServer({ name: 'successor-generation-2', codexHome: successorHome });
  await successor.start();
  const resumed = await successor.call('thread/resume', { threadId });
  checks.push(check('the successor resumes the same session identity after the owner is fenced and the file moved', resumed.ok && resumed.result?.thread?.id === threadId, resumed.error?.message));
  const successorWrite = await successor.call('thread/inject_items', { threadId, items: [developerItem(marker('SUCCESSOR'))] });
  checks.push(check('the successor can write after takeover', successorWrite.ok, successorWrite.error?.message));
  measurements.sourceHomeStillHoldsSession = existsSync(rolloutPath);
  checks.push(check('the source home no longer holds the moved session', !measurements.sourceHomeStillHoldsSession));
  const oldHome = new AppServer({ name: 'old-home-after-move', codexHome: workerHome });
  await oldHome.start();
  const oldResume = await oldHome.call('thread/resume', { threadId });
  checks.push(check('the old home cannot resume the moved session', !oldResume.ok, oldResume.error?.message ?? 'resumed from the old home'));
  await oldHome.kill('end old home check');
  await successor.kill('end successor');

  // Ambiguous start with the controlling process killed in flight, after turn/started and before completion.
  const inFlightHome = home('poc06-inflight');
  const owner = new AppServer({ name: 'in-flight-owner', codexHome: inFlightHome });
  await owner.start();
  const inFlightThread = (await owner.call('thread/start', { cwd: WORKSPACE })).result.thread.id;
  const fromF = owner.events.length;
  const pendingTurn = owner.call('turn/start', { threadId: inFlightThread, input: textItem(`ADR7 POC in-flight ${randomUUID()}`) });
  const startedF = await owner.waitFor(event => event.method === 'turn/started' && event.params?.threadId === inFlightThread, 30000, fromF);
  const responseF = await pendingTurn;
  const turnIdF = responseF.result?.turn?.id ?? null;
  await owner.kill('controlling process killed in flight, after turn/started');
  const recovery = new AppServer({ name: 'in-flight-recovery', codexHome: inFlightHome });
  await recovery.start();
  const listing = await recovery.call('thread/turns/list', { threadId: inFlightThread });
  const record = (listing.result?.data || []).find(turn => turn.id === turnIdF) ?? null;
  const startsAfterRecovery = await recovery.waitFor(event => event.method === 'turn/started' && event.params?.threadId === inFlightThread, 15000, recovery.events.length);
  measurements.inFlightKill = { turnStartedBeforeKill: Boolean(startedF), turnId: turnIdF, recordFoundAfterRestart: Boolean(record), recordStatus: record?.status ?? null, duplicateStartAfterRestart: Boolean(startsAfterRecovery) };
  checks.push(check('after a kill in flight, the turn is reconcilable by its identifier', Boolean(record)));
  checks.push(check('a restart does not start a duplicate turn automatically', !startsAfterRecovery));
  await recovery.kill('end in-flight recovery');

  // Ambiguous start with the kill before any acknowledgement. Nothing may be proven from absence; the result stays inconclusive.
  const earlyHome = home('poc06-early-kill');
  const early = new AppServer({ name: 'early-kill-owner', codexHome: earlyHome });
  await early.start();
  const earlyThread = (await early.call('thread/start', { cwd: WORKSPACE })).result.thread.id;
  const pendingEarly = early.call('turn/start', { threadId: earlyThread, input: textItem('ADR7 POC early kill') });
  await new Promise(resolve => setTimeout(resolve, 5));
  await early.kill('killed before acknowledgement');
  await pendingEarly;
  const afterEarly = new AppServer({ name: 'early-kill-recovery', codexHome: earlyHome });
  await afterEarly.start();
  const earlyListing = await afterEarly.call('thread/turns/list', { threadId: earlyThread });
  const earlyResume = await afterEarly.call('thread/resume', { threadId: earlyThread });
  measurements.earlyKill = { turnsRecordedAfterRestart: (earlyListing.result?.data || []).length, listingOk: earlyListing.ok, listingError: earlyListing.error?.message ?? null, threadResumeAfterKillOk: earlyResume.ok, threadResumeError: earlyResume.error?.message ?? null };
  checks.push(check('a session created with no items survives a kill immediately after creation', earlyResume.ok, earlyResume.error?.message ?? null));
  await afterEarly.kill('end early kill recovery');

  // Mitigation: the same creation followed by one seed item before the kill. Durability should follow from the first write.
  const seededHome = home('poc06-seeded-create');
  const seeded = new AppServer({ name: 'seeded-create-owner', codexHome: seededHome });
  await seeded.start();
  const seededThread = (await seeded.call('thread/start', { cwd: WORKSPACE })).result.thread.id;
  const seedWrite = await seeded.call('thread/inject_items', { threadId: seededThread, items: [developerItem(marker('SEEDED'))] });
  await seeded.kill('killed immediately after a seed item');
  const seededRecovery = new AppServer({ name: 'seeded-create-recovery', codexHome: seededHome });
  await seededRecovery.start();
  const seededResume = await seededRecovery.call('thread/resume', { threadId: seededThread });
  measurements.seededCreateKill = { seedWriteOk: seedWrite.ok, resumeAfterKillOk: seededResume.ok, resumeError: seededResume.error?.message ?? null };
  checks.push(check('a session with one seed item survives a kill immediately after creation', seedWrite.ok && seededResume.ok, seededResume.error?.message ?? null));
  await seededRecovery.kill('end seeded create recovery');

  const inconclusive = measurements.earlyKill.turnsRecordedAfterRestart === 0 && earlyResume.ok
    ? 'the early kill left no turn record; absence does not prove the start did not happen, so that case is not decided here' : null;
  const result = {
    experiment: 'POC-06', title: 'Takeover, fencing and ambiguous turn start', status: verdict(checks, { inconclusive }), checks, measurements,
    notes: [
      'Takeover is decided by a physical move. A live owner holds the session file, so the move is refused until the owner is stopped (fenced).',
      'The in-flight kill shows whether the App Server exposes the started turn after a restart and whether it starts a duplicate on its own.',
      'The early kill can leave no record; the intent must be reconciled by Deszo, not inferred from absence.',
    ],
  };
  writeResult('POC-06', result);
  return result;
}
