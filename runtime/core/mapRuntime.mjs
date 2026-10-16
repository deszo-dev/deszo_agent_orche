import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalHash, parseStrictJson, sha256 } from './canonical.mjs';
import { assertValid, check } from './schemas.mjs';
import { CorruptionError, nowIso } from './store.mjs';
import { UtilityError, jsonValue, ref, setValue, textValue } from './utilities.mjs';
import { enclosingLoops, parseInstance } from './planning.mjs';
import { nodePorts } from './validate.mjs';
import { killTree, launch } from './processes.mjs';
import { StreamRecorder } from './streams.mjs';
import { shimFailureOf } from './supervisor-client.mjs';
import * as gate from './gate.mjs';
import { assemble, carryDecision, consumersOf, taskFingerprints, executePrompt, issueId, mapIssues, outputSchema, recordId, reviewPrompt, scopeMatches, templateFingerprint, topologicalTasks, triagePrompt } from './map.mjs';

// Implementation Map runtime. Every engine-expanded step is a journaled node instance
// "<map instance>/<execution>/<task>-<step>" with ordinary attempts, locks and recovery.
const OPEN_EXEC = ['running', 'paused', 'finishing'];
const OUTPUT_TAIL = 4000;
// Check streams become a single CheckReport artifact, so they are bounded more tightly than Agent logs.
const CHECK_STREAM_LIMIT_BYTES = 64 * 1024 * 1024;
// The weakest stream integrity decides the verdict; an unknown or failed capture is never reported as complete.
const captureVerdictOf = closed => {
  if (!closed) return 'capture_failed';
  const verdicts = [closed.stdout.integrity, closed.stderr.integrity];
  if (verdicts.includes('capture_failed')) return 'capture_failed';
  return verdicts.every(value => value === 'complete') ? 'complete' : 'partial';
};
const fail = message => { throw new UtilityError('output_contract', message); };
const slug = (taskId, step) => {
  const text = `${taskId.toLowerCase()}-${step}`;
  return text.length <= 64 ? text : `${text.slice(0, 55)}-${sha256(Buffer.from(text)).slice(0, 8)}`;
};
const pathIdentity = path => sha256(Buffer.from(process.platform === 'win32' ? path.toLowerCase() : path, 'utf8'));
// Checks get a selected environment: no inherited Node test-runner or option hooks.
const checkEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^NODE_(TEST|OPTIONS|V8_COVERAGE)/i.test(key)));
const tail = text => text.length > OUTPUT_TAIL ? `…${text.slice(-OUTPUT_TAIL)}` : text;

function snapshot(root) {
  const files = {};
  const walk = (dir, prefix) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else if (entry.isFile()) files[rel] = sha256(readFileSync(join(dir, entry.name)));
    }
  };
  walk(root, '');
  return files;
}

export function installMapRuntime(Engine, { ApiError, UNSTARTED }) {
  const P = Engine.prototype;

  // ---------- Records and state ----------
  P.mapRecord = function mapRecord(state, kind, definition, record) {
    assertValid('map.schema.json', definition, record, kind);
    return this.putRecord(state, kind, record);
  };
  P.readRecord = function readRecord(id, kind) {
    const row = this.store.get('SELECT * FROM pipeline_records WHERE id = ?', id);
    if (!row || (kind && row.kind !== kind)) fail(`Record ${id} is not a stored ${kind || 'engine'} record.`);
    return { ref: { recordId: id, artifact: { artifactId: row.artifact_id, sha256: this.store.artifactRow(row.artifact_id).sha256 } }, value: this.store.readJson(row.artifact_id) };
  };
  P.verifiedRecord = function verifiedRecord(claim, kind) {
    if (check('map.schema.json', 'recordRef', claim).length) fail(`Expected a ${kind} record reference.`);
    const row = this.store.get('SELECT * FROM pipeline_records WHERE id = ?', claim.recordId);
    if (!row || row.kind !== kind || row.artifact_id !== claim.artifact.artifactId) fail(`${claim.recordId} is not a ${kind} record issued by this engine.`);
    this.store.verifyRef(claim.artifact);
    return this.store.readJson(row.artifact_id);
  };

  P.mapState = function mapState(state) {
    if (!state.maps) state.maps = { byInstance: new Map(), steps: new Map(), cache: new Map() };
    return state.maps;
  };
  P.loadExec = function loadExec(state, execId) {
    const maps = this.mapState(state);
    const row = this.store.get('SELECT * FROM map_executions WHERE id = ?', execId);
    if (!maps.cache.has(execId)) {
      const plan = this.store.readJson(row.plan_artifact_id);
      const bundle = gate.readBundle(this.store, plan.documentation);
      maps.cache.set(execId, { plan, bundle, defs: new Map(plan.map.tasks.map(task => [task.id, task])), roles: new Map(plan.roles.map(role => [role.id, role])) });
    }
    const tasks = new Map(this.store.all('SELECT * FROM map_tasks WHERE execution_id = ?', execId).map(item => [item.task_id, { row: item, data: parseStrictJson(item.data_json) }]));
    return { row, tasks, ...maps.cache.get(execId) };
  };
  P.saveTask = function saveTask(exec, task) {
    this.store.run('UPDATE map_tasks SET state = ?, selected_result_id = ?, attempts = ?, data_json = ? WHERE execution_id = ? AND task_id = ?',
      task.row.state, task.row.selected_result_id, task.row.attempts, JSON.stringify(task.data), exec.row.id, task.row.task_id);
  };
  P.isMapStep = function isMapStep(state, instanceId) {
    return this.mapState(state).steps.has(instanceId);
  };
  P.mapEvent = function mapEvent(exec, type, payload) {
    const attempt = this.store.get('SELECT * FROM attempts WHERE id = ?', exec.row.attempt_id);
    return { type, nodeInstanceId: attempt.node_instance_id, attemptId: attempt.id, payload: { mapExecutionId: exec.row.id, ...payload } };
  };
  P.setTask = function setTask(exec, task, to, reason, events) {
    const from = task.row.state;
    if (from === to) return;
    task.row.state = to;
    const results = task.data.results ||= [];
    const mark = (id, status) => { const item = results.find(entry => entry.recordId === id); if (item) item.status = status; };
    if (to === 'accepted') mark(task.data.currentResultId, 'accepted');
    if (to === 'needs_changes') mark(task.data.currentResultId, from === 'awaiting_review' ? 'rejected' : 'withdrawn');
    if (to === 'stale') mark(task.data.currentResultId, 'withdrawn');
    // Withdrawn work keeps no selection; acceptance sets it explicitly.
    if (['needs_changes', 'stale', 'waiting', 'running', 'awaiting_review'].includes(to)) task.row.selected_result_id = null;
    events.push(this.mapEvent(exec, 'map.task_state_changed', { taskId: task.row.task_id, from, to, reason }));
  };

  // ---------- Expansion ----------
  P.startMap = function startMap(state, scope, node, attempt) {
    let values, prepared;
    try {
      values = {};
      for (const port of Object.keys(nodePorts(node).inputs)) values[port] = this.inputValue(state, scope, node.id, port);
      prepared = this.prepareMap(state, node, values);
    } catch (error) {
      return this.failAttempt(state, attempt, error instanceof CorruptionError ? 'corruption' : 'output_contract', error.message);
    }
    const { map, bundle, subjectId, fingerprint, prior, repair, sameSubject, crossRevision, fingerprints } = prepared;
    const execId = randomUUID();
    const seq = this.store.get('SELECT COUNT(*) AS n FROM map_executions WHERE run_id = ? AND map_instance_id = ?', state.id, attempt.node_instance_id).n + 1;
    const generation = prior ? (sameSubject ? prior.generation : prior.generation + 1) : 1;
    const repairTargets = repair ? repair.taskIds : [];
    const withdrawn = new Set([...repairTargets, ...consumersOf(map, repairTargets)]);
    const carriedMap = sameSubject || crossRevision ? carryDecision({ map, prior, fingerprints, withdrawn, crossRevision }) : new Map();
    const carried = [...carriedMap.values()];
    const failed = sameSubject ? prior.failedVerificationCycles : 0;
    const maxFailed = Math.max(node.config.limits.maxFailedVerificationCycles, sameSubject ? prior.maxFailedVerificationCycles : 0);
    this.store.transaction(() => {
      const plan = { schemaVersion: 1, mapExecutionId: execId, seq, generation, subjectId, templateFingerprint: fingerprint, map, documentation: values.documentation, base: values.base,
        approval: values.approval, roles: node.config.roles, priorState: prior ? prepared.priorRef : null, carried: carried.map(item => item.taskId), fingerprints,
        priorExecutionId: prior?.mapExecutionId ?? null, priorSubjectId: prior?.subjectId ?? null, crossRevision };
      const planArtifact = this.store.putJson(plan);
      this.store.run(`INSERT INTO map_executions(id, run_id, map_instance_id, attempt_id, generation, subject_id, template_fingerprint, state, failed_cycles, max_failed_cycles, max_task_attempts, pause_reason, plan_artifact_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, NULL, ?, ?)`, execId, state.id, attempt.node_instance_id, attempt.id, generation, subjectId, fingerprint, failed, maxFailed,
      node.config.limits.maxTaskAttempts, planArtifact.artifactId, nowIso());
      const events = [this.commitInputs(state, attempt, values)];
      events.push(...this.attemptTransition(attempt, 'running', 'Map expanded its tasks.'));
      events.push({ type: 'map.expanded', nodeInstanceId: attempt.node_instance_id, attemptId: attempt.id, payload: { mapExecutionId: execId, generation, specificationId: subjectId,
        templateFingerprint: fingerprint, plan: ref(planArtifact), tasks: map.tasks.length, carried: carried.map(item => item.taskId), priorState: prior ? prepared.priorRef : null } });
      for (const task of map.tasks) {
        const kept = carried.find(item => item.taskId === task.id);
        let stateName = 'waiting', selected = null;
        const data = { epoch: 1, pinned: {}, materializedPins: null, currentResultId: null, feedback: [], issues: [], criteria: {}, carried: false, cycle: null, results: [], carriedFrom: null };
        if (repairTargets.includes(task.id)) { stateName = 'needs_changes'; data.feedback = repair.issues; data.issues = repair.issues; }
        else if (kept) {
          stateName = 'accepted'; selected = kept.selectedResult.recordId; data.carried = true; data.currentResultId = selected;
          data.criteria = kept.criteria?.length ? Object.fromEntries(kept.criteria.map(item => [item.id, { verdict: 'passed', recordId: item.recordId }])) : { carried: { verdict: 'passed', recordId: null } };
          data.results = [{ recordId: selected, status: 'carried' }];
          this.readRecord(selected, 'TaskResult');
          let carryRecord = null;
          if (crossRevision) {
            carryRecord = this.mapRecord(state, 'TaskCarry', 'taskCarry', { schemaVersion: 1, kind: 'TaskCarry', recordId: recordId('TCAR', { exec: execId, task: task.id, result: selected }),
              mapExecutionId: execId, taskId: task.id, subjectId, priorSubjectId: prior.subjectId, priorMapExecutionId: prior.mapExecutionId, result: kept.selectedResult,
              fingerprint: fingerprints[task.id], verifiedAt: nowIso() });
            events.push({ type: 'map.record_created', nodeInstanceId: attempt.node_instance_id, attemptId: attempt.id, payload: { mapExecutionId: execId, taskId: task.id, kind: 'TaskCarry', record: carryRecord, stepInstanceId: null } });
          }
          data.carriedFrom = { mapExecutionId: prior.mapExecutionId, subjectId: prior.subjectId, resultId: selected, carryRecordId: carryRecord?.recordId ?? null, crossRevision };
        }
        this.store.run('INSERT INTO map_tasks(execution_id, task_id, state, selected_result_id, attempts, data_json) VALUES (?, ?, ?, ?, 0, ?)', execId, task.id, stateName, selected, JSON.stringify(data));
        events.push({ type: 'map.task_state_changed', nodeInstanceId: attempt.node_instance_id, attemptId: attempt.id, payload: { mapExecutionId: execId, taskId: task.id, from: null, to: stateName,
          reason: stateName === 'accepted' ? (crossRevision ? `Carried from ${prior.subjectId}: unchanged task fingerprint and dependencies.` : 'Carried: same specification and templates; selection unaffected by repair.')
            : stateName === 'needs_changes' ? 'Targeted by the repair input.' : 'Planned.' } });
      }
      this.store.appendEvents(state.id, events);
    });
    this.mapState(state).byInstance.set(attempt.node_instance_id, execId);
    void bundle;
  };

  P.prepareMap = function prepareMap(state, node, values) {
    const verified = gate.verify({ store: this.store, config: { policy: node.config.approvalPolicy }, inputs: { subject: values.documentation, certificate: values.approval },
      lookupRecord: id => this.store.get('SELECT * FROM pipeline_records WHERE id = ?', id) });
    if (verified.status !== 'OPEN') fail(`The documentation approval does not verify: ${verified.reason}`);
    const bundle = gate.readBundle(this.store, values.documentation);
    const entry = bundle.entries.get('implementation-map.json');
    if (!entry) fail('The approved bundle contains no implementation-map.json.');
    let map;
    try { map = parseStrictJson(this.store.readBytes(entry.artifact.artifactId).bytes.toString('utf8')); } catch (error) { fail(`implementation-map.json is not valid JSON: ${error.message}`); }
    const issues = mapIssues(map, bundle.index, node.config.roles);
    if (issues.length) fail(`The implementation map is invalid: ${issues.map(issue => `[${issue.code}] ${issue.message}`).join(' ')}`);
    this.values.readManifest(values.base.artifact);
    const subjectId = gate.subjectIdOf(values.documentation.artifact.sha256);
    const fingerprint = templateFingerprint(node.config);
    let prior = null, priorRef = null;
    const priorValue = values['prior-state'] ? this.values.readValue(values['prior-state']) : null;
    if (priorValue !== null) { prior = this.verifiedRecord(priorValue, 'MapState'); priorRef = priorValue; }
    const sameSubject = Boolean(prior && prior.subjectId === subjectId && prior.templateFingerprint === fingerprint);
    // M6: an earlier specification revision may contribute verified, fingerprint-equal selections.
    const crossRevision = Boolean(prior && !sameSubject && node.config.carryAcrossRevisions && prior.templateFingerprint === fingerprint);
    const fingerprints = taskFingerprints(map, bundle.index, gate.sectionHashes(bundle), values.base.artifact.sha256, node.config.roles, { nativeConfiguration: state.workflow.settings.nativeConfiguration });
    let repair = values.repair ? this.values.readValue(values.repair) : null;
    if (repair !== null) {
      const problems = check('map.schema.json', 'mapRepair', repair);
      if (problems.length) fail(`The repair input is not a MapRepair: ${problems.map(item => `${item.path} ${item.message}`).join('; ')}`);
      if (repair.subjectId !== subjectId) fail(`The repair targets ${repair.subjectId}, not the approved subject ${subjectId}.`);
      for (const id of repair.taskIds) if (!map.tasks.some(task => task.id === id)) fail(`The repair targets unknown task ${id}.`);
    } else repair = null;
    return { map, bundle, subjectId, fingerprint, prior, priorRef, repair, sameSubject, crossRevision, fingerprints };
  };

  // ---------- Step planning ----------
  P.planStep = function planStep(state, exec, taskId, step, extra, events) {
    const instance = `${exec.row.map_instance_id}/${exec.plan.seq}/${slug(taskId, step)}`;
    this.mapState(state).steps.set(instance, { execId: exec.row.id, taskId, step, ...extra });
    this.planAttempt(state, instance, slug(taskId, step), 'map-step', { loopNodeId: exec.row.map_instance_id, iteration: exec.plan.seq }, events, `Map step ${step} of ${taskId}.`);
    return instance;
  };
  const criterionStep = criterion => `${criterion.method === 'review' ? 'review' : 'check'}-${criterion.id.toLowerCase()}`;

  P.planExecute = function planExecute(state, exec, task, events) {
    const def = exec.defs.get(task.row.task_id);
    const pins = Object.fromEntries(def.dependsOn.map(dep => [dep.taskId, exec.tasks.get(dep.taskId).row.selected_result_id]));
    if (task.data.materializedPins && canonicalHash(task.data.materializedPins) !== canonicalHash(pins)) task.data.epoch += 1;
    task.data.pinned = pins;
    task.row.attempts += 1;
    this.setTask(exec, task, 'running', task.row.attempts > 1 ? `Repair attempt ${task.row.attempts}.` : 'Inputs are current; dispatching the executor.', events);
    this.planStep(state, exec, task.row.task_id, 'execute', {}, events);
  };

  P.startCycle = function startCycle(state, exec, task, events) {
    if (exec.row.failed_cycles >= exec.row.max_failed_cycles) {
      this.setTask(exec, task, 'blocked', 'The verification-cycle limit is reached before another cycle.', events);
      return this.pauseMap(state, exec, 'verification_limit', `${exec.row.failed_cycles} failed verification cycle(s) reached the limit of ${exec.row.max_failed_cycles}.`, events);
    }
    const def = exec.defs.get(task.row.task_id);
    task.data.pinned = Object.fromEntries(def.dependsOn.map(dep => [dep.taskId, exec.tasks.get(dep.taskId).row.selected_result_id]));
    task.data.cycle = { n: (task.data.cycle?.n || 0) + 1, candidate: null, conflict: null, checksPlanned: false, checks: {}, counted: false, triage: null, triagePlanned: false, applied: false };
    task.row.attempts += 1;
    this.setTask(exec, task, 'running', `Verification cycle ${task.data.cycle.n}: assembling the selected results.`, events);
    this.planStep(state, exec, task.row.task_id, 'assemble', {}, events);
  };

  P.pauseMap = function pauseMap(state, exec, reason, message, events) {
    this.store.run(`UPDATE map_executions SET state = 'paused', pause_reason = ? WHERE id = ?`, reason, exec.row.id);
    exec.row.state = 'paused'; exec.row.pause_reason = reason;
    events.push(this.mapEvent(exec, 'map.paused', { reason, message }));
    const attempt = this.store.get('SELECT * FROM attempts WHERE id = ?', exec.row.attempt_id);
    events.push(...this.attemptTransition(attempt, 'waiting', `Map paused: ${reason}.`));
    this.writeMapState(state, exec, events);
  };
  P.resumeMap = function resumeMap(state, exec, reason, events) {
    this.store.run(`UPDATE map_executions SET state = 'running', pause_reason = NULL WHERE id = ?`, exec.row.id);
    exec.row.state = 'running'; exec.row.pause_reason = null;
    events.push(this.mapEvent(exec, 'map.resumed', { reason }));
    const attempt = this.store.get('SELECT * FROM attempts WHERE id = ?', exec.row.attempt_id);
    events.push(...this.attemptTransition(attempt, 'running', `Map resumed: ${reason}`));
  };

  // ---------- Progress ----------
  P.advanceMaps = function advanceMaps(state) {
    let changed = false;
    for (const execId of this.mapState(state).byInstance.values()) {
      const row = this.store.get('SELECT state FROM map_executions WHERE id = ?', execId);
      if (row && ['running', 'finishing'].includes(row.state)) changed = this.advanceMap(state, execId) || changed;
    }
    return changed;
  };

  P.advanceMap = function advanceMap(state, execId) {
    return this.store.transaction(() => {
      const exec = this.loadExec(state, execId);
      const events = [];
      const touched = new Set();
      const mark = task => touched.add(task);
      if (exec.row.state === 'running') {
        for (const taskId of topologicalTasks(exec.plan.map)) {
          if (exec.row.state !== 'running') break;
          const task = exec.tasks.get(taskId), def = exec.defs.get(taskId), role = exec.roles.get(def.executorRole);
          const before = JSON.stringify([task.row, task.data]);
          const depsOk = def.dependsOn.every(dep => exec.tasks.get(dep.taskId).row.state === 'accepted');
          const utility = role.kind === 'utility';
          const state0 = task.row.state;
          if (['waiting', 'stale'].includes(state0) && depsOk) {
            if (utility) this.startCycle(state, exec, task, events); else this.planExecute(state, exec, task, events);
          } else if (state0 === 'needs_changes' && depsOk) {
            if (task.row.attempts >= exec.row.max_task_attempts) {
              this.setTask(exec, task, 'blocked', `${task.row.attempts} attempt(s) used; the per-task limit is ${exec.row.max_task_attempts}.`, events);
              this.pauseMap(state, exec, 'task_attempt_limit', `${taskId} needs changes after ${task.row.attempts} attempt(s).`, events);
            } else if (utility) this.startCycle(state, exec, task, events);
            else this.planExecute(state, exec, task, events);
          } else if (state0 === 'awaiting_review') {
            const criteria = Object.values(task.data.criteria);
            if (criteria.every(item => item.verdict !== 'pending')) {
              if (criteria.every(item => item.verdict === 'passed')) {
                this.setTask(exec, task, 'accepted', `Every criterion passed for ${task.data.currentResultId}.`, events);
                task.row.selected_result_id = task.data.currentResultId;
                task.data.issues = [];
              } else {
                task.data.feedback = criteria.flatMap(item => item.issues || []);
                task.data.issues = task.data.feedback;
                this.setTask(exec, task, 'needs_changes', `Criteria failed for ${task.data.currentResultId}: ${Object.entries(task.data.criteria).filter(([, item]) => item.verdict === 'failed').map(([id]) => id).join(', ')}.`, events);
              }
            }
          } else if (state0 === 'running' && utility && task.data.cycle) this.progressCycle(state, exec, task, events);
          if (JSON.stringify([task.row, task.data]) !== before) mark(task);
        }
        if (exec.row.state === 'running' && [...exec.tasks.values()].every(task => task.row.state === 'accepted')) {
          for (const task of touched) this.saveTask(exec, task);
          touched.clear();
          this.finishMap(state, exec, 'implementation_complete', events);
        }
      }
      if (exec.row.state === 'finishing') {
        const prefix = `${exec.row.map_instance_id}/${exec.plan.seq}/`;
        const live = this.liveIn(state).some(record => record.mapPrefix === prefix);
        if (!live) {
          for (const task of touched) this.saveTask(exec, task);
          touched.clear();
          this.cancelMapSteps(state, exec, events, 'The Map returned a specification revision.');
          this.finishMap(state, exec, 'specification_revision_required', events);
        }
      }
      for (const task of touched) this.saveTask(exec, task);
      if (events.length) this.store.appendEvents(state.id, events);
      return events.length > 0;
    });
  };

  P.progressCycle = function progressCycle(state, exec, task, events) {
    const cycle = task.data.cycle, def = exec.defs.get(task.row.task_id);
    const evidence = () => [...(cycle.conflict ? [cycle.conflict] : []), ...Object.values(cycle.checks).map(item => item.ref)];
    if (cycle.triage && !cycle.applied) return this.applyTriage(state, exec, task, events);
    if (cycle.counted) return;
    if (cycle.conflict) return this.countFailure(state, exec, task, 'conflict', evidence(), events);
    if (!cycle.candidate) return;
    const checks = def.acceptanceCriteria;
    if (!cycle.checksPlanned) {
      cycle.checksPlanned = true;
      for (const criterion of checks) this.planStep(state, exec, task.row.task_id, criterionStep(criterion), { criterionId: criterion.id }, events);
      return;
    }
    if (!checks.every(criterion => cycle.checks[criterion.id])) return;
    if (checks.every(criterion => cycle.checks[criterion.id].outcome === 'passed')) {
      const candidate = this.readRecord(cycle.candidate.recordId, 'Candidate');
      const reportArtifact = this.store.putJson({ schemaVersion: 1, kind: 'VerificationReport', candidate: cycle.candidate, checks: checks.map(criterion => cycle.checks[criterion.id].ref) });
      const outputs = {};
      for (const output of def.outputs) outputs[output.id] = output.type === 'candidate' ? { type: 'candidate', record: candidate.ref } : { type: 'json', artifact: ref(reportArtifact) };
      const assembleAttempt = this.latestAttempt(state.id, `${exec.row.map_instance_id}/${exec.plan.seq}/${slug(task.row.task_id, 'assemble')}`);
      const result = this.mapRecord(state, 'TaskResult', 'taskResult', { schemaVersion: 1, kind: 'TaskResult',
        recordId: recordId('RES', { exec: exec.row.id, task: task.row.task_id, cycle: cycle.n, candidate: cycle.candidate.recordId }),
        mapExecutionId: exec.row.id, generation: exec.row.generation, subjectId: exec.row.subject_id, taskId: task.row.task_id,
        attempt: { runId: state.id, nodeInstanceId: assembleAttempt.node_instance_id, attemptId: assembleAttempt.id, role: def.executorRole, requestedModel: null, observedModel: null },
        templateRevision: exec.row.template_fingerprint, inputs: this.taskInputs(exec, def, task), operations: [], outputs, taskReturn: null });
      events.push(this.mapEvent(exec, 'map.record_created', { taskId: task.row.task_id, kind: 'TaskResult', record: result, stepInstanceId: null }));
      events.push(this.mapEvent(exec, 'map.verification_cycle', { taskId: task.row.task_id, cycle: cycle.n, outcome: 'passed', failedVerificationCycles: exec.row.failed_cycles,
        maxFailedVerificationCycles: exec.row.max_failed_cycles, evidence: evidence() }));
      task.data.currentResultId = result.recordId;
      (task.data.results ||= []).push({ recordId: result.recordId, status: 'pending' });
      task.data.criteria = Object.fromEntries(checks.map(criterion => [criterion.id, { verdict: 'passed', recordId: cycle.checks[criterion.id].ref.recordId }]));
      cycle.counted = true;
      this.setTask(exec, task, 'accepted', `Both the candidate and every required check passed (cycle ${cycle.n}).`, events);
      task.row.selected_result_id = result.recordId;
      return;
    }
    this.countFailure(state, exec, task, 'failed', evidence(), events);
  };

  // One completed failed or conflicting cycle counts once; the limit pauses before triage.
  P.countFailure = function countFailure(state, exec, task, outcome, evidence, events) {
    const cycle = task.data.cycle;
    cycle.counted = true;
    exec.row.failed_cycles += 1;
    this.store.run('UPDATE map_executions SET failed_cycles = ? WHERE id = ?', exec.row.failed_cycles, exec.row.id);
    events.push(this.mapEvent(exec, 'map.verification_cycle', { taskId: task.row.task_id, cycle: cycle.n, outcome, failedVerificationCycles: exec.row.failed_cycles,
      maxFailedVerificationCycles: exec.row.max_failed_cycles, evidence }));
    task.data.criteria = Object.fromEntries(exec.defs.get(task.row.task_id).acceptanceCriteria.map(criterion => [criterion.id, { verdict: cycle.checks[criterion.id]?.outcome === 'passed' ? 'passed' : 'failed', recordId: cycle.checks[criterion.id]?.ref.recordId ?? null }]));
    if (exec.row.failed_cycles >= exec.row.max_failed_cycles) {
      this.setTask(exec, task, 'blocked', `Failed verification cycle ${exec.row.failed_cycles} reached the limit.`, events);
      return this.pauseMap(state, exec, 'verification_limit', `${exec.row.failed_cycles} failed verification cycle(s) reached the limit of ${exec.row.max_failed_cycles}; evidence is captured.`, events);
    }
    this.planTriage(state, exec, task, events);
  };
  P.planTriage = function planTriage(state, exec, task, events) {
    task.data.cycle.triagePlanned = true;
    this.planStep(state, exec, task.row.task_id, 'triage', {}, events);
  };

  P.applyTriage = function applyTriage(state, exec, task, events) {
    const cycle = task.data.cycle, triage = cycle.triage;
    cycle.applied = true;
    if (triage.cause === 'specification') {
      task.data.revisionIssues = triage.issues;
      this.store.run(`UPDATE map_executions SET state = 'finishing' WHERE id = ?`, exec.row.id);
      exec.row.state = 'finishing';
      return;
    }
    if (triage.cause === 'unknown') {
      this.setTask(exec, task, 'blocked', 'Triage could not identify a cause.', events);
      return this.pauseMap(state, exec, 'triage_unknown', `Triage ${triage.recordId} returned cause unknown; correct it and retry the triage step.`, events);
    }
    for (const id of triage.affectedTaskIds) {
      const target = exec.tasks.get(id);
      target.data.feedback = triage.issues; target.data.issues = triage.issues;
      target.row.selected_result_id = null;
      this.setTask(exec, target, 'needs_changes', `Triage ${triage.recordId} (${triage.cause}) targets this task.`, events);
      this.saveTask(exec, target);
    }
    for (const id of consumersOf(exec.plan.map, triage.affectedTaskIds)) {
      const consumer = exec.tasks.get(id);
      if (id === task.row.task_id) continue;
      if (consumer.row.state === 'accepted' || consumer.row.state === 'awaiting_review') {
        consumer.row.selected_result_id = null;
        this.setTask(exec, consumer, 'stale', `A repaired dependency invalidates the selection.`, events);
        this.saveTask(exec, consumer);
      }
    }
    this.setTask(exec, task, 'stale', `Waiting for the repaired task(s) ${triage.affectedTaskIds.join(', ')}.`, events);
  };

  P.cancelMapSteps = function cancelMapSteps(state, exec, events, reason) {
    const prefix = `${exec.row.map_instance_id}/${exec.plan.seq}/`;
    for (const attempt of this.latestAttempts(state.id).filter(item => item.node_instance_id.startsWith(prefix) && UNSTARTED.has(item.state)))
      events.push(...this.attemptTransition(attempt, 'canceled', reason));
  };

  P.taskInputs = function taskInputs(exec, def, task) {
    return def.inputs.map(input => {
      if (input.ref === 'base:project') return { id: input.id, ref: input.ref, digest: exec.plan.base.artifact.sha256 };
      if (input.ref.startsWith('spec:')) return { id: input.id, ref: input.ref, digest: sha256(Buffer.from(exec.bundle.headings.get(input.ref.slice(5)) || '', 'utf8')) };
      const producer = input.ref.split(':')[1];
      const selected = task.data.pinned[producer];
      return { id: input.id, ref: input.ref, digest: selected ? this.readRecord(selected, 'TaskResult').ref.artifact.sha256 : '0'.repeat(64) };
    });
  };

  P.writeMapState = function writeMapState(state, exec, events) {
    const tasks = [...exec.tasks.values()].map(task => ({ taskId: task.row.task_id, state: task.row.state,
      selectedResult: task.row.selected_result_id ? this.readRecord(task.row.selected_result_id, 'TaskResult').ref : null, attempts: task.row.attempts,
      ...(exec.plan.fingerprints?.[task.row.task_id] ? { fingerprint: exec.plan.fingerprints[task.row.task_id] } : {}),
      // Criterion evidence travels with an accepted selection, so a carried task keeps its proof.
      criteria: task.row.state === 'accepted' ? Object.entries(task.data.criteria || {}).filter(([, item]) => item.recordId).map(([id, item]) => ({ id, recordId: item.recordId })) : [] }));
    const issues = [...exec.tasks.values()].flatMap(task => task.data.revisionIssues || task.data.issues || []);
    const record = { schemaVersion: 1, kind: 'MapState', recordId: recordId('MST', { exec: exec.row.id, tasks, state: exec.row.state, failed: exec.row.failed_cycles, at: nowIso(), nonce: randomUUID() }),
      mapExecutionId: exec.row.id, generation: exec.row.generation, subjectId: exec.row.subject_id, templateFingerprint: exec.row.template_fingerprint, state: exec.row.state,
      failedVerificationCycles: exec.row.failed_cycles, maxFailedVerificationCycles: exec.row.max_failed_cycles, pauseReason: exec.row.pause_reason, tasks, issues: dedupe(issues) };
    const stored = this.mapRecord(state, 'MapState', 'mapState', record);
    events.push(this.mapEvent(exec, 'map.record_created', { taskId: exec.plan.map.tasks[0].id, kind: 'MapState', record: stored, stepInstanceId: null }));
    return stored;
  };
  const dedupe = issues => [...new Map(issues.map(issue => [issue.id, issue])).values()];

  P.finishMap = function finishMap(state, exec, outcome, events) {
    exec.row.state = outcome;
    this.store.run('UPDATE map_executions SET state = ? WHERE id = ?', outcome, exec.row.id);
    const accepted = [...exec.tasks.values()].filter(task => task.row.state === 'accepted');
    const selectedResults = accepted.map(task => ({ taskId: task.row.task_id, result: this.readRecord(task.row.selected_result_id, 'TaskResult').ref }));
    let candidate = null, result;
    if (outcome === 'implementation_complete') {
      for (const item of selectedResults) {
        const value = this.readRecord(item.result.recordId, 'TaskResult').value;
        for (const output of Object.values(value.outputs)) if (output.type === 'candidate') candidate = output.record;
      }
      if (candidate) result = setValue(this.verifiedRecordManifest(candidate));
      else {
        const assembled = assemble(this.values.readManifest(exec.plan.base.artifact).entries, selectedResults.map(item => ({ recordId: item.result.recordId, operations: this.readRecord(item.result.recordId, 'TaskResult').value.operations })));
        if (assembled.conflicts) fail('Selected task results conflict; the Map cannot complete without a verification task.');
        result = this.values.putSet(assembled.entries.map(({ from, ...entry }) => entry));
      }
    } else result = this.values.putSet([]);
    const checks = [...exec.tasks.values()].flatMap(task => Object.values(task.data.criteria || {}).map(item => item.recordId).filter(id => id?.startsWith('CHK-')))
      .map(id => this.readRecord(id, 'CheckReport').ref);
    const stored = this.writeMapState(state, exec, events);
    const issues = outcome === 'implementation_complete' ? [] : dedupe([...exec.tasks.values()].flatMap(task => task.data.revisionIssues || []));
    const summary = { schemaVersion: 1, kind: 'MapSummary', mapExecutionId: exec.row.id, generation: exec.row.generation, specificationId: exec.row.subject_id, outcome,
      state: stored, selectedResults, issues, candidate, checks: [...new Map(checks.map(item => [item.recordId, item])).values()],
      carries: [...exec.tasks.values()].map(task => task.data.carriedFrom?.carryRecordId).filter(Boolean).map(id => this.readRecord(id, 'TaskCarry').ref) };
    assertValid('map.schema.json', 'summary', summary, 'Map summary');
    const summaryArtifact = this.store.putJson(summary);
    const attempt = this.store.get('SELECT * FROM attempts WHERE id = ?', exec.row.attempt_id);
    events.push(this.commitOutputs(state, attempt, { result, summary: jsonValue(summaryArtifact) }));
    events.push(this.mapEvent(exec, 'map.finished', { outcome, summary: ref(summaryArtifact), state: stored }));
    events.push(...this.attemptTransition(attempt, 'succeeded', outcome === 'implementation_complete' ? 'Every required task is accepted.' : 'A validated specification issue returns to the Analyst.'));
  };
  P.verifiedRecordManifest = function verifiedRecordManifest(candidateRef) {
    const value = this.verifiedRecord(candidateRef, 'Candidate');
    this.values.readManifest(value.manifest);
    return { artifactId: value.manifest.artifactId, sha256: value.manifest.sha256 };
  };

  // ---------- Trees and directories ----------
  P.treeEntries = function treeEntries(exec, task, extraResultId = null) {
    const base = this.values.readManifest(exec.plan.base.artifact).entries;
    const ids = [...Object.values(task.data.pinned || {}).filter(Boolean), ...(extraResultId ? [extraResultId] : [])];
    const assembled = assemble(base, ids.map(id => ({ recordId: id, operations: this.readRecord(id, 'TaskResult').value.operations })));
    if (assembled.conflicts) fail(`Dependency results conflict on ${assembled.conflicts.map(item => item.path).join(', ')}.`);
    return assembled.entries;
  };
  P.materialize = function materialize(dir, entries) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const entry of entries) {
      const target = join(dir, ...entry.path.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, this.store.readBytes(entry.artifact.artifactId).bytes);
    }
    return snapshot(dir);
  };
  P.taskDir = function taskDir(state, exec, taskId, role, epoch = 1) {
    return join(this.store.workdirs, 'tasks', state.id, exec.row.id.slice(0, 8), String(exec.row.generation), taskId, `${role}${epoch > 1 ? `-${epoch}` : ''}`);
  };

  P.roleMapping = function roleMapping(state, exec, scope, role, taskId, dir, epoch) {
    if (role.context !== 'task') {
      const mapping = this.store.get('SELECT * FROM run_context_bindings WHERE run_id = ? AND context_node_id = ?', state.id, this.contextKey(state, scope, role.context.contextId));
      return { mapping, workspace: this.workspaceOf(state) };
    }
    const workspace = { ...this.workspaceOf(state), cwd: dir, cwd_identity: pathIdentity(dir) };
    const key = `${exec.row.map_instance_id}/${exec.plan.seq}/${slug(taskId, role.id)}${epoch > 1 ? `-${epoch}` : ''}`;
    let mapping = this.store.get('SELECT * FROM run_context_bindings WHERE run_id = ? AND context_node_id = ?', state.id, key);
    if (!mapping) {
      this.store.run('INSERT INTO run_context_bindings(run_id, context_node_id, mode, binding_id) VALUES (?, ?, ?, ?)', state.id, key, 'new', this.createBinding(state.id, { id: workspace.id, cwd_identity: workspace.cwd_identity }, role.provider, key));
      mapping = this.store.get('SELECT * FROM run_context_bindings WHERE run_id = ? AND context_node_id = ?', state.id, key);
    }
    return { mapping, workspace };
  };

  // ---------- Dispatch ----------
  P.mapStepReadiness = function mapStepReadiness(state, attempt) {
    if (!UNSTARTED.has(attempt.state) || this.processes.has(attempt.id)) return null;
    const info = this.mapState(state).steps.get(attempt.node_instance_id);
    const row = this.store.get('SELECT state FROM map_executions WHERE id = ?', info.execId);
    if (row?.state !== 'running') return null;
    const { prefix } = parseInstance(this.store.get('SELECT node_instance_id FROM attempts WHERE id = (SELECT attempt_id FROM map_executions WHERE id = ?)', info.execId).node_instance_id);
    if (!this.scopeActive(state, this.scopeFor(state, prefix))) return null;
    return { action: 'map-step', info };
  };

  P.dispatchMapStep = function dispatchMapStep(state, attempt, info) {
    const exec = this.loadExec(state, info.execId);
    const mapAttempt = this.store.get('SELECT * FROM attempts WHERE id = ?', exec.row.attempt_id);
    const scope = this.scopeFor(state, parseInstance(mapAttempt.node_instance_id).prefix);
    const task = exec.tasks.get(info.taskId), def = exec.defs.get(info.taskId);
    try {
      if (info.step === 'assemble') { this.runAssemble(state, exec, task, def, attempt); return true; }
      if (info.step.startsWith('check-')) { this.runCheck(state, exec, task, def, attempt, info, scope); return false; }
      const spec = info.step === 'execute' ? this.executeSpec(state, exec, task, def, scope)
        : info.step === 'triage' ? this.triageSpec(state, exec, task, def, scope)
          : this.reviewSpec(state, exec, task, def, info, scope);
      spec.mapPrefix = `${exec.row.map_instance_id}/${exec.plan.seq}/`;
      const node = { id: slug(info.taskId, info.step), type: 'agent', config: { provider: spec.role.provider, model: spec.role.model, effort: spec.role.effort, timeoutSeconds: spec.role.timeoutSeconds, output: { format: 'json', schema: spec.schema } } };
      this.tryDispatchAgent(state, scope, node, attempt, spec);
      const record = this.processes.get(attempt.id);
      if (record) record.mapPrefix = spec.mapPrefix;
      return false;
    } catch (error) {
      this.failAttempt(state, attempt, error instanceof CorruptionError ? 'corruption' : 'output_contract', error.message);
      return true;
    }
  };

  P.executeSpec = function executeSpec(state, exec, task, def, scope) {
    const role = exec.roles.get(def.executorRole);
    const epoch = task.data.epoch;
    const dir = this.taskDir(state, exec, def.id, 'executor', epoch);
    const { mapping, workspace } = this.roleMapping(state, exec, scope, role, def.id, dir, epoch);
    let before = null;
    const spec = {
      role, mapping, workspace, schema: outputSchema('taskReturn'),
      values: () => this.store.transaction(() => {
        const fresh = this.loadExec(state, exec.row.id).tasks.get(def.id);
        if (fresh.data.materializedEpoch !== epoch) {
          fresh.data.materialized = this.materialize(dir, this.treeEntries(exec, fresh));
          fresh.data.materializedEpoch = epoch;
          fresh.data.materializedPins = fresh.data.pinned;
          this.saveTask(exec, fresh);
        }
        before = snapshot(dir);
        const prompt = executePrompt({ role, task: def, bundle: exec.bundle, subjectId: exec.row.subject_id, map: exec.plan.map, generation: exec.row.generation, feedback: fresh.data.feedback });
        return { prompt: textValue(this.store.putText(prompt)) };
      }),
      check: parsed => {
        if (parsed.kind !== 'candidate') return null;
        const after = snapshot(dir);
        const fresh = this.loadExec(state, exec.row.id).tasks.get(def.id);
        const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(path => before[path] !== after[path]);
        for (const path of changed) {
          if (!(path in after)) return `${def.id} deleted ${path}; deletes need a reviewed delete operation, which M5 does not accept.`;
          if (!def.writeScopes.some(scope => scopeMatchesSafe(path, scope))) return `${def.id} wrote ${path}, outside its write scopes (${def.writeScopes.join(', ')}).`;
        }
        const operations = [];
        for (const output of def.outputs) for (const path of output.paths) {
          if (!(path in after)) return `${def.id} did not write its declared output ${path}.`;
          const bytes = readFileSync(join(dir, ...path.split('/')));
          const artifact = this.store.putBytes(bytes, 'application/octet-stream');
          const original = fresh.data.materialized[path];
          operations.push(original === undefined ? { op: 'create', path, artifact: ref(artifact), byteSize: bytes.length }
            : { op: 'replace', path, preimage: original, artifact: ref(artifact), byteSize: bytes.length });
        }
        spec.operations = operations;
        return null;
      },
      commit: (parsed, events, current, provider) => {
        const fresh = this.loadExec(state, exec.row.id);
        const freshTask = fresh.tasks.get(def.id);
        const returnArtifact = this.store.putJson(parsed);
        if (parsed.kind === 'specification_revision_required') {
          freshTask.data.revisionIssues = parsed.issues.map(issue => globalIssue(exec, def.id, current.id, issue, 'analyst'));
          freshTask.data.issues = freshTask.data.revisionIssues;
          this.saveTask(fresh, freshTask);
          this.store.run(`UPDATE map_executions SET state = 'finishing' WHERE id = ? AND state = 'running'`, exec.row.id);
          return;
        }
        const outputs = {};
        for (const output of def.outputs) {
          const entries = spec.operations.filter(op => output.paths.includes(op.path)).map(op => ({ path: op.path, artifact: op.artifact, byteSize: op.byteSize, mediaType: 'application/octet-stream' }));
          outputs[output.id] = { type: 'fileSet', manifest: ref(this.values.putSet(entries).artifact) };
        }
        const result = this.mapRecord(state, 'TaskResult', 'taskResult', { schemaVersion: 1, kind: 'TaskResult', recordId: recordId('RES', { exec: exec.row.id, task: def.id, attempt: current.id }),
          mapExecutionId: exec.row.id, generation: exec.row.generation, subjectId: exec.row.subject_id, taskId: def.id,
          attempt: { runId: state.id, nodeInstanceId: current.node_instance_id, attemptId: current.id, role: role.id, requestedModel: provider.requestedModel, observedModel: provider.observedModel ?? null },
          templateRevision: exec.row.template_fingerprint, inputs: this.taskInputs(fresh, def, freshTask), operations: spec.operations, outputs, taskReturn: ref(returnArtifact) });
        events.push(this.mapEvent(fresh, 'map.record_created', { taskId: def.id, kind: 'TaskResult', record: result, stepInstanceId: current.node_instance_id }));
        freshTask.data.currentResultId = result.recordId;
        (freshTask.data.results ||= []).push({ recordId: result.recordId, status: 'pending' });
        freshTask.data.criteria = Object.fromEntries(def.acceptanceCriteria.map(criterion => [criterion.id, { verdict: 'pending', recordId: null, issues: [] }]));
        freshTask.data.feedback = [];
        this.setTask(fresh, freshTask, 'awaiting_review', `Result ${result.recordId} captured; ${def.acceptanceCriteria.length} criterion(s) pending.`, events);
        this.saveTask(fresh, freshTask);
        for (const criterion of def.acceptanceCriteria) this.planStep(state, fresh, def.id, criterionStep(criterion), { criterionId: criterion.id }, events);
      },
    };
    return spec;
  };
  const scopeMatchesSafe = (path, scope) => !scope.startsWith('spec:') && scopeMatches(path, scope);

  P.reviewSpec = function reviewSpec(state, exec, task, def, info, scope) {
    const criterion = def.acceptanceCriteria.find(item => item.id === info.criterionId);
    const role = exec.roles.get(criterion.role);
    const resultId = task.data.currentResultId;
    const result = this.readRecord(resultId, 'TaskResult').value;
    const dir = this.taskDir(state, exec, def.id, role.id);
    const { mapping, workspace } = this.roleMapping(state, exec, scope, role, def.id, dir, 1);
    return {
      role, mapping, workspace, schema: outputSchema('taskReview'),
      values: () => {
        this.materialize(dir, this.treeEntries(exec, task, resultId));
        return { prompt: textValue(this.store.putText(reviewPrompt({ role, task: def, criterion, result, bundle: exec.bundle, subjectId: exec.row.subject_id }))) };
      },
      check: parsed => parsed.taskId !== def.id || parsed.resultId !== resultId || parsed.criterionId !== criterion.id
        ? `The review names ${parsed.taskId}/${parsed.resultId}/${parsed.criterionId}, not ${def.id}/${resultId}/${criterion.id}.` : null,
      commit: (parsed, events, current, provider) => {
        const fresh = this.loadExec(state, exec.row.id);
        const freshTask = fresh.tasks.get(def.id);
        const issues = parsed.issues.map(issue => globalIssue(exec, def.id, current.id, issue, def.executorRole));
        const record = this.mapRecord(state, 'TaskReview', 'taskReviewRecord', { schemaVersion: 1, kind: 'TaskReview', recordId: recordId('TREV', { attempt: current.id }),
          mapExecutionId: exec.row.id, taskId: def.id, resultId, criterionId: criterion.id, verdict: parsed.verdict, decision: ref(this.store.putJson(parsed)),
          reviewer: { runId: state.id, nodeInstanceId: current.node_instance_id, attemptId: current.id, role: role.id, requestedModel: provider.requestedModel, observedModel: provider.observedModel ?? null }, issues });
        events.push(this.mapEvent(fresh, 'map.record_created', { taskId: def.id, kind: 'TaskReview', record, stepInstanceId: current.node_instance_id }));
        if (freshTask.data.currentResultId === resultId && freshTask.data.criteria[criterion.id])
          freshTask.data.criteria[criterion.id] = { verdict: parsed.verdict === 'APPROVED' ? 'passed' : 'failed', recordId: record.recordId, issues: issues.filter(issue => issue.severity === 'blocker') };
        this.saveTask(fresh, freshTask);
      },
    };
  };

  P.triageSpec = function triageSpec(state, exec, task, def, scope) {
    const verification = exec.roles.get(def.executorRole);
    const role = exec.roles.get(verification.embeddedRoles.triage);
    const cycle = task.data.cycle;
    const dir = this.taskDir(state, exec, def.id, role.id);
    const { mapping, workspace } = this.roleMapping(state, exec, scope, role, def.id, dir, 1);
    const candidateTasks = def.dependsOn.map(dep => dep.taskId);
    const schema = outputSchema('triageDecision');
    schema.properties = { ...schema.properties, subjectId: { ...schema.properties.subjectId, const: exec.row.subject_id } };
    return {
      role, mapping, workspace, schema,
      values: () => {
        const failures = Object.entries(cycle.checks).filter(([, item]) => item.outcome === 'failed').map(([criterionId, item]) => {
          const report = this.readRecord(item.ref.recordId, 'CheckReport').value;
          return { criterionId, checkId: report.checkId, exitCode: report.exitCode, requiredExitCode: report.requiredExitCode,
            stdout: tail(this.store.readText(report.stdout.artifactId)), stderr: tail(this.store.readText(report.stderr.artifactId)) };
        });
        const conflict = cycle.conflict ? this.readRecord(cycle.conflict.recordId, 'Conflict').value : null;
        return { prompt: textValue(this.store.putText(triagePrompt({ role, task: def, cycle: cycle.n, subjectId: exec.row.subject_id, bundle: exec.bundle, map: exec.plan.map, candidateTasks, failures, conflict }))) };
      },
      check: parsed => {
        if (parsed.subjectId !== exec.row.subject_id) return `Triage names subject ${parsed.subjectId}, not ${exec.row.subject_id}.`;
        if (['implementation', 'tests', 'integration_conflict'].includes(parsed.cause) && parsed.affectedTaskIds.some(id => !candidateTasks.includes(id)))
          return `Triage targets ${parsed.affectedTaskIds.join(', ')}; repairs must target the verified tasks ${candidateTasks.join(', ')}.`;
        return null;
      },
      commit: (parsed, events, current, provider) => {
        const fresh = this.loadExec(state, exec.row.id);
        const freshTask = fresh.tasks.get(def.id);
        const issues = parsed.issues.map(issue => globalIssue(exec, def.id, current.id, issue, issue.ownerRole));
        const evidence = [...(cycle.conflict ? [cycle.conflict] : []), ...Object.values(cycle.checks).map(item => item.ref)];
        const record = this.mapRecord(state, 'Triage', 'triage', { schemaVersion: 1, kind: 'Triage', recordId: recordId('TRI', { attempt: current.id }), mapExecutionId: exec.row.id,
          taskId: def.id, cycle: cycle.n, decision: ref(this.store.putJson(parsed)), cause: parsed.cause, affectedTaskIds: parsed.affectedTaskIds, issues, evidence,
          triager: { runId: state.id, nodeInstanceId: current.node_instance_id, attemptId: current.id, role: role.id, requestedModel: provider.requestedModel, observedModel: provider.observedModel ?? null } });
        events.push(this.mapEvent(fresh, 'map.record_created', { taskId: def.id, kind: 'Triage', record, stepInstanceId: current.node_instance_id }));
        if (freshTask.data.cycle?.n === cycle.n) freshTask.data.cycle.triage = { recordId: record.recordId, cause: parsed.cause, affectedTaskIds: parsed.affectedTaskIds, issues };
        this.saveTask(fresh, freshTask);
      },
    };
  };

  const globalIssue = (exec, taskId, attemptId, issue, ownerRole) => ({
    id: issueId('MAP', { subject: exec.row.subject_id, taskId, attemptId, localId: issue.localId }),
    severity: issue.severity, ownerRole: issue.ownerRole || ownerRole, requirementRefs: issue.requirementRefs, message: issue.message, requestedChange: issue.requestedChange,
  });

  // ---------- Assemble (static) ----------
  P.runAssemble = function runAssemble(state, exec, task, def, attempt) {
    this.store.transaction(() => {
      const ids = def.dependsOn.map(dep => task.data.pinned[dep.taskId]);
      const results = ids.map(id => ({ recordId: id, operations: this.readRecord(id, 'TaskResult').value.operations }));
      const refs = ids.map(id => this.readRecord(id, 'TaskResult').ref);
      const base = this.values.readManifest(exec.plan.base.artifact).entries;
      const assembled = assemble(base, results);
      const events = [this.commitInputs(state, attempt, { base: exec.plan.base })];
      events.push(...this.attemptTransition(attempt, 'running', 'Assembling selected results.'));
      let stored, kind;
      if (assembled.conflicts) {
        kind = 'Conflict';
        stored = this.mapRecord(state, 'Conflict', 'conflict', { schemaVersion: 1, kind, recordId: recordId('CONF', { attempt: attempt.id }), mapExecutionId: exec.row.id, taskId: def.id,
          base: ref(exec.plan.base.artifact), results: refs, conflicts: assembled.conflicts });
      } else {
        kind = 'Candidate';
        const entries = assembled.entries.map(({ from, ...entry }) => entry);
        const manifest = this.values.putSet(entries);
        const candidateOutput = def.outputs.find(output => output.type === 'candidate');
        for (const path of candidateOutput.paths) if (!entries.some(entry => entry.path === path)) fail(`The candidate lacks its declared path ${path}.`);
        stored = this.mapRecord(state, 'Candidate', 'candidate', { schemaVersion: 1, kind, recordId: recordId('CAND', { manifest: manifest.artifact.sha256, results: ids }), mapExecutionId: exec.row.id,
          taskId: def.id, base: ref(exec.plan.base.artifact), results: refs, manifest: ref(manifest.artifact),
          paths: assembled.entries.map(entry => ({ path: entry.path, sha256: entry.artifact.sha256, from: entry.from })) });
      }
      events.push(this.mapEvent(exec, 'map.record_created', { taskId: def.id, kind, record: stored, stepInstanceId: attempt.node_instance_id }));
      events.push(this.commitOutputs(state, attempt, { record: jsonValue(this.store.putJson(stored)) }));
      events.push(...this.attemptTransition(attempt, 'succeeded', kind === 'Candidate' ? `Candidate ${stored.recordId} assembled.` : `Conflict ${stored.recordId}: no last-writer-wins.`));
      const fresh = this.loadExec(state, exec.row.id).tasks.get(def.id);
      if (kind === 'Candidate') fresh.data.cycle.candidate = stored; else fresh.data.cycle.conflict = stored;
      this.saveTask(exec, fresh);
      this.store.appendEvents(state.id, events);
    });
  };

  // ---------- Test Runner ----------
  P.runCheck = function runCheck(state, exec, task, def, attempt, info, scope) {
    const criterion = def.acceptanceCriteria.find(item => item.id === info.criterionId);
    const section = exec.plan.map && exec.bundle.index.sections.find(item => item.id === criterion.checkId);
    const command = section.command;
    const cycle = task.data.cycle;
    const source = command.source === 'candidate' ? { kind: 'candidate', recordId: cycle.candidate.recordId } : { kind: 'task-result', recordId: task.data.currentResultId };
    const entries = command.source === 'candidate' ? this.values.readManifest(this.readRecord(cycle.candidate.recordId, 'Candidate').value.manifest).entries
      : this.treeEntries(exec, task, task.data.currentResultId);
    const dir = join(this.store.workdirs, 'tmp', attempt.id);
    const before = this.materialize(dir, entries);
    const executable = command.program === 'node' ? process.execPath : command.program;
    const record = { runId: state.id, loops: enclosingLoops(scope.prefix).map(item => item.loopInstance), provider: null, keys: [], child: null, stopRequested: false, timedOut: false, launched: false,
      mapPrefix: `${exec.row.map_instance_id}/${exec.plan.seq}/` };
    this.processes.set(attempt.id, record);
    // The command manifest is captured before spawn (ADR-0002 section 1); streams are durable as they arrive.
    const commandRef = ref(this.store.putJson({ schemaVersion: 1, kind: 'CommandManifest', executable, arguments: command.args, source: source.kind,
      timeoutSeconds: command.timeoutSeconds, requiredExitCode: command.requiredExitCode ?? null, environmentPolicy: 'check-environment' }));
    const extended = this.store.get('SELECT journal_version AS version FROM runs WHERE id = ?', state.id).version >= 2;
    const fault = error => this.captureFault(record, error);
    const streams = { stdout: new StreamRecorder({ store: this.store, runId: state.id, attempt, stream: 'stdout', mediaType: 'application/octet-stream', hardLimitBytes: CHECK_STREAM_LIMIT_BYTES, onFault: fault, extended }),
      stderr: new StreamRecorder({ store: this.store, runId: state.id, attempt, stream: 'stderr', mediaType: 'application/octet-stream', hardLimitBytes: CHECK_STREAM_LIMIT_BYTES, onFault: fault, extended }) };
    let startedAt = null, settled = false;
    const finish = outcome => {
      if (settled) return; settled = true;
      clearTimeout(record.timer);
      // Streams close on every outcome, so the evidence record always has manifests to point at.
      const endingReason = !record.launched ? 'process did not start' : record.captureError ? 'process stopped after a capture fault' : record.timedOut ? 'process stopped after its timeout'
        : record.stopRequested ? 'process stopped by Stop' : outcome.signal ? `process ended by signal ${outcome.signal}` : `process exited with code ${outcome.code}`;
      let closed = null;
      try { closed = { stdout: streams.stdout.close(endingReason, { complete: outcome.complete === true }), stderr: streams.stderr.close(endingReason, { complete: outcome.complete === true }) }; }
      catch (error) { fault(error); }
      try { this.finishCheck(state, exec, def, criterion, attempt, { outcome, dir, before, executable, command, source, streams, closed, startedAt, record, commandRef }); }
      catch (error) { try { this.failAttempt(state, this.store.get('SELECT * FROM attempts WHERE id = ?', attempt.id), 'output_contract', error.message); } catch { /* Journal unavailable. */ } }
      finally {
        rmSync(dir, { recursive: true, force: true });
        this.processes.delete(attempt.id);
        if (record.counted) for (const loopInstance of record.loops) this.bodyEnded(state, loopInstance);
        record.resolveExit?.();
        this.pump();
      }
    };
    this.store.transaction(() => this.store.appendEvents(state.id, [this.commitInputs(state, attempt, {})]));
    record.exited = new Promise(done => { record.resolveExit = done; });
    let child;
    try { child = this.launchContained(state.id, { command: executable, args: command.args, cwd: dir, env: checkEnvironment(), stdin: '' }); }
    catch (error) { return finish({ spawnError: error.message }); }
    record.child = child;
    child.once('error', error => { if (!record.launched) finish({ spawnError: error.message }); });
    child.once('spawn', () => {
      record.launched = true; startedAt = nowIso();
      if (record.loops.length) { record.counted = true; for (const loopInstance of record.loops) this.bodyStarted(state, loopInstance); }
      const startIdentity = `${child.pid}@${startedAt}`;
      this.store.run('UPDATE attempts SET process_id = ?, process_start_identity = ?, supervisor_generation = ?, started_at = ? WHERE id = ?', child.pid, startIdentity, this.supervisorGeneration, startedAt, attempt.id);
      const current = this.store.get('SELECT * FROM attempts WHERE id = ?', attempt.id);
      this.store.transaction(() => this.store.appendEvents(state.id, this.attemptTransition(current, 'running', `Test Runner launched ${command.program}.`, { pid: child.pid, startIdentity, supervisorGeneration: this.supervisorGeneration })));
      record.timer = setTimeout(() => { record.timedOut = true; killTree(child.pid); }, command.timeoutSeconds * 1000);
      if (record.stopRequested) killTree(child.pid);
    });
    child.stdout.on('data', chunk => { try { streams.stdout.add(chunk); } catch (error) { fault(error); } });
    child.stderr.on('data', chunk => { try { streams.stderr.add(chunk); } catch (error) { fault(error); } });
    child.once('close', (code, signal) => {
      // A shim failure exit means the CLI never ran: a spawn failure with no result to judge.
      const shimFailure = this.supervisor ? shimFailureOf(code) : null;
      if (shimFailure) finish({ spawnError: `the launch shim could not start the CLI (${shimFailure})` });
      else finish({ code, signal, complete: true });
    });
  };

  // ADR-0002 section 1: every check outcome leaves an evidence record with its command and stream manifests.
  // A check that never closed its streams has no manifests to point at; its captured chunks stay journaled.
  P.checkEvidence = function checkEvidence(state, attempt, criterion, { kind, reason, outcome, startedAt, commandRef, closed }) {
    if (!closed) return { ref: null, events: [] };
    const captureVerdict = captureVerdictOf(closed);
    const evidence = { schemaVersion: 1, kind: 'ExecutionEvidence', attemptId: attempt.id, nodeInstanceId: attempt.node_instance_id, checkId: criterion.checkId,
      outcome: kind, exitCode: outcome.code ?? null, signal: outcome.signal ?? null, startedAt: startedAt ?? null, endedAt: nowIso(), command: commandRef,
      streams: { stdout: closed.stdout.manifestRef, stderr: closed.stderr.manifestRef }, captureVerdict, reason };
    assertValid('execution-evidence.schema.json', 'executionEvidence', evidence, 'Execution evidence');
    const artifact = this.store.putJson(evidence);
    this.store.run('INSERT INTO execution_evidence(id, run_id, attempt_id, outcome, evidence_artifact_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', randomUUID(), state.id, attempt.id, kind, artifact.artifactId, nowIso());
    const journalled = this.store.get('SELECT journal_version AS version FROM runs WHERE id = ?', state.id).version >= 2;
    const events = journalled ? [{ type: 'attempt.execution_evidence', nodeInstanceId: attempt.node_instance_id, attemptId: attempt.id, payload: { evidence: ref(artifact), outcome: kind, checkId: criterion.checkId } }] : [];
    return { ref: ref(artifact), events };
  };

  P.streamBytes = function streamBytes(manifest) {
    return Buffer.concat(manifest.chunks.map(chunk => this.store.readBytes(chunk.artifact.artifactId).bytes));
  };

  P.finishCheck = function finishCheck(state, exec, def, criterion, attempt, { outcome, dir, before, executable, command, source, streams, closed, startedAt, record, commandRef }) {
    let current = this.store.get('SELECT * FROM attempts WHERE id = ?', attempt.id);
    const evidence = (kind, reason) => this.checkEvidence(state, current, criterion, { kind, reason, outcome, startedAt, commandRef, closed });
    // Failures commit their evidence first, then the attempt failure that refers to it.
    const failWithEvidence = (kind, reason, code, message) => {
      const ev = evidence(kind, reason);
      if (ev.events.length) this.store.transaction(() => this.store.appendEvents(state.id, ev.events));
      this.failAttempt(state, current, code, message, { evidence: ev.ref });
    };
    if (record.stopRequested) {
      const ev = evidence('canceled', 'The check was stopped by Stop.');
      return this.store.transaction(() => this.store.appendEvents(state.id, [...ev.events, ...this.attemptTransition(current, 'canceled', 'Stopped by the user.')]));
    }
    if (record.captureError) {
      const code = record.captureError.code === 'capture_limit' ? 'capture_limit' : 'capture_failed';
      return failWithEvidence('capture_failed', `Capture stopped the process: ${record.captureError.message}`, code, record.captureError.message);
    }
    if (outcome.spawnError) return failWithEvidence('spawn_failed', `The process did not start: ${outcome.spawnError}`, 'process', `The check ${criterion.checkId} could not start: ${outcome.spawnError}`);
    if (record.timedOut) return failWithEvidence('timed_out', `The process exceeded ${command.timeoutSeconds} seconds.`, 'timeout', `${criterion.checkId} exceeded ${command.timeoutSeconds} seconds.`);
    if (outcome.code === null) return failWithEvidence('interrupted', `The process ended by signal ${outcome.signal}.`, 'process', `${criterion.checkId} ended by signal ${outcome.signal}; no passing evidence.`);
    const after = snapshot(dir);
    const modified = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(path => before[path] !== after[path] && !(def.writeScopes.some(scope => scopeMatchesSafe(path, scope)) && !(path in before)));
    if (modified.length) return failWithEvidence('invalid_source', `The check modified sources: ${modified.slice(0, 5).join(', ')}.`, 'output_contract', `${criterion.checkId} modified sources (${modified.slice(0, 5).join(', ')}); its evidence is invalid.`);
    this.store.transaction(() => {
      current = this.store.get('SELECT * FROM attempts WHERE id = ?', attempt.id);
      const passed = outcome.code === command.requiredExitCode;
      const ev = evidence(passed ? 'passed' : 'failed', `Exit code ${outcome.code}; required ${command.requiredExitCode}.`);
      const report = this.mapRecord(state, 'CheckReport', 'checkReport', { schemaVersion: 1, kind: 'CheckReport', recordId: recordId('CHK', { attempt: attempt.id }), mapExecutionId: exec.row.id,
        taskId: def.id, criterionId: criterion.id, checkId: criterion.checkId, subjectId: exec.row.subject_id, source, executable, executableVersion: command.program === 'node' ? process.version : null,
        arguments: command.args, timeoutSeconds: command.timeoutSeconds, requiredExitCode: command.requiredExitCode, exitCode: outcome.code, startedAt: startedAt || nowIso(), endedAt: nowIso(),
        stdout: ref(this.store.putBytes(this.streamBytes(closed.stdout.manifest), 'text/plain; charset=utf-8')), stderr: ref(this.store.putBytes(this.streamBytes(closed.stderr.manifest), 'text/plain; charset=utf-8')),
        sourceIntegrity: 'intact', outcome: passed ? 'passed' : 'failed' });
      const fresh = this.loadExec(state, exec.row.id);
      const task = fresh.tasks.get(def.id);
      const events = [this.mapEvent(fresh, 'map.record_created', { taskId: def.id, kind: 'CheckReport', record: report, stepInstanceId: attempt.node_instance_id })];
      events.push(this.commitOutputs(state, current, { report: jsonValue(this.store.putJson(report)) }));
      events.push(...ev.events);
      events.push(...this.attemptTransition(current, 'succeeded', passed ? `${criterion.checkId} passed (exit ${outcome.code}).` : `${criterion.checkId} failed: exit ${outcome.code}, required ${command.requiredExitCode}.`));
      if (source.kind === 'candidate') { if (task.data.cycle?.candidate?.recordId === source.recordId) task.data.cycle.checks[criterion.id] = { ref: report, outcome: passed ? 'passed' : 'failed' }; }
      else if (task.data.currentResultId === source.recordId && task.data.criteria[criterion.id]) {
        task.data.criteria[criterion.id] = { verdict: passed ? 'passed' : 'failed', recordId: report.recordId,
          issues: passed ? [] : [{ id: issueId('MAP', { report: report.recordId }), severity: 'blocker', ownerRole: def.executorRole, requirementRefs: def.requirementRefs,
            message: `${criterion.checkId} exited ${outcome.code} (required ${command.requiredExitCode}).`, requestedChange: `Make ${criterion.checkId} pass: ${tail(streams.stderr.tailText() || streams.stdout.tailText()).slice(-600)}` }] };
      }
      this.saveTask(fresh, task);
      this.store.appendEvents(state.id, events);
    });
  };

  // ---------- Stop, recovery and inspection ----------
  P.cancelMaps = function cancelMaps(runId, events, reason) {
    for (const row of this.store.all(`SELECT * FROM map_executions WHERE run_id = ? AND state IN ('running','paused','finishing')`, runId)) {
      this.store.run(`UPDATE map_executions SET state = 'canceled', pause_reason = NULL WHERE id = ?`, row.id);
      const attempt = this.store.get('SELECT * FROM attempts WHERE id = ?', row.attempt_id);
      if (['running', 'waiting', 'scheduled'].includes(attempt.state)) events.push(...this.attemptTransition(attempt, 'canceled', reason));
    }
  };
  P.mapAttemptIds = function mapAttemptIds(runId) {
    return new Set(this.store.all('SELECT attempt_id FROM map_executions WHERE run_id = ?', runId).map(item => item.attempt_id));
  };

  P.retryMapStep = function retryMapStep(state, body, events) {
    const info = this.mapState(state).steps.get(body.nodeInstanceId);
    const attempt = this.latestAttempt(state.id, body.nodeInstanceId);
    if (!['failed', 'canceled'].includes(attempt.state)) throw new ApiError(409, 'conflict', `Only failed or canceled Map steps can be retried (state is ${attempt.state}).`);
    const exec = this.loadExec(state, info.execId);
    if (!['running', 'paused'].includes(exec.row.state)) throw new ApiError(409, 'conflict', `The Map execution is ${exec.row.state}.`);
    if (exec.row.state === 'paused' && !(exec.row.pause_reason === 'triage_unknown' && info.step === 'triage'))
      throw new ApiError(409, 'conflict', `The Map is paused at its ${exec.row.pause_reason.replace(/_/g, ' ')}; raise the Map limit instead.`);
    const task = exec.tasks.get(info.taskId), def = exec.defs.get(info.taskId);
    const scope = this.scopeFor(state, parseInstance(exec.row.map_instance_id).prefix);
    // Resolve the same role, epoch and visible Context that dispatch will use.
    const spec = info.step === 'execute' ? this.executeSpec(state, exec, task, def, scope)
      : info.step === 'triage' ? this.triageSpec(state, exec, task, def, scope)
        : info.step.startsWith('review-') ? this.reviewSpec(state, exec, task, def, info, scope) : null;
    if (spec) {
      const mappingRow = spec.mapping;
      const binding = this.store.get('SELECT * FROM context_bindings WHERE id = ?', mappingRow.binding_id);
      const choice = body.binding || 'keep';
      if (choice === 'keep' && !['ready', 'unbound'].includes(binding.state))
        throw new ApiError(422, 'context_unavailable', `The Context binding is ${binding.state}; retry with binding "acknowledge" or "fresh".`);
      if (choice === 'acknowledge' && binding.state === 'needs_review')
        events.push(this.bindingTransition(binding, this.bindingRecord(binding).nativeSessionId ? 'ready' : 'unbound', 'Accepted by the user for retry.', { acknowledgedAt: nowIso() })[0]);
      else if (choice === 'acknowledge' && !['ready', 'unbound'].includes(binding.state))
        throw new ApiError(422, 'context_unavailable', `A ${binding.state} binding cannot be acknowledged.`);
      if (choice === 'fresh') {
        if (mappingRow.mode !== 'new') throw new ApiError(422, 'context_unavailable', 'A Continue Context cannot switch to a fresh binding; edit the workflow instead.');
        const fresh = this.createBinding(state.id, spec.workspace, binding.provider, mappingRow.context_node_id);
        this.store.run('UPDATE run_context_bindings SET binding_id = ? WHERE run_id = ? AND context_node_id = ?', fresh, state.id, mappingRow.context_node_id);
        events.push({ type: 'context.remapped', payload: { contextNodeId: mappingRow.context_node_id, fromBindingId: binding.id, toBindingId: fresh, reason: 'Fresh binding selected for retry.' } });
      }
    } else if (body.binding) throw new ApiError(409, 'conflict', 'binding applies only to Agent Map steps.');
    if (info.step === 'triage' && exec.row.state === 'paused') {
      const task = exec.tasks.get(info.taskId);
      task.data.cycle.triage = null; task.data.cycle.applied = false;
      this.setTask(exec, task, 'running', 'Triage retried after an unknown cause.', events);
      this.saveTask(exec, task);
      this.resumeMap(state, exec, 'The triage step was retried.', events);
    }
    this.planAttempt(state, body.nodeInstanceId, slug(info.taskId, info.step), 'map-step', { loopNodeId: exec.row.map_instance_id, iteration: exec.plan.seq }, events, 'Retry requested by the user.');
  };

  P.raiseMapLimit = function raiseMapLimit(state, body, events) {
    const execId = this.mapState(state).byInstance.get(body.nodeInstanceId);
    if (!execId) throw new ApiError(404, 'not_found', `"${body.nodeInstanceId}" is not a Map in this run.`);
    const exec = this.loadExec(state, execId);
    if (exec.row.state !== 'paused' || !['verification_limit', 'task_attempt_limit'].includes(exec.row.pause_reason)) throw new ApiError(409, 'conflict', 'raise-map-limit needs a Map paused at a verification or task-attempt limit.');
    if (body.maxFailedVerificationCycles < exec.row.max_failed_cycles || body.maxTaskAttempts < exec.row.max_task_attempts) throw new ApiError(409, 'conflict', 'Limits can only be raised.');
    if (exec.row.pause_reason === 'verification_limit' && body.maxFailedVerificationCycles <= exec.row.failed_cycles) throw new ApiError(409, 'conflict', `maxFailedVerificationCycles must exceed the ${exec.row.failed_cycles} failed cycle(s).`);
    const blocked = [...exec.tasks.values()].filter(task => task.row.state === 'blocked');
    if (exec.row.pause_reason === 'task_attempt_limit' && blocked.some(task => body.maxTaskAttempts <= task.row.attempts)) throw new ApiError(409, 'conflict', 'maxTaskAttempts must exceed the attempts already used.');
    this.store.run('UPDATE map_executions SET max_failed_cycles = ?, max_task_attempts = ? WHERE id = ?', body.maxFailedVerificationCycles, body.maxTaskAttempts, exec.row.id);
    exec.row.max_failed_cycles = body.maxFailedVerificationCycles; exec.row.max_task_attempts = body.maxTaskAttempts;
    events.push(this.mapEvent(exec, 'map.limits_changed', { maxFailedVerificationCycles: body.maxFailedVerificationCycles, maxTaskAttempts: body.maxTaskAttempts }));
    const reason = exec.row.pause_reason;
    this.resumeMap(state, exec, 'Limits raised.', events);
    for (const task of blocked) {
      if (reason === 'verification_limit' && task.data.cycle?.counted && !task.data.cycle.triagePlanned) {
        this.setTask(exec, task, 'running', 'Limit raised; triaging the failed cycle.', events);
        this.planTriage(state, exec, task, events);
      } else this.setTask(exec, task, reason === 'task_attempt_limit' ? 'needs_changes' : 'waiting', 'Limit raised.', events);
      this.saveTask(exec, task);
    }
  };

  P.mapSnapshots = function mapSnapshots(runId) {
    return this.store.all('SELECT * FROM map_executions WHERE run_id = ? ORDER BY created_at', runId).map(row => {
      const counts = this.store.all('SELECT state FROM map_tasks WHERE execution_id = ?', row.id);
      return { mapInstanceId: row.map_instance_id, mapExecutionId: row.id, state: row.state, generation: row.generation, failedVerificationCycles: row.failed_cycles,
        maxFailedVerificationCycles: row.max_failed_cycles, pauseReason: row.pause_reason, accepted: counts.filter(item => item.state === 'accepted').length, total: counts.length };
    });
  };

  P.mapNavigator = function mapNavigator(runId, instanceId) {
    this.requireRun(runId);
    const row = this.store.get('SELECT * FROM map_executions WHERE run_id = ? AND map_instance_id = ? ORDER BY created_at DESC LIMIT 1', runId, instanceId);
    if (!row) throw new ApiError(404, 'not_found', `No Map execution for "${instanceId}" in this run.`);
    return this.navigatorFor(row);
  };
  P.mapExecutionNavigator = function mapExecutionNavigator(executionId) {
    const row = this.store.get('SELECT * FROM map_executions WHERE id = ?', executionId);
    if (!row) throw new ApiError(404, 'not_found', `Map execution "${executionId}" does not exist.`);
    return this.navigatorFor(row);
  };
  // Generations of one Map instance: this run's executions, then the prior-state lineage across runs.
  P.mapHistory = function mapHistory(runId, instanceId) {
    this.requireRun(runId);
    const rows = this.store.all('SELECT * FROM map_executions WHERE run_id = ? AND map_instance_id = ? ORDER BY created_at DESC', runId, instanceId);
    if (!rows.length) throw new ApiError(404, 'not_found', `No Map execution for "${instanceId}" in this run.`);
    const seen = new Set(), items = [];
    const add = row => {
      if (!row || seen.has(row.id)) return;
      seen.add(row.id);
      const plan = this.store.readJson(row.plan_artifact_id);
      const counts = this.store.all('SELECT state FROM map_tasks WHERE execution_id = ?', row.id);
      items.push({ mapExecutionId: row.id, runId: row.run_id, mapInstanceId: row.map_instance_id, generation: row.generation, specificationId: row.subject_id, state: row.state,
        createdAt: row.created_at, priorExecutionId: plan.priorExecutionId ?? null, crossRevision: Boolean(plan.crossRevision), carried: (plan.carried || []).length,
        accepted: counts.filter(item => item.state === 'accepted').length, total: counts.length });
      if (plan.priorExecutionId) add(this.store.get('SELECT * FROM map_executions WHERE id = ?', plan.priorExecutionId));
    };
    rows.forEach(add);
    const body = { mapInstanceId: instanceId, executions: items };
    assertValid('map.schema.json', 'history', body, 'Map history');
    return body;
  };
  P.navigatorFor = function navigatorFor(row) {
    const runId = row.run_id, instanceId = row.map_instance_id;
    const plan = this.store.readJson(row.plan_artifact_id);
    const tasks = new Map(this.store.all('SELECT * FROM map_tasks WHERE execution_id = ?', row.id).map(item => [item.task_id, { row: item, data: parseStrictJson(item.data_json) }]));
    const prefix = `${row.map_instance_id}/${plan.seq}/`;
    const steps = this.latestAttempts(runId).filter(item => item.node_instance_id.startsWith(prefix));
    const items = plan.map.tasks.map(def => {
      const task = tasks.get(def.id);
      const own = steps.filter(item => item.node_id.startsWith(`${def.id.toLowerCase()}-`));
      const blockedBy = def.dependsOn.filter(dep => tasks.get(dep.taskId).row.state !== 'accepted').map(dep => dep.taskId);
      const readiness = task.row.state === 'waiting' || task.row.state === 'stale' ? (blockedBy.length ? `Waiting for accepted ${blockedBy.join(', ')}.` : 'Ready for dispatch.')
        : task.row.state === 'blocked' ? `Blocked: ${row.pause_reason?.replace(/_/g, ' ') || 'needs a decision'}.` : null;
      return { taskId: def.id, title: def.title, executorRole: def.executorRole, dependsOn: def.dependsOn.map(dep => dep.taskId), state: task.row.state, readiness,
        attempts: task.row.attempts, selectedResultId: task.row.selected_result_id, carried: Boolean(task.data.carried),
        criteria: def.acceptanceCriteria.map(criterion => {
          const item = task.data.criteria?.[criterion.id];
          return { id: criterion.id, method: criterion.method, verdict: task.data.carried && task.row.state === 'accepted' ? 'passed' : item?.verdict || 'pending', recordId: item?.recordId ?? null };
        }),
        steps: own.map(item => ({ nodeInstanceId: item.node_instance_id, step: item.node_id.slice(def.id.length + 1) || item.node_id, state: item.state, ordinal: item.ordinal, attemptId: item.id })),
        issues: task.data.revisionIssues || task.data.issues || [],
        fingerprint: plan.fingerprints?.[def.id] ?? null, carriedFrom: task.data.carriedFrom ?? null, results: task.data.results ?? [] };
    });
    const count = state => items.filter(item => item.state === state).length;
    void instanceId;
    const body = { mapInstanceId: row.map_instance_id, mapExecutionId: row.id, runId, priorExecutionId: plan.priorExecutionId ?? null, crossRevision: Boolean(plan.crossRevision), generation: row.generation, specificationId: row.subject_id, state: row.state, pauseReason: row.pause_reason,
      failedVerificationCycles: row.failed_cycles, maxFailedVerificationCycles: row.max_failed_cycles, maxTaskAttempts: row.max_task_attempts,
      progress: { accepted: count('accepted'), total: items.length, waiting: count('waiting') + count('stale'), running: count('running') + count('awaiting_review'), blocked: count('blocked') }, tasks: items };
    assertValid('map.schema.json', 'navigator', body, 'Map navigator');
    return body;
  };
}
