import { randomUUID } from 'node:crypto';
import { StreamRecorder } from './streams.mjs';
import { killTree } from './processes.mjs';
import { shimFailureOf } from './supervisor-client.mjs';
import { nowIso } from './store.mjs';
import { assertValid } from './schemas.mjs';
import { ref } from './utilities.mjs';
import { enclosingLoops, parseInstance } from './planning.mjs';

const BUFFER_LIMIT = 16 * 1024 * 1024;

// Utility children use the same run Job, process registry, journal, Stop and stream recorder as Agents.
// No supervisor credential or inherited Node preload is passed to a utility child.
export function installTaskProcesses(Engine) {
  Engine.prototype.runTaskCommand = async function runTaskCommand(state, execution, parent, command, args, options = {}) {
    const { cwd, signal, encoding = 'utf8', timeoutMs = 30000, category = 'git', attemptCost = 0, expectedExitCode = 0 } = options;
    if (this.closing || this.runState(state.id) !== 'running' || signal?.aborted) return { status: null, aborted: true, stdout: '', stderr: '' };
    const seq = ++execution.data.commandSeq;
    this.saveManagedTask(execution);
    const instance = `${parent.node_instance_id}/1/command-${seq}`;
    let attempt;
    this.store.transaction(() => {
      const events = [];
      const id = this.planAttempt(state, instance, `command-${seq}`, 'task-command', null, events);
      attempt = this.store.get('SELECT * FROM attempts WHERE id = ?', id);
      events.push(this.commitInputs(state, attempt, {}));
      this.store.appendEvents(state.id, events);
    });
    this.taskState(state).commands.add(instance);
    const record = { runId: state.id, taskExecutionId: execution.row.id, parentAttemptId: parent.id, loops: enclosingLoops(parseInstance(execution.row.node_instance_id).prefix).map(item => item.loopInstance), keys: [], child: null, launched: false, stopRequested: false, timedOut: false, outputBytes: 0 };
    this.processes.set(attempt.id, record);
    try {
      record.workId = this.reserveTaskWork(execution, attempt, category, attemptCost);
      const remaining = this.taskRemainingMs(execution);
      const effectiveTimeout = Math.max(1, Math.min(timeoutMs, remaining));
      const environment = Object.fromEntries(Object.entries(options.env || process.env).filter(([key]) => !/^NODE_(OPTIONS|TEST|V8_COVERAGE)/i.test(key)));
      const manifest = { schemaVersion: 1, kind: 'CommandManifest', executable: command, arguments: args, source: `managed-task:${category}`,
        cwd, taskExecutionId: execution.row.id, parentAttemptId: parent.id, timeoutMs: Math.max(1, Math.floor(effectiveTimeout)),
        timeoutSeconds: Math.max(1, Math.ceil(effectiveTimeout / 1000)), requiredExitCode: expectedExitCode, environmentPolicy: 'run-owned; supervisor secrets and Node preload removed' };
      assertValid('execution-evidence.schema.json', 'commandManifest', manifest);
      const commandRef = ref(this.store.putJson(manifest));
      this.store.run('UPDATE attempts SET invocation_artifact_id = ? WHERE id = ?', commandRef.artifactId, attempt.id);
      // Keep the command in the ordinary invocation event for audit/provenance consumers.
      this.store.appendEvents(state.id, [{ type: 'attempt.invocation_committed', nodeInstanceId: instance, attemptId: attempt.id, payload: { manifest: commandRef } }]);
      const result = await new Promise(resolve => {
        let settled = false, timer;
        const chunks = { stdout: [], stderr: [] }, sizes = { stdout: 0, stderr: 0 };
        let truncated = false;
        const onFault = error => this.captureFault(record, error);
        const streams = Object.fromEntries(['stdout', 'stderr'].map(stream => [stream, new StreamRecorder({ store: this.store, runId: state.id, attempt, stream,
          mediaType: 'application/octet-stream', onFault, extended: true })]));
        const onAbort = () => { record.stopRequested = true; if (record.child?.pid) void killTree(record.child.pid); };
        let startedAt = null;
        const finish = ({ status = null, childSignal = null, error = null, complete = false }) => {
          if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
          const aborted = record.stopRequested || signal?.aborted || this.runState(state.id) === 'stopping';
          const outcome = record.captureError ? 'capture_failed' : aborted ? 'canceled' : record.timedOut ? 'timed_out' : error ? 'spawn_failed' : status === expectedExitCode ? 'passed' : 'failed';
          const reason = record.captureError?.message || (aborted ? 'Stopped by the run controller.' : record.timedOut ? 'The command exceeded its local or aggregate deadline.' : error?.message || `Command exited with code ${status}.`);
          let closed, evidenceRef;
          try {
            closed = Object.fromEntries(Object.entries(streams).map(([name, stream]) => [name, stream.close(reason, { complete })]));
            const captureVerdict = Object.values(closed).every(item => item.integrity === 'complete') ? 'complete' : record.captureError ? 'capture_failed' : 'partial';
            const evidence = { schemaVersion: 1, kind: 'ExecutionEvidence', attemptId: attempt.id, nodeInstanceId: instance, checkId: options.checkId || null,
              outcome, exitCode: status, signal: childSignal, startedAt, endedAt: nowIso(), command: commandRef,
              streams: { stdout: closed.stdout.manifestRef, stderr: closed.stderr.manifestRef }, captureVerdict, reason: reason.slice(0, 1000) };
            assertValid('execution-evidence.schema.json', 'executionEvidence', evidence);
            evidenceRef = ref(this.store.putJson(evidence));
            this.store.run('INSERT INTO execution_evidence(id,run_id,attempt_id,outcome,evidence_artifact_id,created_at) VALUES(?,?,?,?,?,?)', randomUUID(), state.id, attempt.id, outcome, evidenceRef.artifactId, nowIso());
            this.store.appendEvents(state.id, [{ type: 'attempt.execution_evidence', nodeInstanceId: instance, attemptId: attempt.id,
              payload: { evidence: evidenceRef, outcome, ...(options.checkId ? { checkId: options.checkId } : {}) } }]);
            const current = this.store.get('SELECT * FROM attempts WHERE id = ?', attempt.id);
            this.store.appendEvents(state.id, this.attemptTransition(current, aborted ? 'canceled' : outcome === 'passed' ? 'succeeded' : 'failed', reason));
          } catch (captureError) { this.storageUnavailable(captureError); error = captureError; }
          const bytes = name => encoding === 'buffer' ? Buffer.concat(chunks[name]) : Buffer.concat(chunks[name]).toString('utf8');
          resolve({ status, signal: childSignal, error: error || record.captureError || null, timedOut: record.timedOut, aborted, truncated,
            stdout: bytes('stdout'), stderr: bytes('stderr'), evidence: evidenceRef, captureComplete: closed ? Object.values(closed).every(item => item.integrity === 'complete') : false });
        };
        try {
          record.child = this.launchContained(state.id, { command, args, cwd, env: environment, stdin: '' });
          record.exited = new Promise(done => { record.resolveExit = done; });
        } catch (error) { finish({ error }); return; }
        const child = record.child;
        child.once('error', error => finish({ error }));
        child.once('spawn', () => {
          try {
            startedAt = nowIso(); record.launched = true;
            this.markTaskWorkLaunched(record.workId);
            if (record.loops.length) { record.counted = true; for (const loop of record.loops) this.bodyStarted(state, loop); }
            const startIdentity = `${child.pid}@${startedAt}`;
            this.store.run('UPDATE attempts SET process_id=?,process_start_identity=?,supervisor_generation=?,started_at=? WHERE id=?', child.pid, startIdentity, this.supervisorGeneration, startedAt, attempt.id);
            this.store.appendEvents(state.id, this.attemptTransition(attempt, 'running', 'Run-owned utility process launched.', { pid: child.pid, startIdentity, supervisorGeneration: this.supervisorGeneration }));
            timer = setTimeout(() => { record.timedOut = true; void killTree(child.pid); }, effectiveTimeout);
            if (signal?.aborted || record.stopRequested || this.runState(state.id) !== 'running') onAbort();
          } catch (error) { onFault(error); }
        });
        for (const name of ['stdout', 'stderr']) child[name].on('data', chunk => {
          record.outputBytes += chunk.length;
          try { streams[name].add(chunk); } catch (error) { onFault(error); }
          const room = BUFFER_LIMIT - sizes[name];
          if (chunk.length > room) truncated = true;
          if (room > 0) { const kept = chunk.subarray(0, room); sizes[name] += kept.length; chunks[name].push(kept); }
        });
        signal?.addEventListener('abort', onAbort, { once: true });
        child.once('close', (status, childSignal) => {
          const failure = this.supervisor ? shimFailureOf(status) : null;
          finish(failure ? { error: new Error(`The contained launcher failed (${failure}).`) } : { status, childSignal, complete: true });
        });
      });
      this.finishTaskWork(record.workId, result.evidence, record.outputBytes);
      return result;
    } catch (error) {
      const current = this.store.get('SELECT * FROM attempts WHERE id=?', attempt.id);
      if (['scheduled', 'waiting', 'running'].includes(current.state)) this.store.appendEvents(state.id, this.attemptTransition(current, 'failed', error.message));
      this.finishTaskWork(record.workId, null, record.outputBytes);
      throw error;
    } finally {
      if (record.counted) for (const loop of record.loops) this.bodyEnded(state, loop);
      this.processes.delete(attempt.id); record.resolveExit?.();
      this.pump();
    }
  };
}
