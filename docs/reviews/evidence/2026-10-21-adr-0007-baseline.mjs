// Read-only reproduction of the ADR-0007 historical baseline; invokes no runtime or model.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalBytes } from '../../../runtime/core/canonical.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const receipt = JSON.parse(readFileSync(join(directory, '2026-10-21-adr-0007-baseline.json'), 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const document = reference => {
  const bytes = readFileSync(join(directory, reference.file));
  assert.equal(digest(bytes), reference.sha256, `${reference.file}: exact-byte digest`);
  return JSON.parse(bytes.toString('utf8'));
};
const journal = document(receipt.sources.journal);
const observations = document(receipt.sources.observations);
const grant = document(receipt.sources.legacyGrant);
const counts = new Map(), streamBytes = new Map();
let sequence = receipt.journal.fromSequence - 1;
for (const event of journal.events) {
  assert.equal(event.metadata.sequence, ++sequence, 'contiguous journal');
  assert.equal(event.provenance.runId, receipt.runId, 'journal subject');
  const type = event.metadata.type;
  counts.set(type, (counts.get(type) ?? 0) + 1);
  if (type === 'attempt.log_chunk') {
    assert.ok(Number.isSafeInteger(event.payload.byteLength) && event.payload.byteLength >= 0);
    streamBytes.set(event.payload.stream, (streamBytes.get(event.payload.stream) ?? 0) + event.payload.byteLength);
  }
}
assert.equal(sequence, receipt.journal.frontier);
let pageCursor = 0;
for (const page of journal.pages) {
  assert.equal(page.afterSequence, pageCursor);
  assert.equal(page.first, pageCursor + 1);
  assert.equal(page.last - pageCursor, page.count);
  pageCursor = page.last;
}
assert.equal(pageCursor, sequence);
assert.equal(digest(canonicalBytes(journal.events)), receipt.journal.canonicalEventsSha256);
assert.deepEqual(Object.fromEntries([...counts].sort()), receipt.journal.eventsByType);

const ids = new Set();
let observationCursor = 0;
for (const item of observations.items) {
  assert.equal(item.runId, receipt.runId);
  assert.equal(item.controllerSessionId, grant.controllerSessionId);
  assert.ok(!ids.has(item.observationId), 'unique saved observation');
  ids.add(item.observationId);
  assert.equal(item.fromCursor, observationCursor, 'saved observation prefix');
  assert.equal(item.eventCount, item.cursor - item.fromCursor);
  assert.ok(item.cursor <= sequence);
  observationCursor = item.cursor;
}
assert.equal(observationCursor, receipt.observations.savedPrefixEndSequence);
assert.equal(grant.grantId, receipt.legacy.grantId);
assert.equal(grant.workflowSnapshotSha256, receipt.workflowSnapshotSha256);
assert.equal(grant.observationDeadlineMs, receipt.legacy.attentionIntervalMs);
assert.equal(grant.escalationDeadlineMs, receipt.legacy.escalationIntervalMs);
const metrics = {
  journalEvents: journal.events.length,
  logEvents: counts.get('attempt.log_chunk') ?? 0,
  semanticAndLifecycleEvents: journal.events.length - (counts.get('attempt.log_chunk') ?? 0),
  logEventPercent: Number((100 * (counts.get('attempt.log_chunk') ?? 0) / journal.events.length).toFixed(1)),
  capturedStdoutBytes: streamBytes.get('stdout') ?? 0,
  capturedNormalizedBytes: streamBytes.get('normalized') ?? 0,
  savedObservationBatches: ids.size,
};
assert.deepEqual(metrics, receipt.metrics);

// Optional stronger check against all original saved observations, without copying their contents.
if (process.argv[2]) {
  assert.equal(process.argv[2], '--originals-root');
  assert.ok(process.argv[3], 'supply the original preflight-run directory');
  assert.equal(process.argv.length, 4);
  for (const item of observations.items) {
    const bytes = readFileSync(join(process.argv[3], item.sourceFile));
    assert.equal(digest(bytes), item.sourceSha256, item.sourceFile);
    const saved = JSON.parse(bytes.toString('utf8')).data;
    const data = item.sourceFile === 'start-observation.json' ? saved.observation : saved;
    assert.equal(data.observationId, item.observationId);
    assert.equal(data.fromCursor, item.fromCursor);
    assert.equal(data.cursor, item.cursor);
    assert.equal(data.events.length, item.eventCount);
  }
}
console.log(JSON.stringify({ status: 'verified', runId: receipt.runId, frontier: sequence,
  legacyAttentionIntervalMs: grant.observationDeadlineMs, metrics,
  originalObservationFilesVerified: Boolean(process.argv[3]), judgeTokenUsage: null }, null, 2));
