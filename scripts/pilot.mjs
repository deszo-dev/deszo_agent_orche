// A bounded, real-provider execution of the documented reference Delivery Loop.
// Unlike the test helpers, this uses the production provider adapters without overrides.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pilotValidatorSource } from './pilot-documents.mjs';
import assert from 'node:assert/strict';
import { startRunner } from '../runtime/runner.mjs';
import { defaultAdapters } from '../runtime/core/adapters.mjs';
import { createInterface } from 'node:readline';
import { temporaryUserMcpRegistration } from './authoring-test-support.mjs';

const repo = resolve(import.meta.dirname, '..');
const option = name => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const root = resolve(option('--root') || join(repo, '.deszo/pilots', new Date().toISOString().replace(/[:.]/g, '-')));
const wallMinutes = Number(option('--minutes') || 60);
assert.ok(wallMinutes > 0 && wallMinutes <= 120);
assert.ok(!existsSync(join(root, 'evidence/result.json')), 'Use a new pilot root to preserve earlier evidence.');
const evidence = join(root, 'evidence');
mkdirSync(evidence, { recursive: true });
const read = path => readFileSync(join(repo, path), 'utf8');
const json = path => JSON.parse(read(path));
const models = { codex: 'gpt-6-luna', claude: 'haiku', antigravity: 'gemini-3.8-flash-low' };
const diagnosticSchemaPrompt = process.argv.includes('--diagnostic-codex-schema-prompt');
const diagnosticAllSchemaPrompt = process.argv.includes('--diagnostic-schema-prompt');
const workflow = json('docs/examples/reference-delivery/workflow.json');
workflow.workflowId = 'pilot-reference-delivery';
const guide = [
  'Pilot environment: a small, synchronous Node.js service with no external dependencies. Use English for documents and messages.',
  'The base src/api.mjs is already prepared. Do not change its exports or implement code during documentation authoring.',
  'The examples below define the intended business scope, file names, role bindings and valid document formats. Author the three documents in the working directory. You may refine them to resolve real issues, keeping the small service scope and the listed role IDs.',
  'Remove obsolete example prose about the project being unprepared or supplied as documentation only. It is prepared for this pilot. Keep requirements and contracts complete and mutually consistent.',
  'Use exactly ## ID headings. Section dependencies must be acyclic. Every task must receive its full normative requirement/check closure through spec inputs and readScopes. Test-writing tasks must include CHECK-AUTH/CHECK-RESUME case coverage as appropriate. Utility verification runs only the approved node commands. Do not add build systems, libraries, unrelated endpoints or network checks.',
  'Allowed executor roles: implementer (Claude), test-author (Antigravity), reviewer (Codex), analyst (Codex), verification (engine verification template embedding analyst). Four file-writing tasks plus TASK-VERIFY are the intended task plan.',
  'Preserve the five task definitions from the starting implementation map unless a real blocker requires a change. Task dependsOn contains objects {taskId: "TASK-...", milestone: "accepted"}; it NEVER contains specification/check section IDs or strings. Specification dependencies belong to spec-index.json and spec references belong to task inputs/readScopes.',
  'Before returning, run node .pilot-validate.mjs in the working directory. This read-only validator checks both schemas, section headings, dependencies and the map semantics. Correct every reported problem until it exits 0. Do not modify the validator.',
  'On later iterations, read the attached prior bundle and resolve every supplied blocker, preserving stable section/task IDs where their meaning is unchanged. Record all content in the captured files; the final chat response is only a concise summary.',
  'Base src/api.mjs:\n' + read('docs/examples/round-recovery/project/src/api.mjs'),
  'Base fixtures/tokens.json:\n' + read('docs/examples/round-recovery/project/fixtures/tokens.json'),
  'Starting specification template:\n' + read('docs/examples/round-recovery/SPEC.md'),
  'Starting section index template:\n' + read('docs/examples/round-recovery/spec-index.json'),
  'Starting implementation map template:\n' + read('docs/examples/round-recovery/implementation-map.json'),
  'Section index JSON Schema:\n' + read('docs/schemas/spec-section-index.schema.json'),
  'Implementation map JSON Schema:\n' + read('docs/schemas/implementation-map.schema.json'),
].join('\n\n');
function configure(nodes) {
  for (const node of nodes) {
    if (node.type === 'agent') node.config.model = models[node.config.provider];
    if (node.type === 'loop') {
      node.config.limits.maxActiveMinutes = wallMinutes;
      configure(node.config.body.nodes);
    }
    if (node.type === 'prompt-template') {
      if (node.id === 'analysis-prompt') node.config.template += '\n\n' + guide;
      else if (node.id.endsWith('-prompt') && node.id !== 'triage-prompt') node.config.template += '\n\nRead the attached files at their supplied absolute paths. SUBJECT.json specifies the exact subjectId and role to return; do not invent IDs or roles. Judge concrete blockers within the documented scope. Do not create or change files in the workspace. Return the complete JSON decision, including empty scopeRefs/resolvedIssueIds/issues arrays when applicable. A resolvedIssueId must come from the current ReviewPlan openIssues.';
    }
    if (node.type === 'map') for (const role of node.config.roles) if (role.kind === 'agent') {
      role.model = models[role.provider];
      role.instructions += '\nUse English. Read the supplied specification sections and files. Never create configuration, Git metadata, documentation, dependency manifests or auxiliary files outside the listed outputs. Use only built-in Node.js modules and the existing synchronous createService interface. The final response must be one JSON object satisfying the supplied output schema.';
    }
  }
}
configure(workflow.nodes);
writeFileSync(join(evidence, 'workflow.json'), JSON.stringify(workflow, null, 2));
writeFileSync(join(evidence, 'configuration.json'), JSON.stringify({ startedAt: new Date().toISOString(), models, wallMinutes, adapters: diagnosticAllSchemaPrompt ? 'diagnostic-all-schema-prompt; original engine validation unchanged' : diagnosticSchemaPrompt ? 'diagnostic-codex-schema-prompt; original engine validation unchanged' : 'production', fixtureResponses: false }, null, 2));

// This opt-in diagnostic is NOT a production fix or a production acceptance result.
// The original schema still validates outputs in the engine. Only Codex's native schema flag
// is replaced with explicit prompt guidance so downstream stages can be exercised independently.
const adapters = diagnosticSchemaPrompt || diagnosticAllSchemaPrompt ? { ...defaultAdapters, buildInvocation: args => {
  if ((!diagnosticAllSchemaPrompt && args.provider !== 'codex') || !args.output.schema) return defaultAdapters.buildInvocation(args);
  return defaultAdapters.buildInvocation({ ...args, output: { format: 'json' },
    prompt: args.prompt + '\n\nDiagnostic JSON contract (validated in full by the engine):\n' + JSON.stringify(args.output.schema) });
} } : undefined;
const runner = await startRunner({ root, adapters });
const api = async (method, path, body, extraHeaders = {}) => {
  const response = await fetch(`http://127.0.0.1:${runner.connection.port}${path}`, {
    method, headers: { Authorization: `Bearer ${runner.connection.firstPartyToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(result)}`);
  return result;
};
const save = (name, value) => writeFileSync(join(evidence, name), JSON.stringify(value, null, 2));
let runId, snapshot, sequence = 0;
const registrationCleanups = [];
let controller = null;
const started = Date.now();
try {
  const capabilities = await api('GET', '/api/v2/capabilities');
  save('capabilities.json', capabilities);
  if (process.argv.includes('--authoring-registrations')) {
    const authoring = join(root, 'authoring', 'antigravity');
    const configPath = join(authoring, '.agents', 'mcp_config.json');
    mkdirSync(dirname(configPath), { recursive: true }); writeFileSync(configPath, '{}\n');
    for (const provider of ['codex', 'claude', 'antigravity']) {
      const server = { command: process.execPath, args: [resolve(repo, 'scripts/authoring-probe-server.mjs'),
        '--bridge', runner.connection.bridgeScript, '--evidence-file', join(evidence, `${provider}-managed-mcp.jsonl`),
        '--connection-file', runner.connection.connectionFile, '--client-provider', provider,
        ...(provider === 'antigravity' ? ['--working-directory', authoring, '--mcp-config-path', configPath] : [])] };
      registrationCleanups.push(temporaryUserMcpRegistration(provider, `deszo_pilot_${runId || randomUUID().slice(0, 8)}`, server));
    }
  }
  const workspace = await api('PUT', '/api/v2/workspaces/pilot', { cwd: join(runner.connection.scratchRoot, 'pilot') });
  for (const path of ['src/api.mjs', 'fixtures/tokens.json']) {
    const target = join(workspace.cwd, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, read('docs/examples/round-recovery/project/' + path));
  }
  // Prepared pilot tooling, excluded from the project's captured base and every task output.
  const roles = workflow.nodes.find(n => n.id === 'delivery').config.body.nodes.find(n => n.type === 'map').config.roles;
  writeFileSync(join(workspace.cwd, '.pilot-validate.mjs'), pilotValidatorSource(roles));
  const saved = await api('PUT', '/api/v3/workflows/' + workflow.workflowId, { requestId: randomUUID(), expectedEtag: null, workflow }, { 'If-None-Match': '*' });
  save('saved-workflow.json', saved);
  const created = await api('POST', '/api/v2/runs', { workflowId: workflow.workflowId, workflowSnapshotSha256: saved.snapshotSha256, workspaceId: 'pilot', requestId: randomUUID() });
  if (created.outcome === 'confirmation_pending') throw new Error(`Run request ${created.requestId} is pending; this isolated pilot launcher expected first-party direct execution.`);
  if (created.outcome !== 'created' || !created.run?.runId) throw new Error('The runtime returned an unsupported run outcome.');
  runId = created.run.runId;
  if (process.argv.includes('--controller-stdin')) {
    controller = createInterface({ input: process.stdin });
    controller.on('line', async line => {
      try {
        const command = JSON.parse(line);
        if (!['recovery', 'stop'].includes(command.action)) throw new Error('Only recovery and stop controller commands are supported.');
        const body = { ...(command.body || {}), requestId: command.body?.requestId || randomUUID() };
        const result = await api('POST', `/api/v2/runs/${runId}/${command.action}`, body);
        appendFileSync(join(evidence, 'controller-actions.jsonl'), JSON.stringify({ at: new Date().toISOString(), action: command.action, body, result }) + '\n');
        console.log(JSON.stringify({ phase: 'controller-result', action: command.action, result }));
      } catch (error) { console.log(JSON.stringify({ phase: 'controller-error', message: error.message })); }
    });
  }
  console.log(JSON.stringify({ phase: 'started', root, runId, models, wallMinutes }));
  const terminal = ['succeeded', 'failed', 'canceled', 'interrupted'];
  while (true) {
    snapshot = await api('GET', '/api/v2/runs/' + runId);
    const events = runner.engine.store.readEvents(runId, sequence);
    for (const event of events) {
      appendFileSync(join(evidence, 'journal.jsonl'), JSON.stringify(event) + '\n');
      sequence = event.sequence;
      if (event.type === 'run.state_changed' || event.type === 'gate.evaluated' || event.type === 'loop.iteration_started' || event.type === 'attempt.state_changed' && (event.payload.process || event.payload.to === 'failed')) console.log(JSON.stringify({ sequence, type: event.type, node: event.nodeInstanceId, payload: event.payload }));
    }
    const attempts = runner.engine.store.all('SELECT * FROM attempts WHERE run_id = ? ORDER BY rowid', runId);
    save('status.json', { runId, root, elapsedSeconds: (Date.now() - started) / 1000, run: snapshot.run, active: attempts.filter(a => !['succeeded', 'failed', 'canceled', 'interrupted', 'skipped'].includes(a.state)), failures: attempts.filter(a => a.state === 'failed'), attemptCount: attempts.length, sequence });
    save('snapshot.json', snapshot);
    save('attempts.json', attempts);
    if (terminal.includes(snapshot.run.state)) break;
    if (Date.now() - started > wallMinutes * 60_000) {
      await api('POST', '/api/v2/runs/' + runId + '/stop', { requestId: randomUUID() });
      console.log(JSON.stringify({ phase: 'wall_limit', wallMinutes }));
    }
    await new Promise(done => setTimeout(done, 2000));
  }
  const result = { runId, state: snapshot.run.state, elapsedSeconds: (Date.now() - started) / 1000, root, models, finalSequence: sequence };
  if (snapshot.run.state === 'succeeded') {
    const output = (id, port) => {
      const item = snapshot.instances.find(item => item.nodeInstanceId === id);
      const manifest = runner.engine.store.readJson(item.outputs.artifactId);
      return runner.engine.store.readJson(manifest.values[port].artifact.artifactId);
    };
    const acceptance = output('acceptance', 'value');
    const certificate = runner.engine.store.readJson(acceptance.artifact.artifactId);
    assert.equal(certificate.subjectKind, 'delivery');
    assert.equal(certificate.prerequisites.length, 2);
    const technical = runner.engine.store.readJson(certificate.prerequisites[1].artifact.artifactId);
    assert.equal(technical.subject.sha256, certificate.subject.sha256);
    save('acceptance.json', certificate);
    const subject = runner.engine.store.readJson(certificate.subject.artifactId);
    save('delivery-subject.json', subject);
    const deliveryEntry = subject.entries.find(e => e.path === 'DELIVERY.json');
    save('delivery.json', runner.engine.store.readJson(deliveryEntry.artifact.artifactId));
    for (const entry of subject.entries) {
      const target = join(evidence, 'accepted-delivery', entry.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, runner.engine.store.readBytes(entry.artifact.artifactId).bytes);
    }
    save('candidate.json', output('candidate', 'value'));
    result.acceptance = acceptance;
    result.candidate = output('candidate', 'value');
  }
  save('result.json', result);
  console.log(JSON.stringify({ phase: 'finished', ...result }));
  if (snapshot.run.state !== 'succeeded') process.exitCode = 1;
} catch (error) {
  save('harness-error.json', { runId, message: error.message, stack: error.stack });
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  controller?.close();
  await runner.close();
  for (const cleanup of registrationCleanups.reverse()) cleanup();
}
