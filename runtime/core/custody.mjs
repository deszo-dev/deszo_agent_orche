// Process Custody (PoC), Engine side. The Lifecycle Host launches an admitted provider CLI into its own Job and spools its
// output durably. This module admits and launches through the Host, pulls the spool into the same recorders and parser the
// Engine already uses, and resumes from committed offsets when a new Engine attaches. The Host owns the process; the Engine
// owns every workflow decision. Replacing the Engine never restarts, duplicates or re-prompts the CLI.
//
// Workspace ownership (H3): a Host-owned CLI may modify its workspace for as long as its process tree runs, whatever the Engine
// can reach. So the Engine's durable hold on that workspace (custody_workspace_holds) is released only on the Host's proof that the
// process tree has ended (`processTreeEnded`). Losing the Host is a fact about the Engine's knowledge, not about the process: an
// unreachable Host is waited for, never settled as an outcome, and never releases a hold.
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { parseStrictJson } from './canonical.mjs';
import { nowIso } from './store.mjs';
import { isAlive, killTree } from './processes.mjs';
import { transportSchema } from './transport.mjs';
import { resolveEffort } from '../../shared/effort.mjs';
import { resolveWorkspaceRoot, workspaceRootsOverlap } from './workspaceIsolation.mjs';

const POLL_MS = 100;
const READ_BYTES = 32 * 1024;
// One command line must fit the Host's 128 KiB IPC line with its envelope; leave headroom for the capability and framing.
const MAX_COMMAND_BYTES = 120 * 1024;
// While the Host cannot be reached, the Engine asks again at this interval. Asking again never settles or releases anything.
const RETRY_MS = 500;
// How often a live Engine checks its durable workspace holds against the Host.
export const HOLD_RECONCILE_MS = 2_000;
// Host states after which the CLI is gone and its output is final (or known to be incomplete).
const HOST_ENDED = new Set(['host_lost', 'host_stopped', 'refused_host_restart']);
// Host states whose spool is not a complete record of the process; the attempt fails at its capture, not at its result.
const CAPTURE_FAULTS = new Set(['spool_limit_exceeded', 'spool_failed']);
// The Host's own stops: a Stop the Engine or the emergency credential asked for, or the admitted deadline. Such an end is a stop outcome and never a
// result, whatever its exit code (F3).
export const STOP_FAMILY = new Set(['stopped', 'deadline_terminated', 'emergency_stopped']);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Crash-point hook for the replay audit. A test names one point; the Engine then exits without any cleanup, so that a later
// Engine must recover from exactly the state that point leaves. Unset in production, it does nothing.
export function custodyFaultPoint(name) {
  if (process.env.DESZO_CUSTODY_TEST_FAULT === name) process.exit(97);
}

// Test-only identity hold and crash point, between the OS creation of a launched process and the durable record of its identity (the spawn handler,
// before the attempt row names the process). A test names a marker file whose content is a delay in milliseconds. The first launch that reaches this
// point consumes the marker, withholds the identity write, and keeps the Engine running for the delay (so the launched process starts and writes),
// then ends the Engine without cleanup. Returns true while the identity is held. Inert unless the variable names a marker.
export function crashBeforeIdentityPoint() {
  const marker = process.env.DESZO_TEST_CRASH_BEFORE_IDENTITY_MARKER;
  if (!marker || !existsSync(marker)) return false;
  const delayMs = Number(readFileSync(marker, 'utf8')) || 0;
  unlinkSync(marker);
  setTimeout(() => process.exit(97), delayMs);
  return true;
}

// Scheduling barrier for the admission race proofs. Each admission (Custody dispatch, managed-task delivery) checks and claims ownership in one
// synchronous step, then starts its work through this function. Inert unless a test installs `engine.testBarrier`: then the work waits for the
// barrier's promise, so the test can hold one side's claim while the other side is submitted. Production calls the work synchronously.
export function afterBarrierWork(barrier, name, detail, work) {
  const hold = barrier ? barrier(name, detail) : null;
  return hold ? Promise.resolve(hold).then(work) : work();
}

// Test-only outage injection for the workspace-hold proofs. Inert unless the environment names it. While the named file exists, every
// Host call fails as unreachable; the Host itself keeps running and the CLI keeps running under it.
export function custodyOutageActive() {
  const file = process.env.DESZO_CUSTODY_TEST_OUTAGE_FILE;
  return Boolean(file) && existsSync(file);
}

// Test-only refusal injection for the unresolved-condition proofs. Inert unless the environment names it. While the named file exists, every
// Host command about the invocation it names is refused as `not_found`, as a Host without that record answers; the Host and its CLI run on.
// Each refused command is appended to `<file>.calls`, so that a proof can count what the Engine asked.
export function custodyRefusalActive(custodyId, command) {
  const file = process.env.DESZO_CUSTODY_TEST_REFUSE_FILE;
  if (!file || !existsSync(file)) return false;
  let target = '';
  try { target = readFileSync(file, 'utf8').trim(); } catch { return false; }
  if (target !== custodyId) return false;
  appendFileSync(`${file}.calls`, `${Date.now()} ${command}\n`);
  return true;
}

function refusal(code, message) {
  return Object.assign(new Error(message), { code });
}

// A transport failure carries no Host refusal code; an injected outage carries the transport code. Every other failure is the Host's answer.
function transient(error) {
  return !error.code || error.code === 'custody_unreachable' || error.code === 'custody_unavailable';
}

// A newer Engine controls custody, or the caller is not authorized: this Engine must stop acting on the invocation at once.
// `stale_generation` is the same fence one level up: the Host now serves a newer lifecycle generation than this Engine's.
function fenced(error) {
  return error.code === 'stale_engine' || error.code === 'stale_generation' || error.code === 'unauthorized';
}

// The typed unresolved condition of a definitive Host refusal: what was refused, by which command, under which Engine epoch.
function unresolvedCondition(engine, error) {
  return { code: 'custody_unresolved', refusal: error.code, command: error.command ?? null, message: String(error.message).slice(0, 500),
    epoch: engine.custodyEpoch, generation: engine.custodyHost?.context?.generation ?? null, at: nowIso() };
}

// One provider process. It satisfies the child contract runProcess consumes (pid, stdout/stderr data, spawn, close, error)
// but its bytes come from the Host's spool, and its end is the Host's terminal record.
class CustodyChild extends EventEmitter {
  constructor(engine, { runId, attemptId, provider, invocation, deadlineMs, resume }) {
    super();
    Object.assign(this, { engine, runId, attemptId, provider, invocation, deadlineMs, resume });
    this.custody = true;
    this.custodyId = null;
    this.pid = null;
    this.startIdentity = null;
    this.stdin = { on() {}, end() {} };
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.cursor = { stdout: 0, stderr: 0 };
    this.eof = { stdout: false, stderr: false };
    this.stopped = false;
    this.stopRequested = false;
    this.stopDelivered = false;
    this.closed = false;
    this.commit = null;
    this.custodyState = null;
    // The Host's word on the spool. Only a confirmed complete spool may close this attempt's stream as complete.
    this.spoolComplete = false;
    this.faultReported = false;
    this.detached = false;
    // The typed condition of a definitive Host refusal, while one stands. The child then asks nothing; the hold reconciler asks for it.
    this.unresolved = null;
    this.spawned = false;
  }

  begin() {
    this.engine.custodyChildren ??= new Map();
    this.engine.custodyChildren.set(this.attemptId, this);
    this.run().catch(error => this.fail(error));
  }

  async run() {
    if (this.resume) return this.reattach();
    if (this.engine.custodyBindingOf(this.attemptId)) throw refusal('custody_binding_exists', 'This attempt already has a Host-owned process; it is not launched again.');
    // PDE-R10 at the Custody boundary: the synchronous check every Engine-owned launch passes, before admission and again
    // immediately before the launch request, because admission and launch are separate Host calls.
    this.engine.assertLinkedRepairLaunch(this.runId);
    const env = Object.fromEntries(Object.entries(this.invocation.env ?? process.env).filter(([, value]) => typeof value === 'string'));
    const request = { attemptId: this.attemptId, runId: this.runId, provider: this.provider,
      command: this.invocation.command, args: this.invocation.args, cwd: this.invocation.cwd, env,
      stdinHex: this.invocation.stdin == null ? null : Buffer.from(this.invocation.stdin, 'utf8').toString('hex'), deadlineMs: this.deadlineMs };
    // The Host reads one bounded line per command. An admission that cannot fit is refused here, before anything is admitted.
    if (Buffer.byteLength(JSON.stringify(request)) > MAX_COMMAND_BYTES) throw refusal('custody_request_too_large', 'The invocation is too large for one custody admission; it was not launched.');
    const reserved = await this.reserveUntilAnswered(request);
    if (!reserved.permit) {
      // The admission exists at the Host without its permit: it is withdrawn, so that it can never become a process.
      if (reserved.custodyId) await this.withdrawAdmissionUntilConfirmed(reserved.custodyId);
      if (this.engine.parentRepairDispatchPaused?.(this.runId))
        throw refusal('parent_suspension_requested', 'The Parent was suspended before this provider process could be launched.');
      throw refusal('custody_admission_lost', 'This invocation was admitted earlier and its launch permit is gone; it was not launched again.');
    }
    this.custodyId = reserved.custodyId;
    // Parent repair may be requested while Host admission is in flight. Withdraw the unlaunched admission before
    // writing a Custody binding or asking the Host to launch it; the coordinator will resume this attempt after Repair.
    if (this.engine.parentRepairDispatchPaused?.(this.runId)) {
      await this.withdrawAdmissionUntilConfirmed(reserved.custodyId);
      throw refusal('parent_suspension_requested', 'The Parent was suspended before this provider process could be launched.');
    }
    // Durable before anything can run: the binding, so a restarted Engine finds the process the Host started, and the workspace hold,
    // so that no other Run uses the workspace while the Host-owned process may still run in it. Both commit together, before the launch.
    // The hold is the root the Host admitted (its canonical cwd), not the path requested, so a retarget between the two cannot move the hold.
    try {
      this.engine.custodyRecordLaunchIntent({ attemptId: this.attemptId, runId: this.runId, custodyId: reserved.custodyId,
        emergencyToken: reserved.emergencyToken, root: resolveWorkspaceRoot(reserved.cwd ?? this.invocation.cwd) });
    } catch (error) {
      // Without the durable binding and hold, the admission is withdrawn before anything can run.
      await this.engine.custodyCall('custody.cancel', { custodyId: reserved.custodyId }).catch(() => {});
      throw error;
    }
    try {
      this.engine.assertLinkedRepairLaunch(this.runId);
    } catch (error) {
      // The admission is withdrawn, so the Host can never turn it into a process; the guard's refusal is what the Run records.
      const canceled = await this.engine.custodyCall('custody.cancel', { custodyId: this.custodyId }).catch(() => null);
      if (canceled) this.engine.custodyReleaseIfEnded(this.custodyId, canceled);
      throw error;
    }
    // A Stop that arrived while the admission was in flight: the admission is withdrawn, so the Host can never turn it into a process.
    if (this.stopRequested || this.engine.processes?.get(this.attemptId)?.stopRequested) {
      this.stopRequested = true;
      await this.engine.custodyCall('custody.cancel', { custodyId: this.custodyId }).catch(() => {});
      throw refusal('stopped_before_launch', 'The run was stopped before its CLI launched; nothing was started.');
    }
    const launched = await this.launchUntilAnswered(reserved.permit);
    if (launched.state !== 'running') throw refusal('launch_failed', `The Host did not start the CLI (${launched.state}).`);
    this.pid = launched.processId;
    this.startIdentity = `custody:${launched.processCreationTime}`;
    this.spawned = true;
    this.emit('spawn');
    this.pump();
  }

  // A prelaunch admission is safe to classify as withdrawn only after the Host proves that it can never launch.
  // A lost response is retried idempotently; while the Host is unavailable, Parent suspension stays pending.
  async withdrawAdmissionUntilConfirmed(custodyId) {
    for (;;) {
      let status;
      try { status = await this.engine.custodyCall('custody.cancel', { custodyId }); }
      catch (error) {
        if (fenced(error)) throw error;
        if (!transient(error)) throw error;
        await sleep(RETRY_MS);
        continue;
      }
      if (status?.state === 'admission_cancelled' && status.terminal === true && status.processTreeEnded === true) return status;
      if (status?.state === 'admitted' && status.processId == null) {
        await sleep(POLL_MS);
        continue;
      }
      throw refusal('custody_withdrawal_unconfirmed', 'The Host did not prove that the prelaunch admission was withdrawn.');
    }
  }

  // An admission is idempotent for its attempt, so a reserve whose reply was lost is asked again. The repeated answer carries no permit when
  // the first admission was made; the run then fails without any process, which is the correct outcome for an admission that never ran.
  async reserveUntilAnswered(request) {
    for (;;) {
      try {
        return await this.engine.custodyCall('custody.reserve', request);
      } catch (error) {
        if (!transient(error)) throw error;
        await sleep(RETRY_MS);
      }
    }
  }

  // A launch reply can be lost after the Host has started the CLI. The launch is idempotent for its permit: a repeated launch returns the
  // invocation's existing record and starts nothing. So the Engine asks again until the Host answers. It never gives up into a second
  // spawn and never stops a CLI it has not heard from. A refusal from the Host is final.
  async launchUntilAnswered(permit) {
    let reported = false;
    for (;;) {
      try {
        const launched = await this.engine.custodyCall('custody.launch', { custodyId: this.custodyId, permit });
        if (reported) {
          const status = await this.engine.custodyCall('custody.status', { custodyId: this.custodyId });
          this.engine.custodyClearUnresolved(this.custodyId, status);
        }
        return launched;
      } catch (error) {
        if (!transient(error)) throw error;
        if (!reported) this.engine.custodyRecordUnresolved(this.custodyId, unresolvedCondition(this.engine, error));
        reported = true;
        await sleep(RETRY_MS);
      }
    }
  }

  // An Engine that exits gracefully leaves its CLI to the Host. This child stops observing; nothing is stopped or awaited here.
  detach() {
    this.stopped = true;
    this.detached = true;
    this.engine.custodyChildren?.delete(this.attemptId);
  }

  // The Host's record for this invocation, once the Host answers. An unreachable Host is waited for: no outcome is settled from it.
  // Returns null when this Engine no longer owns the attempt (fenced or unauthorized), or when the Host refused to answer for it (the
  // attempt is then unresolved, and the hold reconciler continues it).
  async statusUntilAnswered() {
    for (;;) {
      if (this.detached) return null;
      try {
        return await this.engine.custodyCall('custody.status', { custodyId: this.custodyId });
      } catch (error) {
        if (fenced(error)) {
          this.detach();
          return null;
        }
        if (!transient(error)) {
          this.unresolve(error);
          return null;
        }
        await sleep(RETRY_MS);
      }
    }
  }

  // A definitive Host refusal about this invocation (for example `not_found`: the Host answering has no record of it) is not evidence that
  // its process tree ended; the CLI may still run under the Host that launched it. So the child stops asking (no retry cycle), settles
  // nothing, keeps its attempt running, its lock taken and its workspace held, and the condition is recorded once for the operator. The hold
  // reconciler asks the Host again on its own cadence and hands the answer to resolveUnresolved.
  unresolve(error) {
    this.stopped = true;
    this.unresolved = unresolvedCondition(this.engine, error);
    this.engine.custodyRecordUnresolved(this.custodyId, this.unresolved);
  }

  // The Host answered for an unresolved invocation. The same process continues: its identity must be the one this attempt recorded, or the
  // condition stands. A child that had not attached yet attaches now; one that had continues reading from its committed offsets, and its
  // end (with any Stop still undelivered) follows the ordinary path. Nothing is launched again.
  resolveUnresolved(status) {
    if (!this.unresolved || this.detached) return;
    if (this.spawned) {
      const recorded = this.engine.store.get('SELECT process_start_identity FROM attempts WHERE id = ?', this.attemptId)?.process_start_identity;
      const identity = status.processCreationTime == null ? null : `custody:${status.processCreationTime}`;
      if (status.state === 'admitted' || identity !== (recorded ?? this.startIdentity)) {
        return this.unresolve(refusal('custody_identity_mismatch', 'The Host answered for this invocation with a process that is not the one this attempt recorded.'));
      }
    }
    this.unresolved = null;
    this.engine.custodyClearUnresolved(this.custodyId, status);
    this.stopped = false;
    this.closed = false;
    this.faultReported = false;
    if (!this.spawned) return this.reattach().catch(error => this.fail(error));
    this.pump();
  }

  // An attached Engine reads the Host's record for its attempt. It never launches; it only observes and drains.
  async reattach() {
    const binding = this.engine.custodyBindingOf(this.attemptId);
    if (!binding) throw refusal('custody_binding_missing', 'The attempt has no Host-owned process to reattach.');
    this.custodyId = binding.custody_id;
    this.cursor = { stdout: this.engine.custodyCommittedBytes(this.attemptId, 'stdout'), stderr: this.engine.custodyCommittedBytes(this.attemptId, 'stderr') };
    const status = await this.statusUntilAnswered();
    // This Engine does not own the attempt any more (fenced or unauthorized): it settles nothing and the owning Engine decides.
    if (status === null) return;
    // The Host answers for the invocation, so a condition an earlier Engine recorded no longer stands.
    this.engine.custodyClearUnresolved(this.custodyId, status);
    // A record that never reached a running CLI is not a process to observe; it was never launched and is never launched again.
    if (status.state === 'admitted') {
      // Withdraw the admission so that it can never launch; the workspace hold is released on the withdrawn record.
      await this.engine.custodyCall('custody.cancel', { custodyId: this.custodyId }).catch(() => {});
      throw refusal('custody_admission_lost', 'The Host admitted this invocation but never launched it.');
    }
    if (['refused_host_restart', 'permit_expired', 'launch_failed', 'admission_cancelled'].includes(status.state) || status.processId == null) {
      throw refusal('custody_not_launched', status.terminationReason || `The Host did not launch this invocation (${status.state}).`);
    }
    this.pid = status.processId;
    this.startIdentity = `custody:${status.processCreationTime}`;
    // PID reuse guard: the Host's creation time must be the one the Engine recorded when it first saw this process.
    const recorded = this.engine.store.get('SELECT process_start_identity FROM attempts WHERE id = ?', this.attemptId)?.process_start_identity;
    if (recorded && recorded !== this.startIdentity) throw refusal('custody_identity_mismatch', 'The process the Host holds is not the one this attempt recorded.');
    this.spawned = true;
    this.emit('spawn');
    this.pump();
  }

  async pump() {
    while (!this.stopped) {
      try {
        if (this.stopRequested && !this.stopDelivered) await this.deliverStop();
        let progressed = false;
        for (const stream of ['stdout', 'stderr']) {
          if (this.eof[stream]) continue;
          const page = await this.engine.custodyCall('custody.read', { custodyId: this.custodyId, stream, offset: this.cursor[stream], max: READ_BYTES });
          if (this.faultReported) {
            const status = await this.engine.custodyCall('custody.status', { custodyId: this.custodyId });
            this.engine.custodyClearUnresolved(this.custodyId, status);
          }
          this.faultReported = false;
          if (page.nextOffset > page.offset) {
            // Bytes are delivered to the Engine's recorders before the Host hears they are committed.
            this.cursor[stream] = page.nextOffset;
            this[stream].emit('data', Buffer.from(page.dataHex, 'hex'));
            progressed = true;
          }
          this.eof[stream] = page.eof;
        }
        if (progressed && this.commit) {
          custodyFaultPoint('after_deliver');
          const committed = this.commit();
          custodyFaultPoint('after_commit');
          for (const stream of ['stdout', 'stderr']) {
            if (committed[stream] > 0) await this.engine.custodyCall('custody.ack', { custodyId: this.custodyId, stream, offset: committed[stream] });
          }
          custodyFaultPoint('after_ack');
        }
        if (this.eof.stdout && this.eof.stderr) return this.finish();
        if (!progressed) await sleep(POLL_MS);
      } catch (error) {
        // A fenced Engine (a newer one attached) or an unauthorized caller must stop writing at once. The attempt is left for the Engine
        // that owns it; this one settles nothing.
        if (fenced(error)) { this.detach(); return; }
        // A definitive refusal ends this cycle: the attempt is unresolved, never settled (see unresolve).
        if (!transient(error)) return this.unresolve(error);
        // An unreachable Host is a fault in the Engine's knowledge of the process, never an outcome. The CLI keeps running under the Host,
        // and the Engine keeps asking. The first failure of each episode is reported, so that it is never silent.
        if (!this.faultReported) {
          this.engine.custodyRecordUnresolved(this.custodyId, unresolvedCondition(this.engine, error));
          process.stderr.write(`Process Custody: ${this.custodyId} ${error.code ?? 'error'}: ${error.message}\n`);
        }
        this.faultReported = true;
        await sleep(RETRY_MS);
      }
    }
  }

  // The stop reaches the Host. A stop the Host has not received is retried by the pump, so an unreachable Host never drops it. The Host
  // accepts a stop of an ended invocation, so a refused stop was not applied: it stays pending, and the pump's refusal handling applies.
  async deliverStop() {
    await this.engine.custodyCall('custody.stop', { custodyId: this.custodyId });
    this.stopDelivered = true;
  }

  async finish() {
    if (this.closed) return;
    this.closed = true;
    this.stopped = true;
    // The CLI's end is the Host's terminal record. Output can end before the record does, so the record is awaited, not guessed.
    let status = await this.statusUntilAnswered();
    while (status && !status.terminal) {
      await sleep(RETRY_MS);
      status = await this.statusUntilAnswered();
    }
    if (status === null) return;
    this.custodyState = status.state;
    this.spoolComplete = status.spoolComplete === true;
    let code = null, outcomeSignal = null;
    if (HOST_ENDED.has(status.state)) outcomeSignal = status.state;
    else if (CAPTURE_FAULTS.has(status.state)) outcomeSignal = status.state;
    // A process that exited with an incomplete spool (a stream that failed or was cut short) is not a complete result.
    else if (status.state === 'exited' && status.spoolComplete !== true) outcomeSignal = 'spool_incomplete';
    // F3: the Host's proof that the process tree ended gates every end that could be read as a result, whatever its state and exit code. A
    // leader that exited while the Host has not proven its process tree ended is not an accepted result (S5); its hold waits for the proof.
    else if (status.processTreeEnded !== true) outcomeSignal = 'tree_not_ended';
    // A stop the Host performed is a stop outcome, not a result, even when its tree is proven and its exit code is zero.
    else if (STOP_FAMILY.has(status.state)) outcomeSignal = status.state;
    else code = status.exitCode;
    this.engine.custodyReleaseIfEnded(this.custodyId, status);
    this.engine.custodyChildren?.delete(this.attemptId);
    if (this.commit) this.commit();
    this.emit('close', code, outcomeSignal);
  }

  // An operator Stop reaches the Host and is retried until the Host has it. The Host terminates the Job; this child closes once the
  // Host's record is terminal.
  stop() {
    this.stopRequested = true;
    if (!this.custodyId) return Promise.resolve();
    return this.deliverStop().catch(() => {});
  }

  fail(error) {
    this.closed = true;
    this.stopped = true;
    this.engine.custodyChildren?.delete(this.attemptId);
    this.emit('error', error);
  }
}

export function installCustody(Engine) {
  const P = Engine.prototype;

  // Every Host command carries this Engine's epoch and the lifecycle generation it was started under. The two test-only fault
  // injections are inert unless their environment is set: an outage makes the Host unreachable; the launch-reply fault loses the reply
  // to the first launch after the Host has started the CLI.
  P.custodyCall = function custodyCall(command, payload = {}) {
    // An Engine without Custody can still find Host-owned processes recorded by an earlier one. It cannot reach their Host, so every
    // call is unavailable: nothing is settled, and their workspaces stay held until an Engine with Custody reconciles them.
    if (!this.custodyHost) return Promise.reject(refusal('custody_unavailable', 'Process Custody is not enabled in this Engine; the Lifecycle Host that owns this process cannot be reached.'));
    if (this.custodyUnavailable) return Promise.reject(refusal('custody_unavailable', this.custodyUnavailable));
    if (custodyOutageActive()) return Promise.reject(refusal('custody_unreachable', 'Injected outage: the Lifecycle Host was not reached.'));
    if (payload.custodyId && custodyRefusalActive(payload.custodyId, command)) return Promise.reject(Object.assign(refusal('not_found', 'Injected refusal: No custody record has that identity.'), { command }));
    // A refusal names the command it answered, for the unresolved condition it may become.
    const call = this.custodyHost.custody(command, { ...payload, epoch: this.custodyEpoch, generation: this.custodyHost.context.generation })
      .catch(error => { throw error instanceof Error ? Object.assign(error, { command: error.command ?? command }) : error; });
    if (command === 'custody.launch' && process.env.DESZO_CUSTODY_TEST_DROP_LAUNCH_REPLY === '1' && !this.custodyLaunchReplyLost) {
      this.custodyLaunchReplyLost = true;
      return call.then(() => { throw refusal('custody_unreachable', 'Injected fault: the launch reply was lost after the Host launched the CLI.'); });
    }
    return call;
  };

  // Attaching makes this Engine the only one that controls custody; the Host refuses an older epoch from now on.
  P.custodyAttach = async function custodyAttach() {
    try {
      const attached = await this.custodyHost.custody('custody.attach', { generation: this.custodyHost.context.generation });
      this.custodyEpoch = attached.epoch;
      this.custodyUnavailable = null;
    } catch (error) {
      this.custodyUnavailable = `Process Custody is unavailable: ${error.message}`;
      process.stderr.write(`${this.custodyUnavailable}\n`);
    }
  };

  P.custodyBindingOf = function custodyBindingOf(attemptId) {
    return this.store.get('SELECT * FROM attempt_custody WHERE attempt_id = ?', attemptId) ?? null;
  };

  // The binding and the workspace hold of one invocation, written together before its launch. A hold is the Engine's promise that no
  // other Run uses this physical root until the Host proves the invocation's process tree has ended.
  P.custodyRecordLaunchIntent = function custodyRecordLaunchIntent({ attemptId, runId, custodyId, emergencyToken, root }) {
    this.store.transaction(() => {
      this.store.run('INSERT INTO attempt_custody(attempt_id, run_id, custody_id, emergency_token, created_at) VALUES (?, ?, ?, ?, ?)',
        attemptId, runId, custodyId, emergencyToken, nowIso());
      this.store.run(`INSERT INTO custody_workspace_holds(custody_id, attempt_id, run_id, workspace_root, state, held_at) VALUES (?, ?, ?, ?, 'held', ?)`,
        custodyId, attemptId, runId, root, nowIso());
    });
  };

  // Releases a durable hold only on the Host's proof that the invocation's process tree has ended. Any other status keeps it held.
  P.custodyReleaseIfEnded = function custodyReleaseIfEnded(custodyId, status) {
    if (status?.processTreeEnded !== true) return false;
    const hold = this.store.get("SELECT run_id,attempt_id FROM custody_workspace_holds WHERE custody_id = ? AND state = 'held'", custodyId);
    custodyFaultPoint('before_hold_release');
    const evidence = { hostState: status.state, processTreeEnded: true, exitCode: status.exitCode ?? null,
      spoolComplete: status.spoolComplete === true, terminationReason: status.terminationReason ?? null };
    this.store.transaction(() => {
      this.store.run(`UPDATE custody_workspace_holds SET state = 'released', evidence_json = ?, released_at = ? WHERE custody_id = ? AND state = 'held'`,
        JSON.stringify(evidence), nowIso(), custodyId);
      if (hold) {
        const previousRow = this.store.get('SELECT outcome_json FROM failure_outcomes WHERE attempt_id = ?', hold.attempt_id);
        const attempt = this.store.get('SELECT * FROM attempts WHERE id = ?', hold.attempt_id);
        if (previousRow && attempt) {
          const previous = parseStrictJson(previousRow.outcome_json);
          const observedState = { hostState: status.state, processTreeEnded: true, spoolComplete: status.spoolComplete === true };
          if (Number.isInteger(status.exitCode)) observedState.exitCode = status.exitCode;
          const outcome = this.failureOutcomeEvent(attempt, { source: previous.source, code: previous.canonicalCode, rawCode: previous.rawCode,
            causeKnowledge: previous.causeKnowledge, attemptState: previous.observedState.attemptState || attempt.state,
            executionCertainty: previous.executionCertainty === 'not_started' ? 'not_started' : 'completed',
            sideEffectCertainty: previous.sideEffectCertainty, observedState });
          if (outcome) this.store.appendEvents(hold.run_id, [outcome]);
        }
      }
    });
    // A workspace this release frees may let waiting work dispatch.
    queueMicrotask(() => {
      const parentLink = hold && this.store.get(`SELECT * FROM run_links WHERE continuation_contract = 'logical_policy'
        AND parent_run_id = ? AND state IN ('open','repair_accepted') ORDER BY created_at DESC LIMIT 1`, hold.run_id);
      if (parentLink?.state === 'open') this.settleParentRepairSuspension(parentLink.id);
      else if (parentLink?.state === 'repair_accepted') this.resumeLogicalRepairParent(parentLink);
      this.pump();
    });
    return true;
  };

  // Records the unresolved condition of a held invocation, durably and once: the hold keeps it until the Host answers for the invocation
  // again, and the Run's journal reports it to the operator once per condition and Engine. Nothing is released or settled here.
  P.custodyRecordUnresolved = function custodyRecordUnresolved(custodyId, condition) {
    const hold = this.store.get(`SELECT * FROM custody_workspace_holds WHERE custody_id = ? AND state = 'held'`, custodyId);
    if (!hold) return false;
    const standing = hold.unresolved_json ? JSON.parse(hold.unresolved_json) : null;
    // One condition per refusal: the same refusal seen by another command, or by a successor Engine, is the condition already recorded.
    if (standing && standing.refusal === condition.refusal) return false;
    const key = `${custodyId}:${condition.refusal}`;
    this.custodyReported ??= new Set();
    const report = !this.custodyReported.has(key);
    this.custodyReported.add(key);
    const attempt = this.store.get('SELECT id, node_instance_id, state FROM attempts WHERE id = ?', hold.attempt_id);
    const journalled = this.store.get('SELECT journal_version AS version FROM runs WHERE id = ?', hold.run_id)?.version >= 2;
    const message = `The Lifecycle Host refused ${condition.command ?? 'a custody command'} for this attempt (${condition.refusal}: ${condition.message}). Whether its CLI `
      + `launched or is still running is unknown; the Attempt state is ${attempt?.state ?? 'unknown'}, and its workspace stays held. The Engine asks the Host again and continues or settles `
      + 'the attempt when the Host answers for it; until then a Stop is held, and no other Run can use this workspace.';
    this.store.transaction(() => {
      this.store.run(`UPDATE custody_workspace_holds SET unresolved_json = ?, unresolved_at = ? WHERE custody_id = ? AND state = 'held'`,
        JSON.stringify(condition), condition.at, custodyId);
      const events = [];
      if (report && journalled && attempt) events.push({ type: 'attempt.error', nodeInstanceId: attempt.node_instance_id, attemptId: attempt.id,
        payload: { code: 'custody_unresolved', message, evidence: null } });
      if (attempt) {
        const unavailable = !condition.refusal || ['custody_unreachable', 'custody_unavailable'].includes(condition.refusal);
        const outcome = this.failureOutcomeEvent(attempt, { source: 'host', code: 'custody_unresolved', rawCode: condition.refusal,
          attemptState: attempt.state, causeKnowledge: 'direct_fact', executionCertainty: 'unresolved',
          observedState: { hostState: unavailable ? 'unavailable' : 'refused' } });
        if (outcome) events.push(outcome);
      }
      if (events.length) this.store.appendEvents(hold.run_id, events);
    });
    if (report) process.stderr.write(`Process Custody: ${custodyId} unresolved (${condition.refusal} on ${condition.command}); the workspace stays held.\n`);
    return true;
  };

  P.custodyClearUnresolved = function custodyClearUnresolved(custodyId, status = null) {
    const hold = this.store.get(`SELECT * FROM custody_workspace_holds WHERE custody_id = ? AND state = 'held' AND unresolved_json IS NOT NULL`, custodyId);
    if (!hold) return false;
    const condition = (() => { try { return JSON.parse(hold.unresolved_json); } catch { return null; } })();
    this.store.transaction(() => {
      this.store.run(`UPDATE custody_workspace_holds SET unresolved_json = NULL, unresolved_at = NULL WHERE custody_id = ? AND state = 'held' AND unresolved_json IS NOT NULL`, custodyId);
      if (!status) return;
      const attempt = this.store.get('SELECT * FROM attempts WHERE id = ?', hold.attempt_id);
      if (!attempt) return;
      const neverLaunched = status.processId == null && ['admitted', 'launch_failed', 'permit_expired', 'refused_host_restart', 'admission_cancelled'].includes(status.state);
      const certainEnd = status.processTreeEnded === true;
      const observedState = { hostState: status.state };
      if (typeof status.processTreeEnded === 'boolean') observedState.processTreeEnded = status.processTreeEnded;
      if (Number.isInteger(status.exitCode)) observedState.exitCode = status.exitCode;
      if (typeof status.spoolComplete === 'boolean') observedState.spoolComplete = status.spoolComplete;
      const outcome = this.failureOutcomeEvent(attempt, { source: 'host', code: 'custody_unresolved', rawCode: condition?.refusal,
        causeKnowledge: 'direct_fact', executionCertainty: neverLaunched ? 'not_started' : certainEnd ? 'completed' : 'unresolved',
        sideEffectCertainty: neverLaunched ? 'none_proven' : 'unknown', observedState });
      if (outcome) this.store.appendEvents(hold.run_id, [outcome]);
    });
    return true;
  };

  // The durable hold, if any, that overlaps this physical workspace. Overlap is decided on resolved roots: a nested directory or a
  // junction alias of a held workspace overlaps it, and a disjoint workspace never does. When the workspace cannot be resolved, no
  // disjointness can be shown, so any hold blocks it.
  P.custodyHoldOverlapping = function custodyHoldOverlapping(cwd) {
    const holds = this.store.all(`SELECT * FROM custody_workspace_holds WHERE state = 'held'`);
    if (!holds.length) return null;
    let root;
    try {
      root = resolveWorkspaceRoot(cwd);
    } catch {
      return holds[0];
    }
    return holds.find(hold => workspaceRootsOverlap(hold.workspace_root, root)) ?? null;
  };

  // Whether an active managed-task delivery writes into a repository that overlaps this workspace. A Host-owned CLI is not started there
  // until the delivery ends. Deliveries do not survive an Engine restart, so this Engine's own utilities are all there is to check. A root
  // that cannot be resolved cannot be shown disjoint.
  P.custodyDeliveryOverlapping = function custodyDeliveryOverlapping(cwd) {
    if (this.unconfirmedOverlapping(cwd)) return true;
    const deliveries = [...this.processes.values()].filter(record => record.deliveryCwd).map(record => record.deliveryCwd);
    if (!deliveries.length) return false;
    try {
      const root = resolveWorkspaceRoot(cwd);
      return deliveries.some(other => workspaceRootsOverlap(resolveWorkspaceRoot(other), root));
    } catch {
      return true;
    }
  };

  // Whether a process that the last restart could not confirm ended may still run in an overlapping workspace. Its owner is not known to
  // this Engine any more, so its workspace stays unavailable until that process ends. A process that has ended releases it. A workspace
  // that is unknown (null) or cannot be resolved blocks.
  // The processes that a restart could not confirm ended, with the ones still alive kept. Called on every use, and by the watch below.
  P.pruneUnconfirmed = function pruneUnconfirmed() {
    this.unconfirmedWorkspaces = (this.unconfirmedWorkspaces ?? []).filter(entry => isAlive(entry.pid));
    return this.unconfirmedWorkspaces.length;
  };

  // While any such process is listed, the scheduler runs each second, so that work waiting on it is dispatched as soon as it ends (nothing else
  // would run the scheduler then). The watch stops with the last process.
  P.watchUnconfirmed = function watchUnconfirmed() {
    if (this.unconfirmedWatch || !this.pruneUnconfirmed()) return;
    this.unconfirmedWatch = setInterval(() => {
      if (this.pruneUnconfirmed() === 0) {
        clearInterval(this.unconfirmedWatch);
        this.unconfirmedWatch = null;
      }
      this.pump();
    }, 1000);
    this.unconfirmedWatch.unref?.();
  };

  P.unconfirmedOverlapping = function unconfirmedOverlapping(cwd) {
    this.pruneUnconfirmed();
    if (!this.unconfirmedWorkspaces.length) return false;
    try {
      const root = resolveWorkspaceRoot(cwd);
      return this.unconfirmedWorkspaces.some(entry => entry.cwd === null || workspaceRootsOverlap(resolveWorkspaceRoot(entry.cwd), root));
    } catch {
      return true;
    }
  };

  // Whether a Custody-scoped attempt of this Engine has been dispatched in an overlapping workspace. Its durable hold is written only once the
  // Host has admitted it; until then, this is what keeps a managed-task delivery out. After a restart such an attempt is either held (its hold
  // was written) or was never admitted (it is canceled and launches nothing).
  P.custodyLaunchOverlapping = function custodyLaunchOverlapping(cwd) {
    const launches = [...this.processes.values()].filter(record => record.custodyCwd).map(record => record.custodyCwd);
    if (!launches.length) return false;
    try {
      const root = resolveWorkspaceRoot(cwd);
      return launches.some(other => workspaceRootsOverlap(resolveWorkspaceRoot(other), root));
    } catch {
      return true;
    }
  };

  // Re-checks every durable hold against the Host, and releases each one the Host proves ended. A hold whose attempt is still driven by a
  // child of this Engine is left to that child, unless the child is unresolved: the Host's answer then goes to the child, which continues.
  // An admission this Engine no longer drives is withdrawn, so it can never launch. A definitive refusal is recorded as the hold's
  // unresolved condition (once) and the hold stays held; an answer clears the condition.
  P.custodyReconcileHolds = async function custodyReconcileHolds() {
    if (!this.custodyHost) return;
    const holds = this.store.all(`SELECT * FROM custody_workspace_holds WHERE state = 'held'`);
    if (!holds.length) return;
    if (this.custodyUnavailable) await this.custodyAttach();
    if (this.custodyUnavailable) return;
    for (const hold of holds) {
      const child = this.custodyChildren?.get(hold.attempt_id);
      if (child && !child.unresolved) continue;
      let status;
      try {
        status = await this.custodyCall('custody.status', { custodyId: hold.custody_id });
        if (!child && status.state === 'admitted') status = await this.custodyCall('custody.cancel', { custodyId: hold.custody_id });
      } catch (error) {
        // A fenced Engine stops acting on the invocation, as its child would on the same refusal.
        if (fenced(error)) child?.detach();
        else if (!child && !transient(error)) this.custodyRecordUnresolved(hold.custody_id, unresolvedCondition(this, error));
        continue;
      }
      if (child) { child.resolveUnresolved(status); continue; }
      if (hold.unresolved_json) this.custodyClearUnresolved(hold.custody_id, status);
      this.custodyReleaseIfEnded(hold.custody_id, status);
    }
  };

  P.startCustodyHoldReconciler = function startCustodyHoldReconciler() {
    if (this.custodyHoldTimer) return;
    this.custodyHoldTimer = setInterval(() => { this.custodyReconcileHolds().catch(() => {}); }, HOLD_RECONCILE_MS);
    this.custodyHoldTimer.unref?.();
  };

  P.stopCustodyHoldReconciler = function stopCustodyHoldReconciler() {
    if (this.custodyHoldTimer) clearInterval(this.custodyHoldTimer);
    this.custodyHoldTimer = null;
  };

  // Committed chunks of one stream of one attempt, in order. Each carries its absolute byte offset.
  P.custodyChunks = function custodyChunks(attemptId, stream) {
    return this.store.all("SELECT envelope_json FROM journal_events WHERE attempt_id = ? AND event_type = 'attempt.log_chunk' ORDER BY sequence", attemptId)
      .map(row => JSON.parse(row.envelope_json).payload)
      .filter(payload => payload.stream === stream)
      .sort((a, b) => a.chunkIndex - b.chunkIndex);
  };

  P.custodyCommittedBytes = function custodyCommittedBytes(attemptId, stream) {
    return this.custodyChunks(attemptId, stream).reduce((sum, payload) => sum + payload.byteLength, 0);
  };

  // The recorder seed: the chunks an earlier Engine committed, so the resumed manifest continues without a gap or repeat.
  P.custodyResumeSeed = function custodyResumeSeed(attemptId, stream) {
    const chunks = this.custodyChunks(attemptId, stream).map(payload => ({ index: payload.chunkIndex, byteOffset: payload.byteOffset,
      byteLength: payload.byteLength, artifact: payload.chunk }));
    return { chunks, committedBytes: chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0) };
  };

  // The committed bytes of each stream, read back from the Engine's own artifacts, for a deterministic parser replay.
  P.custodyReplay = function custodyReplay(attemptId) {
    const bytes = stream => Buffer.concat(this.custodyChunks(attemptId, stream).map(payload => this.store.readBytes(payload.chunk.artifactId).bytes));
    return { stdout: bytes('stdout'), stderr: bytes('stderr'), normalized: bytes('normalized') };
  };

  // Whether an attempt may run under Process Custody. Only plain top-level agent attempts qualify; anything else keeps the
  // existing launch path, so Custody never owns a process whose recovery it cannot reconstruct.
  // `mapped` attempts are Map-step steps, which have their own dispatch and settlement and are never Host-owned in this PoC.
  P.custodyScopeAllows = function custodyScopeAllows(node, record) {
    // An explicit Custody requirement stays fail-closed even if its Host bootstrap is missing.
    return Boolean(this.custodyHost || this.processCustodyRequired) && !this.hostAuthority && !record.mapped && !record.taskExecutionId
      && record.loops.length === 0 && !node.config.contextId;
  };

  P.custodyEligible = function custodyEligible(node, record) {
    return this.custodyScopeAllows(node, record) && !this.custodyUnavailable;
  };

  P.launchCustody = function launchCustody(runId, attempt, invocation, { provider, deadlineMs }) {
    const child = new CustodyChild(this, { runId, attemptId: attempt.id, provider, invocation, deadlineMs, resume: false });
    child.begin();
    return child;
  };

  P.attachCustody = function attachCustody(runId, attempt, { provider, deadlineMs }) {
    const child = new CustodyChild(this, { runId, attemptId: attempt.id, provider, invocation: null, deadlineMs, resume: true });
    child.begin();
    return child;
  };

  // The one way a running CLI is stopped. A Host-owned process is stopped through the Host; any other goes to its process tree.
  P.terminateLaunched = function terminateLaunched(child) {
    if (child?.custody) return child.stop();
    return child?.pid ? killTree(child.pid) : undefined;
  };

  // Custody attempts that an Engine restart must continue. recover() leaves them running and records them here.
  P.resumeCustodyAttempts = function resumeCustodyAttempts() {
    // A run that cannot resume (its custody CLI shares it with attempts that were interrupted) has its Host-owned CLI stopped:
    // nothing will read its output, so it must not keep running unobserved. Its workspace hold stays until the Host proves the end.
    for (const custodyId of this.custodyAbandon) this.custodyCall('custody.stop', { custodyId }).catch(() => {});
    this.custodyAbandon = [];
    for (const { run_id: runId, attempt_id: attemptId } of this.custodyResumes) {
      const runRow = this.store.get('SELECT * FROM runs WHERE id = ?', runId);
      if (!runRow) continue;
      const state = this.runs.get(runId) ?? this.loadRunState(runRow);
      this.runs.set(runId, state);
      const attempt = this.store.get('SELECT * FROM attempts WHERE id = ?', attemptId);
      const node = state.workflow.nodes.find(item => item.id === attempt.node_instance_id);
      if (!node) {
        // A Host-owned CLI whose node cannot be resolved is stopped and its attempt interrupted; nothing is left unobserved.
        const binding = this.custodyBindingOf(attemptId);
        if (binding) this.custodyCall('custody.stop', { custodyId: binding.custody_id }).catch(() => {});
        this.store.transaction(() => this.store.appendEvents(runId, this.attemptTransition(attempt, 'interrupted',
          'The Engine cannot resume this process: its node is not a top-level agent in this Run.')));
        continue;
      }
      const workspace = this.workspaceOf(state);
      const keys = [`cwd:${workspace.cwd_identity}`];
      // A run that was stopping when its Engine ended still wants its CLI stopped: the Stop is issued again once the child attaches.
      const record = { runId, loops: [], provider: node.config.provider, keys, child: null, stopRequested: runRow.state === 'stopping', timedOut: false, launched: false,
        custodyResume: true };
      record.exited = new Promise(done => { record.resolveExit = done; });
      for (const key of keys) { this.locks.add(key); this.store.run('INSERT INTO resource_locks(resource_key, run_id, attempt_id, acquired_at) VALUES (?, ?, ?, ?)', key, runId, attemptId, nowIso()); }
      this.processes.set(attemptId, record);
      this.resumeCustodyAgent(state, node, attempt, workspace, record).catch(error => {
        try { this.failAttempt(state, this.store.get('SELECT * FROM attempts WHERE id = ?', attemptId), 'process', error.message); }
        catch (journalError) { this.storageUnavailable(journalError); }
      }).finally(() => this.releaseAgent(state, attempt, record));
    }
    this.custodyResumes = [];
  };

  // The resumed settlement: the same parser, outputs and transitions an uninterrupted attempt would reach.
  P.resumeCustodyAgent = async function resumeCustodyAgent(state, node, attempt, workspace, record) {
    const config = node.config;
    const requestedEffort = resolveEffort(config.effort);
    const transport = config.output.format === 'json' && config.output.schema ? transportSchema(config.output.schema) : null;
    const outcome = await this.runProcess(state, attempt, node, null, record);
    return this.settleAgentProcess(state, node, attempt, { config, requestedEffort, workspace, binding: null, transport, spec: null, record }, outcome);
  };
}
