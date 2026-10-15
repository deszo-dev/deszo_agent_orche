// Read-only Replay projection: folds journal events 1..k into the state visible at step k.
// It never issues commands, provider calls, file restoration or native-session changes.

export function replaySteps(events, { includeLogs = false } = {}) {
  const steps = [];
  events.forEach((event, index) => { if (includeLogs || event.type !== 'attempt.log_chunk') steps.push(index); });
  return steps;
}

export function project(events, upToIndex) {
  const view = { run: null, instances: new Map(), loops: new Map(), bindings: new Map(), maps: new Map(), current: null };
  // Loop and Map lifecycles end through their own attempt (stop, close, restart recovery).
  const owners = new Map();
  const last = Math.min(upToIndex, events.length - 1);
  for (let index = 0; index <= last; index++) {
    const event = events[index];
    view.current = event;
    const p = event.payload;
    const instance = id => {
      if (!view.instances.has(id)) view.instances.set(id, { id, state: 'scheduled', attemptId: null, ordinal: 0, inputs: null, outputs: null, invocation: null, error: null, logs: [] });
      return view.instances.get(id);
    };
    switch (event.type) {
      case 'run.state_changed': view.run = p.to; break;
      case 'node.planned': instance(event.nodeInstanceId).nodeId = p.nodeId; instance(event.nodeInstanceId).nodeType = p.nodeType; break;
      case 'attempt.state_changed': {
        const item = instance(event.nodeInstanceId);
        if (p.from === null) Object.assign(item, { attemptId: event.attemptId, ordinal: p.ordinal ?? item.ordinal + 1, inputs: null, outputs: null, invocation: null, error: null, logs: [] });
        item.state = p.to; item.reason = p.reason;
        const owner = owners.get(event.attemptId);
        if (owner && ['canceled', 'interrupted', 'failed'].includes(p.to)) {
          if (owner.kind === 'loop') {
            const loop = view.loops.get(owner.id);
            Object.assign(loop, { state: p.to, pauseReason: null, message: p.reason });
            // An iteration that returned no decision stays undecided; record how it ended.
            for (const iteration of loop.iterations) if (iteration.continue === null) iteration.outcome = p.to;
          } else {
            const map = view.maps.get(owner.id);
            if (map && !['implementation_complete', 'specification_revision_required'].includes(map.state)) Object.assign(map, { state: p.to, pauseReason: null });
          }
        }
        break;
      }
      case 'attempt.inputs_committed': instance(event.nodeInstanceId).inputs = p.manifest; instance(event.nodeInstanceId).prompt = p.prompt; break;
      case 'attempt.invocation_committed': instance(event.nodeInstanceId).invocation = p.manifest; break;
      case 'attempt.outputs_committed': instance(event.nodeInstanceId).outputs = p.manifest; break;
      case 'attempt.reused': Object.assign(instance(event.nodeInstanceId), { outputs: p.outputs, reusedFrom: p.sourceRunId }); break;
      case 'route.selected': instance(event.nodeInstanceId).routeCase = p.caseId; break;
      case 'gate.evaluated': instance(event.nodeInstanceId).gate = { mode: p.mode, status: p.status, subjectId: p.subjectId, recordId: p.recordId }; break;
      case 'gate.review_carried': (instance(event.nodeInstanceId).carried ||= []).push({ slot: p.slot, priorSubjectId: p.priorSubjectId, recordId: p.record.recordId }); break;
      // Generated Map scopes: each execution's tasks, counter and records as of this step.
      case 'map.expanded': view.maps.set(p.mapExecutionId, { mapExecutionId: p.mapExecutionId, mapInstanceId: event.nodeInstanceId, generation: p.generation, specificationId: p.specificationId,
        state: 'running', pauseReason: null, failedVerificationCycles: 0, maxFailedVerificationCycles: null, carried: p.carried, tasks: new Map(), records: [] }); owners.set(event.attemptId, { kind: 'map', id: p.mapExecutionId }); break;
      case 'map.task_state_changed': { const map = view.maps.get(p.mapExecutionId); if (map) map.tasks.set(p.taskId, { state: p.to, reason: p.reason }); break; }
      case 'map.record_created': { const map = view.maps.get(p.mapExecutionId); if (map) map.records.push({ taskId: p.taskId, kind: p.kind, recordId: p.record.recordId }); break; }
      case 'map.verification_cycle': { const map = view.maps.get(p.mapExecutionId); if (map) Object.assign(map, { failedVerificationCycles: p.failedVerificationCycles, maxFailedVerificationCycles: p.maxFailedVerificationCycles }); break; }
      case 'map.paused': { const map = view.maps.get(p.mapExecutionId); if (map) Object.assign(map, { state: 'paused', pauseReason: p.reason }); break; }
      case 'map.resumed': { const map = view.maps.get(p.mapExecutionId); if (map) Object.assign(map, { state: 'running', pauseReason: null }); break; }
      case 'map.limits_changed': { const map = view.maps.get(p.mapExecutionId); if (map) map.maxFailedVerificationCycles = p.maxFailedVerificationCycles; break; }
      case 'map.finished': { const map = view.maps.get(p.mapExecutionId); if (map) map.state = p.outcome; break; }
      case 'attempt.error': instance(event.nodeInstanceId).error = { code: p.code, message: p.message }; break;
      case 'attempt.log_chunk': instance(event.nodeInstanceId).logs.push({ stream: p.stream, chunk: p.chunk, index: p.chunkIndex }); break;
      case 'context.state_changed': view.bindings.set(p.bindingId, p.to); break;
      case 'loop.started': view.loops.set(p.loopNodeId, { state: 'running', iteration: 0, pauseReason: null, maxIterations: p.maxIterations, maxActiveMinutes: p.maxActiveMinutes, iterations: [] }); owners.set(event.attemptId, { kind: 'loop', id: p.loopNodeId }); break;
      case 'loop.iteration_started': {
        const loop = view.loops.get(p.loopNodeId);
        loop.iteration = p.iteration;
        const record = { iteration: p.iteration, value: p.value, feedback: p.feedback, candidate: null, decision: null, continue: null, reason: null, restart: Boolean(p.restart), outcome: null };
        loop.iterations = loop.iterations.filter(item => item.iteration !== p.iteration).concat(record);
        break;
      }
      case 'loop.iteration_returned': {
        const record = view.loops.get(p.loopNodeId).iterations.find(item => item.iteration === p.iteration);
        Object.assign(record, { candidate: p.candidate, decision: p.decision, continue: p.continue, reason: p.reason });
        break;
      }
      case 'loop.paused': Object.assign(view.loops.get(p.loopNodeId), { state: 'paused', pauseReason: p.reason, message: p.message }); break;
      case 'loop.resumed': Object.assign(view.loops.get(p.loopNodeId), { state: 'running', pauseReason: null, message: null }); break;
      case 'loop.limits_changed': Object.assign(view.loops.get(p.loopNodeId), { maxIterations: p.maxIterations, maxActiveMinutes: p.maxActiveMinutes }); break;
      case 'loop.finished': Object.assign(view.loops.get(p.loopNodeId), { state: 'finished', result: p.result }); break;
      default: break;
    }
  }
  return view;
}

const LABELS = {
  'run.created': () => 'Run captured',
  'run.state_changed': p => `Run ${p.from ?? '∅'} → ${p.to}`,
  'node.planned': p => `Planned ${p.nodeId}`,
  'attempt.state_changed': (p, e) => `${e.nodeInstanceId}: ${p.from ?? '∅'} → ${p.to}`,
  'attempt.inputs_committed': (_, e) => `${e.nodeInstanceId}: inputs resolved`,
  'attempt.invocation_committed': (_, e) => `${e.nodeInstanceId}: CLI invocation captured`,
  'attempt.outputs_committed': (_, e) => `${e.nodeInstanceId}: outputs committed`,
  'attempt.error': (p, e) => `${e.nodeInstanceId}: ${p.code}`,
  'attempt.log_chunk': (p, e) => `${e.nodeInstanceId}: ${p.stream} batch ${p.chunkIndex}`,
  'context.state_changed': p => `Context ${p.from} → ${p.to}`,
  'context.bound': p => `${p.provider} native session captured`,
  'context.remapped': p => `${p.contextNodeId} remapped to a fresh binding`,
  'run.capacity_changed': p => `Capacity revision ${p.revision}`,
  'run.recovery_requested': p => `Recovery: ${p.action}${p.target ? ` (${p.target})` : ''}`,
  'loop.started': p => `${p.loopNodeId} started`,
  'loop.iteration_started': p => `${p.loopNodeId} iteration ${p.iteration}${p.restart ? ' (restart)' : ''}`,
  'loop.iteration_returned': p => `${p.loopNodeId} iteration ${p.iteration}: ${p.continue ? 'continue' : 'finish'}`,
  'loop.paused': p => `${p.loopNodeId} paused: ${p.reason}`,
  'loop.resumed': p => `${p.loopNodeId} resumed`,
  'loop.limits_changed': p => `${p.loopNodeId} limits ${p.maxIterations} / ${p.maxActiveMinutes} min`,
  'loop.finished': p => `${p.loopNodeId} finished after ${p.iterations}`,
  'run.planned': p => `Planned: ${p.mode}${p.mode === 'workflow' ? '' : ` → ${p.targets.join(', ')}`}`,
  'attempt.reused': (p, e) => `${e.nodeInstanceId}: reused from run ${p.sourceRunId.slice(0, 8)}`,
  'cache.reused': (p, e) => `${e.nodeInstanceId}: pinned value used`,
  'cache.pinned': (p, e) => `${e.nodeInstanceId}: pin refreshed`,
  'route.selected': (p, e) => `${e.nodeInstanceId}: ${p.caseId === null ? 'no case matched' : `case ${p.caseId}`}`,
  'gate.review_carried': (p, e) => `${e.nodeInstanceId}: ${p.slot} approval carried from ${p.priorSubjectId}`,
  'map.expanded': p => `Map generation ${p.generation}: ${p.tasks} tasks${p.carried.length ? `, ${p.carried.length} carried` : ''}`,
  'map.task_state_changed': p => `${p.taskId}: ${p.from ?? '∅'} → ${p.to}`,
  'map.record_created': p => `${p.taskId}: ${p.kind} ${p.record.recordId}`,
  'map.verification_cycle': p => `${p.taskId} verification cycle ${p.cycle}: ${p.outcome}`,
  'map.paused': p => `Map paused: ${p.reason}`,
  'map.resumed': () => 'Map resumed',
  'map.limits_changed': p => `Map limits ${p.maxFailedVerificationCycles} / ${p.maxTaskAttempts}`,
  'map.finished': p => `Map finished: ${p.outcome}`,
  'gate.evaluated': (p, e) => `${e.nodeInstanceId}: ${p.mode}${p.status ? ` ${p.status}` : ''} ${p.subjectId}`,
};
export const describeEvent = event => (LABELS[event.type] || (() => event.type))(event.payload, event);
