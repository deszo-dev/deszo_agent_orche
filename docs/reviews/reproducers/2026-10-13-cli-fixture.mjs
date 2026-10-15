// Audit fixture: emit a valid Codex stream with one UTF-8 character split across writes.
import { randomUUID } from 'node:crypto';
let input = '';
for await (const chunk of process.stdin) input += chunk.toString();
if (process.argv[2] === 'antigravity-stale') {
  const conversation_id = `audit-${randomUUID()}`;
  process.stdout.write(JSON.stringify({ event: 'init', init: { conversation_id } }) + '\n');
  process.stdout.write(JSON.stringify({ event: 'result', result: { conversation_id, status: 'SUCCESS', response: 'ORBIT\n', structured_output: { message: 'STALE FROM PREVIOUS TURN' } } }) + '\n');
  process.exit(0);
}
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: `audit-${randomUUID()}` }) + '\n');
const frame = Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Hello, 🌍' } }) + '\n');
const split = frame.indexOf(Buffer.from('🌍')) + 1;
process.stdout.write(frame.subarray(0, split));
await new Promise(done => setTimeout(done, 100));
process.stdout.write(frame.subarray(split));
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: {} }) + '\n');
