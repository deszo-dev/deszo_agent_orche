// Authorized subscription CLI audit. Uses explicit lightweight models; consumes quota.
// Run: node --disable-warning=ExperimentalWarning docs/reviews/reproducers/2026-10-13-real-cli-probes.mjs
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startRunner } from '../../../runtime/runner.mjs';
import { singleAgent } from '../../../runtime/tests/helpers.mjs';
const project = resolve(import.meta.dirname, '../../..');
const auditRoot = join(project, '.deszo/tests');
await mkdir(auditRoot, { recursive: true });
const textResume = process.argv.includes('--antigravity-text-resume');
const priorReport = textResume ? JSON.parse(await readFile(join(import.meta.dirname, '2026-10-13-real-cli-results.json'), 'utf8')) : null;
const root = priorReport?.root || await mkdtemp(join(auditRoot, 'real-cli-'));
const runner = await startRunner({ root });
const { port, token } = runner.connection;
const call = async (method, path, body) => {
  const response = await fetch(`http://127.0.0.1:${port}/api/v2${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text(); const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${method} ${path}: ${JSON.stringify(data)}`);
  return data;
};
const readArtifact = async ref => {
  const response = await fetch(`http://127.0.0.1:${port}/api/v2/artifacts/${ref.artifactId}`, { headers: { Authorization: `Bearer ${token}` } });
  return response.text();
};
const results = priorReport?.results || [];
try {
  for (const [provider, model] of [['claude', 'haiku'], ['antigravity', 'gemini-3.8-flash-low']]) {
    if (textResume && provider !== 'antigravity') continue;
    const workspaceId = `real-${provider}`;
    await call('PUT', `/workspaces/${workspaceId}`, { cwd: join(runner.connection.scratchRoot, workspaceId) });
    let bindingId = textResume ? priorReport.results.find(item => item.provider === 'antigravity' && item.bindingId)?.bindingId : undefined;
    for (const mode of textResume ? ['continue'] : ['new', 'continue']) {
      if (mode === 'continue' && !bindingId) break;
      const workflow = singleAgent({ id: `real-${provider}-${mode}`, provider, model, context: mode, bindingId, timeoutSeconds: 120,
        output: textResume ? { format: 'text' } : { format: 'json', schema: { type: 'object', additionalProperties: false, properties: { message: { type: 'string' } }, required: ['message'] } } });
      workflow.nodes.find(node => node.id === 'request').config.value = textResume
        ? 'What control word did I ask you to remember earlier in this conversation? Reply with only that plain word, no JSON or formatting. Do not use tools.'
        : mode === 'new'
        ? 'Remember the control word ORBIT for this conversation. Return {"message":"ORBIT"}. Do not use tools.'
        : 'What control word did I ask you to remember earlier in this conversation? Return it in the message field. Do not use tools.';
      const saved = await call('PUT', `/workflows/${workflow.workflowId}`, workflow);
      const created = await call('POST', '/runs', { workflowId: workflow.workflowId, workflowSnapshotSha256: saved.snapshotSha256, workspaceId, requestId: randomUUID() });
      let snapshot;
      do { await new Promise(done => setTimeout(done, 500)); snapshot = await call('GET', `/runs/${created.run.runId}`); }
      while (!['succeeded', 'failed', 'canceled', 'interrupted', 'waiting_for_user'].includes(snapshot.run.state));
      const agent = snapshot.instances.find(item => item.nodeId === 'agent');
      let answer = null;
      if (agent.outputs) {
        const manifest = JSON.parse(await readArtifact(agent.outputs));
        const raw = await readArtifact(manifest.values[textResume ? 'text' : 'json'].artifact);
        answer = textResume ? raw.trim() : JSON.parse(raw);
      }
      if (mode === 'new' && snapshot.run.state === 'succeeded') {
        const bindings = await call('GET', `/context-bindings?workspaceId=${workspaceId}`);
        bindingId = bindings.bindings.find(item => item.provider === provider)?.bindingId;
      }
      const failures = runner.engine.store.readEvents(snapshot.run.runId).filter(event => event.type === 'attempt.state_changed' && ['failed', 'blocked', 'interrupted'].includes(event.payload.to)).map(event => event.payload);
      const result = { provider, model, mode, format: textResume ? 'text' : 'json', runId: snapshot.run.runId, state: snapshot.run.state, answer, remembersControlWord: (textResume ? answer : answer?.message) === 'ORBIT', failures, bindingId: bindingId || null };
      results.push(result); console.log(JSON.stringify(result));
    }
  }
} finally {
  await writeFile(join(import.meta.dirname, '2026-10-13-real-cli-results.json'), JSON.stringify({ timestamp: new Date().toISOString(), root, results }, null, 2) + '\n');
  await runner.close();
}
