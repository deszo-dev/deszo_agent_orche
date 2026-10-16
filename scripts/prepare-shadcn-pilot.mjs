// Prepare a saved-workflow candidate; this script never invokes a provider or starts a run.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateWorkflow, topologicalOrder } from '../runtime/core/validate.mjs';
import { pilotValidatorSource } from './pilot-documents.mjs';
import { splitPilotReviewers } from './shadcn-pilot-reviewers.mjs';

const repo = resolve(import.meta.dirname, '..');
const outputPath = 'docs/pilots/shadcn-ui-workflow.json';
const pilotRoot = join(repo, '.deszo/pilots/shadcn-ui');
const validatorPath = join(pilotRoot, 'validate-documents.mjs');
const read = path => readFileSync(join(repo, path), 'utf8');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const workflow = JSON.parse(read('docs/examples/reference-delivery/workflow.json'));
workflow.workflowId = 'deszo-shadcn-ui';
const node = (graph, id) => {
  const found = graph.nodes.find(item => item.id === id);
  assert.ok(found, `Missing node ${id}`);
  return found;
};
const edge = (graph, from, fromPort, to, toPort) => graph.edges.push({
  id: `p-${from}-${fromPort}-${to}-${toPort}`.replaceAll('$', '').slice(0, 64),
  source: { nodeId: from, port: fromPort }, target: { nodeId: to, port: toPort },
});
function remove(graph, ids) {
  graph.nodes = graph.nodes.filter(item => !ids.includes(item.id));
  graph.edges = graph.edges.filter(item => !ids.includes(item.source.nodeId) && !ids.includes(item.target.nodeId));
  graph.after = graph.after.filter(item => !ids.includes(item.before) && !ids.includes(item.after));
}
const analyst = { provider: 'codex', model: 'gpt-6.1-sol', effort: 'max' };
const reviewer = { provider: 'claude', model: 'claude-opus-5-5', effort: 'medium' };
const author = { provider: 'claude', model: 'claude-haiku-5-5', effort: 'xhigh' };
const junior = { provider: 'codex', model: 'gpt-6-luna', effort: 'max' };
const specificationPolicy = { slots: [{ id: 'readiness', role: 'reviewer', view: 'full' }] };
const technicalPolicy = { slots: [{ id: 'quality', role: 'reviewer', view: 'full' }] };
const businessPolicy = { slots: [{ id: 'customer', role: 'analyst', view: 'full' }] };
const delivery = node(workflow, 'delivery').config.body;
const specification = node(delivery, 'specification').config.body;
const implementation = node(delivery, 'implement').config;
node(workflow, 'delivery').config.limits = { maxIterations: 3, maxActiveMinutes: 480 };
node(delivery, 'specification').config.limits = { maxIterations: 3, maxActiveMinutes: 90 };
remove(workflow, ['final-customer-history']);
workflow.nodes.push({ id: 'junior-history', type: 'context', config: { provider: 'codex', mode: 'new' } });
remove(specification, ['customer-prompt', 'customer-review', 'testability-prompt', 'testability-review']);
remove(delivery, ['conformance-prompt', 'conformance-review']);

for (const id of ['prepare', 'evaluate']) node(specification, id).config.policy = specificationPolicy;
node(delivery, 'verify-docs').config.policy = specificationPolicy;
implementation.approvalPolicy = specificationPolicy;
for (const id of ['final-prepare', 'customer-prepare']) node(delivery, id).config.specificationPolicy = specificationPolicy;
for (const id of ['final-prepare', 'technical']) node(delivery, id).config.policy = technicalPolicy;
node(delivery, 'customer-prepare').config.technicalPolicy = technicalPolicy;
for (const id of ['customer-prepare', 'final']) node(delivery, id).config.policy = businessPolicy;
Object.assign(node(specification, 'analyst').config, analyst);
Object.assign(node(specification, 'readiness-review').config, reviewer);
Object.assign(node(delivery, 'quality-review').config, reviewer);
Object.assign(node(delivery, 'final-customer').config, analyst, { contextId: 'analyst-history' });
Object.assign(node(delivery, 'triage').config, analyst);

const writerRules = [
  'Use English. Read the supplied approved specification sections and immutable input files.',
  'Implement only the task-owned concrete outputs. Never change Git metadata, credentials, the controlling Deszo installation or its data directory.',
  'Do not delete or rename existing base files: this pilot captures create/replace operations. Preserve compatibility exports if splitting an existing module.',
  'Dependency manifests and shared components have one explicitly ordered owner. Do not run a CLI that rewrites undeclared files.',
  'Use npm ci only when the approved writeScopes include node_modules/** and required scratch paths. Scratch dependencies/build output must never be declared as captured outputs.',
  'Return exactly the supplied Task Return JSON schema. Real blockers must be reported with evidence; never invent successful commands or screenshots.',
].join('\n');
for (const role of implementation.roles.filter(item => item.kind === 'agent')) {
  Object.assign(role, role.id === 'reviewer' ? reviewer : role.id === 'analyst' ? analyst : author);
  role.instructions += '\n' + writerRules;
}
implementation.roles.push({ id: 'junior-analyst', kind: 'agent', ...junior, timeoutSeconds: 600, context: 'task',
  instructions: 'Update task-owned user/developer documentation to match approved requirements and the accepted implementation. Correct formatting, links, examples and UI terminology. Do not alter requirement meaning, check obligations or approved interfaces; return specification_revision_required for a substantive ambiguity.\n' + writerRules });

// Split the complete source snapshot because each File Input has at most 200 paths.
const files = [...new Set([
  ...execFileSync('git', ['ls-files', '-z'], { cwd: repo, encoding: 'utf8' }).split('\0').filter(Boolean),
  'scripts/prepare-shadcn-pilot.mjs', 'scripts/shadcn-pilot-check.mjs', 'scripts/shadcn-pilot-reviewers.mjs', 'docs/pilots/shadcn-ui-workflow.md', outputPath,
])].filter(path => path === outputPath || existsSync(join(repo, path))).sort();
remove(workflow, ['project']);
const chunks = [];
for (let start = 0; start < files.length; start += 180) {
  const id = `project-${chunks.length + 1}`;
  chunks.push(id);
  workflow.nodes.push({ id, type: 'file-input', config: { mode: 'files', paths: files.slice(start, start + 180) } });
}
workflow.nodes.push({ id: 'project', type: 'merge', config: { mode: 'artifacts', inputs: chunks.map(id => ({ id })) } });
for (const id of chunks) edge(workflow, id, 'value', 'project', id);
edge(workflow, 'project', 'value', 'seed', 'base');

const brief = read('docs/pilots/shadcn-ui-brief.md');
const businessTask = brief.split('## Business task')[1].split('## Roles')[0].trim()
  + '\n\nAcceptance scope:\n' + brief.split('## Acceptance scope')[1].trim();
node(workflow, 'task').config.value = businessTask;
const guide = [
  'You are the senior Analyst and the first recipient of the original business task. Inspect the actual pinned Deszo source before specifying the change.',
  'Inventory every application panel, form, dialog and owned control. Include the palette/toolbar, inspector, nested Loop navigation, Map roles/navigator, problems/run journal/history/Replay, Contexts/chat, recovery, settings/workspaces/workflows and external-run approvals.',
  'Migrate owned controls to shadcn/ui and shared theme tokens, preserving the React Flow canvas, graph interactions, existing English text, functional contracts and reasoning-effort settings. Preserve the Vite local-runtime connection plugin, Tauri behavior and @xyflow/react styling.',
  'Read docs/IMPLEMENTATION_MAP.md, docs/PIPELINE_EXECUTION.md and both docs/schemas/spec-section-index.schema.json and docs/schemas/implementation-map.schema.json. The round-recovery documents are FORMAT examples only; do not copy their fictional business requirements.',
  'Write SPEC.md, spec-index.json and implementation-map.json. Use exactly ## ID headings for every indexed section, all headings indexed, stable acyclic IDs, requirementRefs limited to normative REQ-/CONTRACT- IDs. Every task needs its full transitive normative closure as explicit spec inputs AND readScopes, including test-case/check obligations. dependsOn entries are {taskId, milestone:"accepted"}, never section IDs or strings.',
  'Allowed executor role IDs: implementer, test-author, junior-analyst, verification. The reviewer role reviews code, tests and documentation. The analyst role owns substantive decisions and verification triage. verification is an engine utility, not a provider.',
  'Plan bounded file groups. Give package.json/package-lock.json, theme/global CSS, Vite/TS setup and each shared source file exactly one owner; order every later task that modifies or consumes those files after its accepted producer. Test author and developer use separate task directories and approved interfaces.',
  'Include an accepted documentation task owned by junior-analyst after the UI implementation. Its outputs describe the resulting UI and developer commands. Do not delegate requirement meaning to that role.',
  'Include TASK-UI-EVIDENCE owned by test-author after ALL UI source and test-script outputs have been accepted. It runs node scripts/shadcn-pilot-check.mjs --ui-only --evidence-dir docs/pilots/shadcn-ui-evidence and captures docs/pilots/shadcn-ui-evidence/report.json, main.png, dialogs.png and small-window.png as a declared fileSet reviewed by reviewer. These are generated from the complete accepted UI, not hand-authored screenshots. Include this task and its evidence in final verification dependencies/candidate paths. Check-runner scratch directories are deleted; screenshots generated only during CHECK execution would otherwise be lost.',
  'Create a final TASK-VERIFY utility task that depends on and consumes every accepted output needed in the complete candidate. Its candidate paths must include every changed/new deliverable. Do not include node_modules, dist, reports or temporary files as deliverables.',
  'The approved final candidate check must run node scripts/shadcn-pilot-check.mjs (source candidate, requiredExitCode 0, timeoutSeconds 600). The wrapper installs pinned dependencies, builds, runs runtime regressions, documentation checks and npm run test:ui, then bundles the runtime. The foundation task must add the required browser-test dependency/script; test-author must provide meaningful fixture-runtime browser interaction coverage and screenshot evidence. Do not create test:ui as an empty stub.',
  'test:ui must honor DESZO_UI_EVIDENCE_DIR (relative to the project), write report.json with schemaVersion 1, nonempty scenarios [{id,status:"passed"}] covering the approved scenario IDs, and screenshots ["main.png","dialogs.png","small-window.png"]. Write the three actual browser PNG screenshots in that directory. Include real viewport/interaction/expectation details and source-file digests in the report. The wrapper validates report presence, all scenario statuses and PNG signatures; Opus judges completeness and visual behavior.',
  'Fresh task/check directories have no node_modules. Give tasks that need npm/builds explicit scratch writeScopes for node_modules/**, dist/**, dist-runtime/**, .deszo/** and *.tsbuildinfo. The verification task must allow those NEW scratch paths. npm ci must not modify existing tracked inputs; never change source from a checker. All CHECK commands run independently in fresh directories, so keep full-candidate steps in the one wrapper.',
  'Capture representative browser screenshots and machine-readable assertions for critical UI flows, accessible labels/focus/dialog behavior, busy/disabled/error states, and small-window overflow. A browser result cannot prove a desktop-only behavior. Record the remaining Tauri desktop smoke for the operator after candidate application; do not claim it already happened.',
  'Provider invocations are bounded to 600 seconds. Split implementation into feasible tasks. Allow at most three task attempts and three failed verification cycles. On unknown triage preserve evidence and pause. Do not weaken requirements/checks to pass.',
  'The source base is pinned by the prepared manifest. During documentation authoring write ONLY SPEC.md, spec-index.json and implementation-map.json. Never edit app source, package files or the pilot tooling in this directory. Return a concise summary of semantic decisions and remaining risks.',
  `Before returning, run node ${JSON.stringify(validatorPath)}. Correct schema/closure/role errors until it passes. The validator also detects changes to the pinned project; do not modify the validator or its manifest.`,
].join('\n\n');
node(specification, 'analysis-prompt').config.template += '\n\n' + guide;
// Attach source evidence and the prior bundle to the senior Analyst.
specification.edges = specification.edges.filter(item => !(item.target.nodeId === 'analyst' && item.target.port === 'files'));
specification.nodes.push(
  { id: 'source-base', type: 'json-select', config: { pointer: '/base', outputType: 'ArtifactSet' } },
  { id: 'analyst-inputs', type: 'merge', config: { mode: 'artifacts', inputs: [{ id: 'project' }, { id: 'previous' }] } },
);
edge(specification, '$input', 'value', 'source-base', 'value');
edge(specification, 'source-base', 'value', 'analyst-inputs', 'project');
edge(specification, 'previous', 'value', 'analyst-inputs', 'previous');
edge(specification, 'analyst-inputs', 'value', 'analyst', 'files');

// The junior Analyst may normalize documents only after the senior's first draft/decisions.
specification.edges = specification.edges.filter(item => !(item.source.nodeId === 'analyst' && item.target.nodeId === 'prepare'));
specification.nodes.push(
  { id: 'junior-prompt', type: 'prompt-template', config: { slots: [{ id: 'decisions' }], template: [
    'Apply documentation corrections to the senior Analyst bundle attached at its supplied paths. Preserve the senior decisions and all requirement, interface, scope and test obligations. Correct headings, schema formatting, cross-references, normative closure declarations and role IDs. Do not edit application source or pilot tooling.',
    'Senior Analyst summary and decisions:\n{{decisions}}',
    `Write SPEC.md, spec-index.json and implementation-map.json in the working directory and run node ${JSON.stringify(validatorPath)} before returning.`,
    'If correction needs a new semantic decision, preserve the senior draft and state the exact unresolved point in your summary; do not invent a decision. The developer reviewer must reject an unresolved semantic blocker.',
  ].join('\n\n') } },
  { id: 'junior-analyst', type: 'agent', config: { ...junior, contextId: 'junior-history', timeoutSeconds: 600, output: { format: 'text' }, attachFiles: true, captures: ['SPEC.md', 'spec-index.json', 'implementation-map.json'] } },
);
edge(specification, 'analyst', 'text', 'junior-prompt', 'decisions');
edge(specification, 'junior-prompt', 'text', 'junior-analyst', 'prompt');
edge(specification, 'analyst', 'files', 'junior-analyst', 'files');
edge(specification, 'junior-analyst', 'files', 'prepare', 'subject');
// The review sees the junior summary as well as the immutable final bundle.
node(specification, 'readiness-prompt').config.slots.push({ id: 'junior' });
node(specification, 'readiness-prompt').config.template += '\n\nJunior documentation summary (untrusted evidence):\n{{junior}}\n\nReview implementation feasibility AND testability, full UI inventory coverage, original business scope, ordered file ownership and real verification commands. Reject unresolved semantic questions. Route specification blockers to ownerRole analyst.';
edge(specification, 'junior-analyst', 'text', 'readiness-prompt', 'junior');

const decisionGuide = '\n\nRead the attached immutable files at their supplied absolute paths. SUBJECT.json gives the exact subjectId and your role. Return the complete ReviewDecision JSON with scopeRefs, resolvedIssueIds and issues arrays. Resolve only IDs listed as resolvable for your slot. Never modify reviewed files or invent evidence.';
node(specification, 'readiness-prompt').config.template += decisionGuide;
node(delivery, 'quality-prompt').config.template += '\n\nCheck that code, independent tests and docs satisfy the full shadcn/ui scope and that all required checks actually ran on the selected candidate. Distinguish source/test defects from missing environment evidence.' + decisionGuide;
node(delivery, 'final-customer-prompt').config.template = 'Review the complete business delivery as the senior Analyst, using the full immutable candidate, public requirements, captured UI evidence and engine check summaries.\n\nReview plan (JSON):\n{{plan}}\n\nYou are the same senior Analyst who received the original business task. Accept the complete automated delivery only after mapping every approved business scenario and UI surface to actual evidence. List the operator desktop smoke as a remaining release check; this workflow cannot certify desktop behavior from browser evidence. Reject missing scope or invented results.\n\nOriginal business task:\n' + businessTask + decisionGuide;
node(delivery, 'triage-prompt').config.template += '\n\nUse captured evidence. Route code defects to implementer, test defects to test-author, documentation-only implementation corrections to junior-analyst and requirement/contract changes to specification revision. Use unknown when evidence is insufficient; never widen scope or erase a failure.';
splitPilotReviewers(workflow, reviewer);

// Provide readable layouts for the top-level graph and nested authoring/review stages.
function layout(graph) {
  const order = topologicalOrder(graph);
  const depths = new Map(order.map(id => [id, 0]));
  for (const id of order) for (const item of graph.edges.filter(item => item.source.nodeId === id))
    if (depths.has(item.target.nodeId)) depths.set(item.target.nodeId, Math.max(depths.get(item.target.nodeId), depths.get(id) + 1));
  const rows = new Map();
  graph.view = {};
  for (const item of graph.nodes) {
    const depth = depths.get(item.id) ?? -1;
    const row = rows.get(depth) || 0;
    rows.set(depth, row + 1);
    graph.view[item.id] = { x: depth * 330, y: row * 175 };
    if (item.type === 'loop') layout(item.config.body);
  }
}
layout(workflow);
Object.assign(workflow.view.delivery, { label: 'shadcn/ui delivery' });
Object.assign(specification.view.analyst, { label: 'Analyst · Sol · max' });
Object.assign(specification.view['junior-analyst'], { label: 'Documentation · Luna · max' });
Object.assign(specification.view['readiness-review'], { label: 'Code requirements review · Opus · medium' });
Object.assign(specification.view['testability-review'], { label: 'Test requirements review · Opus · medium' });
Object.assign(delivery.view['quality-review'], { label: 'Code review · Opus · medium' });
Object.assign(delivery.view['test-quality-review'], { label: 'Test review · Opus · medium' });
Object.assign(delivery.view['final-customer'], { label: 'Business acceptance · Sol · max' });
const validation = validateWorkflow(workflow);
assert.equal(validation.valid, true, JSON.stringify(validation.issues, null, 2));
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const branch = execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8' }).trim();
assert.equal(branch, 'codex/shadcn-ui', 'Prepare the pilot from its feature branch.');
mkdirSync(pilotRoot, { recursive: true });
writeFileSync(join(repo, outputPath), JSON.stringify(workflow, null, 2) + '\n');
const baseFiles = files.map(path => ({ path, sha256: hash(readFileSync(join(repo, path))) }));
const manifestPath = join(pilotRoot, 'base-manifest.json');
writeFileSync(manifestPath, JSON.stringify({ commit, branch, files: baseFiles }, null, 2) + '\n');
writeFileSync(validatorPath, [
  "import assert from 'node:assert/strict';",
  "import {createHash} from 'node:crypto';",
  `import {readFileSync} from 'node:fs';`,
  `import {join} from 'node:path';`,
  `const base=JSON.parse(readFileSync(${JSON.stringify(manifestPath)},'utf8'));`,
  `for(const file of base.files) assert.equal(createHash('sha256').update(readFileSync(join(${JSON.stringify(repo)},file.path))).digest('hex'),file.sha256,'Pinned base changed: '+file.path);`,
  pilotValidatorSource(implementation.roles).replace("import {readFileSync} from 'node:fs';\n", ''),
].join('\n'));
writeFileSync(join(pilotRoot, 'preparation.json'), JSON.stringify({
  workflowId: workflow.workflowId, workspaceId: 'deszo-development', branch, startingCommit: commit,
  workflowFile: outputPath, workflowFileSha256: hash(readFileSync(join(repo, outputPath))),
  preparedAt: new Date().toISOString(), sourceFiles: files.length, providerInvocations: 0,
  roles: { analyst, codeReviewer: { ...reviewer }, testReviewer: { ...reviewer }, testAuthor: author, developer: author, juniorAnalyst: junior },
  caveat: 'Prepared only. Model account access, real execution, browser evidence and the post-application desktop smoke are pending.',
}, null, 2) + '\n');
console.log(JSON.stringify({ valid: true, workflowId: workflow.workflowId, branch, startingCommit: commit,
  sourceFiles: files.length, workflowFile: outputPath, validator: pathToFileURL(validatorPath).href, providerInvocations: 0 }, null, 2));
