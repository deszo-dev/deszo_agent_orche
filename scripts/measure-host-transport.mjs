// Measures the real round trip of the protected host's named-pipe transport. The installed-host calls are read-only
// (host.health, installation.status): they change no authority, store or process. Raw samples are written with a summary;
// configured timeout values are not measurements and are not written here.
//   node scripts/measure-host-transport.mjs --samples 40 --out <file.json>
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { connectHost } from '../runtime/host/ipc.mjs';
import { INSTALLED_HOST_PIPE } from '../runtime/host/nativeClient.mjs';

const argv = process.argv.slice(2);
const option = name => { const index = argv.indexOf(`--${name}`); return index < 0 ? null : argv[index + 1]; };
const samples = Math.max(5, Math.min(500, Number(option('samples') ?? 40)));
const out = option('out');

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = fraction => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  return { count: sorted.length, minMs: sorted[0], medianMs: at(0.5), p95Ms: at(0.95), maxMs: sorted.at(-1) };
}

const client = connectHost(INSTALLED_HOST_PIPE, { timeoutMs: 30000 });
const results = { kind: 'HostTransportMeasurement', measuredAt: new Date().toISOString(), node: process.version, platform: process.platform, target: 'installed host over the protected pipe', readOnly: true, operations: {} };
try {
  await client.ready;
  for (const method of ['host.health', 'installation.status']) {
    const durations = [];
    await client.call(method); // warm the connection; not counted
    for (let index = 0; index < samples; index += 1) {
      const started = performance.now();
      await client.call(method);
      durations.push(performance.now() - started);
    }
    results.operations[method] = { ...summarize(durations), rawMs: durations.map(value => Number(value.toFixed(3))) };
  }
} finally {
  client.close();
}
const text = `${JSON.stringify(results, null, 2)}\n`;
if (out) { mkdirSync(dirname(resolve(out)), { recursive: true }); writeFileSync(resolve(out), text); }
process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(results.operations).map(([name, value]) => [name, { count: value.count, medianMs: Number(value.medianMs.toFixed(2)), p95Ms: Number(value.p95Ms.toFixed(2)), maxMs: Number(value.maxMs.toFixed(2)) }]))) + '\n');
