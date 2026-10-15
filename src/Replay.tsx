import { useEffect, useMemo, useState } from 'react';
import { Background, BackgroundVariant, Controls, ReactFlow, ReactFlowProvider } from '@xyflow/react';
import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, History, X } from 'lucide-react';
import { describeEvent, project, replaySteps } from '../shared/replay.mjs';
import { NODE_LABELS, loopOf, toFlow } from './model';
import { nodeTypes, STATE_LABELS } from './nodes';
import { AttemptView, loadAttempt } from './Inspector';
import type { Client } from './transport';
import type { JournalEvent, RunSnapshot, Workflow } from './types';

// Read-only projection of a saved run: no commands, provider calls or file restoration.
export function Replay({ client, runId, onExit }: { client: Client; runId: string; onExit: () => void }) {
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [events, setEvents] = useState<JournalEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [includeLogs, setIncludeLogs] = useState(false);
  const [position, setPosition] = useState(0);
  const [scope, setScope] = useState<string | null>(null);
  const [iteration, setIteration] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [run, setRun] = useState<RunSnapshot | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const snapshot = await client.get<RunSnapshot>(`/runs/${runId}`);
        setRun(snapshot);
        setWorkflow(await client.artifactJson<Workflow>(snapshot.run.workflowSnapshot.artifactId));
        // Capture a stable persisted prefix; a live run keeps streaming, so stop at its last sequence.
        const collected: JournalEvent[] = [];
        const target = snapshot.run.lastSequence;
        await client.stream(runId, 0, controller.signal, event => {
          collected.push(event);
          if (event.sequence >= target) controller.abort();
        }).catch(problem => { if (!controller.signal.aborted) throw problem; });
        setEvents(collected);
      } catch (problem) { if (!controller.signal.aborted) setError((problem as Error).message); }
    })();
    return () => controller.abort();
  }, [client, runId]);

  const steps = useMemo(() => replaySteps(events, { includeLogs }), [events, includeLogs]);
  useEffect(() => { setPosition(Math.max(0, steps.length - 1)); }, [steps.length]);
  const index = steps[position] ?? -1;
  const view = useMemo(() => (index >= 0 ? project(events, index) : null), [events, index]);
  // A scope is a loop instance ID (for example delivery/1/specification); its node is the last segment.
  const loopInstances = run?.loops.map(loop => loop.loopNodeId) || [];
  const loopView = scope ? view?.loops.get(scope) : undefined;
  const scopeNode = scope ? scope.split('/').pop()! : null;
  const prefix = scope ? `${scope}/${iteration}/` : '';
  const instanceId = (nodeId: string) => prefix + nodeId;

  const flow = useMemo(() => {
    if (!workflow) return { nodes: [], edges: [] };
    const converted = toFlow(workflow, scopeNode);
    return {
      nodes: converted.nodes.map(node => {
        const item = node.data.node ? view?.instances.get(instanceId(node.id)) : undefined;
        const loop = node.data.node?.type === 'loop' ? view?.loops.get(instanceId(node.id)) : undefined;
        const state = loop?.state === 'paused' || loop?.state === 'finished' ? loop.state : item?.state;
        return { ...node, draggable: false, connectable: false, selected: node.id === selected, data: { ...node.data, state } };
      }),
      edges: converted.edges.map(edge => ({ ...edge, selectable: false })),
    };
  }, [workflow, scope, view, iteration, selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = view?.current;
  const go = (next: number) => setPosition(Math.min(Math.max(0, next), steps.length - 1));
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.key === 'ArrowRight') go(position + 1);
      if (event.key === 'ArrowLeft') go(position - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const selectedNode = selected && workflow ? (scopeNode ? loopOf(workflow, scopeNode)?.config.body.nodes.find(node => node.id === selected) : workflow.nodes.find(node => node.id === selected)) : null;
  const projected = selected ? view?.instances.get(instanceId(selected)) : undefined;

  return <div className="replay">
    <div className="replay-bar">
      <span className="replay-title"><History size={14} />Replay · {run?.run.workflowId} · <code>{runId.slice(0, 8)}</code></span>
      <button className="icon-button" onClick={() => go(0)} title="First step"><ChevronFirst size={16} /></button>
      <button className="icon-button" onClick={() => go(position - 1)} title="Previous (←)"><ChevronLeft size={16} /></button>
      <input className="replay-slider" type="range" min={0} max={Math.max(0, steps.length - 1)} value={position} onChange={event => go(Number(event.target.value))} />
      <button className="icon-button" onClick={() => go(position + 1)} title="Next (→)"><ChevronRight size={16} /></button>
      <button className="icon-button" onClick={() => go(steps.length - 1)} title="Last step"><ChevronLast size={16} /></button>
      <span className="replay-step">{steps.length ? `${position + 1} / ${steps.length}` : '—'}</span>
      <label className="check"><input type="checkbox" checked={includeLogs} onChange={event => setIncludeLogs(event.target.checked)} />Log batches</label>
      <select value={scope || ''} onChange={event => { setScope(event.target.value || null); setSelected(null); setIteration(1); }}>
        <option value="">Workflow</option>
        {loopInstances.map(id => <option key={id} value={id}>Loop body · {id}</option>)}
      </select>
      {scope && <select value={iteration} onChange={event => setIteration(Number(event.target.value))}>
        {Array.from({ length: Math.max(1, loopView?.iteration || 1) }, (_, i) => i + 1).map(n => <option key={n} value={n}>Iteration {n}</option>)}
      </select>}
      <button className="button small secondary" onClick={onExit}><X size={12} />Exit replay</button>
    </div>
    <div className="replay-event">
      {current ? <><span className="seq">#{current.sequence}</span><strong>{describeEvent(current)}</strong><span className="muted">{new Date(current.timestamp).toLocaleTimeString()}</span>
        <span className="muted">Run: {STATE_LABELS[view?.run || ''] || view?.run || '—'}</span>
        {loopView && <span className="muted">Loop: {loopView.state}{loopView.pauseReason ? ` (${loopView.pauseReason})` : ''} · iteration {loopView.iteration}/{loopView.maxIterations}</span>}</>
        : <span className="muted">{error || 'Loading the captured journal…'}</span>}
    </div>
    <div className="replay-main">
      <div className="canvas">
        <ReactFlowProvider>
          <ReactFlow nodes={flow.nodes} edges={flow.edges} nodeTypes={nodeTypes} nodesDraggable={false} nodesConnectable={false} elementsSelectable
            onNodeClick={(_, node) => setSelected(node.data.node ? node.id : null)} onNodeDoubleClick={(_, node) => { if (node.data.node?.type === 'loop' && view?.loops.has(instanceId(node.id))) { const id = instanceId(node.id); setScope(id); setSelected(null); setIteration(view.loops.get(id)?.iteration || 1); } }}
            fitView>
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#2b2d3a" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
      <aside className="inspector">
        {selectedNode ? <div className="inspector-body">
          <div className="inspector-title"><span>{NODE_LABELS[selectedNode.type as keyof typeof NODE_LABELS]} · {selectedNode.id}</span></div>
          {projected ? <ProjectedAttempt client={client} instance={projected} /> : <p className="muted small">Not planned at this step.</p>}
          {selectedNode.type === 'loop' && view?.loops.get(instanceId(selectedNode.id)) && <LoopIterations loop={view.loops.get(instanceId(selectedNode.id))!} client={client} />}
          {selectedNode.type === 'map' && view && <ProjectedMaps maps={[...view.maps.values()].filter(map => map.mapInstanceId === instanceId(selectedNode.id))} />}
        </div> : <div className="inspector-body"><p className="muted small">Select a node to inspect what was committed by this step. Replay never runs anything.</p>
          {scope && loopView && <LoopIterations loop={loopView} client={client} />}</div>}
      </aside>
    </div>
  </div>;
}

function ProjectedAttempt({ client, instance }: { client: Client; instance: NonNullable<ReturnType<typeof project>['instances'] extends Map<string, infer V> ? V : never> }) {
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof loadAttempt>> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const fake = (manifest: unknown) => (manifest ? ({ payload: { manifest } } as unknown as JournalEvent) : undefined);
  const key = `${instance.id}|${instance.attemptId}|${instance.inputs?.artifactId}|${instance.outputs?.artifactId}`;
  useEffect(() => {
    let canceled = false;
    loadAttempt(client, fake(instance.inputs), fake(instance.outputs), fake(instance.invocation))
      .then(result => { if (!canceled) { setDetail(result); setLoadError(null); } })
      .catch(problem => { if (!canceled) setLoadError((problem as Error).message); });
    return () => { canceled = true; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div className="result-section">
    <h4><span className={`state-chip ${instance.state}`}>{STATE_LABELS[instance.state] || instance.state}</span>{instance.ordinal > 1 && <small className="muted">attempt {instance.ordinal}</small>}</h4>
    {instance.reason && <small className="muted">{instance.reason}</small>}
    {instance.reusedFrom && <small className="muted">Outputs reused from run {instance.reusedFrom.slice(0, 8)}.</small>}
    {instance.routeCase !== undefined && <small className="muted">Route selected: {instance.routeCase ?? 'no case'}</small>}
    {instance.gate && <small className="muted">Gate {instance.gate.mode}: {instance.gate.status || 'prepared'} · {instance.gate.subjectId}{instance.gate.recordId ? ` · ${instance.gate.recordId}` : ''}</small>}
    <AttemptView detail={detail} loadError={loadError} error={instance.error} state={instance.state} />
  </div>;
}

// Generated Map scopes as of this step: tasks, verification counter and engine records.
function ProjectedMaps({ maps }: { maps: ReturnType<typeof project>['maps'] extends Map<string, infer V> ? V[] : never }) {
  if (!maps.length) return <p className="muted small">The Map has not expanded at this step.</p>;
  return <>{maps.map(map => <div className="result-section" key={map.mapExecutionId}>
    <h4>Generation {map.generation} <span className={`state-chip ${map.state}`}>{STATE_LABELS[map.state] || map.state}</span></h4>
    <small className="muted">{map.specificationId} · verification failures {map.failedVerificationCycles}{map.maxFailedVerificationCycles ? `/${map.maxFailedVerificationCycles}` : ''}{map.carried.length ? ` · carried ${map.carried.join(', ')}` : ''}{map.pauseReason ? ` · paused: ${map.pauseReason}` : ''}</small>
    <ul className="map-list">{[...map.tasks.entries()].map(([taskId, task]) => <li key={taskId}><span className={`state-chip ${task.state}`}>{STATE_LABELS[task.state] || task.state}</span> {taskId} <span className="muted">{task.reason}</span></li>)}</ul>
    {map.records.length > 0 && <details><summary>{map.records.length} engine record(s)</summary><ul className="map-list">{map.records.map(item => <li key={item.recordId}>{item.kind} {item.recordId} · {item.taskId}</li>)}</ul></details>}
  </div>)}</>;
}

function LoopIterations({ loop, client }: { loop: NonNullable<ReturnType<typeof project>['loops'] extends Map<string, infer V> ? V : never>; client: Client }) {
  const [texts, setTexts] = useState<Record<string, string>>({});
  useEffect(() => {
    let canceled = false;
    (async () => {
      const result: Record<string, string> = {};
      for (const item of loop.iterations) {
        for (const [name, value] of [['candidate', item.candidate], ['decision', item.decision], ['feedback', item.feedback]] as const) {
          if (value?.artifact) { try { result[`${item.iteration}:${name}`] = await client.artifactText(value.artifact.artifactId); } catch { /* shown as unavailable */ } }
        }
      }
      if (!canceled) setTexts(result);
    })();
    return () => { canceled = true; };
  }, [loop, client]);
  return <div className="result-section"><h4>Iterations</h4>
    {loop.iterations.map(item => <details key={item.iteration} open={item.iteration === loop.iteration}>
      <summary>Iteration {item.iteration}{item.restart ? ' (restarted)' : ''} · {item.continue === null ? (item.outcome ? `closed without a decision (${(STATE_LABELS[item.outcome] || item.outcome).toLowerCase()})` : 'in progress') : item.continue ? 'continue' : 'finish'}</summary>
      {texts[`${item.iteration}:feedback`] ? <pre>Feedback in: {texts[`${item.iteration}:feedback`]}</pre> : null}
      {texts[`${item.iteration}:candidate`] !== undefined && <pre>Candidate: {texts[`${item.iteration}:candidate`]}</pre>}
      {texts[`${item.iteration}:decision`] !== undefined && <pre>Decision: {texts[`${item.iteration}:decision`]}</pre>}
    </details>)}
  </div>;
}
