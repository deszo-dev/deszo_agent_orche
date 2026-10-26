import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawn } from 'node:child_process';
import { canonicalHash, parseStrictJson } from './canonical.mjs';
import { transportSchema } from './transport.mjs';
import { resolveEffort } from '../../shared/effort.mjs';

export const ADAPTER_VERSION = 3;

// Child environments never carry API credentials or third-party Claude routing variables.
export function subscriptionEnvironment(source = process.env) {
  const env = { ...source };
  const forbidden = new Set([
    'OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
    'DESZO_PROCESS_CUSTODY', 'DESZO_OWNER_TOKEN', 'OWNER_TOKEN', 'FIRST_PARTY_TOKEN', 'HOST_TOKEN',
    'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GEMINI_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
    'ANTHROPIC_BASE_URL', 'ANTHROPIC_PROFILE', 'ANTHROPIC_FEDERATION_RULE_ID',
    'ANTHROPIC_ORGANIZATION_ID', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'CLAUDE_CODE_EFFORT_LEVEL', 'CODEX_VERSION',
  ].map(key => key.toLowerCase()));
  const forbiddenPrefixes = ['deszo_lifecycle_', 'deszo_supervisor_', 'deszo_launch_shim', 'deszo_custody_',
    'deszo_test_duplicate_lifecycle', 'deszo_judge_', 'deszo_host_', 'codex_app_', 'codex_internal_',
    'codex_permission_', 'codex_session_', 'codex_task_', 'codex_thread_', 'codex_tool_', 'codex_mcp_',
    'codex_sage_', 'codex_apply_patch_', 'codex_windows_sandbox_'];
  for (const key of Object.keys(env)) {
    const lower = key.toLowerCase();
    if (forbidden.has(lower) || forbiddenPrefixes.some(prefix => lower.startsWith(prefix))) delete env[key];
  }
  return env;
}

export async function discoverCli(provider) {
  const name = provider === 'antigravity' ? 'agy' : provider;
  const home = homedir();
  const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`] : [name];
  const dirs = [
    ...(process.env.PATH || process.env.Path || '').split(delimiter),
    join(home, '.local', 'bin'), join(local, 'Microsoft', 'WinGet', 'Links'),
    join(local, 'agy', 'bin'), '/usr/local/bin', '/opt/homebrew/bin',
  ].filter(Boolean);
  if (provider === 'codex') {
    const bundled = join(local, 'OpenAI', 'Codex', 'bin');
    try {
      for (const folder of (await readdir(bundled, { withFileTypes: true })).filter(entry => entry.isDirectory())) dirs.push(join(bundled, folder.name));
    } catch { /* Optional desktop installation. */ }
  }
  for (const dir of dirs) for (const filename of names) {
    const candidate = join(dir, filename);
    if (existsSync(candidate) && !candidate.endsWith('.cmd')) return candidate;
  }
  return null;
}

export function capture(command, args, { timeout = 30_000, env = subscriptionEnvironment() } = {}) {
  return new Promise(resolve => {
    let child;
    try { child = spawn(command, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { resolve({ code: -1, stdout: '', stderr: error.message }); return; }
    let stdout = '', stderr = '', settled = false;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { child.kill(); finish({ code: -1, stdout, stderr: `${stderr}\nDiagnostic timeout` }); }, timeout);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => finish({ code: -1, stdout, stderr: error.message }));
    child.on('close', code => finish({ code, stdout, stderr }));
  });
}

async function antigravitySettings() {
  try { return JSON.parse(await readFile(join(homedir(), '.gemini', 'antigravity-cli', 'settings.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('Antigravity billing settings could not be read.'); }
}

// Detection never issues a model request.
export async function detectProvider(provider, { processCustody = false } = {}) {
  const base = {
    provider, available: false, cliPath: null, cliVersion: null, accountIdentity: null,
    supportsNew: true, supportsResume: true, supportsJson: true,
    supportsInheritedConfiguration: provider !== 'antigravity', reason: null,
  };
  const cliPath = await discoverCli(provider);
  if (!cliPath) return { ...base, supportsNew: false, supportsResume: false, supportsJson: false, supportsInheritedConfiguration: false, reason: 'The official CLI was not found on this machine.' };
  const version = await capture(cliPath, ['--version']);
  const info = { ...base, cliPath, cliVersion: version.stdout.trim() || null };
  if (provider === 'codex') {
    let windowsSandboxMode = null;
    try { windowsSandboxMode = await codexWindowsSandboxModeForRun(processCustody); }
    catch { return { ...info, reason: 'Codex Windows sandbox configuration could not be read safely.' }; }
    const [rootHelp, execHelp] = await Promise.all([capture(cliPath, ['--help']), capture(cliPath, ['exec', '--help'])]);
    const custodySupport = codexCustodySupport(`${rootHelp.stdout}\n${rootHelp.stderr}`, `${execHelp.stdout}\n${execHelp.stderr}`);
    const status = await capture(cliPath, ['login', 'status']);
    const text = `${status.stdout}${status.stderr}`;
    if (status.code !== 0 || !/Logged in using ChatGPT/i.test(text)) return { ...info, windowsSandboxMode, supportsCustodyExec: custodySupport.supported,
      custodyReason: custodySupport.reason, reason: 'Run "codex login" with a ChatGPT account.' };
    return { ...info, available: true, windowsSandboxMode, supportsCustodyExec: custodySupport.supported, custodyReason: custodySupport.reason,
      accountIdentity: canonicalHash({ provider, home: process.env.CODEX_HOME || join(homedir(), '.codex'), status: text.trim() }) };
  }
  if (provider === 'claude') {
    const status = await capture(cliPath, ['auth', 'status', '--json']);
    try {
      const parsed = JSON.parse(status.stdout);
      if (!(parsed.loggedIn && parsed.authMethod === 'claude.ai' && parsed.apiProvider === 'firstParty')) return { ...info, reason: 'Run "claude auth login" with a subscription account.' };
      return { ...info, available: true, accountIdentity: canonicalHash({ provider, email: parsed.email || null, org: parsed.orgId || parsed.organizationId || null, subscription: parsed.subscriptionType || null }) };
    } catch { return { ...info, reason: 'Subscription authentication could not be confirmed.' }; }
  }
  try {
    const settings = await antigravitySettings();
    if (settings.modelProvider) return { ...info, reason: 'Remove the API modelProvider from Antigravity settings.json to use the subscription.' };
    if (settings.useG1Credits === true) return { ...info, reason: 'Disable useG1Credits in Antigravity settings.json; paid credits are not allowed.' };
  } catch (error) { return { ...info, reason: error.message }; }
  return { ...info, available: true, accountIdentity: canonicalHash({ provider, home: homedir() }), reason: 'Authentication is confirmed by the first invocation. Native-configuration inheritance is not supported.' };
}

// These options are verified from the installed CLI help before a Custody invocation can start.
export function codexCustodySupport(rootHelp, execHelp) {
  const missing = [];
  for (const option of ['--ask-for-approval']) if (!rootHelp.includes(option)) missing.push(option);
  for (const option of ['--json', '--sandbox', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check'])
    if (!execHelp.includes(option)) missing.push(option);
  return missing.length
    ? { supported: false, reason: `Installed Codex CLI does not support required Custody options: ${missing.join(', ')}.` }
    : { supported: true, reason: null };
}

// Restricted execution ignores user config so a user's MCP bridges cannot start inside the managed CLI. Preserve only
// the configured Windows sandbox backend explicitly; it selects the OS implementation while --sandbox still limits the
// Codex filesystem policy to workspace-write.
export function codexWindowsSandboxMode(configText) {
  let section = '';
  for (const line of String(configText || '').split(/\r?\n/)) {
    const table = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (table) { section = table[1].trim(); continue; }
    if (section !== 'windows') continue;
    const setting = line.match(/^\s*sandbox\s*=\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*(?:#.*)?$/);
    if (!setting) continue;
    const mode = setting[1] || setting[2] || setting[3];
    return ['elevated', 'unelevated', 'mxc'].includes(mode) ? mode : null;
  }
  return null;
}

async function configuredCodexWindowsSandboxMode() {
  if (process.platform !== 'win32') return null;
  const home = process.env.CODEX_HOME || join(homedir(), '.codex');
  try { return codexWindowsSandboxMode(await readFile(join(home, 'config.toml'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Only Process Custody needs to restore the selected Windows sandbox backend after user config is omitted.
export async function codexWindowsSandboxModeForRun(processCustody, readConfiguredMode = configuredCodexWindowsSandboxMode) {
  if (processCustody !== true) return null;
  return await readConfiguredMode();
}

// The prompt carries the complete contract; the native flag carries only its transport form.
export const outputContractText = output => output.format === 'json'
  ? `\n\nOutput contract: return only one JSON value${output.schema ? ` that validates against this complete JSON Schema after native transport decoding:\n${JSON.stringify(output.schema)}\nNative transport encoding: choose exactly one allowed object shape from the complete contract. Every required field must have its declared type. For a required non-nullable string or array with no applicable content, use an empty string or empty array only if the contract permits it; never substitute null. Null is allowed only when the native schema explicitly permits it. Native transport can merge alternative shapes and add nullable fields: use null for fields absent or forbidden in your chosen contract shape, and do not invent content for those fields. Use the same encoded JSON object in your final response and native finish tool; do not add a separate reason or commentary to either. If finish reports a validation error, correct the named fields before calling finish again; repeating the rejected object does not complete the task.\n` : '. '}Do not wrap it in a code fence or add commentary.`
  : '';

function antigravityPrintTimeout(timeoutSeconds) {
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new Error('Antigravity requires a positive process timeout.');
  const processMs = timeoutSeconds * 1000;
  // Let the CLI publish its terminal timeout result before the engine kills the process tree.
  const graceMs = Math.min(30_000, Math.max(1000, Math.ceil(processMs / 10)), processMs / 2);
  return `${Math.max(1, Math.floor(processMs - graceMs))}ms`;
}

export function buildInvocation({ provider, cliPath, model, effort, prompt, cwd, nativeSessionId, output, nativeConfiguration, timeoutSeconds, schemaPath,
  processCustody = false, windowsSandboxMode = null }) {
  const requestedEffort = resolveEffort(effort);
  const restricted = nativeConfiguration !== 'inherit';
  const schema = output.format === 'json' && output.schema ? output.schema : null;
  let args, stdin = null;
  if (provider === 'codex') {
    args = [
      '-C', cwd, ...(processCustody ? ['--ask-for-approval', 'never'] : []), 'exec', ...(nativeSessionId ? ['resume', nativeSessionId] : []),
      '--json', '--skip-git-repo-check', ...(restricted ? ['--ignore-user-config', '--ignore-rules'] : []),
      '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"',
      ...(processCustody && ['elevated', 'unelevated', 'mxc'].includes(windowsSandboxMode) ? ['-c', `windows.sandbox="${windowsSandboxMode}"`] : []),
      '-c', `model_reasoning_effort="${requestedEffort}"`,
      '--model', model,
      ...(processCustody ? ['--sandbox', 'workspace-write', '--ephemeral'] : ['--dangerously-bypass-approvals-and-sandbox']),
      ...(schema ? ['--output-schema', schemaPath] : []), '-',
    ];
    stdin = prompt;
  } else if (provider === 'claude') {
    args = [
      '-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages',
      ...(schema ? ['--json-schema', JSON.stringify(schema)] : []), '--model', model,
      '--effort', requestedEffort,
      '--dangerously-skip-permissions', ...(restricted ? ['--safe-mode', '--strict-mcp-config', '--setting-sources', ''] : []),
      ...(nativeSessionId ? ['--resume', nativeSessionId] : []),
    ];
    stdin = prompt;
  } else {
    args = [
      '--input-format', 'text', '--output-format', 'stream-json', '--model', model,
      '--effort', requestedEffort,
      ...(schema ? ['--json-schema', JSON.stringify(schema)] : []), '--dangerously-skip-permissions',
      '--print-timeout', antigravityPrintTimeout(timeoutSeconds), ...(nativeSessionId ? ['--conversation', nativeSessionId] : []),
    ];
    stdin = prompt;
  }
  return { command: cliPath, args, stdin, cwd, env: subscriptionEnvironment() };
}

export function classifyFailure(text) {
  if (/rate[ -]?limit|too many requests|\b429\b/i.test(text)) return 'rate_limited';
  if (/quota|usage.?limit|credits.?exhaust|resource.?exhaust|limit.?reached|hit your limit/i.test(text)) return 'quota';
  if (/billing|paid credits|api key mode/i.test(text)) return 'billing_policy';
  if (/not logged|not authenticated|unauthorized|authentication|auth.?required|login required|please.*(log.?in|sign.?in)|invalid.*(token|credential)|\b401\b|run.*\/login/i.test(text)) return 'authentication';
  if (/permission.*(denied|required)|soft.denied|requires approval|waiting.*approval/i.test(text)) return 'permission';
  if (/malformed JSONL|JSONL protocol|invalid provider event/i.test(text)) return 'provider_protocol';
  if (/temporarily unavailable|service unavailable|gateway timeout|upstream error|\b50[0-4]\b/i.test(text)) return 'provider_unavailable';
  if (/no conversation found|session.*not found|unknown session|could not resume/i.test(text)) return 'context_unavailable';
  return 'process';
}

const structuredText = value => (value === undefined || value === null ? null : typeof value === 'string' ? value : JSON.stringify(value));

// The final answer for the current output contract. Text answers use the turn's textual response.
// JSON answers prefer a parseable textual response of this turn; a structured field is used only
// when the turn has no textual response, and a conflicting pair is rejected as ambiguous.
// Antigravity may concatenate a JSON answer and its finish-tool echo. Accept only a complete
// JSON-object sequence whose EVERY payload equals the structured value; never search prose.
function matchingNativeMessages(text, structured, nativeSchema, decodeNative = value => value) {
  try {
    const expected = typeof structured === 'string' ? parseStrictJson(structured) : structured;
    const digest = canonicalHash(decodeNative(expected));
    let offset = 0, count = 0;
    while (offset < text.length) {
      while (/\s/.test(text[offset] || '') && offset < text.length) offset++;
      if (offset === text.length) break;
      if (text[offset] !== '{') return false;
      const start = offset;
      let depth = 0, quoted = false, escaped = false;
      for (; offset < text.length; offset++) {
        const char = text[offset];
        if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
        else if (char === '"') quoted = true;
        else if (char === '{' || char === '[') depth++;
        else if (char === '}' || char === ']') { if (--depth === 0) { offset++; break; } }
      }
      if (depth !== 0 || quoted) return false;
      const message = parseStrictJson(text.slice(start, offset));
      for (const key of ['toolAction', 'toolSummary']) {
        if (!Object.hasOwn(nativeSchema.properties || {}, key) && typeof message[key] === 'string') delete message[key];
      }
      if (canonicalHash(decodeNative(message)) !== digest) return false;
      count++;
    }
    return count > 0;
  } catch { return false; }
}

export function selectFinal({ text, structured, format, turnScopedStructured, nativeSchema, decodeNative }) {
  const response = text === undefined || text === null ? null : String(text);
  if (format !== 'json') return { finalText: response };
  if (structured === undefined || structured === null) return { finalText: response };
  if (turnScopedStructured) return { finalText: structuredText(structured) };
  if (response === null || !response.trim()) return { finalText: structuredText(structured) };
  if (nativeSchema && matchingNativeMessages(response, structured, nativeSchema, decodeNative)) return { finalText: structuredText(structured) };
  try { parseJsonAnswer(response); return { finalText: response }; }
  catch { return { finalText: null, error: 'The CLI reported a structured result that does not match this turn\'s response; the stale or ambiguous value was not used.' }; }
}

// Normalizes one provider stream event; the parser keeps the last final answer it reports.
export function createParser(provider, { output = { format: 'text' } } = {}) {
  const expectedTransport = provider === 'antigravity' && output.format === 'json' && output.schema ? transportSchema(output.schema) : null;
  const expectedNativeSchema = expectedTransport?.schema;
  // error: a provider/process failure; formatError: an answer that violates the output contract.
  const state = { sessionId: null, finalText: null, error: null, formatError: null, protocolError: false, terminal: false, model: null, usage: null, diagnostics: [] };
  const feed = event => {
    const normalized = { sessionId: null, text: '', model: null };
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      const message = 'Invalid provider event: each JSONL record must be a JSON object.';
      state.protocolError = true;
      state.error ??= message;
      normalized.protocolError = message;
      normalized.providerEvent = event;
      return normalized;
    }
    if (provider === 'codex') {
      // Keep each structured event in the normalized stream; raw stdout remains the exact byte-level evidence.
      normalized.providerEvent = event;
      if (event.type === 'thread.started') normalized.sessionId = event.thread_id;
      if (event.type === 'turn.started') normalized.model = event.model || event.turn?.model || event.turn?.model_slug || null;
      if (event.type === 'item.updated' && event.item?.type === 'agent_message') normalized.text = event.item.text || '';
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') { normalized.text = event.item.text || ''; state.finalText = event.item.text ?? ''; }
      if (event.type === 'turn.completed') { state.usage = event.usage ?? null; state.terminal = true; }
      if (event.type === 'turn.failed' || event.type === 'error') {
        const message = event.error?.message || event.message || JSON.stringify(event);
        // Retry progress remains diagnostic. A successful terminal event is still required.
        if (event.type === 'error' && /^Reconnecting\.\.\.\s+[1-9]\d*\/[1-9]\d*\s+\(stream disconnected before completion:[\s\S]+\)$/.test(message)) normalized.diagnostic = message;
        else state.error = message;
      }
    } else if (provider === 'claude') {
      normalized.sessionId = event.session_id || null;
      if (event.type === 'system' && event.subtype === 'init') normalized.model = event.model || null;
      if (event.type === 'stream_event' && event.event?.delta?.type === 'text_delta') normalized.text = event.event.delta.text || '';
      if (event.type === 'result') {
        // Claude's result event is turn-scoped, so its structured output belongs to this turn.
        const chosen = selectFinal({ text: typeof event.result === 'string' ? event.result : structuredText(event.result), structured: event.structured_output, format: output.format, turnScopedStructured: true });
        state.finalText = chosen.finalText;
        if (chosen.error) state.formatError = chosen.error;
        state.usage = event.usage ?? null; state.terminal = true;
        if (event.is_error || /error/.test(event.subtype || '')) state.error = (event.errors || []).join('\n') || event.result || JSON.stringify(event);
      }
    } else {
      normalized.sessionId = event.conversation_id || event.init?.conversation_id || event.result?.conversation_id || null;
      if (event.event === 'init') normalized.model = event.init?.model || null;
      if (event.event === 'step_update') {
        const step = event.step_update || {};
        normalized.text = step.text_delta || '';
        if (step.step_type === 'tool' && step.state === 'ERROR') {
          const error = step.tool_info?.error ?? step.error;
          const message = typeof error?.message === 'string' ? error.message : structuredText(error) || 'Tool execution failed.';
          const tool = String(step.tool_name || step.tool_info?.name || 'tool').slice(0, 120);
          const diagnostic = `Antigravity ${tool} step ${step.step_index ?? '?'}: ${message}`.slice(0, 2000);
          // Tool errors can be repaired within the same CLI turn; retain evidence without
          // marking the invocation terminal or turning a later valid result into a failure.
          if (!state.diagnostics.includes(diagnostic)) {
            state.diagnostics.push(diagnostic);
            if (state.diagnostics.length > 8) state.diagnostics.shift();
            normalized.diagnostic = diagnostic;
          }
        }
      }
      if (event.event === 'result') {
        const result = event.result || {};
        // Antigravity can repeat an earlier turn's structured output on a later text turn.
        const matchingSchema = expectedNativeSchema && result.json_schema && canonicalHash(expectedNativeSchema) === canonicalHash(result.json_schema);
        const chosen = selectFinal({ text: result.response, structured: result.structured_output, format: output.format, turnScopedStructured: false, nativeSchema: matchingSchema ? expectedNativeSchema : null, decodeNative: expectedTransport?.decode });
        state.finalText = chosen.finalText;
        if (chosen.error) state.formatError = chosen.error;
        state.usage = result.usage ?? null; state.terminal = true;
        if (result.status !== 'SUCCESS') state.error = result.error || `Antigravity status: ${result.status}`;
      }
    }
    if (normalized.sessionId) state.sessionId = normalized.sessionId;
    if (normalized.model) state.model = normalized.model;
    return normalized;
  };
  return { state, feed };
}

export function parseJsonAnswer(text) {
  const trimmed = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return parseStrictJson(trimmed);
}

export const defaultAdapters = { detect: detectProvider, buildInvocation, createParser, classifyFailure };
