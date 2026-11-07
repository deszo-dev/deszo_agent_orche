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
  if (scenario.startsWith('antigravity-finish-')) {
    const rejected = { outcome: 'READY_FOR_REVIEW', issueSummary: null, attemptedApproaches: null };
    if (scenario !== 'antigravity-finish-invalid-result') {
      line({ event: 'step_update', step_update: { step_index: 2, step_type: 'tool', state: 'ERROR', tool_name: 'finish',
        tool_info: { error: { type: 'TOOL_ERROR', message: "invalid arguments:\n- at '/attemptedApproaches': got null, want array\n- at '/issueSummary': got null, want string" } } } });
    }
    if (scenario === 'antigravity-finish-timeout') { await new Promise(done => setTimeout(done, 60_000)); process.exit(1); }
    const result = scenario === 'antigravity-finish-invalid-result' ? rejected : { outcome: 'READY_FOR_REVIEW', issueSummary: '', attemptedApproaches: [] };
    line({ event: 'result', result: { conversation_id, status: 'SUCCESS', response: JSON.stringify(result), structured_output: result } });
    process.exit(0);
  }
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
