// Stream fixture for decoding and normalization regressions (from the M1–M6 implementation review).
import { randomUUID } from 'node:crypto';
let input = '';
for await (const chunk of process.stdin) input += chunk.toString();
const scenario = process.argv[2] || 'split-utf8';
const line = value => process.stdout.write(JSON.stringify(value) + '\n');
if (scenario.startsWith('antigravity-')) {
  // A later text turn whose CLI result still carries an earlier turn's structured output.
  const conversation_id = `stream-${randomUUID()}`;
  line({ event: 'init', init: { conversation_id } });
  const response = scenario === 'antigravity-json-current' ? '{"message":"CURRENT"}' : 'ORBIT\n';
  line({ event: 'result', result: { conversation_id, status: 'SUCCESS', response, structured_output: { message: 'STALE FROM PREVIOUS TURN' } } });
  process.exit(0);
}
line({ type: 'thread.started', thread_id: `stream-${randomUUID()}` });
const frame = Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Hello, 🌍 — привет' } }) + '\n');
const split = frame.indexOf(Buffer.from('🌍')) + 1;
process.stdout.write(frame.subarray(0, split));
await new Promise(done => setTimeout(done, 100));
process.stdout.write(frame.subarray(split));
if (scenario === 'noisy') for (let i = 0; i < 200; i++) line({ type: 'fixture_noise', index: i, padding: 'x'.repeat(400) });
line({ type: 'turn.completed', usage: {} });
