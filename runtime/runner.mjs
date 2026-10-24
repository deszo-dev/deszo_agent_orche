import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { ApiError, Engine } from './core/engine.mjs';
import { ContractError } from './core/schemas.mjs';
import { CorruptionError } from './core/store.mjs';
import { supervisorFromEnvironment } from './core/supervisor-client.mjs';
import { hostFromEnvironment } from './host/runtimeBinding.mjs';
import { lifecycleBridgeFromEnvironment } from './host/lifecycleBridge.mjs';
import { autonomyGateway } from './host/uiGateway.mjs';
import { acquireRuntimeLock } from './lock.mjs';

const ORIGINS = new Set(['http://127.0.0.1:1420', 'http://localhost:1420', 'tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']);
const MAX_BODY = 4 * 1024 * 1024;
const MAX_RESPONSE = 4 * 1024 * 1024;
const PACKAGED_RUNTIME = typeof __DESZO_PACKAGED__ !== 'undefined' && __DESZO_PACKAGED__;
const ID = '[a-z][a-z0-9-]{0,63}';
const UUID = '[0-9a-fA-F-]{36}';

function problem(res, status, code, message, details = []) {
  json(res, status, { code, message, details });
}
function json(res, status, body, headers = {}) {
  let payload = JSON.stringify(body);
  let actualStatus = status;
  if (Buffer.byteLength(payload, 'utf8') > MAX_RESPONSE && status < 400) {
    actualStatus = 413;
    payload = JSON.stringify({ code: 'result_too_large', message: 'The response exceeds the runtime response limit.', details: [] });
  }
  res.writeHead(actualStatus, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(payload);
}

function atomicWrite(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}

function readOrCreateOwnerToken(path) {
  try {
    const token = readFileSync(path, 'utf8');
    if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error('The stored Runtime Owner Token is invalid.');
    return token;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const token = randomBytes(32).toString('hex');
    atomicWrite(path, token);
    return token;
  }
}

function equalSecret(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
  const supplied = Buffer.from(candidate);
  const secret = Buffer.from(expected);
  return supplied.length === secret.length && timingSafeEqual(supplied, secret);
}

async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw new ApiError(400, 'invalid_request', 'Request body is too large.'); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}

function query(url, allowed, integers = []) {
  const result = {};
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key)) throw new ApiError(400, 'invalid_request', `Unknown query parameter "${key}".`);
    if (key in result) throw new ApiError(400, 'invalid_request', `Repeated query parameter "${key}".`);
    if (integers.includes(key)) {
      if (!/^\d+$/.test(value)) throw new ApiError(400, 'invalid_request', `${key} must be a nonnegative integer.`);
      result[key] = Number(value);
    } else result[key] = value;
  }
  return result;
}

export async function startRunner({ root, connectionFile, bridgeFile, port = 0, supervised = false, adapters, maximumAgentTimeoutSeconds, loopMinuteMs, extraOrigins = [], runtimeInstanceId = randomUUID(), nodeExecutable = process.execPath, devTestConfirmationOff = false, exposeHostRequestForTests = false, judgeAttentionEnabled = false } = {}) {
  const origins = new Set([...ORIGINS, ...extraOrigins]);
  const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.deszo');
  root = resolve(root || defaultRoot);
  const sameRoot = process.platform === 'win32' ? root.toLowerCase() === defaultRoot.toLowerCase() : root === defaultRoot;
  if (devTestConfirmationOff && sameRoot) throw new Error('The fixture confirmation policy requires a dedicated runtime root, separate from the default .deszo store.');
  if (exposeHostRequestForTests && (PACKAGED_RUNTIME || !devTestConfirmationOff || sameRoot)) throw new Error('The test-only Host request helper requires an isolated, non-packaged fixture runtime.');
  connectionFile = resolve(connectionFile || join(root, 'runtime', 'connection.json'));
  bridgeFile = resolve(bridgeFile || join(dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'bridge.mjs'));
  await mkdir(join(root, 'runtime'), { recursive: true });
  const releaseLock = await acquireRuntimeLock(join(root, 'runtime', 'runner.lock'));
  const ownerTokenPath = join(root, 'runtime', 'owner-token');
  let token;
  try { token = readOrCreateOwnerToken(ownerTokenPath); }
  catch (error) { await releaseLock(); throw error; }
  const hostToken = randomBytes(32).toString('hex');
  let descriptor = null;
  let connection = null;
  let engine;
  let hostBinding = null;
  let lifecycleHost = null;
  try {
    lifecycleHost = lifecycleBridgeFromEnvironment(process.env);
    // ADR-0006: a runtime launched or covered by a Local Control Host binds to it before serving requests.
    hostBinding = await hostFromEnvironment(process.env, { packaged: PACKAGED_RUNTIME });
    if (PACKAGED_RUNTIME && devTestConfirmationOff) throw new Error('The packaged runtime does not support the fixture confirmation policy.');
    engine = new Engine({ root, adapters, runtimeInstanceId, nodeExecutable, bridgeScript: bridgeFile, supervisor: supervisorFromEnvironment(), hostAuthority: hostBinding?.adapter ?? null, hostRuntimeGeneration: hostBinding?.runtimeGeneration ?? null, hostPolicyId: hostBinding?.policyId ?? null,hostVerificationOnly:hostBinding?.verificationOnly===true,judgeAttentionEnabled,
      externalRunConfirmationOverride: devTestConfirmationOff ? false : null,
      lifecycleHost: lifecycleHost?.context ?? null,
      processContainment: supervised ? 'tauri-job' : 'standalone-best-effort', ...(maximumAgentTimeoutSeconds ? { maximumAgentTimeoutSeconds } : {}), ...(loopMinuteMs ? { loopMinuteMs } : {}) });
    await engine.initialize();
    engine.closePendingRunRequestsAtOwnerCutover();
    if (lifecycleHost) {
      const identity = engine.runtimeIdentity();
      const ready = await lifecycleHost.ready({ pid: process.pid, storeId: identity.storeId, runtimeInstanceId: identity.runtimeInstanceId });
      if (ready?.receipt) {
        await engine.applyHostLifecycleReceipt(ready.receipt);
        if (lifecycleHost.context.testDuplicateReceiptDelivery) {
          const replay = await lifecycleHost.ready({ pid: process.pid, storeId: identity.storeId, runtimeInstanceId: identity.runtimeInstanceId });
          if (replay?.receipt) await engine.applyHostLifecycleReceipt(replay.receipt);
        }
        await lifecycleHost.acknowledgeReceipt(ready.receipt.receiptId);
      }
      engine.on('lifecycle.operation_requested', request => {
        void lifecycleHost.activateCandidate(request).catch(error => engine.recordLifecycleHostDeliveryFailure(request, error));
      });
    }
    if (devTestConfirmationOff && !engine.store.get('SELECT id FROM workspaces LIMIT 1'))
      engine.putWorkspace('main', { cwd: join(engine.store.workdirs, 'scratch', 'main') });
  } catch (error) {
    hostBinding?.client.close();
    if (engine) { try { await engine.shutdown(); } catch { engine.store.close(); } }
    await releaseLock();
    throw error;
  }
  // The host delivers the native Stop scope of a committed revocation or expiry.
  // The stop reaches the owned runs; a failure here is reported and never silently dropped.
  hostBinding?.client.events.on('stop', message => {
    try { engine.stopHostPermits(message.permits, message.works); }
    catch (error) { process.stderr.write(`Local Control Host stop failed: ${error.message}\n`); }
  });
  const streams = new Set();
  let shuttingDown = false;

  const identifyCaller = req => {
    const match = /^Bearer ([a-f0-9]{64})$/i.exec(req.headers.authorization || '');
    if (!match) return null;
    const supplied = match[1];
    if (equalSecret(supplied, token)) return 'owner';
    if (equalSecret(supplied, hostToken)) return 'host';
    return null;
  };
  const parse = text => { try { return JSON.parse(text || '{}'); } catch (error) { throw new ApiError(400, 'invalid_request', `Malformed JSON: ${error.message}`); } };
  const writeEtag = req => {
    const ifMatch = req.headers['if-match'], ifNoneMatch = req.headers['if-none-match'];
    if (ifMatch !== undefined && ifNoneMatch !== undefined) throw new ApiError(400, 'invalid_request', 'Supply either If-Match or If-None-Match, not both.');
    if (ifNoneMatch !== undefined) {
      if (ifNoneMatch !== '*') throw new ApiError(400, 'invalid_request', 'Draft creation requires If-None-Match: *.');
      return null;
    }
    return ifMatch;
  };
  const bodyText = async req => {
    if (req.runtimeBodyText === undefined) req.runtimeBodyText = await readBody(req);
    return req.runtimeBodyText;
  };

  // Every incident or stop write records the authority the caller actually holds, not the one its body claims (ADR-0002 section 7).
  // A session id is recorded only when the controller credential for it is presented; a presented but unknown credential is refused.
  const controllerTokenOf = req => req.headers['x-deszo-controller-token'] ?? null;
  const reporterFor = (req, source) => {
    const token = controllerTokenOf(req);
    const session = token ? engine.controllerSessionFor(token) : null;
    if (token && !session) throw new ApiError(403, 'controller_credential_required', 'The controller credential is not recognised.');
    return { authority: 'external', sessionId: session?.id ?? null };
  };
  const routes = [
    ['POST', 'public', /^\/api\/v2\/owner-token\/rotate$/, async () => {
      const previous = token;
      const next = randomBytes(32).toString('hex');
      try {
        atomicWrite(ownerTokenPath, next);
        token = next;
        if (descriptor) { descriptor.token = next; atomicWrite(connectionFile, JSON.stringify(descriptor)); }
        if (connection) connection.token = next;
        if (hostBinding) await hostBinding.client.call('runtime.owner_token_rotated', { runtimeGeneration: hostBinding.runtimeGeneration, token: next });
      } catch {
        token = previous;
        atomicWrite(ownerTokenPath, previous);
        if (descriptor) { descriptor.token = previous; atomicWrite(connectionFile, JSON.stringify(descriptor)); }
        if (connection) connection.token = previous;
        if (connection) connection.firstPartyToken = previous;
        if (hostBinding) { try { await hostBinding.client.call('runtime.owner_token_rotated', { runtimeGeneration: hostBinding.runtimeGeneration, token: previous }); } catch { /* The old credential remains authoritative locally. */ } }
        throw new ApiError(503, 'owner_token_rotation_failed', 'The Owner Token could not be rotated across the Runtime and Host registration.');
      }
      if (connection) connection.firstPartyToken = next;
      return [200, { rotated: true, token: next }];
    }],
    ['GET', 'public', /^\/api\/v2\/autonomy$/, async () => {
      try { return [200, await autonomyGateway('status', null, hostBinding?.client)]; }
      catch (error) { return [200, { available: false, autonomyEnabled: false, reason: error.message }]; }
    }],
    ...[['proposals','propose'],['open-consent','open'],['revoke','revoke']].map(([path, operation]) => ['POST', 'public', new RegExp(`^/api/v2/autonomy/${path}$`), async ({ req }) => {
      try { return [200, await autonomyGateway(operation, parse(await bodyText(req)), hostBinding?.client)]; }
      catch (error) { throw new ApiError(error.status || 503, error.code || 'autonomy_unavailable', error.message); }
    }]),
    ['GET', 'public', /^\/api\/v3\/authoring\/contract$/, async () => [200, engine.authoringContract()]],
    ['GET', 'public', new RegExp(`^/api/v3/authoring/schemas/([^/]+)$`), ({ match }) => [200, engine.authoringSchema(decodeURIComponent(match[1]))]],
    ['GET', 'public', /^\/api\/v3\/authoring\/node-types$/, () => [200, engine.authoringNodeTypes()]],
    ['GET', 'public', /^\/api\/v3\/authoring\/templates$/, () => [200, { items: engine.authoringTemplates() }]],
    ['GET', 'public', new RegExp(`^/api/v3/authoring/templates/(${ID})$`), ({ match }) => [200, engine.authoringTemplate(match[1])]],
    ['GET', 'public', /^\/api\/v3\/authoring\/events$/, ({ url }) => {
      const params = query(url, ['after', 'limit'], ['after', 'limit']);
      return [200, engine.workflowChanges(params)];
    }],
    ['POST', 'public', /^\/api\/v3\/authoring\/bridge-handshake$/, async ({ req }) => [200, engine.registerBridge(parse(await bodyText(req))) ]],
    ['DELETE', 'public', new RegExp(`^/api/v3/authoring/bridge-handshake/(${UUID})$`), ({ match }) => { engine.unregisterBridge(match[1]); return [200, { removed: true }]; }],
    ['GET', 'public', /^\/api\/v3\/workflows$/, ({ url }) => [200, engine.listWorkflowsV3(query(url, ['limit', 'cursor'], ['limit']))]],
    ['POST', 'public', /^\/api\/v3\/workflows\/validate$/, async ({ req }) => {
      const body = parse(await bodyText(req));
      const workflow = body?.workflow ?? body;
      return [200, engine.validateWorkflow(workflow)];
    }],
    ['PUT', 'retired', new RegExp(`^/api/v3/workflows/(${ID})$`), async ({ req, match }) => {
      const retired = [410, { code: 'api_upgrade_required', message: 'Workflow saves require the Draft and Publication API.', details: [] }];
      if (req.authPrincipal !== 'owner') return retired;
      let body;
      try { body = parse(await bodyText(req)); } catch { return retired; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return retired;
      const ifMatch = req.headers['if-match'];
      const ifNoneMatch = req.headers['if-none-match'];
      let expectedEtag;
      if (ifMatch !== undefined && ifNoneMatch !== undefined) expectedEtag = '__invalid_precondition__';
      else if (ifNoneMatch !== undefined && ifNoneMatch !== '*') expectedEtag = '__invalid_precondition__';
      else {
        const headerEtag = ifNoneMatch === '*' ? null : ifMatch;
        expectedEtag = body.expectedEtag !== undefined && headerEtag !== undefined && body.expectedEtag !== headerEtag
          ? '__invalid_precondition__'
          : headerEtag !== undefined ? headerEtag : body.expectedEtag;
      }
      const replay = engine.replayCommittedReceipt(`PUT /api/v3/workflows/${match[1]}`, body.requestId, {
        workflowId: match[1], expectedEtag: expectedEtag === undefined ? '__missing_precondition__' : expectedEtag,
        workflow: body.workflow ?? null,
      });
      if (!replay.found) return retired;
      return [200, replay.response, { ETag: replay.response.etag }];
    }],
    ['GET', 'public', new RegExp(`^/api/v3/workflows/(${ID})$`), ({ match }) => {
      const saved = engine.getWorkflowV3(match[1]);
      return [200, saved, { ETag: saved.etag }];
    }],
    ['GET', 'public', /^\/api\/v4\/workflows$/, ({ url }) => [200, engine.listWorkflowLifecycle(query(url, ['limit', 'cursor'], ['limit']))]],
    ['GET', 'public', new RegExp(`^/api/v4/workflows/(${ID})/draft$`), ({ match }) => {
      const draft = engine.getWorkflowDraft(match[1]); return [200, draft, { ETag: draft.etag }];
    }],
    ['PUT', 'public', new RegExp(`^/api/v4/workflows/(${ID})/draft$`), async ({ req, match }) => {
      const result = engine.saveWorkflowDraft(match[1], parse(await bodyText(req)), writeEtag(req)); return [200, result, { ETag: result.etag }];
    }],
    ['POST', 'public', new RegExp(`^/api/v4/workflows/(${ID})/draft/validate$`), async ({ req, match }) => {
      const body = parse(await bodyText(req));
      if (Object.keys(body).length) throw new ApiError(400, 'invalid_request', 'Draft validation takes an empty JSON object and an If-Match ETag.');
      return [200, engine.validateWorkflowDraft(match[1], req.headers['if-match'])];
    }],
    ['POST', 'public', new RegExp(`^/api/v4/workflows/(${ID})/draft/from/([1-9][0-9]*)$`), async ({ req, match }) => {
      const result = engine.deriveWorkflowDraft(match[1], Number(match[2]), parse(await bodyText(req)), writeEtag(req)); return [200, result, { ETag: result.etag }];
    }],
    ['POST', 'public', new RegExp(`^/api/v4/workflows/(${ID})/publish$`), async ({ req, match }) => {
      const result = engine.publishWorkflowDraft(match[1], parse(await bodyText(req)), req.headers['if-match']); return [201, result, { ETag: result.etag }];
    }],
    ['GET', 'public', new RegExp(`^/api/v4/workflows/(${ID})/versions$`), ({ match, url }) => [200, engine.listWorkflowPublications(match[1], query(url, ['limit', 'cursor'], ['limit']))]],
    ['GET', 'public', new RegExp(`^/api/v4/workflows/(${ID})/versions/latest$`), ({ match }) => {
      const publication = engine.getLatestWorkflowPublication(match[1]); return [200, publication, { ETag: publication.etag }];
    }],
    ['GET', 'public', new RegExp(`^/api/v4/workflows/(${ID})/versions/([1-9][0-9]*)$`), ({ match }) => {
      const publication = engine.getWorkflowPublication(match[1], Number(match[2])); return [200, publication, { ETag: publication.etag }];
    }],
    ['GET', 'public', /^\/api\/v2\/capabilities$/, async () => [200, await engine.capabilities()]],
    ['GET', 'public', /^\/api\/v2\/settings$/, () => [200, engine.settingsBody()]],
    ['PUT', 'public', /^\/api\/v2\/settings$/, async ({ req }) => { const result = engine.updateSettings(parse(await bodyText(req))); return [result.status, result.body]; }],
    ['GET', 'public', /^\/api\/v2\/workspaces$/, ({ url }) => [200, engine.listWorkspaces(query(url, ['limit', 'cursor'], ['limit']))]],
    ['PUT', 'public', new RegExp(`^/api/v2/workspaces/(${ID})$`), async ({ req, match }) => [200, engine.putWorkspace(match[1], parse(await bodyText(req)))]],
    ['GET', 'public', /^\/api\/v2\/workflows$/, ({ url }) => [200, engine.listWorkflows(query(url, ['limit', 'cursor'], ['limit']))]],
    ['POST', 'public', /^\/api\/v2\/workflows\/validate$/, async ({ req }) => [200, engine.validateWorkflow(parse(await bodyText(req)))]],
    ['PUT', 'retired', new RegExp(`^/api/v2/workflows/(${ID})$`), () => [410, { code: 'api_upgrade_required', message: 'Workflow saves require the Draft and Publication API.', details: [] }]],
    ['GET', 'public', new RegExp(`^/api/v2/workflows/(${ID})$`), ({ match }) => [200, engine.getWorkflow(match[1])]],
    ['GET', 'public', new RegExp(`^/api/v2/workflows/(${ID})/cache-pins$`), ({ match }) => [200, engine.listPins(match[1])]],
    ['PUT', 'public', new RegExp(`^/api/v2/workflows/(${ID})/cache-pins/(${ID})$`), async ({ req, match }) => [200, engine.freezeCache(match[1], match[2], parse(await bodyText(req)))]],
    ['DELETE', 'public', new RegExp(`^/api/v2/workflows/(${ID})/cache-pins/(${ID})$`), ({ match }) => [200, engine.deleteCachePin(match[1], match[2])]],
    ['GET', 'public', /^\/api\/v2\/context-bindings$/, ({ url }) => {
      const { workspaceId } = query(url, ['workspaceId']);
      if (!workspaceId) throw new ApiError(400, 'invalid_request', 'workspaceId is required.');
      return [200, engine.listBindings(workspaceId)];
    }],
    ['POST', 'public', new RegExp(`^/api/v2/context-bindings/(${UUID})/acknowledge$`), async ({ req, match }) => [200, engine.acknowledgeBinding(match[1], parse(await bodyText(req)))]],
    ['POST', 'public', new RegExp(`^/api/v2/context-bindings/(${UUID})/messages$`), async ({ req, match }) => { const result = engine.sendChat(match[1], parse(await bodyText(req))); return [result.status, result.body]; }],
    ['GET', 'public', /^\/api\/v2\/runs$/, ({ url }) => [200, engine.listRuns(query(url, ['workspaceId', 'state', 'kind', 'bindingId', 'limit', 'cursor'], ['limit']))]],
    ['POST', 'public', /^\/api\/v2\/runs$/, async ({ req }) => {
      const body = parse(await bodyText(req));
      const options = { role: req.authRole, clientLabel: req.headers['x-deszo-client-label'], controllerToken: controllerTokenOf(req) };
      const result = body?.hostPermitId ? await engine.createRunUnderHostPermit(body, options) : engine.createRun(body, options);
      return [result.status, result.body];
    }, { hostVariant: true }],
    ['GET', 'public', /^\/api\/v2\/run-requests$/, ({ url }) => {
      const params = query(url, ['state', 'limit'], ['limit']);
      return [200, engine.listRunRequests(params)];
    }],
    ['GET', 'public', new RegExp(`^/api/v2/run-requests/(${UUID})$`), ({ match }) => [200, engine.getRunRequest(match[1])]],
    ['POST', 'retired', new RegExp(`^/api/v2/run-requests/(${UUID})/decision$`), () => [410, { code: 'operation_retired', message: 'This run-request decision route is retired.', details: [] }]],
    ['GET', 'public', new RegExp(`^/api/v2/runs/(${UUID})/events/page$`), ({ match, url }) => {
      const params = query(url, ['afterSequence', 'limit'], ['afterSequence', 'limit']);
      return [200, engine.listRunEvents(match[1], params)];
    }],
    ['GET', 'public', new RegExp(`^/api/v2/runs/(${UUID})$`), ({ match }) => [200, engine.runSnapshot(match[1])]],
    ['POST', 'public', new RegExp(`^/api/v2/runs/(${UUID})/stop$`), async ({ req, match }) => { const result = engine.stopRun(match[1], parse(await bodyText(req))); return [result.status, result.body]; }],
    ['POST', 'public', new RegExp(`^/api/v2/runs/(${UUID})/recovery$`), async ({ req, match }) => { const result = engine.recoverRun(match[1], parse(await bodyText(req))); return [result.status, result.body]; }],
    ['POST', 'public', new RegExp(`^/api/v2/runs/(${UUID})/linked-repair$`), async ({ req, match }) => { const result = engine.linkRepair(match[1], parse(await bodyText(req))); return [result.status, result.body]; }],
    ['POST', 'retired', new RegExp(`^/api/v2/runs/(${UUID})/lifecycle-receipt$`), () => [410, { code: 'operation_retired', message: 'HTTP lifecycle receipts are retired; Host receipts use the authenticated lifecycle channel.', details: [] }]],
    ['GET', 'public', new RegExp(`^/api/v2/runs/(${UUID})/maps/([^/]+)$`), ({ match }) => [200, engine.mapNavigator(match[1], decodeURIComponent(match[2]))]],
    ['GET', 'public', new RegExp(`^/api/v2/runs/(${UUID})/tasks/([^/]+)$`), ({ match }) => [200, engine.managedTaskNavigator(match[1], decodeURIComponent(match[2]))]],
    ['GET', 'public', new RegExp(`^/api/v2/runs/(${UUID})/maps/([^/]+)/executions$`), ({ match }) => [200, engine.mapHistory(match[1], decodeURIComponent(match[2]))]],
    ['GET', 'public', new RegExp(`^/api/v2/map-executions/(${UUID})$`), ({ match }) => [200, engine.mapExecutionNavigator(match[1])]],
    ['GET', 'public', new RegExp(`^/api/v2/artifacts/(${UUID})/provenance$`), ({ match }) => [200, engine.artifactProvenance(match[1])]],
    // ADR-0007 is opt-in. Worker credentials and scoped invocation credentials have different rights.
    ['POST', 'public', /^\/api\/v2\/judge-sessions$/, async ({req}) => { const r=engine.registerJudgeSession(parse(await bodyText(req)));return[r.status,r.body]; }],
    ['POST', 'public', /^\/api\/v2\/judge-attention$/, async ({req}) => { const r=engine.createJudgeAttention(parse(await bodyText(req)),{controllerToken:controllerTokenOf(req)});return[r.status,r.body]; }],
    ['GET', 'public', new RegExp(`^/api/v2/judge-sessions/(${UUID})/attention$`), ({req,match}) => [200,engine.listJudgeAttention(match[1],{controllerToken:controllerTokenOf(req)})]],
    ['POST', 'public', new RegExp(`^/api/v2/judge-sessions/(${UUID})/owner$`), async ({req,match}) => { const r=engine.fenceJudgeOwner(match[1],parse(await bodyText(req)),{controllerToken:controllerTokenOf(req)});return[r.status,r.body]; }],
    ['POST', 'internal-host', /^\/api\/v2\/judge-invocations$/, async ({req}) => { const r=await engine.admitJudgeInvocation(parse(await bodyText(req)),{controllerToken:controllerTokenOf(req)});return[r.status,r.body]; }],
    ['POST', 'internal-host', new RegExp(`^/api/v2/judge-invocations/(${UUID})/started$`), async ({req,match}) => [200,engine.recordJudgeStarted(match[1],parse(await bodyText(req)),{controllerToken:controllerTokenOf(req)})]],
    ['POST', 'internal-host', new RegExp(`^/api/v2/judge-invocations/(${UUID})/complete$`), async ({req,match}) => [200,await engine.completeJudgeInvocation(match[1],parse(await bodyText(req)),{controllerToken:controllerTokenOf(req)})]],
    ['GET', 'public', new RegExp(`^/api/v2/judge-invocations/(${UUID})/evidence$`), async ({req,match}) => [200,await engine.readJudgeEvidence(match[1],{invocationToken:req.headers['x-deszo-judge-token']})]],
    ['GET', 'internal-host', new RegExp(`^/api/v2/judge-invocations/(${UUID})/reads$`), ({req,match}) => [200,engine.listJudgeReads(match[1],{controllerToken:controllerTokenOf(req)})]],
    ['GET', 'public', new RegExp(`^/api/v2/judge-invocations/(${UUID})/artifacts/(${UUID})$`), async ({req,match,url}) => [200,await engine.readJudgeArtifact(match[1],match[2],{invocationToken:req.headers['x-deszo-judge-token'],...query(url,['offset','length'],['offset','length'])})]],
    ['POST', 'public', /^\/api\/v2\/judge-decisions$/, async ({req}) => { const r=await engine.submitJudgeDecision(parse(await bodyText(req)),{controllerToken:controllerTokenOf(req),invocationToken:req.headers['x-deszo-judge-token']});return[r.status,r.body]; }],
    ['GET', 'public', new RegExp(`^/api/v2/judge-decisions/(${UUID})$`), ({req,match}) => [200,engine.getJudgeDecision(match[1],{controllerToken:controllerTokenOf(req)})]],
    // ADR-0002 observation, supervision, incidents and audit are all public owner operations.
    ['POST', 'public', /^\/api\/v2\/controller-sessions$/, async ({ req }) => { const result = engine.createControllerSession(parse(await bodyText(req))); return [result.status, result.body]; }],
    ['POST', 'public', /^\/api\/v2\/control-grants$/, async ({ req }) => { const result = engine.requestControlGrant(parse(await bodyText(req)), { controllerToken: controllerTokenOf(req) }); return [result.status, result.body]; }],
    ['GET', 'public', new RegExp(`^/api/v2/control-grants/(${UUID})$`), ({ match }) => [200, engine.getControlGrant(match[1])]],
    ['GET', 'public', /^\/api\/v2\/control-grants$/, ({ url }) => [200, engine.listControlGrants(query(url, ['state', 'limit'], ['limit']))]],
    ['POST', 'public', new RegExp(`^/api/v2/control-grants/(${UUID})/decision$`), async ({ req, match }) => { const result = engine.decideControlGrant(match[1], parse(await bodyText(req))); return [result.status, result.body]; }],
    ['POST', 'internal-host', new RegExp(`^/api/v2/control-grants/(${UUID})/host-approval$`), async ({ req, match }) => { const result = await engine.approveControlGrantUnderHostPermit(match[1], parse(await bodyText(req))); return [result.status, result.body]; }],
    ['POST', 'public', new RegExp(`^/api/v2/control-grants/(${UUID})/revoke$`), async ({ req, match }) => { const result = engine.revokeControlGrant(match[1], parse(await bodyText(req))); return [result.status, result.body]; }],
    ['GET', 'public', new RegExp(`^/api/v2/runs/(${UUID})/control$`), ({ match }) => [200, engine.getRunControl(match[1])]],
    ['GET', 'public', new RegExp(`^/api/v2/runs/(${UUID})/watch$`), async ({ match, url }) => [200, await engine.watchRun(match[1], query(url, ['cursor', 'waitMs'], ['cursor', 'waitMs']))]],
    ['POST', 'public', new RegExp(`^/api/v2/runs/(${UUID})/observation-acks$`), async ({ req, match }) => { const result = engine.acknowledgeObservation(match[1], parse(await bodyText(req)), { controllerToken: controllerTokenOf(req) }); return [result.status, result.body]; }],
    ['GET', 'public', new RegExp(`^/api/v2/runs/(${UUID})/evidence$`), ({ match }) => [200, { items: engine.runEvidence(match[1]) }]],
    ['GET', 'public', new RegExp(`^/api/v2/runs/(${UUID})/processes$`), ({ match }) => [200, { items: engine.runProcesses(match[1]) }]],
    ['POST', 'public', new RegExp(`^/api/v2/runs/(${UUID})/stop-and-report$`), async ({ req, match }) => { const body = parse(await bodyText(req)); const result = engine.stopAndReport(match[1], body, reporterFor(req, body)); return [result.status, result.body]; }],
    ['POST', 'public', new RegExp(`^/api/v2/runs/(${UUID})/audit-bundles$`), async ({ req, match }) => { const result = await engine.createAuditBundle(match[1], parse(await bodyText(req))); return [result.status, result.body]; }],
    ['GET', 'public', new RegExp(`^/api/v2/audit-bundles/(${UUID})$`), ({ match }) => [200, engine.getAuditBundle(match[1])]],
    ['GET', 'public', new RegExp(`^/api/v2/artifacts/(${UUID})/range$`), ({ match, url }) => [200, engine.readArtifactRange(match[1], query(url, ['offset', 'length'], ['offset', 'length']))]],
    ['POST', 'public', /^\/api\/v2\/incidents$/, async ({ req }) => { const body = parse(await bodyText(req)); body.observation = { ...body.observation, reporter: reporterFor(req, body.observation) }; const result = engine.fileIncident(body); return [result.status, result.body]; }],
    ['GET', 'public', /^\/api\/v2\/incidents$/, ({ url }) => [200, engine.listIncidents(query(url, ['state', 'runId', 'limit'], ['limit']))]],
    ['GET', 'public', new RegExp(`^/api/v2/incidents/(${UUID})$`), ({ match }) => [200, engine.getIncident(match[1])]],
    ['POST', 'public', new RegExp(`^/api/v2/incidents/(${UUID})/observations$`), async ({ req, match }) => { const body = parse(await bodyText(req)); body.observation = { ...body.observation, reporter: reporterFor(req, body.observation) }; const result = engine.appendObservation(match[1], body); return [result.status, result.body]; }],
    ['POST', 'public', new RegExp(`^/api/v2/incidents/(${UUID})/triage$`), async ({ req, match }) => { const body = parse(await bodyText(req)); const result = engine.triageIncident(match[1], body, reporterFor(req, body)); return [result.status, result.body]; }],
    ['GET', 'public', new RegExp(`^/api/v2/command-status/(${UUID})$`), ({ match }) => [200, engine.commandStatus(match[1])]],
    ['GET', 'public', new RegExp(`^/api/v2/runs/(${UUID})/emergency-credential$`), ({ req, match }) => [200, engine.emergencyCredential(match[1], controllerTokenOf(req))]],
    ['POST', 'public', new RegExp(`^/api/v2/runs/(${UUID})/control-extension$`), async ({ req, match }) => { const result = await engine.extendEscalation(match[1], parse(await bodyText(req))); return [result.status, result.body]; }],
    ['POST', 'public', new RegExp(`^/api/v2/runs/(${UUID})/nodes/([^/]+)/stop$`), async ({ req, match }) => {
      const result = engine.stopNode(match[1], decodeURIComponent(match[2]), parse(await bodyText(req))); return [result.status, result.body];
    }],
  ];

  function stream(req, res, runId, url) {
    const row = engine.requireRun(runId);
    const params = query(url, ['afterSequence'], ['afterSequence']);
    const header = req.headers['last-event-id'];
    if (params.afterSequence !== undefined && header !== undefined && String(params.afterSequence) !== header) throw new ApiError(400, 'invalid_request', 'afterSequence conflicts with Last-Event-ID.');
    let after = params.afterSequence ?? (header !== undefined ? Number(header) : 0);
    if (!Number.isInteger(after) || after < 0) throw new ApiError(400, 'invalid_request', 'Invalid event cursor.');
    if (after > row.last_sequence) throw new ApiError(409, 'conflict', 'The cursor is beyond the last stored event.');
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    const send = envelope => { res.write(`event: journal\nid: ${envelope.sequence}\ndata: ${JSON.stringify(envelope)}\n\n`); after = envelope.sequence; };
    const terminal = () => ['succeeded', 'failed', 'canceled', 'interrupted'].includes(engine.store.get('SELECT state FROM runs WHERE id = ?', runId).state);
    for (const envelope of engine.store.readEvents(runId, after)) send(envelope);
    if (terminal()) { res.end(); return; }
    const listener = envelope => {
      if (envelope.runId !== runId || envelope.sequence <= after) return;
      send(envelope);
      if (envelope.type === 'run.state_changed' && ['succeeded', 'failed', 'canceled', 'interrupted'].includes(envelope.payload.to)) close();
    };
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 15_000);
    const entry = { res, close: () => close() };
    const close = () => { engine.off('event', listener); clearInterval(keepalive); streams.delete(entry); res.end(); };
    engine.on('event', listener); streams.add(entry);
    res.on('close', () => { engine.off('event', listener); clearInterval(keepalive); streams.delete(entry); });
  }

  function streamAuthoring(req, res, url) {
    const params = query(url, ['after'], ['after']);
    let after = params.after ?? 0;
    if (after < 0) throw new ApiError(400, 'invalid_request', 'Invalid workflow-change cursor.');
    const first = engine.workflowChanges({ after, limit: 1 });
    if (first.resyncRequired) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.end(`event: resync\ndata: ${JSON.stringify(first)}\n\n`);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    const send = event => { res.write(`event: workflow-change\nid: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`); after = event.sequence; };
    const listener = event => { if (event.sequence > after) send(event); };
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 15_000);
    engine.store.on('workflow-change', listener);
    let initial;
    do {
      initial = engine.workflowChanges({ after, limit: 200 });
      if (initial.resyncRequired) {
        engine.store.off('workflow-change', listener); clearInterval(keepalive);
        res.write(`event: resync\ndata: ${JSON.stringify(initial)}\n\n`); res.end(); return;
      }
      for (const event of initial.items) if (event.sequence > after) send(event);
    } while (initial.nextCursor !== null);
    res.on('close', () => { engine.store.off('workflow-change', listener); clearInterval(keepalive); });
  }

  const specialRoutes = [
    ['GET', 'public', /^\/api\/v3\/authoring\/events\/stream$/, 'authoring-event-stream'],
    ['GET', 'public', new RegExp(`^/api/v2/runs/(${UUID})/events$`), 'run-event-stream'],
    ['GET', 'public', new RegExp(`^/api/v2/artifacts/(${UUID})$`), 'artifact-body'],
  ];
  const classifications = new Set(['public', 'internal-host', 'retired']);
  const registeredRoutes = routes.map(([method, classification, pattern, handler, metadata]) => ({ method, classification, pattern, handler, metadata }));
  const routeInventory = [
    ...registeredRoutes.map(({ method, classification, pattern, metadata }) => ({ method, classification, pattern: pattern.source, ...(metadata?.hostVariant ? { hostVariant: 'POST /api/v2/runs with hostPermitId' } : {}) })),
    ...specialRoutes.map(([method, classification, pattern, special]) => ({ method, classification, pattern: pattern.source, special })),
    { method: 'OPTIONS', classification: 'public', pattern: '*', preflight: true },
  ];
  const uniqueRoutes = new Set();
  for (const route of routeInventory) {
    if (!classifications.has(route.classification)) throw new Error(`Runtime route ${route.method} ${route.pattern} has no valid classification.`);
    const identity = `${route.method} ${route.pattern}`;
    if (uniqueRoutes.has(identity)) throw new Error(`Runtime route ${identity} is registered more than once.`);
    uniqueRoutes.add(identity);
  }

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) return problem(res, 403, 'unauthorized', 'Origin is not allowed.');
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Last-Event-ID, If-Match, If-None-Match, Idempotency-Key, X-Deszo-Client-Label, X-Deszo-Controller-Token, X-Deszo-Judge-Token');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Expose-Headers', 'ETag');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const caller = identifyCaller(req);
    if (!caller) return problem(res, 401, 'unauthorized', 'A valid Runtime Owner Token or authenticated Host credential is required.');
    if (shuttingDown) return problem(res, 409, 'conflict', 'The runtime is shutting down.');
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      const route = registeredRoutes.find(entry => entry.method === req.method && url.pathname.match(entry.pattern));
      const special = specialRoutes.find(([method, , pattern]) => method === req.method && url.pathname.match(pattern));
      const classification = route?.classification ?? special?.[1];
      if (!classification) return problem(res, 404, 'not_found', `Unknown endpoint ${req.method} ${url.pathname}.`);
      if (classification === 'internal-host' && caller !== 'host') return problem(res, 403, 'host_authentication_required', 'This operation requires the authenticated Lifecycle Host protocol.');
      if (classification === 'public' && caller === 'host') {
        if (!route?.metadata?.hostVariant) return problem(res, 403, 'owner_token_required', 'The Host credential cannot authorize a public Runtime API operation.');
        const hostRun = parse(await bodyText(req));
        if (typeof hostRun?.hostPermitId !== 'string' || !hostRun.hostPermitId) return problem(res, 403, 'host_permit_required', 'The Host route variant requires a Host permit.');
      }
      req.authRole = 'first-party';
      req.authPrincipal = caller;
      if (req.method === 'GET' && url.pathname === '/api/v3/authoring/events/stream') return streamAuthoring(req, res, url);
      const events = url.pathname.match(new RegExp(`^/api/v2/runs/(${UUID})/events$`));
      if (req.method === 'GET' && events) return stream(req, res, events[1], url);
      const artifact = url.pathname.match(new RegExp(`^/api/v2/artifacts/(${UUID})$`));
      if (req.method === 'GET' && artifact) {
        const row = engine.store.artifactRow(artifact[1]);
        if (!row) throw new ApiError(404, 'not_found', 'Unknown artifact.');
        const bounds = query(url, ['maxBytes'], ['maxBytes']);
        if (bounds.maxBytes !== undefined && (bounds.maxBytes < 1 || bounds.maxBytes > MAX_RESPONSE)) throw new ApiError(400, 'invalid_request', `maxBytes must be between 1 and ${MAX_RESPONSE}.`);
        if (bounds.maxBytes !== undefined && row.byte_size > bounds.maxBytes) throw new ApiError(413, 'result_too_large', `Artifact is ${row.byte_size} bytes, above the requested ${bounds.maxBytes}-byte result bound.`);
        const { bytes, mediaType, sha256 } = engine.readArtifact(artifact[1]);
        res.writeHead(200, { 'Content-Type': mediaType, ETag: `"${sha256}"`, 'Cache-Control': 'private, max-age=31536000, immutable' });
        res.end(bytes); return;
      }
      if (route) {
        const match = url.pathname.match(route.pattern);
        const [status, body, headers] = await route.handler({ req, url, match });
        return json(res, status, body, headers);
      }
      problem(res, 500, 'internal_error', 'A classified special Runtime route has no dispatch handler.');
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      if (error instanceof ApiError) return problem(res, error.status, error.code, error.message, error.details);
      if (error instanceof CorruptionError) return problem(res, 500, 'corruption', error.message);
      if (error instanceof ContractError) return problem(res, 500, 'internal_error', error.message, error.details);
      process.stderr.write(`${error.stack || error}\n`);
      problem(res, 500, 'internal_error', error.message);
    }
  });

  try { await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolvePromise); }); }
  catch (error) { engine.store.close(); await releaseLock(); throw error; }
  const identity = engine.runtimeIdentity();
  if (hostBinding?.assurance === 'production'||hostBinding?.verificationOnly) {
    try {
      await hostBinding.client.call('runtime.ready', { runtimeGeneration: hostBinding.runtimeGeneration, port: server.address().port, token, hostToken,
        buildId: hostBinding.buildId, protocolVersion: hostBinding.protocolVersion,
        storeSchemaVersion: engine.store.get('SELECT MAX(version) AS version FROM schema_migrations').version, ...identity });
    } catch (error) { server.close(); engine.store.close(); await releaseLock(); hostBinding.client.close(); throw error; }
  }
  descriptor = { descriptorVersion: 1, apiVersions: ['v2', 'v3', 'v4'], storeId: identity.storeId, runtimeInstanceId, applicationRoot: identity.applicationRoot,
    nodeExecutable: identity.nodeExecutable, bridgeScript: bridgeFile, connectionFile, port: server.address().port, token, root: identity.applicationRoot,
    scratchRoot: join(engine.store.workdirs, 'scratch'), processContainment: engine.processContainment,
    ...(lifecycleHost ? { applicationBuildId: lifecycleHost.context.buildId, applicationGeneration: lifecycleHost.context.generation,
      applicationPid: lifecycleHost.context.applicationPid } : {}) };
  atomicWrite(connectionFile, JSON.stringify(descriptor));
  // The UI compatibility field is an alias of Owner Token and carries no separate privilege tier.
  connection = { ...descriptor, firstPartyToken: token };
  queueMicrotask(() => engine.startRun());
  return {
    connection, engine, routeInventory,
    ...(exposeHostRequestForTests ? { async hostRequest(method, path, body, { headers = {} } = {}) {
      const response = await fetch(`http://127.0.0.1:${connection.port}${path}`, { method,
        headers: { Authorization: `Bearer ${hostToken}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
    } } : {}),
    async close() {
      if (shuttingDown) return; shuttingDown = true;
      hostBinding?.client.close();
      for (const entry of streams) entry.close();
      const serverClosed = new Promise(resolvePromise => server.close(resolvePromise));
      server.closeAllConnections?.();
      await engine.shutdown();
      await serverClosed;
      await releaseLock();
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
  const supervised = process.argv.includes('--supervised');
  const firstPartyTokenStdout = process.argv.includes('--first-party-token-stdout') && !process.stdout.isTTY;
  const devTestConfirmationOff = !PACKAGED_RUNTIME && process.argv.includes('--dev-test-confirmation-off');
  const fixtureState = !PACKAGED_RUNTIME && option('--fixture-state');
  let adapters;
  if (fixtureState) {
    const { fixtureAdapters } = await import('./tests/fixture-adapters.mjs');
    adapters = fixtureAdapters(fixtureState);
  }
  if (PACKAGED_RUNTIME && process.argv.some(argument => argument.startsWith('--') && !['--disable-warning=ExperimentalWarning', '--root', '--connection-file', '--bridge-file', '--supervised', '--host-contained', '--first-party-token-stdout'].includes(argument))) {
    throw new Error('The packaged runtime was given an unsupported option.');
  }
  const lines = createInterface({ input: process.stdin });
  const hostContained = process.argv.includes('--host-contained');
  // In Tauri mode the Rust supervisor confirms Job Object membership before any CLI can start.
  if (supervised || hostContained) await new Promise(resolvePromise => lines.on('line', function waitForContainment(line) {
    try { if (JSON.parse(line).command === 'contained') { lines.off('line', waitForContainment); resolvePromise(); } } catch { /* Ignore other input. */ }
  }));
  const runner = await startRunner({ root: option('--root'), connectionFile: option('--connection-file'), bridgeFile: option('--bridge-file'), supervised, firstPartyTokenStdout, devTestConfirmationOff, adapters });
  const startup = { ...runner.connection };
  if (!firstPartyTokenStdout) delete startup.firstPartyToken;
  process.stdout.write(JSON.stringify(startup) + '\n');
  const shutdown = async () => { await runner.close(); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  lines.on('line', line => { try { if (JSON.parse(line).command === 'shutdown') shutdown(); } catch { /* Ignore non-control input. */ } });
}
