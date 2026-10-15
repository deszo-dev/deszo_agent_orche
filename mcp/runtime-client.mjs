import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { managedInvocationDecision } from './managed-invocation.mjs';

const MAX_JSON_BYTES = 4 * 1024 * 1024;
export class BridgeError extends Error {
  constructor(status, code, message, details = []) {
    super(message); Object.assign(this, { status, code, details });
  }
}

async function readDescriptor(connectionFile) {
  let bytes;
  try { bytes = await readFile(connectionFile); }
  catch { throw new BridgeError(503, 'runtime_unavailable', 'The selected runtime connection file is unavailable.'); }
  if (bytes.length > 64 * 1024) throw new BridgeError(400, 'invalid_descriptor', 'The selected connection descriptor is too large.');
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { throw new BridgeError(400, 'invalid_descriptor', 'The selected connection descriptor is not valid JSON.'); }
  if (!value || value.descriptorVersion !== 1 || !Array.isArray(value.apiVersions) || !value.apiVersions.includes('v3') ||
      typeof value.token !== 'string' || !/^[0-9a-f]{64}$/i.test(value.token) ||
      !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
      typeof value.storeId !== 'string' || typeof value.runtimeInstanceId !== 'string' ||
      typeof value.applicationRoot !== 'string' || typeof value.root !== 'string' ||
      !isAbsolute(value.applicationRoot) || resolve(value.root) !== resolve(value.applicationRoot) ||
      typeof value.nodeExecutable !== 'string' || !isAbsolute(value.nodeExecutable) ||
      typeof value.bridgeScript !== 'string' || !isAbsolute(value.bridgeScript) ||
      typeof value.connectionFile !== 'string' || resolve(value.connectionFile) !== connectionFile)
    throw new BridgeError(400, 'invalid_descriptor', 'The connection file is not a supported Deszo runtime descriptor.');
  return value;
}

async function request(descriptor, method, path, body, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15_000);
  try {
    const response = await fetch(`http://127.0.0.1:${descriptor.port}${path}`, {
      method, redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${descriptor.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(options.headers || {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const bound = options.raw ? options.maxBytes : MAX_JSON_BYTES;
    if (Number(response.headers.get('content-length') || 0) > bound)
      throw new BridgeError(413, 'result_too_large', 'The runtime response exceeds the requested result bound.');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > bound) throw new BridgeError(413, 'result_too_large', 'The runtime response exceeds the requested result bound.');
    let value;
    if (!options.raw || !response.ok) {
      try { value = bytes.length ? JSON.parse(bytes.toString('utf8')) : null; }
      catch { throw new BridgeError(502, 'invalid_runtime_response', 'The runtime returned an invalid JSON response.'); }
    }
    if (!response.ok) throw new BridgeError(response.status, value?.code || 'runtime_error', value?.message || `Runtime request failed with HTTP ${response.status}.`, value?.details || []);
    return options.raw ? { bytes, mediaType: response.headers.get('content-type') || 'application/octet-stream', etag: response.headers.get('etag') } : value;
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    if (error?.name === 'AbortError') throw new BridgeError(504, 'runtime_timeout', 'The Deszo runtime did not respond before the bridge request timed out.');
    if (error instanceof TypeError) throw new BridgeError(503, 'runtime_unavailable', 'The selected Deszo runtime is unavailable. Start it in Deszo, then reconnect the bridge.');
    throw error;
  } finally { clearTimeout(timeout); }
}

export async function createRuntimeClient({ connectionFile, handshake, marker }) {
  let descriptor = await readDescriptor(connectionFile);
  const selected = { storeId: descriptor.storeId, applicationRoot: descriptor.applicationRoot };
  const managedInvocation = managedInvocationDecision(marker, descriptor.runtimeInstanceId);
  const assertIdentity = (actual, expected) => {
    if (actual.storeId !== selected.storeId || actual.applicationRoot !== selected.applicationRoot ||
        actual.runtimeInstanceId !== expected.runtimeInstanceId)
      throw new BridgeError(409, 'store_identity_mismatch', 'The selected descriptor and authenticated runtime identify different stores or application roots.');
  };
  const connect = async next => {
    assertIdentity(next, next);
    assertIdentity(await request(next, 'GET', '/api/v3/authoring/contract'), next);
    assertIdentity(await request(next, 'POST', '/api/v3/authoring/bridge-handshake', handshake), next);
  };
  if (!managedInvocation) await connect(descriptor);
  let reconnecting;
  const reconnect = async failed => {
    if (descriptor !== failed) return true;
    if (!reconnecting) reconnecting = (async () => {
      const next = await readDescriptor(connectionFile);
      assertIdentity(next, next);
      if (next.runtimeInstanceId === failed.runtimeInstanceId && next.port === failed.port && next.token === failed.token) return false;
      await connect(next);
      descriptor = next;
      return true;
    })().finally(() => { reconnecting = undefined; });
    return reconnecting;
  };
  const api = async (method, path, body, options = {}) => {
    if (managedInvocation) throw new BridgeError(403, managedInvocation.code, managedInvocation.message, managedInvocation.details);
    if (!path.startsWith('/api/v2/') && !path.startsWith('/api/v3/')) throw new BridgeError(400, 'invalid_request', 'The bridge only forwards versioned Deszo API routes.');
    const attempted = descriptor;
    try { return await request(attempted, method, path, body, options); }
    catch (error) {
      // A lost response can conceal a committed command. Retry the identical body,
      // never a new request ID, and only after authenticating the same selected store.
      const repeatable = method === 'GET' || Boolean(body?.requestId) || path.startsWith('/api/v3/authoring/bridge-handshake') || path.endsWith('/validate');
      if (!repeatable || ![401, 503, 504].includes(error.status) || !await reconnect(attempted)) throw error;
      return request(descriptor, method, path, body, options);
    }
  };
  return { api, managedInvocationDenied: Boolean(managedInvocation) };
}
