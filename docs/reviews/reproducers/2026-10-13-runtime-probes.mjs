// Independent review probes. No network calls or production source changes.
// Run: node --disable-warning=ExperimentalWarning docs/reviews/reproducers/2026-10-13-runtime-probes.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../../runtime/core/store.mjs';
import { sha256 } from '../../../runtime/core/canonical.mjs';
import { createParser } from '../../../runtime/core/adapters.mjs';
import { startTestRunner, singleAgent, fixtureAdapters } from '../../../runtime/tests/helpers.mjs';

const root = resolve(import.meta.dirname, '../../..');
const fixture = join(import.meta.dirname, '2026-10-13-cli-fixture.mjs');
const output = async (api, snapshot, id) => api.artifactJson(snapshot.instances.find(item => item.nodeId === id).outputs.artifactId);
const finish = async (api, workflow) => {
  const created = await api.run(workflow);
  assert.equal(created.status, 202, JSON.stringify(created.body));
  const snapshot = await api.waitFor(created.body.run.runId);
  assert.equal(snapshot.run.state, 'succeeded', JSON.stringify(snapshot.instances));
  return snapshot;
};

if (process.argv.includes('--capture-fault')) {
  const api = await startTestRunner();
  await api.workspace();
  const original = api.runner.engine.store.putBytes.bind(api.runner.engine.store);
  api.runner.engine.store.putBytes = (bytes, mediaType, ...rest) => {
    if (mediaType === 'application/octet-stream') {
      const error = new Error('Audit-injected ENOSPC while capturing CLI output');
      error.code = 'ENOSPC';
      throw error;
    }
    return original(bytes, mediaType, ...rest);
  };
  const created = await api.run(singleAgent({ id: 'audit-capture-fault', model: 'fixture-noisy' }));
  console.log(JSON.stringify({ root: api.root, runId: created.body.run.runId }));
  await api.waitFor(created.body.run.runId);
  await api.close();
  process.exit(0);
}

const results = [];
{
  const migrationRoot = mkdtempSync(join(root, '.deszo/tests/migration-cut-'));
  mkdirSync(join(migrationRoot, 'store'), { recursive: true });
  const db = new DatabaseSync(join(migrationRoot, 'store/state.sqlite'));
  const ddl = readFileSync(join(root, 'docs/storage/m1.sql'), 'utf8');
  db.exec(ddl);
  db.prepare('INSERT INTO schema_migrations(version,sha256,applied_at) VALUES (?,?,?)').run(1, sha256(Buffer.from(ddl)), new Date().toISOString());
  // Simulate a process exit after m2.sql COMMIT, before Store.migrate records version 2.
  db.exec(readFileSync(join(root, 'docs/storage/m2.sql'), 'utf8'));
  db.close();
  let error = null;
  try { const store = new Store(migrationRoot); store.db.close(); } catch (caught) { error = caught.message; }
  results.push({ probe: 'migration-commit-before-version', root: migrationRoot, restartFails: error !== null, error });
}
{
  const api = await startTestRunner({ runner: { adapters: {
    ...fixtureAdapters('unused'),
    buildInvocation: ({ prompt, cwd }) => ({ command: process.execPath, args: [fixture], stdin: prompt, cwd, env: process.env }),
  } } });
  try {
    await api.workspace();
    const snapshot = await finish(api, singleAgent({ id: 'audit-utf8' }));
    const manifest = await output(api, snapshot, 'agent');
    const actual = await api.artifactText(manifest.values.text.artifact.artifactId);
    results.push({ probe: 'split-utf8', expected: 'Hello, 🌍', actual, corrupted: actual !== 'Hello, 🌍', runId: snapshot.run.runId, root: api.root });
  } finally { await api.close(); }
}

{
  const api = await startTestRunner({ runner: { adapters: {
    ...fixtureAdapters('unused'), createParser,
    buildInvocation: ({ prompt, cwd }) => ({ command: process.execPath, args: [fixture, 'antigravity-stale'], stdin: prompt, cwd, env: process.env }),
  } } });
  try {
    await api.workspace();
    const snapshot = await finish(api, singleAgent({ id: 'audit-antigravity-stale', provider: 'antigravity' }));
    const manifest = await output(api, snapshot, 'agent');
    const actual = await api.artifactText(manifest.values.text.artifact.artifactId);
    results.push({ probe: 'antigravity-text-prefers-old-structured-output', expected: 'ORBIT\n', actual, staleOutputCommitted: actual !== 'ORBIT\n', runId: snapshot.run.runId, root: api.root });
  } finally { await api.close(); }
}

const slots = [{ id: 'customer', role: 'customer', view: 'public', provider: 'codex' }, { id: 'readiness', role: 'implementation-readiness', view: 'full', provider: 'claude' }];
const policy = { slots: slots.map(({ provider, ...slot }) => slot) };
function reviews({ id, prior, instructions = 'Review policy A.', nativeConfiguration = 'restricted' }) {
  const nodes = [], edges = [];
  const edge = (from, fromPort, to, toPort) => edges.push({ id: `${from}-${fromPort}-${to}-${toPort}`.slice(0, 64), source: { nodeId: from, port: fromPort }, target: { nodeId: to, port: toPort } });
  nodes.push(
    { id: 'docs', type: 'file-input', config: { mode: 'files', paths: ['SPEC.md', 'spec-index.json', 'implementation-map.json'] } },
    { id: 'seed', type: 'merge', config: { mode: 'record', inputs: [], fields: [{ name: 'issues', source: { literal: [] } }, { name: 'none', source: { literal: null } }] } },
    { id: 'issue-list', type: 'json-select', config: { pointer: '/issues', outputType: 'JsonValue' } },
    { id: 'prepare', type: 'gate', config: { mode: 'prepare', policy, carry: true } },
    { id: 'plan-text', type: 'json-select', config: { pointer: '', outputType: 'Text', render: 'canonical-json' } },
    { id: 'evaluate', type: 'gate', config: { mode: 'evaluate', policy } },
    { id: 'instructions', type: 'text', config: { value: instructions } },
    { id: 'answer', type: 'result-viewer', config: {} },
  );
  edge('seed', 'value', 'issue-list', 'value'); edge('docs', 'value', 'prepare', 'subject'); edge('issue-list', 'value', 'prepare', 'issues'); edge('prepare', 'plan', 'plan-text', 'value');
  if (prior) {
    nodes.push({ id: 'prior', type: 'file-input', config: { mode: 'artifact', valueType: 'JsonValue', artifact: prior } });
    edge('prior', 'value', 'prepare', 'prior');
  } else {
    nodes.push({ id: 'prior', type: 'json-select', config: { pointer: '/none', outputType: 'JsonValue' } });
    edge('seed', 'value', 'prior', 'value'); edge('prior', 'value', 'prepare', 'prior');
  }
  for (const slot of slots) {
    const s = slot.id;
    nodes.push(
      { id: `${s}-route`, type: 'route', config: { valueType: 'JsonValue', selector: '/needsReview', cases: [{ id: 'live', equals: true }, { id: 'carried', equals: false }], onUnmatched: 'error' } },
      { id: `${s}-status`, type: 'json-select', config: { pointer: '/status', outputType: 'Text', render: 'raw-string' } },
      { id: `${s}-prompt`, type: 'prompt-template', config: { template: `Review the specification. {{instructions}}\n\nReview plan (JSON):\n{{plan}}\n\nStatus: {{status}}\nReturn a ReviewDecision.`, slots: [{ id: 'instructions' }, { id: 'plan' }, { id: 'status' }] } },
      { id: `${s}-review`, type: 'agent', config: { provider: slot.provider, model: 'fixture-reviewer-approve-1', timeoutSeconds: 60, output: { format: 'json' }, attachFiles: true } },
      { id: `${s}-carry`, type: 'json-select', config: { pointer: '/carry', outputType: 'JsonValue' } },
      { id: `${s}-decision`, type: 'merge', config: { mode: 'selected', valueType: 'JsonValue', inputs: [{ id: 'live' }, { id: 'carried' }] } },
    );
    edge('prepare', `${s}-need`, `${s}-route`, 'selector'); edge('prepare', `${s}-need`, `${s}-route`, 'value');
    edge(`${s}-route`, 'live', `${s}-status`, 'value'); edge('plan-text', 'value', `${s}-prompt`, 'plan'); edge(`${s}-status`, 'value', `${s}-prompt`, 'status');
    edge('instructions', 'text', `${s}-prompt`, 'instructions'); edge(`${s}-prompt`, 'text', `${s}-review`, 'prompt'); edge('prepare', s, `${s}-review`, 'files');
    edge(`${s}-route`, 'carried', `${s}-carry`, 'value'); edge(`${s}-review`, 'json', `${s}-decision`, 'live'); edge(`${s}-carry`, 'value', `${s}-decision`, 'carried'); edge(`${s}-decision`, 'value', 'evaluate', s);
  }
  edge('prepare', 'subject', 'evaluate', 'subject'); edge('prepare', 'plan', 'evaluate', 'plan'); edge('evaluate', 'certificate', 'answer', 'value');
  return { schemaVersion: 1, workflowId: id, capabilities: ['core-v1', 'loops-v1', 'pipeline-v1', 'delivery-v1', 'revisions-v1'], settings: { nativeConfiguration }, nodes, edges, after: [] };
}
{
  const api = await startTestRunner();
  try {
    const workspace = await api.workspace();
    for (const name of ['SPEC.md', 'spec-index.json', 'implementation-map.json']) {
      let text = readFileSync(join(root, 'docs/examples/round-recovery', name), 'utf8');
      if (name === 'SPEC.md') text = text.replace('## BUSINESS-TASK\n', '## BUSINESS-TASK\n\nRevision 1.\n');
      mkdirSync(dirname(join(workspace.cwd, name)), { recursive: true }); writeFileSync(join(workspace.cwd, name), text);
    }
    const first = await finish(api, reviews({ id: 'audit-reviews-original' }));
    const prior = (await output(api, first, 'evaluate')).values.certificate.artifact;
    for (const change of [{ probe: 'changed-upstream-instructions', instructions: 'Review policy B: reject this specification.' }, { probe: 'changed-native-profile', nativeConfiguration: 'inherit' }]) {
      const snapshot = await finish(api, reviews({ id: `audit-${change.probe}`, prior, ...change }));
      const agents = snapshot.instances.filter(item => item.nodeId.endsWith('-review')).map(item => ({ node: item.nodeId, state: item.state }));
      const certificate = await api.artifactJson((await output(api, snapshot, 'evaluate')).values.certificate.artifact.artifactId);
      results.push({ probe: change.probe, agents, carriedWithoutReview: agents.every(item => item.state === 'skipped'), certificate, runId: snapshot.run.runId, root: api.root });
    }
  } finally { await api.close(); }
}
{
  const captured = await new Promise(resolvePromise => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', process.argv[1], '--capture-fault'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data.toString(); }); child.stderr.on('data', data => { stderr += data.toString(); });
    child.once('close', (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
  results.push({ probe: 'capture-write-failure', ...captured, crashed: captured.code !== 0 && captured.stderr.includes('ENOSPC') });
}
const report = { timestamp: new Date().toISOString(), results };
writeFileSync(join(import.meta.dirname, '2026-10-13-runtime-probe-results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
