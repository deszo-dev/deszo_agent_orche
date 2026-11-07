// A harmless, read-only MCP server for the PoC's scoped-tool check. It exposes one tool that returns a fixed string and
// touches no Deszo state, no credentials and no network. A model that calls it proves tool reachability only.
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const server = new McpServer({ name: 'deszo-adr7-poc-echo', version: '0.1.0' });
server.registerTool('poc_scoped_echo', {
  title: 'PoC scoped echo',
  description: 'Returns the fixed string DESZO_POC_ECHO_OK. Read-only; used only to verify tool reachability in the ADR-0007 PoC.',
  inputSchema: z.object({ nonce: z.string().max(80) }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ nonce }) => ({ content: [{ type: 'text', text: `DESZO_POC_ECHO_OK nonce=${nonce}` }] }));

serveStdio(() => server);
