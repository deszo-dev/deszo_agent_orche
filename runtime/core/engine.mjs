import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { StringDecoder } from 'node:string_decoder';
import { canonicalBytes, canonicalHash, canonicalize, parseStrictJson, sha256 } from './canonical.mjs';
import { assertValid, check, compileOutputSchema, SCHEMAS } from './schemas.mjs';
import { CorruptionError, nowIso, Store } from './store.mjs';
import { INPUT, M1_MAXIMUM_TIMEOUT, PROVIDERS, RETURN, capabilityIssues, contextIdsOf, isExecutable, nodePorts, semanticIssues, structuralIssues, topologicalOrder } from './validate.mjs';
import { ADAPTER_VERSION, defaultAdapters, outputContractText, parseJsonAnswer } from './adapters.mjs';
import { isAlive, killTree, launch, processStartTime } from './processes.mjs';
import { UtilityError, captureFiles, jsonValue, ref, resolvePointer, runUtility, textValue, values as valueHelpers } from './utilities.mjs';
import { transportSchema } from './transport.mjs';
import { allNodesDeep, bodyPrefix, enclosingLoops, fingerprints, parseInstance, requiredSet, returnSources } from './planning.mjs';
import * as gate from './gate.mjs';
import { installMapRuntime } from './mapRuntime.mjs';
import { installSupervision } from './supervision.mjs';
import { shimFailureOf } from './supervisor-client.mjs';
import { StreamRecorder } from './streams.mjs';
import { prepareManagedToolIsolation } from './managed-isolation.mjs';
import { DEFAULT_EFFORT, EFFORT_POLICY_VERSION, resolveEffort } from '../../shared/effort.mjs';
import contextChainExample from '../../docs/examples/m1-context-chain/workflow.json' with { type: 'json' };
import deliveryExample from '../../docs/examples/reference-delivery/workflow.json' with { type: 'json' };

export { parseInstance };

export class ApiError extends Error {
  constructor(status, code, message, details = []) { super(message); this.status = status; this.code = code; this.details = details; }
}

const TERMINAL_RUN = new Set(['succeeded', 'failed', 'canceled', 'interrupted']);
const ACTIVE_RUN = new Set(['queued', 'running', 'draining', 'waiting_for_user', 'stopping']);
const ACTIVE_SQL = `('queued','running','draining','waiting_for_user','stopping')`;
const TERMINAL_ATTEMPT = new Set(['succeeded', 'failed', 'canceled', 'blocked', 'interrupted', 'reused', 'skipped']);
const DONE_OK = new Set(['succeeded', 'reused']);
const UNSTARTED = new Set(['scheduled', 'waiting']);
const DEFAULT_SETTINGS = { schemaVersion: 1, globalLimit: 3, providerLimits: { codex: 1, claude: 1, antigravity: 1 }, externalRunConfirmation: true };
const LIST_DEFAULT = 50;
const STARTUP_TOLERANCE_MS = 5_000;
const API = 'runtime-api-v2.schema.json';
const API_V3 = 'runtime-api-v3.schema.json';
const CHAT_WORKFLOW = 'context-chat';

export function canonicalPath(path) {
  const real = realpathSync.native(resolve(path));
  return process.platform === 'win32' ? real.toLowerCase() : real;
}
const within = (child, parent) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
export const scopedId = (loopInstance, iteration, nodeId) => `${loopInstance}/${iteration}/${nodeId}`;

// M2 run lifecycle as a pure table; the scheduler and the decision fixtures share it.
export function m2Transition(state, event) {
  if (TERMINAL_RUN.has(state)) return 'rejected';
  if (event === 'runtime_restart') return 'interrupted';
  if (event === 'root_stop') return 'stopping';
  const table = {
    'running:attempt_failed': 'draining', 'draining:running_finished': 'waiting_for_user', 'running:idle_with_held_work': 'waiting_for_user',
    'running:all_succeeded': 'succeeded', 'waiting_for_user:retry': 'running', 'waiting_for_user:raise_limit': 'running',
    'waiting_for_user:restart_iteration': 'running', 'waiting_for_user:close': 'failed',
  };
  return table[`${state}:${event}`] || 'rejected';
}

export function loopStep({ iteration, maxIterations, continue: again }) {
  if (!again) return 'finish';
  return iteration >= maxIterations ? 'pause_iteration_limit' : 'next';
}

// Selected-alternative join table (PIPELINE_EXECUTION route section).
export function selectedOutcome(states) {
  const active = states.filter(item => item === 'succeeded' || item === 'running' || item === 'failed').length;
  if (active > 1) return 'contract_error';
  if (states.includes('failed')) return 'recovery';
  if (states.includes('pending') || states.includes('running')) return 'wait';
  return active === 1 ? 'commit' : 'inactive';
}

export function routeCase(cases, selected) {
  const matches = cases.filter(item => canonicalize(item.equals) === canonicalize(selected));
  return matches.length > 1 ? { error: 'contract' } : matches.length ? { caseId: matches[0].id } : { caseId: null };
}

export class Engine {
  constructor({ root, adapters = defaultAdapters, processContainment = 'standalone-best-effort', supervisorGeneration = randomUUID(), runtimeInstanceId = randomUUID(), nodeExecutable = process.execPath, bridgeScript = resolve(import.meta.dirname, '../../mcp/bridge.mjs'), externalRunConfirmationOverride = null, maximumAgentTimeoutSeconds = M1_MAXIMUM_TIMEOUT, detectionTtlMs = 30_000, loopMinuteMs = 60_000, supervisor = null } = {}) {
    this.store = new Store(root);
    this.values = valueHelpers(this.store);
    this.adapters = adapters;
    this.processContainment = processContainment;
    this.supervisorGeneration = supervisorGeneration;
    this.runtimeInstanceId = runtimeInstanceId;
    this.nodeExecutable = resolve(nodeExecutable);
    this.bridgeScript = resolve(bridgeScript);
    // The native supervisor is optional: without one, supervision grants are refused and Stop cannot prove termination.
    this.supervisor = supervisor;
    // The runtime's own liveness is reported on its own clock; a hung runtime stops being reported and its runs are stopped.
    if (supervisor) { this.runtimeHeartbeat = setInterval(() => { void Promise.resolve().then(() => supervisor.runtimeAlive()).catch(() => {}); }, 1000); this.runtimeHeartbeat.unref?.(); }
    this.stopRequests = new Map();
    this.dispatchPaused = new Set();
    this.watchdogs = new Map();
    this.awaitingArm = new Set();
    this.emergencyCredentials = new Map();
    this.externalRunConfirmationOverride = externalRunConfirmationOverride;
    this.maximumAgentTimeoutSeconds = maximumAgentTimeoutSeconds;
    this.detectionTtlMs = detectionTtlMs;
    this.loopMinuteMs = loopMinuteMs;
    this.cursorSecret = randomBytes(32);
    this.runs = new Map();        // runId -> in-memory scheduling state for nonterminal runs
    this.processes = new Map();   // attemptId -> live process record
    this.detections = new Map();
    this.locks = new Set();
    this.recoveryBlocked = null;
    this.closing = false;
  }

  get root() { return this.store.root; }
  on(...args) { return this.store.on(...args); }
  off(...args) { return this.store.off(...args); }

  async initialize() {
    this.reconcileIncidentSpool();
    if (!this.store.get('SELECT * FROM application_settings WHERE singleton = 1')) {
      const artifact = this.store.putJson(DEFAULT_SETTINGS);
      this.store.run('INSERT INTO application_settings(singleton, revision, settings_artifact_id, updated_at) VALUES (1, 1, ?, ?)', artifact.artifactId, nowIso());
    }
    if (!this.store.get('SELECT * FROM runtime_identity WHERE singleton = 1'))
      this.store.run('INSERT INTO runtime_identity(singleton, store_id, created_at) VALUES (1, ?, ?)', randomUUID(), nowIso());
    this.store.transaction(() => {
      for (const row of this.store.all("SELECT * FROM workflows WHERE kind = 'user'")) this.syncCacheNodeIncarnations(row.id, this.store.readJson(row.snapshot_artifact_id));
      for (const pin of this.store.all('SELECT * FROM cache_pins WHERE incarnation_id IS NULL')) {
        const current = this.store.get('SELECT incarnation_id FROM cache_node_incarnations WHERE workflow_id = ? AND node_id = ? AND active = 1', pin.workflow_id, pin.node_id);
        const incarnationId = current?.incarnation_id || randomUUID();
        if (!current) this.store.run('INSERT OR IGNORE INTO cache_node_incarnations(workflow_id,node_id,incarnation_id,active,created_at,retired_at) VALUES(?,?,?,0,?,?)', pin.workflow_id, pin.node_id, incarnationId, pin.pinned_at, pin.pinned_at);
        this.store.run('UPDATE cache_pins SET incarnation_id = ? WHERE workflow_id = ? AND node_id = ?', incarnationId, pin.workflow_id, pin.node_id);
      }
    });
    this.expireRunRequests();
    await this.recover();
  }

  // ---------- Restart recovery ----------
  async recover() {
    const open = this.store.all(`SELECT * FROM runs WHERE state IN ${ACTIVE_SQL} ORDER BY created_at`);
    const uncertain = [];
    for (const run of open) {
      for (const attempt of this.store.all(`SELECT * FROM attempts WHERE run_id = ? AND state = 'running' AND process_id IS NOT NULL`, run.id)) {
        if (this.processContainment === 'standalone-best-effort' && isAlive(attempt.process_id)) {
          const started = await processStartTime(attempt.process_id);
          const launched = Date.parse(attempt.process_start_identity?.split('@')[1] || '');
          if (started !== null && Number.isFinite(launched) && Math.abs(started - launched) <= STARTUP_TOLERANCE_MS) {
            await killTree(attempt.process_id);
            if (isAlive(attempt.process_id)) uncertain.push(attempt.process_id);
          }
        }
      }
      this.store.transaction(() => {
        const events = [];
        for (const attempt of this.store.all('SELECT * FROM attempts WHERE run_id = ? ORDER BY rowid', run.id)) {
          const loop = this.store.get('SELECT 1 FROM loop_executions WHERE run_id = ? AND attempt_id = ?', run.id, attempt.id) || this.store.get('SELECT 1 FROM map_executions WHERE run_id = ? AND attempt_id = ?', run.id, attempt.id);
          if (attempt.state === 'running' || (loop && attempt.state === 'waiting')) events.push(...this.attemptTransition(attempt, 'interrupted', 'Runtime restarted while the attempt was active.'));
          else if (UNSTARTED.has(attempt.state)) events.push(...this.attemptTransition(attempt, 'canceled', 'Runtime restarted before the attempt started.'));
        }
        this.store.run(`UPDATE loop_executions SET state = 'interrupted', pause_reason = NULL WHERE run_id = ? AND state IN ('running','paused')`, run.id);
        this.store.run(`UPDATE map_executions SET state = 'interrupted', pause_reason = NULL WHERE run_id = ? AND state IN ('running','paused','finishing')`, run.id);
        this.store.run(`UPDATE loop_iterations SET outcome = 'interrupted', ended_at = ? WHERE run_id = ? AND outcome IN ('running','paused')`, nowIso(), run.id);
        for (const binding of this.store.all(`SELECT b.* FROM context_bindings b JOIN run_context_bindings m ON m.binding_id = b.id WHERE m.run_id = ? AND b.state = 'writing'`, run.id))
          events.push(this.bindingTransition(binding, 'needs_review', 'Runtime restarted during a native write; native history may have advanced.')[0]);
        events.push(this.runEvent(run, 'interrupted', 'Runtime restarted or lost process supervision.'));
        this.store.appendEvents(run.id, events);
      });
    }
    this.store.run('DELETE FROM resource_locks');
    this.recoveryBlocked = uncertain.length ? `Owned processes could not be confirmed terminated: ${uncertain.join(', ')}. Close them, then restart the runtime.` : null;
  }

  // ---------- Capabilities and settings ----------
  async detect(provider, { fresh = false } = {}) {
    const cached = this.detections.get(provider);
    if (!fresh && cached && Date.now() - cached.at < this.detectionTtlMs) return cached.value;
    const value = await this.adapters.detect(provider);
    this.detections.set(provider, { at: Date.now(), value });
    return value;
  }

  async capabilities() {
    const providers = await Promise.all(PROVIDERS.map(provider => this.detect(provider, { fresh: true })));
    const body = {
      schemaVersion: 1, engineCapabilities: ['core-v1', 'loops-v1', 'cache-v1', 'pipeline-v1', 'delivery-v1', 'revisions-v1'],
      providers: providers.map(p => ({ provider: p.provider, available: p.available, cliVersion: p.cliVersion, supportsNew: p.supportsNew, supportsResume: p.supportsResume, supportsJson: p.supportsJson, supportsInheritedConfiguration: p.supportsInheritedConfiguration, reason: p.reason })),
      maximumAgentTimeoutSeconds: this.maximumAgentTimeoutSeconds, processContainment: this.processContainment,
    };
    assertValid(API, 'capabilities', body);
    if (capabilityIssues(body).length) throw new Error('Capabilities must contain each provider exactly once.');
    return body;
  }

  currentSettings() {
    const row = this.store.get('SELECT * FROM application_settings WHERE singleton = 1');
    const settings = this.store.readJson(row.settings_artifact_id);
    if (settings.externalRunConfirmation === undefined) settings.externalRunConfirmation = true;
    if (this.externalRunConfirmationOverride !== null) settings.externalRunConfirmation = this.externalRunConfirmationOverride;
    const digest = this.externalRunConfirmationOverride === null
      ? this.store.artifactRow(row.settings_artifact_id).sha256
      : canonicalHash(settings);
    return { revision: row.revision, sha256: digest, settings, artifactId: row.settings_artifact_id };
  }
  settingsBody() { const { revision, sha256: digest, settings } = this.currentSettings(); return { revision, sha256: digest, settings }; }

  updateSettings(body) {
    this.validateBody('updateApplicationSettings', body);
    return this.idempotent('PUT /settings', body.requestId, body, () => {
      const current = this.currentSettings();
      if (body.expectedRevision !== current.revision) throw new ApiError(409, 'conflict', `Settings revision is ${current.revision}, not ${body.expectedRevision}.`);
      return this.store.transaction(() => {
        const artifact = this.store.putJson(body.settings);
        const revision = current.revision + 1;
        this.store.run('UPDATE application_settings SET revision = ?, settings_artifact_id = ?, updated_at = ? WHERE singleton = 1', revision, artifact.artifactId, nowIso());
        for (const run of this.store.all(`SELECT id FROM runs WHERE state IN ${ACTIVE_SQL}`))
          this.store.appendEvents(run.id, [{ type: 'run.capacity_changed', payload: { revision, settings: ref(artifact) } }]);
        return { status: 200, body: this.settingsBody() };
      });
    }, () => queueMicrotask(() => this.pump()));
  }

  // ---------- Generic helpers ----------
  validateBody(definition, body) {
    const issues = check(API, definition, body);
    if (issues.length) throw new ApiError(400, 'invalid_request', `Request does not match ${definition}.`, issues);
  }

  idempotent(command, requestId, payload, fn, after) {
    const digest = canonicalHash({ command, payload });
    const result = this.store.transaction(() => {
      const receipt = this.store.get('SELECT * FROM command_receipts WHERE request_id = ?', requestId);
      if (receipt) {
        if (receipt.payload_sha256 !== digest || receipt.command !== command) throw new ApiError(409, 'conflict', 'This requestId was already used for a different command or payload.');
        return { response: this.store.readJson(receipt.response_artifact_id), isNew: false };
      }
      const response = fn();
      const artifact = this.store.putJson(response);
      this.store.run('INSERT INTO command_receipts(request_id, command, payload_sha256, response_artifact_id, created_at) VALUES (?, ?, ?, ?, ?)', requestId, command, digest, artifact.artifactId, nowIso());
      return { response, isNew: true };
    });
    if (result.isNew) after?.();
    return result.response;
  }

  encodeCursor(data) {
    const body = Buffer.from(canonicalize(data)).toString('base64url');
    return `${body}.${createHmac('sha256', this.cursorSecret).update(body).digest('base64url')}`;
  }
  decodeCursor(cursor, collection, filters) {
    const [body, mac] = String(cursor).split('.');
    if (!body || !mac || createHmac('sha256', this.cursorSecret).update(body).digest('base64url') !== mac) throw new ApiError(400, 'invalid_request', 'The cursor is malformed or was issued by another runtime.');
    const data = parseStrictJson(Buffer.from(body, 'base64url').toString('utf8'));
    if (data.collection !== collection || canonicalize(data.filters) !== canonicalize(filters)) throw new ApiError(400, 'invalid_request', 'The cursor does not match this collection or filter.');
    return data;
  }

  // Seek pagination: newest first, fenced at the first page so later inserts never shift pages.
  page({ collection, table, filters, where = [], params = [], limit = LIST_DEFAULT, cursor, map }) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiError(400, 'invalid_request', 'limit must be between 1 and 200.');
    const clauses = [...where], bound = [...params];
    let fence = null;
    if (cursor) {
      const data = this.decodeCursor(cursor, collection, filters);
      fence = data.fence;
      clauses.push('(created_at < ? OR (created_at = ? AND id < ?))'); bound.push(data.last[0], data.last[0], data.last[1]);
      clauses.push('(created_at < ? OR (created_at = ? AND id <= ?))'); bound.push(fence[0], fence[0], fence[1]);
    }
    const sql = `SELECT * FROM ${table}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`;
    const rows = this.store.db.prepare(sql).all(...bound, limit + 1);
    const items = rows.slice(0, limit);
    if (!fence && items.length) fence = [items[0].created_at, items[0].id];
    const last = items.at(-1);
    return { items: items.map(map), nextCursor: rows.length > limit ? this.encodeCursor({ collection, filters, fence, last: [last.created_at, last.id] }) : null };
  }

  // ---------- Workspaces ----------
  workspaceBody(row) { return { workspaceId: row.id, cwd: row.cwd, cwdIdentity: row.cwd_identity, createdAt: row.created_at, updatedAt: row.updated_at }; }

  putWorkspace(workspaceId, body) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(workspaceId)) throw new ApiError(400, 'invalid_request', 'Workspace ID must match the workflow ID grammar.');
    this.validateBody('workspaceRequest', body);
    const scratch = canonicalPath(join(this.store.workdirs, 'scratch'));
    const requested = resolve(body.cwd);
    if (!existsSync(requested) && within(process.platform === 'win32' ? requested.toLowerCase() : requested, scratch)) mkdirSync(requested, { recursive: true });
    if (!existsSync(requested) || !statSync(requested).isDirectory()) throw new ApiError(422, 'validation_failed', 'The workspace directory must exist.');
    const canonical = canonicalPath(requested);
    this.assertNoAuthoringDirectoryConflict(canonical);
    const store = canonicalPath(this.store.storeDir);
    if (within(canonical, store) || within(store, canonical)) throw new ApiError(422, 'validation_failed', 'The workspace directory may not contain or be inside the trusted store.');
    const identity = sha256(Buffer.from(canonical, 'utf8'));
    const existing = this.store.get('SELECT * FROM workspaces WHERE id = ?', workspaceId);
    const now = nowIso();
    if (existing) {
      if (existing.cwd_identity !== identity && this.activeRun(workspaceId)) throw new ApiError(409, 'conflict', 'A run is active in this workspace; it cannot be rebound now.');
      this.store.run('UPDATE workspaces SET cwd = ?, cwd_identity = ?, updated_at = ? WHERE id = ?', requested, identity, now, workspaceId);
    } else {
      this.store.run('INSERT INTO workspaces(id, cwd, cwd_identity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', workspaceId, requested, identity, now, now);
    }
    return this.workspaceBody(this.store.get('SELECT * FROM workspaces WHERE id = ?', workspaceId));
  }

  assertNoAuthoringDirectoryConflict(workspaceRoot) {
    const activeSince = new Date(Date.now() - 90_000).toISOString();
    for (const bridge of this.store.all("SELECT working_directory, mcp_config_path FROM bridge_registrations WHERE client_provider = 'antigravity' AND last_seen_at >= ?", activeSince)) {
      for (const candidate of [bridge.working_directory, bridge.mcp_config_path].filter(Boolean)) {
        const path = canonicalPath(candidate);
        if (within(path, workspaceRoot) || within(workspaceRoot, path))
          throw new ApiError(422, 'authoring_directory_conflict', 'The workspace root overlaps a connected Antigravity authoring directory or MCP config path.');
      }
    }
  }

  listWorkspaces({ limit, cursor } = {}) {
    return this.page({ collection: 'workspaces', table: 'workspaces', filters: {}, limit, cursor, map: row => this.workspaceBody(row) });
  }

  requireWorkspace(id) {
    const row = this.store.get('SELECT * FROM workspaces WHERE id = ?', id);
    if (!row) throw new ApiError(404, 'not_found', `Workspace "${id}" does not exist.`);
    return row;
  }
  activeRun(workspaceId) { return this.store.get(`SELECT id, state FROM runs WHERE workspace_id = ? AND state IN ${ACTIVE_SQL}`, workspaceId); }

  // ---------- Workflows ----------
  validateWorkflow(workflow) {
    const structural = structuralIssues(workflow);
    if (structural.length) return { valid: false, issues: structural };
    const issues = semanticIssues(workflow, { maximumAgentTimeoutSeconds: this.maximumAgentTimeoutSeconds }).map(({ path, message }) => ({ path, message }));
    return { valid: issues.length === 0, issues };
  }

  savedWorkflow(row) {
    const workflow = this.store.readJson(row.snapshot_artifact_id);
    const { view, ...definition } = workflow;
    return { workflow, snapshotSha256: this.store.artifactRow(row.snapshot_artifact_id).sha256, executionHash: canonicalHash(definition), validation: this.validateWorkflow(workflow) };
  }

  runtimeIdentity() {
    const identity = this.store.get('SELECT store_id FROM runtime_identity WHERE singleton = 1');
    return { storeId: identity.store_id, runtimeInstanceId: this.runtimeInstanceId, applicationRoot: canonicalPath(this.root), nodeExecutable: this.nodeExecutable };
  }

  authoringContract() {
    const identity = this.runtimeIdentity();
    const workflowSchema = SCHEMAS['workflow.schema.json'];
    return {
      descriptorVersion: 1, contractVersion: '3.0', apiVersions: ['v2', 'v3'], ...identity,
      workflowSchemaId: 'workflow.schema.json', workflowSchemaSha256: sha256(canonicalBytes(workflowSchema)),
      capabilities: ['core-v1', 'loops-v1', 'cache-v1', 'pipeline-v1', 'delivery-v1', 'revisions-v1'],
      limits: { maxRequestBytes: 4 * 1024 * 1024, maxResponseBytes: 4 * 1024 * 1024, maxPageSize: 200, maxEventPageSize: 200 },
    };
  }

  authoringSchema(schemaId) {
    const schema = SCHEMAS[schemaId];
    if (!schema || !/^[a-z0-9-]+\.schema\.json$/.test(schemaId)) throw new ApiError(404, 'not_found', `Schema "${schemaId}" is not published by this runtime.`);
    const references = new Set();
    const visit = value => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (!value || typeof value !== 'object') return;
      if (typeof value.$ref === 'string' && !value.$ref.startsWith('#')) references.add(value.$ref.split('#')[0].split('/').at(-1));
      for (const child of Object.values(value)) visit(child);
    };
    visit(schema);
    return { schemaId, version: 1, sha256: sha256(canonicalBytes(schema)), schema, dependencies: [...references].sort() };
  }

  authoringNodeTypes() {
    const definitions = {
      text: 'textNode', 'prompt-template': 'promptTemplateNode', agent: 'agentNode', context: 'contextNode',
      'result-viewer': 'resultViewerNode', 'file-input': 'fileInputNode', merge: 'mergeNode', 'json-select': 'jsonSelectNode',
      condition: 'conditionNode', loop: 'loopNode', cache: 'cacheNode', route: 'routeNode', gate: 'gateNode', map: 'mapNode',
    };
    return { schemaId: 'workflow.schema.json', types: Object.entries(definitions).map(([type, definition]) => ({
      type, schemaRef: `workflow.schema.json#/$defs/${definition}`, configurationDependentPorts: true,
      portRules: 'Ports are derived from the node configuration by the same validator used for workflow saves and validation.',
    })) };
  }

  authoringTemplates() {
    return [
      { templateId: 'empty', version: 1, title: 'Empty workflow', requiredCapabilities: ['core-v1'], placeholders: ['workflowId'] },
      { templateId: 'context-chain', version: 1, title: 'Context chain', requiredCapabilities: ['core-v1'], placeholders: ['workflowId', 'codexModel', 'claudeModel'] },
      { templateId: 'delivery-loop', version: 1, title: 'Delivery Loop reference', requiredCapabilities: ['core-v1', 'loops-v1', 'pipeline-v1', 'delivery-v1'], placeholders: ['workflowId', 'modelIds'] },
    ];
  }

  authoringTemplate(templateId) {
    const metadata = this.authoringTemplates().find(item => item.templateId === templateId);
    if (!metadata) throw new ApiError(404, 'not_found', `Template "${templateId}" is not published by this runtime.`);
    let workflow;
    if (templateId === 'empty') {
      workflow = { schemaVersion: 1, workflowId: 'replace-with-workflow-id', capabilities: ['core-v1'], settings: { nativeConfiguration: 'restricted' },
        nodes: [
          { id: 'request', type: 'text', config: { value: 'Replace this with the requested workflow input.' } },
          { id: 'result', type: 'result-viewer', config: {} },
        ], edges: [{ id: 'request-text-result', source: { nodeId: 'request', port: 'text' }, target: { nodeId: 'result', port: 'value' } }], after: [] };
    } else {
      workflow = structuredClone(templateId === 'context-chain' ? contextChainExample : deliveryExample);
      workflow.workflowId = 'replace-with-workflow-id';
      for (const node of allNodesDeep(workflow.nodes)) {
        if (node.type === 'agent') { node.config.model = `replace-with-${node.config.provider}-model-id`; node.config.effort ??= DEFAULT_EFFORT; }
        if (node.type === 'map') for (const role of node.config.roles) if (role.kind === 'agent') { role.model = `replace-with-${role.provider}-model-id`; role.effort ??= DEFAULT_EFFORT; }
      }
    }
    return { ...metadata, workflow, notes: 'This is an example. Replace every explicit placeholder with a user-selected value, then discover, validate, and save it through this runtime.' };
  }

  registerBridge(body) {
    if (!body || typeof body.bridgeId !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(body.bridgeId) || !['codex', 'claude', 'antigravity', 'other'].includes(body.clientProvider))
      throw new ApiError(400, 'invalid_request', 'A bridge handshake requires a UUID bridgeId and a supported clientProvider.');
    let workingDirectory = null, mcpConfigPath = null;
    if (body.clientProvider === 'antigravity') {
      if (typeof body.workingDirectory !== 'string' || typeof body.mcpConfigPath !== 'string')
        throw new ApiError(422, 'authoring_directory_conflict', 'Antigravity bridge registration requires its working directory and resolved MCP config path.');
      try {
        workingDirectory = canonicalPath(body.workingDirectory);
        mcpConfigPath = canonicalPath(body.mcpConfigPath);
        if (!statSync(workingDirectory).isDirectory() || !statSync(mcpConfigPath).isFile()) throw new Error('Path type mismatch');
      } catch {
        throw new ApiError(422, 'authoring_directory_conflict', 'Antigravity bridge paths must be absolute, resolvable, and identify an existing directory and config file.');
      }
      const roots = this.store.all('SELECT cwd FROM workspaces');
      for (const workspace of roots) {
        const root = canonicalPath(workspace.cwd);
        if ([workingDirectory, mcpConfigPath].some(path => within(path, root) || within(root, path)))
          throw new ApiError(422, 'authoring_directory_conflict', 'The Antigravity authoring directory or config path overlaps a registered workspace.');
      }
      const taskRootPath = join(canonicalPath(this.store.workdirs), 'tasks');
      const taskRoot = existsSync(taskRootPath) ? canonicalPath(taskRootPath) : taskRootPath;
      if ([workingDirectory, mcpConfigPath].some(path => within(path, taskRoot) || within(taskRoot, path)))
        throw new ApiError(422, 'authoring_directory_conflict', 'The Antigravity authoring directory or config path overlaps the runtime-managed copied Map task area.');
    }
    const activeSince = new Date(Date.now() - 90_000).toISOString();
    this.store.run('DELETE FROM bridge_registrations WHERE last_seen_at < ?', activeSince);
    this.store.run(`INSERT INTO bridge_registrations(bridge_id,client_provider,working_directory,mcp_config_path,isolation_mechanism,last_seen_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(bridge_id) DO UPDATE SET client_provider=excluded.client_provider,working_directory=excluded.working_directory,
      mcp_config_path=excluded.mcp_config_path,isolation_mechanism=excluded.isolation_mechanism,last_seen_at=excluded.last_seen_at`,
    body.bridgeId, body.clientProvider, workingDirectory, mcpConfigPath, typeof body.isolationMechanism === 'string' ? body.isolationMechanism.slice(0, 120) : null, nowIso());
    return { bridgeId: body.bridgeId, clientProvider: body.clientProvider, workingDirectory, mcpConfigPath, ...this.runtimeIdentity() };
  }

  unregisterBridge(bridgeId) { this.store.run('DELETE FROM bridge_registrations WHERE bridge_id = ?', bridgeId); }

  workflowEtag(row, sha256 = this.store.artifactRow(row.snapshot_artifact_id).sha256) { return `"wf-${row.revision}-${sha256}"`; }

  savedWorkflowV3(row) {
    const saved = this.savedWorkflow(row);
    return { ...saved, revision: row.revision, etag: this.workflowEtag(row, saved.snapshotSha256) };
  }

  getWorkflowV3(workflowId) {
    const row = this.store.get("SELECT * FROM workflows WHERE id = ? AND kind = 'user'", workflowId);
    if (!row) throw new ApiError(404, 'not_found', `Workflow "${workflowId}" does not exist.`);
    return this.savedWorkflowV3(row);
  }

  listWorkflowsV3({ limit, cursor } = {}) {
    return this.page({ collection: 'workflows-v3', table: 'workflows', filters: {}, where: ["kind = 'user'"], limit, cursor, map: row => {
      const saved = this.savedWorkflow(row);
      return { workflowId: row.id, revision: row.revision, snapshotSha256: saved.snapshotSha256, executionHash: saved.executionHash, createdAt: row.created_at, updatedAt: row.updated_at };
    } });
  }

  syncCacheNodeIncarnations(workflowId, workflow) {
    const cacheNodes = new Set(allNodesDeep(workflow.nodes).filter(node => node.type === 'cache').map(node => node.id));
    const active = this.store.all('SELECT node_id, incarnation_id FROM cache_node_incarnations WHERE workflow_id = ? AND active = 1', workflowId);
    for (const row of active) if (!cacheNodes.has(row.node_id))
      this.store.run('UPDATE cache_node_incarnations SET active = 0, retired_at = ? WHERE workflow_id = ? AND node_id = ? AND incarnation_id = ?', nowIso(), workflowId, row.node_id, row.incarnation_id);
    for (const nodeId of cacheNodes) {
      const row = this.store.get('SELECT incarnation_id FROM cache_node_incarnations WHERE workflow_id = ? AND node_id = ? AND active = 1', workflowId, nodeId);
      if (!row) this.store.run('INSERT INTO cache_node_incarnations(workflow_id,node_id,incarnation_id,active,created_at) VALUES(?,?,?,1,?)', workflowId, nodeId, randomUUID(), nowIso());
    }
  }

  saveWorkflowV3(workflowId, body) {
    if (!body || !Object.hasOwn(body, 'expectedEtag') || body.expectedEtag === undefined)
      throw new ApiError(428, 'precondition_required', 'Supply expectedEtag from a workflow read, or null for create-only.');
    const issues = check(API_V3, 'saveWorkflow', body);
    if (issues.length) throw new ApiError(400, 'invalid_request', 'Request does not match saveWorkflow.', issues);
    const workflow = body.workflow;
    if (workflow.workflowId !== workflowId) throw new ApiError(400, 'invalid_request', 'workflowId in the body must match the path.');
    const structural = structuralIssues(workflow);
    if (structural.length) throw new ApiError(422, 'validation_failed', 'The workflow does not match workflow.schema.json.', structural);
    const expectedEtag = body.expectedEtag;
    const payload = { workflowId, expectedEtag, workflow };
    return this.idempotent(`PUT /api/v3/workflows/${workflowId}`, body.requestId, payload, () => {
      const existing = this.store.get('SELECT * FROM workflows WHERE id = ?', workflowId);
      if (existing?.kind === 'system') throw new ApiError(409, 'conflict', `Workflow ID "${workflowId}" is reserved.`);
      if (expectedEtag === null) {
        if (existing) throw new ApiError(412, 'precondition_failed', 'A workflow with this ID already exists.', [{ path: '/expectedEtag', message: `Current ETag is ${this.workflowEtag(existing)}.` }]);
      } else {
        if (expectedEtag === undefined) throw new ApiError(428, 'precondition_required', 'Supply expectedEtag from a workflow read, or null for create-only.');
        if (!existing || this.workflowEtag(existing) !== expectedEtag)
          throw new ApiError(412, 'precondition_failed', existing ? `The workflow changed; current revision is ${existing.revision}.` : 'The workflow no longer exists.', existing ? [{ path: '/expectedEtag', message: `Current ETag is ${this.workflowEtag(existing)}.` }] : []);
      }
      const artifact = this.store.putBytes(canonicalBytes(workflow), 'application/json');
      const now = nowIso();
      const revision = existing ? existing.revision + 1 : 1;
      if (existing) this.store.run('UPDATE workflows SET snapshot_artifact_id = ?, revision = ?, updated_at = ? WHERE id = ?', artifact.artifactId, revision, now, workflowId);
      else this.store.run('INSERT INTO workflows(id,snapshot_artifact_id,created_at,updated_at,kind,revision) VALUES(?,?,?,? ,\'user\',?)', workflowId, artifact.artifactId, now, now, revision);
      this.syncCacheNodeIncarnations(workflowId, workflow);
      const eventId = randomUUID();
      this.store.run('INSERT INTO workflow_changes(event_id,workflow_id,revision,snapshot_sha256,request_id,created_at) VALUES(?,?,?,?,?,?)', eventId, workflowId, revision, artifact.sha256, body.requestId, now);
      return this.savedWorkflowV3(this.store.get('SELECT * FROM workflows WHERE id = ?', workflowId));
    }, () => {
      const row = this.store.get('SELECT * FROM workflow_changes WHERE request_id = ?', body.requestId);
      if (row) queueMicrotask(() => this.store.emit('workflow-change', this.workflowChangeBody(row)));
    });
  }

  workflowChangeBody(row) {
    return { sequence: row.sequence, eventId: row.event_id, workflowId: row.workflow_id, revision: row.revision, snapshotSha256: row.snapshot_sha256, requestId: row.request_id, createdAt: row.created_at };
  }

  workflowChanges({ after = 0, limit = 100 } = {}) {
    if (!Number.isInteger(after) || after < 0) throw new ApiError(400, 'invalid_request', 'after must be a nonnegative integer.');
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiError(400, 'invalid_request', 'limit must be between 1 and 200.');
    const bounds = this.store.get('SELECT MIN(sequence) AS first, MAX(sequence) AS last FROM workflow_changes');
    const latest = bounds.last || 0;
    if (after > latest) throw new ApiError(409, 'conflict', 'The workflow-change cursor is beyond the latest committed event.');
    if (bounds.first && after < bounds.first - 1) return { items: [], nextCursor: null, cursor: latest, resyncRequired: true };
    const rows = this.store.all('SELECT * FROM workflow_changes WHERE sequence > ? ORDER BY sequence LIMIT ?', after, limit + 1);
    const items = rows.slice(0, limit).map(row => this.workflowChangeBody(row));
    return { items, nextCursor: rows.length > limit ? items.at(-1).sequence : null, cursor: latest, resyncRequired: false };
  }

  putWorkflow(workflowId, text, { kind = 'user' } = {}) {
    // Only the internal Context chat uses this unversioned system snapshot path.
    if (kind !== 'system' || workflowId !== CHAT_WORKFLOW)
      throw new ApiError(428, 'precondition_required', 'User workflows require a v3 request ID and an explicit save precondition.');
    let workflow;
    try { workflow = typeof text === 'string' ? parseStrictJson(text) : text; }
    catch (error) { throw new ApiError(400, 'invalid_request', error.message); }
    const structural = structuralIssues(workflow);
    if (structural.length) throw new ApiError(422, 'validation_failed', 'The workflow does not match workflow.schema.json.', structural);
    if (workflow.workflowId !== workflowId) throw new ApiError(400, 'invalid_request', 'workflowId in the body must match the path.');
    const existing = this.store.get('SELECT * FROM workflows WHERE id = ?', workflowId);
    if ((existing?.kind || (workflowId === CHAT_WORKFLOW ? 'system' : 'user')) !== kind) throw new ApiError(409, 'conflict', `Workflow ID "${workflowId}" is reserved.`);
    const artifact = this.store.putBytes(canonicalBytes(workflow), 'application/json');
    const now = nowIso();
    if (existing) this.store.run('UPDATE workflows SET snapshot_artifact_id = ?, updated_at = ? WHERE id = ?', artifact.artifactId, now, workflowId);
    else this.store.run('INSERT INTO workflows(id, snapshot_artifact_id, created_at, updated_at, kind) VALUES (?, ?, ?, ?, ?)', workflowId, artifact.artifactId, now, now, kind);
    return this.savedWorkflow(this.store.get('SELECT * FROM workflows WHERE id = ?', workflowId));
  }

  getWorkflow(workflowId) {
    const row = this.store.get(`SELECT * FROM workflows WHERE id = ? AND kind = 'user'`, workflowId);
    if (!row) throw new ApiError(404, 'not_found', `Workflow "${workflowId}" does not exist.`);
    return this.savedWorkflow(row);
  }

  listWorkflows({ limit, cursor } = {}) {
    return this.page({ collection: 'workflows', table: 'workflows', filters: {}, where: [`kind = 'user'`], limit, cursor, map: row => {
      const saved = this.savedWorkflow(row);
      return { workflowId: row.id, snapshotSha256: saved.snapshotSha256, executionHash: saved.executionHash, createdAt: row.created_at, updatedAt: row.updated_at };
    } });
  }

  // ---------- Cache pins ----------
  pinsFor(workflowId) {
    return Object.fromEntries(this.store.all(`SELECT p.* FROM cache_pins p JOIN cache_node_incarnations c
      ON c.workflow_id = p.workflow_id AND c.node_id = p.node_id AND c.incarnation_id = p.incarnation_id AND c.active = 1
      WHERE p.workflow_id = ?`, workflowId)
      .map(row => [row.node_id, { value: parseStrictJson(row.value_json), sourceRunId: row.source_run_id, sourceAttemptId: row.source_attempt_id, fingerprint: row.fingerprint, pinnedAt: row.pinned_at, incarnationId: row.incarnation_id }]));
  }

  listPins(workflowId) {
    const saved = this.getWorkflow(workflowId);
    const current = this.cacheFingerprints(saved.workflow, this.pinsFor(workflowId));
    const active = this.pinsFor(workflowId);
    const rows = this.store.all('SELECT * FROM cache_pins WHERE workflow_id = ?', workflowId);
    return { pins: rows.map(row => {
      const pin = active[row.node_id] || { value: parseStrictJson(row.value_json), sourceRunId: row.source_run_id, sourceAttemptId: row.source_attempt_id, fingerprint: row.fingerprint, pinnedAt: row.pinned_at };
      const orphaned = !active[row.node_id];
      return { nodeId: row.node_id, value: pin.value, sourceRunId: pin.sourceRunId, sourceAttemptId: pin.sourceAttemptId,
        fingerprint: pin.fingerprint, sourceChanged: orphaned || current[row.node_id] !== pin.fingerprint, orphaned, pinnedAt: pin.pinnedAt };
    }) };
  }

  // Fingerprint of each Cache's producer side, used to report a changed source.
  cacheFingerprints(workflow, pins) {
    const result = {};
    const visit = graph => {
      const prints = fingerprints(graph, pins);
      for (const node of graph.nodes) {
        if (node.type === 'cache') { const edge = graph.edges.find(item => item.target.nodeId === node.id); result[node.id] = edge && edge.source.nodeId !== INPUT ? prints[edge.source.nodeId] : canonicalHash({ boundary: edge?.source.port }); }
        if (node.type === 'loop') visit(node.config.body);
      }
    };
    visit(workflow);
    return result;
  }

  freezeCache(workflowId, nodeId, body) {
    this.validateBody('freezeCacheRequest', body);
    const saved = this.getWorkflow(workflowId);
    const node = allNodesDeep(saved.workflow.nodes).find(item => item.id === nodeId);
    if (node?.type !== 'cache') throw new ApiError(404, 'not_found', `"${nodeId}" is not a Cache node of "${workflowId}".`);
    const run = this.requireRun(body.runId);
    if (run.workflow_id !== workflowId) throw new ApiError(409, 'conflict', 'The run belongs to another workflow.');
    if (body.nodeInstanceId !== nodeId) throw new ApiError(409, 'conflict', 'Pin an outer Cache instance (scoped body instances are pinned from their node ID).');
    const attempt = this.latestAttempt(run.id, body.nodeInstanceId);
    if (!attempt || attempt.state !== 'succeeded' || !attempt.outputs_artifact_id) throw new ApiError(409, 'conflict', 'Only a succeeded Cache attempt can be pinned.');
    const value = this.store.readJson(attempt.outputs_artifact_id).values.value;
    this.storePin(saved.workflow, nodeId, value, run.id, attempt.id);
    return this.listPins(workflowId);
  }

  storePin(workflow, nodeId, value, runId, attemptId) {
    this.syncCacheNodeIncarnations(workflow.workflowId, workflow);
    const incarnation = this.store.get('SELECT incarnation_id FROM cache_node_incarnations WHERE workflow_id = ? AND node_id = ? AND active = 1', workflow.workflowId, nodeId);
    if (!incarnation) throw new ApiError(409, 'conflict', `Cache node "${nodeId}" has no active identity.`);
    const pins = { ...this.pinsFor(workflow.workflowId), [nodeId]: { value } };
    const fingerprint = this.cacheFingerprints(workflow, pins)[nodeId];
    this.store.run(`INSERT INTO cache_pins(workflow_id, node_id, value_json, source_run_id, source_attempt_id, fingerprint, pinned_at, incarnation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workflow_id, node_id) DO UPDATE SET value_json = excluded.value_json, source_run_id = excluded.source_run_id, source_attempt_id = excluded.source_attempt_id, fingerprint = excluded.fingerprint, pinned_at = excluded.pinned_at, incarnation_id = excluded.incarnation_id`,
    workflow.workflowId, nodeId, canonicalize(value), runId, attemptId, fingerprint, nowIso(), incarnation.incarnation_id);
  }

  deleteCachePin(workflowId, nodeId) {
    this.getWorkflow(workflowId);
    this.store.run('DELETE FROM cache_pins WHERE workflow_id = ? AND node_id = ?', workflowId, nodeId);
    return this.listPins(workflowId);
  }

  // ---------- Context bindings ----------
  bindingRecord(row) { return this.store.readJson(row.binding_artifact_id); }
  bindingBody(row) {
    const record = this.bindingRecord(row);
    return { bindingId: row.id, provider: row.provider, workspaceId: row.workspace_id, state: row.state, model: record.model ?? null, configurationHash: row.configuration_hash, bindingSha256: this.store.artifactRow(row.binding_artifact_id).sha256 };
  }

  listBindings(workspaceId) {
    this.requireWorkspace(workspaceId);
    return { bindings: this.store.all('SELECT * FROM context_bindings WHERE workspace_id = ? ORDER BY updated_at DESC', workspaceId).map(row => this.bindingBody(row)) };
  }

  writeBinding(row, changes) {
    const record = { ...this.bindingRecord(row), ...changes, schemaVersion: 1, bindingId: row.id };
    const artifact = this.store.putJson(record);
    const nativeHash = record.nativeSessionId ? sha256(Buffer.from(`${row.provider}:${record.nativeSessionId}`)) : null;
    this.store.run(`UPDATE context_bindings SET state = ?, binding_artifact_id = ?, native_session_hash = ?, account_identity = ?, configuration_hash = ?, updated_at = ? WHERE id = ?`,
      record.state, artifact.artifactId, nativeHash, record.accountIdentity, record.configurationHash, nowIso(), row.id);
    return this.store.get('SELECT * FROM context_bindings WHERE id = ?', row.id);
  }

  createBinding(runId, workspace, provider, contextNodeId, createdAt = nowIso()) {
    const bindingId = randomUUID();
    const record = { schemaVersion: 1, bindingId, provider, workspaceId: workspace.id, cwdIdentity: workspace.cwd_identity, state: 'unbound',
      accountIdentity: 'pending', configurationHash: '0'.repeat(64), nativeSessionId: null, model: null, origin: { runId, contextNodeId } };
    const artifact = this.store.putJson(record);
    this.store.run(`INSERT INTO context_bindings(id, provider, workspace_id, account_identity, cwd_identity, configuration_hash, native_session_hash, binding_artifact_id, state, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, NULL, ?, 'unbound', ?)`,
      bindingId, provider, workspace.id, workspace.cwd_identity, record.configurationHash, artifact.artifactId, createdAt);
    return bindingId;
  }

  acknowledgeBinding(bindingId, body) {
    this.validateBody('acknowledgeContext', body);
    return this.idempotent(`POST /context-bindings/${bindingId}/acknowledge`, body.requestId, body, () => this.store.transaction(() => {
      const row = this.store.get('SELECT * FROM context_bindings WHERE id = ?', bindingId);
      if (!row) throw new ApiError(404, 'not_found', 'Unknown Context binding.');
      if (this.locks.has(`binding:${bindingId}`) || row.state === 'writing') throw new ApiError(409, 'conflict', 'The binding has an active writer.');
      if (this.store.artifactRow(row.binding_artifact_id).sha256 !== body.observedBindingSha256) throw new ApiError(409, 'conflict', 'The binding changed since it was observed.');
      if (row.state === 'unavailable') throw new ApiError(409, 'context_unavailable', 'An unavailable session cannot be made available by acknowledgement.');
      if (row.state !== 'needs_review') throw new ApiError(409, 'conflict', `Only needs_review bindings can be acknowledged (state is ${row.state}).`);
      const to = this.bindingRecord(row).nativeSessionId ? 'ready' : 'unbound';
      return this.bindingBody(this.writeBinding(row, { state: to, acknowledgedAt: nowIso(), acknowledgedFrom: body.observedBindingSha256 }));
    }));
  }

  // Manual Context chat: a run of kind "chat" over a generated core-v1 workflow.
  sendChat(bindingId, body) {
    this.validateBody('chatRequest', body);
    return this.idempotent(`POST /context-bindings/${bindingId}/messages`, body.requestId, body, () => {
      const binding = this.store.get('SELECT * FROM context_bindings WHERE id = ?', bindingId);
      if (!binding) throw new ApiError(404, 'not_found', 'Unknown Context binding.');
      if (binding.workspace_id !== body.workspaceId) throw new ApiError(409, 'conflict', 'The binding belongs to another workspace.');
      if (binding.state !== 'ready' || !this.bindingRecord(binding).nativeSessionId) throw new ApiError(422, 'context_unavailable', `Chat needs a ready binding with a native session (state is ${binding.state}).`);
      const workflow = {
        schemaVersion: 1, workflowId: CHAT_WORKFLOW, capabilities: ['core-v1'], settings: { nativeConfiguration: 'restricted' },
        nodes: [
          { id: 'message', type: 'text', config: { value: body.prompt } },
          { id: 'conversation', type: 'context', config: { provider: binding.provider, mode: 'continue', bindingId } },
          { id: 'reply', type: 'agent', config: { provider: binding.provider, model: body.model, effort: resolveEffort(body.effort), contextId: 'conversation', timeoutSeconds: body.timeoutSeconds ?? 600, output: { format: 'text' } } },
          { id: 'transcript', type: 'result-viewer', config: {} },
        ],
        edges: [
          { id: 'message-reply', source: { nodeId: 'message', port: 'text' }, target: { nodeId: 'reply', port: 'prompt' } },
          { id: 'reply-transcript', source: { nodeId: 'reply', port: 'text' }, target: { nodeId: 'transcript', port: 'value' } },
        ],
        after: [],
      };
      const saved = this.putWorkflow(CHAT_WORKFLOW, workflow, { kind: 'system' });
      const snapshot = this.store.artifactRow(this.store.get('SELECT snapshot_artifact_id FROM workflows WHERE id = ?', CHAT_WORKFLOW).snapshot_artifact_id);
      if (snapshot.sha256 !== saved.snapshotSha256) throw new Error('Chat snapshot mismatch.');
      return this.captureRun({ workflow, snapshot, workspace: this.requireWorkspace(body.workspaceId), kind: 'chat', options: {}, requestId: body.requestId });
    }, () => queueMicrotask(() => this.startRun()));
  }

  // ---------- Run queries ----------
  runBody(row) {
    return { runId: row.id, workflowId: row.workflow_id, workflowSnapshot: { artifactId: row.workflow_snapshot_artifact_id, sha256: this.store.artifactRow(row.workflow_snapshot_artifact_id).sha256 },
      executionHash: row.execution_hash, state: row.state, lastSequence: row.last_sequence, createdAt: row.created_at, workspaceId: row.workspace_id, kind: row.kind };
  }
  requireRun(runId) {
    const row = this.store.get('SELECT * FROM runs WHERE id = ?', runId);
    if (!row) throw new ApiError(404, 'not_found', `Run "${runId}" does not exist.`);
    return row;
  }

  latestAttempts(runId) {
    return this.store.all(`SELECT a.*, n.node_id FROM attempts a JOIN node_instances n ON n.run_id = a.run_id AND n.id = a.node_instance_id
      WHERE a.run_id = ? AND a.ordinal = (SELECT MAX(b.ordinal) FROM attempts b WHERE b.run_id = a.run_id AND b.node_instance_id = a.node_instance_id) ORDER BY n.rowid`, runId);
  }
  latestAttempt(runId, instanceId) {
    return this.store.get('SELECT * FROM attempts WHERE run_id = ? AND node_instance_id = ? ORDER BY ordinal DESC LIMIT 1', runId, instanceId);
  }

  runSnapshot(runId) {
    const row = this.requireRun(runId);
    const instances = this.latestAttempts(runId).map(item => ({ nodeInstanceId: item.node_instance_id, nodeId: item.node_id, state: item.state, attemptId: item.id, ordinal: item.ordinal,
      outputs: item.outputs_artifact_id ? { artifactId: item.outputs_artifact_id, sha256: this.store.artifactRow(item.outputs_artifact_id).sha256 } : null }));
    const contexts = this.store.all('SELECT * FROM run_context_bindings WHERE run_id = ? ORDER BY context_node_id', runId)
      .map(item => ({ contextNodeId: item.context_node_id, mode: item.mode, bindingId: item.binding_id }));
    const loops = this.store.all('SELECT * FROM loop_executions WHERE run_id = ? ORDER BY rowid', runId).map(item => ({
      loopNodeId: item.loop_node_id, state: item.state, iteration: item.iteration, maxIterations: item.max_iterations, maxActiveMinutes: item.max_active_minutes,
      activeMs: this.activeMs(runId, item.loop_node_id, item), pauseReason: item.pause_reason }));
    return { run: this.runBody(row), instances, contexts, loops, maps: this.mapSnapshots(runId), controlMode: this.controlModeOf(runId) };
  }

  listRuns({ workspaceId, state, kind, bindingId, limit, cursor } = {}) {
    if (workspaceId !== undefined) this.requireWorkspace(workspaceId);
    if (state !== undefined && !ACTIVE_RUN.has(state) && !TERMINAL_RUN.has(state)) throw new ApiError(400, 'invalid_request', `Unknown run state "${state}".`);
    if (kind !== undefined && !['workflow', 'chat'].includes(kind)) throw new ApiError(400, 'invalid_request', `Unknown run kind "${kind}".`);
    const filters = { workspaceId: workspaceId ?? null, state: state ?? null, kind: kind ?? null, bindingId: bindingId ?? null };
    const where = [], params = [];
    if (workspaceId !== undefined) { where.push('workspace_id = ?'); params.push(workspaceId); }
    if (state !== undefined) { where.push('state = ?'); params.push(state); }
    if (kind !== undefined) { where.push('kind = ?'); params.push(kind); }
    if (bindingId !== undefined) { where.push('id IN (SELECT run_id FROM run_context_bindings WHERE binding_id = ?)'); params.push(bindingId); }
    return this.page({ collection: 'runs', table: 'runs', filters, where, params, limit, cursor, map: row => this.runBody(row) });
  }

  // ---------- Run creation ----------
  createRun(body, { role = 'first-party', clientLabel = null, controllerToken = null } = {}) {
    this.validateBody('createRun', body);
    if (this.recoveryBlocked) throw new ApiError(409, 'conflict', this.recoveryBlocked);
    if (this.closing) throw new ApiError(409, 'conflict', 'The runtime is shutting down.');
    const external = role === 'external';
    if (external && !this.store.get('SELECT id FROM workspaces LIMIT 1')) throw new ApiError(409, 'workspace_required', 'Create a workspace in the Deszo window before requesting a run.');
    const command = external ? 'POST /runs/external' : 'POST /runs/direct';
    return this.idempotent(command, body.requestId, body, () => {
      const workflowRow = this.store.get(`SELECT * FROM workflows WHERE id = ? AND kind = 'user'`, body.workflowId);
      if (!workflowRow) throw new ApiError(404, 'not_found', `Workflow "${body.workflowId}" does not exist.`);
      const workspace = this.requireWorkspace(body.workspaceId);
      const snapshot = this.store.artifactRow(workflowRow.snapshot_artifact_id);
      if (snapshot.sha256 !== body.workflowSnapshotSha256) throw new ApiError(409, 'conflict', 'The saved workflow changed; reload it before running.');
      const settings = this.currentSettings().settings;
      // A supervised run must be bound to its approved grant before launch; a confirmation queue cannot hold that binding.
      if (body.controlGrantId && external && settings.externalRunConfirmation) throw new ApiError(409, 'confirmation_required', 'A supervised run needs its control grant bound at creation. Confirmation is on, so request the supervised run from the Deszo window.');
      if (external && settings.externalRunConfirmation) {
        const createdAt = nowIso();
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
        this.store.run(`INSERT INTO external_run_requests(request_id,payload_sha256,request_json,workflow_id,workflow_snapshot_sha256,workspace_id,workspace_cwd_identity,client_label,state,created_at,expires_at)
          VALUES(?,?,?,?,?,?,?,?,'pending',?,?)`, body.requestId, canonicalHash(body), canonicalize(body), body.workflowId, body.workflowSnapshotSha256, workspace.id, workspace.cwd_identity,
        typeof clientLabel === 'string' ? clientLabel.slice(0, 120) : null, createdAt, expiresAt);
        return { status: 202, body: { outcome: 'confirmation_pending', requestId: body.requestId, statusPath: `/api/v2/run-requests/${body.requestId}` } };
      }
      const workflow = this.store.readJson(snapshot.id);
      const result = this.captureRun({ workflow, snapshot, workspace, kind: 'workflow', options: { mode: body.mode || 'workflow', targets: body.targets, refreshCaches: body.refreshCaches || [] }, requestId: body.requestId });
      // The observer is armed here, inside the creating transaction and before the queued start.
      if (body.controlGrantId) this.bindControlGrant(body.controlGrantId, { runId: result.body.run.runId, workflowId: body.workflowId, workspaceId: body.workspaceId,
        snapshotSha256: body.workflowSnapshotSha256, controllerToken });
      if (external) {
        const createdAt = nowIso();
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
        this.store.run(`INSERT INTO external_run_requests(request_id,payload_sha256,request_json,workflow_id,workflow_snapshot_sha256,workspace_id,workspace_cwd_identity,client_label,state,created_at,expires_at,run_id)
          VALUES(?,?,?,?,?,?,?,?,'approved',?,?,?)`, body.requestId, canonicalHash(body), canonicalize(body), body.workflowId, body.workflowSnapshotSha256, workspace.id, workspace.cwd_identity,
        typeof clientLabel === 'string' ? clientLabel.slice(0, 120) : null, createdAt, expiresAt, result.body.run.runId);
      }
      return result;
    }, () => queueMicrotask(() => this.startRun()));
  }

  expireRunRequests() {
    const now = nowIso();
    return this.store.transaction(() => this.store.run("UPDATE external_run_requests SET state = 'expired' WHERE state = 'pending' AND expires_at <= ?", now).changes);
  }

  runRequestBody(row) {
    return {
      requestId: row.request_id, workflowId: row.workflow_id, workspaceId: row.workspace_id,
      workflowSnapshotSha256: row.workflow_snapshot_sha256, clientLabel: row.client_label,
      state: row.state, createdAt: row.created_at, expiresAt: row.expires_at, runId: row.run_id,
      problem: row.problem_json ? parseStrictJson(row.problem_json) : null,
    };
  }

  listRunRequests({ state = 'pending', limit = 50 } = {}) {
    this.expireRunRequests();
    if (!['pending', 'approved', 'denied', 'expired', 'all'].includes(state)) throw new ApiError(400, 'invalid_request', 'Unknown run-request state.');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, 'invalid_request', 'limit must be between 1 and 100.');
    const rows = state === 'all'
      ? this.store.all('SELECT * FROM external_run_requests ORDER BY created_at DESC LIMIT ?', limit)
      : this.store.all('SELECT * FROM external_run_requests WHERE state = ? ORDER BY created_at DESC LIMIT ?', state, limit);
    return { items: rows.map(row => this.runRequestBody(row)), nextCursor: null };
  }

  getRunRequest(requestId) {
    this.expireRunRequests();
    const row = this.store.get('SELECT * FROM external_run_requests WHERE request_id = ?', requestId);
    if (!row) throw new ApiError(404, 'not_found', `Run request "${requestId}" does not exist.`);
    return this.runRequestBody(row);
  }

  decideRunRequest(requestId, body) {
    if (!body || typeof body.requestId !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(body.requestId) || !['approve', 'deny'].includes(body.decision))
      throw new ApiError(400, 'invalid_request', 'A decision request requires a UUID requestId and approve or deny decision.');
    const payload = { runRequestId: requestId, decision: body.decision };
    return this.idempotent(`POST /run-requests/${requestId}/decision`, body.requestId, payload, () => {
      this.expireRunRequests();
      const request = this.store.get('SELECT * FROM external_run_requests WHERE request_id = ?', requestId);
      if (!request) return { status: 404, body: { code: 'not_found', message: `Run request "${requestId}" does not exist.`, details: [] } };
      if (request.state !== 'pending') return { status: 409, body: { code: 'conflict', message: `Run request is already ${request.state}.`, details: [] } };
      if (body.decision === 'deny') {
        this.store.run("UPDATE external_run_requests SET state = 'denied' WHERE request_id = ?", requestId);
        return { status: 200, body: this.runRequestBody(this.store.get('SELECT * FROM external_run_requests WHERE request_id = ?', requestId)) };
      }
      const command = parseStrictJson(request.request_json);
      try {
        const workflowRow = this.store.get("SELECT * FROM workflows WHERE id = ? AND kind = 'user'", request.workflow_id);
        if (!workflowRow) throw new ApiError(404, 'not_found', `Workflow "${request.workflow_id}" does not exist.`);
        const snapshot = this.store.artifactRow(workflowRow.snapshot_artifact_id);
        if (snapshot.sha256 !== request.workflow_snapshot_sha256) throw new ApiError(409, 'conflict', 'The saved workflow changed while this request was pending.');
        const workspace = this.requireWorkspace(request.workspace_id);
        if (workspace.cwd_identity !== request.workspace_cwd_identity) throw new ApiError(409, 'conflict', 'The workspace binding changed while this request was pending.');
        const result = this.captureRun({ workflow: this.store.readJson(snapshot.id), snapshot, workspace, kind: 'workflow',
          options: { mode: command.mode || 'workflow', targets: command.targets, refreshCaches: command.refreshCaches || [] }, requestId });
        const runId = result.body.run.runId;
        this.store.run("UPDATE external_run_requests SET state = 'approved', run_id = ? WHERE request_id = ?", runId, requestId);
        return { status: 202, body: { request: this.runRequestBody(this.store.get('SELECT * FROM external_run_requests WHERE request_id = ?', requestId)), run: result.body.run } };
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        const problem = { code: error.code, message: error.message, details: error.details || [] };
        this.store.run("UPDATE external_run_requests SET state = 'denied', problem_json = ? WHERE request_id = ?", canonicalize(problem), requestId);
        return { status: error.status, body: problem };
      }
    }, () => {
      if (body.decision === 'approve') queueMicrotask(() => this.startRun());
    });
  }

  listRunEvents(runId, { afterSequence = 0, limit = 100 } = {}) {
    const run = this.requireRun(runId);
    if (!Number.isInteger(afterSequence) || afterSequence < 0 || afterSequence > run.last_sequence) throw new ApiError(400, 'invalid_request', 'afterSequence must be a valid nonnegative run-event cursor.');
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiError(400, 'invalid_request', 'limit must be between 1 and 200.');
    const rows = this.store.readEventsPage(runId, afterSequence, limit);
    const more = rows.length > limit;
    const items = rows.slice(0, limit);
    return { items, nextCursor: more ? items.at(-1).sequence : null };
  }

  artifactProvenance(artifactId) {
    const artifact = this.store.artifactRow(artifactId);
    if (!artifact) throw new ApiError(404, 'not_found', 'Unknown artifact.');
    const sources = this.store.all(`
      SELECT a.run_id,a.node_instance_id,a.id AS attempt_id,'inputs' AS source_kind,'[]' AS path_json FROM attempts a WHERE a.inputs_artifact_id = ?
      UNION ALL SELECT a.run_id,a.node_instance_id,a.id,'invocation','[]' FROM attempts a WHERE a.invocation_artifact_id = ?
      UNION ALL SELECT a.run_id,a.node_instance_id,a.id,'outputs','[]' FROM attempts a WHERE a.outputs_artifact_id = ?
      UNION ALL SELECT a.run_id,a.node_instance_id,a.id,'inputs',r.path_json FROM artifact_references r JOIN attempts a ON a.inputs_artifact_id = r.parent_artifact_id WHERE r.referenced_artifact_id = ?
      UNION ALL SELECT a.run_id,a.node_instance_id,a.id,'invocation',r.path_json FROM artifact_references r JOIN attempts a ON a.invocation_artifact_id = r.parent_artifact_id WHERE r.referenced_artifact_id = ?
      UNION ALL SELECT a.run_id,a.node_instance_id,a.id,'outputs',r.path_json FROM artifact_references r JOIN attempts a ON a.outputs_artifact_id = r.parent_artifact_id WHERE r.referenced_artifact_id = ?
      LIMIT 101`, artifactId, artifactId, artifactId, artifactId, artifactId, artifactId)
      .map(source => ({ runId: source.run_id, nodeInstanceId: source.node_instance_id, attemptId: source.attempt_id,
        sourceKind: source.source_kind, path: parseStrictJson(source.path_json) }));
    for (const run of this.store.all('SELECT id,workflow_snapshot_artifact_id FROM runs WHERE workflow_snapshot_artifact_id = ?', artifactId))
      sources.push({ runId: run.id, nodeInstanceId: null, attemptId: null, sourceKind: 'workflow_snapshot', path: [] });
    return { artifactId, sha256: artifact.sha256, byteSize: artifact.byte_size, mediaType: artifact.media_type, sources: sources.slice(0, 100) };
  }

  contextNodes(workflow) {
    const result = [];
    const visit = (nodes, loopId) => {
      for (const node of nodes) {
        if (node.type === 'context') result.push({ node, loopId });
        if (node.type === 'loop') visit(node.config.body.nodes, node.id);
      }
    };
    visit(workflow.nodes, null);
    return result;
  }

  // Compute the outer plan: planned node IDs, reused predecessors, frozen cuts and pins.
  planRun(workflow, workspace, { mode, targets, refreshCaches }) {
    const outer = new Map(workflow.nodes.map(node => [node.id, node]));
    const deep = allNodesDeep(workflow.nodes);
    for (const id of refreshCaches) if (deep.find(node => node.id === id)?.type !== 'cache') throw new ApiError(422, 'validation_failed', `refreshCaches names "${id}", which is not a Cache node.`);
    for (const id of targets || []) if (!outer.has(id) || outer.get(id).type === 'context') throw new ApiError(422, 'validation_failed', `Target "${id}" is not an executable node of the outer workflow.`);
    const pins = this.pinsFor(workflow.workflowId);
    const frozen = new Set(deep.filter(node => node.type === 'cache' && node.config.mode === 'frozen' && !refreshCaches.includes(node.id)).map(node => node.id));
    for (const id of frozen) {
      if (!pins[id]) throw new ApiError(422, 'validation_failed', `Frozen Cache "${id}" has no pin. Run it live and pin its value first.`, [{ path: id, message: 'missing pin' }]);
      try { this.store.verifyRef(pins[id].value.artifact); }
      catch { throw new ApiError(422, 'validation_failed', `The pin of Frozen Cache "${id}" failed digest verification.`); }
    }
    const viewers = workflow.nodes.filter(node => node.type === 'result-viewer').map(node => node.id);
    const reused = new Map();
    let planned;
    if (mode === 'node') {
      planned = new Set(targets);
      const target = targets[0];
      const predecessors = new Set([...workflow.edges.filter(edge => edge.target.nodeId === target).map(edge => edge.source.nodeId), ...workflow.after.filter(pair => pair.after === target).map(pair => pair.before)]);
      if (frozen.has(target)) predecessors.clear();
      const current = fingerprints(workflow, pins);
      for (const id of predecessors) {
        const source = this.reuseSource(workflow.workflowId, workspace.id, id, current[id]);
        if (!source) throw new ApiError(422, 'validation_failed', `Run Node needs a committed, current output of "${id}"; none matches the current definition. Run the branch instead.`, [{ path: `/nodes/${id}`, message: 'missing or stale input' }]);
        reused.set(id, source);
      }
    } else {
      planned = requiredSet(workflow, mode === 'branch' ? targets : viewers, frozen);
    }
    // Context prerequisites: a planned writer cannot stand in for an unplanned or reused one.
    const users = new Map();
    const note = (contextId, outerNode, agent) => { if (!users.has(contextId)) users.set(contextId, []); users.get(contextId).push({ outerNode, agent }); };
    const walk = (nodes, outerNode) => { for (const node of nodes) { const owner = outerNode || node.id; if (node.type === 'agent' && node.config.contextId) note(node.config.contextId, owner, node); if (node.type === 'loop') walk(node.config.body.nodes, owner); } };
    walk(workflow.nodes, null);
    const contexts = new Map(this.contextNodes(workflow).map(item => [item.node.id, item.node]));
    for (const [contextId, list] of users) {
      const live = list.filter(item => planned.has(item.outerNode) && !reused.has(item.outerNode));
      const missing = list.filter(item => !planned.has(item.outerNode) || reused.has(item.outerNode));
      if (!live.length || !missing.length) continue;
      const context = contexts.get(contextId);
      const ok = context.config.mode === 'continue' && missing.every(item => reused.has(item.outerNode) && reused.get(item.outerNode).bindingId === context.config.bindingId);
      if (!ok) throw new ApiError(422, 'context_prerequisite', `Context "${contextId}" is shared by "${live[0].agent.id}" and "${missing[0].agent.id}", which is not part of this plan. A fresh conversation cannot stand in for its turns; run them together or use a Continue Context.`);
    }
    return { mode, targets: mode === 'workflow' ? viewers : targets, planned, reused, frozen, refreshCaches, pins: Object.fromEntries([...frozen].map(id => [id, pins[id]])) };
  }

  // Most recent succeeded attempt of `nodeId` whose captured fingerprint equals the current one.
  reuseSource(workflowId, workspaceId, nodeId, fingerprint) {
    const runs = this.store.all(`SELECT * FROM runs WHERE workflow_id = ? AND workspace_id = ? AND kind = 'workflow' ORDER BY created_at DESC LIMIT 50`, workflowId, workspaceId);
    for (const run of runs) {
      const attempt = this.latestAttempt(run.id, nodeId);
      if (!attempt || !DONE_OK.has(attempt.state) || !attempt.outputs_artifact_id) continue;
      const captured = this.store.readJson(run.workflow_snapshot_artifact_id);
      const plan = run.plan_artifact_id ? this.store.readJson(run.plan_artifact_id) : { pins: {} };
      if (plan.effortPolicyVersion !== EFFORT_POLICY_VERSION) continue;
      if (fingerprints(captured, plan.pins || {})[nodeId] !== fingerprint) continue;
      return { runId: run.id, attemptId: attempt.id, outputs: attempt.outputs_artifact_id, bindingId: attempt.context_binding_id };
    }
    return null;
  }

  captureRun({ workflow, snapshot, workspace, kind, options, requestId }) {
    const active = this.activeRun(workspace.id);
    if (active) throw new ApiError(409, 'conflict', active.state === 'waiting_for_user' ? 'The previous run in this workspace is waiting for recovery; close or stop it first.' : 'Another run is active in this workspace.');
    const validation = this.validateWorkflow(workflow);
    if (!validation.valid) throw new ApiError(422, 'validation_failed', 'The workflow is not executable.', validation.issues);
    const contexts = this.contextNodes(workflow);
    const continued = new Map();
    for (const { node } of contexts.filter(item => item.node.config.mode === 'continue')) {
      const binding = this.store.get('SELECT * FROM context_bindings WHERE id = ?', node.config.bindingId);
      if (!binding || binding.workspace_id !== workspace.id || binding.provider !== node.config.provider || binding.state !== 'ready')
        throw new ApiError(422, 'context_unavailable', `Context "${node.id}" needs a ready ${node.config.provider} binding in this workspace (${binding ? `state is ${binding.state}` : 'binding not found'}).`);
      continued.set(node.id, binding);
    }
    if (workflow.settings.nativeConfiguration === 'inherit' && allNodesDeep(workflow.nodes).some(node => node.type === 'agent' && node.config.provider === 'antigravity'))
      throw new ApiError(422, 'unsupported_capability', 'Antigravity does not support inherited native configuration.');
    for (const node of allNodesDeep(workflow.nodes).filter(item => item.type === 'file-input' && item.config.mode === 'artifact')) {
      const row = this.store.artifactRow(node.config.artifact.artifactId);
      if (!row || row.sha256 !== node.config.artifact.sha256) throw new ApiError(422, 'validation_failed', `File input "${node.id}" pins an artifact that is not stored with that digest.`);
    }
    const plan = this.planRun(workflow, workspace, options.mode ? options : { mode: 'workflow', refreshCaches: [] });
    const settings = this.currentSettings();
    const runSettings = { schemaVersion: 1, applicationSettings: { revision: settings.revision, sha256: settings.sha256, settings: settings.settings },
      nativeConfiguration: workflow.settings.nativeConfiguration, maximumAgentTimeoutSeconds: this.maximumAgentTimeoutSeconds,
      processContainment: this.processContainment, workspace: this.workspaceBody(workspace) };
    assertValid(API, 'runSettings', runSettings);
    const { view, ...definition } = workflow;
    const runId = randomUUID();
    return this.store.transaction(() => {
      const settingsArtifact = this.store.putJson(runSettings);
      const planRecord = { schemaVersion: 1, effortPolicyVersion: EFFORT_POLICY_VERSION, mode: plan.mode, targets: plan.targets, planned: [...plan.planned], refreshCaches: plan.refreshCaches, frozen: [...plan.frozen], pins: plan.pins,
        reused: Object.fromEntries([...plan.reused].map(([id, source]) => [id, { runId: source.runId, attemptId: source.attemptId }])) };
      const planArtifact = this.store.putJson(planRecord);
      const createdAt = nowIso();
      this.store.run(`INSERT INTO runs(id, workflow_id, workspace_id, workflow_snapshot_artifact_id, settings_artifact_id, execution_hash, state, last_sequence, created_at, kind, plan_artifact_id) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`,
        runId, workflow.workflowId, workspace.id, snapshot.id, settingsArtifact.artifactId, canonicalHash(definition), createdAt, kind, planArtifact.artifactId);
      const events = [
        { type: 'run.created', payload: { workflowSnapshot: { artifactId: snapshot.id, sha256: snapshot.sha256 }, executionHash: canonicalHash(definition), settingsSnapshot: ref(settingsArtifact) } },
        { type: 'run.state_changed', payload: { from: null, to: 'queued', reason: 'Run captured.' } },
        { type: 'run.planned', payload: { plan: ref(planArtifact), mode: plan.mode, targets: plan.targets } },
      ];
      for (const { node } of contexts.filter(item => item.node.config.lifetime !== 'iteration')) {
        const bindingId = node.config.mode === 'continue' ? continued.get(node.id).id : this.createBinding(runId, workspace, node.config.provider, node.id, createdAt);
        this.store.run('INSERT INTO run_context_bindings(run_id, context_node_id, mode, binding_id) VALUES (?, ?, ?, ?)', runId, node.id, node.config.mode, bindingId);
      }
      const nodes = new Map(workflow.nodes.map(node => [node.id, node]));
      const order = topologicalOrder(workflow).filter(id => plan.planned.has(id) || plan.reused.has(id));
      for (const id of order) {
        this.store.run(`INSERT INTO node_instances(run_id, id, node_id, node_type, state) VALUES (?, ?, ?, ?, ?)`, runId, id, id, nodes.get(id).type, plan.reused.has(id) ? 'reused' : 'scheduled');
        events.push({ type: 'node.planned', nodeInstanceId: id, payload: { nodeId: id, nodeType: nodes.get(id).type, scope: null } });
      }
      for (const id of order) {
        const attemptId = randomUUID();
        const source = plan.reused.get(id);
        if (source) {
          this.store.run(`INSERT INTO attempts(id, run_id, node_instance_id, ordinal, state, outputs_artifact_id, context_binding_id) VALUES (?, ?, ?, 1, 'reused', ?, ?)`, attemptId, runId, id, source.outputs, source.bindingId);
          events.push({ type: 'attempt.state_changed', nodeInstanceId: id, attemptId, payload: { from: null, to: 'reused', reason: `Reused from run ${source.runId}.`, process: null, ordinal: 1 } });
          events.push({ type: 'attempt.reused', nodeInstanceId: id, attemptId, payload: { sourceRunId: source.runId, sourceAttemptId: source.attemptId, outputs: { artifactId: source.outputs, sha256: this.store.artifactRow(source.outputs).sha256 } } });
        } else {
          this.store.run(`INSERT INTO attempts(id, run_id, node_instance_id, ordinal, state) VALUES (?, ?, ?, 1, 'scheduled')`, attemptId, runId, id);
          events.push({ type: 'attempt.state_changed', nodeInstanceId: id, attemptId, payload: { from: null, to: 'scheduled', reason: 'Planned before dispatch.', process: null, ordinal: 1 } });
        }
      }
      this.store.appendEvents(runId, events);
      return { status: 202, body: { outcome: 'created', run: this.runBody(this.store.get('SELECT * FROM runs WHERE id = ?', runId)), requestId } };
    });
  }

  // ---------- In-memory scopes ----------
  buildScope(graph, frozen, { loopInstance = null, iteration = null } = {}) {
    const prefix = loopInstance ? bodyPrefix(loopInstance, iteration) : '';
    const scope = { prefix, loopInstance, iteration, graph, nodes: new Map(graph.nodes.map(node => [node.id, node])), predecessors: new Map(), afterPredecessors: new Map() };
    for (const node of graph.nodes.filter(isExecutable)) { scope.predecessors.set(node.id, new Set()); scope.afterPredecessors.set(node.id, new Set()); }
    for (const edge of graph.edges) if (edge.source.nodeId !== INPUT && edge.target.nodeId !== RETURN && !frozen.has(edge.target.nodeId)) scope.predecessors.get(edge.target.nodeId)?.add(edge.source.nodeId);
    for (const pair of graph.after) scope.afterPredecessors.get(pair.after)?.add(pair.before);
    return scope;
  }

  startRun() {
    for (const row of this.store.all(`SELECT * FROM runs WHERE state = 'queued' ORDER BY created_at`)) {
      if (this.runs.has(row.id)) continue;
      const workflow = this.store.readJson(row.workflow_snapshot_artifact_id);
      const plan = row.plan_artifact_id ? this.store.readJson(row.plan_artifact_id) : { frozen: [], pins: {}, refreshCaches: [] };
      const state = { id: row.id, kind: row.kind, workflow, plan, frozen: new Set(plan.frozen), scopes: new Map(), loops: new Map() };
      state.scopes.set('', this.buildScope(workflow, state.frozen));
      this.runs.set(row.id, state);
      this.store.transaction(() => this.store.appendEvents(row.id, [this.runEvent(row, 'running', 'Scheduler started.')]));
    }
    this.pump();
  }

  scopeFor(state, prefix) {
    if (state.scopes.has(prefix)) return state.scopes.get(prefix);
    const parts = prefix.split('/').filter(Boolean);
    const loopInstance = parts.slice(0, -1).join('/');
    const iteration = Number(parts.at(-1));
    const loopNode = this.loopNode(state, loopInstance);
    const scope = this.buildScope(loopNode.config.body, state.frozen, { loopInstance, iteration });
    state.scopes.set(prefix, scope);
    return scope;
  }

  loopNode(state, loopInstance) {
    const { prefix, nodeId } = parseInstance(loopInstance);
    return this.scopeFor(state, prefix).nodes.get(nodeId);
  }

  locate(state, instanceId) {
    const { prefix, nodeId } = parseInstance(instanceId);
    const scope = this.scopeFor(state, prefix);
    return { scope, node: scope.nodes.get(nodeId) };
  }

  loopRuntime(state, loopInstance) {
    if (!state.loops.has(loopInstance)) state.loops.set(loopInstance, { node: this.loopNode(state, loopInstance), running: 0, since: 0, pending: null, timer: null });
    return state.loops.get(loopInstance);
  }

  // ---------- Journal helpers ----------
  runEvent(row, to, reason) {
    const from = this.store.get('SELECT state FROM runs WHERE id = ?', row.id).state;
    this.store.run('UPDATE runs SET state = ? WHERE id = ?', to, row.id);
    return { type: 'run.state_changed', payload: { from, to, reason } };
  }

  attemptTransition(attempt, to, reason, process = null) {
    const current = this.store.get('SELECT state FROM attempts WHERE id = ?', attempt.id);
    this.store.run('UPDATE attempts SET state = ?, ended_at = CASE WHEN ? THEN ? ELSE ended_at END WHERE id = ?', to, TERMINAL_ATTEMPT.has(to) ? 1 : 0, nowIso(), attempt.id);
    this.store.run('UPDATE node_instances SET state = ? WHERE run_id = ? AND id = ?', to, attempt.run_id, attempt.node_instance_id);
    return [{ type: 'attempt.state_changed', nodeInstanceId: attempt.node_instance_id, attemptId: attempt.id, payload: { from: current.state, to, reason, process } }];
  }

  bindingTransition(binding, to, reason, changes = {}) {
    const from = binding.state;
    const updated = this.writeBinding(binding, { ...changes, state: to });
    return [{ type: 'context.state_changed', payload: { bindingId: binding.id, from, to, reason } }, updated];
  }

  planAttempt(state, instanceId, nodeId, nodeType, scope, events, reason = 'Planned before dispatch.') {
    const existing = this.store.get('SELECT MAX(ordinal) AS ordinal FROM attempts WHERE run_id = ? AND node_instance_id = ?', state.id, instanceId);
    if (!existing.ordinal) {
      this.store.run(`INSERT INTO node_instances(run_id, id, node_id, node_type, state) VALUES (?, ?, ?, ?, 'scheduled')`, state.id, instanceId, nodeId, nodeType);
      events.push({ type: 'node.planned', nodeInstanceId: instanceId, payload: { nodeId, nodeType, scope } });
    }
    const ordinal = (existing.ordinal || 0) + 1;
    const attemptId = randomUUID();
    this.store.run(`INSERT INTO attempts(id, run_id, node_instance_id, ordinal, state) VALUES (?, ?, ?, ?, 'scheduled')`, attemptId, state.id, instanceId, ordinal);
    this.store.run(`UPDATE node_instances SET state = 'scheduled' WHERE run_id = ? AND id = ?`, state.id, instanceId);
    events.push({ type: 'attempt.state_changed', nodeInstanceId: instanceId, attemptId, payload: { from: null, to: 'scheduled', reason, process: null, ordinal } });
    return attemptId;
  }

  // ---------- Scheduler ----------
  pump() {
    if (this.pumping) { this.pumpAgain = true; return; }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        for (const state of [...this.runs.values()]) {
          try { this.pumpRun(state); }
          catch (error) { process.stderr.write(`Scheduler error in run ${state.id}: ${error.stack || error}\n`); }
        }
      } while (this.pumpAgain);
    } finally { this.pumping = false; }
  }

  runState(runId) { return this.store.get('SELECT state FROM runs WHERE id = ?', runId).state; }

  // A body scope is active only while every enclosing loop runs at that iteration with no pending pause.
  scopeActive(state, scope) {
    for (const { loopInstance, iteration } of enclosingLoops(scope.prefix)) {
      const loop = this.loopRow(state, loopInstance);
      if (loop?.state !== 'running' || loop.iteration !== iteration || state.loops.get(loopInstance)?.pending) return false;
    }
    return true;
  }

  // Status of one data input: active / inactive / pending / failed.
  inputStatus(state, scope, edge) {
    if (edge.source.nodeId === INPUT) return 'active';
    const source = this.latestAttempt(state.id, scope.prefix + edge.source.nodeId);
    if (!source) return 'inactive';
    if (source.state === 'skipped') return 'inactive';
    if (DONE_OK.has(source.state)) return this.store.readJson(source.outputs_artifact_id).values[edge.source.port] ? 'active' : 'inactive';
    if (['failed', 'canceled', 'interrupted', 'blocked'].includes(source.state)) return 'failed';
    return source.state === 'running' ? 'running' : 'pending';
  }

  readiness(state, attempt) {
    if (this.isMapStep(state, attempt.node_instance_id)) return this.mapStepReadiness(state, attempt);
    if (!UNSTARTED.has(attempt.state) || this.processes.has(attempt.id)) return null;
    const located = this.locate(state, attempt.node_instance_id);
    if (!located?.node || !this.scopeActive(state, located.scope)) return null;
    const { scope, node } = located;
    if (node.type === 'loop' && this.loopRow(state, attempt.node_instance_id)) return null;
    if (node.type === 'map' && this.store.get('SELECT 1 FROM map_executions WHERE run_id = ? AND attempt_id = ?', state.id, attempt.id)) return null;
    for (const before of scope.afterPredecessors.get(node.id)) {
      const previous = this.latestAttempt(state.id, scope.prefix + before);
      if (previous && !['succeeded', 'reused', 'skipped'].includes(previous.state)) return null;
    }
    const edges = scope.graph.edges.filter(edge => edge.target.nodeId === node.id && !(state.frozen.has(node.id) && node.type === 'cache'));
    const statuses = edges.map(edge => ({ edge, status: this.inputStatus(state, scope, edge) }));
    if (node.type === 'merge' && node.config.mode === 'selected') {
      const outcome = selectedOutcome(statuses.map(item => item.status === 'active' ? 'succeeded' : item.status));
      if (outcome === 'wait' || outcome === 'recovery') return null;
      return { scope, node, action: outcome === 'commit' ? 'run' : outcome === 'inactive' ? 'skip' : 'conflict', chosen: statuses.find(item => item.status === 'active')?.edge };
    }
    if (statuses.some(item => item.status === 'inactive')) return { scope, node, action: 'skip' };
    if (!statuses.every(item => item.status === 'active')) return null;
    return { scope, node, action: 'run' };
  }

  pumpRun(state) {
    // A missed controller acknowledgement pauses new dispatch only; work already running keeps its own timeouts.
    // Nothing launches for a supervised run until its observer is armed, and a paused controller stops new dispatch.
    if (this.dispatchPaused.has(state.id) || this.awaitingArm.has(state.id)) return;
    if (this.runState(state.id) === 'running') {
      for (const attempt of this.latestAttempts(state.id)) {
        const ready = this.readiness(state, attempt);
        if (!ready) continue;
        if (ready.action === 'skip') { this.skipAttempt(state, attempt, 'An input comes from an inactive Route output or a skipped node.'); this.pumpAgain = true; }
        else if (ready.action === 'conflict') this.failAttempt(state, attempt, 'output_contract', 'More than one alternative of a selected Merge is active.');
        else if (ready.action === 'map-step') { if (this.dispatchMapStep(state, attempt, ready.info)) this.pumpAgain = true; }
        else if (ready.node.type === 'agent') this.tryDispatchAgent(state, ready.scope, ready.node, attempt);
        else if (ready.node.type === 'loop') { this.startLoop(state, ready.scope, ready.node, attempt); this.pumpAgain = true; }
        else if (ready.node.type === 'map') { this.startMap(state, ready.scope, ready.node, attempt); this.pumpAgain = true; }
        else { this.runStatic(state, ready.scope, ready.node, attempt, ready.chosen); this.pumpAgain = true; }
        if (this.runState(state.id) !== 'running') break;
      }
      if (this.runState(state.id) === 'running') for (const loop of this.store.all(`SELECT loop_node_id FROM loop_executions WHERE run_id = ? AND state = 'running'`, state.id)) this.maybeReturn(state, loop.loop_node_id);
      if (this.runState(state.id) === 'running' && this.advanceMaps(state)) this.pumpAgain = true;
    }
    for (const loopInstance of state.loops.keys()) this.maybeSettlePause(state, loopInstance);
    this.finishRunIfDone(state);
  }

  skipAttempt(state, attempt, reason) {
    this.store.transaction(() => this.store.appendEvents(state.id, this.attemptTransition(attempt, 'skipped', reason)));
  }

  liveIn(state) { return [...this.processes.values()].filter(record => record.runId === state.id); }

  finishRunIfDone(state) {
    // Another scheduler pass is pending (for example a Map just changed task states); decide after it.
    if (this.liveIn(state).length || this.pumpAgain) return;
    const row = this.store.get('SELECT * FROM runs WHERE id = ?', state.id);
    let to = null, reason = '';
    if (row.state === 'stopping') { to = 'canceled'; reason = 'Root Stop completed after every child process exited.'; }
    else if (row.state === 'draining') {
      to = state.kind === 'chat' ? 'failed' : 'waiting_for_user';
      reason = state.kind === 'chat' ? 'The chat turn failed.' : 'Running attempts finished after a failure; recovery is needed.';
    } else if (row.state === 'running') {
      const latest = this.latestAttempts(state.id);
      const outer = latest.filter(attempt => !attempt.node_instance_id.includes('/'));
      if (outer.length && outer.every(attempt => ['succeeded', 'reused', 'skipped'].includes(attempt.state))) { to = 'succeeded'; reason = 'Every planned node succeeded, was reused, or was skipped by a Route.'; }
      else if (!latest.some(attempt => this.readiness(state, attempt))) {
        to = state.kind === 'chat' ? 'failed' : 'waiting_for_user';
        reason = 'No work can proceed; failed, stopped or paused work needs a decision.';
      }
    }
    if (!to) return;
    this.store.transaction(() => this.store.appendEvents(state.id, [this.runEvent(row, to, reason)]));
    if (row.state === 'stopping') this.recordTerminationProof(state.id).catch(error => process.stderr.write(`Termination proof for run ${state.id} failed: ${error.message}\n`));
    if (TERMINAL_RUN.has(to)) { this.endControl(state.id); this.forget(state); }
  }

  forget(state) {
    for (const loop of state.loops.values()) clearInterval(loop.timer);
    this.runs.delete(state.id);
  }

  // M2: the first failure stops dispatch but keeps unstarted work for recovery.
  latchFailure(state, events) {
    const row = this.store.get('SELECT * FROM runs WHERE id = ?', state.id);
    if (row.state === 'running') events.push(this.runEvent(row, 'draining', 'An attempt failed; no new dispatch until recovery.'));
  }

  failAttempt(state, attempt, code, message, { evidence = null, binding = null, bindingTo = null, bindingReason = '', bindingChanges = {} } = {}) {
    this.store.transaction(() => {
      const current = this.store.get('SELECT * FROM attempts WHERE id = ?', attempt.id);
      const events = [{ type: 'attempt.error', nodeInstanceId: current.node_instance_id, attemptId: current.id, payload: { code, message, evidence } }];
      events.push(...this.attemptTransition(current, 'failed', message));
      if (binding && bindingTo && binding.state !== bindingTo) events.push(this.bindingTransition(binding, bindingTo, bindingReason, bindingChanges)[0]);
      const { loopInstance } = parseInstance(current.node_instance_id);
      if (loopInstance) this.pauseLoop(state, loopInstance, 'body_failure', `Body node ${current.node_instance_id} failed: ${message}`, events);
      this.latchFailure(state, events);
      this.store.appendEvents(state.id, events);
    });
  }

  // Resolve a port value inside a scope: an edge from a node's latest output or a loop boundary.
  inputValue(state, scope, nodeId, port) {
    const edge = scope.graph.edges.find(item => item.target.nodeId === nodeId && item.target.port === port);
    if (!edge) throw new UtilityError('output_contract', `No edge supplies ${nodeId}.${port}.`);
    return this.edgeValue(state, scope, edge);
  }
  edgeValue(state, scope, edge) {
    if (edge.source.nodeId === INPUT) return this.boundaryValue(state, scope, edge.source.port);
    const source = this.latestAttempt(state.id, scope.prefix + edge.source.nodeId);
    if (!DONE_OK.has(source?.state) || !source.outputs_artifact_id) throw new UtilityError('output_contract', `${edge.source.nodeId} has no committed output.`);
    const value = this.store.readJson(source.outputs_artifact_id).values[edge.source.port];
    if (!value) throw new UtilityError('output_contract', `${edge.source.nodeId} did not commit port ${edge.source.port}.`);
    this.store.verifyRef(value.artifact);
    return value;
  }

  boundaryValue(state, scope, port) {
    const iteration = this.store.get('SELECT * FROM loop_iterations WHERE run_id = ? AND loop_node_id = ? AND iteration = ?', state.id, scope.loopInstance, scope.iteration);
    if (port === 'value') return parseStrictJson(iteration.value_json);
    if (port === 'feedback') return parseStrictJson(iteration.feedback_json);
    if (port === 'iteration') return jsonValue(this.store.putJson(scope.iteration));
    const loopAttempt = this.store.get('SELECT a.inputs_artifact_id FROM loop_executions l JOIN attempts a ON a.id = l.attempt_id WHERE l.run_id = ? AND l.loop_node_id = ?', state.id, scope.loopInstance);
    return this.store.readJson(loopAttempt.inputs_artifact_id).values[port];
  }

  commitOutputs(state, attempt, values, providerResult = null) {
    const manifest = { schemaVersion: 1, runId: state.id, attemptId: attempt.id, nodeId: parseInstance(attempt.node_instance_id).nodeId, values, providerResult };
    assertValid('attempt-record.schema.json', 'outputs', manifest, 'Output manifest');
    const artifact = this.store.putJson(manifest);
    this.store.run('UPDATE attempts SET outputs_artifact_id = ? WHERE id = ?', artifact.artifactId, attempt.id);
    return { type: 'attempt.outputs_committed', nodeInstanceId: attempt.node_instance_id, attemptId: attempt.id, payload: { manifest: ref(artifact) } };
  }

  commitInputs(state, attempt, values, { prompt = null, promptSources = [], binding = null } = {}) {
    const manifest = { schemaVersion: 1, runId: state.id, attemptId: attempt.id, nodeId: parseInstance(attempt.node_instance_id).nodeId, values,
      contextBindingId: binding?.id ?? null, prompt, promptSources, contextBinding: binding ? { artifactId: binding.binding_artifact_id, sha256: this.store.artifactRow(binding.binding_artifact_id).sha256 } : null };
    assertValid('attempt-record.schema.json', 'inputs', manifest, 'Input manifest');
    const artifact = this.store.putJson(manifest);
    this.store.run('UPDATE attempts SET inputs_artifact_id = ?, context_binding_id = ? WHERE id = ?', artifact.artifactId, binding?.id ?? null, attempt.id);
    return { type: 'attempt.inputs_committed', nodeInstanceId: attempt.node_instance_id, attemptId: attempt.id, payload: { manifest: ref(artifact), prompt, contextBindingId: binding?.id ?? null } };
  }

  workspaceOf(state) { return this.store.get('SELECT w.* FROM workspaces w JOIN runs r ON r.workspace_id = w.id WHERE r.id = ?', state.id); }

  runStatic(state, scope, node, attempt, chosen) {
    try {
      this.store.transaction(() => {
        const values = {};
        const events = [];
        const frozen = node.type === 'cache' && state.frozen.has(node.id);
        if (node.type === 'merge' && node.config.mode === 'selected') values[chosen.target.port] = this.edgeValue(state, scope, chosen);
        else if (!frozen) for (const port of Object.keys(nodePorts(node).inputs)) values[port] = this.inputValue(state, scope, node.id, port);
        let outputs = {};
        if (node.type === 'text') outputs = { text: textValue(this.store.putText(node.config.value)) };
        else if (node.type === 'prompt-template') {
          const texts = Object.fromEntries(node.config.slots.map(slot => [slot.id, this.store.readText(values[slot.id].artifact.artifactId)]));
          outputs = { text: textValue(this.store.putText(node.config.template.replace(/\{\{([a-z][a-z0-9-]{0,63})\}\}/g, (_, id) => texts[id]))) };
        } else if (node.type === 'merge' && node.config.mode === 'selected') outputs = { value: values[chosen.target.port] };
        else if (node.type === 'cache') {
          if (frozen) {
            const pin = state.plan.pins[node.id];
            this.store.verifyRef(pin.value.artifact);
            outputs = { value: pin.value };
            events.push({ type: 'cache.reused', nodeInstanceId: attempt.node_instance_id, attemptId: attempt.id, payload: { nodeId: node.id, pin: pin.value, sourceRunId: pin.sourceRunId, sourceAttemptId: pin.sourceAttemptId } });
          } else {
            if (values.value.type !== node.config.valueType) throw new UtilityError('output_contract', `Cache expects ${node.config.valueType}, got ${values.value.type}.`);
            outputs = { value: values.value };
            if (state.plan.refreshCaches.includes(node.id)) {
              this.storePin(state.workflow, node.id, values.value, state.id, attempt.id);
              events.push({ type: 'cache.pinned', nodeInstanceId: attempt.node_instance_id, attemptId: attempt.id, payload: { nodeId: node.id, pin: values.value, sourceRunId: state.id, sourceAttemptId: attempt.id } });
            }
          }
        } else if (node.type === 'route') {
          const selected = this.store.readJson(values.selector.artifact.artifactId);
          const found = resolvePointer(selected, node.config.selector);
          if (!found.found) throw new UtilityError('output_contract', `Route selector ${node.config.selector} does not exist.`);
          const match = routeCase(node.config.cases, found.value);
          if (match.error) throw new UtilityError('output_contract', `More than one Route case matches ${JSON.stringify(found.value)}.`);
          events.push({ type: 'route.selected', nodeInstanceId: attempt.node_instance_id, attemptId: attempt.id, payload: { caseId: match.caseId, selector: values.selector } });
          if (!match.caseId) throw new UtilityError('route_unmatched', `No Route case matches ${JSON.stringify(found.value)}${node.config.onUnmatched === 'pause' ? '; the run waits for your decision' : ''}.`);
          outputs = { [match.caseId]: values.value };
        } else if (node.type === 'gate') outputs = this.runGate(state, scope, node, attempt, values, events);
        else if (node.type !== 'result-viewer') outputs = runUtility({ store: this.store, node, inputs: values, cwd: this.workspaceOf(state).cwd });
        const committed = [this.commitInputs(state, attempt, values)];
        committed.push(...this.attemptTransition(attempt, 'running', 'Static node started.'));
        committed.push(...events);
        committed.push(this.commitOutputs(state, attempt, outputs));
        committed.push(...this.attemptTransition(attempt, 'succeeded', 'Static node committed its outputs.'));
        this.store.appendEvents(state.id, committed);
      });
    } catch (error) {
      const code = error instanceof CorruptionError ? 'corruption' : error instanceof UtilityError ? error.code : 'output_contract';
      if (code === 'route_unmatched') {
        // The route.selected observation is part of the evidence even though the attempt fails.
        this.store.transaction(() => this.store.appendEvents(state.id, [{ type: 'route.selected', nodeInstanceId: attempt.node_instance_id, attemptId: attempt.id, payload: { caseId: null, selector: this.inputValue(state, scope, node.id, 'selector') } }]));
      }
      this.failAttempt(state, attempt, code, error.message);
    }
  }

  // ---------- Gate ----------
  putRecord(state, kind, record) {
    const artifact = this.store.putJson(record);
    this.store.run('INSERT OR IGNORE INTO pipeline_records(id, run_id, kind, artifact_id, created_at) VALUES (?, ?, ?, ?, ?)', record.recordId, state.id, kind, artifact.artifactId, nowIso());
    const row = this.store.get('SELECT * FROM pipeline_records WHERE id = ?', record.recordId);
    return { recordId: record.recordId, artifact: { artifactId: row.artifact_id, sha256: this.store.artifactRow(row.artifact_id).sha256 } };
  }

  recordLookup() {
    return id => {
      const row = this.store.get('SELECT * FROM pipeline_records WHERE id = ?', id);
      if (!row) return null;
      return { kind: row.kind, ref: { recordId: id, artifact: { artifactId: row.artifact_id, sha256: this.store.artifactRow(row.artifact_id).sha256 } }, value: this.store.readJson(row.artifact_id) };
    };
  }

  // The Agent that reviews a slot: wired directly or as one alternative of a selected Merge.
  slotReviewer(scope, evaluateNode, slotId) {
    const edge = scope.graph.edges.find(item => item.target.nodeId === evaluateNode.id && item.target.port === slotId);
    if (!edge) return null;
    const source = scope.nodes.get(edge.source.nodeId);
    if (source?.type === 'agent') return { agent: source, merge: null };
    if (source?.type === 'merge' && source.config.mode === 'selected') {
      const alternatives = scope.graph.edges.filter(item => item.target.nodeId === source.id).map(item => ({ edge: item, node: scope.nodes.get(item.source.nodeId) }));
      const agent = alternatives.find(item => item.node?.type === 'agent' && item.edge.source.port === 'json');
      return agent ? { agent: agent.node, merge: source, alternatives } : null;
    }
    return null;
  }

  // Reviewer fingerprint: a Merkle hash of every definition upstream of the reviewing Agent's inputs
  // and After prerequisites (instructions through any template slot, selectors, the Agent and its
  // Context policy), stopping at the prepare Gate whose subject-derived values the scope hash covers,
  // plus the native profile. Inputs whose content cannot be established from definitions fail closed
  // (null → live review): other Agents, Loops, Maps or Gates, workspace files, Loop boundary values, a
  // Continue Context, and any Context another node also writes (its native history is unprovable).
  reviewerFingerprint(state, scope, agent, prepareId) {
    let unknown = false;
    const memo = new Map();
    const visit = id => {
      if (id === prepareId) return 'subject';
      if (id === INPUT) { unknown = true; return null; }
      if (memo.has(id)) return memo.get(id);
      memo.set(id, null);
      const node = scope.nodes.get(id);
      if (!node || (id !== agent.id && ['agent', 'loop', 'map', 'gate'].includes(node.type)) || (node.type === 'file-input' && node.config.mode === 'files')) unknown = true;
      let context = null;
      if (node?.type === 'agent' && node.config.contextId) {
        context = scope.nodes.get(node.config.contextId) || this.contextNodes(state.workflow).find(item => item.node.id === node.config.contextId)?.node;
        if (!context || context.config.mode === 'continue') unknown = true;
        const writers = allNodesDeep(state.workflow.nodes).filter(other => other.id !== node.id && contextIdsOf(other).includes(node.config.contextId));
        if (writers.length) unknown = true;
      }
      const inputs = scope.graph.edges.filter(edge => edge.target.nodeId === id).map(edge => [edge.target.port, edge.source.port, visit(edge.source.nodeId)]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
      const after = scope.graph.after.filter(pair => pair.after === id).map(pair => visit(pair.before)).sort();
      const value = canonicalHash({ type: node?.type ?? null, config: node?.config ?? null, context: context?.config ?? null, inputs, after });
      memo.set(id, value);
      return value;
    };
    const closure = visit(agent.id);
    return unknown ? null : canonicalHash({ version: 4, closure, nativeConfiguration: state.workflow.settings.nativeConfiguration });
  }

  runGate(state, scope, node, attempt, values, events) {
    const config = node.config;
    if (config.mode === 'prepare') {
      const evaluator = scope.graph.edges.filter(item => item.source.nodeId === node.id && item.source.port === 'plan').map(item => scope.nodes.get(item.target.nodeId))
        .find(item => item?.type === 'gate' && item.config.mode === 'evaluate');
      const reviewerFingerprints = {};
      if (evaluator) for (const slot of config.policy.slots) {
        const found = this.slotReviewer(scope, evaluator, slot.id);
        if (found) reviewerFingerprints[slot.id] = this.reviewerFingerprint(state, scope, found.agent, node.id);
      }
      const result = config.subject === 'delivery'
        ? gate.prepareDelivery({ store: this.store, config, inputs: values, readRecord: this.recordLookup() })
        : gate.prepare({ store: this.store, config, inputs: values, reviewerFingerprints, readRecord: this.recordLookup() });
      events.push({ type: 'gate.evaluated', nodeInstanceId: attempt.node_instance_id, attemptId: attempt.id, payload: result.event });
      return result.outputs;
    }
    if (config.mode === 'evaluate') {
      const reviewers = {};
      for (const slot of config.policy.slots) {
        const found = this.slotReviewer(scope, node, slot.id);
        const source = found ? this.latestAttempt(state.id, scope.prefix + found.agent.id) : null;
        // Only a live Agent answer that actually reached this slot names a reviewer.
        if (!source || !DONE_OK.has(source.state) || !source.outputs_artifact_id) continue;
        const outputs = this.store.readJson(source.outputs_artifact_id);
        reviewers[slot.id] = { nodeInstanceId: source.node_instance_id, attemptId: source.id, requestedModel: outputs.providerResult?.requestedModel || 'unknown', observedModel: outputs.providerResult?.observedModel ?? null };
      }
      const now = nowIso();
      const result = gate.evaluate({ store: this.store, config, inputs: values, reviewers, runId: state.id, now, readRecord: this.recordLookup() });
      const reviewRefs = result.records.map(record => this.putRecord(state, record.kind, record));
      for (const record of result.records.filter(item => item.kind === 'ReviewCarry'))
        events.push({ type: 'gate.review_carried', nodeInstanceId: attempt.node_instance_id, attemptId: attempt.id, payload: { slot: record.slot, subjectId: record.subjectId, priorSubjectId: record.priorSubjectId,
          record: reviewRefs.find(item => item.recordId === record.recordId), priorReview: record.priorReview } });
      let certificate = null;
      if (result.status === 'OPEN') certificate = this.putRecord(state, 'GateCertificate', gate.certificateFor({ plan: result.plan, reviewRefs, runId: state.id, now }));
      const report = gate.report({ status: result.status, subjectId: result.plan.subjectId, reason: result.reason, issues: result.issues, certificate });
      events.push({ type: 'gate.evaluated', nodeInstanceId: attempt.node_instance_id, attemptId: attempt.id, payload: { mode: 'evaluate', subjectId: result.plan.subjectId, status: result.status, recordId: certificate?.recordId ?? null } });
      return { report: jsonValue(this.store.putJson(report)), certificate: jsonValue(this.store.putJson(certificate)) };
    }
    const result = gate.verify({ store: this.store, config, inputs: values, lookupRecord: id => this.store.get('SELECT * FROM pipeline_records WHERE id = ?', id) });
    const report = gate.report({ status: result.status, subjectId: result.subjectId, reason: result.reason, issues: [], certificate: result.certificate });
    events.push({ type: 'gate.evaluated', nodeInstanceId: attempt.node_instance_id, attemptId: attempt.id, payload: { mode: 'verify', subjectId: result.subjectId, status: result.status, recordId: result.certificate?.recordId ?? null } });
    return { report: jsonValue(this.store.putJson(report)) };
  }

  // ---------- Loops ----------
  loopRow(state, loopInstance) { return this.store.get('SELECT * FROM loop_executions WHERE run_id = ? AND loop_node_id = ?', state.id, loopInstance); }

  activeMs(runId, loopInstance, row) {
    const runtime = this.runs.get(runId)?.loops.get(loopInstance);
    const base = row?.active_ms ?? 0;
    return Math.round(runtime && runtime.running > 0 ? base + (performance.now() - runtime.since) : base);
  }

  validCarry(loop, value) {
    if (value.type !== loop.config.valueType) return `expected ${loop.config.valueType}, got ${value.type}`;
    if (value.type === 'JsonValue') {
      const issues = compileOutputSchema(loop.config.stateSchema)(this.store.readJson(value.artifact.artifactId));
      if (issues.length) return `state does not match stateSchema: ${issues.map(issue => `${issue.path} ${issue.message}`).join('; ')}`;
    }
    if (value.type === 'ArtifactSet') this.values.readManifest(value.artifact);
    return null;
  }

  startLoop(state, scope, loop, attempt) {
    const loopInstance = attempt.node_instance_id;
    let values;
    try {
      values = {};
      for (const port of Object.keys(nodePorts(loop).inputs)) values[port] = this.inputValue(state, scope, loop.id, port);
      const invalid = this.validCarry(loop, values.seed);
      if (invalid) throw new UtilityError('output_contract', `Loop seed is invalid: ${invalid}.`);
    } catch (error) {
      return this.failAttempt(state, attempt, error.code === 'corruption' ? 'corruption' : 'output_contract', error.message);
    }
    this.store.transaction(() => {
      const events = [this.commitInputs(state, attempt, values)];
      events.push(...this.attemptTransition(attempt, 'running', 'Loop started.'));
      const { maxIterations, maxActiveMinutes } = loop.config.limits;
      this.store.run(`INSERT INTO loop_executions(run_id, loop_node_id, attempt_id, state, iteration, max_iterations, max_active_minutes, active_ms, pause_reason) VALUES (?, ?, ?, 'running', 1, ?, ?, 0, NULL)`,
        state.id, loopInstance, attempt.id, maxIterations, maxActiveMinutes);
      this.loopRuntime(state, loopInstance);
      events.push({ type: 'loop.started', nodeInstanceId: loopInstance, attemptId: attempt.id, payload: { loopNodeId: loopInstance, maxIterations, maxActiveMinutes, seed: values.seed } });
      this.startIteration(state, loopInstance, attempt, 1, values.seed, textValue(this.store.putText('')), events, false);
      this.store.appendEvents(state.id, events);
    });
  }

  startIteration(state, loopInstance, loopAttempt, iteration, value, feedback, events, restart) {
    const now = nowIso();
    const loop = this.loopNode(state, loopInstance);
    if (restart) this.store.run(`UPDATE loop_iterations SET outcome = 'running', started_at = ?, ended_at = NULL, candidate_json = NULL, decision_json = NULL WHERE run_id = ? AND loop_node_id = ? AND iteration = ?`, now, state.id, loopInstance, iteration);
    else this.store.run(`INSERT INTO loop_iterations(run_id, loop_node_id, iteration, value_json, feedback_json, candidate_json, decision_json, outcome, started_at, ended_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'running', ?, NULL)`,
      state.id, loopInstance, iteration, canonicalize(value), canonicalize(feedback), now);
    this.store.run(`UPDATE loop_executions SET iteration = ? WHERE run_id = ? AND loop_node_id = ?`, iteration, state.id, loopInstance);
    const body = loop.config.body;
    const scope = this.scopeFor(state, bodyPrefix(loopInstance, iteration));
    const workspace = this.workspaceOf(state);
    for (const context of body.nodes.filter(node => node.type === 'context' && node.config.lifetime === 'iteration')) {
      const key = scope.prefix + context.id;
      if (!this.store.get('SELECT 1 FROM run_context_bindings WHERE run_id = ? AND context_node_id = ?', state.id, key))
        this.store.run('INSERT INTO run_context_bindings(run_id, context_node_id, mode, binding_id) VALUES (?, ?, ?, ?)', state.id, key, 'new', this.createBinding(state.id, workspace, context.config.provider, key));
    }
    events.push({ type: 'loop.iteration_started', nodeInstanceId: loopInstance, attemptId: loopAttempt.id, payload: { loopNodeId: loopInstance, iteration, value, feedback, restart } });
    const nodes = new Map(body.nodes.map(node => [node.id, node]));
    const required = requiredSet(body, returnSources(body), state.frozen);
    for (const id of topologicalOrder(body).filter(item => required.has(item))) {
      if (restart) {
        const latest = this.latestAttempt(state.id, scope.prefix + id);
        if (latest && UNSTARTED.has(latest.state)) events.push(...this.attemptTransition(latest, 'canceled', 'Superseded by an iteration restart.'));
      }
      this.planAttempt(state, scope.prefix + id, id, nodes.get(id).type, { loopNodeId: loopInstance, iteration }, events, restart ? 'Iteration restarted.' : 'Planned for this iteration.');
    }
  }

  returnValue(state, scope, port) {
    const edge = scope.graph.edges.find(item => item.target.nodeId === RETURN && item.target.port === port);
    if (edge.source.nodeId === INPUT) return { value: this.boundaryValue(state, scope, edge.source.port) };
    const status = this.inputStatus(state, scope, edge);
    if (status === 'inactive') return { inactive: true };
    if (status !== 'active') return null;
    return { value: this.edgeValue(state, scope, edge) };
  }

  maybeReturn(state, loopInstance) {
    const row = this.loopRow(state, loopInstance);
    if (row?.state !== 'running' || state.loops.get(loopInstance)?.pending) return;
    const scope = this.scopeFor(state, bodyPrefix(loopInstance, row.iteration));
    if (!this.scopeActive(state, scope)) return;
    const iteration = this.store.get('SELECT * FROM loop_iterations WHERE run_id = ? AND loop_node_id = ? AND iteration = ?', state.id, loopInstance, row.iteration);
    if (iteration?.outcome !== 'running') return;
    const loop = this.loopNode(state, loopInstance);
    const candidateResult = this.returnValue(state, scope, 'candidate');
    const decisionResult = this.returnValue(state, scope, 'decision');
    if (!candidateResult || !decisionResult) return;
    const loopAttempt = this.store.get('SELECT * FROM attempts WHERE id = ?', row.attempt_id);
    let problem = candidateResult.inactive || decisionResult.inactive ? 'a Loop Return source is inactive (skipped by a Route); join alternatives with a selected Merge' : null;
    const candidate = candidateResult.value, decisionValue = decisionResult.value;
    let decision;
    if (!problem) problem = this.validCarry(loop, candidate);
    if (!problem) {
      if (decisionValue.type !== 'JsonValue') problem = 'the decision must be JsonValue';
      else {
        decision = this.store.readJson(decisionValue.artifact.artifactId);
        const issues = check('loop-decision.schema.json', null, decision);
        if (issues.length) problem = `the decision violates the loop-decision contract (${issues.map(issue => `${issue.path} ${issue.message}`).join('; ')})`;
      }
    }
    this.store.transaction(() => {
      const events = [];
      if (problem) {
        events.push({ type: 'attempt.error', nodeInstanceId: loopInstance, attemptId: loopAttempt.id, payload: { code: 'output_contract', message: `Iteration ${row.iteration} returned an invalid value: ${problem}.`, evidence: null } });
        this.pauseLoop(state, loopInstance, 'body_failure', `Invalid loop return: ${problem}.`, events);
        this.latchFailure(state, events);
        this.store.appendEvents(state.id, events);
        return;
      }
      events.push({ type: 'loop.iteration_returned', nodeInstanceId: loopInstance, attemptId: loopAttempt.id, payload: { loopNodeId: loopInstance, iteration: row.iteration, candidate, decision: decisionValue, continue: decision.continue, reason: decision.reason } });
      this.store.run(`UPDATE loop_iterations SET candidate_json = ?, decision_json = ?, outcome = ?, ended_at = ? WHERE run_id = ? AND loop_node_id = ? AND iteration = ?`,
        canonicalize(candidate), canonicalize(decisionValue), decision.continue ? 'continued' : 'finished', nowIso(), state.id, loopInstance, row.iteration);
      const step = loopStep({ iteration: row.iteration, maxIterations: row.max_iterations, continue: decision.continue });
      if (step === 'finish') {
        const activeMs = this.closeActiveSegment(state, loopInstance);
        this.store.run(`UPDATE loop_executions SET state = 'finished', active_ms = ? WHERE run_id = ? AND loop_node_id = ?`, activeMs, state.id, loopInstance);
        events.push({ type: 'loop.finished', nodeInstanceId: loopInstance, attemptId: loopAttempt.id, payload: { loopNodeId: loopInstance, iterations: row.iteration, result: candidate, activeMs } });
        events.push(this.commitOutputs(state, loopAttempt, { result: candidate, decision: decisionValue }));
        events.push(...this.attemptTransition(loopAttempt, 'succeeded', `Checker finished the loop after ${row.iteration} iteration(s).`));
      } else if (step === 'pause_iteration_limit') {
        this.store.run(`UPDATE loop_iterations SET outcome = 'paused' WHERE run_id = ? AND loop_node_id = ? AND iteration = ?`, state.id, loopInstance, row.iteration);
        this.pauseLoop(state, loopInstance, 'iteration_limit', `The checker asked to continue after the last permitted iteration (${row.max_iterations}).`, events);
      } else {
        this.startIteration(state, loopInstance, loopAttempt, row.iteration + 1, candidate, textValue(this.store.putText(decision.feedback)), events, false);
      }
      this.store.appendEvents(state.id, events);
    });
    this.pumpAgain = true;
  }

  pauseLoop(state, loopInstance, reason, message, events) {
    const row = this.loopRow(state, loopInstance);
    if (!row || row.state !== 'running') return;
    const activeMs = this.closeActiveSegment(state, loopInstance);
    this.store.run(`UPDATE loop_executions SET state = 'paused', pause_reason = ?, active_ms = ? WHERE run_id = ? AND loop_node_id = ?`, reason, activeMs, state.id, loopInstance);
    this.store.run(`UPDATE loop_iterations SET outcome = 'paused' WHERE run_id = ? AND loop_node_id = ? AND iteration = ? AND outcome = 'running'`, state.id, loopInstance, row.iteration);
    const loopAttempt = this.store.get('SELECT * FROM attempts WHERE id = ?', row.attempt_id);
    events.push({ type: 'loop.paused', nodeInstanceId: loopInstance, attemptId: loopAttempt.id, payload: { loopNodeId: loopInstance, iteration: row.iteration, reason, message, activeMs } });
    events.push(...this.attemptTransition(loopAttempt, 'waiting', `Loop paused: ${reason}.`));
    const runtime = state.loops.get(loopInstance);
    if (runtime) runtime.pending = null;
  }

  resumeLoop(state, loopInstance, reason, events) {
    const row = this.loopRow(state, loopInstance);
    this.store.run(`UPDATE loop_executions SET state = 'running', pause_reason = NULL WHERE run_id = ? AND loop_node_id = ?`, state.id, loopInstance);
    this.store.run(`UPDATE loop_iterations SET outcome = 'running' WHERE run_id = ? AND loop_node_id = ? AND iteration = ? AND outcome = 'paused'`, state.id, loopInstance, row.iteration);
    const loopAttempt = this.store.get('SELECT * FROM attempts WHERE id = ?', row.attempt_id);
    events.push({ type: 'loop.resumed', nodeInstanceId: loopInstance, attemptId: loopAttempt.id, payload: { loopNodeId: loopInstance, iteration: row.iteration, reason } });
    events.push(...this.attemptTransition(loopAttempt, 'running', `Loop resumed: ${reason}`));
  }

  // Pending pauses (time limit, scoped Stop) settle once the loop's body processes have exited.
  maybeSettlePause(state, loopInstance) {
    const runtime = state.loops.get(loopInstance);
    if (!runtime?.pending || runtime.running > 0) return;
    if (this.liveIn(state).some(record => record.loops.includes(loopInstance))) return;
    const [reason, message] = runtime.pending;
    this.store.transaction(() => { const events = []; this.pauseLoop(state, loopInstance, reason, message, events); this.store.appendEvents(state.id, events); });
    runtime.pending = null;
  }

  // Active time is the union of intervals with at least one running body process, per enclosing loop.
  bodyStarted(state, loopInstance) {
    const runtime = this.loopRuntime(state, loopInstance);
    if (runtime.running++ === 0) {
      runtime.since = performance.now();
      clearInterval(runtime.timer);
      runtime.timer = setInterval(() => this.checkTimeLimit(state, loopInstance), 200);
    }
  }
  bodyEnded(state, loopInstance) {
    const runtime = this.loopRuntime(state, loopInstance);
    if (--runtime.running === 0) {
      clearInterval(runtime.timer); runtime.timer = null;
      const row = this.loopRow(state, loopInstance);
      if (row) this.store.run('UPDATE loop_executions SET active_ms = ? WHERE run_id = ? AND loop_node_id = ?', Math.round(row.active_ms + performance.now() - runtime.since), state.id, loopInstance);
    }
  }
  closeActiveSegment(state, loopInstance) {
    const row = this.loopRow(state, loopInstance);
    const runtime = state.loops.get(loopInstance);
    if (!runtime || runtime.running === 0) return row.active_ms;
    const total = Math.round(row.active_ms + performance.now() - runtime.since);
    runtime.since = performance.now();
    this.store.run('UPDATE loop_executions SET active_ms = ? WHERE run_id = ? AND loop_node_id = ?', total, state.id, loopInstance);
    return total;
  }
  checkTimeLimit(state, loopInstance) {
    const row = this.loopRow(state, loopInstance);
    const runtime = state.loops.get(loopInstance);
    if (!row || row.state !== 'running' || runtime.pending) return;
    if (this.activeMs(state.id, loopInstance, row) <= row.max_active_minutes * this.loopMinuteMs) return;
    runtime.pending = ['time_limit', `Active time exceeded ${row.max_active_minutes} minute(s).`];
    this.stopLoopBody(state, loopInstance);
  }
  stopLoopBody(state, loopInstance) {
    for (const record of this.liveIn(state).filter(item => item.loops.includes(loopInstance))) {
      record.stopRequested = true;
      if (record.child?.pid && record.launched) killTree(record.child.pid);
    }
    queueMicrotask(() => this.pump());
  }

  // ---------- Agents ----------
  capacityAvailable(provider, settings) {
    const live = [...this.processes.values()].filter(record => record.provider);
    return live.length < settings.globalLimit && live.filter(item => item.provider === provider).length < settings.providerLimits[provider];
  }

  contextKey(state, scope, contextId) {
    const context = this.contextNodes(state.workflow).find(item => item.node.id === contextId)?.node;
    if (context?.config.lifetime !== 'iteration') return contextId;
    // The iteration of the loop that owns the Context: the innermost enclosing body that declares it.
    for (const { loopInstance, iteration } of enclosingLoops(scope.prefix)) {
      if (this.loopNode(state, loopInstance).config.body.nodes.some(node => node.id === contextId)) return bodyPrefix(loopInstance, iteration) + contextId;
    }
    return contextId;
  }

  // `spec` (Map steps) supplies the directory, Context mapping, prompt and answer hooks.
  tryDispatchAgent(state, scope, node, attempt, spec = null) {
    const workspace = spec?.workspace || this.workspaceOf(state);
    const mapping = spec ? spec.mapping : node.config.contextId ? this.store.get('SELECT * FROM run_context_bindings WHERE run_id = ? AND context_node_id = ?', state.id, this.contextKey(state, scope, node.config.contextId)) : null;
    const keys = [`cwd:${workspace.cwd_identity}`, ...(mapping ? [`binding:${mapping.binding_id}`] : [])].sort();
    const settings = this.currentSettings().settings;
    if (keys.some(key => this.locks.has(key)) || !this.capacityAvailable(node.config.provider, settings)) {
      if (attempt.state === 'scheduled') this.store.transaction(() => this.store.appendEvents(state.id, this.attemptTransition(attempt, 'waiting', 'Waiting for provider capacity or a directory/Context lock.')));
      return;
    }
    for (const key of keys) { this.locks.add(key); this.store.run('INSERT INTO resource_locks(resource_key, run_id, attempt_id, acquired_at) VALUES (?, ?, ?, ?)', key, state.id, attempt.id, nowIso()); }
    const record = { runId: state.id, loops: enclosingLoops(scope.prefix).map(item => item.loopInstance), provider: node.config.provider, keys, child: null, stopRequested: false, timedOut: false, launched: false };
    this.processes.set(attempt.id, record);
    this.executeAgent(state, scope, node, attempt, workspace, mapping, record, spec).catch(error => {
      try { this.failAttempt(state, this.store.get('SELECT * FROM attempts WHERE id = ?', attempt.id), error instanceof CorruptionError ? 'corruption' : error.code === 'input_unavailable' ? 'input_unavailable' : 'process', error.message); }
      catch (journalError) { this.storageUnavailable(journalError); }
    }).finally(() => this.releaseAgent(state, attempt, record));
  }

  releaseAgent(state, attempt, record) {
    for (const key of record.keys) { this.locks.delete(key); this.store.run('DELETE FROM resource_locks WHERE resource_key = ?', key); }
    this.processes.delete(attempt.id);
    if (record.counted) for (const loopInstance of record.loops) this.bodyEnded(state, loopInstance);
    record.resolveExit?.();
    this.pump();
  }

  async executeAgent(state, scope, node, attempt, workspace, mapping, record, spec = null) {
    const config = node.config;
    const requestedEffort = resolveEffort(config.effort);
    const nativeConfiguration = state.workflow.settings.nativeConfiguration;
    const detection = await this.detect(config.provider);
    attempt = this.store.get('SELECT * FROM attempts WHERE id = ?', attempt.id);
    if (this.runState(state.id) !== 'running' || !UNSTARTED.has(attempt.state) || !this.scopeActive(state, scope)) return;
    let binding = mapping ? this.store.get('SELECT * FROM context_bindings WHERE id = ?', mapping.binding_id) : null;
    if (binding && !['unbound', 'ready'].includes(binding.state)) return this.failAttempt(state, attempt, 'context_unavailable', `Context binding is ${binding.state}; it cannot be used for a new write.`);
    if (!detection.available || !detection.cliPath) {
      const code = /login|authentication|account/i.test(detection.reason || '') ? 'authentication' : /billing|credits|modelProvider/i.test(detection.reason || '') ? 'billing_policy' : 'provider_unavailable';
      return this.failAttempt(state, attempt, code, detection.reason || `${config.provider} is unavailable.`);
    }
    if (nativeConfiguration === 'inherit' && !detection.supportsInheritedConfiguration) return this.failAttempt(state, attempt, 'provider_unavailable', `${config.provider} cannot inherit native configuration.`);
    const configurationHash = canonicalHash({ provider: config.provider, accountIdentity: detection.accountIdentity, cwdIdentity: workspace.cwd_identity, nativeConfiguration, adapterVersion: ADAPTER_VERSION });
    if (binding && binding.state === 'ready') {
      if (binding.configuration_hash !== configurationHash || binding.cwd_identity !== workspace.cwd_identity) return this.failAttempt(state, attempt, 'context_unavailable', 'The Context binding was created with a different account, directory or native configuration.');
      if (!this.bindingRecord(binding).nativeSessionId) return this.failAttempt(state, attempt, 'context_unavailable', 'The Context binding has no native session to resume.');
    }
    // Preflight the native structured-output transport before any model request.
    let transport = null;
    if (config.output.format === 'json' && config.output.schema) {
      try { transport = transportSchema(config.output.schema); }
      catch (error) { return this.failAttempt(state, attempt, 'output_contract', `The output schema cannot be sent as ${config.provider} native structured output: ${error.message}`); }
    }
    record.launching = true;
    const nativeSessionId = binding ? this.bindingRecord(binding).nativeSessionId : null;
    const values = spec ? spec.values() : { prompt: this.inputValue(state, scope, node.id, 'prompt') };
    let prompt = this.store.readText(values.prompt.artifact.artifactId);
    const promptSources = [{ kind: 'input', artifact: ref(values.prompt.artifact) }];
    const tmp = join(this.store.workdirs, 'tmp', attempt.id);
    let attachments = null;
    if (config.attachFiles) {
      values.files = this.inputValue(state, scope, node.id, 'files');
      const manifest = this.values.readManifest(values.files.artifact);
      const folder = join(this.store.workdirs, 'attachments', attempt.id);
      const lines = [];
      for (const entry of manifest.entries) {
        const target = join(folder, ...entry.path.split('/'));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, this.store.readBytes(entry.artifact.artifactId).bytes, { mode: 0o444 });
        lines.push(`- ${entry.path} → ${target}`);
      }
      const section = `\n\nAttached files (read-only copies):\n${lines.join('\n') || '- (none)'}`;
      prompt += section;
      promptSources.push({ kind: 'attachments', artifact: ref(this.store.putText(section)) });
      attachments = ref(values.files.artifact);
    }
    prompt += outputContractText(config.output);
    if (config.output.format === 'json') promptSources.push({ kind: 'output-contract', artifact: ref(this.store.putText(outputContractText(config.output))) });
    const promptArtifact = this.store.putText(prompt);
    const schemaPath = transport ? join(tmp, 'output.schema.json') : null;
    const invocation = this.adapters.buildInvocation({ provider: config.provider, cliPath: detection.cliPath, model: config.model, effort: requestedEffort, prompt, cwd: workspace.cwd,
      nativeSessionId, output: transport ? { ...config.output, schema: transport.schema } : config.output, nativeConfiguration, timeoutSeconds: config.timeoutSeconds, schemaPath });
    invocation.env = { ...(invocation.env || process.env), DESZO_MANAGED_INVOCATION: this.runtimeInstanceId };
    let managedToolIsolation;
    try {
      managedToolIsolation = detection.fixture === true
        ? { mechanism: 'fixture-cli', checkedScopes: ['fixture'], bridgeEntries: [] }
        : await prepareManagedToolIsolation({ provider: config.provider, cliVersion: detection.cliVersion, cwd: invocation.cwd,
          args: invocation.args, bridgeScript: this.bridgeScript, runtimeInstanceId: this.runtimeInstanceId });
    } catch (error) {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(join(this.store.workdirs, 'attachments', attempt.id), { recursive: true, force: true });
      return this.failAttempt(state, attempt, error.code === 'managed_tool_isolation_unavailable' ? error.code : 'managed_tool_isolation_unavailable', error.message);
    }
    if (transport) { mkdirSync(tmp, { recursive: true }); writeFileSync(schemaPath, JSON.stringify(transport.schema)); }
    const sessionBefore = nativeSessionId ? ref(this.store.putJson({ provider: config.provider, nativeSessionId })) : null;
    const manifest = { schemaVersion: 1, runId: state.id, attemptId: attempt.id, provider: config.provider, requestedModel: config.model, requestedEffort,
      cliExecutable: invocation.command, cliVersion: detection.cliVersion || '', arguments: invocation.args, cwd: invocation.cwd, cwdIdentity: workspace.cwd_identity,
      nativeConfiguration, configurationHash, environmentPolicy: 'subscription-only', stdin: invocation.stdin === null ? null : ref(this.store.putText(invocation.stdin)),
      managedToolIsolation: { ...managedToolIsolation, runtimeInstanceId: this.runtimeInstanceId },
      timeoutSeconds: config.timeoutSeconds, nativeSessionBefore: sessionBefore, ...(attachments ? { attachments } : {}) };
    assertValid('attempt-record.schema.json', 'invocation', manifest, 'Invocation manifest');
    let current = this.store.get('SELECT * FROM attempts WHERE id = ?', attempt.id);
    this.store.transaction(() => {
      const events = [this.commitInputs(state, current, values, { prompt: ref(promptArtifact), promptSources, binding })];
      const invocationArtifact = this.store.putJson(manifest);
      this.store.run('UPDATE attempts SET invocation_artifact_id = ? WHERE id = ?', invocationArtifact.artifactId, attempt.id);
      events.push({ type: 'attempt.invocation_committed', nodeInstanceId: current.node_instance_id, attemptId: attempt.id, payload: { manifest: ref(invocationArtifact) } });
      if (binding) {
        const [event, updated] = this.bindingTransition(binding, 'writing', 'Agent invocation reserved the native conversation.', { accountIdentity: detection.accountIdentity, configurationHash, model: config.model });
        events.push(event); binding = updated;
      }
      this.store.appendEvents(state.id, events);
    });
    const outcome = await this.runProcess(state, current, node, invocation, record);
    rmSync(tmp, { recursive: true, force: true });
    rmSync(join(this.store.workdirs, 'attachments', attempt.id), { recursive: true, force: true });
    current = this.store.get('SELECT * FROM attempts WHERE id = ?', attempt.id);
    if (!outcome.launched) {
      this.restoreBindingBeforeLaunch(state, binding);
      return this.failAttempt(state, current, 'provider_unavailable', `The CLI could not be started: ${outcome.error}`);
    }
    const parser = outcome.parser.state;
    if (outcome.captureError) {
      const reason = `Capturing the CLI output failed (${outcome.captureError.code || 'error'}: ${outcome.captureError.message}); the process was stopped and nothing was committed.`;
      try {
        return this.failAttempt(state, current, 'capture_failed', reason, binding ? { binding, bindingTo: 'needs_review', bindingReason: 'Output capture failed; native history may have advanced.' } : {});
      } catch (error) { return this.storageUnavailable(error); }
    }
    const evidence = () => ref(this.store.putJson({ exitCode: outcome.code, signal: outcome.signal ?? null, providerError: parser.error, stderrTail: outcome.stderrTail }));
    const reported = parser.sessionId && binding && !this.bindingRecord(binding).nativeSessionId ? { nativeSessionId: parser.sessionId } : {};
    const native = binding ? { binding, bindingTo: 'needs_review', bindingReason: 'The invocation did not complete normally; native history may have advanced.', bindingChanges: reported } : {};
    const succeeded = outcome.code === 0 && !parser.error && parser.terminal && parser.finalText !== null;
    if (record.stopRequested && !succeeded) {
      return this.store.transaction(() => {
        const events = this.attemptTransition(current, 'canceled', record.stopReason || 'Stopped by the user.');
        if (binding) events.push(this.bindingTransition(binding, 'needs_review', native.bindingReason, reported)[0]);
        this.store.appendEvents(state.id, events);
      });
    }
    if (record.timedOut) return this.failAttempt(state, current, 'timeout', `The attempt exceeded ${config.timeoutSeconds} seconds of active process time.`, { evidence: evidence(), ...native });
    if (!succeeded) {
      const text = [parser.error, outcome.stderrTail].filter(Boolean).join('\n');
      if (outcome.code === 0 && !parser.error) return this.failAttempt(state, current, 'output_contract', parser.formatError || (parser.terminal ? 'The CLI reported no final answer.' : 'The CLI exited without a terminal event.'), { evidence: evidence(), ...native });
      return this.failAttempt(state, current, this.adapters.classifyFailure(text), text.trim().slice(0, 4000) || `The CLI exited with code ${outcome.code}.`, { evidence: evidence(), ...native });
    }
    if (binding && !parser.sessionId) return this.failAttempt(state, current, 'output_contract', 'The CLI did not report a native session ID, so continuation is unavailable.', { evidence: evidence(), ...native });
    let jsonArtifact = null, captured = null, parsed;
    if (config.output.format === 'json') {
      try { parsed = parseJsonAnswer(parser.finalText); if (transport) parsed = transport.decode(parsed); }
      catch (error) { return this.failAttempt(state, current, 'output_contract', `The final answer is not valid JSON: ${error.message}`, { evidence: evidence(), ...native }); }
      if (config.output.schema) {
        const issues = compileOutputSchema(config.output.schema)(parsed);
        if (issues.length) return this.failAttempt(state, current, 'output_contract', `The final answer does not match the output schema: ${issues.map(issue => `${issue.path} ${issue.message}`).join('; ')}`, { evidence: evidence(), ...native });
      }
      jsonArtifact = this.store.putJson(parsed);
    }
    if (spec?.check) {
      let problem;
      try { problem = spec.check(parsed, current); } catch (error) { problem = error.message; }
      if (problem) return this.failAttempt(state, current, 'output_contract', problem, { evidence: evidence(), ...native });
    }
    if (config.captures) {
      try { captured = this.values.putSet(captureFiles(this.store, workspace.cwd, config.captures, 'output_contract')); }
      catch (error) { return this.failAttempt(state, current, 'output_contract', `Declared output capture failed: ${error.message}`, { evidence: evidence(), ...native }); }
    }
    this.store.transaction(() => {
      const textArtifact = this.store.putText(parser.finalText);
      const outputValues = { text: textValue(textArtifact), ...(jsonArtifact ? { json: jsonValue(jsonArtifact) } : {}), ...(captured ? { files: captured } : {}) };
      const sessionArtifact = this.store.putJson({ provider: config.provider, nativeSessionId: parser.sessionId ?? null });
      const usage = parser.usage ? ref(this.store.putJson(parser.usage)) : null;
      const events = [this.commitOutputs(state, current, outputValues, { provider: config.provider, requestedModel: config.model, requestedEffort, observedModel: parser.model, nativeSession: ref(sessionArtifact), usage })];
      if (binding) {
        const first = !this.bindingRecord(binding).nativeSessionId;
        const [event, updated] = this.bindingTransition(binding, 'ready', 'Invocation committed; native conversation advanced.', { nativeSessionId: parser.sessionId });
        if (first) events.push({ type: 'context.bound', payload: { bindingId: binding.id, provider: config.provider, nativeSessionRef: ref(sessionArtifact), cwdIdentity: workspace.cwd_identity } });
        events.push(event); binding = updated;
      }
      spec?.commit?.(parsed, events, current, { provider: config.provider, requestedModel: config.model, observedModel: parser.model });
      events.push(...this.attemptTransition(current, 'succeeded', 'Outputs committed after a successful terminal event and process exit.'));
      this.store.appendEvents(state.id, events);
    });
  }

  restoreBindingBeforeLaunch(state, binding) {
    if (!binding || binding.state !== 'writing') return;
    const to = this.bindingRecord(binding).nativeSessionId ? 'ready' : 'unbound';
    this.store.transaction(() => this.store.appendEvents(state.id, [this.bindingTransition(binding, to, 'No process was launched; the native conversation did not change.')[0]]));
  }

  runProcess(state, attempt, node, invocation, record) {
    return new Promise(resolvePromise => {
      const parser = this.adapters.createParser(node.config.provider, { output: node.config.output });
      // Capture failures (for example a full disk) happen in stream callbacks and timers, outside
      // the awaited invocation: contain them, stop the owned process and report them distinctly.
      const fault = error => this.captureFault(record, error);
      // Every byte is durable as it arrives; the stream manifests are published when the process ends (ADR-0002 section 1).
      const extended = this.store.get('SELECT journal_version AS version FROM runs WHERE id = ?', state.id).version >= 2;
      const recorder = (stream, mediaType) => new StreamRecorder({ store: this.store, runId: state.id, attempt, stream, mediaType, onFault: fault, extended });
      const streams = { stdout: recorder('stdout', 'application/octet-stream'), stderr: recorder('stderr', 'application/octet-stream'), normalized: recorder('normalized', 'application/x-ndjson') };
      // Multibyte UTF-8 characters may be split across chunks; decode as a stream.
      const stdoutDecoder = new StringDecoder('utf8'), stderrDecoder = new StringDecoder('utf8');
      let stdoutRemainder = '', stderrTail = '', settled = false, timer = null;
      record.exited = new Promise(done => { record.resolveExit = done; });
      let child;
      try { child = this.launchContained(state.id, invocation); }
      catch (error) { resolvePromise({ launched: false, error: error.message, parser }); return; }
      record.child = child;
      const finish = (result, { complete = false } = {}) => {
        if (settled) return; settled = true; clearTimeout(timer);
        const endingReason = result.launched ? (result.signal ? `process ended by signal ${result.signal}` : `process exited with code ${result.code}`) : (result.error || 'process did not launch');
        let manifests = {};
        try { manifests = Object.fromEntries(Object.entries(streams).map(([name, stream]) => [name, stream.close(endingReason, { complete })])); }
        catch (error) { fault(error); }
        resolvePromise({ ...result, parser, stderrTail: stderrTail.slice(-8000), captureError: record.captureError ?? null, streams: manifests });
      };
      child.once('error', error => { if (!record.launched) finish({ launched: false, error: error.message }); });
      child.once('spawn', () => { try {
        record.launched = true;
        if (record.loops.length) { record.counted = true; for (const loopInstance of record.loops) this.bodyStarted(state, loopInstance); }
        const startIdentity = `${child.pid}@${new Date().toISOString()}`;
        this.store.run('UPDATE attempts SET process_id = ?, process_start_identity = ?, supervisor_generation = ?, started_at = ? WHERE id = ?', child.pid, startIdentity, this.supervisorGeneration, nowIso(), attempt.id);
        const current = this.store.get('SELECT * FROM attempts WHERE id = ?', attempt.id);
        this.store.transaction(() => this.store.appendEvents(state.id, this.attemptTransition(current, 'running', 'CLI process launched.', { pid: child.pid, startIdentity, supervisorGeneration: this.supervisorGeneration })));
        timer = record.timer = setTimeout(() => { record.timedOut = true; killTree(child.pid); }, node.config.timeoutSeconds * 1000);
        if (record.stopRequested) killTree(child.pid);
      } catch (error) { fault(error); } });
      child.stdout.on('data', chunk => {
        try {
          streams.stdout.add(chunk);
          const lines = (stdoutRemainder + stdoutDecoder.write(chunk)).split(/\r?\n/);
          stdoutRemainder = lines.pop();
          for (const line of lines) this.observe(parser, line, streams.normalized);
        } catch (error) { fault(error); }
      });
      child.stderr.on('data', chunk => {
        try { streams.stderr.add(chunk); stderrTail = (stderrTail + stderrDecoder.write(chunk)).slice(-16000); } catch (error) { fault(error); }
      });
      child.once('close', (code, signal) => {
        try {
          stdoutRemainder += stdoutDecoder.end();
          stderrTail += stderrDecoder.end();
          if (stdoutRemainder) this.observe(parser, stdoutRemainder, streams.normalized);
        } catch (error) { fault(error); }
        // A shim failure exit means the CLI never ran; it is reported as a launch failure, not as the CLI's own result.
        const shimFailure = this.supervisor ? shimFailureOf(code) : null;
        if (shimFailure) finish({ launched: false, error: `The launch shim could not start the CLI (${shimFailure}).` });
        else if (record.launched) finish({ launched: true, code, signal }, { complete: true });
        else finish({ launched: false, error: 'Process closed before launch.' });
      });
    });
  }

  captureFault(record, error) {
    if (record.captureError) return;
    record.captureError = error;
    if (record.child?.pid && record.launched) killTree(record.child.pid);
  }

  // The store itself could not be written: refuse new work and stop owned processes. Durable
  // state stays as last committed; restart recovery marks the affected runs interrupted.
  storageUnavailable(error) {
    this.recoveryBlocked = `The runtime could not write its store (${error.code || 'error'}: ${error.message}). Free space or fix the data folder, then restart; affected runs are recovered as interrupted.`;
    this.closing = true;
    for (const record of this.processes.values()) { record.stopRequested = true; if (record.child?.pid && record.launched) killTree(record.child.pid); }
    process.stderr.write(`${this.recoveryBlocked}\n`);
  }

  observe(parser, line, normalizedBatch) {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    const normalized = parser.feed(event);
    const observation = { sessionId: normalized.sessionId || undefined, text: normalized.text || undefined, model: normalized.model || undefined, terminal: parser.state.terminal || undefined, error: parser.state.error || undefined };
    if (Object.values(observation).some(value => value !== undefined)) normalizedBatch.add(Buffer.from(JSON.stringify(observation) + '\n'));
  }

  // ---------- Stop ----------
  cancelLoops(runId, events, reason) {
    for (const loop of this.store.all(`SELECT * FROM loop_executions WHERE run_id = ? AND state IN ('running','paused')`, runId)) {
      this.store.run(`UPDATE loop_executions SET state = 'canceled', pause_reason = NULL WHERE run_id = ? AND loop_node_id = ?`, runId, loop.loop_node_id);
      this.store.run(`UPDATE loop_iterations SET outcome = 'canceled', ended_at = ? WHERE run_id = ? AND loop_node_id = ? AND outcome IN ('running','paused')`, nowIso(), runId, loop.loop_node_id);
      const attempt = this.store.get('SELECT * FROM attempts WHERE id = ?', loop.attempt_id);
      if (!TERMINAL_ATTEMPT.has(attempt.state)) events.push(...this.attemptTransition(attempt, 'canceled', reason));
    }
  }

  stopRun(runId, body) {
    this.validateBody('stopRequest', body);
    let shouldSignalProcesses = false;
    return this.idempotent(`POST /runs/${runId}/stop`, body.requestId, body, () => {
      const row = this.requireRun(runId);
      if (TERMINAL_RUN.has(row.state)) return { status: 200, body: { runId, state: row.state, requestId: body.requestId } };
      if (row.state !== 'stopping') {
        shouldSignalProcesses = true;
        this.store.transaction(() => {
          const events = [this.runEvent(row, 'stopping', 'Root Stop requested.')];
          const loopAttempts = new Set([...this.store.all('SELECT attempt_id FROM loop_executions WHERE run_id = ?', runId).map(item => item.attempt_id), ...this.mapAttemptIds(runId)]);
          for (const attempt of this.latestAttempts(runId).filter(item => UNSTARTED.has(item.state) && !this.processes.get(item.id)?.launching && !loopAttempts.has(item.id)))
            events.push(...this.attemptTransition(attempt, 'canceled', 'Canceled by root Stop before it started.'));
          this.cancelLoops(runId, events, 'Loop canceled by root Stop.');
          this.cancelMaps(runId, events, 'Map canceled by root Stop.');
          this.store.appendEvents(runId, events);
        });
      }
      return { status: 202, body: { runId, state: 'stopping', requestId: body.requestId } };
    }, () => {
      // The proof names every launched member, so termination is checked against what this Stop actually owned.
      if (shouldSignalProcesses) this.stopRequests.set(runId, { requestedAt: nowIso(), observed: true,
        pids: [...this.processes.entries()].filter(([, record]) => record.runId === runId && record.launched && record.child?.pid).map(([attemptId, record]) => ({ attemptId, pid: record.child.pid })) });
      if (shouldSignalProcesses) for (const record of this.processes.values()) if (record.runId === runId) {
        record.stopRequested = true;
        if (record.child?.pid && record.launched) killTree(record.child.pid);
      }
      queueMicrotask(() => this.pump());
    });
  }

  stopNode(runId, instanceId, body) {
    this.validateBody('nodeStopRequest', body);
    let loopToStop = null;
    let processToStop = null;
    return this.idempotent(`POST /runs/${runId}/nodes/${instanceId}/stop`, body.requestId, body, () => {
      const row = this.requireRun(runId);
      const state = this.runs.get(runId);
      if (!state || !['running', 'draining'].includes(row.state)) throw new ApiError(409, 'conflict', `The run is ${row.state}; a scoped Stop needs a running run.`);
      const attempt = this.latestAttempt(runId, instanceId);
      if (!attempt) throw new ApiError(404, 'not_found', `Node instance "${instanceId}" does not exist in this run.`);
      const loop = this.loopRow(state, instanceId);
      if (loop) {
        if (loop.state !== 'running') throw new ApiError(409, 'conflict', `Loop "${instanceId}" is ${loop.state}.`);
        loopToStop = { state, instanceId };
      } else {
        const record = this.processes.get(attempt.id);
        if (!record || attempt.state !== 'running') throw new ApiError(409, 'conflict', `"${instanceId}" is not running.`);
        processToStop = record;
      }
      return { status: 202, body: { runId, state: row.state, requestId: body.requestId } };
    }, () => {
      if (loopToStop) {
        this.loopRuntime(loopToStop.state, loopToStop.instanceId).pending = ['stopped', 'Stopped by the user.'];
        this.stopLoopBody(loopToStop.state, loopToStop.instanceId);
      } else if (processToStop) {
        processToStop.stopRequested = true;
        processToStop.stopReason = 'Stopped by the user (scoped Stop).';
        if (processToStop.child?.pid && processToStop.launched) killTree(processToStop.child.pid);
        queueMicrotask(() => this.pump());
      }
    });
  }

  // ---------- Recovery ----------
  recoverRun(runId, body) {
    this.validateBody('recoveryRequest', body);
    return this.idempotent(`POST /runs/${runId}/recovery`, body.requestId, body, () => {
      const row = this.requireRun(runId);
      const state = this.runs.get(runId);
      if (row.state !== 'waiting_for_user' || !state) throw new ApiError(409, 'conflict', `Recovery needs a run that is waiting for the user (state is ${row.state}).`);
      const target = body.nodeInstanceId ?? body.loopNodeId ?? null;
      const options = Object.fromEntries(Object.entries(body).filter(([key]) => !['requestId', 'action', 'nodeInstanceId', 'loopNodeId'].includes(key)));
      return this.store.transaction(() => {
        const events = [{ type: 'run.recovery_requested', payload: { action: body.action, target, requestId: body.requestId, options } }];
        if (body.action === 'close') {
          const loopAttempts = new Set([...this.store.all('SELECT attempt_id FROM loop_executions WHERE run_id = ?', runId).map(item => item.attempt_id), ...this.mapAttemptIds(runId)]);
          for (const attempt of this.latestAttempts(runId).filter(item => UNSTARTED.has(item.state) && !loopAttempts.has(item.id)))
            events.push(...this.attemptTransition(attempt, 'canceled', 'Closed by the user.'));
          this.cancelLoops(runId, events, 'Loop canceled when the run was closed.');
          this.cancelMaps(runId, events, 'Map canceled when the run was closed.');
          events.push(this.runEvent(row, 'failed', 'Closed by the user after a failure or pause.'));
          this.store.appendEvents(runId, events);
          this.forget(state);
          return { status: 200, body: { runId, state: 'failed', requestId: body.requestId } };
        }
        if (body.action === 'retry' && this.isMapStep(state, body.nodeInstanceId)) this.retryMapStep(state, body, events);
        else if (body.action === 'retry') this.retry(state, body, events);
        else if (body.action === 'raise-map-limit') this.raiseMapLimit(state, body, events);
        else if (body.action === 'raise-limit') this.raiseLimit(state, body, events);
        else this.restartIteration(state, body, events);
        events.push(this.runEvent(row, 'running', `Recovery: ${body.action}.`));
        this.store.appendEvents(runId, events);
        return { status: 202, body: { runId, state: 'running', requestId: body.requestId } };
      });
    }, () => queueMicrotask(() => this.pump()));
  }

  retry(state, body, events) {
    const attempt = this.latestAttempt(state.id, body.nodeInstanceId);
    if (!attempt) throw new ApiError(404, 'not_found', `Node instance "${body.nodeInstanceId}" does not exist in this run.`);
    if (!['failed', 'canceled'].includes(attempt.state)) throw new ApiError(409, 'conflict', `Only failed or canceled attempts can be retried (state is ${attempt.state}).`);
    if (this.loopRow(state, body.nodeInstanceId)) throw new ApiError(409, 'conflict', 'A started loop is recovered through raise-limit, restart-iteration or its body nodes.');
    const located = this.locate(state, body.nodeInstanceId);
    const { loopInstance, iteration } = parseInstance(body.nodeInstanceId);
    if (loopInstance) {
      const loop = this.loopRow(state, loopInstance);
      if (loop.iteration !== iteration) throw new ApiError(409, 'conflict', `Iteration ${iteration} is not the loop's current iteration.`);
      if (loop.state === 'paused' && ['iteration_limit', 'time_limit'].includes(loop.pause_reason)) throw new ApiError(409, 'conflict', `The loop is paused at its ${loop.pause_reason.replace('_', ' ')}; raise the limit first.`);
    }
    const node = located.node;
    if (node.type === 'agent' && node.config.contextId) {
      const key = this.contextKey(state, located.scope, node.config.contextId);
      const mapping = this.store.get('SELECT * FROM run_context_bindings WHERE run_id = ? AND context_node_id = ?', state.id, key);
      const binding = this.store.get('SELECT * FROM context_bindings WHERE id = ?', mapping.binding_id);
      const choice = body.binding || 'keep';
      if (choice === 'keep' && !['ready', 'unbound'].includes(binding.state)) throw new ApiError(422, 'context_unavailable', `The Context binding is ${binding.state}; retry with binding "acknowledge" or "fresh".`);
      if (choice === 'acknowledge' && binding.state === 'needs_review')
        events.push(this.bindingTransition(binding, this.bindingRecord(binding).nativeSessionId ? 'ready' : 'unbound', 'Accepted by the user for retry.', { acknowledgedAt: nowIso() })[0]);
      else if (choice === 'acknowledge' && !['ready', 'unbound'].includes(binding.state)) throw new ApiError(422, 'context_unavailable', `A ${binding.state} binding cannot be acknowledged.`);
      if (choice === 'fresh') {
        if (mapping.mode !== 'new') throw new ApiError(422, 'context_unavailable', 'A Continue Context cannot switch to a fresh binding; edit the workflow instead.');
        const fresh = this.createBinding(state.id, this.workspaceOf(state), binding.provider, key);
        this.store.run('UPDATE run_context_bindings SET binding_id = ? WHERE run_id = ? AND context_node_id = ?', fresh, state.id, key);
        events.push({ type: 'context.remapped', payload: { contextNodeId: key, fromBindingId: binding.id, toBindingId: fresh, reason: 'Fresh binding selected for retry.' } });
      }
    } else if (body.binding) throw new ApiError(409, 'conflict', 'binding applies only to Agents that use a Context.');
    this.planAttempt(state, body.nodeInstanceId, node.id, node.type, loopInstance ? { loopNodeId: loopInstance, iteration } : null, events, 'Retry requested by the user.');
    if (loopInstance && this.loopRow(state, loopInstance).state === 'paused') this.resumeLoop(state, loopInstance, 'A body node was retried.', events);
  }

  raiseLimit(state, body, events) {
    const loop = this.loopRow(state, body.loopNodeId);
    if (!loop) throw new ApiError(404, 'not_found', `Loop "${body.loopNodeId}" has not started in this run.`);
    if (loop.state !== 'paused' || !['iteration_limit', 'time_limit'].includes(loop.pause_reason)) throw new ApiError(409, 'conflict', 'raise-limit needs a loop paused at its iteration or time limit.');
    if (body.maxIterations < loop.max_iterations || body.maxActiveMinutes < loop.max_active_minutes) throw new ApiError(409, 'conflict', 'Limits can only be raised.');
    if (loop.pause_reason === 'iteration_limit' && body.maxIterations <= loop.iteration) throw new ApiError(409, 'conflict', `maxIterations must exceed the completed iteration ${loop.iteration}.`);
    if (loop.pause_reason === 'time_limit' && body.maxActiveMinutes * this.loopMinuteMs <= loop.active_ms) throw new ApiError(409, 'conflict', 'maxActiveMinutes must exceed the active time already used.');
    this.store.run('UPDATE loop_executions SET max_iterations = ?, max_active_minutes = ? WHERE run_id = ? AND loop_node_id = ?', body.maxIterations, body.maxActiveMinutes, state.id, body.loopNodeId);
    const loopAttempt = this.store.get('SELECT * FROM attempts WHERE id = ?', loop.attempt_id);
    events.push({ type: 'loop.limits_changed', nodeInstanceId: body.loopNodeId, attemptId: loopAttempt.id, payload: { loopNodeId: body.loopNodeId, maxIterations: body.maxIterations, maxActiveMinutes: body.maxActiveMinutes } });
    const reason = loop.pause_reason;
    this.resumeLoop(state, body.loopNodeId, 'Limits raised.', events);
    if (reason === 'iteration_limit') {
      const last = this.store.get('SELECT * FROM loop_iterations WHERE run_id = ? AND loop_node_id = ? AND iteration = ?', state.id, body.loopNodeId, loop.iteration);
      this.store.run(`UPDATE loop_iterations SET outcome = 'continued' WHERE run_id = ? AND loop_node_id = ? AND iteration = ?`, state.id, body.loopNodeId, loop.iteration);
      const decision = this.store.readJson(parseStrictJson(last.decision_json).artifact.artifactId);
      this.startIteration(state, body.loopNodeId, loopAttempt, loop.iteration + 1, parseStrictJson(last.candidate_json), textValue(this.store.putText(decision.feedback)), events, false);
    } else {
      const prefix = bodyPrefix(body.loopNodeId, loop.iteration);
      for (const attempt of this.latestAttempts(state.id).filter(item => item.node_instance_id.startsWith(prefix) && item.state === 'canceled' && !this.isMapStep(state, item.node_instance_id))) {
        const node = this.locate(state, attempt.node_instance_id).node;
        this.planAttempt(state, attempt.node_instance_id, node.id, node.type, { loopNodeId: body.loopNodeId, iteration: loop.iteration }, events, 'Re-planned after the time limit was raised.');
      }
    }
  }

  restartIteration(state, body, events) {
    const loop = this.loopRow(state, body.loopNodeId);
    if (!loop) throw new ApiError(404, 'not_found', `Loop "${body.loopNodeId}" has not started in this run.`);
    if (loop.state !== 'paused') throw new ApiError(409, 'conflict', 'restart-iteration needs a paused loop.');
    if (loop.pause_reason === 'time_limit') throw new ApiError(409, 'conflict', 'The loop is out of active time; raise the limit first.');
    const loopAttempt = this.store.get('SELECT * FROM attempts WHERE id = ?', loop.attempt_id);
    const iteration = this.store.get('SELECT * FROM loop_iterations WHERE run_id = ? AND loop_node_id = ? AND iteration = ?', state.id, body.loopNodeId, loop.iteration);
    this.resumeLoop(state, body.loopNodeId, 'Iteration restarted.', events);
    this.startIteration(state, body.loopNodeId, loopAttempt, loop.iteration, parseStrictJson(iteration.value_json), parseStrictJson(iteration.feedback_json), events, true);
  }

  readArtifact(artifactId) {
    const { bytes, row } = this.store.readBytes(artifactId);
    return { bytes, mediaType: row.media_type, sha256: row.sha256 };
  }

  async shutdown() {
    this.closing = true;
    const live = [...this.processes.values()];
    for (const record of live) { record.stopRequested = true; if (record.child?.pid && record.launched) await killTree(record.child.pid); }
    await Promise.all(live.map(record => record.exited).filter(Boolean));
    for (const state of this.runs.values()) for (const loop of state.loops.values()) clearInterval(loop.timer);
    await new Promise(done => setTimeout(done, 50));
    if (this.runtimeHeartbeat) clearInterval(this.runtimeHeartbeat);
    this.store.close();
  }
}

installMapRuntime(Engine, { ApiError, UNSTARTED });
installSupervision(Engine, { ApiError });

