import { HostError } from './authority.mjs';
import { parseStrictJson } from '../core/canonical.mjs';

// Enforce the bound while consuming bytes, before materializing an arbitrarily large response in memory.
export async function boundedRuntimeJson(response, { maxBytes = 4 * 1024 * 1024 } = {}) {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    await response.body?.cancel(); throw new HostError(502,'runtime_result_bound','Runtime response exceeds its byte bound.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new HostError(502,'runtime_protocol','Runtime returned no JSON body.');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new HostError(502,'runtime_result_bound','Runtime response exceeds its byte bound.'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  try { return parseStrictJson(Buffer.concat(chunks,size).toString('utf8')); }
  catch { throw new HostError(502,'runtime_protocol','Runtime returned malformed or ambiguous JSON.'); }
}
