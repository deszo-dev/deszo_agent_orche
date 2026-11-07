import { StringDecoder } from 'node:string_decoder';
import { assertValid } from './schemas.mjs';
import { ref } from './utilities.mjs';

// Durable, lossless capture of one process stream (ADR-0002 section 1). Bytes are published as immutable
// chunk artifacts in order and journaled with their offsets, so nothing depends on memory or on the
// process finishing. A stream stops only at its hard bound, which is an explicit capture-limit failure.
export const STREAM_BATCH_BYTES = 64 * 1024;
export const STREAM_BATCH_MS = 250;
export const STREAM_TAIL_BYTES = 8 * 1024;
export const STREAM_HARD_LIMIT_BYTES = 256 * 1024 * 1024;

export class CaptureLimitError extends Error {
  constructor(stream, limitBytes) {
    super(`The ${stream} stream reached its ${limitBytes}-byte capture limit; the process was stopped and the captured bytes are kept.`);
    this.code = 'capture_limit';
  }
}

export class StreamRecorder {
  // extended: a journal-v2 run may carry byte offsets and the closure event; v1 runs keep the original shape.
  // resume: a recorder continuing a stream that an earlier Engine already committed (Process Custody reattach). Its chunks and
  // committed byte count come from that Engine's durable journal, so the manifest and offsets continue without a gap or a repeat.
  constructor({ store, runId, attempt, stream, mediaType, hardLimitBytes = STREAM_HARD_LIMIT_BYTES, onFault = () => {}, extended = true, resume = null, deferFlush = false }) {
    Object.assign(this, { store, runId, attempt, stream, mediaType, hardLimitBytes, onFault, extended, deferFlush });
    this.pending = []; this.pendingBytes = 0; this.timer = null;
    this.chunks = resume ? resume.chunks.map(entry => ({ ...entry })) : [];
    this.committedBytes = resume ? resume.committedBytes : 0;
    this.receivedBytes = this.committedBytes; this.uncommittedBytes = 0;
    this.tail = Buffer.alloc(0); this.failed = null; this.writeFailed = false; this.closed = false;
  }

  add(chunk) {
    if (this.closed) throw new Error(`The ${this.stream} stream was added to after it closed.`);
    const accepted = this.failed ? 0 : Math.max(0, Math.min(chunk.length, this.hardLimitBytes - this.receivedBytes));
    this.receivedBytes += chunk.length;
    this.uncommittedBytes += chunk.length - accepted;
    this.tail = Buffer.concat([this.tail, chunk]).subarray(-STREAM_TAIL_BYTES);
    if (accepted) {
      this.pending.push(accepted === chunk.length ? chunk : chunk.subarray(0, accepted));
      this.pendingBytes += accepted;
      // deferFlush: the owner commits this stream explicitly (with its companion stream), so no size or timer flush happens here.
      if (this.deferFlush) { /* Held until the owner's flush. */ }
      else if (this.pendingBytes >= STREAM_BATCH_BYTES) this.flush();
      else if (!this.timer) this.timer = setTimeout(() => this.flush(), STREAM_BATCH_MS);
    }
    if (!this.failed && accepted < chunk.length) this.fault(new CaptureLimitError(this.stream, this.hardLimitBytes));
  }

  fault(error) {
    if (this.failed) return;
    this.failed = error;
    this.onFault(error);
  }

  flush() {
    clearTimeout(this.timer); this.timer = null;
    if (!this.pendingBytes) return;
    const bytes = Buffer.concat(this.pending);
    this.pending = []; this.pendingBytes = 0;
    if (this.writeFailed) { this.uncommittedBytes += bytes.length; return; }
    try {
      this.store.transaction(() => {
        const artifact = this.store.putBytes(bytes, this.mediaType);
        const entry = { index: this.chunks.length, byteOffset: this.committedBytes, byteLength: bytes.length, artifact: ref(artifact) };
        const payload = this.extended
          ? { stream: this.stream, chunk: entry.artifact, chunkIndex: entry.index, byteOffset: entry.byteOffset, byteLength: entry.byteLength }
          : { stream: this.stream, chunk: entry.artifact, chunkIndex: entry.index };
        this.store.appendEvents(this.runId, [{ type: 'attempt.log_chunk', nodeInstanceId: this.attempt.node_instance_id, attemptId: this.attempt.id, payload }]);
        this.chunks.push(entry);
        this.committedBytes += bytes.length;
      });
    } catch (error) {
      this.writeFailed = true; this.uncommittedBytes += bytes.length;
      this.fault(error);
    }
  }

  // Flush everything, publish the stream manifest and journal its closure. complete means the pipe reached EOF.
  close(endingReason, { complete }) {
    if (this.closed) throw new Error(`The ${this.stream} stream closed twice.`);
    this.flush();
    this.closed = true;
    const integrity = this.failed ? 'capture_failed' : complete && !this.uncommittedBytes ? 'complete' : 'partial';
    const manifest = { schemaVersion: 1, kind: 'StreamManifest', stream: this.stream, mediaType: this.mediaType,
      receivedBytes: this.receivedBytes, committedBytes: this.committedBytes, chunkCount: this.chunks.length, complete: integrity === 'complete',
      endingReason: endingReason.slice(0, 200), integrity, chunks: this.chunks };
    assertValid('execution-evidence.schema.json', 'streamManifest', manifest, 'Stream manifest');
    const manifestRef = ref(this.store.putJson(manifest));
    if (this.extended) this.store.transaction(() => this.store.appendEvents(this.runId, [{ type: 'attempt.log_stream_closed', nodeInstanceId: this.attempt.node_instance_id, attemptId: this.attempt.id,
      payload: { stream: this.stream, manifest: manifestRef, receivedBytes: this.receivedBytes, committedBytes: this.committedBytes, chunkCount: this.chunks.length,
        complete: manifest.complete, integrity, endingReason: manifest.endingReason } }]));
    return { manifest, manifestRef, integrity };
  }

  // The last bytes received, decoded without splitting a character. Used for diagnostics only.
  tailText() {
    const decoder = new StringDecoder('utf8');
    return decoder.write(this.tail) + decoder.end();
  }
}
