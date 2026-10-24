// Audit a real Owner-authorized Run pinned to the exact Published Version selected by the MCP client.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

const option = key => { const i = process.argv.indexOf(key); return i < 0 ? undefined : process.argv[i + 1]; };
const root = resolve(option('--root'));
const provider = option('--provider');
const descriptor = JSON.parse(readFileSync(resolve(option('--connection-file'))));
const requestReport = JSON.parse(readFileSync(join(root, readdirSync(root).find(f => f.startsWith(`${provider}-request-`) && f.endsWith('-result.json')))));
const get = async (path, raw = false) => {
  const response = await fetch(`http://127.0.0.1:${descriptor.port}${path}`, { headers: { Authorization: `Bearer ${descriptor.token}` }, signal: AbortSignal.timeout(15_000) });
  assert.ok(response.ok, `HTTP ${response.status} for ${path}`);
  return raw ? Buffer.from(await response.arrayBuffer()) : response.json();
};
const readRef = async ref => {
  const bytes = await get(`/api/v2/artifacts/${ref.artifactId}?maxBytes=524288`, true);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), ref.sha256);
  return bytes;
};
const runId = requestReport.request?.runId || requestReport.runId;
assert.ok(runId, 'The authoring request report must contain the directly admitted Run ID.');
const deadline = Date.now() + 300_000;
let snapshot;
while (Date.now() < deadline) {
  snapshot = await get(`/api/v2/runs/${runId}`);
  if (snapshot.run.state === 'succeeded') break;
  assert.ok(['queued', 'running'].includes(snapshot.run.state), `Run ${runId} ended or paused as ${snapshot.run.state}.`);
  await new Promise(done => setTimeout(done, 1000));
}
assert.equal(snapshot?.run.state, 'succeeded', 'The Owner-authorized real Run did not complete in five minutes.');
assert.equal(snapshot.run.publishedVersion.publishedVersionId, requestReport.request.publishedVersionId);
const events = []; let after = 0;
for (;;) {
  const page = await get(`/api/v2/runs/${request.runId}/events/page?afterSequence=${after}&limit=200`);
  events.push(...page.items);
  if (!page.nextCursor) break;
  after = page.nextCursor;
}
events.forEach((event, index) => assert.equal(event.sequence, index + 1));
const invocations = [];
for (const event of events.filter(e => e.type === 'attempt.invocation_committed')) {
  const manifest = JSON.parse(await readRef(event.payload.manifest));
  assert.equal(manifest.environmentPolicy, 'subscription-only');
  assert.notEqual(manifest.managedToolIsolation.mechanism, 'fixture-cli');
  invocations.push({ attemptId: manifest.attemptId, provider: manifest.provider, requestedModel: manifest.requestedModel,
    cliVersion: manifest.cliVersion, managedToolIsolation: manifest.managedToolIsolation });
}
assert.deepEqual(invocations.map(i => i.provider).sort(), ['antigravity', 'claude', 'codex']);
assert.equal(snapshot.instances.length, 5);
assert.ok(snapshot.instances.every(i => i.state === 'succeeded'));
const workflow = await get(`/api/v4/workflows/${requestReport.workflowId}/versions/${requestReport.request.version}`);
const viewerId = workflow.workflow.nodes.find(n => n.type === 'result-viewer').id;
const viewer = snapshot.instances.find(i => i.nodeId === viewerId);
await readRef(viewer.outputs);
const viewerInputs = events.find(e => e.type === 'attempt.inputs_committed' && e.nodeInstanceId === viewer.nodeInstanceId);
assert.ok(viewerInputs);
const input = JSON.parse(await readRef(viewerInputs.payload.manifest));
const finalValue = input.values.value;
assert.equal(finalValue.type, 'Text');
const finalText = (await readRef(finalValue.artifact)).toString('utf8');
assert.ok(finalText.trim(), 'The final text artifact must be non-empty.');
const providerOutputs = [];
for (const invocation of invocations) {
  const event = events.find(e => e.type === 'attempt.outputs_committed' && e.attemptId === invocation.attemptId);
  const manifest = JSON.parse(await readRef(event.payload.manifest));
  const text = (await readRef(manifest.values.text.artifact)).toString('utf8');
  providerOutputs.push({ provider: invocation.provider, observedModel: manifest.providerResult?.observedModel,
    textSha256: manifest.values.text.artifact.sha256, textBytes: Buffer.byteLength(text) });
  // Only the first Agent receives the literal-output instruction. The following
  // Agents receive the previous answer as their complete prompt.
  if (invocation.provider === 'codex') assert.equal(text.trim(), 'DESZO_ACCEPTANCE_OK');
}
const runs = await get('/api/v2/runs?limit=200');
assert.equal(runs.items.filter(r => r.workflowId === requestReport.workflowId).length, 1);
const report = { passed: true, at: new Date().toISOString(), provider, workflowId: requestReport.workflowId,
  requestId: requestReport.requestId, runId, publishedVersionId: requestReport.request.publishedVersionId, state: snapshot.run.state, eventCount: events.length,
  contiguousJournal: true, exactlyOneRun: true, invocations, providerOutputs, viewerArtifact: viewer.outputs, finalArtifact: finalValue.artifact, finalText };
writeFileSync(join(root, `${provider}-run-result.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: true, provider, runId: request.runId, events: events.length, providers: invocations.map(i => i.provider) }));
