import { Handle, Position, type NodeProps } from '@xyflow/react';
import { ArrowLeftToLine, ArrowRightFromLine, Bot, Braces, Database, Eye, FileInput, FileText, Filter, GitMerge, Link2, ListChecks, Repeat, Scale, ShieldCheck, Split } from 'lucide-react';
import type { ReactNode } from 'react';
import { NODE_LABELS, portsOf, type FlowNode } from './model';
import { PROVIDER_NAMES, type NodeType } from './types';
import { DEFAULT_EFFORT } from '../shared/effort.mjs';

const ICONS: Record<NodeType, ReactNode> = {
  text: <FileText size={14} />, 'prompt-template': <Braces size={14} />, agent: <Bot size={14} />, context: <Link2 size={14} />, 'result-viewer': <Eye size={14} />,
  'file-input': <FileInput size={14} />, merge: <GitMerge size={14} />, 'json-select': <Filter size={14} />, condition: <Scale size={14} />, loop: <Repeat size={14} />,
  cache: <Database size={14} />, route: <Split size={14} />, gate: <ShieldCheck size={14} />, map: <ListChecks size={14} />, task: <ListChecks size={14} />,
};
export const STATE_LABELS: Record<string, string> = {
  scheduled: 'Planned', waiting: 'Waiting', running: 'Running', succeeded: 'Succeeded', failed: 'Failed', canceled: 'Canceled', blocked: 'Blocked', interrupted: 'Interrupted',
  unbound: 'Unbound', ready: 'Ready', writing: 'Writing', needs_review: 'Needs review', unavailable: 'Unavailable',
  paused: 'Paused', finished: 'Finished', reused: 'Reused', skipped: 'Skipped',
  awaiting_review: 'In review', accepted: 'Accepted', needs_changes: 'Needs changes', stale: 'Stale',
  implementation_complete: 'Complete', specification_revision_required: 'Revision required', finishing: 'Finishing',
};

function summary(data: FlowNode['data']): string {
  const node = data.node!;
  switch (node.type) {
    case 'task': return `${node.config.delivery.boundary === 'verified_branch' ? 'Verified branch' : 'Candidate acceptance'} · ${Object.keys(node.config.roles).length} roles · ≤${node.config.bounds.maxAttempts} attempts`;
    case 'text': return node.config.value.split('\n')[0] || 'Empty text';
    case 'prompt-template': return `${node.config.slots.length} slot${node.config.slots.length === 1 ? '' : 's'}`;
    case 'agent': return `${node.config.model || 'model not set'} · ${node.config.effort ?? (data.readOnly ? 'effort not specified' : DEFAULT_EFFORT)} · ${node.config.output.format}${node.config.attachFiles ? ' · files in' : ''}${node.config.captures ? ' · captures' : ''}`;
    case 'context': return node.config.mode === 'new' ? (node.config.lifetime === 'iteration' ? 'New each iteration' : 'New per run') : 'Continue binding';
    case 'file-input': return node.config.mode === 'files' ? node.config.paths.join(', ') : `Pinned ${node.config.valueType}`;
    case 'merge': if (node.config.mode === 'selected') return `Selected · one of ${node.config.inputs.length} alternatives`;
      return node.config.mode === 'record' ? `Record · ${node.config.fields.map(field => field.name).join(', ')}` : `${node.config.mode} · ${node.config.inputs.length} inputs`;
    case 'json-select': return `${node.config.pointer || '(root)'} → ${node.config.outputType}`;
    case 'condition': return `done when ${node.config.doneWhen.pointer || '(root)'} ${node.config.doneWhen.op}${'value' in node.config.doneWhen ? ` ${JSON.stringify(node.config.doneWhen.value)}` : ''}`;
    case 'loop': return `${node.config.valueType} · ≤${node.config.limits.maxIterations} iterations · ${node.config.body.nodes.length} body nodes`;
    case 'cache': return `${node.config.mode === 'frozen' ? 'Frozen — uses the pinned value' : 'Live — passes the value through'} · ${node.config.valueType}`;
    case 'route': return `${node.config.selector || '(root)'} → ${node.config.cases.map(item => item.id).join(' | ')}`;
    case 'gate': return node.config.mode === 'self-repair-verify' ? 'Installed P5 plan · no model supplied inputs' : `${node.config.mode} · ${node.config.policy.slots.map(slot => slot.id).join(', ')}`;
    case 'map': return `${node.config.roles.length} roles · ≤${node.config.limits.maxFailedVerificationCycles} failed verifications`;
    default: return 'Displays the final value';
  }
}

export function WorkflowNodeCard({ data, selected }: NodeProps<FlowNode>) {
  const node = data.node!;
  const ports = portsOf(node);
  const provider = node.type === 'agent' || node.type === 'context' ? node.config.provider : undefined;
  const inputs = Object.keys(ports.inputs), outputs = Object.keys(ports.outputs);
  const rows = Math.max(inputs.length, outputs.length, 1);
  const executable = node.type !== 'context';
  return <div className={`flow-node type-${node.type} ${provider || ''} ${selected ? 'selected' : ''} state-${data.state || 'idle'}`}>
    {node.type === 'agent' && <Handle type="target" position={Position.Top} id="context" className="handle-context" title="Context" />}
    <div className="flow-node-head">
      <span className="flow-node-icon">{ICONS[node.type]}</span>
      <span className="flow-node-title">{data.label || node.id}</span>
      {data.state && <span className={`state-chip ${data.state}`}>{STATE_LABELS[data.state] || data.state}</span>}
    </div>
    <div className="flow-node-kind">{NODE_LABELS[node.type]}{provider ? ` · ${PROVIDER_NAMES[provider]}` : ''}</div>
    <div className="flow-node-summary">{summary(data)}</div>
    <div className="flow-node-ports" style={{ minHeight: rows * 20 }}>
      <div className="port-column">{inputs.map(port => <div className="port-row in" key={port}>
        <Handle type="target" position={Position.Left} id={port} className={`handle-data ${ports.inputs[port].join(' ')}`} />
        <span>{port}</span></div>)}</div>
      <div className="port-column out">{outputs.map(port => <div className="port-row out" key={port}>
        <span>{port}</span>
        <Handle type="source" position={Position.Right} id={port} className={`handle-data ${ports.outputs[port]}`} /></div>)}</div>
    </div>
    {node.type === 'loop' && <div className="flow-node-hint">Double-click to open the body</div>}
    {node.type === 'context' && <Handle type="source" position={Position.Bottom} id="context" className="handle-context" title="Connect to an Agent of the same provider" />}
    {executable && <>
      <Handle type="target" position={Position.Bottom} id="after-in" className="handle-after in" title="Run after (order only)" style={{ left: '30%' }} />
      <Handle type="source" position={Position.Bottom} id="after-out" className="handle-after out" title="Order-only dependency" style={{ left: '70%' }} />
    </>}
  </div>;
}

export function BoundaryCard({ data }: NodeProps<FlowNode>) {
  const boundary = data.boundary!;
  const ports = Object.entries(boundary.ports);
  return <div className={`flow-node boundary ${boundary.kind}`}>
    <div className="flow-node-head">
      <span className="flow-node-icon">{boundary.kind === 'input' ? <ArrowRightFromLine size={14} /> : <ArrowLeftToLine size={14} />}</span>
      <span className="flow-node-title">{boundary.kind === 'input' ? 'Loop Input' : 'Loop Return'}</span>
    </div>
    <div className="flow-node-kind">{boundary.kind === 'input' ? 'Current value, iteration, feedback and fixed inputs' : 'Candidate and checker decision'}</div>
    <div className="flow-node-ports" style={{ minHeight: ports.length * 20 }}>
      {boundary.kind === 'return' ? <div className="port-column">{ports.map(([port, types]) => <div className="port-row in" key={port}>
        <Handle type="target" position={Position.Left} id={port} className={`handle-data ${(types as string[]).join(' ')}`} /><span>{port}</span></div>)}</div> : <div />}
      {boundary.kind === 'input' ? <div className="port-column out">{ports.map(([port, type]) => <div className="port-row out" key={port}>
        <span>{port}</span><Handle type="source" position={Position.Right} id={port} className={`handle-data ${type}`} /></div>)}</div> : <div />}
    </div>
  </div>;
}

export const nodeTypes = {
  task: WorkflowNodeCard,
  text: WorkflowNodeCard, 'prompt-template': WorkflowNodeCard, agent: WorkflowNodeCard, context: WorkflowNodeCard, 'result-viewer': WorkflowNodeCard,
  'file-input': WorkflowNodeCard, merge: WorkflowNodeCard, 'json-select': WorkflowNodeCard, condition: WorkflowNodeCard, loop: WorkflowNodeCard, boundary: BoundaryCard,
  cache: WorkflowNodeCard, route: WorkflowNodeCard, gate: WorkflowNodeCard, map: WorkflowNodeCard,
};
