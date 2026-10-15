import { canonicalHash, canonicalize } from './canonical.mjs';
import { SCHEMAS, check } from './schemas.mjs';

// Pure Implementation Map helpers: definition validation, scopes, assembly and prompts.
export const MAP_TEMPLATE_VERSION = 1;
const MAP = SCHEMAS['map.schema.json'];

export const shortHash = (value, length = 12) => canonicalHash(value).slice(0, length).toUpperCase();
export const recordId = (prefix, value) => `${prefix}-${shortHash(value)}`;

// Self-contained output contracts for the provider CLIs (only local #/ references).
export const outputSchema = name => ({ $defs: { issueDraft: MAP.$defs.issueDraft }, ...MAP.$defs[name] });

// Role registry entries in the documentation's role-fixture shape.
export function registryKinds(roles) {
  return Object.fromEntries(roles.map(role => [role.id, role.kind === 'agent'
    ? { kind: 'agent', engineOutputs: [], embeddedRoles: [] }
    : { kind: 'utility', engineOutputs: ['candidate'], embeddedRoles: [role.embeddedRoles.triage] }]));
}

export function templateFingerprint(config) {
  return canonicalHash({ version: MAP_TEMPLATE_VERSION, roles: config.roles, approvalPolicy: config.approvalPolicy });
}

export function normalizedPath(path) {
  if (!path || path.includes('\\') || path.includes(':') || path.startsWith('/')) return null;
  const parts = path.split('/');
  if (parts.some(part => part === '' || part === '..')) return null;
  return parts.filter(part => part !== '.').join('/');
}

// Declared scope matching: "dir/**" is a prefix; other globs match from the right like a POSIX path match.
export function scopeMatches(path, scope) {
  if (scope.endsWith('/**')) return path.startsWith(scope.slice(0, -2));
  if (!/[*?]/.test(scope)) return path === scope;
  const pattern = scope.split('/').map(part => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')).join('/');
  return new RegExp(`(^|/)${pattern}$`).test(path);
}

function cyclic(adjacency) {
  const state = new Map();
  const visit = key => {
    state.set(key, 1);
    for (const next of adjacency.get(key) || []) {
      if (state.get(next) === 1) return true;
      if (!state.has(next) && visit(next)) return true;
    }
    state.set(key, 2);
    return false;
  };
  return [...adjacency.keys()].some(key => !state.has(key) && visit(key));
}

// Mirrors docs/tools/validate_docs.py map_issues, plus runtime template-port rules.
// Section index rules (mirrors docs/tools/validate_docs.py section_issues).
export function sectionIssues(index) {
  const issues = [];
  const add = (code, message) => issues.push({ code, path: '/spec-index.json', message });
  const sections = new Map(index.sections.map(section => [section.id, section]));
  if (sections.size !== index.sections.length) add('sections.unique', 'Section IDs must be unique.');
  const adjacency = new Map([...sections].map(([id, section]) => [id, new Set(section.dependsOn)]));
  if ([...adjacency.values()].some(deps => [...deps].some(dep => !sections.has(dep)))) add('section.reference', 'A section depends on an unknown section.');
  if (cyclic(adjacency)) add('section.cycle', 'Section dependencies form a cycle.');
  if ([...sections.values()].some(section => section.normative && section.dependsOn.some(dep => sections.has(dep) && !sections.get(dep).normative)))
    add('section.informative_dependency', 'A normative section depends on an informative one.');
  return issues;
}

// registry: role-fixture entries { kind, engineOutputs, embeddedRoles } keyed by role ID (defaults to the Map's roles).
export function mapIssues(map, index, roles, { registry: given = null } = {}) {
  const issues = [];
  const add = (code, message) => issues.push({ code, path: '/implementation-map.json', message });
  const schema = check('implementation-map.schema.json', null, map);
  if (schema.length) return schema.map(issue => ({ code: 'schema', path: `/implementation-map.json${issue.path === '/' ? '' : issue.path}`, message: issue.message }));
  const sections = new Map(index.sections.map(section => [section.id, section]));
  const tasks = new Map(map.tasks.map(task => [task.id, task]));
  const registry = given || registryKinds(roles);
  if (tasks.size !== map.tasks.length) add('tasks.unique', 'Task IDs must be unique.');
  const closure = (roots, taskId) => {
    const result = new Set();
    const visit = key => {
      if (result.has(key)) return;
      if (!sections.has(key)) { add('task.section', `${taskId} references unknown section ${key}.`); return; }
      result.add(key);
      for (const dependency of sections.get(key).dependsOn) visit(dependency);
    };
    for (const key of roots) visit(key);
    return result;
  };
  const adjacency = new Map([...tasks.keys()].map(key => [key, new Set()]));
  for (const task of tasks.values()) {
    for (const field of ['inputs', 'outputs', 'acceptanceCriteria'])
      if (new Set(task[field].map(item => item.id)).size !== task[field].length) add(`task.${field}.unique`, `${task.id}: ${field} IDs must be unique.`);
    const deps = new Map(task.dependsOn.map(item => [item.taskId, item.milestone]));
    if (deps.size !== task.dependsOn.length) add('task.deps.unique', `${task.id}: duplicate dependency.`);
    for (const key of deps.keys()) {
      if (!tasks.has(key) || key === task.id) add('task.dependency', `${task.id} depends on unknown task ${key}.`);
      if (tasks.has(key)) adjacency.get(key).add(task.id);
    }
    const inputs = new Set(task.inputs.filter(item => item.ref.startsWith('spec:')).map(item => item.ref.slice(5)));
    const scopes = new Set(task.readScopes.filter(scope => scope.startsWith('spec:')).map(scope => scope.slice(5)));
    const checks = new Set(task.acceptanceCriteria.filter(item => item.method === 'check').map(item => item.checkId));
    const outputPaths = new Set(task.outputs.filter(output => output.type === 'fileSet').flatMap(output => output.paths));
    const named = new Set([...sections.values()].filter(section => section.kind === 'check' && section.command.args.some(arg => outputPaths.has(normalizedPath(arg)))).map(section => section.id));
    const subset = (a, b) => [...a].every(item => b.has(item));
    if (!subset(named, inputs) || !subset(named, scopes)) add('task.check_input', `${task.id} produces a path named by ${[...named].join(', ')}; declare that check as a spec input and read scope.`);
    const needed = closure(new Set([...task.requirementRefs, ...inputs, ...checks, ...named]), task.id);
    if (!subset(needed, inputs) || !subset(needed, scopes)) add('task.closure', `${task.id} must declare its whole normative closure (${[...needed].filter(key => !inputs.has(key) || !scopes.has(key)).join(', ')}) as spec inputs and read scopes.`);
    if (task.requirementRefs.some(key => !sections.has(key) || !sections.get(key).normative || !['requirement', 'contract'].includes(sections.get(key).kind)))
      add('task.requirement', `${task.id}: requirementRefs must name normative requirement or contract sections.`);
    if ([...checks].some(key => sections.get(key)?.kind !== 'check')) add('task.check', `${task.id}: a check criterion names no indexed check.`);
    for (const item of task.inputs) if (item.ref.startsWith('task:')) {
      const [, producer, outputId] = item.ref.split(':');
      if (deps.get(producer) !== 'accepted') add('task.input_dependency', `${task.id} reads ${producer} without an accepted dependency.`);
      if (!tasks.has(producer) || !tasks.get(producer).outputs.some(output => output.id === outputId)) add('task.output_reference', `${task.id} reads a missing output ${item.ref}.`);
    }
    const role = registry[task.executorRole];
    if (!role) add('role.missing', `${task.id}: executor role "${task.executorRole}" is not in the role registry.`);
    const captures = [];
    for (const output of task.outputs) {
      if (output.type === 'candidate' && (role?.kind !== 'utility' || !role.engineOutputs.includes('candidate'))) add('role.candidate', `${task.id}: only an engine utility template produces a candidate.`);
      for (const path of output.paths || []) {
        if (normalizedPath(path) !== path || /[*?]/.test(path)) add('task.path', `${task.id}: "${path}" is not a normalized relative path.`);
        captures.push(path.toLowerCase());
        if (output.type === 'fileSet' && !task.writeScopes.some(scope => scopeMatches(path, scope))) add('task.write_scope', `${task.id}: "${path}" is outside its write scopes.`);
      }
    }
    if (new Set(captures).size !== captures.length) add('task.path_collision', `${task.id}: output paths collide.`);
    for (const criterion of task.acceptanceCriteria) if (criterion.method === 'review' && registry[criterion.role]?.kind !== 'agent') add('role.review', `${task.id}: review role "${criterion.role}" is not an Agent role.`);
    // Runtime template ports (M5 engine templates).
    if (role?.kind === 'agent') {
      if (task.outputs.some(output => output.type !== 'fileSet')) add('template.ports', `${task.id}: the agent task template captures fileSet outputs only.`);
      if (task.acceptanceCriteria.some(item => item.method === 'check' && sections.get(item.checkId)?.command?.source !== 'task-result')) add('template.ports', `${task.id}: checks of an agent task must use source "task-result".`);
    }
    if (role?.kind === 'utility') {
      if (task.outputs.filter(output => output.type === 'candidate').length !== 1 || task.outputs.some(output => output.type === 'fileSet' || output.type === 'text'))
        add('template.ports', `${task.id}: the verification template produces exactly one candidate and optional json reports.`);
      if (!task.acceptanceCriteria.length || task.acceptanceCriteria.some(item => item.method !== 'check' || sections.get(item.checkId)?.command?.source !== 'candidate'))
        add('template.ports', `${task.id}: verification criteria must be checks with source "candidate".`);
      if (task.dependsOn.length === 0) add('template.ports', `${task.id}: verification needs accepted source tasks.`);
    }
  }
  if (cyclic(adjacency)) add('task.cycle', 'Task dependencies form a cycle.');
  return issues;
}

export function topologicalTasks(map) {
  const order = [], seen = new Set(), tasks = new Map(map.tasks.map(task => [task.id, task]));
  const visit = id => { if (seen.has(id)) return; seen.add(id); for (const dep of tasks.get(id).dependsOn) visit(dep.taskId); order.push(id); };
  for (const task of map.tasks) visit(task.id);
  return order;
}

// Every task that (transitively) depends on one of `ids`.
export function consumersOf(map, ids) {
  const result = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of map.tasks) if (!result.has(task.id) && task.dependsOn.some(dep => ids.includes(dep.taskId) || result.has(dep.taskId))) { result.add(task.id); changed = true; }
  }
  return [...result];
}

// Apply TaskResult operations over a base path→entry map. Different content, incompatible
// preimages or case collisions are conflicts; identical operations deduplicate.
export function assemble(baseEntries, results) {
  const files = new Map(baseEntries.map(entry => [entry.path, { ...entry, from: null }]));
  const touched = new Map();
  const conflicts = [];
  for (const { recordId: id, operations } of results) {
    for (const op of operations) {
      const previous = touched.get(op.path);
      if (previous) {
        if (previous.op.artifact.sha256 !== op.artifact.sha256) {
          const known = conflicts.find(item => item.path === op.path);
          if (known) known.results.push(id); else conflicts.push({ path: op.path, reason: 'different_content', results: [previous.id, id] });
        }
        continue;
      }
      const base = files.get(op.path);
      if ((op.op === 'replace' && base?.artifact.sha256 !== op.preimage) || (op.op === 'create' && base && base.artifact.sha256 !== op.artifact.sha256)) {
        conflicts.push({ path: op.path, reason: 'preimage_mismatch', results: [id] });
        continue;
      }
      const lower = op.path.toLowerCase();
      const collision = [...files.keys()].find(path => path !== op.path && path.toLowerCase() === lower);
      if (collision) { conflicts.push({ path: op.path, reason: 'case_collision', results: [id] }); continue; }
      touched.set(op.path, { id, op });
      files.set(op.path, { path: op.path, artifact: op.artifact, byteSize: op.byteSize, mediaType: 'application/octet-stream', from: id });
    }
  }
  return conflicts.length ? { conflicts } : { entries: [...files.values()].sort((a, b) => (a.path < b.path ? -1 : 1)) };
}

// Verification-cycle bound (decision fixtures: verificationCycles).
export function verificationStep({ before, limit, outcome }) {
  if (outcome === 'operational_failure') return { count: before, state: 'paused_recovery' };
  const count = before + (outcome === 'failed' ? 1 : 0);
  if (count >= limit) return { count, state: 'paused_limit' };
  return { count, state: outcome === 'passed' ? 'passed' : 'repair_allowed' };
}

const sectionText = (bundle, ids) => ids.filter(id => bundle.headings.has(id)).map(id => bundle.headings.get(id)).join('\n\n');
const specIds = task => [...new Set([...task.inputs.filter(item => item.ref.startsWith('spec:')).map(item => item.ref.slice(5)),
  ...task.readScopes.filter(scope => scope.startsWith('spec:')).map(scope => scope.slice(5))])];
const issueLines = issues => issues.map(issue => `- [${issue.id}] ${issue.message} → ${issue.requestedChange}`).join('\n');

export function executePrompt({ role, task, bundle, subjectId, map, generation, feedback }) {
  return [
    role.instructions, '',
    `Task: ${task.id} — ${task.title}`,
    `Specification: ${subjectId} (map ${map.mapId}, generation ${generation})`,
    `Executor role: ${task.executorRole}`,
    `Requirements: ${task.requirementRefs.join(', ')}`, '',
    'Outputs to write:',
    ...task.outputs.flatMap(output => (output.paths || []).map(path => `- ${path}`)),
    `Write scopes: ${task.writeScopes.join(', ')}`,
    'Acceptance criteria:',
    ...task.acceptanceCriteria.map(item => `- ${item.id} (${item.method === 'review' ? `review by ${item.role}` : `check ${item.checkId}`}): ${item.description}`), '',
    'Specification sections:', sectionText(bundle, specIds(task)), '',
    ...(feedback.length ? ['Feedback to address:', issueLines(feedback), ''] : []),
    'The working directory holds the captured base and accepted dependency results. Write only the listed outputs.',
    'Answer with a TaskReturn JSON: {"schemaVersion":1,"kind":"candidate","summary":"…"} once the files are written, or kind "specification_revision_required" with blocker issues when the specification itself must change.',
  ].join('\n');
}

export function reviewPrompt({ role, task, criterion, result, bundle, subjectId }) {
  return [
    role.instructions, '',
    `Review task ${task.id} result ${result.recordId} against criterion ${criterion.id}: ${criterion.description}`,
    `Task: ${task.id} — ${task.title}`,
    `Result: ${result.recordId}`,
    `Criterion: ${criterion.id}`,
    `Specification: ${subjectId}`, '',
    'Changed files (relative to the captured base; the working directory holds this snapshot):',
    ...result.operations.map(op => `- ${op.op} ${op.path}`), '',
    'Specification sections:', sectionText(bundle, specIds(task)), '',
    'Answer with a TaskReview JSON naming this taskId, resultId and criterionId. CHANGES_REQUESTED needs at least one blocker issue.',
  ].join('\n');
}

export function triagePrompt({ role, task, cycle, subjectId, bundle, map, candidateTasks, failures, conflict }) {
  return [
    role.instructions, '',
    `Triage verification of ${task.id}, cycle ${cycle}.`,
    `Specification: ${subjectId} (map ${map.mapId})`,
    `Candidate tasks: ${candidateTasks.join(', ')}`,
    ...failures.map(item => `Failed check ${item.checkId} (criterion ${item.criterionId}): exit ${item.exitCode}, expected ${item.requiredExitCode}\nstdout tail:\n${item.stdout}\nstderr tail:\n${item.stderr}`),
    ...(conflict ? conflict.conflicts.map(item => `Conflict on ${item.path} (${item.reason}) between results ${item.results.join(', ')}`) : []), '',
    'Specification sections:', sectionText(bundle, specIds(task)), '',
    `Set subjectId to ${JSON.stringify(subjectId)} in the returned decision.`,
    'Answer with a TriageDecision JSON. cause implementation/tests/integration_conflict names affectedTaskIds from the candidate tasks; specification names requirementRefs; unknown pauses for the user.',
  ].join('\n');
}

export const issueId = (scope, value) => `ISS-${scope}-${shortHash(value, 10)}`;
export const stableJson = value => canonicalize(value);

// ---------- M6: task fingerprints and cross-revision carry ----------
// The normative closure a task depends on (the same roots as the closure validation).
export function taskClosure(task, index) {
  const sections = new Map(index.sections.map(section => [section.id, section]));
  const outputPaths = new Set(task.outputs.filter(output => output.type === 'fileSet').flatMap(output => output.paths));
  const roots = new Set([...task.requirementRefs, ...task.inputs.filter(item => item.ref.startsWith('spec:')).map(item => item.ref.slice(5)),
    ...task.acceptanceCriteria.filter(item => item.method === 'check').map(item => item.checkId),
    ...[...sections.values()].filter(section => section.kind === 'check' && section.command.args.some(arg => outputPaths.has(normalizedPath(arg)))).map(section => section.id)]);
  const result = new Set();
  const visit = id => { if (result.has(id) || !sections.has(id)) return; result.add(id); sections.get(id).dependsOn.forEach(visit); };
  roots.forEach(visit);
  return result;
}

// Merkle fingerprint per task: definition, normative closure hashes, base, the native execution
// profile, the pinned roles it uses and its dependencies' fingerprints. Any change invalidates it.
export function taskFingerprints(map, index, hashes, baseSha, roles, { nativeConfiguration = null } = {}) {
  const tasks = new Map(map.tasks.map(task => [task.id, task]));
  const byRole = new Map(roles.map(role => [role.id, role]));
  const memo = new Map();
  const visit = id => {
    if (memo.has(id)) return memo.get(id);
    const task = tasks.get(id);
    const executor = byRole.get(task.executorRole);
    const value = canonicalHash({
      version: MAP_TEMPLATE_VERSION, task, base: baseSha, nativeConfiguration,
      closure: [...taskClosure(task, index)].sort().map(section => [section, hashes.get(section) ?? null]),
      executor, embedded: executor?.kind === 'utility' ? byRole.get(executor.embeddedRoles.triage) ?? null : null,
      reviewers: task.acceptanceCriteria.filter(item => item.method === 'review').map(item => byRole.get(item.role) ?? null),
      deps: task.dependsOn.map(dep => [dep.taskId, visit(dep.taskId)]),
    });
    memo.set(id, value);
    return value;
  };
  return Object.fromEntries(map.tasks.map(task => [task.id, visit(task.id)]));
}

// Which prior selections may be carried. Cross-revision carry needs a recorded, equal fingerprint
// for the task and every dependency carried too; an unknown closure (no fingerprint) never carries.
export function carryDecision({ map, prior, fingerprints, withdrawn = new Set(), crossRevision }) {
  const priorTasks = new Map((prior?.tasks || []).map(item => [item.taskId, item]));
  const carried = new Map();
  for (const id of topologicalTasks(map)) {
    const task = map.tasks.find(item => item.id === id);
    const before = priorTasks.get(id);
    if (!before || before.state !== 'accepted' || !before.selectedResult || withdrawn.has(id)) continue;
    if (before.fingerprint ? before.fingerprint !== fingerprints[id] : crossRevision) continue;
    if (!task.dependsOn.every(dep => carried.has(dep.taskId))) continue;
    carried.set(id, before);
  }
  return carried;
}
