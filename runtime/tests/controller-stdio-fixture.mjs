import { createInterface } from 'node:readline';
let canceled = 0;
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const lines = createInterface({ input: process.stdin, terminal: false });
lines.on('line', line => {
  const input = JSON.parse(line);
  if (input.method === 'notifications/cancelled') { canceled++; return; }
  if (input.method === 'initialize') { send(input.id, { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } }); return; }
  if (input.method !== 'tools/call') return;
  if (input.params.name === 'hold') return;
  if (input.params.name === 'status') { send(input.id, { canceled }); return; }
  if (input.params.name === 'oversized') { send(input.id, { text: 'x'.repeat(1024) }); return; }
  const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: input.id, result: { text: 'Привет 🌍' } }) + '\n');
  const index = bytes.indexOf(Buffer.from('🌍')) + 1;
  process.stdout.write(bytes.subarray(0, index)); setTimeout(() => process.stdout.write(bytes.subarray(index)), 10);
});
