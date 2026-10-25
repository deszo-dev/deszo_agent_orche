import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalHash, compareText, sha256 } from './canonical.mjs';
import { assertValid, check, SCHEMAS } from './schemas.mjs';
import { nowIso } from './store.mjs';
import { UtilityError, jsonValue, ref, textValue } from './utilities.mjs';
import { enclosingLoops, parseInstance } from './planning.mjs';
import { scopeMatches } from './map.mjs';
import { deriveSourceFacts, evaluateCandidateFloors, selectExecutionPlan } from './taskAssessment.mjs';
import { buildContextPackage, computeCompatibilityFingerprint, evaluateAcceptanceRecord, handleContextNeededRequest, handleReviewOutcomeInLoop } from './contextPackage.mjs';
import { deliveryManifestDigest, executeBranchDelivery } from './branchDelivery.mjs';
import { afterBarrierWork } from './custody.mjs';

const ACTIVE = new Set(['running', 'paused']);
const pending = new Set(['scheduled', 'waiting']);
const validPath = path => typeof path === 'string' && path.length > 0 && !path.includes('\\') && !/[:\x00-\x1f]/.test(path)
  && !path.startsWith('/') && !path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || part === '.deszo-context');
const digestEntries = entries => canonicalHash(entries.map(entry => ({ path: entry.path, digest: entry.artifact.sha256 })).sort((a, b) => compareText(a.path, b.path)));
const criteriaOf = assessment => assessment.requirements.flatMap(requirement => requirement.acceptanceCriteria.map(criterion => ({ ...criterion, requirementRef: requirement.id })));
const matches = (path, patterns) => patterns.some(pattern => scopeMatches(path, pattern));
const incomplete = message => { throw new UtilityError('input_unavailable', message); };

function sourceSnapshot(store, directory, excluded) {
  const entries = [];
  const visit = (dir, prefix) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (path === '.deszo-context' || matches(path, excluded) || (item.isDirectory() && matches(`${path}/placeholder`, excluded))) continue;
      if (!validPath(path) || item.isSymbolicLink()) incomplete(`Unsupported source path or symbolic link: ${path}.`);
      if (item.isDirectory()) visit(join(dir, item.name), path);
      else if (item.isFile()) {
        const bytes = readFileSync(join(dir, item.name));
        if (bytes.length > 16 * 1024 * 1024) incomplete(`Source file ${path} exceeds the supported 16 MiB limit.`);
        entries.push({ path, byteSize: bytes.length, mediaType: 'application/octet-stream', artifact: ref(store.putBytes(bytes, 'application/octet-stream')) });
      } else incomplete(`Unsupported source file type: ${path}.`);
    }
  };
  visit(directory, '');
  return entries.sort((a, b) => compareText(a.path, b.path));
}

function stageQueue(plan, config) {
  const queue = [];
  if (plan.selectedStages.includes('readiness_review')) queue.push({ phase: 'readiness-code', role: 'codeReviewer' }, { phase: 'readiness-tests', role: 'testReviewer' });
  if (plan.selectedStages.includes('prepare') && config.scope.tests.length) queue.push({ phase: 'write-tests', role: 'testAuthor' }, { phase: 'review-test-source', role: 'testReviewer' });
  queue.push({ phase: 'implement', role: 'developer' });
  if (config.scope.documentation.length) queue.push({ phase: 'documentation', role: 'juniorAnalyst' });
  queue.push({ phase: 'assemble' });
  config.checks.forEach((_, index) => queue.push({ phase: `check-${index}`, check: index }));
  queue.push({ phase: 'review-code', role: 'codeReviewer' }, { phase: 'review-tests', role: 'testReviewer' },
    { phase: 'accept', role: plan.independentAcceptance ? 'businessAccepter' : 'analyst' });
  if (config.delivery.boundary === 'verified_branch') queue.push({ phase: 'deliver' });
  return queue;
}

export function installTaskRuntime(Engine, { ApiError }) {
  const P = Engine.prototype;
  P.taskState = function taskState(state) { return state.managedTasks ||= { executions: new Map(), steps: new Map(), commands: new Set() }; };
  P.managedTask = function managedTask(state, id) {
    const cache = this.taskState(state).executions;
    if (!cache.has(id)) {
      const row = this.store.get('SELECT * FROM managed_tasks WHERE id=? AND run_id=?', id, state.id);
      if (!row) incomplete('Managed task execution not found.');
      cache.set(id, { row, data: this.store.readJson(row.state_artifact_id) });
    }
    return cache.get(id);
  };
  P.saveManagedTask = function saveManagedTask(execution, events = null, kind = 'state') {
    const artifact = this.store.putJson(execution.data);
    this.store.run('UPDATE managed_tasks SET state=?,state_artifact_id=?,updated_at=? WHERE id=?', execution.row.state, artifact.artifactId, nowIso(), execution.row.id);
    const event = { type: 'task.recorded', nodeInstanceId: execution.row.node_instance_id, attemptId: execution.row.attempt_id, payload: { kind, record: ref(artifact) } };
    if (events) events.push(event); else this.store.appendEvents(execution.row.run_id, [event]);
  };
  P.taskRemainingMs = function taskRemainingMs(execution) { return execution.data.config.bounds.maxElapsedSeconds * 1000 - (Date.now() - Date.parse(execution.data.startedAt)); };
  P.taskWorkSummary = function taskWorkSummary(execution) {
    const { lastWorkEnd, openWork, ...row } = this.store.get("SELECT COALESCE(SUM(attempt_cost),0) AS attempts,COALESCE(SUM(launched_at IS NOT NULL),0) AS processes,COALESCE(SUM(output_bytes),0) AS outputBytes,COALESCE(SUM(duration_ms),0) AS processMilliseconds,MAX(ended_at) AS lastWorkEnd,COALESCE(SUM(ended_at IS NULL),0) AS openWork FROM task_work WHERE task_execution_id=?", execution.row.id);
    const terminal = !ACTIVE.has(execution.row.state), parentEnd = terminal ? this.store.get('SELECT ended_at FROM attempts WHERE id=?', execution.row.attempt_id)?.ended_at : null;
    const observedEnd = terminal && !openWork && parentEnd ? Math.max(Date.parse(parentEnd), Date.parse(lastWorkEnd || parentEnd)) : Date.now();
    const elapsedMilliseconds = Math.max(0, observedEnd - Date.parse(execution.data.startedAt));
    return { ...row, elapsedMilliseconds, elapsedBasis: execution.row.state === 'interrupted' ? 'recovery_upper_bound' : terminal && !openWork ? 'terminal_observation' : 'live_wall_clock', remainingMilliseconds: Math.max(0, execution.data.config.bounds.maxElapsedSeconds * 1000 - elapsedMilliseconds), repairs: execution.data.repairs };
  };
  P.reserveTaskWork = function reserveTaskWork(execution, attempt, category, cost = 1) {
    const work = this.taskWorkSummary(execution);
    if (this.taskRemainingMs(execution) <= 0 || work.attempts + cost > execution.data.config.bounds.maxAttempts) {
      execution.data.incompleteReason = 'aggregate_budget_exhausted'; this.saveManagedTask(execution, null, 'budget');
      incomplete('The aggregate task attempt or elapsed-time limit is exhausted. Preparation, context turns, checks and delivery share this limit.');
    }
    const id = randomUUID();
    this.store.run('INSERT INTO task_work(id,task_execution_id,attempt_id,category,attempt_cost,started_at) VALUES(?,?,?,?,?,?)', id, execution.row.id, attempt.id, category, cost, nowIso());
    return id;
  };
  P.finishTaskWork = function finishTaskWork(workId, evidence = null, outputBytes = 0) {
    if (!workId) return;
    const row = this.store.get('SELECT * FROM task_work WHERE id=?', workId);
    if (!row || row.ended_at) return;
    this.store.run('UPDATE task_work SET ended_at=?,duration_ms=?,output_bytes=?,evidence_artifact_id=? WHERE id=?', nowIso(), Math.max(0, Date.now() - Date.parse(row.started_at)), Number.isFinite(outputBytes) ? outputBytes : 0, evidence?.artifactId || null, workId);
  };
  P.markTaskWorkLaunched = function markTaskWorkLaunched(workId) { if (workId) this.store.run('UPDATE task_work SET launched_at=? WHERE id=? AND launched_at IS NULL', nowIso(), workId); };
  P.isManagedTaskStep = function isManagedTaskStep(state, instance) { const task = this.taskState(state); return task.steps.has(instance) || task.commands.has(instance); };
  P.managedTaskReadiness = function managedTaskReadiness(state, attempt) {
    const info = this.taskState(state).steps.get(attempt.node_instance_id);
    if (!info || !pending.has(attempt.state) || this.processes.has(attempt.id)) return null;
    const execution = this.managedTask(state, info.executionId);
    if (execution.row.state !== 'running' || execution.data.current?.attemptId !== attempt.id) return null;
    return { action: 'task-step', info };
  };

  P.startManagedTask = function startManagedTask(state, scope, node, attempt) {
    try {
      if (this.store.get('SELECT 1 FROM managed_tasks WHERE run_id=? AND node_instance_id=?', state.id, attempt.node_instance_id)) incomplete('A managed task instance cannot be restarted with a new budget in the same run. Recover its current step or start a newly captured run.');
      const request = this.inputValue(state, scope, node.id, 'request'), source = this.inputValue(state, scope, node.id, 'source');
      const entries = this.values.readManifest(source.artifact).entries;
      if (entries.some(entry => !validPath(entry.path) || matches(entry.path, node.config.scope.excludedOutputs))) incomplete('The immutable source contains unsupported paths or paths hidden by excluded outputs.');
      const id = randomUUID(), startedAt = nowIso();
      const execution = { row: { id, run_id: state.id, node_instance_id: attempt.node_instance_id, attempt_id: attempt.id, state: 'running' }, data: {
        config: node.config, request: this.store.readText(request.artifact.artifactId), requestRef: request.artifact, sourceRef: source.artifact,
        sourceSnapshotHash: digestEntries(entries), baseEntries: entries, entries, startedAt, sequence: 0, commandSeq: 0, repairs: 0, discoveryTurns: 0,
        assessment: null, plan: null, queue: [], current: null, evidenceIds: [], acceptanceIds: [], feedback: [], baseModes: {}, delivery: null,
      } };
      this.store.transaction(() => {
        const initial = this.store.putJson(execution.data);
        this.store.run('INSERT INTO managed_tasks(id,run_id,node_instance_id,attempt_id,state,state_artifact_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', id, state.id, attempt.node_instance_id, attempt.id, 'running', initial.artifactId, startedAt, startedAt);
        const events = [this.commitInputs(state, attempt, { request, source }), ...this.attemptTransition(attempt, 'running', 'Managed task started under the ordinary scheduler.')];
        this.taskState(state).executions.set(id, execution);
        execution.data.queue = [...(node.config.delivery.boundary === 'verified_branch' ? [{ phase: 'assert-source' }] : []), { phase: 'define', role: 'analyst' }, { phase: 'confirm-plan', role: 'codeReviewer' }, { phase: 'plan' }];
        this.scheduleManagedStep(state, execution, events);
        this.saveManagedTask(execution, events);
        this.store.appendEvents(state.id, events);
      });
    } catch (error) { this.failAttempt(state, attempt, 'input_unavailable', error.message); }
  };
  P.scheduleManagedStep = function scheduleManagedStep(state, execution, events) {
    const step = execution.data.queue.shift();
    if (!step) return;
    const sequence = ++execution.data.sequence;
    const instance = `${execution.row.node_instance_id}/${sequence}/${step.phase}`;
    const attemptId = this.planAttempt(state, instance, step.phase, step.role ? 'agent' : 'task-utility', null, events);
    execution.data.current = { ...step, instance, attemptId, contextTurns: 1, extraPaths: [], result: null };
    this.taskState(state).steps.set(instance, { executionId: execution.row.id });
  };
  P.pauseManagedTask = function pauseManagedTask(state, execution, reason) {
    execution.row.state = 'paused'; execution.data.incompleteReason = reason;
    const parent = this.store.get('SELECT * FROM attempts WHERE id=?', execution.row.attempt_id);
    this.store.transaction(() => {
      const events = this.attemptTransition(parent, 'waiting', reason);
      this.saveManagedTask(execution, events, 'incomplete'); this.store.appendEvents(state.id, events);
    });
  };
  P.dispatchManagedTaskStep = function dispatchManagedTaskStep(state, attempt, info) {
    const execution = this.managedTask(state, info.executionId), step = execution.data.current;
    const scope = this.scopeFor(state, parseInstance(execution.row.node_instance_id).prefix);
    try {
      if (!step.role) { this.runManagedTaskUtility(state, execution, attempt); return; }
      const spec = this.managedTaskAgentSpec(state, execution, scope);
      const role = execution.data.config.roles[step.role];
      const node = { id: step.phase, type: 'agent', config: { provider: role.provider, model: role.model, effort: role.effort,
        timeoutSeconds: Math.max(5, Math.min(role.timeoutSeconds, Math.ceil(this.taskRemainingMs(execution) / 1000))), output: { format: 'json', schema: spec.schema } } };
      this.tryDispatchAgent(state, scope, node, attempt, spec);
    } catch (error) { this.failAttempt(state, attempt, 'input_unavailable', error.message); }
  };
  P.managedTaskDirectory = function managedTaskDirectory(execution, suffix) { return join(this.store.workdirs, 'managed-tasks', execution.row.id, suffix); };
  P.writeManagedSource = function writeManagedSource(execution, dir) {
    mkdirSync(dir, { recursive: true });
    // Directories are always new per logical step; a continued context only adds its reserved context files.
    for (const entry of execution.data.entries) {
      const path = join(dir, ...entry.path.split('/')); mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, this.store.readBytes(entry.artifact.artifactId).bytes);
    }
  };
  P.managedTaskAgentSpec = function managedTaskAgentSpec(state, execution, scope) {
    const data = execution.data, step = data.current, role = data.config.roles[step.role];
    const dir = this.managedTaskDirectory(execution, `step-${data.sequence}${step.contextEpoch ? `-fresh-${step.contextEpoch}` : ''}`);
    if (!existsSync(dir)) this.writeManagedSource(execution, dir);
    const workspace = { ...this.workspaceOf(state), cwd: dir, cwd_identity: sha256(Buffer.from(process.platform === 'win32' ? dir.toLowerCase() : dir)) };
    const key = step.instance;
    let mapping = this.store.get('SELECT * FROM run_context_bindings WHERE run_id=? AND context_node_id=?', state.id, key);
    if (!mapping) {
      const binding = this.createBinding(state.id, workspace, role.provider, key);
      this.store.run('INSERT INTO run_context_bindings(run_id,context_node_id,mode,binding_id) VALUES(?,?,?,?)', state.id, key, 'new', binding);
      mapping = this.store.get('SELECT * FROM run_context_bindings WHERE run_id=? AND context_node_id=?', state.id, key);
    }
    const candidateDigest = digestEntries(data.entries), subjectId = `SUBJ-${candidateDigest.slice(0, 16).toUpperCase()}`;
    const normative = [{ ref: 'business-request', digest: data.requestRef.sha256 }, { ref: 'policy', digest: canonicalHash(data.config) }];
    if (data.assessment) normative.push({ ref: 'assessment', digest: canonicalHash(data.assessment) });
    if (data.plan) normative.push({ ref: 'execution-plan', digest: data.plan.planFingerprint });
    if (data.feedback.length) normative.push({ ref: 'feedback', digest: canonicalHash(data.feedback) });
    for (const [path, artifact] of Object.entries(step.evidenceExpansions || {})) normative.push({ ref: path, digest: artifact.sha256 });
    let selected = data.entries;
    if (!['analyst', 'businessAccepter'].includes(step.role)) {
      const roots = data.assessment?.scope.affectedComponents || [];
      const patterns = step.role === 'juniorAnalyst' ? data.config.scope.documentation : step.role === 'testAuthor' || step.role === 'testReviewer' ? [...data.config.scope.tests, ...roots] : [...data.config.scope.production, ...roots];
      selected = data.entries.filter(entry => matches(entry.path, patterns) || step.extraPaths.includes(entry.path));
    }
    const pkg = buildContextPackage({ role: step.role, taskBinding: execution.row.id, subjectDigest: candidateDigest, stepInstanceId: step.instance,
      isFreshContext: step.contextTurns === 1, declaredScope: selected.map(entry => entry.path), normativeContent: normative,
      sourceFiles: selected.map(entry => ({ path: entry.path, digest: entry.artifact.sha256, changeKind: data.baseEntries.some(base => base.path === entry.path && base.artifact.sha256 === entry.artifact.sha256) ? 'unchanged' : 'modified' })),
      evidenceAndIssues: this.taskEvidenceRecords(execution).map(item => ({ ref: item.id, digest: item.digest })) });
    step.package = pkg;
    step.compatibilityFingerprint = computeCompatibilityFingerprint({ version: 2, subjectHash: candidateDigest, scope: selected.map(entry => entry.path), role: step.role,
      provider: role.provider, model: role.model, effort: role.effort, promptInstructions: step.phase, contextPackage: pkg });
    const contextDir = join(dir, '.deszo-context'); mkdirSync(contextDir, { recursive: true });
    const evidenceAssets = this.managedEvidenceAssets(execution);
    for (const asset of evidenceAssets.initial) {
      const path = join(contextDir, ...asset.path.split('/')); mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, asset.bytes);
    }
    for (const [path, artifact] of Object.entries(step.evidenceExpansions || {})) {
      const target = join(contextDir, 'evidence', ...path.split(':').slice(1)); mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, this.store.readBytes(artifact.artifactId).bytes);
    }
    writeFileSync(join(contextDir, 'package.json'), JSON.stringify(pkg, null, 2));
    const input = { phase: step.phase, role: step.role, runId: state.id, taskExecutionId: execution.row.id, sourceSnapshotHash: data.sourceSnapshotHash,
      businessRequestId: `BUS-${data.requestRef.sha256.slice(0, 16)}`, request: data.request, assessment: data.assessment, plan: data.plan,
      subjectId, candidateDigest, criteria: data.assessment ? criteriaOf(data.assessment) : [], evidence: this.taskEvidenceRecords(execution), feedback: data.feedback,
      configuredChecks: data.config.checks, evidenceProducers: ['testRunner', 'codeReviewer', 'testReviewer', 'analyst', ...(data.config.roles.businessAccepter ? ['businessAccepter'] : [])],
      declaredScope: data.config.scope, packagePath: '.deszo-context/package.json', evidenceCatalog: evidenceAssets.catalog, expandedPaths: step.extraPaths };
    writeFileSync(join(contextDir, 'input.json'), JSON.stringify(input, null, 2));
    const schema = structuredClone(SCHEMAS['managed-task.schema.json'].$defs.turn);
    schema.properties.assessment.anyOf[0] = structuredClone(SCHEMAS['task-assessment.schema.json']);
    delete schema.properties.assessment.anyOf[0].$id; delete schema.properties.assessment.anyOf[0].$schema;
    const instructions = step.phase === 'define' || step.phase === 'discovery'
      ? 'Return the bounded TaskAssessment in assessment. Pin the engine identities from the input. State unresolved questions, constraints, criteria, supported evidence producers and affected paths. Preserve every criterion ID named by configuredChecks; additional business criteria need a supported observation producer. Discovery must resolve the named unknowns; never silently omit them.'
      : ['write-tests', 'implement', 'documentation'].includes(step.phase)
        ? `Edit only the declared ${step.phase === 'write-tests' ? 'tests' : step.phase === 'documentation' ? 'documentation' : 'production'} scope. Preserve all other source. The Junior Analyst only repairs wording/formatting without changing requirements. Return COMPLETED with null assessment/review.`
        : step.phase === 'triage'
          ? 'Classify the captured failing check in triage as implementation, tests, requirements, environment or unknown, with evidence-backed reason. Do not edit source. Unavailable information is REVIEW_INCOMPLETE. Never infer a source defect from a timeout or missing evidence.'
          : `Return the independent review in review, with APPROVED or CHANGES_REQUESTED, a reason and criterion statuses. ${['confirm-plan', 'readiness-code', 'readiness-tests', 'review-test-source'].includes(step.phase) ? 'This is a readiness/design review before implementation: APPROVED means the assessment or test design is ready. Business outcomes may remain unverified and behavioral tests may be expected to fail at this stage.' : 'Evaluate the original business outcome against the exact assembled source and complete engine evidence.'} Do not edit source or invent check records. Missing information is CONTEXT_NEEDED or REVIEW_INCOMPLETE, never a fake source defect.`;
    const prompt = `Managed task: ${step.phase}. ${instructions}\nRead .deszo-context/input.json and .deszo-context/package.json. Return one JSON envelope; no duplicate prose summary.\nMANAGED_TASK_INPUT_BEGIN\n${JSON.stringify(input)}\nMANAGED_TASK_INPUT_END`;
    const values = { prompt: textValue(this.store.putText(prompt)) };
    this.saveManagedTask(execution, null, 'context-package');
    return { workspace, mapping, taskExecutionId: execution.row.id, schema, values: () => values,
      check: parsed => parsed.status === 'COMPLETED' && ['define', 'discovery'].includes(step.phase) && !parsed.assessment ? 'The Analyst must return a TaskAssessment.'
        : parsed.status === 'COMPLETED' && step.phase === 'triage' && !parsed.triage ? 'Check triage must return an evidence-backed classification.'
        : parsed.status === 'COMPLETED' && !['define', 'discovery', 'write-tests', 'implement', 'documentation', 'triage'].includes(step.phase) && !parsed.review ? 'A reviewer must return a review.' : null,
      commit: (parsed, events) => { step.result = parsed; step.directory = dir; this.saveManagedTask(execution, events, 'agent-result'); } };
  };

  // Context contains bounded previews plus exact chunk descriptors. Full logs stay in immutable storage;
  // a one-shot CLI can request an individual evidence chunk and resume without another repair cycle.
  P.managedEvidenceAssets = function managedEvidenceAssets(execution) {
    const refs = new Map();
    for (const row of this.store.all('SELECT id,content_artifact_id FROM task_evidence WHERE task_execution_id=? AND plan_revision_id=?', execution.row.id, execution.data.plan?.planRevisionId || '')) if (execution.data.evidenceIds.includes(row.id)) refs.set(row.content_artifact_id, row.id);
    for (const item of execution.data.feedback) if (item?.evidence?.artifactId) refs.set(item.evidence.artifactId, `feedback:${item.phase}`);
    const catalog = [], initial = [], expandable = new Map();
    for (const [id, recordId] of refs) {
      const content = this.store.readJson(id), path = `evidence/${id}.json`;
      initial.push({ path, bytes: Buffer.from(JSON.stringify(content, null, 2)) });
      const entry = { recordId, artifactId: id, path: `.deszo-context/${path}`, kind: content.kind || 'ReviewObservation', streams: {} };
      if (content.kind === 'ExecutionEvidence') for (const name of ['stdout', 'stderr']) {
        const manifest = this.store.readJson(content.streams[name].artifactId);
        let remaining = 64 * 1024; const tail = [];
        for (const chunk of [...manifest.chunks].reverse()) { if (remaining <= 0) break; const bytes = this.store.readBytes(chunk.artifact.artifactId).bytes.subarray(-remaining); tail.unshift(bytes); remaining -= bytes.length; }
        const previewPath = `evidence/${id}/${name}/tail.txt`;
        initial.push({ path: previewPath, bytes: Buffer.concat(tail) });
        entry.streams[name] = { integrity: manifest.integrity, byteSize: manifest.committedBytes, previewPath: `.deszo-context/${previewPath}`, previewTruncated: manifest.committedBytes > 64 * 1024,
          chunks: manifest.chunks.map(chunk => { const requestPath = `evidence:${id}:${name}:${chunk.index}`; expandable.set(requestPath, chunk.artifact); return { requestPath, byteOffset: chunk.byteOffset, byteLength: chunk.byteLength, digest: chunk.artifact.sha256 }; }) };
      }
      catalog.push(entry);
    }
    return { catalog, initial, expandable };
  };

  P.taskEvidenceRecords = function taskEvidenceRecords(execution) {
    return this.store.all('SELECT id,record_artifact_id FROM task_evidence WHERE task_execution_id=? AND plan_revision_id=? ORDER BY created_at,id', execution.row.id, execution.data.plan?.planRevisionId || '')
      .filter(row => execution.data.evidenceIds.includes(row.id)).map(row => this.store.readJson(row.record_artifact_id)).filter(record => record.candidateDigest === digestEntries(execution.data.entries));
  };
  P.addTaskEvidence = function addTaskEvidence(execution, attempt, content, kind, appliesToCriteria, boundary = 'candidate', outcome = kind === 'check' ? 'passed' : 'recorded') {
    const artifact = content.artifactId ? content : ref(this.store.putJson(content));
    const digest = artifact.sha256, candidateDigest = digestEntries(execution.data.entries);
    const record = { id: randomUUID(), kind, digest, subjectId: `SUBJ-${candidateDigest.slice(0, 16).toUpperCase()}`, candidateDigest, boundary,
      source: 'engine', outcome, appliesToCriteria, recordedAt: nowIso() };
    const stored = this.store.putJson(record);
    this.store.run('INSERT INTO task_evidence(id,task_execution_id,plan_revision_id,producer,attempt_id,record_artifact_id,content_artifact_id,created_at) VALUES(?,?,?,?,?,?,?,?)', record.id, execution.row.id, execution.data.plan.planRevisionId, kind === 'check' ? 'testRunner' : kind === 'commit' ? 'engine' : execution.data.current.role, attempt.id, stored.artifactId, artifact.artifactId, nowIso());
    execution.data.evidenceIds.push(record.id);
    return record;
  };
  P.taskEvidenceForCriterion = function taskEvidenceForCriterion(execution, criterion) {
    const producers = criterion.evidenceProducer === 'analyst' && execution.data.plan.independentAcceptance ? ['businessAccepter'] : [criterion.evidenceProducer];
    const selected = new Set(this.store.all('SELECT id,producer FROM task_evidence WHERE task_execution_id=? AND plan_revision_id=?', execution.row.id, execution.data.plan.planRevisionId).filter(row => producers.includes(row.producer)).map(row => row.id));
    return this.taskEvidenceRecords(execution).filter(record => selected.has(record.id) && record.appliesToCriteria.includes(criterion.id));
  };
  P.resolveTaskEvidence = function resolveTaskEvidence(execution, reference) {
    if (!execution.data.evidenceIds.includes(reference.id)) return null;
    const row = this.store.get('SELECT * FROM task_evidence WHERE id=? AND task_execution_id=? AND plan_revision_id=?', reference.id, execution.row.id, execution.data.plan.planRevisionId);
    if (!row) return null;
    const record = this.store.readJson(row.record_artifact_id);
    const bytes = this.store.readBytes(row.content_artifact_id);
    if (record.digest !== bytes.row.sha256) return null;
    return record;
  };

  P.runManagedTaskUtility = function runManagedTaskUtility(state, execution, attempt) {
    // A delivery writes into the source repository: it fetches the verified commit there and updates the target ref. While a Host-owned
    // process may still run in an overlapping workspace (Process Custody), the delivery waits for its owner to confirm the end. The other
    // utilities only read the repository's committed objects or work in their own directories.
    const deliveryCwd = execution.data.current.phase === 'deliver' ? this.workspaceOf(state).cwd : null;
    if (deliveryCwd && (this.custodyHoldOverlapping(deliveryCwd) || this.custodyLaunchOverlapping(deliveryCwd) || this.unconfirmedOverlapping(deliveryCwd))) {
      if (attempt.state === 'scheduled') this.store.appendEvents(state.id, this.attemptTransition(attempt, 'waiting', 'Waiting for a Host-owned process to end in this workspace; its owner has not yet confirmed that it has.'));
      return;
    }
    const keys = deliveryCwd ? [`delivery:${this.workspaceOf(state).cwd_identity}:${execution.data.config.delivery.targetBranchRef}`] : [];
    if (keys.some(key => this.locks.has(key))) {
      if (attempt.state === 'scheduled') this.store.appendEvents(state.id, this.attemptTransition(attempt, 'waiting', 'Waiting for the repository/ref delivery lock.'));
      return;
    }
    for (const key of keys) { this.locks.add(key); this.store.run('INSERT INTO resource_locks(resource_key,run_id,attempt_id,acquired_at) VALUES(?,?,?,?)', key, state.id, attempt.id, nowIso()); }
    const controller = new AbortController();
    const record = { runId: state.id, taskExecutionId: execution.row.id, loops: enclosingLoops(parseInstance(execution.row.node_instance_id).prefix).map(item => item.loopInstance), keys, child: null, launched: false, stopRequested: false, abortController: controller, deliveryCwd };
    this.processes.set(attempt.id, record);
    record.exited = new Promise(done => { record.resolveExit = done; });
    this.store.appendEvents(state.id, [...this.attemptTransition(attempt, 'running', 'Managed task utility started.'), this.commitInputs(state, attempt, {})]);
    // A delivery's claim is held by the admission above until its work starts (the barrier is inert outside tests).
    afterBarrierWork(this.testBarrier, 'delivery-claimed', { runId: state.id, phase: execution.data.current.phase, workspaceCwd: this.workspaceOf(state).cwd },
      () => this.executeManagedTaskUtility(state, execution, attempt, controller.signal)).then(() => {
      if (controller.signal.aborted || record.stopRequested || this.runState(state.id) === 'stopping') {
        const current = this.store.get('SELECT * FROM attempts WHERE id=?', attempt.id);
        if (current.state === 'running') this.store.appendEvents(state.id, this.attemptTransition(current, 'canceled', 'Managed utility stopped.'));
        this.saveManagedTask(execution);
        return;
      }
      this.store.appendEvents(state.id, this.attemptTransition(attempt, 'succeeded', 'Managed task utility completed.'));
    }).catch(error => {
      if (this.runState(state.id) === 'stopping' || controller.signal.aborted) {
        const current = this.store.get('SELECT * FROM attempts WHERE id=?', attempt.id);
        if (current.state === 'running') this.store.appendEvents(state.id, this.attemptTransition(current, 'canceled', 'Managed utility stopped.'));
        this.saveManagedTask(execution);
        return;
      }
      this.failAttempt(state, attempt, 'input_unavailable', error.message);
    }).finally(() => { for (const key of keys) { this.locks.delete(key); this.store.run('DELETE FROM resource_locks WHERE resource_key=?', key); } this.processes.delete(attempt.id); record.resolveExit(); this.pump(); });
  };
  P.executeManagedTaskUtility = async function executeManagedTaskUtility(state, execution, attempt, signal) {
    const data = execution.data, step = data.current;
    const run = (command, args, options = {}) => this.runTaskCommand(state, execution, attempt, command, args, { signal, ...options });
    if (step.phase === 'assert-source') {
      const config = data.config.delivery, repo = this.workspaceOf(state).cwd;
      const tree = await run('git', ['ls-tree', '-rz', '--full-tree', config.baseCommit], { cwd: repo });
      if (tree.error || tree.truncated || tree.status !== 0) incomplete('The declared Git base could not be inspected completely.');
      const manifest = tree.stdout.split('\0').filter(Boolean).map(line => { const [meta, path] = line.split('\t'); const [mode, type, oid] = meta.split(' '); return { path, mode, type, oid }; });
      const source = new Map(data.baseEntries.map(entry => [entry.path, entry]));
      if (manifest.length !== source.size || manifest.some(entry => !validPath(entry.path) || !['100644', '100755'].includes(entry.mode) || entry.type !== 'blob' || !source.has(entry.path))) incomplete('Verified branch delivery requires the complete regular-file Git base, with no extra/uncommitted inputs. Recapture the source snapshot against the declared base.');
      for (const entry of manifest) {
        const blob = await run('git', ['cat-file', 'blob', entry.oid], { cwd: repo, encoding: 'buffer' });
        if (blob.status !== 0 || blob.truncated || sha256(blob.stdout) !== source.get(entry.path).artifact.sha256) incomplete(`Captured source ${entry.path} differs from its declared Git base.`);
        data.baseModes[entry.path] = entry.mode;
      }
    } else if (step.phase === 'plan') {
      const assessment = data.assessment;
      if (!assessment) incomplete('No engine-captured assessment exists.');
      const bindings = Object.fromEntries(Object.entries(data.config.roles).map(([key, value]) => [key, Object.fromEntries(['role', 'provider', 'model', 'effort'].map(field => [field, value[field]]))]));
      const policy = { ...data.config.projectPolicy, requiresTests: data.config.scope.tests.length > 0 };
      const facts = deriveSourceFacts(assessment.scope.affectedComponents, policy);
      const plan = selectExecutionPlan({ assessment, sourceFacts: facts, projectPolicy: policy, roleBindings: bindings, deliveryBoundary: data.config.delivery.boundary,
        aggregateBounds: data.config.bounds, checks: data.config.checks.map(({ criteria, ...spec }) => ({ ...spec, source: 'candidate' })), reviewerConfirmation: data.confirmation });
      plan.executionRunId = state.id; plan.planRevisionId = `REV-${randomUUID()}`; plan.planId = data.plan?.planId || plan.planId;
      this.bindManagedPlan(state, execution, plan);
      const work = this.taskWorkSummary(execution); plan.aggregateBounds.consumedAttempts = work.attempts; plan.aggregateBounds.consumedElapsedSeconds = Math.ceil(work.elapsedMilliseconds / 1000);
      this.store.recordExecutionPlan(plan, assessment.assessmentId);
      data.plan = plan; data.evidenceIds = []; data.acceptanceIds = [];
      const unknowns = assessment.assessmentAxes.uncertainty === 'high' || assessment.assessmentAxes.verifiability === 'unverified' || assessment.grounds.unresolvedQuestions.length;
      if (unknowns) {
        if (data.discoveryTurns >= data.config.bounds.maxDiscoveryTurns) incomplete('Bounded discovery is exhausted. Requirements remain unverified or materially uncertain.');
        data.discoveryTurns++;
        data.queue = [{ phase: 'discovery', role: 'analyst' }, { phase: 'confirm-plan', role: 'codeReviewer' }, { phase: 'plan' }];
      } else data.queue = stageQueue(plan, data.config);
    } else if (step.phase === 'assemble') {
      const base = new Map(data.baseEntries.map(entry => [entry.path, entry.artifact.sha256]));
      const current = new Map(data.entries.map(entry => [entry.path, entry.artifact.sha256]));
      const changed = [...new Set([...base.keys(), ...current.keys()])].filter(path => base.get(path) !== current.get(path));
      const checkResult = evaluateCandidateFloors(data.plan, changed, data.config.projectPolicy);
      data.floorEvaluation = { status: checkResult.status, planRevisionId: data.plan.planRevisionId, candidateDigest: digestEntries(data.entries), sourceSnapshotHash: data.sourceSnapshotHash, changedPaths: changed.sort(), exceededPaths: checkResult.exceededPaths, evaluatedAt: checkResult.evaluatedAt || nowIso() };
      (data.floorEvaluations ||= []).push(data.floorEvaluation);
      if (checkResult.status === 'escalated') {
        data.plan = checkResult.escalationPlan;
        this.bindManagedPlan(state, execution, data.plan);
        this.store.recordExecutionPlan(data.plan, data.assessment.assessmentId);
        data.feedback.push('Actual candidate changes raised the risk floor. Re-run the missing preparation and all affected reviews under this revision.');
        data.queue = stageQueue(data.plan, data.config); data.evidenceIds = [];
      }
      data.candidate = this.values.putSet(data.entries);
    } else if (step.phase.startsWith('check-')) {
      const spec = data.config.checks[step.check];
      const criteria = new Set(criteriaOf(data.assessment).map(item => item.id));
      if (spec.criteria.some(id => !criteria.has(id))) incomplete(`Check ${spec.id} names an unknown acceptance criterion.`);
      const dir = this.managedTaskDirectory(execution, `check-${data.sequence}-attempt-${attempt.ordinal}`); this.writeManagedSource(execution, dir);
      const before = digestEntries(data.entries);
      const result = await run(spec.command, spec.args, { cwd: dir, timeoutMs: spec.timeoutMs, category: 'verification', attemptCost: 1, checkId: spec.id, expectedExitCode: spec.expectedExitCode });
      if (result.aborted) return;
      if (result.error || result.timedOut || !result.captureComplete || result.status === null) incomplete(`Check ${spec.id} did not produce complete engine evidence. An operational failure cannot be treated as a source defect.`);
      if (result.status !== spec.expectedExitCode) {
        data.feedback.push({ phase: step.phase, checkId: spec.id, exitCode: result.status, evidence: result.evidence, reason: 'Complete engine check failed; triage is required before repair.' });
        data.queue = [{ phase: 'triage', role: 'analyst' }];
        this.saveManagedTask(execution, null, 'check-failed'); return;
      }
      const after = sourceSnapshot(this.store, dir, data.config.scope.excludedOutputs);
      if (digestEntries(after) !== before) incomplete(`Check ${spec.id} mutated the approved source; a new candidate and affected reviews are required.`);
      this.addTaskEvidence(execution, attempt, result.evidence, 'check', spec.criteria);
    } else if (step.phase === 'deliver') {
      const work = this.reserveTaskWork(execution, attempt, 'branch-delivery', 1);
      try {
        const source = this.workspaceOf(state).cwd, config = data.config.delivery;
        const entries = data.entries.map(entry => ({ path: entry.path, content: this.store.readBytes(entry.artifact.artifactId).bytes, mode: data.baseModes[entry.path] || '100644' }));
        const paths = new Set(entries.map(entry => entry.path));
        for (const entry of data.baseEntries) if (!paths.has(entry.path)) entries.push({ path: entry.path, content: null, operation: 'delete', mode: data.baseModes[entry.path] || '100644' });
        const plan = { schemaVersion: 1, kind: 'DeliveryPlan', deliveryPlanId: execution.row.id, runId: state.id, manifestVersion: 2,
          candidateDigest: deliveryManifestDigest(entries, 2), repositoryPath: source, baseCommit: config.baseCommit, targetBranchRef: config.targetBranchRef,
          branchExpectedOldValue: config.expectedOldValue, isolation: { mode: 'separate_clone', cloneStrategy: 'reference_dissociate' },
          hookPolicy: { installHooks: config.installHooks === true, hookSource: config.hookSource || null, hooksJournal: config.installHooks ? 'installed' : 'none' },
          verificationChecks: data.config.checks.map(({ criteria, ...value }) => value), commitPolicy: config.commitPolicy,
          boundaryCriteria: [{ id: 'BRANCH-DELIVERY', description: 'Exact source, environment, commit and target ref verified.' }], createdAt: nowIso() };
        const cloneDir = this.managedTaskDirectory(execution, `delivery-${data.sequence}`);
        const result = await executeBranchDelivery({ plan, candidateFiles: entries, cloneDir, signal, processRunner: run,
          onPhase: async (phase, receipt) => {
            const stored = this.store.putJson(receipt);
            if (phase === 'intent') this.store.run('INSERT INTO delivery_operations(id,run_id,task_execution_id,intent_artifact_id,phase,receipt_artifact_id,updated_at) VALUES(?,?,?,?,?,?,?)', plan.deliveryPlanId, state.id, execution.row.id, stored.artifactId, phase, stored.artifactId, nowIso());
            else this.store.run('UPDATE delivery_operations SET phase=?,receipt_artifact_id=?,updated_at=? WHERE id=?', phase, stored.artifactId, nowIso(), plan.deliveryPlanId);
            this.store.appendEvents(state.id, [{ type: 'task.recorded', nodeInstanceId: step.instance, attemptId: attempt.id, payload: { kind: `delivery-${phase}`, record: ref(stored) } }]);
          } });
        data.delivery = result;
        const receipt = this.store.putJson(result);
        this.store.run('UPDATE delivery_operations SET phase=?,receipt_artifact_id=?,updated_at=? WHERE task_execution_id=?', result.status === 'publication_uncertain' || (result.status === 'stopped' && result.refUpdated) ? 'reconciliation_required' : result.readyForMerge ? 'published' : result.status, receipt.artifactId, nowIso(), execution.row.id);
        if (result.status === 'publication_uncertain') { this.store.recordBranchDelivery(result, state.id); incomplete(result.environmentSmokeReport.diagnostics); }
        if (signal.aborted || this.runState(state.id) === 'stopping') return;
        if (!result.readyForMerge) { this.store.recordBranchDelivery(result, state.id); incomplete(result.environmentSmokeReport.diagnostics); }
        const evidence = this.addTaskEvidence(execution, attempt, result, 'commit', ['BRANCH-DELIVERY'], 'verified_branch');
        const prior = this.store.readJson(this.store.get('SELECT record_artifact_id FROM acceptance_records WHERE id=?', data.acceptanceIds.at(-1)).record_artifact_id);
        const acceptance = { ...prior, recordId: `ACC-${randomUUID()}`, deliveryBoundary: 'verified_branch', criteria: [...prior.criteria,
          { criterionId: 'BRANCH-DELIVERY', requirementRef: 'DELIVERY', status: 'satisfied', reason: 'Exact local branch delivery verified by the engine.', evidenceRefs: [{ kind: evidence.kind, id: evidence.id, digest: evidence.digest }] }], evaluatedAt: nowIso() };
        const verdict = evaluateAcceptanceRecord(acceptance, { expectedCriteria: acceptance.criteria.map(item => item.criterionId), expectedBoundary: 'verified_branch',
          criterionBoundaries: Object.fromEntries(prior.criteria.map(item => [item.criterionId, 'candidate'])), expectedSubjectId: prior.subjectId, expectedCandidateDigest: prior.candidateDigest,
          resolveEvidence: reference => this.resolveTaskEvidence(execution, reference) });
        if (!verdict.canOpenGate) incomplete(verdict.reason);
        this.store.recordAcceptanceRecord(acceptance, state.id); data.acceptanceIds.push(acceptance.recordId);
        this.store.recordBranchDelivery(result, state.id);
        this.store.run("UPDATE delivery_operations SET phase='completed',updated_at=? WHERE id=?", nowIso(), plan.deliveryPlanId);
      } finally { this.finishTaskWork(work); }
    }
    this.saveManagedTask(execution);
  };

  P.bindManagedPlan = function bindManagedPlan(state, execution, plan) {
    const run = this.requireRun(state.id), artifact = this.store.artifactRow(run.workflow_snapshot_artifact_id);
    plan.workflowBinding = { snapshot: { artifactId: artifact.id, sha256: artifact.sha256 }, executionHash: run.execution_hash,
      taskNodeId: parseInstance(execution.row.node_instance_id).nodeId, compilerVersion: 1, templateFingerprint: canonicalHash(execution.data.config), steps: stageQueue(plan, execution.data.config) };
    // Layout, attempt and run IDs are provenance only. Scope, every local bound and captured template are semantic.
    const { snapshot, ...semantic } = plan.workflowBinding;
    plan.planFingerprint = canonicalHash({ selectorFingerprint: plan.planFingerprint, workflowBinding: semantic });
  };

  P.consumeManagedAgent = function consumeManagedAgent(state, execution, attempt) {
    const data = execution.data, step = data.current, result = step.result;
    if (!result) incomplete('The managed Agent produced no captured result.');
    if (!['write-tests', 'implement', 'documentation'].includes(step.phase)) {
      if (digestEntries(sourceSnapshot(this.store, step.directory, data.config.scope.excludedOutputs)) !== digestEntries(data.entries)) incomplete(`${step.role} modified a read-only review or assessment workspace. Its result cannot authorize this candidate.`);
    }
    if (result.status !== 'COMPLETED') {
      if (result.status === 'REVIEW_INCOMPLETE') { this.pauseManagedTask(state, execution, `REVIEW_INCOMPLETE: ${result.reason}`); return false; }
      const available = new Map(data.entries.map(entry => [entry.path, this.store.readBytes(entry.artifact.artifactId).bytes.toString('utf8')]));
      const evidenceAssets = this.managedEvidenceAssets(execution);
      for (const path of result.requestedPaths) if (evidenceAssets.expandable.has(path)) available.set(path, this.store.readBytes(evidenceAssets.expandable.get(path).artifactId).bytes.toString('utf8'));
      const widening = handleContextNeededRequest({ request: { paths: result.requestedPaths }, contextPackage: step.package, stepAttempts: step.contextTurns,
        maxStepAttempts: data.config.bounds.maxContextTurns, availableArtifacts: available });
      if (!result.requestedPaths.length || result.requestedPaths.some(path => !validPath(path) && !evidenceAssets.expandable.has(path)) || !widening.resumed) { this.pauseManagedTask(state, execution, `REVIEW_INCOMPLETE: ${widening.reason || 'unsupported_or_empty_context_request'}`); return false; }
      step.evidenceExpansions ||= {};
      for (const path of result.requestedPaths) if (evidenceAssets.expandable.has(path)) step.evidenceExpansions[path] = evidenceAssets.expandable.get(path);
      step.extraPaths = [...new Set([...step.extraPaths, ...result.requestedPaths])]; step.contextTurns++; step.result = null;
      const events = []; step.attemptId = this.planAttempt(state, step.instance, step.phase, 'agent', null, events);
      this.saveManagedTask(execution, events, 'context-expanded'); this.store.appendEvents(state.id, events); return false;
    }
    if (['define', 'discovery'].includes(step.phase)) {
      const assessment = { ...result.assessment, assessmentId: `ASSESS-${randomUUID()}`, assessmentRunId: state.id, authorRole: 'analyst',
        businessRequestId: `BUS-${data.requestRef.sha256.slice(0, 16)}`, sourceSnapshotHash: data.sourceSnapshotHash };
      assertValid('task-assessment.schema.json', null, assessment);
      if (!criteriaOf(assessment).length || new Set(criteriaOf(assessment).map(item => item.id)).size !== criteriaOf(assessment).length) incomplete('Assessment requires a nonempty, uniquely identified acceptance inventory.');
      const producers = new Set(['testRunner', 'codeReviewer', 'testReviewer', 'analyst', ...(data.config.roles.businessAccepter ? ['businessAccepter'] : [])]);
      if (criteriaOf(assessment).some(criterion => !producers.has(criterion.evidenceProducer))) incomplete('The assessment names an unavailable evidence producer. Use a configured engine check or an explicitly bound observation role.');
      if (data.config.checks.some(spec => spec.criteria.some(id => !criteriaOf(assessment).some(criterion => criterion.id === id)))) incomplete('The assessment omitted a criterion ID required by the configured checks.');
      if (criteriaOf(assessment).some(criterion => criterion.evidenceProducer === 'testRunner' && !data.config.checks.some(spec => spec.criteria.includes(criterion.id)))) incomplete('An automated acceptance criterion has no configured engine check. Capture a valid check mapping before implementation.');
      if (assessment.scope.affectedComponents.some(path => !validPath(path))) incomplete('Assessment affected paths must be explicit normalized source paths.');
      this.store.recordTaskAssessment(assessment); data.assessment = assessment;
    } else if (step.phase === 'triage') {
      const { cause, reason } = result.triage;
      data.feedback.push({ phase: 'triage', cause, reason });
      if (['environment', 'unknown'].includes(cause)) incomplete(`REVIEW_INCOMPLETE: check triage is ${cause}: ${reason}`);
      if (data.repairs >= data.config.bounds.maxRepairIterations) incomplete('The shared repair limit is exhausted.');
      data.repairs++; data.evidenceIds = []; data.acceptanceIds = [];
      if (cause === 'requirements') data.queue = [{ phase: 'define', role: 'analyst' }, { phase: 'confirm-plan', role: 'codeReviewer' }, { phase: 'plan' }];
      else if (cause === 'tests') data.queue = [{ phase: 'write-tests', role: 'testAuthor' }, { phase: 'review-test-source', role: 'testReviewer' }, ...stageQueue(data.plan, data.config).filter(item => !['readiness-code', 'readiness-tests', 'write-tests', 'review-test-source'].includes(item.phase))];
      else data.queue = stageQueue(data.plan, data.config).filter(item => !['readiness-code', 'readiness-tests', 'write-tests', 'review-test-source'].includes(item.phase));
    } else if (['write-tests', 'implement', 'documentation'].includes(step.phase)) {
      const current = sourceSnapshot(this.store, step.directory, data.config.scope.excludedOutputs);
      const before = new Map(data.entries.map(entry => [entry.path, entry.artifact.sha256])), after = new Map(current.map(entry => [entry.path, entry.artifact.sha256]));
      const changed = [...new Set([...before.keys(), ...after.keys()])].filter(path => before.get(path) !== after.get(path));
      const domain = step.phase === 'write-tests' ? 'tests' : step.phase === 'documentation' ? 'documentation' : 'production';
      for (const path of changed) {
        if (!matches(path, data.config.scope[domain]) || (domain === 'production' && matches(path, [...data.config.scope.tests, ...data.config.scope.documentation]))) incomplete(`${step.role} changed ${path} outside its declared ${domain} scope.`);
      }
      data.entries = current;
    } else {
      const review = result.review;
      if (new Set(review.criteria.map(item => item.criterionId)).size !== review.criteria.length || review.criteria.some(item => !criteriaOf(data.assessment).some(criterion => criterion.id === item.criterionId))) incomplete('Review criterion identifiers must be unique members of the captured inventory.');
      if (['review-code', 'review-tests', 'accept'].includes(step.phase) && review.verdict === 'APPROVED' && review.criteria.some(item => item.status !== 'satisfied')) incomplete('APPROVED is inconsistent with an unsatisfied or unverified criterion.');
      if (step.phase === 'confirm-plan') {
        if (review.verdict !== 'APPROVED') incomplete(`Independent planning confirmation refused: ${review.reason}`);
        data.confirmation = { confirmed: true, confirmedBy: step.role, confirmedAt: nowIso(), reason: review.reason };
      } else {
        const outcome = handleReviewOutcomeInLoop({ reviewOutcome: { status: 'COMPLETED', verdict: review.verdict }, loopState: { iteration: data.repairs, maxIterations: data.config.bounds.maxRepairIterations, retryAllowed: false } });
        if (outcome.action === 'repair') {
          if (data.repairs >= data.config.bounds.maxRepairIterations) incomplete('The shared repair limit is exhausted.');
          data.repairs++; data.evidenceIds = []; data.acceptanceIds = []; data.feedback.push({ phase: step.phase, reason: review.reason, criteria: review.criteria });
          if (step.phase.startsWith('readiness')) data.queue = [{ phase: 'define', role: 'analyst' }, { phase: 'confirm-plan', role: 'codeReviewer' }, { phase: 'plan' }];
          else if (step.phase === 'review-test-source') data.queue.unshift({ phase: 'write-tests', role: 'testAuthor' }, { phase: 'review-test-source', role: 'testReviewer' });
          else data.queue = stageQueue(data.plan, data.config);
          return true;
        }
        const criteria = criteriaOf(data.assessment);
        const manual = review.criteria.filter(item => item.status === 'satisfied' && criteria.some(criterion => criterion.id === item.criterionId && (criterion.evidenceProducer === step.role || (step.role === 'businessAccepter' && criterion.evidenceProducer === 'analyst')))).map(item => item.criterionId);
        if (manual.length && ['review-code', 'review-tests', 'accept'].includes(step.phase)) this.addTaskEvidence(execution, attempt, review, 'observation', manual);
        if (step.phase === 'accept') {
          if (data.floorEvaluation?.status !== 'passed' || data.floorEvaluation.planRevisionId !== data.plan.planRevisionId || data.floorEvaluation.candidateDigest !== digestEntries(data.entries)) incomplete('The candidate has no passing engine floor-evaluation receipt for the active plan.');
          for (const spec of data.config.checks) {
            const passed = this.taskEvidenceRecords(execution).some(record => {
              if (record.kind !== 'check' || record.outcome !== 'passed') return false;
              const row = this.store.get('SELECT content_artifact_id FROM task_evidence WHERE id=?', record.id), evidence = this.store.readJson(row.content_artifact_id);
              return evidence.checkId === spec.id && evidence.outcome === 'passed' && evidence.captureVerdict === 'complete';
            });
            if (!passed) incomplete(`Mandatory check ${spec.id} has no complete passing evidence for this candidate and plan.`);
          }
          if (review.criteria.length !== criteria.length || criteria.some(criterion => !review.criteria.some(item => item.criterionId === criterion.id))) incomplete('Business acceptance must cover every captured criterion exactly once.');
          const candidateDigest = digestEntries(data.entries), binding = data.config.roles[step.role];
          const acceptance = { schemaVersion: 1, kind: 'AcceptanceRecord', recordId: `ACC-${randomUUID()}`, deliveryBoundary: 'candidate', subjectId: `SUBJ-${candidateDigest.slice(0, 16).toUpperCase()}`, candidateDigest,
            accepter: { role: step.role, provider: binding.provider, model: binding.model, effort: binding.effort, contextId: step.instance, independent: step.role === 'businessAccepter' },
            criteria: criteria.map(criterion => ({ criterionId: criterion.id, requirementRef: criterion.requirementRef, status: review.criteria.find(item => item.criterionId === criterion.id).status,
              reason: review.criteria.find(item => item.criterionId === criterion.id).reason,
              evidenceRefs: this.taskEvidenceForCriterion(execution, criterion).map(record => ({ id: record.id, kind: record.kind, digest: record.digest })) })),
            overallStatus: 'accepted', unresolvedLimitations: [], evaluatedAt: nowIso() };
          const verdict = evaluateAcceptanceRecord(acceptance, { expectedCriteria: criteria.map(item => item.id), expectedBoundary: 'candidate', expectedSubjectId: acceptance.subjectId,
            expectedCandidateDigest: candidateDigest, resolveEvidence: reference => this.resolveTaskEvidence(execution, reference) });
          if (!verdict.canOpenGate) incomplete(verdict.reason);
          this.store.recordAcceptanceRecord(acceptance, state.id); data.acceptanceIds.push(acceptance.recordId);
        }
      }
    }
    return true;
  };

  P.advanceManagedTasks = function advanceManagedTasks(state) {
    let changed = false;
    for (const execution of this.taskState(state).executions.values()) {
      if (execution.row.state !== 'running') continue;
      const step = execution.data.current, attempt = step && this.store.get('SELECT * FROM attempts WHERE id=?', step.attemptId);
      if (!attempt || this.processes.has(attempt.id)) continue;
      if (['failed', 'canceled', 'interrupted'].includes(attempt.state)) { this.pauseManagedTask(state, execution, execution.data.incompleteReason || 'A managed step needs recovery.'); changed = true; continue; }
      if (attempt.state !== 'succeeded') continue;
      if (this.runState(state.id) !== 'running') continue;
      try {
        if (step.role && !this.consumeManagedAgent(state, execution, attempt)) { changed = true; continue; }
        this.store.transaction(() => {
          const events = [];
          if (execution.data.queue.length) this.scheduleManagedStep(state, execution, events);
          else {
            execution.row.state = 'completed';
            const parent = this.store.get('SELECT * FROM attempts WHERE id=?', execution.row.attempt_id);
            const summary = { schemaVersion: 1, kind: 'ManagedTaskSummary', taskExecutionId: execution.row.id, outcome: execution.data.delivery?.readyForMerge ? 'READY_FOR_MERGE' : 'accepted',
              assessment: execution.data.assessment, plan: execution.data.plan, candidate: execution.data.candidate, acceptanceRecords: execution.data.acceptanceIds,
              candidateFloorEvaluation: execution.data.floorEvaluation,
              deliveryResult: execution.data.delivery, work: this.taskWorkSummary(execution) };
            assertValid('managed-task.schema.json', null, summary);
            events.push(this.commitOutputs(state, parent, { candidate: execution.data.candidate, summary: jsonValue(this.store.putJson(summary)) }));
            events.push(...this.attemptTransition(parent, 'succeeded', 'The selected task boundary is accepted against engine evidence.'));
            this.store.run("UPDATE execution_plans SET status='completed' WHERE id=? AND plan_revision_id=?", execution.data.plan.planId, execution.data.plan.planRevisionId);
          }
          this.saveManagedTask(execution, events); this.store.appendEvents(state.id, events);
        });
      } catch (error) { this.pauseManagedTask(state, execution, error.message); }
      changed = true;
    }
    return changed;
  };
  P.cancelManagedTasks = function cancelManagedTasks(runId, events, reason, instance = null) {
    const state = this.runs.get(runId); if (!state) return;
    for (const execution of this.taskState(state).executions.values()) {
      if (!ACTIVE.has(execution.row.state) || (instance && execution.row.node_instance_id !== instance)) continue;
      execution.row.state = 'canceled'; execution.data.incompleteReason = reason;
      const parent = this.store.get('SELECT * FROM attempts WHERE id=?', execution.row.attempt_id);
      if (!['canceled', 'failed', 'succeeded', 'interrupted'].includes(parent.state)) events.push(...this.attemptTransition(parent, 'canceled', reason));
      this.saveManagedTask(execution, events);
      for (const record of this.processes.values()) if (record.taskExecutionId === execution.row.id) { record.stopRequested = true; record.abortController?.abort(); }
    }
  };
  P.retryManagedTaskStep = function retryManagedTaskStep(state, body, events) {
    const info = this.taskState(state).steps.get(body.nodeInstanceId);
    if (!info) throw new ApiError(409, 'conflict', 'Select the failed managed task step to retry it.');
    const execution = this.managedTask(state, info.executionId), step = execution.data.current;
    if (this.taskRemainingMs(execution) <= 0) throw new ApiError(409, 'conflict', 'The aggregate deadline is exhausted; it cannot be reset by retry.');
    if (step.instance !== body.nodeInstanceId) throw new ApiError(409, 'conflict', 'Only the current managed step may be retried.');
    if (step.phase === 'deliver' && this.store.get('SELECT 1 FROM delivery_operations WHERE task_execution_id=?', execution.row.id)) throw new ApiError(409, 'conflict', 'A delivery intent already exists. Inspect and reconcile its saved ref/commit receipt; automatic delivery retry is prohibited. Start a newly captured plan after reconciliation.');
    const binding = this.store.get('SELECT b.* FROM context_bindings b JOIN run_context_bindings m ON m.binding_id=b.id WHERE m.run_id=? AND m.context_node_id=?', state.id, step.instance);
    if (binding?.state === 'needs_review' && body.binding !== 'acknowledge' && body.binding !== 'fresh') throw new ApiError(422, 'context_unavailable', 'A failed native turn needs acknowledged or fresh Context recovery.');
    if (binding && (binding.state === 'needs_review' || body.binding === 'fresh')) {
      if (body.binding !== 'acknowledge' && body.binding !== 'fresh') throw new ApiError(422, 'context_unavailable', 'A failed native turn needs acknowledged or fresh Context recovery.');
      if (body.binding === 'acknowledge') events.push(this.bindingTransition(binding, this.bindingRecord(binding).nativeSessionId ? 'ready' : 'unbound', 'Acknowledged for managed task retry.')[0]);
      else {
        step.contextEpoch = (step.contextEpoch || 0) + 1; step.contextTurns = 1;
        const dir = this.managedTaskDirectory(execution, `step-${execution.data.sequence}-fresh-${step.contextEpoch}`);
        const workspace = { ...this.workspaceOf(state), cwd: dir, cwd_identity: sha256(Buffer.from(process.platform === 'win32' ? dir.toLowerCase() : dir)) };
        const id = this.createBinding(state.id, workspace, binding.provider, step.instance);
        this.store.run('UPDATE run_context_bindings SET binding_id=? WHERE run_id=? AND context_node_id=?', id, state.id, step.instance);
      }
    }
    execution.row.state = 'running'; execution.data.incompleteReason = null; step.result = null;
    step.attemptId = this.planAttempt(state, step.instance, step.phase, step.role ? 'agent' : 'task-utility', null, events);
    const parent = this.store.get('SELECT * FROM attempts WHERE id=?', execution.row.attempt_id);
    events.push(...this.attemptTransition(parent, 'running', 'Managed task resumed within the original aggregate bounds.'));
    this.saveManagedTask(execution, events);
  };
  P.managedTaskNavigator = function managedTaskNavigator(runId, instance) {
    this.requireRun(runId);
    const row = this.store.get('SELECT * FROM managed_tasks WHERE run_id=? AND node_instance_id=? ORDER BY created_at DESC LIMIT 1', runId, instance);
    if (!row) throw new ApiError(404, 'not_found', 'Managed task execution not found.');
    const execution = this.runs.has(runId) ? this.managedTask(this.runs.get(runId), row.id) : { row, data: this.store.readJson(row.state_artifact_id) };
    return { taskExecutionId: row.id, state: row.state, current: execution.data.current?.instance || null, phase: execution.data.current?.phase || null,
      assessment: execution.data.assessment, plan: execution.data.plan, work: this.taskWorkSummary(execution), incompleteReason: execution.data.incompleteReason || null,
      candidateFloorEvaluation: execution.data.floorEvaluation || null,
      acceptanceRecordIds: execution.data.acceptanceIds, delivery: execution.data.delivery, deliveryOperation: this.store.get('SELECT * FROM delivery_operations WHERE task_execution_id=?', row.id) || null,
      stateArtifact: { artifactId: row.state_artifact_id, sha256: this.store.artifactRow(row.state_artifact_id).sha256 } };
  };
  P.interruptManagedTasks = function interruptManagedTasks(runId, events) {
    for (const row of this.store.all("SELECT * FROM managed_tasks WHERE run_id=? AND state IN ('running','paused')", runId)) {
      const execution = { row: { ...row, state: 'interrupted' }, data: this.store.readJson(row.state_artifact_id) };
      execution.data.incompleteReason = 'Runtime restarted. Inspect the saved task, work and delivery receipts before creating a new run.';
      this.saveManagedTask(execution, events, 'interrupted');
      this.store.run("UPDATE task_work SET ended_at=?,duration_ms=MAX(0,(julianday(?) - julianday(started_at))*86400000) WHERE task_execution_id=? AND ended_at IS NULL", nowIso(), nowIso(), row.id);
    }
    this.store.run("UPDATE delivery_operations SET phase='reconciliation_required',updated_at=? WHERE run_id=? AND phase NOT IN ('completed','reconciled')", nowIso(), runId);
  };
}
