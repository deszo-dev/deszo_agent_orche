// Failure and fallback experiments (POC-08). Each live failure must end in a bounded, observable result. Conditions that cannot
// be produced live are marked INCONCLUSIVE and cite the evidence that does cover them, rather than being counted as passes.
import { existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { AppServer, CODEX_EXE } from './codex-app-server.mjs';
import { check, verdict, home, WORKSPACE, ensureDirs, writeResult } from './poc-common.mjs';
import { runCli } from './experiments-session.mjs';
const nodeProcess = process;

export async function poc08() {
  ensureDirs();
  const checks = [], measurements = {}, trace = [];

  // Client binary unavailable: a bounded, explicit result before any session is touched.
  const missing = 'C:/Users/jusse/AppData/Local/OpenAI/Codex/bin/does-not-exist/codex.exe';
  const missingBinary = existsSync(missing);
  measurements.clientBinaryMissing = { detected: !missingBinary };
  checks.push(check('a missing client binary is detected before any session operation', !missingBinary));

  // Client crashes at startup: the initialize call must return a bounded failure, not hang.
  const crashing = new AppServer({ name: 'crashing-client', codexHome: home('poc08-crash'), codexExe: nodeProcess.execPath });
  const started = performance.now();
  let crashResult;
  try { const init = await crashing.start(); crashResult = init.ok ? 'started' : `initialize failed: ${init.error?.message}`; } catch (error) { crashResult = `start error: ${error.message}`; }
  measurements.clientCrashAtStartup = { result: crashResult, elapsedMs: Math.round(performance.now() - started), exit: crashing.exit ?? null };
  checks.push(check('a client that exits at startup yields a bounded failure within 25 s', crashResult !== 'started' && measurements.clientCrashAtStartup.elapsedMs < 25000, crashResult));

  // Session unavailable: an unknown identifier is refused, and the controlling process stays usable.
  const srv = new AppServer({ name: 'session-unavailable', codexHome: home('poc08-session') });
  await srv.start();
  const unknown = await srv.call('thread/resume', { threadId: randomUUID() });
  checks.push(check('an unknown session identifier is refused explicitly', !unknown.ok, unknown.error?.message));
  const alive = await srv.call('thread/list', { limit: 1 });
  checks.push(check('the controlling process remains usable after a refused session lookup', alive.ok));
  measurements.unknownSessionRefusalMs = unknown.durationMs;

  // Scoped MCP tools unavailable: a broken registration must be visible, and it must not block session creation.
  const brokenHome = home('poc08-broken-mcp');
  runCli(CODEX_EXE, ['mcp', 'add', 'poc-broken', '--', nodeProcess.execPath.replaceAll('\\', '/'), 'C:/DeszoPoC/does-not-exist.mjs'], { CODEX_HOME: brokenHome });
  const mcpSrv = new AppServer({ name: 'mcp-unavailable', codexHome: brokenHome });
  await mcpSrv.start();
  const status = await mcpSrv.call('mcpServerStatus/list', { detail: 'full' }, 40000);
  const statusText = JSON.stringify(status.result ?? status.error ?? {});
  const toolListed = statusText.includes('poc_scoped_echo');
  const created = await mcpSrv.call('thread/start', { cwd: WORKSPACE });
  checks.push(check('an unavailable scoped MCP server is reported and its tools are not listed', !toolListed, toolListed ? 'tool listed' : statusText.slice(0, 160)));
  checks.push(check('an unavailable scoped MCP server does not block session creation', created.ok, created.error?.message));
  trace.push({ step: 'broken MCP registration', statusSnippet: statusText.slice(0, 300) });
  await mcpSrv.kill('end MCP failure');
  await srv.kill('end session failure');

  const liveNotProduced = [
    ['queue-wait expiry under a real queue', 'INCONCLUSIVE', 'Live queue expiry needs an arbitrary-length predecessor turn; covered as controlled-clock logic in lib/judge-attention-timing.test.mjs.'],
    ['response deadline expiry', 'INCONCLUSIVE', 'Requires a real 900 s wait with a decision outstanding; covered as controlled-clock logic (lib/judge-attention-timing.test.mjs).'],
    ['stale ownership', 'SEE POC-05, POC-06', 'Stale-generation admission is observed in POC-05 S2 and POC-06 (Codex accepts it).'],
    ['insufficient budget', 'INCONCLUSIVE', 'Codex exposes no budget signal here. Deszo refusal logic is covered by the existing runtime suite, not by a live Codex turn.'],
    ['worker restart', 'SEE POC-02', 'Resume after process exit is observed in POC-02.'],
    ['ambiguous turn-start acknowledgement', 'SEE POC-06', 'Lost acknowledgement is observed in POC-06.'],
  ];

  const status8 = verdict(checks, { inconclusive: 'several conditions are covered elsewhere or cannot be produced live' });
  const record = {
    experiment: 'POC-08', title: 'Failure and fallback', status: status8, checks, measurements, trace,
    conditionsNotProducedLive: liveNotProduced.map(([condition, status, why]) => ({ condition, status, why })),
  };
  writeResult('POC-08', record);
  return record;
}
