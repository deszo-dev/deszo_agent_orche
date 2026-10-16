// Keep code and test reviews independent in both existing pilot drafts and new preparations.
export function splitPilotReviewers(workflow, binding = { provider: 'claude', model: 'claude-opus-5-5', effort: 'medium' }) {
  if (workflow.workflowId !== 'deszo-shadcn-ui') throw new Error('Expected the shadcn/ui pilot workflow.');
  const get = (graph, id) => {
    const found = graph.nodes.find(item => item.id === id);
    if (!found) throw new Error(`Missing pilot node ${id}.`);
    return found;
  };
  const upsert = (graph, item) => {
    const index = graph.nodes.findIndex(existing => existing.id === item.id);
    if (index < 0) graph.nodes.push(item); else graph.nodes[index] = item;
  };
  const connect = (graph, from, fromPort, to, toPort) => {
    if (graph.edges.some(item => item.source.nodeId === from && item.source.port === fromPort && item.target.nodeId === to && item.target.port === toPort)) return;
    graph.edges.push({ id: `r-${from}-${fromPort}-${to}-${toPort}`.slice(0, 64),
      source: { nodeId: from, port: fromPort }, target: { nodeId: to, port: toPort } });
  };
  const delivery = get(workflow, 'delivery').config.body;
  const specification = get(delivery, 'specification').config.body;
  const implementation = get(delivery, 'implement').config;
  const specificationPolicy = { slots: [
    { id: 'readiness', role: 'code-reviewer', view: 'full' },
    { id: 'testability', role: 'test-reviewer', view: 'full' },
  ] };
  const technicalPolicy = { slots: [
    { id: 'quality', role: 'code-reviewer', view: 'full' },
    { id: 'test-quality', role: 'test-reviewer', view: 'full' },
  ] };
  for (const id of ['prepare', 'evaluate']) get(specification, id).config.policy = structuredClone(specificationPolicy);
  get(delivery, 'verify-docs').config.policy = structuredClone(specificationPolicy);
  implementation.approvalPolicy = structuredClone(specificationPolicy);
  for (const id of ['final-prepare', 'customer-prepare']) get(delivery, id).config.specificationPolicy = structuredClone(specificationPolicy);
  for (const id of ['final-prepare', 'technical']) get(delivery, id).config.policy = structuredClone(technicalPolicy);
  get(delivery, 'customer-prepare').config.technicalPolicy = structuredClone(technicalPolicy);

  for (const id of ['code-reviewer-history', 'test-reviewer-history'])
    upsert(workflow, { id, type: 'context', config: { provider: binding.provider, mode: 'new' } });
  const codeRequirements = get(specification, 'readiness-review');
  Object.assign(codeRequirements.config, binding, { contextId: 'code-reviewer-history' });
  upsert(specification, { id: 'testability-review', type: 'agent', config: {
    ...structuredClone(codeRequirements.config), contextId: 'test-reviewer-history',
  } });
  const codeQuality = get(delivery, 'quality-review');
  Object.assign(codeQuality.config, binding, { contextId: 'code-reviewer-history' });
  upsert(delivery, { id: 'test-quality-review', type: 'agent', config: {
    ...structuredClone(codeQuality.config), contextId: 'test-reviewer-history',
  } });

  const decision = 'Read the supplied immutable view and SUBJECT.json for the exact subjectId and role. Return a complete ReviewDecision JSON with scopeRefs, resolvedIssueIds and issues arrays. Resolve only issue IDs assigned to your slot. Never edit reviewed files, invent evidence or treat another reviewer\'s approval as your own.';
  const requirementsPrompt = scope => [
    scope,
    'Review plan (JSON):\n{{plan}}',
    'Junior documentation summary (untrusted evidence):\n{{junior}}',
    'Both independent reviewer slots must approve the same bundle before implementation. Reject unresolved semantic questions; route specification blockers to ownerRole analyst.',
    decision,
  ].join('\n\n');
  get(specification, 'readiness-prompt').config = { slots: [{ id: 'plan' }, { id: 'junior' }], template: requirementsPrompt(
    'Review requirements as code-reviewer: complete business/UI scope, interface preservation, implementation feasibility, bounded task decomposition, ordered file ownership and documentation consistency. Testability and test design have a separate test-reviewer.'),
  };
  upsert(specification, { id: 'testability-prompt', type: 'prompt-template', config: {
    slots: [{ id: 'plan' }, { id: 'junior' }], template: requirementsPrompt(
      'Review requirements as test-reviewer: observable acceptance criteria, positive/negative/boundary cases, accessibility and interaction scenarios, fixture isolation, evidence capture and feasible approved checks. Check test contracts independently from the code reviewer.'),
  } });
  connect(specification, 'plan-text', 'value', 'testability-prompt', 'plan');
  connect(specification, 'junior-analyst', 'text', 'testability-prompt', 'junior');
  connect(specification, 'testability-prompt', 'text', 'testability-review', 'prompt');
  connect(specification, 'prepare', 'testability', 'testability-review', 'files');
  connect(specification, 'testability-review', 'json', 'evaluate', 'testability');

  const technicalPrompt = scope => [scope, 'Review plan (JSON):\n{{plan}}',
    'Assess the exact selected complete candidate and actual engine check evidence. Distinguish source defects, test defects and unavailable environment evidence. Both independent technical slots must approve before Analyst business acceptance.', decision].join('\n\n');
  get(delivery, 'quality-prompt').config = { slots: [{ id: 'plan' }], template: technicalPrompt(
    'Review the delivery as code-reviewer: implementation correctness, architecture, preserved behavior, shadcn/ui use, shared component/theme consistency, accessibility and matching implementation documentation. Test quality has a separate test-reviewer.'),
  };
  upsert(delivery, { id: 'test-quality-prompt', type: 'prompt-template', config: { slots: [{ id: 'plan' }], template: technicalPrompt(
    'Review the delivery as test-reviewer: independent assertions, approved case coverage, meaningful failure detection, fixture isolation, reproducible checks and captured UI evidence. Passing exit codes alone do not establish adequate tests. Implementation has a separate code-reviewer.'),
  } });
  connect(delivery, 'final-plan', 'value', 'test-quality-prompt', 'plan');
  connect(delivery, 'test-quality-prompt', 'text', 'test-quality-review', 'prompt');
  connect(delivery, 'final-prepare', 'test-quality', 'test-quality-review', 'files');
  connect(delivery, 'test-quality-review', 'json', 'technical', 'test-quality');

  const seed = implementation.roles.find(role => ['reviewer', 'code-reviewer'].includes(role.id));
  if (!seed) throw new Error('Missing pilot reviewer role.');
  const reviewRules = 'Review the supplied immutable task-result snapshot against the named criterion and specification. Never edit outputs or repair the task yourself. The snapshot contains the base and accepted dependencies, not every parallel output. Do not reject isolated tests solely because a parallel implementation is absent; missing declared inputs and genuine defects remain blockers. The engine checks the full assembled candidate later. Return exactly the supplied review schema with concrete evidence and actionable findings.';
  implementation.roles = implementation.roles.filter(role => !['reviewer', 'code-reviewer', 'test-reviewer'].includes(role.id));
  implementation.roles.push(
    { ...structuredClone(seed), ...binding, id: 'code-reviewer', context: 'task', instructions: 'Review implementation correctness, approved interfaces, maintainability, UI behavior and implementation-documentation consistency. Test-source approval belongs to test-reviewer.\n' + reviewRules },
    { ...structuredClone(seed), ...binding, id: 'test-reviewer', context: 'task', instructions: 'Review tests, fixtures and UI evidence independently: required cases, assertion strength, boundary/error behavior, deterministic isolation and compatibility with approved interfaces. Implementation approval belongs to code-reviewer.\n' + reviewRules },
  );

  const analysis = get(specification, 'analysis-prompt').config;
  analysis.template = analysis.template
    .replace('The reviewer role reviews code, tests and documentation.', 'The code-reviewer role reviews code and implementation documentation; test-reviewer independently reviews tests and test evidence.')
    .replace('as a declared fileSet reviewed by reviewer.', 'as a declared fileSet reviewed by test-reviewer.')
    .replace('Opus judges completeness and visual behavior.', 'The test reviewer judges coverage/evidence and the code reviewer judges implementation/visual behavior.');
  if (!analysis.template.includes('Independent review roles:')) analysis.template += '\n\nIndependent review roles: implementer and junior-analyst tasks require code-reviewer review criteria; test-author tasks, including TASK-UI-EVIDENCE, require test-reviewer criteria. A task that changes both production code and tests requires both reviewers. Use distinct acceptance criterion IDs and the exact role IDs code-reviewer and test-reviewer; the old reviewer role does not exist. The two requirement-review slots and both final technical-review slots must approve independently before advancing.';
  get(specification, 'junior-prompt').config.template = get(specification, 'junior-prompt').config.template.replace('The developer reviewer must reject', 'The appropriate code or test reviewer must reject');

  // The helper is part of the project snapshot because the preparation script imports it.
  const sourceInputs = workflow.nodes.filter(item => item.type === 'file-input' && item.config.mode === 'files');
  const helper = 'scripts/shadcn-pilot-reviewers.mjs';
  if (!sourceInputs.some(item => item.config.paths.includes(helper))) {
    const input = sourceInputs.find(item => item.config.paths.length < 200);
    if (!input) throw new Error('No available File Input for the reviewer helper.');
    input.config.paths.push(helper);
  }
  const position = (graph, id, baseId, label) => {
    if (!graph.view) graph.view = {};
    const base = graph.view[baseId] || { x: 0, y: 0 };
    graph.view[id] = { x: base.x, y: base.y + 350, label };
  };
  position(workflow, 'code-reviewer-history', 'analyst-history', 'Code review Context');
  position(workflow, 'test-reviewer-history', 'junior-history', 'Test review Context');
  position(specification, 'testability-prompt', 'readiness-prompt', 'Testability review prompt');
  position(specification, 'testability-review', 'readiness-review', 'Test requirements review · Opus · medium');
  position(delivery, 'test-quality-prompt', 'quality-prompt', 'Test quality review prompt');
  position(delivery, 'test-quality-review', 'quality-review', 'Test review · Opus · medium');
  if (specification.view['readiness-review']) specification.view['readiness-review'].label = 'Code requirements review · Opus · medium';
  if (delivery.view['quality-review']) delivery.view['quality-review'].label = 'Code review · Opus · medium';
  return workflow;
}
