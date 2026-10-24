import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBridge, CONTROLLER_TRANSPORT } from '../mcp/stdio-client.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
export const RECEIPT_PATH = resolve(project, 'docs/authoring/controller-transport.json');
const hash = value => createHash('sha256').update(value).digest('hex');
export function transportIdentity() {
  return { ...CONTROLLER_TRANSPORT, platform: process.platform, nodeMajor: Number(process.versions.node.split('.')[0]),
    driverSha256: hash(readFileSync(resolve(project, 'mcp/stdio-client.mjs'), 'utf8').replaceAll('\r\n', '\n')) };
}
export function checkTransport(path = RECEIPT_PATH) {
  const identity = transportIdentity(), fingerprint = hash(JSON.stringify(identity));
  let receipt; try { receipt = JSON.parse(readFileSync(path, 'utf8')); } catch { /* Missing receipt is unverified. */ }
  const positive = receipt?.samples?.find(row => row.delayMs === 25_000);
  const negative = receipt?.samples?.find(row => row.delayMs === 60_000);
  const valid = receipt?.kind === 'DeszoControllerTransport' && receipt.passed === true && receipt.fingerprint === fingerprint &&
    positive?.passed === true && positive.error === null && positive.elapsedMs >= 25_000 && positive.elapsedMs < 35_000 &&
    negative?.passed === true && negative.error === 'controller_transport_timeout' && negative.elapsedMs >= 45_000 && negative.elapsedMs < 50_000;
  return { valid: Boolean(valid), fingerprint, identity, receipt: valid ? receipt : null,
    nextAction: valid ? 'reuse_verified_transport' : 'node scripts/deszo-transport.mjs --measure' };
}

async function measure(path) {
  const before = checkTransport(path);
  if (before.valid && !process.argv.includes('--force')) return { passed: true, cached: true, fingerprint: before.fingerprint };
  const samples = [];
  for (const delayMs of [25_000, 60_000]) {
    const bridge = await openBridge({ script: fileURLToPath(import.meta.url), args: ['--server'] });
    const start = performance.now(); let error = null;
    try { await bridge.call('delay', { delayMs }); } catch (cause) { error = cause.code ?? cause.message; }
    const elapsedMs = performance.now() - start;
    await bridge.close();
    const passed = delayMs === 25_000 ? error === null && elapsedMs >= 25_000 && elapsedMs < 35_000
      : error === 'controller_transport_timeout' && elapsedMs >= 45_000 && elapsedMs < 50_000;
    samples.push({ delayMs, elapsedMs, error, passed });
    if (!passed) throw new Error('The controller transport did not satisfy its measured bound.');
  }
  if (checkTransport(path).fingerprint !== before.fingerprint) throw new Error('The transport changed during measurement.');
  const receipt = { kind: 'DeszoControllerTransport', version: 1, measuredAt: new Date().toISOString(),
    fingerprint: before.fingerprint, identity: before.identity, passed: true, providerCalls: 0, samples,
    limitation: 'This explicit stdio driver only. Not the desktop default MCP transport, model latency, consent, or autonomous-worker authority.' };
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(receipt, null, 2) + '\n');
  return { passed: true, cached: false, fingerprint: before.fingerprint, providerCalls: 0, samples };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--server')) {
      const { McpServer } = await import('@modelcontextprotocol/server');
      const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
      const { z } = await import('zod');
      const server = new McpServer({ name: 'deszo-transport-fixture', version: '1' });
      server.registerTool('delay', { description: 'Synthetic transport check; no models or profile writes.',
        inputSchema: z.object({ delayMs: z.number().int().min(0).max(60_000) }) }, async ({ delayMs }) => {
        await new Promise(done => setTimeout(done, delayMs)); return { content: [{ type: 'text', text: 'completed' }] };
      });
      serveStdio(() => server); process.stdin.on('end', () => process.exit(0));
    } else {
      const result = process.argv.includes('--measure') ? await measure(RECEIPT_PATH) : checkTransport();
      console.log(JSON.stringify(result)); if (result.passed === false || result.valid === false) process.exitCode = 1;
    }
  } catch (error) { console.error(JSON.stringify({ passed: false, error: error.message })); process.exitCode = 1; }
}
