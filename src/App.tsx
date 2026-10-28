import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addEdge, Background, BackgroundVariant, Controls, MiniMap, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow,
  type Connection as FlowConnection, type Edge, type IsValidConnection,
} from '@xyflow/react';
import {
  ArrowLeft, Bot, Braces, Database, Eye, FileInput, FileText, Filter, FolderOpen, GitMerge, History, Link2, MessageSquare, Play, Plus, RefreshCw, Repeat, Save, Scale, Settings,
  ListChecks, ShieldCheck, Split, Square, TriangleAlert, Workflow as WorkflowIcon,
} from 'lucide-react';
import { isTauri } from '@tauri-apps/api/core';
import { ApiProblem, Client, getConnection } from './transport';
import { INPUT, RETURN, allNodes, boundaryPorts, createNode, edgeId, emptyWorkflow, fromFlow, graphOf, loopOf, loopPath, mapAllNodes, portsOf, toFlow, uniqueId, updateLoop, validId, type FlowNode, type PortType } from './model';
import { nodeTypes, STATE_LABELS } from './nodes';
import { EffortField, Inspector } from './Inspector';
import { DEFAULT_EFFORT, type Effort } from '../shared/effort.mjs';
import { Replay } from './Replay';
import { AutonomyModal } from './Autonomy';
import { RunControlPanel, type ControlGrant } from './Supervision';
import { contextChainTemplate, deliveryTemplate, referenceDeliveryTemplate, reviewLoopTemplate, selectiveDeliveryTemplate, specificationLoopTemplate } from './templates';
import {
  PROVIDERS, PROVIDER_NAMES, TERMINAL_RUN,
  type AppSettings, type CachePin, type Capabilities, type ContextBinding, type JournalEvent, type NodeType, type Provider, type Run, type RunSnapshot, type WorkflowJudgeQuestion,
  type PublishedWorkflow, type RunRequest, type SavedWorkflow, type Workflow, type WorkflowNode, type WorkflowSummary, type Workspace,
  type PublishedVersionSummary,
} from './types';

const stored = (key: string) => { try { return localStorage.getItem(key) || ''; } catch { return ''; } };
const remember = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* Optional convenience. */ } };
const RUN_LABELS: Record<string, string> = {
  queued: 'Queued', running: 'Running', draining: 'Draining after a failure', waiting_for_user: 'Waiting for you', stopping: 'Stopping',
  succeeded: 'Succeeded', failed: 'Failed', canceled: 'Canceled', interrupted: 'Interrupted',
};
type Panel = 'run' | 'history' | 'contexts' | 'problems';

export default function App() { return <ReactFlowProvider><Workspace /></ReactFlowProvider>; }

function Workspace() {
  const [client, setClient] = useState<Client | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'error' | 'info'; text: string; details?: string[] } | null>(null);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState(stored('deszo.workspace'));
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [base, setBase] = useState<Workflow>(() => emptyWorkflow('untitled'));
  const [scope, setScope] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedWorkflow | null>(null);
  const [published, setPublished] = useState<PublishedWorkflow | null>(null);
  const [publishedVersions, setPublishedVersions] = useState<PublishedVersionSummary[]>([]);
  const [selectedPublishedVersion, setSelectedPublishedVersion] = useState<number | null>(null);
  const [publishedSelectionLoading, setPublishedSelectionLoading] = useState(false);
  const [externalWorkflow, setExternalWorkflow] = useState<SavedWorkflow | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [dirty, setDirty] = useState(false);
  const [issues, setIssues] = useState<{ path: string; message: string }[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [bindings, setBindings] = useState<ContextBinding[]>([]);
  const [run, setRun] = useState<RunSnapshot | null>(null);
  const [events, setEvents] = useState<JournalEvent[]>([]);
  const [panel, setPanel] = useState<Panel>('problems');
  const [modal, setModal] = useState<'settings' | 'workspace' | 'workflow' | 'approvals' | 'autonomy' | 'control' | null>(null);
  const [chatBinding, setChatBinding] = useState<ContextBinding | null>(null);
  const [pins, setPins] = useState<CachePin[]>([]);
  const [replayRunId, setReplayRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingRunRequests, setPendingRunRequests] = useState<RunRequest[]>([]);
  const [pendingControlGrants, setPendingControlGrants] = useState<ControlGrant[]>([]);
  const [authoringChange, setAuthoringChange] = useState(0);
  const flow = useReactFlow();
  const streamAbort = useRef<AbortController | null>(null);
  const workflowStreamAbort = useRef<AbortController | null>(null);
  const editRevision = useRef(0);
  const selectionRevision = useRef(0);
  const publishedSelectionSequence = useRef(0);
  const ownSaveRequestId = useRef<string | null>(null);
  const pendingAuthoringEvents = useRef(new Map<string, { sequence: number; eventId: string; workflowId: string; revision: number; requestId: string }>());
  const currentSaved = useRef<SavedWorkflow | null>(null);
  const currentDirty = useRef(false);
  const currentWorkflowId = useRef('');
  const loadWorkflowRef = useRef<((workflow: Workflow, saved: SavedWorkflow | null, preserveView?: boolean, published?: PublishedWorkflow | null) => void) | null>(null);

  const report = useCallback((error: unknown, prefix = '') => {
    if (error instanceof ApiProblem) setNotice({ kind: 'error', text: `${prefix}${error.message}`, details: error.details.map(item => `${item.path} ${item.message}`) });
    else setNotice({ kind: 'error', text: `${prefix}${(error as Error).message}` });
  }, []);

  // ---------- Bootstrap ----------
  const connect = useCallback(async () => {
    const connection = await getConnection();
    const next = new Client(connection);
    setClient(current => (current && current.connection.port === connection.port && current.connection.token === connection.token && current.connection.runtimeInstanceId === connection.runtimeInstanceId ? current : next));
    next.get<Capabilities>('/capabilities').then(setCapabilities).catch(report);
    return next;
  }, [report]);
  useEffect(() => {
    let canceled = false;
    connect().catch(error => { if (!canceled) setFatal((error as Error).message); });
    // The desktop shell reports an unexpected runtime exit; reconnect to the new generation.
    let unlisten: (() => void) | null = null;
    if (isTauri()) import('@tauri-apps/api/event').then(({ listen }) => listen<string>('runtime-lost', event => {
      setNotice({ kind: 'error', text: event.payload });
      connect().then(() => setNotice({ kind: 'info', text: `${event.payload} Reconnected.` })).catch(error => setFatal((error as Error).message));
    })).then(stop => { if (canceled) stop(); else unlisten = stop; });
    return () => { canceled = true; unlisten?.(); };
  }, [connect]);

  const refreshLists = useCallback(async () => {
    if (!client) return;
    const [ws, wf] = await Promise.all([client.get<{ items: Workspace[] }>('/workspaces?limit=200'), client.getV4<{ items: WorkflowSummary[] }>('/workflows?limit=200')]);
    setWorkspaces(ws.items); setWorkflows(wf.items);
    if (!ws.items.length) {
      setWorkspaceId('');
      if (client.hasFirstParty) setModal('workspace');
    } else if (!ws.items.some(item => item.workspaceId === workspaceId)) setWorkspaceId(ws.items[0].workspaceId);
  }, [client, workspaceId]);
  useEffect(() => { refreshLists().catch(report); }, [client]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (workspaceId) remember('deszo.workspace', workspaceId); }, [workspaceId]);

  const refreshBindings = useCallback(async () => {
    if (!client || !workspaceId || !workspaces.some(item => item.workspaceId === workspaceId)) return;
    setBindings((await client.get<{ bindings: ContextBinding[] }>(`/context-bindings?workspaceId=${workspaceId}`)).bindings);
  }, [client, workspaceId, workspaces]);
  useEffect(() => { refreshBindings().catch(report); }, [refreshBindings, report]);

  // ---------- Editor model ----------
  const workflow = useMemo(() => fromFlow(base, scope, nodes, edges), [base, scope, nodes, edges]);
  currentSaved.current = saved; currentDirty.current = dirty; currentWorkflowId.current = workflow.workflowId;
  const showScope = useCallback((next: Workflow, nextScope: string | null) => {
    const converted = toFlow(next, nextScope);
    setBase(next); setScope(nextScope); setNodes(converted.nodes); setEdges(converted.edges); setSelected(null);
    setTimeout(() => flow.fitView({ padding: 0.2, duration: 200 }), 50);
  }, [flow, setEdges, setNodes]);
  const loadWorkflow = useCallback((next: Workflow, savedWorkflow: SavedWorkflow | null, preserveView = false, publishedWorkflow: PublishedWorkflow | null = null) => {
    publishedSelectionSequence.current += 1;
    const selectedBefore = selected;
    const nextScope = preserveView && scope && loopOf(next, scope) ? scope : null;
    const viewport = preserveView ? flow.getViewport() : null;
    showScope(next, nextScope);
    setSelected(preserveView && selectedBefore && graphOf(next, nextScope).nodes.some(node => node.id === selectedBefore) ? selectedBefore : null);
    setSaved(savedWorkflow); setPublished(publishedWorkflow); setPublishedSelectionLoading(false); setSelectedPublishedVersion(publishedWorkflow?.version ?? null);
    setExternalWorkflow(null); setDirty(!savedWorkflow); selectionRevision.current += 1; remember('deszo.workflow', next.workflowId);
    if (viewport) setTimeout(() => flow.setViewport(viewport, { duration: 0 }), 80);
  }, [flow, scope, selected, showScope]);
  loadWorkflowRef.current = loadWorkflow;

  const openWorkflow = useCallback(async (workflowId: string, preserveView = false) => {
    if (!client) return;
    const [latest, versions] = await Promise.all([
      client.getV4<PublishedWorkflow>(`/workflows/${workflowId}/versions/latest`).catch(error => {
        if (error instanceof ApiProblem && error.status === 404) return null;
        throw error;
      }),
      client.listPublishedVersions<PublishedVersionSummary>(workflowId).catch(error => {
        if (error instanceof ApiProblem && error.status === 404) return [];
        throw error;
      }),
    ]);
    setPublishedVersions(versions);
    let draft: SavedWorkflow;
    try { draft = await client.getV4<SavedWorkflow>(`/workflows/${workflowId}/draft`); }
    catch (error) {
      if (!(error instanceof ApiProblem && error.status === 404) || !latest) throw error;
      draft = await client.deriveDraft<SavedWorkflow>(workflowId, latest.version, crypto.randomUUID(), null);
    }
    loadWorkflow(draft.workflow, draft, preserveView, latest);
  }, [client, loadWorkflow]);

  useEffect(() => {
    if (!client) return;
    const controller = new AbortController();
    workflowStreamAbort.current?.abort();
    workflowStreamAbort.current = controller;
    let cursor = 0;
    let initialized = false;
    let stopped = false;
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const onChange = async (event: { sequence: number; eventId: string; workflowId: string; revision: number; requestId: string }) => {
      if (event.sequence <= cursor) return;
      cursor = event.sequence;
      refreshLists().catch(() => {});
      if (event.requestId !== ownSaveRequestId.current) {
        pendingAuthoringEvents.current.set(event.workflowId, event);
        setAuthoringChange(event.sequence);
      }
    };
    const run = async () => {
      while (!stopped && !controller.signal.aborted) {
        let resync = false;
        try {
          if (!initialized) {
            const page = await client.getV3<{ cursor: number }>('/authoring/events?after=0&limit=1');
            cursor = page.cursor;
            initialized = true;
          }
          await client.streamWorkflowChanges(cursor, controller.signal, event => { void onChange(event); }, () => {}, () => { resync = true; });
          if (resync && !controller.signal.aborted) {
            const page = await client.getV3<{ cursor: number; resyncRequired: boolean }>('/authoring/events?after=0&limit=1');
            cursor = page.cursor;
            initialized = true;
            await refreshLists();
            const activeId = currentWorkflowId.current;
            if (activeId && !currentDirty.current) {
              const latest = await client.getV4<SavedWorkflow>(`/workflows/${activeId}/draft`).catch(() => null);
              const [publication, versions] = await Promise.all([
                client.getV4<PublishedWorkflow>(`/workflows/${activeId}/versions/latest`).catch(() => null),
                client.listPublishedVersions<PublishedVersionSummary>(activeId).catch(() => []),
              ]);
              setPublishedVersions(versions);
              if (latest && latest.revision > (currentSaved.current?.revision || 0)) loadWorkflowRef.current?.(latest.workflow, latest, true, publication);
            }
          }
        } catch (error) {
          if (controller.signal.aborted) break;
          if (!(error instanceof DOMException && error.name === 'AbortError')) report(error, 'Workflow change stream: ');
        }
        if (!stopped && !controller.signal.aborted) await sleep(1200);
      }
    };
    void run();
    return () => { stopped = true; controller.abort(); };
  }, [client, refreshLists, report]);

  useEffect(() => {
    if (!client) return;
    const event = pendingAuthoringEvents.current.get(workflow.workflowId);
    if (!event) return;
    let active = true;
    client.getV4<SavedWorkflow>(`/workflows/${event.workflowId}/draft`).then(async latest => {
      const [publication, versions] = await Promise.all([
        client.getV4<PublishedWorkflow>(`/workflows/${event.workflowId}/versions/latest`).catch(() => null),
        client.listPublishedVersions<PublishedVersionSummary>(event.workflowId).catch(() => []),
      ]);
      setPublishedVersions(versions);
      if (!active || latest.revision <= (currentSaved.current?.revision || 0)) {
        pendingAuthoringEvents.current.delete(event.workflowId);
        return;
      }
      pendingAuthoringEvents.current.delete(event.workflowId);
      if (currentDirty.current) setExternalWorkflow(latest);
      else loadWorkflowRef.current?.(latest.workflow, latest, true, publication);
    }).catch(error => { if (active) report(error, 'External workflow update: '); });
    return () => { active = false; };
  }, [authoringChange, client, dirty, report, saved?.revision, workflow.workflowId]);

  const refreshRunRequests = useCallback(async () => {
    if (!client?.hasFirstParty) { setPendingRunRequests([]); setPendingControlGrants([]); return; }
    try {
      const [requests, grants] = await Promise.all([client.get<{ items: RunRequest[] }>('/run-requests?state=pending&limit=100'), client.get<{ items: ControlGrant[] }>('/control-grants?state=pending&limit=100')]);
      setPendingRunRequests(requests.items); setPendingControlGrants(grants.items);
    }
    catch (error) { report(error, 'Approval queue: '); }
  }, [client, report]);
  useEffect(() => {
    if (!client?.hasFirstParty) { setPendingRunRequests([]); return; }
    const onFocus = () => { void refreshRunRequests(); };
    void refreshRunRequests();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refreshRunRequests(); }, 2500);
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [client, refreshRunRequests]);
  const enterScope = (loopId: string | null) => showScope(workflow, loopId);

  useEffect(() => {
    if (!client) return;
    const last = stored('deszo.workflow');
    if (!last) { setPublishedVersions([]); loadWorkflow(contextChainTemplate(), null); return; }
    openWorkflow(last).catch(() => { setPublishedVersions([]); loadWorkflow(contextChainTemplate(), null); });
  }, [client, openWorkflow]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!client) return;
    const timer = setTimeout(() => client.postV3<{ valid: boolean; issues: { path: string; message: string }[] }>('/workflows/validate', { workflow })
      .then(result => setIssues(result.issues)).catch(() => {}), 350);
    return () => clearTimeout(timer);
  }, [client, workflow]);

  const markDirty = () => { editRevision.current += 1; setDirty(true); };
  const onNodes: typeof onNodesChange = changes => { onNodesChange(changes); if (changes.some(change => (change.type === 'position' && change.dragging === false) || change.type === 'remove')) markDirty(); };
  const onEdges: typeof onEdgesChange = changes => { onEdgesChange(changes); if (changes.some(change => change.type === 'remove')) markDirty(); };

  const flowNode = useCallback((id: string | null) => nodes.find(node => node.id === id), [nodes]);
  const portsAt = useCallback((id: string | null): { inputs: Record<string, PortType[]>; outputs: Record<string, PortType> } | null => {
    const item = flowNode(id);
    if (!item) return null;
    if (item.data.node) return portsOf(item.data.node);
    const loop = loopOf(workflow, scope);
    if (!loop) return null;
    const ports = boundaryPorts(loop.config);
    return item.id === INPUT ? { inputs: {}, outputs: ports.input } : { inputs: ports.ret, outputs: {} };
  }, [flowNode, scope, workflow]);

  const isValidConnection: IsValidConnection = useCallback(connection => {
    if (connection.source === connection.target) return false;
    const source = flowNode(connection.source)?.data.node, target = flowNode(connection.target)?.data.node;
    if (connection.sourceHandle === 'context' || connection.targetHandle === 'context')
      return connection.sourceHandle === 'context' && connection.targetHandle === 'context' && source?.type === 'context' && target?.type === 'agent' && source.config.provider === target.config.provider;
    if (connection.sourceHandle === 'after-out' || connection.targetHandle === 'after-in') return connection.sourceHandle === 'after-out' && connection.targetHandle === 'after-in' && Boolean(source && target);
    const produced = portsAt(connection.source)?.outputs[connection.sourceHandle || ''];
    const accepted = portsAt(connection.target)?.inputs[connection.targetHandle || ''];
    if (!produced || !accepted || !accepted.includes(produced)) return false;
    return !edges.some(edge => edge.target === connection.target && edge.targetHandle === connection.targetHandle);
  }, [edges, flowNode, portsAt]);

  const onConnect = useCallback((connection: FlowConnection) => {
    setEdges(current => {
      if (connection.sourceHandle === 'context') {
        const without = current.filter(edge => !(edge.target === connection.target && (edge.data as any)?.kind === 'context'));
        return addEdge({ ...connection, id: `context:${connection.target}`, type: 'smoothstep', className: 'context-edge', data: { kind: 'context' } }, without);
      }
      if (connection.sourceHandle === 'after-out') return addEdge({ ...connection, id: `after:${connection.source}:${connection.target}`, type: 'smoothstep', className: 'after-edge', data: { kind: 'after' } }, current);
      const taken = [...current.map(edge => edge.id), ...workflow.edges.map(edge => edge.id), ...allNodes(workflow).flatMap(node => node.type === 'loop' ? node.config.body.edges.map(edge => edge.id) : [])];
      return addEdge({ ...connection, id: edgeId(connection.source, connection.sourceHandle || '', connection.target, connection.targetHandle || '', taken), type: 'smoothstep' }, current);
    });
    markDirty();
  }, [setEdges, workflow]);

  const addNode = (type: NodeType, provider?: Provider) => {
    if (type === 'loop' && loopPath(workflow, scope).length >= 3) { setNotice({ kind: 'info', text: 'Loops can be nested at most three levels deep.' }); return; }
    const taken = allNodes(workflow).map(node => node.id);
    const id = uniqueId(type === 'agent' ? provider || 'agent' : type === 'context' ? `${provider || 'codex'}-context` : type, taken);
    const center = flow.screenToFlowPosition({ x: window.innerWidth / 2 - 120, y: window.innerHeight / 2 - 160 });
    setNodes(current => [...current, { id, type, position: { x: center.x + (current.length % 5) * 24, y: center.y + (current.length % 5) * 24 }, data: { node: createNode(type, id, provider) } }]);
    setSelected(id); markDirty();
  };

  const updateNode = (node: WorkflowNode) => {
    setNodes(current => current.map(item => item.id === node.id ? { ...item, data: { ...item.data, node } } : item));
    const ports = portsOf(node);
    setEdges(current => current.filter(edge => {
      const kind = (edge.data as any)?.kind;
      if (kind === 'after') return true;
      if (kind === 'context') {
        if (edge.target === node.id) { const context = flowNode(edge.source)?.data.node; return node.type === 'agent' && context?.type === 'context' && context.config.provider === node.config.provider; }
        if (edge.source === node.id) { const agent = flowNode(edge.target)?.data.node; return node.type === 'context' && agent?.type === 'agent' && agent.config.provider === node.config.provider; }
        return true;
      }
      if (edge.target === node.id && !(edge.targetHandle && edge.targetHandle in ports.inputs)) return false;
      if (edge.source === node.id && !(edge.sourceHandle && edge.sourceHandle in ports.outputs)) return false;
      return true;
    }));
    if (node.type === 'loop') {
      // Fixed inputs and the value type also shape the body boundary; keep the body in the base copy.
      setBase(current => updateLoop(current, node));
    }
    markDirty();
  };

  const renameNode = (from: string, to: string) => {
    if (allNodes(workflow).some(node => node.id === to)) return `A node named "${to}" already exists in this workflow.`;
    const retarget = (node: WorkflowNode) => node.type === 'agent' && node.config.contextId === from ? { ...node, config: { ...node.config, contextId: to } } as WorkflowNode : node;
    setNodes(current => current.map(item => {
      if (!item.data.node) return item;
      const node = item.id === from ? { ...item.data.node, id: to } as WorkflowNode : item.data.node;
      return { ...item, id: item.id === from ? to : item.id, data: { ...item.data, node: retarget(node) } };
    }));
    setEdges(current => current.map(edge => ({ ...edge, source: edge.source === from ? to : edge.source, target: edge.target === from ? to : edge.target,
      id: edge.id.startsWith('context:') && edge.target === from ? `context:${to}` : edge.id })));
    // Other scopes may reference a renamed outer Context.
    setBase(current => mapAllNodes(current, retarget));
    setSelected(to); markDirty();
    return null;
  };

  const deleteSelected = () => {
    if (!selected || selected === INPUT || selected === RETURN) return;
    setNodes(current => current.filter(node => node.id !== selected));
    setEdges(current => current.filter(edge => edge.source !== selected && edge.target !== selected));
    setSelected(null); markDirty();
  };

  // ---------- Save / run ----------
  const save = useCallback(async (): Promise<SavedWorkflow | null> => {
    if (!client) return null;
    const missing = allNodes(workflow).flatMap(node => node.type === 'agent' && !node.config.model ? [node.id]
      : node.type === 'map' ? node.config.roles.filter(role => role.kind === 'agent' && !role.model).map(role => `${node.id}/${role.id}`) : []);
    if (missing.length) { setNotice({ kind: 'error', text: `Set an explicit model ID before saving: ${missing.join(', ')}.` }); return null; }
    const requestId = crypto.randomUUID();
    const workflowId = workflow.workflowId;
    const expectedEtag = saved?.workflow.workflowId === workflowId ? saved.etag : null;
    const editAtStart = editRevision.current;
    const selectionAtStart = selectionRevision.current;
    ownSaveRequestId.current = requestId;
    try {
      const result = await client.saveWorkflow<SavedWorkflow>(workflowId, requestId, expectedEtag, workflow);
      if (selectionRevision.current === selectionAtStart && currentWorkflowId.current === workflowId) {
        setSaved(result); setExternalWorkflow(null);
        if (editRevision.current === editAtStart) { setBase(fromFlow(result.workflow, scope, nodes, edges)); setDirty(false); }
        else setDirty(true);
        remember('deszo.workflow', workflowId);
      }
      setWorkflows((await client.getV4<{ items: WorkflowSummary[] }>('/workflows?limit=200')).items);
      return result;
    } catch (error) {
      if (error instanceof ApiProblem && error.status === 412) {
        const remote = await client.getV4<SavedWorkflow>(`/workflows/${workflowId}/draft`).catch(() => null);
        if (remote && selectionRevision.current === selectionAtStart && currentWorkflowId.current === workflowId) {
          setExternalWorkflow(remote);
          setNotice({ kind: 'error', text: `Save conflict: ${workflowId} changed in another editor. Your draft is still here.` });
          return null;
        }
      }
      report(error, 'Save failed: '); return null;
    } finally { if (ownSaveRequestId.current === requestId) ownSaveRequestId.current = null; }
  }, [client, edges, nodes, report, saved, scope, workflow]);

  const validateDraft = async () => {
    if (!client) return false;
    const current = dirty || !saved ? await save() : saved;
    if (!current) return false;
    try {
      const result = await client.validateDraft<{ workflowId: string; revision: number; etag: string; validation: { valid: boolean; issues: { path: string; message: string }[] } }>(workflow.workflowId, current.etag);
      setIssues(result.validation.issues);
      setNotice(result.validation.valid ? { kind: 'info', text: `Draft revision ${result.revision} is valid and ready to publish.` } : { kind: 'error', text: `Draft revision ${result.revision} has validation issues.` , details: result.validation.issues.map(issue => `${issue.path} ${issue.message}`) });
      return result.validation.valid;
    } catch (error) { report(error, 'Draft validation failed: '); return false; }
  };

  const publish = async () => {
    if (!client) return;
    setBusy(true);
    try {
      const current = dirty || !saved ? await save() : saved;
      if (!current) return;
      const validation = await client.validateDraft<{ validation: { valid: boolean; issues: { path: string; message: string }[] } }>(workflow.workflowId, current.etag);
      setIssues(validation.validation.issues);
      if (!validation.validation.valid) {
        setPanel('problems'); setNotice({ kind: 'error', text: 'The Draft has validation issues and cannot be published.', details: validation.validation.issues.map(issue => `${issue.path} ${issue.message}`) }); return;
      }
      const result = await client.publishDraft<PublishedWorkflow>(workflow.workflowId, crypto.randomUUID(), current.etag);
      setPublished(result); setSelectedPublishedVersion(result.version);
      setPublishedVersions(await client.listPublishedVersions<PublishedVersionSummary>(workflow.workflowId));
      setNotice({ kind: 'info', text: `Published Version ${result.version} (${result.definitionDigest.slice(0, 12)}).` });
      setWorkflows((await client.getV4<{ items: WorkflowSummary[] }>('/workflows?limit=200')).items);
    } catch (error) { report(error, 'Publication failed: '); }
    finally { setBusy(false); }
  };

  const selectPublishedVersion = async (version: number) => {
    if (!client) return;
    const workflowId = workflow.workflowId;
    const selection = ++publishedSelectionSequence.current;
    setSelectedPublishedVersion(version);
    setPublishedSelectionLoading(true);
    try {
      const selectedVersion = await client.getV4<PublishedWorkflow>(`/workflows/${workflowId}/versions/${version}`);
      if (selection !== publishedSelectionSequence.current || currentWorkflowId.current !== workflowId) return;
      setPublished(selectedVersion);
      setIssues(selectedVersion.runnable ? [] : selectedVersion.validation.issues);
    } catch (error) {
      if (selection !== publishedSelectionSequence.current || currentWorkflowId.current !== workflowId) return;
      setSelectedPublishedVersion(published?.version ?? null);
      report(error, 'Published Version could not be loaded: ');
    } finally {
      if (selection === publishedSelectionSequence.current && currentWorkflowId.current === workflowId) setPublishedSelectionLoading(false);
    }
  };

  const refreshRun = useCallback(async (runId: string) => {
    if (!client) return;
    const snapshot = await client.get<RunSnapshot>(`/runs/${runId}`);
    setRun(current => current && current.run.runId !== runId ? current : snapshot);
  }, [client]);

  const attach = useCallback(async (snapshot: RunSnapshot) => {
    if (!client) return;
    streamAbort.current?.abort();
    const controller = new AbortController(); streamAbort.current = controller;
    setRun(snapshot); setEvents([]);
    const collected: JournalEvent[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => { flushTimer = null; setEvents([...collected]); refreshRun(snapshot.run.runId).catch(() => {}); };
    try {
      await client.stream(snapshot.run.runId, 0, controller.signal, event => {
        collected.push(event);
        if (event.type === 'run.state_changed') setRun(current => current && current.run.runId === event.runId ? { ...current, run: { ...current.run, state: event.payload.to } } : current);
        if (!flushTimer) flushTimer = setTimeout(flush, 120);
      });
      flush();
      if (!controller.signal.aborted) await refreshRun(snapshot.run.runId);
      refreshBindings().catch(() => {});
    } catch (error) {
      if (controller.signal.aborted) return;
      report(error, 'Event stream: ');
      // The runtime may have been replaced; obtain the current connection (the desktop shell restarts it).
      connect().catch(() => {});
    }
  }, [client, connect, refreshBindings, refreshRun, report]);

  const start = async (plan: { mode?: 'branch' | 'node'; targets?: string[]; refreshCaches?: string[] } = {}) => {
    if (!client) return;
    if (publishedSelectionLoading) return;
    if (!workspaceId) { setModal('workspace'); return; }
    setBusy(true); setNotice(null);
    try {
      if (dirty) { setNotice({ kind: 'error', text: 'Save and publish the current Draft before running it. Run uses the selected immutable Published Version.' }); return; }
      if (!published || published.workflowId !== workflow.workflowId) { setNotice({ kind: 'error', text: 'Publish this workflow before starting a Run.' }); return; }
      if (!published.runnable) { setPanel('problems'); setIssues(published.validation.issues); setNotice({ kind: 'error', text: `Published Version ${published.version} is not Runnable. Derive a Draft, correct it, and publish a new version.`, details: published.validation.issues.map(issue => `${issue.path} ${issue.message}`) }); return; }
      const waiting = (await client.get<{ items: Run[] }>(`/runs?workspaceId=${workspaceId}&state=waiting_for_user&limit=1`)).items[0];
      if (waiting) {
        if (!window.confirm(`Run ${waiting.runId.slice(0, 8)} (${waiting.workflowId}) is waiting for a recovery decision and holds this workspace. Close it as failed and start a new run?`)) return;
        await client.post(`/runs/${waiting.runId}/recovery`, { requestId: crypto.randomUUID(), action: 'close' });
      }
      const accepted = await client.post<{ outcome: 'created'; run: Run } | { outcome: 'confirmation_pending'; requestId: string; statusPath: string }>('/runs', {
        workflowId: published.workflowId, workflowSnapshotSha256: published.snapshotSha256, publishedVersionId: published.publishedVersionId,
        definitionDigest: published.definitionDigest, workspaceId, requestId: crypto.randomUUID(), ...plan,
      });
      if (accepted.outcome === 'confirmation_pending') {
        setNotice({ kind: 'info', text: `Run request ${accepted.requestId.slice(0, 8)} is waiting for approval in Deszo.` });
        if (client.hasFirstParty) setModal('approvals');
        return;
      }
      setNotice({ kind: 'info', text: `Run started from Published Version ${published.version}.` });
      setPanel('run');
      attach(await client.get<RunSnapshot>(`/runs/${accepted.run.runId}`));
    } catch (error) { report(error, 'Run was not started: '); }
    finally { setBusy(false); }
  };

  const stop = async () => {
    if (!client || !run) return;
    try { await client.post(`/runs/${run.run.runId}/stop`, { requestId: crypto.randomUUID() }); }
    catch (error) { report(error, 'Stop failed: '); }
  };

  const recovery = async (body: Record<string, unknown>) => {
    if (!client || !run) return;
    try {
      await client.post(`/runs/${run.run.runId}/recovery`, { requestId: crypto.randomUUID(), ...body });
      if (body.action !== 'close') attach(await client.get<RunSnapshot>(`/runs/${run.run.runId}`));
      else await refreshRun(run.run.runId);
      refreshBindings().catch(() => {});
    } catch (error) { report(error, 'Recovery failed: '); }
  };

  const refreshPins = useCallback(async () => {
    if (!client || !saved) { setPins([]); return; }
    try { setPins((await client.get<{ pins: CachePin[] }>(`/workflows/${saved.workflow.workflowId}/cache-pins`)).pins); } catch { setPins([]); }
  }, [client, saved]);
  useEffect(() => { refreshPins(); }, [refreshPins, run?.run.state]);
  const freeze = async (nodeId: string) => {
    if (!client || !run) return;
    try { setPins((await client.put<{ pins: CachePin[] }>(`/workflows/${run.run.workflowId}/cache-pins/${nodeId}`, { runId: run.run.runId, nodeInstanceId: nodeId })).pins); setNotice({ kind: 'info', text: `Pinned the output of ${nodeId}. Set the Cache to Frozen to reuse it.` }); }
    catch (error) { report(error, 'Pin failed: '); }
  };

  const stopNode = async (instanceId: string) => {
    if (!client || !run) return;
    try { await client.post(`/runs/${run.run.runId}/nodes/${encodeURIComponent(instanceId)}/stop`, { requestId: crypto.randomUUID() }); }
    catch (error) { report(error, 'Stop node failed: '); }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); save(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  // ---------- Run overlay ----------
  const runMatchesEditor = Boolean(run && run.run.workflowId === workflow.workflowId);
  const path = useMemo(() => loopPath(workflow, scope), [scope, workflow]);
  // Scoped instance prefix of the shown body: each enclosing loop at its latest iteration.
  const { prefix, loopInstance } = useMemo(() => {
    // An outer level shows the latest iteration in which the next inner loop actually started.
    let current = '', instance: string | null = null;
    path.forEach((loopId, index) => {
      instance = current + loopId;
      const latest = run?.loops.find(loop => loop.loopNodeId === instance)?.iteration ?? 1;
      const next = path[index + 1];
      let chosen = latest;
      if (next) for (let it = latest; it >= 1; it--) if (run?.loops.some(loop => loop.loopNodeId === `${instance}/${it}/${next}`)) { chosen = it; break; }
      current = `${instance}/${chosen}/`;
    });
    return { prefix: current, loopInstance: instance };
  }, [path, run]);
  const loopExec = loopInstance ? run?.loops.find(loop => loop.loopNodeId === loopInstance) : undefined;
  const instanceOf = useCallback((nodeId: string) => prefix + nodeId, [prefix]);
  const nodeStates = useMemo(() => {
    const states = new Map<string, string>();
    if (!runMatchesEditor || !run) return states;
    const latest = new Map<string, string>();
    for (const instance of run.instances) latest.set(instance.nodeInstanceId, instance.state);
    for (const event of events) if (event.type === 'attempt.state_changed' && event.nodeInstanceId) latest.set(event.nodeInstanceId, event.payload.to);
    for (const node of graphOf(workflow, scope).nodes) if (latest.has(instanceOf(node.id))) states.set(node.id, latest.get(instanceOf(node.id))!);
    for (const node of graphOf(workflow, scope).nodes) {
      const loop = node.type === 'loop' ? run.loops.find(item => item.loopNodeId === instanceOf(node.id)) : undefined;
      if (loop && (loop.state === 'paused' || loop.state === 'finished')) states.set(node.id, loop.state);
    }
    const bindingStates = new Map<string, string>();
    for (const event of events) if (event.type === 'context.state_changed') bindingStates.set(event.payload.bindingId, event.payload.to);
    for (const mapping of run.contexts) if (bindingStates.has(mapping.bindingId)) {
      const key = mapping.contextNodeId.split('/').pop()!;
      if (!mapping.contextNodeId.includes('/') || mapping.contextNodeId === instanceOf(key)) states.set(key, bindingStates.get(mapping.bindingId)!);
      else if (graphOf(workflow, scope).nodes.some(node => node.id === key) && mapping.contextNodeId.endsWith(`/${key}`) && !states.has(key)) states.set(key, bindingStates.get(mapping.bindingId)!);
    }
    return states;
  }, [events, instanceOf, run, runMatchesEditor, scope, workflow]);
  const displayNodes = useMemo(() => nodes.map(node => ({ ...node, selected: node.id === selected, data: { ...node.data, state: nodeStates.get(node.id) } })), [nodes, nodeStates, selected]);
  const active = run && !TERMINAL_RUN.includes(run.run.state);
  const selectedFlow = flowNode(selected);
  const selectedNode = selectedFlow?.data.node;
  const editorDiffers = runMatchesEditor && saved && run && (dirty || saved.executionHash !== run.run.executionHash);
  const visibleContexts = useMemo(() => [
    ...workflow.nodes.filter(node => node.type === 'context'),
    ...path.flatMap(id => loopOf(workflow, id)?.config.body.nodes.filter(node => node.type === 'context') || []),
  ], [path, workflow]);
  const selectedInstance = selectedNode ? instanceOf(selectedNode.id) : null;
  const selectedRunning = Boolean(run && ['running', 'draining'].includes(run.run.state) && selectedInstance && (nodeStates.get(selectedNode!.id) === 'running' || (selectedNode!.type === 'loop' && run.loops.find(loop => loop.loopNodeId === selectedInstance)?.state === 'running')));
  const outerExecutable = Boolean(selectedNode && !scope && selectedNode.type !== 'context');
  const idle = !active || run?.run.state === 'waiting_for_user';

  if (fatal) return <div className="fatal"><TriangleAlert size={28} /><h2>The runtime is not available</h2><p>{fatal}</p><p className="muted">In a browser, start <code>npm run runner</code> first. In the desktop app, check that Node.js 22+ is installed.</p></div>;

  if (replayRunId && client) return <div className="shell replay-shell">
    <header className="topbar"><div className="brand">de<span>s</span>zo</div><span className="muted small">Read-only Replay — the editor draft is kept unchanged.</span></header>
    <Replay client={client} runId={replayRunId} onExit={() => setReplayRunId(null)} />
  </div>;

  return <div className="shell">
    <header className="topbar">
      <div className="brand">de<span>s</span>zo</div>
      <button className="chip-button" onClick={() => setModal('workspace')} title="Workspace and working directory"><FolderOpen size={14} />{workspaceId || 'Choose workspace'}</button>
      <button className="chip-button" onClick={() => setModal('workflow')} title="Open or create a workflow"><WorkflowIcon size={14} />{workflow.workflowId}{dirty && <i className="dirty-dot" title="Unsaved changes" />}</button>
      {client?.hasFirstParty && <button className="chip-button" onClick={() => setModal('approvals')} title="Review external run requests and supervision grants"><ShieldCheck size={14} />Approvals{pendingRunRequests.length + pendingControlGrants.length > 0 && <span className="approval-count">{pendingRunRequests.length + pendingControlGrants.length}</span>}</button>}
      {scope && <span className="crumbs"><button className="chip-button" onClick={() => enterScope(null)}><ArrowLeft size={13} />Workflow</button>
        {path.map((id, index) => <span key={id} className="crumbs">
          <span className="muted">›</span>
          {index === path.length - 1 ? <span className="chip-button static"><Repeat size={13} />Loop body · {id}</span> : <button className="chip-button" onClick={() => enterScope(id)}><Repeat size={13} />{id}</button>}
        </span>)}</span>}
      <div className="spacer" />
      {run && <span className={`run-pill ${run.run.state}`}>{RUN_LABELS[run.run.state]}</span>}
      {run && <button className="chip-button" onClick={() => setModal('control')}><ShieldCheck size={14} />{run.run.controlMode === 'supervised' ? 'Supervised' : 'Run control'}</button>}
      {publishedVersions.length > 0 && <label className="published-version-picker">
        <span>Published</span>
        <select aria-label="Published Version" value={selectedPublishedVersion ?? ''} onChange={event => void selectPublishedVersion(Number(event.target.value))}>
          {publishedVersions.map(version => <option key={version.publishedVersionId} value={version.version}>
            v{version.version}{version.runnable ? '' : ' · not Runnable'}
          </option>)}
        </select>
      </label>}
      <button className="button ghost" onClick={() => void validateDraft()} disabled={!client || busy || (!dirty && !saved)}><ListChecks size={14} />Validate Draft</button>
      <button className="button secondary" onClick={() => save()} disabled={!client || busy}><Save size={14} />Save Draft</button>
      <button className="button secondary" onClick={() => void publish()} disabled={!client || busy}><ListChecks size={14} />Publish</button>
      {active && run.run.state !== 'waiting_for_user' ? <button className="button danger" onClick={stop} disabled={run.run.state === 'stopping'}><Square size={14} />Stop run</button>
        : <button className="button primary" onClick={() => start()} disabled={!client || busy || publishedSelectionLoading}><Play size={14} />Run workflow</button>}
      <button className="icon-button" onClick={() => setModal('settings')} title="Settings and providers"><Settings size={16} /></button>
      <button className="chip-button" onClick={() => setModal('autonomy')} title="Time-bounded development autonomy"><ShieldCheck size={14} />Autonomy</button>
    </header>
    {notice && <div className={`notice ${notice.kind}`}><div><strong>{notice.text}</strong>{notice.details?.length ? <ul>{notice.details.slice(0, 8).map(item => <li key={item}>{item}</li>)}</ul> : null}</div><button onClick={() => setNotice(null)}>×</button></div>}
    <div className="main-grid">
      <aside className="palette">
        <h3>Palette</h3>
        <PaletteItem icon={<FileText size={14} />} label="Text" hint="Literal prompt or instruction" onClick={() => addNode('text')} />
        <PaletteItem icon={<Braces size={14} />} label="Prompt Template" hint="Compose named inputs" onClick={() => addNode('prompt-template')} />
        <h4>Agents</h4>
        {PROVIDERS.map(provider => <PaletteItem key={provider} icon={<Bot size={14} />} label={PROVIDER_NAMES[provider]} hint={providerHint(capabilities, provider)} className={provider} onClick={() => addNode('agent', provider)} />)}
        <h4>Contexts</h4>
        {PROVIDERS.map(provider => <PaletteItem key={provider} icon={<Link2 size={14} />} label={`${PROVIDER_NAMES[provider]} Context`} hint="Reusable native conversation" className={provider} onClick={() => addNode('context', provider)} />)}
        <h4>Data and control</h4>
        <PaletteItem icon={<FileInput size={14} />} label="File / Artifact Input" hint="Snapshot files or pin an output" onClick={() => addNode('file-input')} />
        <PaletteItem icon={<GitMerge size={14} />} label="Merge" hint="Text, files or a JSON record" onClick={() => addNode('merge')} />
        <PaletteItem icon={<Filter size={14} />} label="JSON Select" hint="Pick a field by pointer" onClick={() => addNode('json-select')} />
        <PaletteItem icon={<Scale size={14} />} label="Condition" hint="Typed loop decision" onClick={() => addNode('condition')} />
        <PaletteItem icon={<Repeat size={14} />} label="Loop" hint={scope ? 'Nested loop (pipeline)' : 'Repeat a body until done'} onClick={() => addNode('loop')} />
        <PaletteItem icon={<Database size={14} />} label="Cache" hint="Checkpoint; freeze to skip its producer" onClick={() => addNode('cache')} />
        <h4>Pipeline</h4>
        <PaletteItem icon={<ListChecks size={14} />} label="Managed Task" hint="Assess, plan, implement and verify" onClick={() => addNode('task')} />
        <PaletteItem icon={<Split size={14} />} label="Route" hint="Pick one branch by a JSON value" onClick={() => addNode('route')} />
        <PaletteItem icon={<ShieldCheck size={14} />} label="Gate" hint="Prepare, evaluate or verify reviews" onClick={() => addNode('gate')} />
        <PaletteItem icon={<ListChecks size={14} />} label="Implementation Map" hint="Run approved tasks with checks" onClick={() => addNode('map')} />
        <h4>Output</h4>
        {!scope && <PaletteItem icon={<Eye size={14} />} label="Result Viewer" hint="Shows a final value" onClick={() => addNode('result-viewer')} />}
        <div className="legend"><span><i className="line data" />Data</span><span><i className="line context" />Context</span><span><i className="line after" />After</span></div>
      </aside>
      <section className="canvas">
        <ReactFlow nodes={displayNodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodes} onEdgesChange={onEdges} onConnect={onConnect}
          isValidConnection={isValidConnection} onNodeClick={(_, node) => setSelected(node.data.node ? node.id : null)} onPaneClick={() => setSelected(null)}
          onNodeDoubleClick={(_, node) => { if (node.data.node?.type === 'loop') enterScope(node.id); }}
          deleteKeyCode={['Delete']} fitView defaultEdgeOptions={{ type: 'smoothstep' }}>
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#2b2d3a" />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable className="minimap" nodeColor="#3a3c4c" maskColor="#10111799" />
        </ReactFlow>
        {editorDiffers && <div className="canvas-banner">The editor has newer changes than the selected run; node states show the captured run.</div>}
        {externalWorkflow && externalWorkflow.workflow.workflowId === workflow.workflowId && <div className="canvas-banner external-change">
          <span>Saved revision {externalWorkflow.revision} is newer. Your draft is preserved.</span>
          <button className="button small ghost" onClick={() => {
            if (dirty && !window.confirm('Replace the unsaved draft with the newer saved workflow?')) return;
            openWorkflow(externalWorkflow.workflow.workflowId, true).catch(error => report(error, 'Reload Draft failed: '));
          }}>Reload revision</button>
          <button className="button small secondary" onClick={async () => {
            if (!client) return;
            const missing = allNodes(workflow).flatMap(node => node.type === 'agent' && !node.config.model ? [node.id]
              : node.type === 'map' ? node.config.roles.filter(role => role.kind === 'agent' && !role.model).map(role => `${node.id}/${role.id}`) : []);
            if (missing.length) { setNotice({ kind: 'error', text: `Set an explicit model ID before saving: ${missing.join(', ')}.` }); return; }
            const id = `${workflow.workflowId.slice(0, 52)}-copy-${crypto.randomUUID().slice(0, 6)}`;
            const copy = { ...workflow, workflowId: id };
            const requestId = crypto.randomUUID();
            const editAtStart = editRevision.current;
            const selectionAtStart = selectionRevision.current;
            ownSaveRequestId.current = requestId;
            try {
              const result = await client.saveWorkflow<SavedWorkflow>(id, requestId, null, copy);
              setWorkflows((await client.getV4<{ items: WorkflowSummary[] }>('/workflows?limit=200')).items);
              if (selectionRevision.current === selectionAtStart && editRevision.current === editAtStart && currentWorkflowId.current === workflow.workflowId) {
                loadWorkflow(result.workflow, result, true);
                setNotice({ kind: 'info', text: `Saved your draft as ${id}.` });
              } else setNotice({ kind: 'info', text: `Saved as ${id}. The newer editor changes are still in your draft.` });
            } catch (error) { report(error, 'Save as new failed: '); }
            finally { if (ownSaveRequestId.current === requestId) ownSaveRequestId.current = null; }
          }}>Save draft as new</button>
        </div>}
        {scope && loopExec && <div className="canvas-banner right">Showing {loopInstance} · iteration {loopExec.iteration} · {loopExec.state}{loopExec.pauseReason ? ` (${loopExec.pauseReason.replace('_', ' ')})` : ''}</div>}
      </section>
      <aside className="inspector">
        {selectedNode ? <Inspector node={selectedNode} label={selectedFlow?.data.label} readOnly={false} bindings={bindings} inBody={Boolean(scope)}
          visibleContexts={visibleContexts} agents={allNodes(workflow)}
          onChange={updateNode} onRename={to => renameNode(selectedNode.id, to)} onDelete={deleteSelected}
          onOpenBody={selectedNode.type === 'loop' ? () => enterScope(selectedNode.id) : undefined}
          onLabel={label => { setNodes(current => current.map(item => item.id === selected ? { ...item, data: { ...item.data, label: label || undefined } } : item)); markDirty(); }}
          client={runMatchesEditor ? client : null} events={events} instanceId={selectedInstance} contexts={run?.contexts || []}
          canStop={selectedRunning} onStop={() => selectedInstance && stopNode(selectedInstance)}
          onRunBranch={outerExecutable && idle ? () => start({ mode: 'branch', targets: [selectedNode.id] }) : undefined}
          onRunNode={outerExecutable && idle ? () => start({ mode: 'node', targets: [selectedNode.id] }) : undefined}
          pin={selectedNode.type === 'cache' ? pins.find(pin => pin.nodeId === selectedNode.id) || null : undefined}
          onFreeze={client?.hasFirstParty && selectedNode.type === 'cache' && !scope && runMatchesEditor && run && nodeStates.get(selectedNode.id) === 'succeeded' ? () => freeze(selectedNode.id) : undefined}
          onRefresh={selectedNode.type === 'cache' && selectedNode.config.mode === 'frozen' && idle ? () => start({ refreshCaches: [selectedNode.id] }) : undefined}
          runActive={Boolean(active)} runId={runMatchesEditor ? run?.run.runId ?? null : null} />
          : <WorkflowOverview workflow={workflow} saved={saved} issues={issues} scope={scope} onNative={value => { setBase(current => ({ ...current, settings: { nativeConfiguration: value } })); markDirty(); }} capabilities={capabilities} />}
      </aside>
    </div>
    <BottomPanel panel={panel} setPanel={setPanel} issues={issues} run={run} events={events} client={client} workspaceId={workspaceId}
      bindings={bindings} refreshBindings={refreshBindings} workflow={workflow} onRecovery={recovery} onChat={setChatBinding}
      onOpenRun={async runId => {
        if (!client) return;
        try { setPanel('run'); attach(await client.get<RunSnapshot>(`/runs/${runId}`)); } catch (error) { report(error); }
      }}
      onReplay={runId => setReplayRunId(runId)}
      onLoadCaptured={async snapshot => {
        if (!client) return;
        if (dirty && !window.confirm('Replace the unsaved editor draft with the captured workflow of this run?')) return;
        setPublishedVersions([]);
        loadWorkflow(await client.artifactJson<Workflow>(snapshot.run.workflowSnapshot.artifactId), null);
      }} report={report} onSelectNode={id => {
        const parts = id.split('/');
        const nodeId = parts[parts.length - 1], loopId = parts.length > 1 ? parts[parts.length - 3] : null;
        if (scope !== loopId) enterScope(loopId);
        setTimeout(() => setSelected(nodeId), 80);
      }} />
    {chatBinding && client && <ChatModal client={client} binding={chatBinding} workspaceId={workspaceId} onClose={() => { setChatBinding(null); refreshBindings().catch(() => {}); }} report={report} />}
    {modal === 'approvals' && client?.hasFirstParty && <ApprovalModal client={client} requests={pendingRunRequests} grants={pendingControlGrants} onClose={() => setModal(null)} onChanged={refreshRunRequests} report={report} />}
    {modal === 'settings' && client && <SettingsModal client={client} capabilities={capabilities} onCapabilities={setCapabilities} onClose={() => setModal(null)} report={report} />}
    {modal === 'control' && client && run && <Modal title="Run control" onClose={() => setModal(null)}><RunControlPanel client={client} runId={run.run.runId} report={report} /></Modal>}
    {modal === 'autonomy' && client && <AutonomyModal client={client} workspace={workspaces.find(item => item.workspaceId === workspaceId)} saved={dirty ? null : saved} onClose={() => setModal(null)} report={report} />}
    {modal === 'workspace' && client && <WorkspaceModal client={client} workspaces={workspaces} current={workspaceId} onSelect={id => { setWorkspaceId(id); setModal(null); }}
      onCreated={async id => { await refreshLists(); setWorkspaceId(id); setModal(null); }} onClose={() => setModal(null)} report={report} />}
    {modal === 'workflow' && client && <WorkflowModal workflows={workflows} onClose={() => setModal(null)} report={report}
      onOpen={async id => {
        if (dirty && !window.confirm('Discard unsaved changes in the current workflow?')) return;
        try { await openWorkflow(id); setModal(null); } catch (error) { report(error, 'Could not open workflow: '); }
      }}
      onCreate={(id, template) => {
        if (dirty && !window.confirm('Discard unsaved changes in the current workflow?')) return;
        const source = template === 'chain' ? contextChainTemplate() : template === 'loop' ? reviewLoopTemplate() : template === 'spec' ? specificationLoopTemplate() : template === 'delivery' ? deliveryTemplate() : template === 'selective' ? selectiveDeliveryTemplate() : template === 'reference' ? referenceDeliveryTemplate() : emptyWorkflow(id);
        setPublishedVersions([]);
        loadWorkflow({ ...source, workflowId: id }, null); setModal(null);
      }} />}
  </div>;
}

function providerHint(capabilities: Capabilities | null, provider: Provider) {
  const record = capabilities?.providers.find(item => item.provider === provider);
  if (!record) return 'Checking CLI…';
  return record.available ? `Ready${record.cliVersion ? ` · ${record.cliVersion.split(/\s+/).slice(-1)[0]}` : ''}` : 'Unavailable';
}

function PaletteItem({ icon, label, hint, onClick, className = '' }: { icon: React.ReactNode; label: string; hint: string; onClick: () => void; className?: string }) {
  return <button className={`palette-item ${className}`} onClick={onClick} title={`Add ${label}`}><span className="palette-icon">{icon}</span><span><strong>{label}</strong><small>{hint}</small></span><Plus size={13} /></button>;
}

function WorkflowOverview({ workflow, saved, issues, scope, onNative, capabilities }: { workflow: Workflow; saved: SavedWorkflow | null; issues: { path: string; message: string }[]; scope: string | null; onNative: (value: 'restricted' | 'inherit') => void; capabilities: Capabilities | null }) {
  const counts = allNodes(workflow).reduce<Record<string, number>>((acc, node) => ({ ...acc, [node.type]: (acc[node.type] || 0) + 1 }), {});
  if (scope) return <div className="inspector-body">
    <div className="inspector-title"><span>Loop body · {scope}</span></div>
    <p className="muted small">Connect <strong>Loop Input</strong> ports (value, iteration, feedback and fixed inputs) to body nodes. Exactly one edge must reach each <strong>Loop Return</strong> port: <code>candidate</code> (the next value) and <code>decision</code> (from a Condition or a JSON Agent checker).</p>
    <p className="muted small">The body runs once per iteration. <code>continue: false</code> finishes the loop; limits pause it for your decision.</p>
  </div>;
  return <div className="inspector-body">
    <div className="inspector-title"><span>Workflow</span></div>
    <dl className="facts">
      <div><dt>ID</dt><dd>{workflow.workflowId}</dd></div>
      <div><dt>Capabilities</dt><dd>{workflow.capabilities.join(', ')}</dd></div>
      <div><dt>Nodes</dt><dd>{Object.entries(counts).map(([type, count]) => `${count} ${type}`).join(' · ') || 'Empty'}</dd></div>
      <div><dt>Saved</dt><dd>{saved ? `${saved.snapshotSha256.slice(0, 12)}…` : 'Not saved yet'}</dd></div>
      <div><dt>Ready to run</dt><dd>{issues.length ? `${issues.length} problem${issues.length === 1 ? '' : 's'}` : 'Yes'}</dd></div>
    </dl>
    <label className="field"><span>Native configuration</span>
      <select value={workflow.settings.nativeConfiguration} onChange={event => onNative(event.target.value as 'restricted' | 'inherit')}>
        <option value="restricted">Restricted — suppress native instructions/MCP where supported</option>
        <option value="inherit">Inherit — use supported native settings under subscription guards</option>
      </select>
    </label>
    <p className="muted small">Agents run with Full Access in the workspace directory. Directory and Context locks serialize writers; they are not a sandbox.</p>
    {capabilities && <p className="muted small">Process containment: {capabilities.processContainment === 'tauri-job' ? 'desktop Job Object' : 'standalone best effort (development)'}.</p>}
    <h4 className="section-title">How to build</h4>
    <ol className="steps">
      <li>Add a Text node with the task and connect it to an Agent’s <code>prompt</code>.</li>
      <li>Combine answers with a Prompt Template or Merge; select fields with JSON Select.</li>
      <li>Connect a Context’s bottom handle to Agents that should share one conversation.</li>
      <li>Wrap repeated work in a Loop; double-click it to edit the body.</li>
      <li>End with a Result Viewer, save, then run.</li>
    </ol>
  </div>;
}

function BottomPanel({ panel, setPanel, issues, run, events, client, workspaceId, bindings, refreshBindings, workflow, onRecovery, onChat, onOpenRun, onReplay, onLoadCaptured, report, onSelectNode }: {
  panel: Panel; setPanel: (panel: Panel) => void; issues: { path: string; message: string }[]; run: RunSnapshot | null; events: JournalEvent[]; client: Client | null; workspaceId: string;
  bindings: ContextBinding[]; refreshBindings: () => Promise<void>; workflow: Workflow; onRecovery: (body: Record<string, unknown>) => void; onChat: (binding: ContextBinding) => void;
  onOpenRun: (runId: string) => void; onReplay: (runId: string) => void; onLoadCaptured: (snapshot: RunSnapshot) => void;
  report: (error: unknown, prefix?: string) => void; onSelectNode: (id: string) => void;
}) {
  const [history, setHistory] = useState<Run[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [workflowJudgeEnabled, setWorkflowJudgeEnabled] = useState(Boolean(workflow.judgePolicy));
  const onWorkflowJudgeState = useCallback((enabled: boolean) => setWorkflowJudgeEnabled(enabled), []);
  const loadHistory = useCallback(async (more = false) => {
    if (!client || !workspaceId) return;
    try {
      const page = await client.get<{ items: Run[]; nextCursor: string | null }>(`/runs?workspaceId=${workspaceId}&limit=30${more && cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      setHistory(current => more ? [...current, ...page.items] : page.items); setCursor(page.nextCursor);
    } catch (error) { report(error); }
  }, [client, cursor, report, workspaceId]);
  useEffect(() => { if (panel === 'history') loadHistory(false); }, [panel, workspaceId, run?.run.state]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (panel === 'contexts') refreshBindings().catch(report); }, [panel]); // eslint-disable-line react-hooks/exhaustive-deps
  const visible = showLogs ? events : events.filter(event => event.type !== 'attempt.log_chunk');
  return <section className="bottom">
    <div className="tabs">
      <button className={panel === 'problems' ? 'active' : ''} onClick={() => setPanel('problems')}><TriangleAlert size={13} />Problems <span>{issues.length}</span></button>
      <button className={panel === 'run' ? 'active' : ''} onClick={() => setPanel('run')}><Play size={13} />Run journal <span>{events.length}</span></button>
      <button className={panel === 'history' ? 'active' : ''} onClick={() => setPanel('history')}><History size={13} />History</button>
      <button className={panel === 'contexts' ? 'active' : ''} onClick={() => setPanel('contexts')}><Link2 size={13} />Contexts <span>{bindings.length}</span></button>
    </div>
    <div className="bottom-body">
      {panel === 'problems' && (issues.length === 0 ? <div className="empty">No problems. The workflow is executable.</div> : <ul className="issue-list">{issues.map((issue, index) => <li key={index}><code>{issue.path}</code>{issue.message}</li>)}</ul>)}
      {panel === 'run' && (!run ? <div className="empty">Run the workflow or open a run from History.</div> : <div className="journal">
        <div className="journal-head">
          <span>Run <code>{run.run.runId.slice(0, 8)}</code> · {run.run.workflowId} · <strong>{RUN_LABELS[run.run.state]}</strong> · {new Date(run.run.createdAt).toLocaleString()}</span>
          {run.loops.map(loop => <span key={loop.loopNodeId} className="muted small">{loop.loopNodeId}: iteration {loop.iteration}/{loop.maxIterations} · {loop.state} · {(loop.activeMs / 1000).toFixed(1)} s</span>)}
          <label className="check"><input type="checkbox" checked={showLogs} onChange={event => setShowLogs(event.target.checked)} />Show log batches</label>
          <button className="button small ghost" onClick={() => onReplay(run.run.runId)}><History size={12} />Replay</button>
          <button className="button small ghost" onClick={() => onLoadCaptured(run)}>Load captured workflow</button>
        </div>
        <WorkflowJudgePanel runId={run.run.runId} runState={run.run.state} client={client} eventsCursor={events.at(-1)?.sequence ?? 0}
          report={report} onRecovery={onRecovery} onState={onWorkflowJudgeState} />
        {run.run.state === 'waiting_for_user' && client?.hasFirstParty && !workflowJudgeEnabled && !workflow.judgePolicy
          && <RecoveryPanel run={run} workflow={workflow} onRecovery={onRecovery} />}
        <table><tbody>{visible.map(event => <tr key={event.sequence} onClick={() => event.nodeInstanceId && onSelectNode(event.nodeInstanceId)}>
          <td className="seq">#{event.sequence}</td><td className="time">{new Date(event.timestamp).toLocaleTimeString()}</td>
          <td className="type">{event.type}</td><td className="node">{event.nodeInstanceId || ''}</td><td className="payload">{describe(event)}</td>
        </tr>)}</tbody></table>
      </div>)}
      {panel === 'history' && <div className="history">
        {history.length === 0 ? <div className="empty">No runs in this workspace yet.</div> : <table><tbody>{history.map(item => <tr key={item.runId}>
          <td onClick={() => onOpenRun(item.runId)}><span className={`run-pill ${item.state}`}>{RUN_LABELS[item.state]}</span></td><td onClick={() => onOpenRun(item.runId)}>{item.kind === 'chat' ? <span className="muted"><MessageSquare size={11} /> chat turn</span> : item.workflowId}</td>
          <td><code>{item.runId.slice(0, 8)}</code></td><td>{new Date(item.createdAt).toLocaleString()}</td><td>{item.lastSequence} events</td>
          <td><button className="button small ghost" onClick={() => onReplay(item.runId)}><History size={12} />Replay</button></td></tr>)}</tbody></table>}
        <div className="history-actions"><button className="button small ghost" onClick={() => loadHistory(false)}><RefreshCw size={12} />Refresh</button>{cursor && <button className="button small ghost" onClick={() => loadHistory(true)}>Load more</button>}</div>
      </div>}
      {panel === 'contexts' && <div className="history">
        {bindings.length === 0 ? <div className="empty">Context bindings appear after a run uses a Context node.</div> : <table><tbody>{bindings.map(binding => <tr key={binding.bindingId}>
          <td><span className={`state-chip ${binding.state}`}>{STATE_LABELS[binding.state]}</span></td><td>{PROVIDER_NAMES[binding.provider]}</td><td><code>{binding.bindingId}</code></td><td>{binding.model || '—'}</td>
          <td>{binding.state === 'ready' && client?.hasFirstParty && <button className="button small ghost" onClick={() => onChat(binding)}><MessageSquare size={12} />Chat</button>}
            {binding.state === 'needs_review' && client?.hasFirstParty && <button className="button small secondary" onClick={async () => {
            if (!client) return;
            if (!window.confirm('Accept the current native conversation state? Its history may include turns from an interrupted or failed attempt.')) return;
            try { await client.post(`/context-bindings/${binding.bindingId}/acknowledge`, { requestId: crypto.randomUUID(), observedBindingSha256: binding.bindingSha256 }); await refreshBindings(); }
            catch (error) { report(error, 'Acknowledge failed: '); }
          }}>Accept current state</button>}</td></tr>)}</tbody></table>}
      </div>}
    </div>
  </section>;
}

function WorkflowJudgePanel({ runId, runState, client, eventsCursor, report, onRecovery, onState }: {
  runId: string; runState: RunSnapshot['run']['state']; client: Client | null; eventsCursor: number;
  report: (error: unknown, prefix?: string) => void; onRecovery: (body: Record<string, unknown>) => void; onState: (enabled: boolean) => void;
}) {
  const [data, setData] = useState<{ enabled: boolean; barrier: boolean; items: WorkflowJudgeQuestion[] }>({ enabled: false, barrier: false, items: [] });
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!client) return;
    try {
      const next = await client.get<{ enabled: boolean; barrier: boolean; items: WorkflowJudgeQuestion[] }>(`/runs/${runId}/judge-questions`);
      setData(next); onState(next.enabled);
    } catch (error) { report(error, 'Judge questions could not be loaded: '); }
  }, [client, onState, report, runId]);
  useEffect(() => { refresh(); }, [refresh, eventsCursor]);
  if (!data.enabled && data.items.length === 0) return null;
  const pending = data.items.filter(item => item.status === 'pending');
  const closeRun = () => {
    if (window.confirm('Close this Run as failed? This supersedes any pending Judge question and linked continuation.')) onRecovery({ action: 'close' });
  };
  const answer = async (question: WorkflowJudgeQuestion) => {
    if (!client || !client.hasFirstParty) return;
    const value = values[question.questionId] || '';
    const typedAnswer = question.answerSpec.type === 'choice'
      ? { type: 'choice' as const, optionId: value }
      : { type: 'text' as const, value };
    setSubmitting(question.questionId);
    try {
      await client.post(`/judge-questions/${question.questionId}/answers`, { requestId: crypto.randomUUID(), answer: typedAnswer });
      await refresh();
    } catch (error) { report(error, 'Judge answer was not accepted: '); }
    finally { setSubmitting(null); }
  };
  return <section className="judge-questions" aria-label="Workflow Judge questions">
    <div className="judge-questions-head"><h4>Workflow Judge</h4><span className="muted small">{data.barrier ? 'Run held at a Judge decision boundary' : 'No unresolved Judge barrier'}</span></div>
    {pending.length === 0 && <p className="muted small">{data.enabled ? 'There is no open typed question. The Judge may be waiting for meaningful evidence progress.' : 'No open questions.'}</p>}
    {data.items.map(question => <article className="judge-question" key={question.questionId}>
      <div className="judge-question-title"><strong>{question.status === 'pending' ? 'Owner input requested' : `Question ${question.status}`}</strong>
        {question.originatingRunId !== runId && <span className="muted small">Linked Repair</span>}</div>
      <p>{question.question}</p>
      {question.status === 'pending' && (question.answerSpec.type === 'choice'
        ? <label className="field"><span>Your answer</span><select value={values[question.questionId] || ''} onChange={event => setValues(current => ({ ...current, [question.questionId]: event.target.value }))}>
          <option value="">Choose an answer</option>{question.answerSpec.options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select></label>
        : <label className="field"><span>Your answer</span><textarea maxLength={question.answerSpec.maxLength} value={values[question.questionId] || ''}
          onChange={event => setValues(current => ({ ...current, [question.questionId]: event.target.value }))} /></label>)}
      {question.status === 'pending' && <button className="button small secondary" disabled={!client?.hasFirstParty || submitting === question.questionId
        || (question.answerSpec.type === 'choice' && !values[question.questionId])} onClick={() => answer(question)}>
        {submitting === question.questionId ? 'Submitting…' : 'Submit answer'}
      </button>}
    </article>)}
    {data.enabled && runState === 'waiting_for_user' && client?.hasFirstParty && <button className="button small ghost" onClick={closeRun}>Close Run</button>}
  </section>;
}

// The user decides how a waiting run continues: retry, raise a limit, restart an iteration, or close.
function RecoveryPanel({ run, workflow, onRecovery }: { run: RunSnapshot; workflow: Workflow; onRecovery: (body: Record<string, unknown>) => void }) {
  const [binding, setBinding] = useState<Record<string, string>>({});
  const [limits, setLimits] = useState<Record<string, { maxIterations: number; maxActiveMinutes: number }>>({});
  const nodes = new Map(allNodes(workflow).map(node => [node.id, node]));
  const startedLoops = new Set(run.loops.map(loop => loop.loopNodeId));
  const held = run.instances.filter(item => ['failed', 'canceled'].includes(item.state) && !startedLoops.has(item.nodeInstanceId));
  const paused = run.loops.filter(loop => loop.state === 'paused');
  const pausedMaps = (run.maps || []).filter(map => map.state === 'paused');
  return <div className="recovery">
    <strong>This run is waiting for your decision.</strong>
    {held.map(item => {
      const node = nodes.get(item.nodeId);
      const usesContext = node?.type === 'agent' && Boolean(node.config.contextId);
      return <div className="recovery-row" key={item.nodeInstanceId}>
        <span className={`state-chip ${item.state}`}>{STATE_LABELS[item.state]}</span><code>{item.nodeInstanceId}</code>
        {usesContext && <select value={binding[item.nodeInstanceId] || 'acknowledge'} onChange={event => setBinding({ ...binding, [item.nodeInstanceId]: event.target.value })}>
          <option value="acknowledge">Accept the conversation’s current state</option><option value="fresh">Start a fresh conversation</option><option value="keep">Keep (only if still ready)</option>
        </select>}
        <button className="button small secondary" onClick={() => onRecovery({ action: 'retry', nodeInstanceId: item.nodeInstanceId, ...(usesContext ? { binding: binding[item.nodeInstanceId] || 'acknowledge' } : {}) })}>Retry</button>
      </div>;
    })}
    {paused.map(loop => {
      const value = limits[loop.loopNodeId] || { maxIterations: loop.maxIterations + (loop.pauseReason === 'iteration_limit' ? 2 : 0), maxActiveMinutes: loop.maxActiveMinutes * (loop.pauseReason === 'time_limit' ? 2 : 1) };
      return <div className="recovery-row" key={loop.loopNodeId}>
        <span className="state-chip paused">Paused</span><code>{loop.loopNodeId}</code><span className="muted small">{loop.pauseReason?.replace('_', ' ')} at iteration {loop.iteration}</span>
        {(loop.pauseReason === 'iteration_limit' || loop.pauseReason === 'time_limit') && <>
          <input className="tiny" type="number" min={1} max={50} value={value.maxIterations} onChange={event => setLimits({ ...limits, [loop.loopNodeId]: { ...value, maxIterations: Number(event.target.value) } })} title="Max iterations" />
          <input className="tiny" type="number" min={1} max={1440} value={value.maxActiveMinutes} onChange={event => setLimits({ ...limits, [loop.loopNodeId]: { ...value, maxActiveMinutes: Number(event.target.value) } })} title="Max active minutes" />
          <button className="button small secondary" onClick={() => onRecovery({ action: 'raise-limit', loopNodeId: loop.loopNodeId, ...value })}>Raise limits</button>
        </>}
        {loop.pauseReason !== 'time_limit' && <button className="button small ghost" onClick={() => onRecovery({ action: 'restart-iteration', loopNodeId: loop.loopNodeId })}>Restart iteration</button>}
      </div>;
    })}
    {pausedMaps.map(map => <MapLimitRow key={map.mapExecutionId} map={map} onRecovery={onRecovery} />)}
    <div className="recovery-row"><button className="button small danger" onClick={() => window.confirm('Close this run as failed? Unstarted work will be canceled.') && onRecovery({ action: 'close' })}>Close run as failed</button></div>
  </div>;
}

function MapLimitRow({ map, onRecovery }: { map: NonNullable<RunSnapshot['maps']>[number]; onRecovery: (body: Record<string, unknown>) => void }) {
  const [cycles, setCycles] = useState(map.maxFailedVerificationCycles + 2);
  const [attempts, setAttempts] = useState(5);
  const limit = map.pauseReason === 'verification_limit' || map.pauseReason === 'task_attempt_limit';
  return <div className="recovery-row">
    <span className="state-chip paused">Paused</span><code>{map.mapInstanceId}</code>
    <span className="muted small">{map.pauseReason?.replace(/_/g, ' ')} · {map.accepted}/{map.total} accepted · failures {map.failedVerificationCycles}/{map.maxFailedVerificationCycles}</span>
    {limit ? <>
      <input className="tiny" type="number" min={1} max={20} value={cycles} onChange={event => setCycles(Number(event.target.value))} title="Max failed verification cycles" />
      <input className="tiny" type="number" min={1} max={20} value={attempts} onChange={event => setAttempts(Number(event.target.value))} title="Max attempts per task" />
      <button className="button small secondary" onClick={() => onRecovery({ action: 'raise-map-limit', nodeInstanceId: map.mapInstanceId, maxFailedVerificationCycles: cycles, maxTaskAttempts: attempts })}>Raise Map limits</button>
    </> : <span className="muted small">Retry the triage step above after correcting the cause.</span>}
  </div>;
}

function describe(event: JournalEvent) {
  const p = event.payload;
  switch (event.type) {
    case 'run.state_changed': case 'attempt.state_changed': return `${p.from ?? '∅'} → ${p.to} · ${p.reason}`;
    case 'context.state_changed': return `${p.bindingId.slice(0, 8)} ${p.from} → ${p.to} · ${p.reason}`;
    case 'attempt.error': return `${p.code}: ${p.message}`;
    case 'attempt.log_chunk': return `${p.stream} #${p.chunkIndex}`;
    case 'node.planned': return `${p.nodeType}${p.scope ? ` · iteration ${p.scope.iteration}` : ''}`;
    case 'run.capacity_changed': return `settings revision ${p.revision}`;
    case 'context.bound': return `${p.provider} native session captured`;
    case 'context.remapped': return `${p.contextNodeId}: fresh binding ${p.toBindingId.slice(0, 8)}`;
    case 'run.recovery_requested': return `${p.action}${p.target ? ` · ${p.target}` : ''}`;
    case 'loop.started': return `limits ${p.maxIterations} iterations / ${p.maxActiveMinutes} min`;
    case 'loop.iteration_started': return `iteration ${p.iteration}${p.restart ? ' (restart)' : ''}`;
    case 'loop.iteration_returned': return `iteration ${p.iteration}: ${p.continue ? 'continue' : 'finish'} · ${p.reason}`;
    case 'loop.paused': return `${p.reason} · ${p.message}`;
    case 'loop.resumed': return p.reason;
    case 'loop.limits_changed': return `${p.maxIterations} iterations / ${p.maxActiveMinutes} min`;
    case 'loop.finished': return `${p.iterations} iteration(s) · ${(p.activeMs / 1000).toFixed(1)} s active`;
    case 'run.planned': return `${p.mode}${p.mode === 'workflow' ? '' : ` → ${p.targets.join(', ')}`}`;
    case 'attempt.reused': return `outputs reused from run ${p.sourceRunId.slice(0, 8)}`;
    case 'cache.reused': return `pinned value from run ${p.sourceRunId.slice(0, 8)}`;
    case 'cache.pinned': return 'pin replaced with this run’s value';
    case 'route.selected': return p.caseId === null ? 'no case matched' : `case ${p.caseId}`;
    case 'gate.review_carried': return `${p.slot} approval carried from ${p.priorSubjectId} · ${p.record.recordId}`;
    case 'map.expanded': return `generation ${p.generation} · ${p.tasks} tasks${p.carried.length ? ` · carried ${p.carried.join(', ')}` : ''}`;
    case 'map.task_state_changed': return `${p.taskId}: ${p.from ?? '∅'} → ${p.to} · ${p.reason}`;
    case 'map.record_created': return `${p.taskId}: ${p.kind} ${p.record.recordId}`;
    case 'map.verification_cycle': return `${p.taskId} cycle ${p.cycle}: ${p.outcome} · failures ${p.failedVerificationCycles}/${p.maxFailedVerificationCycles}`;
    case 'map.paused': return `${p.reason} · ${p.message}`;
    case 'map.resumed': return p.reason;
    case 'map.limits_changed': return `${p.maxFailedVerificationCycles} failed cycles / ${p.maxTaskAttempts} attempts per task`;
    case 'map.finished': return p.outcome;
    case 'gate.evaluated': return `${p.mode}${p.status ? ` · ${p.status}` : ''} · ${p.subjectId}${p.recordId ? ` · ${p.recordId}` : ''}`;
    default: return '';
  }
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <div className="modal"><div className="modal-head"><h3>{title}</h3><button className="icon-button" onClick={onClose}>×</button></div>{children}</div>
  </div>;
}

function WorkspaceModal({ client, workspaces, current, onSelect, onCreated, onClose, report }: { client: Client; workspaces: Workspace[]; current: string; onSelect: (id: string) => void; onCreated: (id: string) => void; onClose: () => void; report: (error: unknown) => void }) {
  const [id, setId] = useState(workspaces.length ? '' : 'main');
  const [cwd, setCwd] = useState('');
  const pick = async () => {
    if (!isTauri()) return;
    const { open } = await import('@tauri-apps/plugin-dialog');
    const folder = await open({ directory: true, multiple: false, title: 'Select the workspace directory' });
    if (typeof folder === 'string') setCwd(folder);
  };
  const create = async () => {
    if (!client.hasFirstParty) return;
    if (!validId(id)) { report(new Error('Workspace ID must use lowercase letters, digits and hyphens.')); return; }
    try { await client.put(`/workspaces/${id}`, { cwd: cwd || `${client.connection.scratchRoot}${client.connection.scratchRoot.includes('\\') ? '\\' : '/'}${id}` }); onCreated(id); }
    catch (error) { report(error); }
  };
  return <Modal title="Workspace" onClose={onClose}>
    {workspaces.length > 0 && <div className="list">{workspaces.map(item => <button key={item.workspaceId} className={`list-item ${item.workspaceId === current ? 'active' : ''}`} onClick={() => onSelect(item.workspaceId)}>
      <strong>{item.workspaceId}</strong><small>{item.cwd}</small></button>)}</div>}
    {client.hasFirstParty ? <>
      <h4 className="section-title">{workspaces.length ? 'Add a workspace' : 'Create your first workspace'}</h4>
      <p className="muted small">Agents run in this directory with Full Access. Leave the folder empty to use a managed scratch folder.</p>
      <label className="field"><span>Workspace ID</span><input value={id} onChange={event => setId(event.target.value.toLowerCase())} placeholder="main" /></label>
      <label className="field"><span>Directory</span><div className="row"><input value={cwd} onChange={event => setCwd(event.target.value)} placeholder="Managed scratch folder" />{isTauri() && <button className="button secondary" onClick={pick}><FolderOpen size={14} />Browse</button>}</div></label>
      <div className="modal-actions"><button className="button primary" onClick={create}>Save workspace</button></div>
    </> : <p className="muted small">Workspace changes are managed in the Deszo window. Select an existing workspace to choose where a run request will apply.</p>}
  </Modal>;
}

type Template = 'empty' | 'chain' | 'loop' | 'spec' | 'delivery' | 'selective' | 'reference';
function WorkflowModal({ workflows, onOpen, onCreate, onClose, report }: { workflows: WorkflowSummary[]; onOpen: (id: string) => void; onCreate: (id: string, template: Template) => void; onClose: () => void; report: (error: unknown) => void }) {
  const [id, setId] = useState('');
  const create = (template: Template) => validId(id) ? onCreate(id, template) : report(new Error('Use lowercase letters, digits and hyphens, starting with a letter.'));
  return <Modal title="Workflows" onClose={onClose}>
    <div className="list">{workflows.length === 0 ? <p className="muted">No saved workflows yet.</p> : workflows.map(item => <button key={item.workflowId} className="list-item" onClick={() => onOpen(item.workflowId)}>
      <strong>{item.workflowId}</strong><small>Updated {new Date(item.updatedAt).toLocaleString()} · {item.draftRevision === null ? 'no Draft' : `Draft r${item.draftRevision}`} · {item.latestPublishedVersion === null ? 'unpublished' : `Published v${item.latestPublishedVersion}${item.runnable ? '' : ' · not Runnable'}`}</small></button>)}</div>
    <h4 className="section-title">New workflow</h4>
    <label className="field"><span>Workflow ID</span><input value={id} onChange={event => setId(event.target.value.toLowerCase())} placeholder="review-chain" /></label>
    <div className="modal-actions">
      <button className="button secondary" onClick={() => create('chain')}>Context-chain template</button>
      <button className="button secondary" onClick={() => create('loop')}>Review-loop template</button>
      <button className="button secondary" onClick={() => create('spec')}>Specification-loop template</button>
      <button className="button secondary" onClick={() => create('delivery')}>Delivery (Map) template</button>
      <button className="button secondary" onClick={() => create('selective')}>Selective-revision template</button>
      <button className="button secondary" onClick={() => create('reference')}>Reference delivery (full loop)</button>
      <button className="button primary" onClick={() => create('empty')}>Empty workflow</button>
    </div>
  </Modal>;
}

function ApprovalModal({ client, requests, grants, onClose, onChanged, report }: { client: Client; requests: RunRequest[]; grants: ControlGrant[]; onClose: () => void; onChanged: () => Promise<void>; report: (error: unknown, prefix?: string) => void }) {
  const [busyRequest, setBusyRequest] = useState<string | null>(null);
  const decide = async (requestId: string, decision: 'approve' | 'deny', kind: 'run-requests' | 'control-grants' = 'run-requests') => {
    setBusyRequest(requestId);
    try {
      await client.post(`/${kind}/${requestId}/decision`, { requestId: crypto.randomUUID(), decision });
    } catch (error) { report(error, `Could not ${decision} run request: `); }
    finally { await onChanged(); setBusyRequest(null); }
  };
  return <Modal title={`Approvals · ${requests.length + grants.length} pending`} onClose={onClose}>
    {grants.map(item => <article className="approval-item" key={item.grantId}>
      <div className="approval-heading"><strong>Supervision · {item.workflowId}</strong><span className="state-chip waiting_for_user">Pending</span></div>
      <dl className="approval-facts">
        <div><dt>Workspace</dt><dd>{item.workspaceId}</dd></div>
        <div><dt>Controller</dt><dd>{item.clientLabel || item.clientProvider} <em>(unverified client claim)</em></dd></div>
        <div><dt>Client version</dt><dd>{item.clientVersion || 'Not supplied'}</dd></div>
        <div><dt>Snapshot</dt><dd><code>{item.workflowSnapshotSha256.slice(0, 16)}…</code></dd></div>
        <div><dt>Actions</dt><dd>{item.requestedActions.join(', ')}</dd></div>
        <div><dt>Observation / Stop</dt><dd>{item.observationDeadlineMs / 1000}s / {item.escalationDeadlineMs / 1000}s</dd></div>
      </dl>
      <div className="modal-actions">
        <button className="button secondary" disabled={busyRequest === item.grantId} onClick={() => decide(item.grantId, 'deny', 'control-grants')}>Deny supervision</button>
        <button className="button primary" disabled={busyRequest === item.grantId} onClick={() => decide(item.grantId, 'approve', 'control-grants')}>Approve supervision</button>
      </div>
    </article>)}
    {requests.length === 0 ? <div className="empty">No pending run requests.</div> : <div className="approval-list">{requests.map(item => <article className="approval-item" key={item.requestId}>
      <div className="approval-heading"><strong>{item.workflowId}</strong><span className="state-chip waiting_for_user">Pending</span></div>
      <dl className="approval-facts">
        <div><dt>Workspace</dt><dd>{item.workspaceId}</dd></div>
        <div><dt>Requested by</dt><dd>{item.clientLabel || 'Unlabelled client'} <em>(unverified client claim)</em></dd></div>
        <div><dt>Snapshot</dt><dd><code>{item.workflowSnapshotSha256.slice(0, 16)}…</code></dd></div>
        <div><dt>Control</dt><dd>{item.controlModeRequested || 'unsupervised'}</dd></div>
        <div><dt>Expires</dt><dd>{new Date(item.expiresAt).toLocaleString()}</dd></div>
      </dl>
      <div className="modal-actions">
        <button className="button secondary" disabled={busyRequest === item.requestId} onClick={() => decide(item.requestId, 'deny')}>Deny</button>
        <button className="button primary" disabled={busyRequest === item.requestId} onClick={() => decide(item.requestId, 'approve')}><ShieldCheck size={14} />Approve and run</button>
      </div>
    </article>)}</div>}
    <p className="muted small">Approval rechecks the saved workflow snapshot, workspace binding and current run requirements. Approving starts provider work.</p>
  </Modal>;
}

function SettingsModal({ client, capabilities, onCapabilities, onClose, report }: { client: Client; capabilities: Capabilities | null; onCapabilities: (value: Capabilities) => void; onClose: () => void; report: (error: unknown) => void }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [draft, setDraft] = useState<AppSettings['settings'] | null>(null);
  const [checking, setChecking] = useState(false);
  const [clientProvider, setClientProvider] = useState<'codex' | 'claude' | 'antigravity'>('codex');
  const [allowExecution, setAllowExecution] = useState(false);
  const [workingDirectory, setWorkingDirectory] = useState('');
  const [mcpConfigPath, setMcpConfigPath] = useState('');
  const [configOutput, setConfigOutput] = useState('');
  useEffect(() => { client.get<AppSettings>('/settings').then(value => { setSettings(value); setDraft(value.settings); }).catch(report); }, [client, report]);
  const saveSettings = async () => {
    if (!client.hasFirstParty || !settings || !draft) return;
    try { const value = await client.put<AppSettings>('/settings', { requestId: crypto.randomUUID(), expectedRevision: settings.revision, settings: draft }); setSettings(value); setDraft(value.settings); }
    catch (error) { report(error); }
  };
  const recheck = async () => { setChecking(true); try { onCapabilities(await client.get<Capabilities>('/capabilities')); } catch (error) { report(error); } finally { setChecking(false); } };
  const generateClientConfig = () => {
    const { nodeExecutable, bridgeScript, connectionFile } = client.connection;
    if (!nodeExecutable || !bridgeScript || !connectionFile) { report(new Error('This runtime does not publish the Node.js, bridge, and connection-file paths needed for client setup.')); return; }
    if (clientProvider === 'antigravity' && (!workingDirectory || !mcpConfigPath || ![workingDirectory, mcpConfigPath].every(path => /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(path)))) {
      report(new Error('Antigravity setup needs absolute authoring-directory and MCP config-file paths.')); return;
    }
    const args = [bridgeScript, '--connection-file', connectionFile, '--client-provider', clientProvider];
    if (clientProvider === 'antigravity') args.push('--working-directory', workingDirectory, '--mcp-config-path', mcpConfigPath);
    if (allowExecution) args.push('--allow-execution');
    const value = clientProvider === 'codex'
      ? `[mcp_servers.deszo]\ncommand = ${JSON.stringify(nodeExecutable)}\nargs = ${JSON.stringify(args)}\n`
      : JSON.stringify({ mcpServers: { deszo: { command: nodeExecutable, args } } }, null, 2);
    setConfigOutput(value);
  };
  const copyClientConfig = async () => {
    if (!configOutput) { generateClientConfig(); return; }
    try { await navigator.clipboard.writeText(configOutput); }
    catch (error) { report(error); }
  };
  return <Modal title="Settings" onClose={onClose}>
    <h4 className="section-title">Providers <button className="button small ghost" onClick={recheck} disabled={checking}><RefreshCw size={12} className={checking ? 'spin' : ''} />Check again</button></h4>
    <p className="muted small">Detection never sends a model request. Official CLIs authenticate with their subscription accounts; there is no API, credit or model fallback.</p>
    <table className="provider-table"><tbody>{(capabilities?.providers || []).map(item => <tr key={item.provider}>
      <td><strong>{PROVIDER_NAMES[item.provider]}</strong></td><td><span className={`state-chip ${item.available ? 'succeeded' : 'failed'}`}>{item.available ? 'Available' : 'Unavailable'}</span></td>
      <td><code>{item.cliVersion || '—'}</code></td><td className="muted">{item.reason || ''}</td></tr>)}</tbody></table>
    <p className="muted small">Engine capabilities: {capabilities?.engineCapabilities.join(', ') || '…'}</p>
    <h4 className="section-title">Capacity <em>application-wide, across all workspaces</em></h4>
    {draft && <div className="capacity-grid">
      <label className="field"><span>All Agent calls</span><input type="number" min={1} max={16} value={draft.globalLimit} onChange={event => setDraft({ ...draft, globalLimit: Math.min(16, Math.max(1, Number(event.target.value) || 1)) })} /></label>
      {PROVIDERS.map(provider => <label className="field" key={provider}><span>{PROVIDER_NAMES[provider]}</span>
        <input type="number" min={1} max={8} value={draft.providerLimits[provider]} onChange={event => setDraft({ ...draft, providerLimits: { ...draft.providerLimits, [provider]: Math.min(8, Math.max(1, Number(event.target.value) || 1)) } })} /></label>)}
    </div>}
    {client.hasFirstParty && draft && <label className="check policy-check"><input type="checkbox" checked={draft.externalRunConfirmation} onChange={event => setDraft({ ...draft, externalRunConfirmation: event.target.checked })} />Require approval in Deszo before external run requests start</label>}
    {!client.hasFirstParty && <p className="muted small">Runtime settings can only be changed in the Deszo window.</p>}
    <p className="muted small">Lowering a limit never stops running calls; new calls wait. Raising per-provider concurrency should be tested against your account first.</p>
    <div className="modal-actions"><span className="muted small">Revision {settings?.revision ?? '…'} · data folder {client.connection.root}</span>{client.hasFirstParty && <button className="button primary" onClick={saveSettings}>Save settings</button>}</div>
    <h4 className="section-title">External authoring bridge</h4>
    <p className="muted small">The local stdio bridge forwards to this running runtime. It reads the external connection descriptor and never starts another runtime.</p>
    <label className="field"><span>Client</span><select value={clientProvider} onChange={event => { setClientProvider(event.target.value as typeof clientProvider); setConfigOutput(''); }}>
      <option value="codex">Codex</option><option value="claude">Claude Code</option><option value="antigravity">Antigravity</option>
    </select></label>
    {clientProvider === 'antigravity' && <>
      <label className="field"><span>Dedicated authoring directory</span><input value={workingDirectory} onChange={event => { setWorkingDirectory(event.target.value); setConfigOutput(''); }} placeholder="Absolute path outside every workspace" /></label>
      <label className="field"><span>Workspace MCP config file</span><input value={mcpConfigPath} onChange={event => { setMcpConfigPath(event.target.value); setConfigOutput(''); }} placeholder="Absolute path to the existing config file" /></label>
      <p className="muted small">The bridge handshake verifies these paths and rejects overlaps with registered workspaces.</p>
    </>}
    <label className="check policy-check"><input type="checkbox" checked={allowExecution} onChange={event => { setAllowExecution(event.target.checked); setConfigOutput(''); }} />Expose start and stop run tools to this client</label>
    <div className="modal-actions"><button className="button secondary" onClick={generateClientConfig}><FileText size={14} />Generate client config</button>{configOutput && <button className="button ghost" onClick={copyClientConfig}>Copy config</button>}</div>
    {configOutput && <pre className="config-output">{configOutput}</pre>}
  </Modal>;
}

// Manual chat with a ready binding; every turn is an ordinary chat run with the same journal and locks.
function ChatModal({ client, binding, workspaceId, onClose, report }: { client: Client; binding: ContextBinding; workspaceId: string; onClose: () => void; report: (error: unknown, prefix?: string) => void }) {
  const [turns, setTurns] = useState<{ runId: string; state: string; prompt: string; reply: string | null; error: string | null }[]>([]);
  const [model, setModel] = useState(binding.model || '');
  const [effort, setEffort] = useState<Effort>(DEFAULT_EFFORT);
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const load = useCallback(async () => {
    const page = await client.get<{ items: Run[] }>(`/runs?kind=chat&bindingId=${binding.bindingId}&limit=50`);
    const loaded = await Promise.all(page.items.reverse().map(async item => {
      const snapshot = await client.get<RunSnapshot>(`/runs/${item.runId}`);
      const text = async (id: string) => {
        const instance = snapshot.instances.find(entry => entry.nodeInstanceId === id);
        if (!instance?.outputs) return null;
        const manifest = await client.artifactJson(instance.outputs.artifactId);
        return client.artifactText(manifest.values[id === 'message' ? 'text' : 'text'].artifact.artifactId);
      };
      const failed = snapshot.instances.find(entry => entry.nodeInstanceId === 'reply' && entry.state === 'failed');
      return { runId: item.runId, state: item.state, prompt: (await text('message')) || '', reply: await text('reply'), error: failed ? 'The turn failed; open it from History for details.' : null };
    }));
    setTurns(loaded);
  }, [binding.bindingId, client]);
  useEffect(() => { load().catch(error => report(error)); }, [load, report]);
  const send = async () => {
    if (!prompt.trim() || !model) return;
    setSending(true);
    try {
      const accepted = await client.post<{ run: Run }>(`/context-bindings/${binding.bindingId}/messages`, { requestId: crypto.randomUUID(), workspaceId, model, effort, prompt });
      setPrompt('');
      for (let i = 0; i < 1200; i++) {
        const snapshot = await client.get<RunSnapshot>(`/runs/${accepted.run.runId}`);
        if (TERMINAL_RUN.includes(snapshot.run.state)) break;
        await new Promise(done => setTimeout(done, 500));
      }
      await load();
    } catch (error) { report(error, 'Chat turn was not sent: '); }
    finally { setSending(false); }
  };
  return <Modal title={`Chat · ${PROVIDER_NAMES[binding.provider]} · ${binding.bindingId.slice(0, 8)}`} onClose={onClose}>
    <p className="muted small">Each message continues the native conversation of this binding. Later Continue runs append after these turns.</p>
    <div className="chat-log">{turns.length === 0 ? <p className="muted">No manual turns yet.</p> : turns.map(turn => <div className="chat-turn" key={turn.runId}>
      <div className="chat-you"><strong>You</strong><pre>{turn.prompt}</pre></div>
      <div className="chat-agent"><strong>{PROVIDER_NAMES[binding.provider]}</strong>{turn.reply !== null ? <pre>{turn.reply}</pre> : <small className="muted">{turn.error || RUN_LABELS[turn.state]}</small>}</div>
    </div>)}</div>
    <label className="field"><span>Model ID <em>explicit; never substituted</em></span><input value={model} onChange={event => setModel(event.target.value.trim())} placeholder="Enter an exact model ID" /></label>
    <EffortField value={effort} readOnly={sending} onChange={setEffort} />
    <label className="field"><span>Message</span><textarea rows={4} value={prompt} onChange={event => setPrompt(event.target.value)} /></label>
    <div className="modal-actions"><button className="button primary" onClick={send} disabled={sending || !prompt.trim() || !model}><MessageSquare size={14} />{sending ? 'Waiting for the reply…' : 'Send'}</button></div>
  </Modal>;
}
