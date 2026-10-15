// Seed only the isolated fixture runtime for manual UI verification.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
const project = resolve(import.meta.dirname, '../../..');
const root = join(project, '.deszo/audit-ui-20261013');
const connection = JSON.parse(await readFile(join(root, 'runtime/connection.json'), 'utf8'));
const call = async (method, path, body) => {
  const response = await fetch(`http://127.0.0.1:${connection.port}/api/v2${path}`, { method, headers: { Authorization: `Bearer ${connection.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result;
};
const workspace = (await call('GET', '/workspaces')).items.find(item => item.workspaceId === 'audit-ui');
if (!workspace) throw new Error('Create audit-ui in the fixture UI first.');
for (const [path, source] of [['SPEC.md', 'SPEC.md'], ['spec-index.json', 'spec-index.json'], ['implementation-map.json', 'implementation-map.json'], ['src/api.mjs', 'project/src/api.mjs'], ['fixtures/tokens.json', 'project/fixtures/tokens.json']]) {
  let text = await readFile(join(project, 'docs/examples/round-recovery', source), 'utf8');
  if (path === 'SPEC.md') text = text.replace('## BUSINESS-TASK\n', '## BUSINESS-TASK\n\nRevision 1.\n');
  await mkdir(dirname(join(workspace.cwd, path)), { recursive: true }); await writeFile(join(workspace.cwd, path), text);
}
const workflow = JSON.parse(await readFile(join(project, 'docs/examples/m5-delivery/workflow.json'), 'utf8'));
workflow.workflowId = 'audit-fixture-delivery';
for (const node of workflow.nodes) {
  if (node.type === 'agent') { node.config.model = 'fixture-reviewer-approve-1'; node.config.timeoutSeconds = 60; }
  if (node.type === 'map') for (const role of node.config.roles) if (role.kind === 'agent') {
    role.model = `fixture-${({ implementer: 'implementer', 'test-author': 'test-author', reviewer: 'task-reviewer', analyst: 'triage' })[role.id]}`;
    role.timeoutSeconds = 60;
  }
}
const saved = await call('PUT', `/workflows/${workflow.workflowId}`, workflow);
console.log(JSON.stringify({ workspace: workspace.workspaceId, workflow: workflow.workflowId, validation: saved.validation }));
