import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { startTestRunner } from './helpers.mjs';

const testsRoot = resolve(import.meta.dirname, '../../.deszo/tests');

test('UI transport creates, edits, validates, publishes, selects, and launches an exact Published Version', async () => {
  await mkdir(testsRoot, { recursive: true });
  const modulePath = join(testsRoot, `transport-${randomUUID()}.mjs`);
  const source = await readFile(resolve(import.meta.dirname, '../../src/transport.ts'), 'utf8');
  const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  await writeFile(modulePath, javascript);
  const { Client, ApiProblem } = await import(pathToFileURL(modulePath).href);
  const api = await startTestRunner();
  try {
    await api.workspace();
    const client = new Client(api.runner.connection);
    const workflow = {
      schemaVersion: 1, workflowId: `ui-transport-${randomUUID().slice(0, 8)}`, capabilities: ['core-v1'],
      settings: { nativeConfiguration: 'restricted' }, view: { request: { x: 12, y: 34 } },
      nodes: [
        { id: 'request', type: 'text', config: { value: 'UI transport publication fixture.' } },
        { id: 'agent', type: 'agent', config: { provider: 'codex', model: 'fixture-echo', timeoutSeconds: 120, output: { format: 'text' } } },
        { id: 'result', type: 'result-viewer', config: {} },
      ],
      edges: [
        { id: 'request-agent', source: { nodeId: 'request', port: 'text' }, target: { nodeId: 'agent', port: 'prompt' } },
        { id: 'agent-result', source: { nodeId: 'agent', port: 'text' }, target: { nodeId: 'result', port: 'value' } },
      ], after: [],
    };
    const firstDraft = await client.saveWorkflow('unknown', randomUUID(), null, workflow).catch(error => error);
    assert.ok(firstDraft instanceof ApiProblem);
    assert.equal(firstDraft.status, 400, 'the transport surfaces path/workflow identity mismatch as a typed API problem');

    const draft = await client.saveWorkflow(workflow.workflowId, randomUUID(), null, workflow);
    assert.equal(draft.revision, 1);
    assert.deepEqual(draft.workflow.view, workflow.view);
    const validation = await client.validateDraft(workflow.workflowId, draft.etag);
    assert.equal(validation.validation.valid, true);
    const first = await client.publishDraft(workflow.workflowId, randomUUID(), draft.etag);
    assert.equal(first.version, 1);

    const edited = structuredClone(workflow);
    edited.view.request.x = 88;
    const updatedDraft = await client.saveWorkflow(workflow.workflowId, randomUUID(), draft.etag, edited);
    assert.equal(updatedDraft.revision, 2);
    await assert.rejects(client.saveWorkflow(workflow.workflowId, randomUUID(), draft.etag, workflow), error => error instanceof ApiProblem && error.status === 412);
    const secondValidation = await client.validateDraft(workflow.workflowId, updatedDraft.etag);
    assert.equal(secondValidation.validation.valid, true);
    const second = await client.publishDraft(workflow.workflowId, randomUUID(), updatedDraft.etag);
    assert.equal(second.version, 2);
    assert.notEqual(second.definitionDigest, first.definitionDigest);
    const selected = await client.getV4(`/workflows/${workflow.workflowId}/versions/1`);
    assert.equal(selected.publishedVersionId, first.publishedVersionId);
    assert.deepEqual(selected.workflow.view, { request: { x: 12, y: 34 } });

    const run = await client.post('/runs', { requestId: randomUUID(), workflowId: workflow.workflowId,
      workflowSnapshotSha256: selected.snapshotSha256, publishedVersionId: selected.publishedVersionId,
      definitionDigest: selected.definitionDigest, workspaceId: 'main' });
    assert.equal(run.outcome, 'created');
    assert.equal(run.run.publishedVersion.publishedVersionId, selected.publishedVersionId);
    await api.waitFor(run.run.runId);

    const pagedClient = new Client(api.runner.connection);
    const cursors = [];
    pagedClient.getV4 = async path => {
      const url = new URL(path, 'http://fixture');
      cursors.push(url.searchParams.get('cursor'));
      if (!url.searchParams.has('cursor')) return { items: Array.from({ length: 200 }, (_, index) => index), nextCursor: 'page-2' };
      return { items: [200], nextCursor: null };
    };
    const allVersions = await pagedClient.listPublishedVersions(workflow.workflowId);
    assert.equal(allVersions.length, 201, 'the UI transport follows nextCursor past the first 200 versions');
    assert.deepEqual(cursors, [null, 'page-2']);
  } finally {
    await api.close();
    await rm(modulePath, { force: true });
  }
});
