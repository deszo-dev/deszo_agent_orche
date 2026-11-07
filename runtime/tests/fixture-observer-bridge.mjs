// Protocol fixture for the optional controller console; never connects to a user store.
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
const server = new McpServer({ name: 'controller-console-fixture', version: '1' });
const reply = data => ({ content: [{ type: 'text', text: JSON.stringify({ envelopeVersion: 1, status: 'ok', data }) }],
  structuredContent: { envelopeVersion: 1, status: 'ok', data } });
for (const name of ['observe_run', 'read_observation_detail', 'get_controller_state', 'await_run_start', 'acknowledge_run_observation', 'stop_and_report', 'prepare_emergency_stop'])
  server.registerTool(name, { description: name }, async () => reply({ fixture: name }));
server.registerTool('watch_run', { description: 'An intentionally slow oversized response.' }, async () => {
  await new Promise(done => setTimeout(done, 400));
  return reply({ events: [{ sequence: 1, payload: { reason: 'Long diagnostic. '.repeat(4000) } }] });
});
server.registerTool('stop_run', { description: 'Immediate fixture Stop.' }, async () => reply({ stopped: true }));
serveStdio(() => server);
