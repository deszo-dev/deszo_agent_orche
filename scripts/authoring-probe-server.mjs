// Diagnostic stdio proxy: observe only protocol metadata, never tokens or tool result bodies.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

const options = process.argv.slice(2);
const take = name => { const index = options.indexOf(name); if (index < 0 || !options[index + 1]) throw new Error(`Missing ${name}`); const value = options[index + 1]; options.splice(index, 2); return value; };
const bridge = resolve(take('--bridge'));
const evidenceFile = resolve(take('--evidence-file'));
const record = value => appendFileSync(evidenceFile, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...value }) + '\n');
record({ event: 'started', markerPresent: Boolean(process.env.DESZO_MANAGED_INVOCATION) });
const requests = new Map();
function observe(stream, direction) {
  let buffer = '';
  stream.on('data', bytes => {
    buffer += bytes;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let value; try { value = JSON.parse(line); } catch { record({ event: 'invalid-json', direction }); continue; }
      if (direction === 'request' && value.method) {
        if (value.id !== undefined) requests.set(value.id, { method: value.method, tool: value.params?.name });
        record({ event: 'request', id: value.id, method: value.method, tool: value.params?.name });
      } else if (direction === 'response' && value.id !== undefined) {
        const request = requests.get(value.id);
        const result = value.result?.structuredContent;
        record({ event: 'response', id: value.id, ...request, isError: value.result?.isError === true || Boolean(value.error),
          tools: request?.method === 'tools/list' ? value.result?.tools?.map(tool => tool.name) : undefined,
          status: result?.status, code: result?.error?.code, httpStatus: result?.error?.status, workflowId: result?.data?.workflow?.workflowId,
          revision: result?.data?.revision, requestId: result?.data?.requestId, outcome: result?.data?.outcome,
          runId: result?.data?.run?.runId, untrusted: result?.untrusted, byteSize: result?.data?.byteSize,
          artifactSha256: result?.data?.sha256 });
      }
    }
  });
}
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', bridge, ...options], {
  windowsHide: true, env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
});
observe(process.stdin, 'request'); observe(child.stdout, 'response');
process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
child.stdin.on('error', () => {});
child.once('error', error => { record({ event: 'error', code: error.code }); process.exitCode = 1; });
child.once('close', code => { record({ event: 'closed', code }); process.exitCode = code ?? 1; });
process.stdin.once('end', () => child.stdin.end());
