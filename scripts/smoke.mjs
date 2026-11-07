// Real-provider M1 check: runs the documented Codex → Claude → Codex Context chain.
// It consumes subscription quota. Models are never guessed:
//   npm run smoke -- --codex <model-id> --claude <model-id>
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startRunner } from '../runtime/runner.mjs';

const option = name => { const index = process.argv.indexOf(`--${name}`); return index < 0 ? undefined : process.argv[index + 1]; };
const models = { codex: option('codex'), claude: option('claude') };
if (!models.codex || !models.claude) {
  console.error('Usage: npm run smoke -- --codex <model-id> --claude <model-id>\nBoth model IDs are required; the smoke check never chooses a model for you.');
  process.exit(2);
}

const root = option('root') ? resolve(option('root')) : resolve(import.meta.dirname, '../.deszo/smoke', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
const runner = await startRunner({ root });
const { port, firstPartyToken } = runner.connection;
const call = async (method, path, body, extraHeaders = {}) => {
  const endpoint = path.startsWith('/api/') ? path : `/api/v2${path}`;
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, { method, headers: { Authorization: `Bearer ${firstPartyToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${data.message}`);
  return data;
};

let report;
try {
  const capabilities = await call('GET', '/capabilities');
  for (const provider of ['codex', 'claude']) {
    const record = capabilities.providers.find(item => item.provider === provider);
    if (!record.available) throw new Error(`${provider} is unavailable: ${record.reason}`);
  }
  await call('PUT', '/workspaces/smoke', { cwd: join(runner.connection.scratchRoot, 'smoke') });
  const workflow = JSON.parse(await readFile(resolve(import.meta.dirname, '../docs/examples/m1-context-chain/workflow.json'), 'utf8'));
  workflow.workflowId = 'smoke-context-chain';
  for (const node of workflow.nodes) if (node.type === 'agent') node.config.model = models[node.config.provider];
  const draftPath = `/api/v4/workflows/${workflow.workflowId}/draft`;
  const draft = await call('PUT', draftPath, { requestId: randomUUID(), workflow }, { 'If-None-Match': '*' });
  const validation = await call('POST', `${draftPath}/validate`, {}, { 'If-Match': draft.etag });
  if (!validation.validation.valid) throw new Error(`Workflow invalid: ${JSON.stringify(validation.validation.issues)}`);
  const published = await call('POST', `/api/v4/workflows/${workflow.workflowId}/publish`, { requestId: randomUUID() }, { 'If-Match': draft.etag });
  const accepted = await call('POST', '/runs', { workflowId: workflow.workflowId, publishedVersionId: published.publishedVersionId,
    definitionDigest: published.definitionDigest, workflowSnapshotSha256: published.snapshotSha256, workspaceId: 'smoke', requestId: randomUUID() });
  if (accepted.outcome !== 'created' || !accepted.run?.runId) throw new Error('The runtime returned an unsupported run outcome.');
  const runId = accepted.run.runId;
  console.log(`Run ${runId} started; waiting for completion…`);
  let snapshot;
  do { await new Promise(done => setTimeout(done, 1000)); snapshot = await call('GET', `/runs/${runId}`); }
  while (!['succeeded', 'failed', 'canceled', 'interrupted'].includes(snapshot.run.state));
  const viewer = snapshot.instances.find(item => item.nodeId === 'answer');
  report = { root, runId, state: snapshot.run.state, models, instances: snapshot.instances.map(item => ({ node: item.nodeId, state: item.state })), viewerOutputs: viewer.outputs };
  console.log(JSON.stringify(report, null, 2));
  await writeFile(join(root, 'smoke-results.json'), JSON.stringify(report, null, 2));
  process.exitCode = snapshot.run.state === 'succeeded' ? 0 : 1;
} catch (error) {
  console.error(error.message); process.exitCode = 1;
} finally {
  await runner.close();
}
