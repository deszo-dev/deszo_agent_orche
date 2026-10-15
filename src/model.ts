import type { Edge, Node } from '@xyflow/react';
import type { Capability, GatePolicy, LoopConfig, NodeType, Provider, ValueType, Workflow, WorkflowEdge, WorkflowNode } from './types';
import { DEFAULT_EFFORT } from '../shared/effort.mjs';

export type PortType = ValueType;
export interface Ports { inputs: Record<string, PortType[]>; outputs: Record<string, PortType> }
export const INPUT = '$input';
export const RETURN = '$return';

export function portsOf(node: WorkflowNode): Ports {
  switch (node.type) {
    case 'text': return { inputs: {}, outputs: { text: 'Text' } };
    case 'prompt-template': return { inputs: Object.fromEntries(node.config.slots.map(slot => [slot.id, ['Text' as PortType]])), outputs: { text: 'Text' } };
    case 'agent': return {
      inputs: { prompt: ['Text'], ...(node.config.attachFiles ? { files: ['ArtifactSet' as PortType] } : {}) },
      outputs: { text: 'Text', ...(node.config.output.format === 'json' ? { json: 'JsonValue' as PortType } : {}), ...(node.config.captures ? { files: 'ArtifactSet' as PortType } : {}) },
    };
    case 'result-viewer': return { inputs: { value: ['Text', 'JsonValue', 'ArtifactSet'] }, outputs: {} };
    case 'file-input': return { inputs: {}, outputs: { value: node.config.mode === 'files' ? 'ArtifactSet' : node.config.valueType } };
    case 'merge': {
      if (node.config.mode === 'selected') { const type = node.config.valueType; return { inputs: Object.fromEntries(node.config.inputs.map(input => [input.id, [type]])), outputs: { value: type } }; }
      const fixed = node.config.mode === 'text' ? 'Text' : node.config.mode === 'artifacts' ? 'ArtifactSet' : null;
      return {
        inputs: Object.fromEntries(node.config.inputs.map(input => [input.id, [(fixed || (input as { type: PortType }).type) as PortType]])),
        outputs: { value: (fixed || 'JsonValue') as PortType },
      };
    }
    case 'json-select': return { inputs: { value: ['JsonValue'] }, outputs: { value: node.config.outputType } };
    case 'condition': return { inputs: { value: ['JsonValue'] }, outputs: { decision: 'JsonValue' } };
    case 'map': return {
      inputs: { documentation: ['ArtifactSet'], approval: ['JsonValue'], base: ['ArtifactSet'], ...Object.fromEntries(node.config.optionalInputs.map(id => [id, ['JsonValue' as PortType]])) },
      outputs: { result: 'ArtifactSet', summary: 'JsonValue' },
    };
    case 'loop': return {
      inputs: { seed: [node.config.valueType], ...Object.fromEntries(node.config.fixedInputs.map(input => [input.id, [input.type]])) },
      outputs: { result: node.config.valueType, decision: 'JsonValue' },
    };
    case 'cache': return { inputs: { value: [node.config.valueType] }, outputs: { value: node.config.valueType } };
    case 'route': return { inputs: { selector: ['JsonValue'], value: [node.config.valueType] }, outputs: Object.fromEntries(node.config.cases.map(item => [item.id, node.config.valueType])) };
    case 'gate': {
      const slots = node.config.policy.slots.map(slot => slot.id);
      if (node.config.mode === 'prepare' && node.config.subject === 'delivery') return {
        inputs: { documentation: ['ArtifactSet'], approval: ['JsonValue'], summary: ['JsonValue'], candidate: ['ArtifactSet'], issues: ['JsonValue'], ...(node.config.technicalPolicy ? { technical: ['JsonValue' as PortType] } : {}) },
        outputs: { subject: 'ArtifactSet', plan: 'JsonValue', ...Object.fromEntries(slots.map(id => [id, 'ArtifactSet' as PortType])) },
      };
      if (node.config.mode === 'prepare') return {
        inputs: { subject: ['ArtifactSet'], issues: ['JsonValue'], ...(node.config.carry ? { prior: ['JsonValue' as PortType] } : {}) },
        outputs: { subject: 'ArtifactSet', plan: 'JsonValue', ...Object.fromEntries(slots.map(id => [id, 'ArtifactSet' as PortType])), ...(node.config.carry ? Object.fromEntries(slots.map(id => [`${id}-need`, 'JsonValue' as PortType])) : {}) },
      };
      if (node.config.mode === 'evaluate') return { inputs: { subject: ['ArtifactSet'], plan: ['JsonValue'], ...Object.fromEntries(slots.map(id => [id, ['JsonValue' as PortType]])) }, outputs: { report: 'JsonValue', certificate: 'JsonValue' } };
      return { inputs: { subject: ['ArtifactSet'], certificate: ['JsonValue'] }, outputs: { report: 'JsonValue' } };
    }
    default: return { inputs: {}, outputs: {} };
  }
}

export function boundaryPorts(loop: LoopConfig) {
  return {
    input: { value: loop.valueType, iteration: 'JsonValue', feedback: 'Text', ...Object.fromEntries(loop.fixedInputs.map(input => [input.id, input.type])) } as Record<string, PortType>,
    ret: { candidate: [loop.valueType], decision: ['JsonValue'] } as Record<string, PortType[]>,
  };
}

export const NODE_LABELS: Record<NodeType, string> = {
  text: 'Text', 'prompt-template': 'Prompt Template', agent: 'Agent', context: 'Context', 'result-viewer': 'Result Viewer',
  'file-input': 'File / Artifact Input', merge: 'Merge', 'json-select': 'JSON Select', condition: 'Condition', loop: 'Loop',
  cache: 'Cache', route: 'Route', gate: 'Gate', map: 'Implementation Map',
};
export const LOOPS_TYPES: NodeType[] = ['file-input', 'merge', 'json-select', 'condition', 'loop', 'route', 'gate', 'map'];
export const DEFAULT_POLICY: GatePolicy = { slots: [
  { id: 'customer', role: 'customer', view: 'public' },
  { id: 'readiness', role: 'implementation-readiness', view: 'full' },
  { id: 'testability', role: 'testability-reviewer', view: 'full' },
] };
// Models are always explicit. Only Claude has documented CLI aliases; the others start empty.
export const DEFAULT_MODELS: Record<Provider, string> = { codex: '', claude: 'sonnet', antigravity: '' };
export const MODEL_SUGGESTIONS: Record<Provider, string[]> = { codex: [], claude: ['sonnet', 'opus', 'haiku'], antigravity: [] };
const ID = /^[a-z][a-z0-9-]{0,63}$/;
export const validId = (id: string) => ID.test(id);

export function uniqueId(base: string, taken: Iterable<string>) {
  const used = new Set(taken);
  const clean = base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+/, '').slice(0, 56) || 'node';
  if (!used.has(clean)) return clean;
  for (let i = 2; ; i++) if (!used.has(`${clean}-${i}`)) return `${clean}-${i}`;
}

export const DECISION_SCHEMA = {
  type: 'object', properties: { continue: { type: 'boolean' }, reason: { type: 'string' }, feedback: { type: 'string' } },
  required: ['continue', 'reason', 'feedback'], additionalProperties: false,
};

export function createNode(type: NodeType, id: string, provider: Provider = 'codex'): WorkflowNode {
  switch (type) {
    case 'text': return { id, type, config: { value: '' } };
    case 'prompt-template': return { id, type, config: { template: 'Instruction:\n{{instruction}}\n\nMaterial:\n{{material}}', slots: [{ id: 'instruction' }, { id: 'material' }] } };
    case 'agent': return { id, type, config: { provider, model: DEFAULT_MODELS[provider], effort: DEFAULT_EFFORT, timeoutSeconds: 600, output: { format: 'text' } } };
    case 'context': return { id, type, config: { provider, mode: 'new' } };
    case 'result-viewer': return { id, type, config: {} };
    case 'file-input': return { id, type, config: { mode: 'files', paths: ['README.md'] } };
    case 'merge': return { id, type, config: { mode: 'text', inputs: [{ id: 'first' }, { id: 'second' }], separator: '\n\n' } };
    case 'json-select': return { id, type, config: { pointer: '/message', outputType: 'Text', render: 'raw-string' } };
    case 'condition': return { id, type, config: { doneWhen: { pointer: '/done', op: 'is-true' }, reason: { literal: 'The condition is met.' }, feedback: { literal: 'Try again.' } } };
    case 'loop': return { id, type, config: { valueType: 'Text', fixedInputs: [], limits: { maxIterations: 5, maxActiveMinutes: 30 }, body: { nodes: [], edges: [], after: [], view: { [INPUT]: { x: 0, y: 100 }, [RETURN]: { x: 700, y: 100 } } } } };
    case 'cache': return { id, type, config: { valueType: 'Text', mode: 'live' } };
    case 'route': return { id, type, config: { valueType: 'JsonValue', selector: '/status', cases: [{ id: 'approved', equals: 'OPEN' }, { id: 'revise', equals: 'REVISION_REQUIRED' }], onUnmatched: 'error' } };
    case 'gate': return { id, type, config: { mode: 'prepare', policy: structuredClone(DEFAULT_POLICY) } };
    case 'map': return { id, type, config: { approvalPolicy: structuredClone(DEFAULT_POLICY), optionalInputs: [], limits: { maxFailedVerificationCycles: 3, maxTaskAttempts: 3 }, roles: [
      { id: 'implementer', kind: 'agent', provider: 'claude', model: DEFAULT_MODELS.claude, effort: DEFAULT_EFFORT, instructions: 'Implement the approved task. Write only the listed outputs.', timeoutSeconds: 600, context: 'task' },
      { id: 'test-author', kind: 'agent', provider: 'antigravity', model: DEFAULT_MODELS.antigravity, effort: DEFAULT_EFFORT, instructions: 'Write the approved tests. Write only the listed outputs.', timeoutSeconds: 600, context: 'task' },
      { id: 'reviewer', kind: 'agent', provider: 'codex', model: DEFAULT_MODELS.codex, effort: DEFAULT_EFFORT, instructions: 'Review the captured snapshot against the criterion.', timeoutSeconds: 600, context: 'task' },
      { id: 'analyst', kind: 'agent', provider: 'codex', model: DEFAULT_MODELS.codex, effort: DEFAULT_EFFORT, instructions: 'Triage the failed verification from the captured evidence.', timeoutSeconds: 600, context: 'task' },
      { id: 'verification', kind: 'utility', template: 'verification', embeddedRoles: { triage: 'analyst' } },
    ] } };
  }
}

export const MARKER = /\{\{([a-z][a-z0-9-]{0,63})\}\}/g;
// Keep declared slots aligned with the template's markers, preserving descriptions.
export function syncSlots(template: string, slots: { id: string; description?: string }[]) {
  const ids = [...new Set([...template.matchAll(MARKER)].map(match => match[1]))];
  return ids.map(id => slots.find(slot => slot.id === id) || { id });
}

export function emptyWorkflow(workflowId: string): Workflow {
  return { schemaVersion: 1, workflowId, capabilities: ['core-v1'], settings: { nativeConfiguration: 'restricted' }, nodes: [], edges: [], after: [], view: {} };
}

type LoopNode = Extract<WorkflowNode, { type: 'loop' }>;
const deep = (nodes: WorkflowNode[]): WorkflowNode[] => nodes.flatMap(node => node.type === 'loop' ? [node, ...deep(node.config.body.nodes)] : [node]);
export const allNodes = (workflow: Workflow) => deep(workflow.nodes);
// Node IDs are unique across all bodies, so a loop ID names its scope at any depth.
export const loopOf = (workflow: Workflow, loopId: string | null) => loopId ? allNodes(workflow).find(node => node.id === loopId && node.type === 'loop') as LoopNode | undefined : undefined;
export function loopPath(workflow: Workflow, loopId: string | null): string[] {
  if (!loopId) return [];
  const walk = (nodes: WorkflowNode[], trail: string[]): string[] | null => {
    for (const node of nodes) if (node.type === 'loop') {
      if (node.id === loopId) return [...trail, node.id];
      const found = walk(node.config.body.nodes, [...trail, node.id]);
      if (found) return found;
    }
    return null;
  };
  return walk(workflow.nodes, []) || [];
}
function replaceLoop(nodes: WorkflowNode[], loopId: string, replace: (loop: LoopNode) => LoopNode): WorkflowNode[] {
  return nodes.map(node => node.type !== 'loop' ? node : node.id === loopId ? replace(node) : { ...node, config: { ...node.config, body: { ...node.config.body, nodes: replaceLoop(node.config.body.nodes, loopId, replace) } } });
}

export type BoundaryNode = { id: string; type: 'boundary'; kind: 'input' | 'return'; ports: Record<string, PortType> | Record<string, PortType[]> };
export type FlowData = { node?: WorkflowNode; boundary?: BoundaryNode; state?: string; label?: string; readOnly?: boolean };
export type FlowNode = Node<FlowData>;

interface Graph { nodes: WorkflowNode[]; edges: WorkflowEdge[]; after: { before: string; after: string }[]; view?: Record<string, { x: number; y: number; label?: string }> }
export function graphOf(workflow: Workflow, scope: string | null): Graph {
  const loop = loopOf(workflow, scope);
  return loop ? loop.config.body : workflow;
}

// The canvas shows one graph: the outer workflow or one loop body with its two boundaries.
export function toFlow(workflow: Workflow, scope: string | null = null): { nodes: FlowNode[]; edges: Edge[] } {
  const graph = graphOf(workflow, scope);
  const nodes: FlowNode[] = graph.nodes.map((node, index) => ({
    id: node.id, type: node.type, position: graph.view?.[node.id] ? { x: graph.view[node.id].x, y: graph.view[node.id].y } : { x: 80 + (index % 4) * 270, y: 80 + Math.floor(index / 4) * 210 },
    data: { node, label: graph.view?.[node.id]?.label },
  }));
  const loop = loopOf(workflow, scope);
  if (loop) {
    const ports = boundaryPorts(loop.config);
    nodes.unshift({ id: INPUT, type: 'boundary', position: graph.view?.[INPUT] || { x: -260, y: 100 }, deletable: false, data: { boundary: { id: INPUT, type: 'boundary', kind: 'input', ports: ports.input } } });
    nodes.push({ id: RETURN, type: 'boundary', position: graph.view?.[RETURN] || { x: 1200, y: 100 }, deletable: false, data: { boundary: { id: RETURN, type: 'boundary', kind: 'return', ports: ports.ret } } });
  }
  const present = new Set(nodes.map(node => node.id));
  const edges: Edge[] = graph.edges.map(edge => ({ id: edge.id, source: edge.source.nodeId, sourceHandle: edge.source.port, target: edge.target.nodeId, targetHandle: edge.target.port, type: 'smoothstep' }));
  for (const node of graph.nodes) if (node.type === 'agent' && node.config.contextId && present.has(node.config.contextId))
    edges.push({ id: `context:${node.id}`, source: node.config.contextId, sourceHandle: 'context', target: node.id, targetHandle: 'context', type: 'smoothstep', className: 'context-edge', data: { kind: 'context' } });
  graph.after.forEach(pair => edges.push({ id: `after:${pair.before}:${pair.after}`, source: pair.before, sourceHandle: 'after-out', target: pair.after, targetHandle: 'after-in', type: 'smoothstep', className: 'after-edge', data: { kind: 'after' } }));
  return { nodes, edges };
}

export function fromFlow(base: Workflow, scope: string | null, nodes: FlowNode[], edges: Edge[]): Workflow {
  const present = new Set(nodes.map(node => node.id));
  const contextOf = new Map<string, string>();
  const dataEdges: WorkflowEdge[] = [];
  const after: Workflow['after'] = [];
  for (const edge of edges) {
    const kind = (edge.data as { kind?: string } | undefined)?.kind;
    if (kind === 'context') contextOf.set(edge.target, edge.source);
    else if (kind === 'after') after.push({ before: edge.source, after: edge.target });
    else dataEdges.push({ id: edge.id, source: { nodeId: edge.source, port: edge.sourceHandle || '' }, target: { nodeId: edge.target, port: edge.targetHandle || '' } });
  }
  const graphNodes = nodes.filter(flow => flow.data.node).map(flow => {
    const node = flow.data.node!;
    if (node.type !== 'agent') return node;
    const { contextId, ...config } = node.config;
    // A Context drawn on this canvas wins; an off-canvas reference (outer Context in a body) is kept.
    const linked = contextOf.get(node.id) ?? (contextId && !present.has(contextId) ? contextId : undefined);
    return { ...node, config: linked ? { ...config, contextId: linked } : config } as WorkflowNode;
  });
  const view: NonNullable<Workflow['view']> = {};
  for (const flow of nodes) view[flow.id] = { x: Math.round(flow.position.x), y: Math.round(flow.position.y), ...(flow.data.label ? { label: flow.data.label } : {}) };
  // Keep loop bodies on this canvas from the base (they are edited in their own scope).
  const bodies = new Map(allNodes(base).filter(node => node.type === 'loop').map(node => [node.id, (node as LoopNode).config.body]));
  const kept = graphNodes.map(node => node.type === 'loop' && bodies.has(node.id) ? { ...node, config: { ...node.config, body: bodies.get(node.id)! } } as WorkflowNode : node);
  if (!scope) return withCapabilities({ ...base, nodes: kept, edges: dataEdges, after, view });
  return withCapabilities({ ...base, nodes: replaceLoop(base.nodes, scope, loop => ({ ...loop, config: { ...loop.config, body: { nodes: kept, edges: dataEdges, after, view } } })) });
}

// Replace a loop's configuration at any depth, keeping its stored body.
export function updateLoop(workflow: Workflow, loop: LoopNode): Workflow {
  return { ...workflow, nodes: replaceLoop(workflow.nodes, loop.id, current => ({ ...loop, config: { ...loop.config, body: current.config.body } })) };
}
export function mapAllNodes(workflow: Workflow, fn: (node: WorkflowNode) => WorkflowNode): Workflow {
  const visit = (nodes: WorkflowNode[]): WorkflowNode[] => nodes.map(node => {
    const next = fn(node);
    return next.type === 'loop' ? { ...next, config: { ...next.config, body: { ...next.config.body, nodes: visit(next.config.body.nodes) } } } : next;
  });
  return { ...workflow, nodes: visit(workflow.nodes) };
}

// Capabilities are declared exactly when a node type or field that needs them is present.
export function withCapabilities(workflow: Workflow): Workflow {
  const nodes = allNodes(workflow);
  const nested = nodes.some(node => node.type === 'loop' && node.config.body.nodes.some(inner => inner.type === 'loop'));
  const delivery = nodes.some(node => node.type === 'map' || (node.type === 'gate' && node.config.subject === 'delivery'));
  const pipeline = delivery || nested || nodes.some(node => node.type === 'gate' || node.type === 'route' || (node.type === 'merge' && node.config.mode === 'selected'));
  const loops = pipeline || nodes.some(node => LOOPS_TYPES.includes(node.type)
    || (node.type === 'agent' && (node.config.attachFiles !== undefined || node.config.captures))
    || (node.type === 'context' && node.config.mode === 'new' && node.config.lifetime));
  const capabilities: Capability[] = ['core-v1'];
  if (loops) capabilities.push('loops-v1');
  if (nodes.some(node => node.type === 'cache')) capabilities.push('cache-v1');
  if (pipeline) capabilities.push('pipeline-v1');
  if (delivery) capabilities.push('delivery-v1');
  if (nodes.some(node => (node.type === 'gate' && node.config.carry) || (node.type === 'map' && node.config.carryAcrossRevisions))) capabilities.push('revisions-v1');
  return { ...workflow, capabilities };
}

export function edgeId(source: string, sourcePort: string, target: string, targetPort: string, taken: Iterable<string>) {
  return uniqueId(`${source.replace('$', '')}-${sourcePort}-${target.replace('$', '')}-${targetPort}`.slice(0, 60), taken);
}
