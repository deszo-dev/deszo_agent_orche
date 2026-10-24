import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startRunner } from '../runner.mjs';
import { classifyFailure, createParser } from '../core/adapters.mjs';
import { canonicalHash } from '../core/canonical.mjs';

export const fixture = resolve(import.meta.dirname, 'fixture-cli.mjs');
const testsRoot = resolve(import.meta.dirname, '../../.deszo/tests');

export function fixtureAdapters(stateDir, { unavailable = [], managedMcpPreflight = false } = {}) {
  return {
    detect: async provider => ({
      provider, available: !unavailable.includes(provider), cliPath: process.execPath, cliVersion: 'fixture-1', fixture: !managedMcpPreflight, accountIdentity: canonicalHash({ provider, account: 'fixture' }),
      supportsNew: true, supportsResume: true, supportsJson: true, supportsInheritedConfiguration: provider !== 'antigravity',
      reason: unavailable.includes(provider) ? 'Run "codex login" with a ChatGPT account.' : null,
    }),
    // The native schema file (when the engine sends one) lets the fixture enforce provider schema rules.
    buildInvocation: ({ provider, model, prompt, cwd, nativeSessionId, schemaPath }) => ({
      command: process.execPath, args: [fixture, model.replace(/^fixture-/, ''), nativeSessionId || '', stateDir, provider, schemaPath || ''], stdin: prompt, cwd, env: process.env,
    }),
    createParser: () => createParser('codex'),
    classifyFailure,
  };
}

export async function startTestRunner(options = {}) {
  await mkdir(testsRoot, { recursive: true });
  const root = options.root || await mkdtemp(join(testsRoot, 'root-'));
  const stateDir = join(root, 'fixture-state');
  const runner = await startRunner({ root, adapters: fixtureAdapters(stateDir, options), ...options.runner });
  const { port, token, firstPartyToken } = runner.connection;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await runner.close();
  };
  const callWithToken = async (bearer, method, path, body, { raw = false, headers = {} } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { Authorization: `Bearer ${bearer}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    if (raw) return response;
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  };
  const call = async (method, path, body, options) => {
    const result = await callWithToken(firstPartyToken, method, path, body, options);
    if (method === 'POST' && path === '/api/v2/runs' && result.status < 400) {
      if (result.body?.outcome === 'confirmation_pending') throw new Error('A fixture run unexpectedly requires in-app approval.');
      if (result.body?.outcome !== 'created' || !result.body.run?.runId) throw new Error('The runtime returned an unsupported run outcome.');
    }
    return result;
  };
  const callExternal = (method, path, body, options) => callWithToken(token, method, path, body, options);
  const callHost = runner.hostRequest ? runner.hostRequest.bind(runner) : async (method, path, body, options) => callWithToken('invalid-test-host-token', method, path, body, options);
  const workflowEtags = new Map();
  const workflowPublications = new Map();
  const withPublishedBinding = (method, path, body) => {
    if (method !== 'POST' || path !== '/api/v2/runs' || !body || typeof body !== 'object' || body.publishedVersionId) return body;
    const publication = runner.engine.store.get(`SELECT p.id AS publishedVersionId, p.definition_digest AS definitionDigest
      FROM workflow_publications p JOIN artifacts a ON a.id = p.snapshot_artifact_id
      WHERE p.workflow_id = ? AND a.sha256 = ? AND p.runnable = 1 ORDER BY p.version DESC LIMIT 1`, body.workflowId, body.workflowSnapshotSha256);
    return publication ? { ...body, publishedVersionId: publication.publishedVersionId, definitionDigest: publication.definitionDigest } : body;
  };
  const requestWithToken = (bearer, method, path, body, options) => callWithToken(bearer, method, path, withPublishedBinding(method, path, body), options);
  const api = {
    root, stateDir, runner, call: (method, path, body, options) => call(method, path, withPublishedBinding(method, path, body), options),
    callExternal: (method, path, body, options) => requestWithToken(token, method, path, body, options), callHost,
    publication(workflowId) {
      const saved = workflowPublications.get(workflowId);
      if (saved) return saved;
      const row = runner.engine.store.get('SELECT * FROM workflow_publications WHERE workflow_id = ? ORDER BY version DESC LIMIT 1', workflowId);
      return row ? runner.engine.workflowPublicationBody(row) : null;
    },
    async workspace(id = 'main') {
      const result = await call('PUT', `/api/v2/workspaces/${id}`, { cwd: join(runner.connection.scratchRoot, id) });
      if (result.status !== 200) throw new Error(JSON.stringify(result.body));
      return result.body;
    },
    async save(workflow) {
      const expectedEtag = workflowEtags.get(workflow.workflowId) ?? null;
      const requestId = randomUUID();
      const result = await call('PUT', `/api/v4/workflows/${workflow.workflowId}/draft`, { requestId, workflow }, {
        headers: expectedEtag === null ? { 'If-None-Match': '*' } : { 'If-Match': expectedEtag },
      });
      if (result.status !== 200) {
        await close();
        throw new Error(JSON.stringify(result.body));
      }
      workflowEtags.set(workflow.workflowId, result.body.etag);
      if (result.body.validation.valid) {
        const published = await call('POST', `/api/v4/workflows/${workflow.workflowId}/publish`, { requestId: randomUUID() }, { headers: { 'If-Match': result.body.etag } });
        if (published.status !== 201) {
          await close();
          throw new Error(JSON.stringify(published.body));
        }
        workflowPublications.set(workflow.workflowId, published.body);
      } else {
        workflowPublications.delete(workflow.workflowId);
      }
      const { etag, revision, workflowId, definitionDigest, sourcePublishedVersionId, updatedAt, ...saved } = result.body;
      return saved;
    },
    async run(workflow, workspaceId = 'main', requestId = randomUUID()) {
      const saved = await api.save(workflow);
      const publication = workflowPublications.get(workflow.workflowId);
      return call('POST', '/api/v2/runs', { workflowId: workflow.workflowId, workflowSnapshotSha256: saved.snapshotSha256,
        publishedVersionId: publication?.publishedVersionId || randomUUID(), definitionDigest: publication?.definitionDigest || saved.snapshotSha256, workspaceId, requestId });
    },
    async events(runId, after = 0) {
      const response = await call('GET', `/api/v2/runs/${runId}/events?afterSequence=${after}`, undefined, { raw: true });
      const text = await response.text();
      return text.split('\n\n').filter(frame => frame.includes('data: ')).map(frame => JSON.parse(frame.slice(frame.indexOf('data: ') + 6)));
    },
    async waitFor(runId, predicate = run => ['succeeded', 'failed', 'canceled', 'interrupted', 'waiting_for_user'].includes(run.state), timeout = 30_000) {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        const snapshot = await call('GET', `/api/v2/runs/${runId}`);
        if (predicate(snapshot.body.run, snapshot.body)) return snapshot.body;
        await new Promise(done => setTimeout(done, 50));
      }
      throw new Error(`Run ${runId} did not reach the expected state.`);
    },
    async recover(runId, body) { return call('POST', `/api/v2/runs/${runId}/recovery`, { requestId: randomUUID(), ...body }); },
    async closeRun(runId) {
      const result = await call('POST', `/api/v2/runs/${runId}/recovery`, { requestId: randomUUID(), action: 'close' });
      if (result.status !== 200) throw new Error(JSON.stringify(result.body));
      return result.body;
    },
    async artifactJson(id) { return JSON.parse(await (await call('GET', `/api/v2/artifacts/${id}`, undefined, { raw: true })).text()); },
    async artifactText(id) { return (await call('GET', `/api/v2/artifacts/${id}`, undefined, { raw: true })).text(); },
    close,
  };
  return api;
}

export async function contextChain(model = 'fixture-echo') {
  const workflow = JSON.parse(await readFile(resolve(import.meta.dirname, '../../docs/examples/m1-context-chain/workflow.json'), 'utf8'));
  for (const node of workflow.nodes) if (node.type === 'agent') node.config.model = model;
  return workflow;
}

export function singleAgent({ id = 'single', provider = 'codex', model = 'fixture-echo', output = { format: 'text' }, timeoutSeconds = 60, context = 'new', bindingId } = {}) {
  return {
    schemaVersion: 1, workflowId: id, capabilities: ['core-v1'], settings: { nativeConfiguration: 'restricted' },
    nodes: [
      { id: 'request', type: 'text', config: { value: 'Say hello.' } },
      ...(context ? [{ id: 'history', type: 'context', config: { provider, mode: context, ...(context === 'continue' ? { bindingId } : {}) } }] : []),
      { id: 'agent', type: 'agent', config: { provider, model, ...(context ? { contextId: 'history' } : {}), timeoutSeconds, output } },
      { id: 'answer', type: 'result-viewer', config: {} },
    ],
    edges: [
      { id: 'request-agent', source: { nodeId: 'request', port: 'text' }, target: { nodeId: 'agent', port: 'prompt' } },
      { id: 'agent-answer', source: { nodeId: 'agent', port: output.format === 'json' ? 'json' : 'text' }, target: { nodeId: 'answer', port: 'value' } },
    ],
    after: [],
  };
}
