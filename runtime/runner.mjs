import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { writeFileSync, renameSync } from 'node:fs';
import { ApiError, Engine } from './core/engine.mjs';
import { ContractError } from './core/schemas.mjs';
import { CorruptionError } from './core/store.mjs';
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

export async function startRunner({ root, connectionFile, bridgeFile, port = 0, supervised = false, adapters, maximumAgentTimeoutSeconds, loopMinuteMs, extraOrigins = [], runtimeInstanceId = randomUUID(), nodeExecutable = process.execPath, devTestConfirmationOff = false } = {}) {
  const origins = new Set([...ORIGINS, ...extraOrigins]);
  const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.deszo');
  root = resolve(root || defaultRoot);
  const sameRoot = process.platform === 'win32' ? root.toLowerCase() === defaultRoot.toLowerCase() : root === defaultRoot;
  if (devTestConfirmationOff && sameRoot) throw new Error('The fixture confirmation policy requires a dedicated runtime root, separate from the default .deszo store.');
  connectionFile = resolve(connectionFile || join(root, 'runtime', 'connection.json'));
  bridgeFile = resolve(bridgeFile || join(dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'bridge.mjs'));
  await mkdir(join(root, 'runtime'), { recursive: true });
  const releaseLock = await acquireRuntimeLock(join(root, 'runtime', 'runner.lock'));
  const token = randomBytes(32).toString('hex');
  const firstPartyToken = randomBytes(32).toString('hex');
  let engine;
  try {
    if (PACKAGED_RUNTIME && devTestConfirmationOff) throw new Error('The packaged runtime does not support the fixture confirmation policy.');
    engine = new Engine({ root, adapters, runtimeInstanceId, nodeExecutable, bridgeScript: bridgeFile,
      externalRunConfirmationOverride: devTestConfirmationOff ? false : null,
      processContainment: supervised ? 'tauri-job' : 'standalone-best-effort', ...(maximumAgentTimeoutSeconds ? { maximumAgentTimeoutSeconds } : {}), ...(loopMinuteMs ? { loopMinuteMs } : {}) });
    await engine.initialize();
    if (devTestConfirmationOff && !engine.store.get('SELECT id FROM workspaces LIMIT 1'))
      engine.putWorkspace('main', { cwd: join(engine.store.workdirs, 'scratch', 'main') });
  } catch (error) { await releaseLock(); throw error; }
  const streams = new Set();
  let shuttingDown = false;

  const authorized = req => {
    const supplied = Buffer.from((req.headers.authorization || '').replace(/^Bearer /, ''));
    const external = Buffer.from(token);
    const firstParty = Buffer.from(firstPartyToken);
    if (supplied.length === external.length && timingSafeEqual(supplied, external)) return 'external';
    if (supplied.length === firstParty.length && timingSafeEqual(supplied, firstParty)) return 'first-party';
    return null;
  };
  const parse = text => { try { return JSON.parse(text || '{}'); } catch (error) { throw new ApiError(400, 'invalid_request', `Malformed JSON: ${error.message}`); } };

  const routes = [
    ['GET', /^\/api\/v3\/authoring\/contract$/, async () => [200, engine.authoringContract()]],
    ['GET', new RegExp(`^/api/v3/authoring/schemas/([^/]+)$`), ({ match }) => [200, engine.authoringSchema(decodeURIComponent(match[1]))]],
    ['GET', /^\/api\/v3\/authoring\/node-types$/, () => [200, engine.authoringNodeTypes()]],
    ['GET', /^\/api\/v3\/authoring\/templates$/, () => [200, { items: engine.authoringTemplates() }]],
    ['GET', new RegExp(`^/api/v3/authoring/templates/(${ID})$`), ({ match }) => [200, engine.authoringTemplate(match[1])]],
    ['GET', /^\/api\/v3\/authoring\/events$/, ({ url }) => {
      const params = query(url, ['after', 'limit'], ['after', 'limit']);
      return [200, engine.workflowChanges(params)];
    }],
    ['POST', /^\/api\/v3\/authoring\/bridge-handshake$/, async ({ req }) => [200, engine.registerBridge(parse(await readBody(req))) ]],
    ['DELETE', new RegExp(`^/api/v3/authoring/bridge-handshake/(${UUID})$`), ({ match }) => { engine.unregisterBridge(match[1]); return [200, { removed: true }]; }],
    ['GET', /^\/api\/v3\/workflows$/, ({ url }) => [200, engine.listWorkflowsV3(query(url, ['limit', 'cursor'], ['limit']))]],
    ['POST', /^\/api\/v3\/workflows\/validate$/, async ({ req }) => {
      const body = parse(await readBody(req));
      const workflow = body?.workflow ?? body;
      return [200, engine.validateWorkflow(workflow)];
    }],
    ['PUT', new RegExp(`^/api/v3/workflows/(${ID})$`), async ({ req, match }) => {
      const body = parse(await readBody(req));
      const ifMatch = req.headers['if-match'];
      const ifNoneMatch = req.headers['if-none-match'];
      if (ifMatch && ifNoneMatch) throw new ApiError(400, 'invalid_request', 'Use If-Match or If-None-Match, not both.');
      if (ifNoneMatch && ifNoneMatch !== '*') throw new ApiError(412, 'precondition_failed', 'Create-only saves require If-None-Match: *.');
      const headerEtag = ifNoneMatch === '*' ? null : ifMatch;
      if (body.expectedEtag !== undefined && headerEtag !== undefined && body.expectedEtag !== headerEtag)
        throw new ApiError(400, 'invalid_request', 'The body precondition and HTTP conditional header disagree.');
      const expectedEtag = headerEtag !== undefined ? headerEtag : body.expectedEtag;
      if (expectedEtag === undefined) throw new ApiError(428, 'precondition_required', 'Use If-Match for a replacement or If-None-Match: * for creation.');
      const saved = engine.saveWorkflowV3(match[1], { ...body, expectedEtag });
      return [200, saved, { ETag: saved.etag }];
    }],
    ['GET', new RegExp(`^/api/v3/workflows/(${ID})$`), ({ match }) => {
      const saved = engine.getWorkflowV3(match[1]);
      return [200, saved, { ETag: saved.etag }];
    }],
    ['GET', /^\/api\/v2\/capabilities$/, async () => [200, await engine.capabilities()]],
    ['GET', /^\/api\/v2\/settings$/, () => [200, engine.settingsBody()]],
    ['PUT', /^\/api\/v2\/settings$/, async ({ req }) => { const result = engine.updateSettings(parse(await readBody(req))); return [result.status, result.body]; }],
    ['GET', /^\/api\/v2\/workspaces$/, ({ url }) => [200, engine.listWorkspaces(query(url, ['limit', 'cursor'], ['limit']))]],
    ['PUT', new RegExp(`^/api/v2/workspaces/(${ID})$`), async ({ req, match }) => [200, engine.putWorkspace(match[1], parse(await readBody(req)))]],
    ['GET', /^\/api\/v2\/workflows$/, ({ url }) => [200, engine.listWorkflows(query(url, ['limit', 'cursor'], ['limit']))]],
    ['POST', /^\/api\/v2\/workflows\/validate$/, async ({ req }) => [200, engine.validateWorkflow(parse(await readBody(req)))]],
    ['PUT', new RegExp(`^/api/v2/workflows/(${ID})$`), () => [410, { code: 'api_upgrade_required',
      message: 'Workflow saves require API v3. Read the workflow ETag and save with a stable requestId and an explicit precondition.', details: [] }]],
    ['GET', new RegExp(`^/api/v2/workflows/(${ID})$`), ({ match }) => [200, engine.getWorkflow(match[1])]],
    ['GET', new RegExp(`^/api/v2/workflows/(${ID})/cache-pins$`), ({ match }) => [200, engine.listPins(match[1])]],
    ['PUT', new RegExp(`^/api/v2/workflows/(${ID})/cache-pins/(${ID})$`), async ({ req, match }) => [200, engine.freezeCache(match[1], match[2], parse(await readBody(req)))]],
    ['DELETE', new RegExp(`^/api/v2/workflows/(${ID})/cache-pins/(${ID})$`), ({ match }) => [200, engine.deleteCachePin(match[1], match[2])]],
    ['GET', /^\/api\/v2\/context-bindings$/, ({ url }) => {
      const { workspaceId } = query(url, ['workspaceId']);
      if (!workspaceId) throw new ApiError(400, 'invalid_request', 'workspaceId is required.');
      return [200, engine.listBindings(workspaceId)];
    }],
    ['POST', new RegExp(`^/api/v2/context-bindings/(${UUID})/acknowledge$`), async ({ req, match }) => [200, engine.acknowledgeBinding(match[1], parse(await readBody(req)))]],
    ['POST', new RegExp(`^/api/v2/context-bindings/(${UUID})/messages$`), async ({ req, match }) => { const result = engine.sendChat(match[1], parse(await readBody(req))); return [result.status, result.body]; }],
    ['GET', /^\/api\/v2\/runs$/, ({ url }) => [200, engine.listRuns(query(url, ['workspaceId', 'state', 'kind', 'bindingId', 'limit', 'cursor'], ['limit']))]],
    ['POST', /^\/api\/v2\/runs$/, async ({ req }) => { const result = engine.createRun(parse(await readBody(req)), { role: req.authRole, clientLabel: req.headers['x-deszo-client-label'] }); return [result.status, result.body]; }],
    ['GET', /^\/api\/v2\/run-requests$/, ({ url }) => {
      const params = query(url, ['state', 'limit'], ['limit']);
      return [200, engine.listRunRequests(params)];
    }],
    ['GET', new RegExp(`^/api/v2/run-requests/(${UUID})$`), ({ match }) => [200, engine.getRunRequest(match[1])]],
    ['POST', new RegExp(`^/api/v2/run-requests/(${UUID})/decision$`), async ({ req, match }) => {
      const result = engine.decideRunRequest(match[1], parse(await readBody(req)));
      return [result.status, result.body];
    }],
    ['GET', new RegExp(`^/api/v2/runs/(${UUID})/events/page$`), ({ match, url }) => {
      const params = query(url, ['afterSequence', 'limit'], ['afterSequence', 'limit']);
      return [200, engine.listRunEvents(match[1], params)];
    }],
    ['GET', new RegExp(`^/api/v2/runs/(${UUID})$`), ({ match }) => [200, engine.runSnapshot(match[1])]],
    ['POST', new RegExp(`^/api/v2/runs/(${UUID})/stop$`), async ({ req, match }) => { const result = engine.stopRun(match[1], parse(await readBody(req))); return [result.status, result.body]; }],
    ['POST', new RegExp(`^/api/v2/runs/(${UUID})/recovery$`), async ({ req, match }) => { const result = engine.recoverRun(match[1], parse(await readBody(req))); return [result.status, result.body]; }],
    ['GET', new RegExp(`^/api/v2/runs/(${UUID})/maps/([^/]+)$`), ({ match }) => [200, engine.mapNavigator(match[1], decodeURIComponent(match[2]))]],
    ['GET', new RegExp(`^/api/v2/runs/(${UUID})/maps/([^/]+)/executions$`), ({ match }) => [200, engine.mapHistory(match[1], decodeURIComponent(match[2]))]],
    ['GET', new RegExp(`^/api/v2/map-executions/(${UUID})$`), ({ match }) => [200, engine.mapExecutionNavigator(match[1])]],
    ['GET', new RegExp(`^/api/v2/artifacts/(${UUID})/provenance$`), ({ match }) => [200, engine.artifactProvenance(match[1])]],
    ['POST', new RegExp(`^/api/v2/runs/(${UUID})/nodes/([^/]+)/stop$`), async ({ req, match }) => {
      const result = engine.stopNode(match[1], decodeURIComponent(match[2]), parse(await readBody(req))); return [result.status, result.body];
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

  const firstPartyOnly = (method, pathname) => {
    if (method === 'PUT' && /^\/api\/v2\/settings$/.test(pathname)) return true;
    if (method === 'PUT' && /^\/api\/v2\/workspaces\//.test(pathname)) return true;
    if (method === 'PUT' && /^\/api\/v2\/workflows\/[^/]+\/cache-pins\//.test(pathname)) return true;
    if (method === 'DELETE' && /^\/api\/v2\/workflows\/[^/]+\/cache-pins\//.test(pathname)) return true;
    if (method === 'POST' && /^\/api\/v2\/context-bindings\/[^/]+\/(acknowledge|messages)$/.test(pathname)) return true;
    if (method === 'POST' && /^\/api\/v2\/runs\/[^/]+\/recovery$/.test(pathname)) return true;
    if (method === 'GET' && /^\/api\/v2\/run-requests$/.test(pathname)) return true;
    if (method === 'POST' && /^\/api\/v2\/run-requests\/[^/]+\/decision$/.test(pathname)) return true;
    return false;
  };

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) return problem(res, 403, 'unauthorized', 'Origin is not allowed.');
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Last-Event-ID, If-Match, If-None-Match, Idempotency-Key, X-Deszo-Client-Label');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Expose-Headers', 'ETag');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const role = authorized(req);
    if (!role) return problem(res, 401, 'unauthorized', 'Runtime token required.');
    if (shuttingDown) return problem(res, 409, 'conflict', 'The runtime is shutting down.');
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      req.authRole = role;
      if (firstPartyOnly(req.method, url.pathname) && role !== 'first-party') return problem(res, 403, 'forbidden', 'This operation requires the first-party Deszo credential.');
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
      for (const [method, pattern, handler] of routes) {
        const match = url.pathname.match(pattern);
        if (match && req.method === method) { const [status, body, headers] = await handler({ req, url, match }); return json(res, status, body, headers); }
      }
      problem(res, 404, 'not_found', `Unknown endpoint ${req.method} ${url.pathname}.`);
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
  const descriptor = { descriptorVersion: 1, apiVersions: ['v2', 'v3'], storeId: identity.storeId, runtimeInstanceId, applicationRoot: identity.applicationRoot,
    nodeExecutable: identity.nodeExecutable, bridgeScript: bridgeFile, connectionFile, port: server.address().port, token, root: identity.applicationRoot,
    scratchRoot: join(engine.store.workdirs, 'scratch'), processContainment: engine.processContainment };
  const temporary = `${connectionFile}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(descriptor), { mode: 0o600 }); renameSync(temporary, connectionFile);
  const connection = { ...descriptor, firstPartyToken };
  queueMicrotask(() => engine.startRun());
  return {
    connection, engine,
    async close() {
      if (shuttingDown) return; shuttingDown = true;
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
  if (PACKAGED_RUNTIME && process.argv.some(argument => argument.startsWith('--') && !['--disable-warning=ExperimentalWarning', '--root', '--connection-file', '--bridge-file', '--supervised', '--first-party-token-stdout'].includes(argument))) {
    throw new Error('The packaged runtime was given an unsupported option.');
  }
  const lines = createInterface({ input: process.stdin });
  // In Tauri mode the Rust supervisor confirms Job Object membership before any CLI can start.
  if (supervised) await new Promise(resolvePromise => lines.on('line', function waitForContainment(line) {
    try { if (JSON.parse(line).command === 'contained') { lines.off('line', waitForContainment); resolvePromise(); } } catch { /* Ignore other input. */ }
  }));
  const runner = await startRunner({ root: option('--root'), connectionFile: option('--connection-file'), bridgeFile: option('--bridge-file'), supervised, firstPartyTokenStdout, devTestConfirmationOff });
  const startup = { ...runner.connection };
  if (!firstPartyTokenStdout) delete startup.firstPartyToken;
  process.stdout.write(JSON.stringify(startup) + '\n');
  const shutdown = async () => { await runner.close(); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  lines.on('line', line => { try { if (JSON.parse(line).command === 'shutdown') shutdown(); } catch { /* Ignore non-control input. */ } });
}
