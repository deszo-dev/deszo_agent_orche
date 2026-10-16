import { useEffect, useState } from 'react';
import { AlertTriangle, GitBranch, Lock, Play, Plus, RefreshCw, Repeat, Square, Trash2, Unlock, X } from 'lucide-react';
import { DECISION_SCHEMA, MODEL_SUGGESTIONS, NODE_LABELS, syncSlots, validId } from './model';
import { PROVIDERS, PROVIDER_NAMES, VALUE_TYPES, type CachePin, type ContextBinding, type GatePolicy, type MapHistory, type MapNavigator, type ManagedTaskNavigator, type MapRole, type FieldSource, type JournalEvent, type Provider, type TextSource, type ValueType, type WorkflowNode } from './types';
import type { Client } from './transport';
import { STATE_LABELS } from './nodes';
import { DEFAULT_EFFORT, EFFORT_LEVELS, type Effort } from '../shared/effort.mjs';

interface Props {
  node: WorkflowNode; label?: string; readOnly: boolean; bindings: ContextBinding[]; inBody: boolean;
  visibleContexts: WorkflowNode[]; agents: WorkflowNode[];
  onChange: (node: WorkflowNode) => void; onRename: (id: string) => string | null; onLabel: (label: string) => void; onDelete: () => void; onOpenBody?: () => void;
  client: Client | null; events: JournalEvent[]; instanceId: string | null; contexts: { contextNodeId: string; bindingId: string }[];
  canStop: boolean; onStop?: () => void;
  onRunBranch?: () => void; onRunNode?: () => void;
  pin?: CachePin | null; onFreeze?: () => void; onRefresh?: () => void;
  runActive?: boolean; runId?: string | null;
}

export function Inspector(props: Props) {
  const { node, label, readOnly, bindings, onChange, onRename, onLabel, onDelete, client, events, contexts, instanceId, inBody, visibleContexts, agents } = props;
  const [idDraft, setIdDraft] = useState(node.id);
  const [idError, setIdError] = useState<string | null>(null);
  useEffect(() => { setIdDraft(node.id); setIdError(null); }, [node.id]);
  const commitId = () => {
    if (idDraft === node.id) return;
    if (!validId(idDraft)) { setIdError('Use lowercase letters, digits and hyphens, starting with a letter.'); return; }
    setIdError(onRename(idDraft));
  };
  const update = (config: object) => onChange({ ...node, config: { ...node.config, ...config } } as WorkflowNode);
  const replaceConfig = (config: object) => onChange({ ...node, config } as WorkflowNode);

  return <div className="inspector-body">
    <div className="inspector-title">
      <span>{NODE_LABELS[node.type]}</span>
      <span className="row tight">
        {props.canStop && <button className="button small danger" onClick={props.onStop} title="Stop only this node (scoped Stop)"><Square size={12} />Stop node</button>}
        {!readOnly && <button className="icon-button danger" title="Delete node" onClick={onDelete}><Trash2 size={14} /></button>}
      </span>
    </div>
    <label className="field"><span>Node ID <em>unique across the workflow and loop bodies</em></span>
      <input value={idDraft} disabled={readOnly} onChange={event => setIdDraft(event.target.value)} onBlur={commitId} onKeyDown={event => event.key === 'Enter' && commitId()} />
      {idError && <small className="field-error">{idError}</small>}
    </label>
    <label className="field"><span>Display label <em>(layout only)</em></span>
      <input value={label || ''} disabled={readOnly} placeholder={node.id} onChange={event => onLabel(event.target.value)} />
    </label>

    {(props.onRunBranch || props.onRunNode) && <div className="row tight run-actions">
      {props.onRunBranch && <button className="button small secondary" onClick={props.onRunBranch} title="Run this node and everything it needs; nothing downstream"><GitBranch size={12} />Run branch</button>}
      {props.onRunNode && <button className="button small ghost" onClick={props.onRunNode} title="Run only this node, reusing current committed inputs"><Play size={12} />Run node</button>}
    </div>}

    {node.type === 'task' && <>
      <p className="muted">The Analyst assesses this request. The engine selects stages, runs independent reviews and checks, and verifies the chosen delivery boundary. Set an explicit model and effort for every role.</p>
      <JsonField label="Roles, scope, limits and delivery" hint="Captured with the workflow; no automatic model substitution" value={node.config} readOnly={readOnly} keyId={node.id} objectOnly onChange={value => value && replaceConfig(value)} />
      {client && props.runId && instanceId && <ManagedTaskView client={client} runId={props.runId} instanceId={instanceId} live={Boolean(props.runActive)} />}
    </>}
    {node.type === 'text' && <label className="field"><span>Literal text</span>
      <textarea rows={10} value={node.config.value} disabled={readOnly} onChange={event => update({ value: event.target.value })} spellCheck={false} />
    </label>}

    {node.type === 'prompt-template' && <>
      <label className="field"><span>Template <em>use {'{{slot-id}}'} markers</em></span>
        <textarea rows={10} value={node.config.template} disabled={readOnly} spellCheck={false}
          onChange={event => update({ template: event.target.value, slots: syncSlots(event.target.value, node.config.slots) })} />
      </label>
      <div className="field"><span>Input slots</span>
        {node.config.slots.length === 0 && <small className="muted">Add a marker such as {'{{answer}}'} to create an input.</small>}
        {node.config.slots.map((slot, index) => <div className="slot-row" key={slot.id}>
          <code>{slot.id}</code>
          <input placeholder="Description (optional)" value={slot.description || ''} disabled={readOnly}
            onChange={event => update({ slots: node.config.slots.map((item, i) => i === index ? (event.target.value ? { ...item, description: event.target.value } : { id: item.id }) : item) })} />
        </div>)}
      </div>
    </>}

    {node.type === 'agent' && <>
      <label className="field"><span>Provider</span>
        <select value={node.config.provider} disabled={readOnly} onChange={event => update({ provider: event.target.value as Provider, contextId: undefined })}>
          {PROVIDERS.map(provider => <option key={provider} value={provider}>{PROVIDER_NAMES[provider]}</option>)}
        </select>
      </label>
      <label className="field"><span>Model ID <em>explicit; never substituted</em></span>
        <input list={`models-${node.id}`} value={node.config.model} disabled={readOnly} placeholder="Enter an exact model ID" onChange={event => update({ model: event.target.value.trim() })} />
        <datalist id={`models-${node.id}`}>{MODEL_SUGGESTIONS[node.config.provider].map(model => <option key={model} value={model} />)}</datalist>
        {!node.config.model && <small className="field-error">A model ID is required before saving.</small>}
      </label>
      <EffortField value={node.config.effort} readOnly={readOnly} onChange={effort => update({ effort })} />
      <label className="field"><span>Timeout (seconds of active process time)</span>
        <input type="number" min={5} max={600} value={node.config.timeoutSeconds} disabled={readOnly} onChange={event => update({ timeoutSeconds: Math.max(5, Math.round(Number(event.target.value) || 5)) })} />
      </label>
      <label className="field"><span>Output</span>
        <select value={node.config.output.format} disabled={readOnly} onChange={event => update({ output: event.target.value === 'json' ? { format: 'json' } : { format: 'text' } })}>
          <option value="text">Text answer</option>
          <option value="json">JSON value (adds a json port)</option>
        </select>
      </label>
      {node.config.output.format === 'json' && <>
        <JsonField label="JSON Schema" hint="optional, Draft 2020-12, local refs only" value={node.config.output.schema} readOnly={readOnly} keyId={node.id}
          onChange={schema => update({ output: schema === undefined ? { format: 'json' } : { format: 'json', schema } })} objectOnly />
        {!readOnly && inBody && <button className="button small ghost" onClick={() => update({ output: { format: 'json', schema: DECISION_SCHEMA } })}>Use the loop-decision schema</button>}
      </>}
      <label className="field"><span>Context</span>
        <select value={node.config.contextId || ''} disabled={readOnly} onChange={event => update({ contextId: event.target.value || undefined })}>
          <option value="">No Context — a fresh private session per attempt</option>
          {visibleContexts.filter(item => item.type === 'context' && item.config.provider === node.config.provider).map(item => <option key={item.id} value={item.id}>{item.id}</option>)}
        </select>
        <small className="muted">{inBody ? 'Outer Contexts are shared across iterations; body Contexts can start fresh each iteration.' : 'You can also drag from a Context’s bottom handle to this node’s top handle.'}</small>
      </label>
      <label className="check"><input type="checkbox" checked={Boolean(node.config.attachFiles)} disabled={readOnly} onChange={event => update({ attachFiles: event.target.checked || undefined })} />Attach files (adds a <code>files</code> ArtifactSet input)</label>
      <StringList label="Capture files after success" hint="workspace-relative paths; adds a files output" values={node.config.captures || []} readOnly={readOnly} placeholder="out/report.md"
        onChange={captures => update({ captures: captures.length ? captures : undefined })} />
    </>}

    {node.type === 'context' && <>
      <label className="field"><span>Provider</span>
        <select value={node.config.provider} disabled={readOnly} onChange={event => replaceConfig({ provider: event.target.value as Provider, mode: 'new' })}>
          {PROVIDERS.map(provider => <option key={provider} value={provider}>{PROVIDER_NAMES[provider]}</option>)}
        </select>
      </label>
      <label className="field"><span>Mode</span>
        <select value={node.config.mode === 'new' ? (node.config.lifetime === 'iteration' ? 'iteration' : 'new') : 'continue'} disabled={readOnly} onChange={event => {
          const mode = event.target.value;
          if (mode === 'new') replaceConfig({ provider: node.config.provider, mode: 'new' });
          else if (mode === 'iteration') replaceConfig({ provider: node.config.provider, mode: 'new', lifetime: 'iteration' });
          else {
            const candidate = bindings.find(binding => binding.provider === node.config.provider && binding.state === 'ready');
            replaceConfig({ provider: node.config.provider, mode: 'continue', bindingId: candidate?.bindingId || '00000000-0000-4000-8000-000000000000' });
          }
        }}>
          <option value="new">New per run</option>
          {inBody && <option value="iteration">New each iteration</option>}
          <option value="continue">Continue an existing binding</option>
        </select>
      </label>
      {node.config.mode === 'continue' && <label className="field"><span>Binding</span>
        <select value={node.config.bindingId} disabled={readOnly} onChange={event => replaceConfig({ provider: node.config.provider, mode: 'continue', bindingId: event.target.value })}>
          {!bindings.some(binding => node.config.mode === 'continue' && binding.bindingId === node.config.bindingId) && <option value={node.config.bindingId}>Select a binding…</option>}
          {bindings.filter(binding => binding.provider === node.config.provider).map(binding => <option key={binding.bindingId} value={binding.bindingId}>
            {binding.bindingId.slice(0, 8)} · {STATE_LABELS[binding.state]}{binding.model ? ` · ${binding.model}` : ''}
          </option>)}
        </select>
        <small className="muted">Continue appends to the binding’s current native conversation; it never rewinds or silently starts fresh.</small>
      </label>}
      <div className="field"><span>Used by</span><small className="muted">{agents.filter(agent => agent.type === 'agent' && agent.config.contextId === node.id).map(agent => agent.id).join(', ') || 'No Agent yet.'}</small></div>
    </>}

    {node.type === 'file-input' && <>
      <label className="field"><span>Source</span>
        <select value={node.config.mode} disabled={readOnly} onChange={event => replaceConfig(event.target.value === 'files' ? { mode: 'files', paths: ['README.md'] } : { mode: 'artifact', valueType: 'Text', artifact: { artifactId: '00000000-0000-4000-8000-000000000000', sha256: '0'.repeat(64) } })}>
          <option value="files">Workspace files (snapshot when the node runs)</option>
          <option value="artifact">A previously committed artifact</option>
        </select>
      </label>
      {node.config.mode === 'files' ? <StringList label="Paths" hint="relative to the workspace; no .., globs or absolute paths" values={node.config.paths} readOnly={readOnly} placeholder="docs/notes.md"
        onChange={paths => update({ paths: paths.length ? paths : ['README.md'] })} />
        : <>
          <TypeSelect label="Value type" value={node.config.valueType} readOnly={readOnly} onChange={valueType => update({ valueType })} />
          <label className="field"><span>Artifact ID</span><input value={node.config.artifact.artifactId} disabled={readOnly} onChange={event => update({ artifact: { ...(node.config as any).artifact, artifactId: event.target.value.trim() } })} /></label>
          <label className="field"><span>SHA-256</span><input value={node.config.artifact.sha256} disabled={readOnly} onChange={event => update({ artifact: { ...(node.config as any).artifact, sha256: event.target.value.trim().toLowerCase() } })} /></label>
          <small className="muted">Copy both from an Agent output in the run inspector. The digest is verified when the run is created and again when the node runs.</small>
        </>}
    </>}

    {node.type === 'merge' && <MergeEditor node={node} readOnly={readOnly} replaceConfig={replaceConfig} />}

    {node.type === 'json-select' && <>
      <label className="field"><span>JSON Pointer <em>RFC 6901; empty selects the root</em></span>
        <input value={node.config.pointer} disabled={readOnly} placeholder="/message" onChange={event => update({ pointer: event.target.value })} />
      </label>
      <TypeSelect label="Output type" value={node.config.outputType} readOnly={readOnly}
        onChange={outputType => replaceConfig({ pointer: node.config.pointer, outputType, ...(outputType === 'Text' ? { render: 'raw-string' } : {}) })} />
      {node.config.outputType === 'Text' && <label className="field"><span>Text rendering</span>
        <select value={node.config.render} disabled={readOnly} onChange={event => update({ render: event.target.value })}>
          <option value="raw-string">Raw string (the value must be a string)</option>
          <option value="canonical-json">Canonical JSON text</option>
        </select></label>}
      {node.config.outputType === 'ArtifactSet' && <label className="field"><span>When the value is null</span>
        <select value={node.config.nullAs || 'error'} disabled={readOnly} onChange={event => update({ nullAs: event.target.value === 'error' ? undefined : 'empty' })}>
          <option value="error">Fail</option><option value="empty">Use an empty set</option>
        </select></label>}
    </>}

    {node.type === 'condition' && <>
      <label className="field"><span>Done when — pointer</span>
        <input value={node.config.doneWhen.pointer} disabled={readOnly} placeholder="/done" onChange={event => update({ doneWhen: { ...node.config.doneWhen, pointer: event.target.value } })} />
      </label>
      <label className="field"><span>Comparison</span>
        <select value={node.config.doneWhen.op} disabled={readOnly} onChange={event => {
          const op = event.target.value as 'equals' | 'not-equals' | 'is-true' | 'is-false';
          update({ doneWhen: op === 'equals' || op === 'not-equals' ? { pointer: node.config.doneWhen.pointer, op, value: node.config.doneWhen.value ?? true } : { pointer: node.config.doneWhen.pointer, op } });
        }}>
          <option value="is-true">is true (Boolean)</option><option value="is-false">is false (Boolean)</option>
          <option value="equals">equals literal</option><option value="not-equals">does not equal literal</option>
        </select>
      </label>
      {'value' in node.config.doneWhen && <JsonField label="Literal" hint="any JSON value; compared without coercion" value={node.config.doneWhen.value} readOnly={readOnly} keyId={`${node.id}-literal`}
        onChange={value => update({ doneWhen: { ...node.config.doneWhen, value: value ?? null } })} />}
      <TextSourceField label="Reason" value={node.config.reason} readOnly={readOnly} onChange={reason => update({ reason })} />
      <TextSourceField label="Feedback for the next iteration" value={node.config.feedback} readOnly={readOnly} onChange={feedback => update({ feedback })} />
      <small className="muted">The decision is continue = not done. Missing pointers or wrong types fail instead of guessing.</small>
    </>}

    {node.type === 'loop' && <>
      {props.onOpenBody && <button className="button secondary wide" onClick={props.onOpenBody}><Repeat size={13} />Open loop body</button>}
      <TypeSelect label="Carried value type" value={node.config.valueType} readOnly={readOnly}
        onChange={valueType => replaceConfig({ ...node.config, valueType, stateSchema: valueType === 'JsonValue' ? (node.config.stateSchema || { type: 'object' }) : undefined })} />
      {node.config.valueType === 'JsonValue' && <JsonField label="State schema" hint="validates the seed and every candidate" value={node.config.stateSchema} readOnly={readOnly} keyId={`${node.id}-state`} objectOnly
        onChange={stateSchema => update({ stateSchema: stateSchema || { type: 'object' } })} />}
      <div className="field"><span>Fixed inputs <em>unchanged across iterations</em></span>
        {node.config.fixedInputs.map((input, index) => <div className="slot-row" key={index}>
          <input value={input.id} disabled={readOnly} onChange={event => update({ fixedInputs: node.config.fixedInputs.map((item, i) => i === index ? { ...item, id: event.target.value.toLowerCase() } : item) })} />
          <select value={input.type} disabled={readOnly} onChange={event => update({ fixedInputs: node.config.fixedInputs.map((item, i) => i === index ? { ...item, type: event.target.value as ValueType } : item) })}>
            {VALUE_TYPES.map(type => <option key={type}>{type}</option>)}
          </select>
          {!readOnly && <button className="icon-button" onClick={() => update({ fixedInputs: node.config.fixedInputs.filter((_, i) => i !== index) })}><X size={12} /></button>}
        </div>)}
        {!readOnly && <button className="button small ghost" onClick={() => update({ fixedInputs: [...node.config.fixedInputs, { id: `input-${node.config.fixedInputs.length + 1}`, type: 'Text' }] })}><Plus size={12} />Add fixed input</button>}
      </div>
      <div className="capacity-grid two">
        <label className="field"><span>Max iterations</span><input type="number" min={1} max={50} value={node.config.limits.maxIterations} disabled={readOnly}
          onChange={event => update({ limits: { ...node.config.limits, maxIterations: Math.min(50, Math.max(1, Number(event.target.value) || 1)) } })} /></label>
        <label className="field"><span>Max active minutes</span><input type="number" min={1} max={1440} value={node.config.limits.maxActiveMinutes} disabled={readOnly}
          onChange={event => update({ limits: { ...node.config.limits, maxActiveMinutes: Math.min(1440, Math.max(1, Number(event.target.value) || 1)) } })} /></label>
      </div>
      <small className="muted">Reaching a limit pauses for your decision; it never counts as success.</small>
    </>}

    {node.type === 'cache' && <>
      <TypeSelect label="Value type" value={node.config.valueType} readOnly={readOnly} onChange={valueType => update({ valueType })} />
      <label className="field"><span>Mode</span>
        <select value={node.config.mode} disabled={readOnly} onChange={event => update({ mode: event.target.value })}>
          <option value="live">Live — pass the producer's value through</option>
          <option value="frozen">Frozen — use the pinned value; the producer is not run for it</option>
        </select>
      </label>
      <div className="field"><span>Pin</span>
        {props.pin ? <small className="muted">{props.pin.value.type} {props.pin.value.artifact.sha256.slice(0, 12)}… from run {props.pin.sourceRunId.slice(0, 8)} · {new Date(props.pin.pinnedAt).toLocaleString()}</small>
          : <small className="muted">No pin yet. Run the workflow with this Cache Live, then pin its output.</small>}
        {props.pin?.sourceChanged && <small className="field-error">The producer changed since this value was pinned. Refresh to re-run it, or keep the old value deliberately.</small>}
        <div className="row tight">
          {props.onFreeze && <button className="button small secondary" onClick={props.onFreeze}><Lock size={12} />Pin output of the selected run</button>}
          {props.onRefresh && <button className="button small ghost" onClick={props.onRefresh} title="Run once with this Cache treated as Live and replace the pin on success"><RefreshCw size={12} />Run with refresh</button>}
        </div>
        {node.config.mode === 'live' && props.pin && <small className="muted"><Unlock size={11} /> Switch to Frozen to reuse the pin.</small>}
      </div>
    </>}

    {node.type === 'route' && <>
      <TypeSelect label="Routed value type" value={node.config.valueType} readOnly={readOnly} onChange={valueType => update({ valueType })} />
      <label className="field"><span>Selector <em>JSON Pointer into the selector input</em></span>
        <input value={node.config.selector} disabled={readOnly} placeholder="/status" onChange={event => update({ selector: event.target.value })} />
      </label>
      <div className="field"><span>Cases <em>exact JSON equality, no coercion; one output each</em></span>
        {node.config.cases.map((item, index) => <div className="slot-row" key={index}>
          <input value={item.id} disabled={readOnly} onChange={event => update({ cases: node.config.cases.map((other, i) => i === index ? { ...other, id: event.target.value.toLowerCase() } : other) })} />
          <LiteralInput value={item.equals} readOnly={readOnly} onChange={equals => update({ cases: node.config.cases.map((other, i) => i === index ? { ...other, equals } : other) })} />
          {!readOnly && node.config.cases.length > 1 && <button className="icon-button" onClick={() => update({ cases: node.config.cases.filter((_, i) => i !== index) })}><X size={12} /></button>}
        </div>)}
        {!readOnly && <button className="button small ghost" onClick={() => update({ cases: [...node.config.cases, { id: `case-${node.config.cases.length + 1}`, equals: '' }] })}><Plus size={12} />Add case</button>}
      </div>
      <label className="field"><span>When nothing matches</span>
        <select value={node.config.onUnmatched} disabled={readOnly} onChange={event => update({ onUnmatched: event.target.value })}>
          <option value="error">Fail the Route (route_unmatched)</option><option value="pause">Fail and wait for my decision</option>
        </select>
      </label>
      <small className="muted">Outputs of cases that were not selected are inactive: nodes that need them are skipped. Join alternatives with a selected Merge.</small>
    </>}

    {node.type === 'gate' && <>
      <label className="field"><span>Mode</span>
        <select value={node.config.mode} disabled={readOnly} onChange={event => update({ mode: event.target.value })}>
          <option value="prepare">Prepare — validate the bundle, build role views and a review plan</option>
          <option value="evaluate">Evaluate — check every review, update issues, issue a certificate</option>
          <option value="verify">Verify — accept only an engine-issued certificate for this subject</option>
        </select>
      </label>
      {node.config.mode === 'prepare' && <label className="field"><span>Subject</span>
        <select value={node.config.subject || 'specification'} disabled={readOnly} onChange={event => replaceConfig(event.target.value === 'delivery'
          ? { mode: 'prepare', policy: node.config.policy, subject: 'delivery', specificationPolicy: structuredClone(node.config.policy) }
          : { mode: 'prepare', policy: node.config.policy })}>
          <option value="specification">Specification bundle (SPEC + index + map)</option>
          <option value="delivery">Delivery: approved spec + completed Map + candidate + passing checks</option>
        </select></label>}
      {node.config.subject === 'delivery' && <>
        <small className="muted">The delivery subject is built only from engine evidence: the specification certificate (verified under the policy below), the completed MapState, its Candidate and a passing CheckReport for every check criterion.</small>
        <PolicyEditor policy={node.config.specificationPolicy || { slots: [] }} readOnly={readOnly} onChange={specificationPolicy => update({ specificationPolicy })} />
        <label className="check"><input type="checkbox" checked={Boolean(node.config.technicalPolicy)} disabled={readOnly}
          onChange={event => update({ technicalPolicy: event.target.checked ? { slots: [{ id: 'quality', role: 'reviewer', view: 'full' }, { id: 'conformance', role: 'analyst', view: 'full' }] } : undefined })} />
          Final Customer stage: require a technical certificate for this exact delivery (adds a <code>technical</code> input)</label>
        {node.config.technicalPolicy && <PolicyEditor policy={node.config.technicalPolicy} readOnly={readOnly} onChange={technicalPolicy => update({ technicalPolicy })} />}
      </>}
      {node.config.mode === 'prepare' && node.config.subject !== 'delivery' && <label className="check"><input type="checkbox" checked={Boolean(node.config.carry)} disabled={readOnly}
        onChange={event => update({ carry: event.target.checked || undefined })} />Carry unchanged approvals (adds a <code>prior</code> input and a <code>&lt;slot&gt;-need</code> output per slot)</label>}
      {node.config.mode === 'prepare' && node.config.carry && <small className="muted">Route each slot on <code>/needsReview</code>: live → the reviewer's prompt, carried → JSON Select <code>/carry</code>; join both with a selected Merge into evaluate.</small>}
      <PolicyEditor policy={node.config.policy} readOnly={readOnly} onChange={policy => update({ policy })} />
      <small className="muted">Use the same policy in prepare, evaluate and verify; a certificate from another policy never opens the gate. Review slots must come from the <code>json</code> output of an Agent.</small>
    </>}

    {node.type === 'map' && <>
      <PolicyEditor policy={node.config.approvalPolicy} readOnly={readOnly} onChange={approvalPolicy => update({ approvalPolicy })} />
      <small className="muted">The approval certificate must come from a Gate with this exact policy and the same documentation bundle.</small>
      <div className="field"><span>Optional inputs</span>
        {(['prior-state', 'repair'] as const).map(id => <label className="check" key={id}><input type="checkbox" disabled={readOnly} checked={node.config.optionalInputs.includes(id)}
          onChange={event => update({ optionalInputs: event.target.checked ? [...node.config.optionalInputs, id] : node.config.optionalInputs.filter(item => item !== id) })} />
          {id === 'prior-state' ? 'prior-state — a stored MapState for same-specification carry' : 'repair — a MapRepair request for selected tasks'}</label>)}
      </div>
      <div className="capacity-grid two">
        <label className="field"><span>Max failed verification cycles</span><input type="number" min={1} max={20} value={node.config.limits.maxFailedVerificationCycles} disabled={readOnly}
          onChange={event => update({ limits: { ...node.config.limits, maxFailedVerificationCycles: Math.min(20, Math.max(1, Number(event.target.value) || 1)) } })} /></label>
        <label className="field"><span>Max attempts per task</span><input type="number" min={1} max={20} value={node.config.limits.maxTaskAttempts} disabled={readOnly}
          onChange={event => update({ limits: { ...node.config.limits, maxTaskAttempts: Math.min(20, Math.max(1, Number(event.target.value) || 1)) } })} /></label>
      </div>
      <label className="check"><input type="checkbox" checked={Boolean(node.config.carryAcrossRevisions)} disabled={readOnly} onChange={event => update({ carryAcrossRevisions: event.target.checked || undefined })} />
        Carry unchanged tasks across specification revisions (verified task fingerprints)</label>
      <RolesEditor roles={node.config.roles} readOnly={readOnly} contexts={visibleContexts} onChange={roles => update({ roles })} />
      {client && props.runId && instanceId && <MapNavigatorView client={client} runId={props.runId} instanceId={instanceId} live={Boolean(props.runActive)} />}
    </>}

    {client && instanceId && node.type !== 'map' && <AttemptDetails client={client} instanceId={instanceId} events={events} contexts={contexts} isContext={node.type === 'context'} />}
  </div>;
}

export function EffortField({ value, readOnly, onChange }: { value?: Effort; readOnly: boolean; onChange: (effort: Effort) => void }) {
  return <label className="field"><span>Reasoning effort</span>
    <select value={value ?? (readOnly ? '' : DEFAULT_EFFORT)} disabled={readOnly} onChange={event => onChange(event.target.value as Effort)}>
      {readOnly && value === undefined && <option value="">Not specified in snapshot</option>}
      {EFFORT_LEVELS.map(effort => <option key={effort} value={effort}>{effort === 'xhigh' ? 'Extra high (xhigh)' : effort[0].toUpperCase() + effort.slice(1)}</option>)}
    </select>
    {value === undefined && !readOnly && <small className="muted">New runs use medium. Choose a level to save it explicitly.</small>}
  </label>;
}

function RolesEditor({ roles, readOnly, contexts, onChange }: { roles: MapRole[]; readOnly: boolean; contexts: WorkflowNode[]; onChange: (roles: MapRole[]) => void }) {
  const set = (index: number, role: MapRole) => onChange(roles.map((item, i) => (i === index ? role : item)));
  return <div className="field"><span>Role registry <em>pinned into every run; models are explicit</em></span>
    {roles.map((role, index) => <div className="record-field" key={index}>
      <div className="slot-row">
        <input value={role.id} disabled={readOnly} onChange={event => set(index, { ...role, id: event.target.value.toLowerCase() })} />
        <span className="muted small">{role.kind === 'agent' ? 'Agent' : 'Verification utility'}</span>
        {!readOnly && roles.length > 1 && <button className="icon-button" onClick={() => onChange(roles.filter((_, i) => i !== index))}><X size={12} /></button>}
      </div>
      {role.kind === 'agent' ? <>
        <div className="slot-row">
          <select value={role.provider} disabled={readOnly} onChange={event => set(index, { ...role, provider: event.target.value as Provider, context: 'task' })}>
            {PROVIDERS.map(provider => <option key={provider} value={provider}>{PROVIDER_NAMES[provider]}</option>)}
          </select>
          <input value={role.model} disabled={readOnly} placeholder="Exact model ID" onChange={event => set(index, { ...role, model: event.target.value.trim() })} />
        </div>
        {!role.model && <small className="field-error">A model ID is required before saving.</small>}
        <EffortField value={role.effort} readOnly={readOnly} onChange={effort => set(index, { ...role, effort })} />
        <textarea rows={2} value={role.instructions} disabled={readOnly} onChange={event => set(index, { ...role, instructions: event.target.value })} />
        <select value={role.context === 'task' ? '' : role.context.contextId} disabled={readOnly} onChange={event => set(index, { ...role, context: event.target.value ? { contextId: event.target.value } : 'task' })}>
          <option value="">Fresh Context per task (task directory)</option>
          {contexts.filter(item => item.type === 'context' && item.config.provider === role.provider).map(item => <option key={item.id} value={item.id}>Continue Context {item.id} (workspace directory)</option>)}
        </select>
      </> : <label className="field"><span>Embedded triage role</span>
        <select value={role.embeddedRoles.triage} disabled={readOnly} onChange={event => set(index, { ...role, embeddedRoles: { triage: event.target.value } })}>
          {roles.filter(item => item.kind === 'agent').map(item => <option key={item.id} value={item.id}>{item.id}</option>)}
        </select></label>}
    </div>)}
    {!readOnly && <div className="row tight">
      <button className="button small ghost" onClick={() => onChange([...roles, { id: `role-${roles.length + 1}`, kind: 'agent', provider: 'codex', model: '', effort: DEFAULT_EFFORT, instructions: 'Describe this role.', timeoutSeconds: 600, context: 'task' }])}><Plus size={12} />Agent role</button>
      {!roles.some(role => role.kind === 'utility') && <button className="button small ghost" onClick={() => onChange([...roles, { id: 'verification', kind: 'utility', template: 'verification', embeddedRoles: { triage: roles.find(role => role.kind === 'agent')?.id || 'analyst' } }])}><Plus size={12} />Verification utility</button>}
    </div>}
  </div>;
}

function ManagedTaskView({ client, runId, instanceId, live }: { client: Client; runId: string; instanceId: string; live: boolean }) {
  const [nav, setNav] = useState<ManagedTaskNavigator | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let canceled = false;
    const load = () => client.get<ManagedTaskNavigator>(`/runs/${runId}/tasks/${encodeURIComponent(instanceId)}`)
      .then(value => { if (!canceled) { setNav(value); setError(null); } }).catch(problem => { if (!canceled) setError((problem as Error).message); });
    void load(); const timer = live ? setInterval(load, 1000) : null;
    return () => { canceled = true; if (timer) clearInterval(timer); };
  }, [client, runId, instanceId, live]);
  if (error) return <p className="muted small">{error}</p>;
  if (!nav) return null;
  return <div className="result-section">
    <h4>Task execution <span className={`state-chip ${nav.state}`}>{nav.state}</span></h4>
    <p className="small">Current phase: <code>{nav.phase || '—'}</code></p>
    <p className="muted small">{nav.work.attempts} aggregate attempts · {nav.work.repairs} repairs · {Math.ceil(nav.work.remainingMilliseconds / 1000)} s remaining · {nav.work.outputBytes} captured bytes</p>
    {nav.plan && <><p className="small">Risk: <strong>{nav.plan.classification.winningClassification}</strong></p><p className="muted small">{nav.plan.classification.reason}</p><p className="small">{nav.plan.selectedStages.join(' → ')}</p></>}
    {nav.incompleteReason && <p className="field-error">{nav.incompleteReason}</p>}
    <p className="muted small">Acceptance records: {nav.acceptanceRecordIds.length}</p>
    {nav.delivery && <p className="small">{nav.delivery.status} · <code>{nav.delivery.targetBranchRef}</code></p>}
    {nav.deliveryOperation && <p className="muted small">Delivery operation: {nav.deliveryOperation.phase}</p>}
  </div>;
}

// Basic Map navigator: progress, counter and per-task state, criteria and steps; reads never run anything.
function MapNavigatorView({ client, runId, instanceId, live }: { client: Client; runId: string; instanceId: string; live: boolean }) {
  const [nav, setNav] = useState<MapNavigator | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [history, setHistory] = useState<MapHistory | null>(null);
  const [execution, setExecution] = useState<string | null>(null);
  useEffect(() => {
    let canceled = false;
    const path = execution ? `/map-executions/${execution}` : `/runs/${runId}/maps/${encodeURIComponent(instanceId)}`;
    const load = () => Promise.all([client.get<MapNavigator>(path), client.get<MapHistory>(`/runs/${runId}/maps/${encodeURIComponent(instanceId)}/executions`)])
      .then(([value, generations]) => { if (!canceled) { setNav(value); setHistory(generations); setError(null); } })
      .catch(problem => { if (!canceled) setError((problem as Error).message); });
    load();
    const timer = live && !execution ? setInterval(load, 1000) : null;
    return () => { canceled = true; if (timer) clearInterval(timer); };
  }, [client, runId, instanceId, live, execution]);
  if (error) return <div className="result-section"><h4>Map navigator</h4><small className="muted">{error}</small></div>;
  if (!nav) return null;
  const levels = new Map<string, number>();
  const level = (id: string): number => {
    if (!levels.has(id)) { const task = nav.tasks.find(item => item.taskId === id)!; levels.set(id, task.dependsOn.length ? 1 + Math.max(...task.dependsOn.map(level)) : 0); }
    return levels.get(id)!;
  };
  const columns: string[][] = [];
  for (const task of nav.tasks) (columns[level(task.taskId)] ||= []).push(task.taskId);
  return <div className="result-section map-nav">
    <h4>Map navigator <span className={`state-chip ${nav.state}`}>{STATE_LABELS[nav.state] || nav.state}</span></h4>
    <div className="map-progress"><i style={{ width: `${(100 * nav.progress.accepted) / nav.progress.total}%` }} /></div>
    <small className="muted">{nav.progress.accepted}/{nav.progress.total} accepted · {nav.progress.running} running · {nav.progress.waiting} waiting · {nav.progress.blocked} blocked ·
      verification failures {nav.failedVerificationCycles}/{nav.maxFailedVerificationCycles} · generation {nav.generation} · {nav.specificationId}{nav.pauseReason ? ` · paused: ${nav.pauseReason.replace(/_/g, ' ')}` : ''}</small>
    {history && history.executions.length > 1 && <div className="map-history">
      <span className="muted small">Generations:</span>
      {history.executions.map((item, index) => <button key={item.mapExecutionId} className={`chip-button ${(execution || history.executions[0].mapExecutionId) === item.mapExecutionId ? 'active' : ''}`}
        onClick={() => setExecution(index === 0 ? null : item.mapExecutionId)} title={`${item.specificationId} · run ${item.runId.slice(0, 8)} · ${item.state}`}>
        G{item.generation} · {item.accepted}/{item.total}{item.carried ? ` · ${item.carried} carried` : ''}{item.runId !== runId ? ' · earlier run' : ''}</button>)}
    </div>}
    {execution && <small className="muted">Historical generation (read-only): {nav.specificationId}.</small>}
    <div className="map-graph">{columns.map((ids, index) => <div className="map-column" key={index}>{ids.map(id => {
      const task = nav.tasks.find(item => item.taskId === id)!;
      return <button key={id} className={`map-task ${task.state} ${open === id ? 'open' : ''}`} onClick={() => setOpen(open === id ? null : id)} title={task.title}>
        <strong>{id}</strong><span className={`state-chip ${task.state}`}>{STATE_LABELS[task.state] || task.state}</span>
      </button>;
    })}</div>)}</div>
    {nav.tasks.filter(task => task.taskId === open).map(task => <div className="map-detail" key={task.taskId}>
      <strong>{task.taskId} — {task.title}</strong>
      <small className="muted">{task.executorRole} · {task.attempts} attempt(s){task.carried ? ' · carried from the prior state' : ''}{task.selectedResultId ? ` · selected ${task.selectedResultId}` : ''}{task.readiness ? ` · ${task.readiness}` : ''}</small>
      {task.carriedFrom && <small className="muted">Carried {task.carriedFrom.crossRevision ? `from ${task.carriedFrom.subjectId} (verified fingerprint${task.carriedFrom.carryRecordId ? `, ${task.carriedFrom.carryRecordId}` : ''})` : 'within the same specification'} · result {task.carriedFrom.resultId}</small>}
      {task.results && task.results.length > 0 && <ul className="map-list">{task.results.map(item => <li key={item.recordId}><span className={`state-chip ${item.status === 'accepted' || item.status === 'carried' ? 'succeeded' : item.status === 'pending' ? 'scheduled' : 'failed'}`}>{item.status}</span> {item.recordId}</li>)}</ul>}
      <ul className="map-list">{task.criteria.map(item => <li key={item.id}><span className={`state-chip ${item.verdict === 'passed' ? 'succeeded' : item.verdict === 'failed' ? 'failed' : 'scheduled'}`}>{item.verdict}</span> {item.id} · {item.method}{item.recordId ? ` · ${item.recordId}` : ''}</li>)}</ul>
      {task.steps.length > 0 && <ul className="map-list">{task.steps.map(step => <li key={step.nodeInstanceId}><span className={`state-chip ${step.state}`}>{STATE_LABELS[step.state] || step.state}</span> {step.step}{step.ordinal > 1 ? ` · attempt ${step.ordinal}` : ''}</li>)}</ul>}
      {task.issues.length > 0 && <ul className="map-list">{task.issues.map(issue => <li key={issue.id}><code>{issue.id}</code> {issue.message} → {issue.requestedChange}</li>)}</ul>}
    </div>)}
  </div>;
}

function LiteralInput({ value, readOnly, onChange }: { value: unknown; readOnly: boolean; onChange: (value: unknown) => void }) {
  const [text, setText] = useState(JSON.stringify(value));
  const [error, setError] = useState(false);
  return <input className={error ? 'invalid' : ''} value={text} disabled={readOnly} title="A JSON literal, for example &quot;OPEN&quot;, true or 3" onChange={event => {
    setText(event.target.value);
    try { onChange(JSON.parse(event.target.value)); setError(false); } catch { setError(true); }
  }} />;
}

function PolicyEditor({ policy, readOnly, onChange }: { policy: GatePolicy; readOnly: boolean; onChange: (policy: GatePolicy) => void }) {
  const set = (index: number, patch: Partial<GatePolicy['slots'][number]>) => onChange({ slots: policy.slots.map((slot, i) => i === index ? { ...slot, ...patch } : slot) });
  return <div className="field"><span>Review slots <em>slot ID · role · view · optional scope</em></span>
    {policy.slots.map((slot, index) => <div className="slot-row" key={index}>
      <input value={slot.id} disabled={readOnly} onChange={event => set(index, { id: event.target.value.toLowerCase() })} />
      <input value={slot.role} disabled={readOnly} onChange={event => set(index, { role: event.target.value.toLowerCase() })} />
      <select value={slot.view} disabled={readOnly} onChange={event => set(index, { view: event.target.value as 'full' | 'public' })}><option value="full">full</option><option value="public">public</option></select>
      <input className="narrow" value={(slot.scopeRefs || []).join(', ')} disabled={readOnly} placeholder="whole view" title="Optional scope: section IDs whose closure this slot reviews"
        onChange={event => { const refs = event.target.value.split(',').map(item => item.trim().toUpperCase()).filter(Boolean); set(index, { scopeRefs: refs.length ? refs : undefined }); }} />
      {!readOnly && policy.slots.length > 1 && <button className="icon-button" onClick={() => onChange({ slots: policy.slots.filter((_, i) => i !== index) })}><X size={12} /></button>}
    </div>)}
    {!readOnly && <button className="button small ghost" onClick={() => onChange({ slots: [...policy.slots, { id: `slot-${policy.slots.length + 1}`, role: 'reviewer', view: 'full' }] })}><Plus size={12} />Add slot</button>}
  </div>;
}

function TypeSelect({ label, value, readOnly, onChange }: { label: string; value: ValueType; readOnly: boolean; onChange: (value: ValueType) => void }) {
  return <label className="field"><span>{label}</span><select value={value} disabled={readOnly} onChange={event => onChange(event.target.value as ValueType)}>
    {VALUE_TYPES.map(type => <option key={type}>{type}</option>)}
  </select></label>;
}

function StringList({ label, hint, values, readOnly, placeholder, onChange }: { label: string; hint: string; values: string[]; readOnly: boolean; placeholder: string; onChange: (values: string[]) => void }) {
  return <div className="field"><span>{label} <em>{hint}</em></span>
    {values.map((value, index) => <div className="slot-row" key={index}>
      <input value={value} disabled={readOnly} onChange={event => onChange(values.map((item, i) => i === index ? event.target.value : item))} />
      {!readOnly && <button className="icon-button" onClick={() => onChange(values.filter((_, i) => i !== index))}><X size={12} /></button>}
    </div>)}
    {!readOnly && <button className="button small ghost" onClick={() => onChange([...values, placeholder])}><Plus size={12} />Add</button>}
  </div>;
}

function JsonField({ label, hint, value, readOnly, keyId, onChange, objectOnly = false }: { label: string; hint: string; value: unknown; readOnly: boolean; keyId: string; onChange: (value: any) => void; objectOnly?: boolean }) {
  const [text, setText] = useState(value === undefined ? '' : JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setText(value === undefined ? '' : JSON.stringify(value, null, 2)); setError(null); }, [keyId]); // eslint-disable-line react-hooks/exhaustive-deps
  return <label className="field"><span>{label} <em>{hint}</em></span>
    <textarea rows={6} value={text} disabled={readOnly} spellCheck={false} onChange={event => {
      const next = event.target.value; setText(next);
      if (!next.trim()) { setError(null); onChange(undefined); return; }
      try {
        const parsed = JSON.parse(next);
        if (objectOnly && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) throw new Error('A JSON object is required.');
        setError(null); onChange(parsed);
      } catch (problem) { setError((problem as Error).message); }
    }} />
    {error && <small className="field-error">{error} — the last valid value is kept.</small>}
  </label>;
}

function TextSourceField({ label, value, readOnly, onChange }: { label: string; value: TextSource; readOnly: boolean; onChange: (value: TextSource) => void }) {
  const literal = 'literal' in value;
  return <div className="field"><span>{label}</span>
    <div className="row">
      <select className="narrow" value={literal ? 'literal' : 'pointer'} disabled={readOnly} onChange={event => onChange(event.target.value === 'literal' ? { literal: '' } : { pointer: '/reason' })}>
        <option value="literal">Literal</option><option value="pointer">Pointer</option>
      </select>
      <input value={literal ? value.literal : value.pointer} disabled={readOnly} onChange={event => onChange(literal ? { literal: event.target.value } : { pointer: event.target.value })} />
    </div>
  </div>;
}

function MergeEditor({ node, readOnly, replaceConfig }: { node: Extract<WorkflowNode, { type: 'merge' }>; readOnly: boolean; replaceConfig: (config: object) => void }) {
  const config = node.config;
  const inputs = config.inputs as { id: string; type?: ValueType }[];
  const setInputs = (next: { id: string; type?: ValueType }[]) => replaceConfig({ ...config, inputs: config.mode === 'record' ? next.map(item => ({ id: item.id, type: item.type || 'Text' })) : next.map(item => ({ id: item.id })) });
  return <>
    <label className="field"><span>Mode</span>
      <select value={config.mode} disabled={readOnly} onChange={event => {
        const mode = event.target.value;
        const ids = inputs.map(item => ({ id: item.id }));
        if (mode === 'text') replaceConfig({ mode, inputs: ids, separator: '\n\n' });
        else if (mode === 'artifacts') replaceConfig({ mode, inputs: ids });
        else if (mode === 'selected') replaceConfig({ mode, valueType: 'JsonValue', inputs: ids });
        else replaceConfig({ mode, inputs: ids.map(item => ({ ...item, type: 'Text' })), fields: ids.map(item => ({ name: item.id.replace(/-/g, '_'), source: { input: item.id } })) });
      }}>
        <option value="text">Text — concatenate in order</option>
        <option value="artifacts">ArtifactSet — union without overwrites</option>
        <option value="record">JSON record — named fields</option>
        <option value="selected">Selected — exactly one active alternative</option>
      </select>
    </label>
    <div className="field"><span>Inputs <em>in order</em></span>
      {inputs.map((input, index) => <div className="slot-row" key={index}>
        <input value={input.id} disabled={readOnly} onChange={event => setInputs(inputs.map((item, i) => i === index ? { ...item, id: event.target.value.toLowerCase() } : item))} />
        {config.mode === 'record' && <select value={input.type} disabled={readOnly} onChange={event => setInputs(inputs.map((item, i) => i === index ? { ...item, type: event.target.value as ValueType } : item))}>
          {VALUE_TYPES.map(type => <option key={type}>{type}</option>)}</select>}
        {!readOnly && <button className="icon-button" onClick={() => setInputs(inputs.filter((_, i) => i !== index))}><X size={12} /></button>}
      </div>)}
      {!readOnly && <button className="button small ghost" onClick={() => setInputs([...inputs, { id: `input-${inputs.length + 1}`, type: 'Text' }])}><Plus size={12} />Add input</button>}
    </div>
    {config.mode === 'selected' && <TypeSelect label="Value type" value={config.valueType} readOnly={readOnly} onChange={valueType => replaceConfig({ ...config, valueType })} />}
    {config.mode === 'selected' && <small className="muted">Commits the one alternative that is active after a Route. Two active alternatives are a contract error; none makes this Merge inactive too.</small>}
    {config.mode === 'text' && <label className="field"><span>Separator <em>literal; \n is a newline</em></span>
      <input value={config.separator.replace(/\n/g, '\\n')} disabled={readOnly} onChange={event => replaceConfig({ ...config, separator: event.target.value.replace(/\\n/g, '\n') })} /></label>}
    {config.mode === 'record' && <div className="field"><span>Fields</span>
      {config.fields.map((field, index) => {
        const source = field.source as FieldSource;
        const kind = 'literal' in source ? 'literal' : source.pointer !== undefined ? 'pointer' : 'input';
        const setField = (next: { name: string; source: FieldSource }) => replaceConfig({ ...config, fields: config.fields.map((item, i) => i === index ? next : item) });
        return <div className="record-field" key={index}>
          <div className="slot-row">
            <input value={field.name} disabled={readOnly} placeholder="name" onChange={event => setField({ ...field, name: event.target.value })} />
            <select value={kind} disabled={readOnly} onChange={event => {
              const next = event.target.value;
              setField({ ...field, source: next === 'literal' ? { literal: '' } : { input: inputs[0]?.id || '', ...(next === 'pointer' ? { pointer: '/' } : {}) } });
            }}><option value="input">Input value</option><option value="pointer">Input + pointer</option><option value="literal">Literal JSON</option></select>
            {!readOnly && <button className="icon-button" onClick={() => replaceConfig({ ...config, fields: config.fields.filter((_, i) => i !== index) })}><X size={12} /></button>}
          </div>
          {kind !== 'literal' && 'input' in source && <div className="slot-row">
            <select value={source.input} disabled={readOnly} onChange={event => setField({ ...field, source: { ...source, input: event.target.value } })}>
              {inputs.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}
            </select>
            {kind === 'pointer' && <input value={source.pointer} disabled={readOnly} onChange={event => setField({ ...field, source: { ...source, pointer: event.target.value } })} />}
          </div>}
          {kind === 'literal' && <JsonField label="Literal" hint="JSON" value={(source as { literal: unknown }).literal} readOnly={readOnly} keyId={`${node.id}-${index}`} onChange={value => setField({ ...field, source: { literal: value ?? null } })} />}
        </div>;
      })}
      {!readOnly && <button className="button small ghost" onClick={() => replaceConfig({ ...config, fields: [...config.fields, { name: `field_${config.fields.length + 1}`, source: { literal: '' } }] })}><Plus size={12} />Add field</button>}
    </div>}
  </>;
}

function AttemptDetails({ client, instanceId, events, contexts, isContext }: { client: Client; instanceId: string; events: JournalEvent[]; contexts: { contextNodeId: string; bindingId: string }[]; isContext: boolean }) {
  const mine = events.filter(event => event.nodeInstanceId === instanceId);
  const lastAttempt = [...mine].reverse().find(event => event.type === 'attempt.state_changed' && event.payload.from === null)?.attemptId;
  const current = mine.filter(event => event.attemptId === lastAttempt || event.attemptId === null);
  const inputs = current.find(event => event.type === 'attempt.inputs_committed');
  const reused = current.find(event => event.type === 'attempt.reused');
  const outputs = current.find(event => event.type === 'attempt.outputs_committed') || (reused ? { ...reused, payload: { manifest: reused.payload.outputs } } : undefined);
  const invocation = current.find(event => event.type === 'attempt.invocation_committed');
  const error = current.find(event => event.type === 'attempt.error');
  const attempts = mine.filter(event => event.type === 'attempt.state_changed' && event.payload.from === null).length;
  const [detail, setDetail] = useState<{ inputs?: string; outputs?: Record<string, string>; model?: string; logs?: string; invocation?: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const logChunks = current.filter(event => event.type === 'attempt.log_chunk' && event.payload.stream !== 'stdout');
  const key = `${instanceId}|${inputs?.id}|${outputs?.id}|${invocation?.id}|${logChunks.length}`;
  useEffect(() => {
    let canceled = false;
    (async () => {
      try { const result = await loadAttempt(client, inputs, outputs, invocation, logChunks); if (!canceled) { setDetail(result); setLoadError(null); } }
      catch (problem) { if (!canceled) setLoadError((problem as Error).message); }
    })();
    return () => { canceled = true; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isContext) {
    const mapping = contexts.find(item => item.contextNodeId === instanceId);
    return mapping ? <div className="result-section"><h4>Selected run</h4><small className="muted">Bound to {mapping.bindingId}</small></div> : null;
  }
  if (!mine.length) return null;
  const state = [...mine].reverse().find(event => event.type === 'attempt.state_changed')?.payload.to;
  return <div className="result-section">
    <h4>Selected run <span className={`state-chip ${state}`}>{STATE_LABELS[state] || state}</span>{attempts > 1 && <small className="muted">attempt {attempts}</small>}</h4>
    <AttemptView detail={detail} loadError={loadError} error={error ? { code: error.payload.code, message: error.payload.message } : null} state={state} />
  </div>;
}

export async function loadAttempt(client: Client, inputs?: JournalEvent, outputs?: JournalEvent, invocation?: JournalEvent, logChunks: JournalEvent[] = []) {
  const result: { inputs?: string; outputs?: Record<string, string>; model?: string; logs?: string; invocation?: string } = {};
  if (inputs) {
    const manifest = await client.artifactJson(inputs.payload.manifest.artifactId);
    if (manifest.prompt) result.inputs = await client.artifactText(manifest.prompt.artifactId);
    else {
      const parts: string[] = [];
      for (const [port, value] of Object.entries<any>(manifest.values)) parts.push(`${port} (${value.type}):\n${await client.artifactText(value.artifact.artifactId)}`);
      result.inputs = parts.join('\n\n') || '(no inputs)';
    }
  }
  if (outputs) {
    const manifest = await client.artifactJson(outputs.payload.manifest.artifactId);
    result.outputs = {};
    for (const [port, value] of Object.entries<any>(manifest.values)) {
      const text = await client.artifactText(value.artifact.artifactId);
      result.outputs[`${port} · ${value.type}`] = value.type === 'ArtifactSet' ? describeSet(JSON.parse(text)) : text;
    }
    if (manifest.providerResult) result.model = `${manifest.providerResult.requestedModel}${manifest.providerResult.observedModel ? ` → observed ${manifest.providerResult.observedModel}` : ''}${manifest.providerResult.requestedEffort ? ` · requested effort: ${manifest.providerResult.requestedEffort}` : ''}`;
  }
  if (invocation) {
    const manifest = await client.artifactJson(invocation.payload.manifest.artifactId);
    result.invocation = `${manifest.cliExecutable} ${manifest.arguments.map((arg: string) => (/\s/.test(arg) ? JSON.stringify(arg.length > 80 ? `${arg.slice(0, 80)}…` : arg) : arg)).join(' ')}\ncwd: ${manifest.cwd}\nnative configuration: ${manifest.nativeConfiguration}`;
  }
  if (logChunks.length) {
    let text = '';
    for (const chunk of logChunks) text += await client.artifactText(chunk.payload.chunk.artifactId);
    result.logs = text.split('\n').map(line => { try { const item = JSON.parse(line); return item.text ?? (item.sessionId ? `[session ${item.sessionId}]` : item.error ? `[error] ${item.error}` : ''); } catch { return line; } }).join('');
  }
  return result;
}

const describeSet = (manifest: { entries: { path: string; byteSize: number; artifact: { artifactId: string } }[] }) =>
  manifest.entries.length ? manifest.entries.map(entry => `${entry.path}  (${entry.byteSize} bytes, ${entry.artifact.artifactId.slice(0, 8)})`).join('\n') : '(empty set)';

export function AttemptView({ detail, loadError, error, state }: { detail: Awaited<ReturnType<typeof loadAttempt>> | null; loadError: string | null; error: { code: string; message: string } | null; state?: string }) {
  return <>
    {loadError && <div className="result-error">{loadError}</div>}
    {error && <div className="result-error"><strong>{error.code}</strong> {error.message}</div>}
    {detail?.model && <small className="muted">Model: {detail.model}</small>}
    {detail?.inputs !== undefined && <details open={!detail.outputs}><summary>Resolved input</summary><pre>{detail.inputs}</pre></details>}
    {detail?.outputs && Object.entries(detail.outputs).map(([port, text]) => <details open key={port}><summary>Output · {port}</summary><pre>{pretty(text)}</pre></details>)}
    {detail?.logs && <details><summary>Stream and stderr</summary><pre>{detail.logs}</pre></details>}
    {detail?.invocation && <details><summary>Invocation</summary><pre>{detail.invocation}</pre></details>}
    {state === 'scheduled' && <small className="muted"><AlertTriangle size={12} /> Held: waiting for predecessors or a recovery decision.</small>}
  </>;
}

function pretty(text: string) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}
