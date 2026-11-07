// P6-G0 Engine-side switch request (ADR-0010 section 5). The active Engine stops admitting new Runs, settles the ones it has,
// stages the exact candidate package while it stays selected, and then sends one fixed switch request. The Lifecycle Host
// fences Custody, stops this Engine's tree, performs the Store boundary and makes the single commit. This module never writes
// the selector and never stops anything itself.
// This module imports nothing from runtime/core: every runtime/host module is a Lifecycle Host entry point, and the P5 boundary
// protects everything it imports from self-repair. A refusal carries its HTTP status and stable code; the runner converts it.

/** A refusal of the switch path, with the HTTP status and the stable machine code the Engine's API reports. */
export class SwitchRefusal extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const ACTIVE_RUN_STATES = ['queued', 'running', 'draining', 'stopping'];
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const BUILD_ID = /^[A-Za-z0-9_-]{1,100}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createSwitchQuiescence() {
  return { active: false, operationId: null };
}

/** The admission gate: while a switch is quiescing or accepted, new Runs are refused with a stable code. */
export function assertAdmissionOpen(quiescence) {
  if (quiescence.active) throw new SwitchRefusal(503, 'switch_in_progress', 'The Engine is being replaced; new Runs are not admitted.');
}

// Waits until no Run is executing or about to. Runs waiting for the Owner are not executing and do not block the switch.
async function settle(engine, timeoutMs) {
  const sql = `SELECT COUNT(*) AS count FROM runs WHERE state IN (${ACTIVE_RUN_STATES.map(() => '?').join(',')})`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const active = engine.store.get(sql, ...ACTIVE_RUN_STATES).count;
    if (active === 0) return;
    if (Date.now() >= deadline) throw new SwitchRefusal(409, 'switch_not_quiescent', `${active} Run(s) are still executing; the switch waits for them to settle.`);
    await sleep(100);
  }
}

export async function requestEngineSwitch({ engine, lifecycleHost, quiescence, body, timeoutMs = 60_000,
  onStaged = null, beforeSwitchAdmission = null }) {
  if (!lifecycleHost) throw new SwitchRefusal(409, 'not_host_managed', 'Engine switching requires the managed Lifecycle Host.');
  const operationId = body?.operationId;
  const targetEngineBuildId = body?.targetEngineBuildId;
  const packageSha256 = body?.packageSha256;
  if (typeof operationId !== 'string' || !UUID.test(operationId)) throw new SwitchRefusal(400, 'invalid_request', 'operationId must be a UUID.');
  if (typeof targetEngineBuildId !== 'string' || !BUILD_ID.test(targetEngineBuildId)) throw new SwitchRefusal(400, 'invalid_request', 'targetEngineBuildId is malformed.');
  if (typeof packageSha256 !== 'string' || !SHA256.test(packageSha256)) throw new SwitchRefusal(400, 'invalid_request', 'packageSha256 must be lowercase SHA-256.');
  if (quiescence.active) throw new SwitchRefusal(409, 'switch_in_progress', 'An Engine switch is already in progress.');
  // A request that names the Engine already running asks for its operation's outcome, not for a new switch. A committed operation
  // returns its recorded status: nothing quiesces, stages, switches or commits again (the caller's retry after a lost acknowledgement).
  if (targetEngineBuildId === lifecycleHost.context.buildId) {
    const recorded = await hostCall(lifecycleHost, 'engine.switch_status', { operationId }).catch(error => {
      throw error instanceof SwitchUncertain ? new SwitchRefusal(409, 'switch_status_unconfirmed', 'The Host did not confirm the operation status.') : error;
    });
    if (recorded.phase === 'verified' && recorded.toEngineBuildId === targetEngineBuildId && recorded.packageSha256 === packageSha256) {
      return { operationId, accepted: false, duplicate: true, committed: true, phase: recorded.phase, toEngineBuildId: recorded.toEngineBuildId };
    }
    throw new SwitchRefusal(409, 'invalid_request', 'The target is the running Engine, and its operation is not a committed switch to it.');
  }
  quiescence.active = true;
  quiescence.operationId = operationId;
  let accepted = false;
  try {
    await settle(engine, timeoutMs);
    const context = lifecycleHost.context;
    const common = { operationId, fromEngineBuildId: context.buildId, toEngineBuildId: targetEngineBuildId, packageSha256,
      shellBuildId: context.shellBuildId, generation: context.generation };
    // Staging changes no selection and starts nothing: an unconfirmed staging reopens admission like any refusal.
    const staged = await hostCall(lifecycleHost, 'engine.stage', common).catch(error => {
      throw error instanceof SwitchUncertain ? new SwitchRefusal(409, 'switch_refused', 'The Host did not confirm the staging; the Engine stays selected.') : error;
    });
    // Stage is inert. Persist its exact operation/package evidence, then run the synchronous Store boundary that
    // serializes P5 Stop/invalidation against Host switch admission immediately before sending engine.switch.
    onStaged?.({ common, response: staged });
    beforeSwitchAdmission?.({ common, staged });
    let switched;
    try {
      switched = await hostCall(lifecycleHost, 'engine.switch', common);
    } catch (error) {
      // The Host may have accepted the switch before the reply was lost: ask it, and never reopen admission on a guess (M1).
      if (!(error instanceof SwitchUncertain)) throw error;
      switched = await confirmSwitch(lifecycleHost, common);
    }
    accepted = switched.accepted === true;
    if (!accepted) throw new SwitchRefusal(409, 'switch_refused', switched.phase ? `The switch is ${switched.phase}.` : 'The switch was not accepted.');
    return { operationId, accepted, phase: switched.phase ?? 'unconfirmed', stagedPhase: staged.phase };
  } finally {
    // Once the Host accepted the switch this Engine stays quiesced; the Host stops it. Otherwise it admits Runs again.
    if (!accepted) quiescence.active = false;
  }
}

// The Host's coded refusal changes nothing. Any other failure (a timeout or a lost reply) does not say whether the Host acted.
class SwitchUncertain extends Error {}

async function hostCall(lifecycleHost, command, payload) {
  try {
    return await lifecycleHost.p6Call(command, payload);
  } catch (error) {
    if (error.code) throw new SwitchRefusal(409, error.code, error.message);
    throw new SwitchUncertain(error.message);
  }
}

// After a lost switch reply, the same request is sent again. The Host serializes its decisions, so the second answer is the decision
// for the first request too: a request still being decided is answered after it, and an operation already accepted answers duplicate.
// A coded refusal means nothing was accepted; an unknown answer keeps this Engine quiesced, because the Host may stop it (M1, M-1).
async function confirmSwitch(lifecycleHost, common) {
  try {
    const switched = await lifecycleHost.p6Call('engine.switch', common);
    return { accepted: switched.accepted === true, phase: switched.phase };
  } catch (error) {
    if (error.code) return { accepted: false, phase: null };
    return { accepted: true, phase: null };
  }
}
