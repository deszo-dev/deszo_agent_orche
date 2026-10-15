export type Provider = 'codex' | 'claude' | 'antigravity';
export const PROVIDERS: Provider[] = ['codex', 'claude', 'antigravity'];
export const PROVIDER_NAMES: Record<Provider, string> = { codex: 'Codex', claude: 'Claude Code', antigravity: 'Antigravity' };

export interface ArtifactRef { artifactId: string; sha256: string }
export type ValueType = 'Text' | 'JsonValue' | 'ArtifactSet';
export const VALUE_TYPES: ValueType[] = ['Text', 'JsonValue', 'ArtifactSet'];
export type OutputContract = { format: 'text' } | { format: 'json'; schema?: Record<string, unknown> };
export type FieldSource = { input: string; pointer?: string } | { literal: unknown };
export type TextSource = { literal: string } | { pointer: string };

export interface LoopConfig {
  valueType: ValueType; stateSchema?: Record<string, unknown>; fixedInputs: { id: string; type: ValueType }[];
  limits: { maxIterations: number; maxActiveMinutes: number };
  body: { nodes: WorkflowNode[]; edges: WorkflowEdge[]; after: { before: string; after: string }[]; view?: Record<string, { x: number; y: number; label?: string }> };
}

export type WorkflowNode =
  | { id: string; type: 'text'; config: { value: string } }
  | { id: string; type: 'prompt-template'; config: { template: string; slots: { id: string; description?: string }[] } }
  | { id: string; type: 'agent'; config: { provider: Provider; model: string; contextId?: string; timeoutSeconds: number; output: OutputContract; attachFiles?: boolean; captures?: string[] } }
  | { id: string; type: 'context'; config: { provider: Provider; mode: 'new'; lifetime?: 'run' | 'iteration' } | { provider: Provider; mode: 'continue'; bindingId: string } }
  | { id: string; type: 'result-viewer'; config: Record<string, never> }
  | { id: string; type: 'file-input'; config: { mode: 'files'; paths: string[] } | { mode: 'artifact'; valueType: ValueType; artifact: ArtifactRef } }
  | { id: string; type: 'merge'; config: { mode: 'text'; inputs: { id: string }[]; separator: string } | { mode: 'artifacts'; inputs: { id: string }[] }
      | { mode: 'record'; inputs: { id: string; type: ValueType }[]; fields: { name: string; source: FieldSource }[]; schema?: Record<string, unknown> }
      | { mode: 'selected'; valueType: ValueType; inputs: { id: string }[] } }
  | { id: string; type: 'json-select'; config: { pointer: string; outputType: ValueType; render?: 'raw-string' | 'canonical-json'; nullAs?: 'error' | 'empty' } }
  | { id: string; type: 'condition'; config: { doneWhen: { pointer: string; op: 'equals' | 'not-equals' | 'is-true' | 'is-false'; value?: unknown }; reason: TextSource; feedback: TextSource } }
  | { id: string; type: 'loop'; config: LoopConfig }
  | { id: string; type: 'cache'; config: { valueType: ValueType; mode: 'live' | 'frozen' } }
  | { id: string; type: 'route'; config: { valueType: ValueType; selector: string; cases: { id: string; equals: unknown }[]; onUnmatched: 'error' | 'pause' } }
  | { id: string; type: 'gate'; config: { mode: 'prepare' | 'evaluate' | 'verify'; policy: GatePolicy; carry?: boolean; subject?: 'specification' | 'delivery'; specificationPolicy?: GatePolicy; technicalPolicy?: GatePolicy } }
  | { id: string; type: 'map'; config: MapConfig };
export type MapRole =
  | { id: string; kind: 'agent'; provider: Provider; model: string; instructions: string; timeoutSeconds: number; context: 'task' | { contextId: string } }
  | { id: string; kind: 'utility'; template: 'verification'; embeddedRoles: { triage: string } };
export interface MapConfig {
  approvalPolicy: GatePolicy; optionalInputs: ('prior-state' | 'repair')[];
  limits: { maxFailedVerificationCycles: number; maxTaskAttempts: number }; roles: MapRole[]; carryAcrossRevisions?: boolean;
}
export interface GatePolicy { slots: { id: string; role: string; view: 'full' | 'public'; scopeRefs?: string[] }[] }
export type NodeType = WorkflowNode['type'];

export interface WorkflowEdge { id: string; source: { nodeId: string; port: string }; target: { nodeId: string; port: string } }
export type Capability = 'core-v1' | 'loops-v1' | 'cache-v1' | 'pipeline-v1' | 'delivery-v1' | 'revisions-v1';
export interface Workflow {
  schemaVersion: 1; workflowId: string; capabilities: Capability[];
  settings: { nativeConfiguration: 'restricted' | 'inherit' };
  nodes: WorkflowNode[]; edges: WorkflowEdge[]; after: { before: string; after: string }[];
  view?: Record<string, { x: number; y: number; label?: string }>;
}

export interface Issue { path: string; message: string }
export interface SavedWorkflow { workflow: Workflow; snapshotSha256: string; executionHash: string; revision: number; etag: string; validation: { valid: boolean; issues: Issue[] } }
export interface WorkflowSummary { workflowId: string; snapshotSha256: string; executionHash: string; revision: number; createdAt: string; updatedAt: string }
export interface Workspace { workspaceId: string; cwd: string; cwdIdentity: string; createdAt: string; updatedAt: string }

export type RunState = 'queued' | 'running' | 'draining' | 'waiting_for_user' | 'stopping' | 'succeeded' | 'failed' | 'canceled' | 'interrupted';
export type AttemptState = 'scheduled' | 'waiting' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'blocked' | 'interrupted' | 'reused' | 'skipped';
export const TERMINAL_RUN: RunState[] = ['succeeded', 'failed', 'canceled', 'interrupted'];
export interface Run { runId: string; workflowId: string; workflowSnapshot: ArtifactRef; executionHash: string; state: RunState; lastSequence: number; createdAt: string; workspaceId: string; kind: 'workflow' | 'chat' }
export interface CachePin { nodeId: string; value: { type: ValueType; artifact: ArtifactRef }; sourceRunId: string; sourceAttemptId: string; fingerprint: string; sourceChanged: boolean; orphaned?: boolean; pinnedAt: string }
export interface LoopExecution { loopNodeId: string; state: 'running' | 'paused' | 'finished' | 'failed' | 'canceled' | 'interrupted'; iteration: number; maxIterations: number; maxActiveMinutes: number; activeMs: number; pauseReason: string | null }
export interface RunSnapshot {
  run: Run;
  instances: { nodeInstanceId: string; nodeId: string; state: AttemptState; attemptId: string; ordinal: number; outputs: ArtifactRef | null }[];
  contexts: { contextNodeId: string; mode: 'new' | 'continue'; bindingId: string }[];
  loops: LoopExecution[];
  maps?: MapExecution[];
}
export interface MapExecution { mapInstanceId: string; mapExecutionId: string; state: string; generation: number; failedVerificationCycles: number; maxFailedVerificationCycles: number; pauseReason: string | null; accepted: number; total: number }
export interface MapNavigator {
  mapInstanceId: string; mapExecutionId: string; generation: number; specificationId: string; state: string; pauseReason: string | null;
  failedVerificationCycles: number; maxFailedVerificationCycles: number; maxTaskAttempts: number;
  progress: { accepted: number; total: number; waiting: number; running: number; blocked: number };
  tasks: { taskId: string; title: string; executorRole: string; dependsOn: string[]; state: string; readiness: string | null; attempts: number; selectedResultId: string | null; carried: boolean;
    criteria: { id: string; method: 'review' | 'check'; verdict: 'pending' | 'passed' | 'failed'; recordId: string | null }[];
    steps: { nodeInstanceId: string; step: string; state: string; ordinal: number; attemptId: string }[];
    issues: { id: string; severity: string; ownerRole: string; message: string; requestedChange: string }[];
    fingerprint?: string | null; results?: { recordId: string; status: string }[];
    carriedFrom?: { mapExecutionId: string; subjectId: string; resultId: string; carryRecordId: string | null; crossRevision: boolean } | null }[];
  runId?: string; priorExecutionId?: string | null; crossRevision?: boolean;
}
export interface MapHistory {
  mapInstanceId: string;
  executions: { mapExecutionId: string; runId: string; mapInstanceId: string; generation: number; specificationId: string; state: string; createdAt: string; priorExecutionId: string | null; crossRevision: boolean; carried: number; accepted: number; total: number }[];
}
export interface ContextBinding { bindingId: string; provider: Provider; workspaceId: string; state: 'unbound' | 'ready' | 'writing' | 'needs_review' | 'unavailable'; model: string | null; configurationHash: string; bindingSha256: string }
export interface Capabilities {
  schemaVersion: 1; engineCapabilities: string[]; maximumAgentTimeoutSeconds: number; processContainment: string;
  providers: { provider: Provider; available: boolean; cliVersion: string | null; supportsNew: boolean; supportsResume: boolean; supportsJson: boolean; supportsInheritedConfiguration: boolean; reason: string | null }[];
}
export interface AppSettings { revision: number; sha256: string; settings: { schemaVersion: 1; globalLimit: number; providerLimits: Record<Provider, number>; externalRunConfirmation: boolean } }
export interface JournalEvent {
  schemaVersion: 1 | 2; id: string; runId: string; sequence: number; timestamp: string;
  nodeInstanceId: string | null; attemptId: string | null; type: string; payload: Record<string, any>;
}
export interface Connection {
  port: number; token: string; firstPartyToken?: string; root: string; scratchRoot: string; processContainment: string;
  descriptorVersion?: number; apiVersions?: string[]; storeId?: string; runtimeInstanceId?: string; applicationRoot?: string; nodeExecutable?: string;
  bridgeScript?: string; connectionFile?: string;
}
export interface RunRequest {
  requestId: string; workflowId: string; workspaceId: string; workflowSnapshotSha256: string; clientLabel: string | null;
  state: 'pending' | 'approved' | 'denied' | 'expired'; createdAt: string; expiresAt: string; runId: string | null;
  problem: { code: string; message: string; details: { path: string; message: string }[] } | null;
}
