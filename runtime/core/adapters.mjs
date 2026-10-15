import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawn } from 'node:child_process';
import { canonicalHash, parseStrictJson } from './canonical.mjs';
import { transportSchema } from './transport.mjs';
import { resolveEffort } from '../../shared/effort.mjs';

export const ADAPTER_VERSION = 2;

// Child environments never carry API credentials or third-party Claude routing variables.
export function subscriptionEnvironment(source = process.env) {
  const env = { ...source };
  const forbidden = new Set([
    'OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
    'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GEMINI_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
    'ANTHROPIC_BASE_URL', 'ANTHROPIC_PROFILE', 'ANTHROPIC_FEDERATION_RULE_ID',
    'ANTHROPIC_ORGANIZATION_ID', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'CLAUDE_CODE_EFFORT_LEVEL',
  ].map(key => key.toLowerCase()));
  for (const key of Object.keys(env)) if (forbidden.has(key.toLowerCase())) delete env[key];
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
export async function detectProvider(provider) {
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
    const status = await capture(cliPath, ['login', 'status']);
    const text = `${status.stdout}${status.stderr}`;
    if (!/Logged in using ChatGPT/i.test(text)) return { ...info, reason: 'Run "codex login" with a ChatGPT account.' };
    return { ...info, available: true, accountIdentity: canonicalHash({ provider, home: process.env.CODEX_HOME || join(homedir(), '.codex'), status: text.trim() }) };
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

// The prompt carries the complete contract; the native flag carries only its transport form.
export const outputContractText = output => output.format === 'json'
  ? `\n\nOutput contract: return only one JSON value${output.schema ? ` that validates against this complete JSON Schema after native transport decoding:\n${JSON.stringify(output.schema)}\nNative transport encoding: choose exactly one allowed object shape from the complete contract. The native finish schema can merge alternative shapes and require nullable fields. Set every field absent or forbidden in your chosen shape to null, never an empty array, empty string, invented issue or extra explanation. Supply the contract values for the fields your shape requires. Use the same encoded JSON object in your final response and native finish tool; do not add a separate reason or commentary to either.\n` : '. '}Do not wrap it in a code fence or add commentary.`
  : '';

export function buildInvocation({ provider, cliPath, model, effort, prompt, cwd, nativeSessionId, output, nativeConfiguration, timeoutSeconds, schemaPath }) {
  const requestedEffort = resolveEffort(effort);
  const restricted = nativeConfiguration !== 'inherit';
  const schema = output.format === 'json' && output.schema ? output.schema : null;
  let args, stdin = null;
  if (provider === 'codex') {
    args = [
      '-C', cwd, 'exec', ...(nativeSessionId ? ['resume', nativeSessionId] : []),
      '--json', '--skip-git-repo-check', ...(restricted ? ['--ignore-user-config', '--ignore-rules'] : []),
      '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"',
      '-c', `model_reasoning_effort="${requestedEffort}"`,
      '--model', model, '--dangerously-bypass-approvals-and-sandbox',
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
      '--print', prompt, '--output-format', 'stream-json', '--model', model,
      '--effort', requestedEffort,
      ...(schema ? ['--json-schema', JSON.stringify(schema)] : []), '--dangerously-skip-permissions',
      '--print-timeout', `${timeoutSeconds}s`, ...(nativeSessionId ? ['--conversation', nativeSessionId] : []),
    ];
  }
  return { command: cliPath, args, stdin, cwd, env: subscriptionEnvironment() };
}

export function classifyFailure(text) {
  if (/quota|usage.?limit|rate.?limit|credits.?exhaust|resource.?exhaust|limit.?reached|hit your limit|\b429\b/i.test(text)) return 'quota';
  if (/billing|paid credits|api key mode/i.test(text)) return 'billing_policy';
  if (/not logged|not authenticated|unauthorized|authentication|auth.?required|login required|please.*(log.?in|sign.?in)|invalid.*(token|credential)|\b401\b|run.*\/login/i.test(text)) return 'authentication';
  if (/permission.*(denied|required)|soft.denied|requires approval|waiting.*approval/i.test(text)) return 'permission';
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
  const state = { sessionId: null, finalText: null, error: null, formatError: null, terminal: false, model: null, usage: null };
  const feed = event => {
    const normalized = { sessionId: null, text: '', model: null };
    if (provider === 'codex') {
      if (event.type === 'thread.started') normalized.sessionId = event.thread_id;
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') { normalized.text = event.item.text || ''; state.finalText = event.item.text ?? ''; }
      if (event.type === 'turn.completed') { state.usage = event.usage ?? null; state.terminal = true; }
      if (event.type === 'turn.failed' || event.type === 'error') state.error = event.error?.message || event.message || JSON.stringify(event);
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
      if (event.event === 'step_update') normalized.text = event.step_update?.text_delta || '';
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
