// Versioned deterministic inspection, executed in the worker before acknowledgement. Workflow text is data only.
import { canonicalHash } from '../core/canonical.mjs';
export function inspectObservation(page, { runId, cursor }) {
  const problems = [];
  if (page?.runId !== runId || !Array.isArray(page?.events) || !Number.isInteger(page?.nextCursor) || page.nextCursor < cursor) problems.push('Malformed run observation.');
  let last = cursor;
  for (const event of page?.events || []) {
    if (!Number.isInteger(event.sequence) || event.sequence !== last + 1 || event.runId !== runId || typeof event.type !== 'string') problems.push('The event sequence is incomplete or belongs to another run.');
    last = event.sequence;
  }
  if (last !== page?.nextCursor || page?.skippedRanges?.length) problems.push('The observation contains an unprocessed range.');
  if (page?.criticalIncidents > 0) problems.push('Deszo reports an unresolved critical incident.');
  if (!page?.terminal && page?.controlMode !== 'supervised') problems.push('The active run lost supervision.');
  return { rulesVersion: 1, runId, cursor: page?.nextCursor, processedDigest: canonicalHash(page), eventCount: page?.events?.length ?? 0, verdict: problems.length ? 'stop' : 'processed', problems };
}
