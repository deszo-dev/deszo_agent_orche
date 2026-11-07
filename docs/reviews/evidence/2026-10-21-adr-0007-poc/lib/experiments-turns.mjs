// Turn-related experiments. Without a sign-in in the isolated home, a turn is admitted and emits turn/started, then the model
// request fails with 401 and Codex retries. That is real App Server turn-start evidence, not a Judge wake-up: no model
// response or scoped-tool call can occur, so POC-03 is BLOCKED for the wake-up claim. Every active turn is bounded by
// interruption or observed completion. Unauthenticated requests are rejected at the provider edge; no credential is sent.
import { randomUUID } from 'node:crypto';
import { AppServer } from './codex-app-server.mjs';
import { check, verdict, home, WORKSPACE, ensureDirs, writeResult } from './poc-common.mjs';

const textItem = text => [{ type: 'text', text, text_elements: [] }];
const turnNotifications = (srv, threadId, from = 0) => srv.events.slice(from).filter(event => event.kind === 'notification' && event.params?.threadId === threadId && ['turn/started', 'turn/completed'].includes(event.method));
const EXPERIMENTAL = { experimentalApi: true };

function maxConcurrentTurns(events) {
  let active = 0, max = 0;
  for (const event of events) {
    if (event.method === 'turn/started') active += 1;
    if (event.method === 'turn/completed') active -= 1;
    max = Math.max(max, active);
  }
  return max;
}

async function startedAfter(srv, threadId, fromIndex, timeoutMs) {
  return srv.waitFor(event => event.method === 'turn/started' && event.params?.threadId === threadId, timeoutMs, fromIndex);
}

async function turnListing(srv, threadId) {
  const listed = await srv.call('thread/turns/list', { threadId });
  return listed.ok ? (listed.result?.data || []).map(turn => ({ id: turn.id, status: turn.status })) : { error: listed.error?.message };
}

// Arm 1: default capabilities. Turn A is active; turn B arrives while A is active. The question is what happens to B.
async function armDefault() {
  const checks = [], measurements = {};
  const srv = new AppServer({ name: 'arm-default', codexHome: home('poc04-default') });
  await srv.start();
  const threadId = (await srv.call('thread/start', { cwd: WORKSPACE })).result.thread.id;
  const fromA = srv.events.length;
  const turnA = srv.call('turn/start', { threadId, input: textItem(`ADR7 POC turn A ${randomUUID()}`) });
  const startedA = await startedAfter(srv, threadId, fromA, 30000);
  const respA = await turnA;
  const turnAId = respA.result?.turn?.id;
  measurements.turnA = { admissionAckMs: respA.ok ? Math.round(respA.durationMs * 1000) / 1000 : null, turnStartedAfterSendMs: startedA ? Math.round((startedA.atMs - respA.sentMs) * 1000) / 1000 : null, turnId: turnAId ?? null };
  checks.push(check('turn A is admitted and emits turn/started', Boolean(respA.ok && startedA), respA.error?.message));

  const fromB = srv.events.length;
  const bText = `ADR7 POC turn B ${randomUUID()}`;
  const respB = await srv.call('turn/start', { threadId, input: textItem(bText) });
  const bId = respB.result?.turn?.id ?? null;
  const bMerged = Boolean(respB.ok && turnAId && bId === turnAId);
  const notificationsWhileA = turnNotifications(srv, threadId, fromB).map(event => event.method);
  const bItemRecorded = srv.events.slice(fromB).some(event => event.kind === 'notification' && event.method === 'item/started' && JSON.stringify(event.params).includes(bText));
  measurements.turnB = { acceptedWhileAActive: respB.ok, error: respB.error?.message ?? null, initialStatus: respB.result?.turn?.status ?? null, turnId: bId, mergedIntoActiveTurnA: bMerged, contentRecordedAsItem: bItemRecorded, notificationsWhileAActive: notificationsWhileA };

  const steer = turnAId ? await srv.call('turn/steer', { threadId, expectedTurnId: turnAId, input: textItem('ADR7 POC steer into A') }) : { ok: false, error: { message: 'no turn id' } };
  measurements.steerIntoActiveTurnAccepted = steer.ok;

  let completedA = await srv.waitFor(event => event.method === 'turn/completed' && event.params?.turn?.id === turnAId, 150000, fromA);
  measurements.turnA.completedStatus = completedA?.params?.turn?.status ?? null;
  measurements.turnA.completedAtMs = completedA ? Math.round(completedA.atMs) : null;
  measurements.turnA.endedOnItsOwn = Boolean(completedA);
  if (!completedA && turnAId) {
    const interrupt = await srv.call('turn/interrupt', { threadId, turnId: turnAId });
    measurements.turnA.interruptAcknowledged = interrupt.ok;
    completedA = await srv.waitFor(event => event.method === 'turn/completed' && event.params?.turn?.id === turnAId, 30000, fromA);
  }

  const afterA = srv.events.length;
  const laterStart = await startedAfter(srv, threadId, afterA, 90000);
  measurements.afterTurnA = { startedTurnId: laterStart?.params?.turn?.id ?? null, startedWithinSeconds: laterStart ? 'yes, see turnId' : 'none within 90 s' };
  measurements.turnListingAfterA = await turnListing(srv, threadId);
  const bRecord = Array.isArray(measurements.turnListingAfterA) ? measurements.turnListingAfterA.find(turn => turn.id === bId) : null;
  measurements.turnB.recordAfterA = bRecord ?? null;

  const all = turnNotifications(srv, threadId, 0);
  measurements.maxConcurrentTurnsObserved = maxConcurrentTurns(all);
  checks.push(check('at most one autonomous turn runs per session', measurements.maxConcurrentTurnsObserved <= 1, `max=${measurements.maxConcurrentTurnsObserved}`));
  checks.push(check('turn B is not started while A is active', !notificationsWhileA.includes('turn/started')));
  // A second request must get its own lifecycle (refused explicitly, or started later as its own turn), not be merged into A.
  const ownLifecycle = respB.ok ? (!bMerged && Boolean(laterStart)) : Boolean(respB.error);
  checks.push(check('a second request during an active turn is refused explicitly or runs later as its own turn (not merged into A)', ownLifecycle, bMerged ? `merged: turn B returned turn A's id ${turnAId}` : (respB.ok ? `accepted as ${bId}; later start=${Boolean(laterStart)}` : respB.error?.message)));
  checks.push(check('the second request content is recorded in the session, not dropped', bItemRecorded, bItemRecorded ? null : 'no item/started carried its text'));
  await srv.kill('arm default done');
  return { arm: 'default-capabilities', checks, measurements };
}

// Arm 2: experimentalApi declared. Native queue: C is queued while A is active. Measures whether the App Server serializes C.
async function armExperimentalQueue() {
  const checks = [], measurements = {};
  const srv = new AppServer({ name: 'arm-experimental-queue', codexHome: home('poc04-queue'), capabilities: EXPERIMENTAL });
  const init = await srv.start();
  measurements.initialize = init.ok ? 'ok' : init.error?.message;
  const threadId = (await srv.call('thread/start', { cwd: WORKSPACE })).result.thread.id;
  const fromA = srv.events.length;
  const turnA = srv.call('turn/start', { threadId, input: textItem(`ADR7 POC queue arm A ${randomUUID()}`) });
  await startedAfter(srv, threadId, fromA, 30000);
  const respA = await turnA;
  const turnAId = respA.result?.turn?.id;

  const queuedAt = srv.events.length;
  const queueAdd = await srv.call('thread/queue/add', { threadId, clientUserMessageId: randomUUID(), input: textItem(`ADR7 POC queued C ${randomUUID()}`) });
  const queueList = await srv.call('thread/queue/list', { threadId });
  measurements.nativeQueue = { addOk: queueAdd.ok, addError: queueAdd.error?.message ?? null, listOk: queueList.ok, listSummary: JSON.stringify(queueList.result ?? queueList.error ?? {}).slice(0, 300) };
  checks.push(check('the native queue accepts a request while turn A is active', queueAdd.ok, queueAdd.error?.message));

  const completedA = await srv.waitFor(event => event.method === 'turn/completed' && event.params?.turn?.id === turnAId, 150000, fromA);
  measurements.turnA = { endedOnItsOwn: Boolean(completedA), completedStatus: completedA?.params?.turn?.status ?? null };
  const continuation = await startedAfter(srv, threadId, queuedAt, 90000);
  measurements.queuedRequestStarted = continuation ? { startedAtMs: Math.round(continuation.atMs), wallClockFromQueueMs: Math.round(continuation.atMs - queuedAt) } : null;
  const queueChanges = srv.events.slice(queuedAt).filter(event => event.kind === 'notification' && event.method === 'thread/queue/changed').length;
  measurements.queueChangedNotifications = queueChanges;
  checks.push(check('a queued request is started by the App Server after turn A completes (serialized, not concurrent)', Boolean(continuation) && maxConcurrentTurns(turnNotifications(srv, threadId, 0)) <= 1, continuation ? 'started after A' : 'not started within 90 s after A'));
  await srv.kill('arm experimental queue done');
  return { arm: 'experimental-native-queue', checks, measurements };
}

// Arm 3: interruption as the bound on an active turn. A is interrupted while still active.
async function armInterrupt() {
  const checks = [], measurements = {};
  const srv = new AppServer({ name: 'arm-interrupt', codexHome: home('poc04-interrupt') });
  await srv.start();
  const threadId = (await srv.call('thread/start', { cwd: WORKSPACE })).result.thread.id;
  const fromD = srv.events.length;
  const turnD = srv.call('turn/start', { threadId, input: textItem(`ADR7 POC interrupt probe ${randomUUID()}`) });
  const startedD = await startedAfter(srv, threadId, fromD, 30000);
  const respD = await turnD;
  const turnDId = respD.result?.turn?.id;
  await new Promise(resolve => setTimeout(resolve, 3000));
  const interrupt = await srv.call('turn/interrupt', { threadId, turnId: turnDId });
  const completedD = await srv.waitFor(event => event.method === 'turn/completed' && event.params?.turn?.id === turnDId, 30000, fromD);
  // Both timestamps are on the same runner-relative clock: interrupt.sentMs and the notification's atMs.
  measurements.interrupt = { startedTurn: Boolean(startedD), acknowledged: interrupt.ok, error: interrupt.error?.message ?? null, completedStatus: completedD?.params?.turn?.status ?? null, interruptToCompletionMs: completedD ? Math.round((completedD.atMs - interrupt.sentMs) * 1000) / 1000 : null };
  checks.push(check('an active turn can be bounded by turn/interrupt and reaches a terminal status', Boolean(interrupt.ok && completedD), interrupt.error?.message ?? (completedD ? null : 'no turn/completed within 30 s')));
  await srv.kill('arm interrupt done');
  return { arm: 'interrupt-bound', checks, measurements };
}

export async function poc04() {
  ensureDirs();
  const arms = [await armDefault(), await armExperimentalQueue(), await armInterrupt()];
  const checks = arms.flatMap(arm => arm.checks.map(item => ({ ...item, name: `[${arm.arm}] ${item.name}` })));
  const record = {
    experiment: 'POC-04', title: 'Concurrent escalations and serialization', status: verdict(checks), checks,
    measurements: Object.fromEntries(arms.map(arm => [arm.arm, arm.measurements])),
    notes: [
      'Each arm starts its own App Server in an isolated home. The active turns end through Codex retries of unauthenticated model requests, not through a model answer, so timings are control-path measurements only.',
      'The default arm does not declare experimentalApi, so thread/queue/* is not available there; the queue arm declares it. Experimental methods are a capability to be justified, not assumed safe.',
    ],
  };
  writeResult('POC-04', record);
  return record;
}

export async function poc03() {
  // The wake-up claim needs a model response and a scoped tool call. Neither is possible without a sign-in in the isolated home.
  const srv = new AppServer({ name: 'wake-up-probe', codexHome: home('poc03-wakeup') });
  await srv.start();
  const account = await srv.call('account/read', {});
  const blockedReason = account.ok && account.result?.account ? null : `isolated CODEX_HOME has no account (account/read ${account.ok ? 'returned no account' : `error: ${account.error?.message}`})`;
  await srv.kill('end POC-03 probe');
  const record = {
    experiment: 'POC-03', title: 'Real event-triggered Judge turn', status: 'BLOCKED',
    checks: [
      check('turn-start evidence is observable from the App Server (POC-04 arm 1 measures turn/started)', true),
      // pass: null means not evaluated. A blocked requirement is neither a pass nor a contradicted requirement.
      { name: 'a Judge response is received and correlated to the request', pass: null, detail: blockedReason },
      { name: 'a harmless scoped tool is called by the model', pass: null, detail: blockedReason },
    ],
    blocker: blockedReason,
    unblockBy: 'The user completes the device sign-in into the isolated home (command in README). No credential is copied from the default profile.',
    notes: ['turn/started is recorded as a turn-start fact only; it is not a successful wake-up without a model response.'],
  };
  writeResult('POC-03', record);
  return record;
}
