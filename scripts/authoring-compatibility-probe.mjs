// Live compatibility probe. This intentionally uses native models and subscription quota.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { startRunner } from '../runtime/runner.mjs';
import { detectProvider, buildInvocation } from '../runtime/core/adapters.mjs';
import { nativeInvocation } from './authoring-test-support.mjs';

const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const root = resolve(option('--root') || '.deszo/acceptance/adr0001-20261015-01');
const selected = (option('--providers') || 'codex,claude,antigravity').split(',');
const disableCodex = process.argv.includes('--codex-disable-servers');
const forceCodexMarker = process.argv.includes('--codex-force-marker');
const includeProject = process.argv.includes('--include-project');
const managedProfile = option('--profile') || 'inherit';
assert.ok(selected.every(p => ['codex', 'claude', 'antigravity'].includes(p)));
const models = { codex: 'gpt-6-luna', claude: 'haiku', antigravity: 'gemini-3.8-flash-low' };
const stamp = randomUUID().slice(0, 8);
const probeRoot = join(root, `native-${stamp}`); mkdirSync(probeRoot, { recursive: true });
const runner = await startRunner({ root: join(probeRoot, 'runtime') });
const bridge = resolve(option('--bridge') || 'mcp/bridge.mjs');
const proxy = resolve('scripts/authoring-probe-server.mjs');
const results = [];

function registration(provider, cwd, log) {
  const args = [proxy, '--bridge', bridge, '--evidence-file', log, '--connection-file', runner.connection.connectionFile, '--client-provider', provider];
  if (provider === 'antigravity') args.push('--working-directory', cwd, '--mcp-config-path', join(cwd, '.agents', 'mcp_config.json'));
  return { command: process.execPath, args };
}

// Add and later remove just our unique key; do not restore over unrelated concurrent updates.
function installJson(path, name, server) {
  const existed = existsSync(path); mkdirSync(dirname(path), { recursive: true });
  const originalText = existed ? readFileSync(path, 'utf8') : '';
  const value = originalText.trim() ? JSON.parse(originalText) : {};
  value.mcpServers ||= {}; assert.ok(!Object.hasOwn(value.mcpServers, name));
  value.mcpServers[name] = server; writeFileSync(path, JSON.stringify(value, null, 2));
  return () => {
    const current = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(current.mcpServers?.[name], server, 'The temporary registration changed unexpectedly.');
    delete current.mcpServers[name]; if (!Object.keys(current.mcpServers).length) delete current.mcpServers;
    if (!existed && !Object.keys(current).length) unlinkSync(path);
    else if (existed && !originalText.trim() && !Object.keys(current).length) writeFileSync(path, originalText);
    else writeFileSync(path, JSON.stringify(current, null, 2));
  };
}

function installCodex(path, name, server) {
  const existed = existsSync(path); mkdirSync(dirname(path), { recursive: true });
  const original = existed ? readFileSync(path, 'utf8') : '';
  const block = `\n# Deszo acceptance ${stamp}\n[mcp_servers.${name}]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\nstartup_timeout_sec = 20\ntool_timeout_sec = 30\nenabled = true\n`;
  writeFileSync(path, original + block);
  return () => {
    const current = readFileSync(path, 'utf8'); assert.ok(current.includes(block), 'The temporary registration changed unexpectedly.');
    const next = current.replace(block, '');
    if (!existed && !next) unlinkSync(path); else writeFileSync(path, next);
  };
}

try {
  for (const provider of selected) {
    const detected = await detectProvider(provider); assert.equal(detected.available, true, `${provider}: ${detected.reason}`);
    const cwd = join(probeRoot, provider, 'authoring'); mkdirSync(cwd, { recursive: true });
    const log = join(probeRoot, `${provider}-mcp.jsonl`);
    const name = `deszo_acceptance_${stamp}`;
    const server = registration(provider, cwd, log);
    const cleanups = [];
    try {
      if (provider === 'codex') cleanups.push(installCodex(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'), name, server));
      else if (provider === 'claude') cleanups.push(installJson(join(homedir(), '.claude.json'), name, server));
      else { mkdirSync(join(cwd, '.agents'), { recursive: true }); writeFileSync(join(cwd, '.agents', 'mcp_config.json'), JSON.stringify({ mcpServers: { [name]: server } }, null, 2)); }
      const names = [name];
      if (includeProject && provider === 'codex') {
        const projectName = `${name}_project`;
        cleanups.push(installCodex(join(cwd, '.codex', 'config.toml'), projectName, server));
        names.push(projectName);
      }
      if (includeProject && provider === 'claude') {
        const projectName = `${name}_project`;
        cleanups.push(installJson(join(cwd, '.mcp.json'), projectName, server));
        mkdirSync(join(cwd, '.claude'), { recursive: true });
        writeFileSync(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ enableAllProjectMcpServers: true }));
        names.push(projectName);
      }
      if (includeProject && provider === 'antigravity') {
        const globalName = `${name}_global`;
        cleanups.push(installJson(join(homedir(), '.gemini', 'config', 'mcp_config.json'), globalName, server));
        names.push(globalName);
      }
      let sessionId = null;
      for (const phase of ['authoring', 'managed', 'continued']) {
        const before = existsSync(log) ? readFileSync(log, 'utf8').length : 0;
        const disabling = disableCodex && provider === 'codex' && phase !== 'authoring';
        const profile = phase === 'authoring' ? 'inherit' : managedProfile;
        const visibleNames = provider === 'codex' && profile === 'restricted' ? [] : names;
        const prompt = `This is an authorized, read-only Deszo integration test. ${disabling
          ? `The ${names.join(', ')} MCP servers have been disabled by the invocation. Do not run commands or use other servers. Report whether their get_authoring_contract tools are available; do not work around their absence.`
          : visibleNames.length ? `Use ONLY each of the ${visibleNames.join(', ')} MCP servers' get_authoring_contract tool exactly once. Do not run commands, read or write files, or call other servers. ${phase === 'authoring' ? 'Report their storeId and status.' : 'Actually call the tools again, even if a prior turn was refused: the test needs a fresh observable refusal, not a prediction. Report the error code; do not work around the refusal.'}`
            : `Try each ${names.join(', ')} get_authoring_contract tool if it is available. The managed profile excludes their configuration. Do not run commands, use other servers, or work around absence; report unavailable tools.`}`;
        const invocation = buildInvocation({ provider, cliPath: detected.cliPath, model: models[provider], prompt, cwd,
          nativeSessionId: phase === 'continued' ? sessionId : null, output: { format: 'text' }, nativeConfiguration: profile, timeoutSeconds: 150 });
        if (provider === 'codex' && includeProject) invocation.args.unshift('-c', `projects.${JSON.stringify(cwd)}.trust_level="trusted"`);
        if (disabling) for (const serverName of names) invocation.args.splice(invocation.args.length - 1, 0, '-c', `mcp_servers.${serverName}.enabled=false`);
        if (forceCodexMarker && provider === 'codex' && phase !== 'authoring') for (const serverName of visibleNames)
          invocation.args.splice(invocation.args.length - 1, 0, '-c', `mcp_servers.${serverName}.env.DESZO_MANAGED_INVOCATION=${JSON.stringify(runner.connection.runtimeInstanceId)}`);
        invocation.env = { ...invocation.env };
        if (phase === 'authoring') delete invocation.env.DESZO_MANAGED_INVOCATION;
        else invocation.env.DESZO_MANAGED_INVOCATION = runner.connection.runtimeInstanceId;
        const prefix = join(probeRoot, `${provider}-${phase}`);
        console.log(JSON.stringify({ phase: 'native-start', provider, probe: phase, cliVersion: detected.cliVersion }));
        const outcome = await nativeInvocation(invocation, { provider, prefix, timeoutMs: 165_000,
          secrets: [runner.connection.token, runner.connection.firstPartyToken] });
        const observations = existsSync(log) ? readFileSync(log, 'utf8').slice(before).trim().split('\n').filter(Boolean).map(JSON.parse) : [];
        const calls = observations.filter(o => o.event === 'response' && o.method === 'tools/call' && o.tool === 'get_authoring_contract');
        const starts = observations.filter(o => o.event === 'started');
        const passed = outcome.exitCode === 0 && outcome.terminal && !outcome.error && (disabling || !visibleNames.length
          ? starts.length === 0 && calls.length === 0
          : starts.length >= visibleNames.length && calls.length >= visibleNames.length && (phase === 'authoring'
            ? starts.every(o => !o.markerPresent) && calls.every(o => o.status === 'ok')
            : starts.every(o => o.markerPresent) && calls.every(o => o.code === 'managed_invocation_denied')));
        if (phase === 'managed') sessionId = outcome.sessionId;
        const row = { provider, phase, cliVersion: detected.cliVersion, requestedModel: models[provider], observedModel: outcome.model,
          exitCode: outcome.exitCode, timedOut: outcome.timedOut, terminal: outcome.terminal, error: outcome.error,
          finalText: outcome.finalText, observations, sessionId: outcome.sessionId, nativeConfiguration: profile, arguments: invocation.args,
          mechanism: phase === 'authoring' ? 'positive-control' : disabling ? 'codex-disable-servers'
            : forceCodexMarker && provider === 'codex' ? 'codex-explicit-mcp-marker' : 'marker-propagation', passed };
        results.push(row); writeFileSync(join(probeRoot, 'result.json'), JSON.stringify({ results }, null, 2));
        console.log(JSON.stringify({ phase: 'native-result', provider, probe: phase, passed, error: outcome.error, mcpStarts: starts.length, calls: calls.length }));
        if (!passed) break;
        if (phase === 'managed' && !sessionId) break;
      }
    } finally { for (const cleanup of cleanups.reverse()) cleanup(); }
  }
} finally {
  await runner.close();
  writeFileSync(join(probeRoot, 'result.json'), JSON.stringify({ results }, null, 2));
}
const passed = selected.every(provider => results.filter(r => r.provider === provider).length === 3 && results.filter(r => r.provider === provider).every(r => r.passed));
console.log(JSON.stringify({ phase: 'completed', root: probeRoot, passed }));
if (!passed) process.exitCode = 1;
