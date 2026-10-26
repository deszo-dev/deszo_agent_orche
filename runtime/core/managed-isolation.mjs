import { homedir } from 'node:os';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import neutralizers from '../../docs/authoring/mcp-neutralizers.json' with { type: 'json' };

const code = 'managed_tool_isolation_unavailable';
const failure = message => Object.assign(new Error(message), { code });
const normalizedPath = path => {
  const value = resolve(path).replaceAll('\\', '/');
  return process.platform === 'win32' ? value.toLowerCase() : value;
};

function ancestors(directory) {
  const paths = [];
  let current = resolve(directory);
  while (true) {
    paths.push(current);
    const parent = dirname(current);
    if (parent === current) return paths;
    current = parent;
  }
}

function samePath(left, right) { return normalizedPath(left) === normalizedPath(right); }

// Any Deszo bridge counts, not only this runtime's own: the installed app's bundled runtime/bridge.mjs,
// the development mcp/bridge.mjs and older installs. The bridge requires --connection-file, so a bridge.mjs launched with it is one.
function launchesDeszoBridge(values) {
  const tokens = values.flatMap(value => value.split(/\s+/)).map(token => token.replace(/^['"]|['"]$/g, ''));
  const launchesBridge = tokens.some(token => token.replaceAll('\\', '/').split('/').pop().toLowerCase() === 'bridge.mjs');
  const hasConnectionFile = tokens.some(token => token === '--connection-file' || token.startsWith('--connection-file='));
  return launchesBridge && hasConnectionFile;
}

function serverIsBridge(server, bridgeScript) {
  if (!server || typeof server !== 'object' || server.disabled === true || server.enabled === false) return false;
  const expected = normalizedPath(bridgeScript);
  const values = [server.command, ...(Array.isArray(server.args) ? server.args : [])].filter(value => typeof value === 'string');
  if (launchesDeszoBridge(values)) return true;
  return values.some(value => {
    if (!value) return false;
    try { if (samePath(value, bridgeScript)) return true; } catch { /* It may be an argument string rather than a path. */ }
    const normalized = value.replaceAll('\\', '/');
    return normalizedPath(value.split(/\s+/)[0].replace(/^['"]|['"]$/g, '')) === expected || normalized.includes(expected);
  });
}

function addJsonServers(value, scope, bridgeScript, found, disabledNames = new Set()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const add = (servers, managed = false) => {
    if (!servers || typeof servers !== 'object') return;
    const entries = Array.isArray(servers)
      ? servers.map((server, index) => [server?.name || `managed-${index + 1}`, server])
      : Object.entries(servers);
    for (const [name, server] of entries)
      if (!disabledNames.has(name) && serverIsBridge(server, bridgeScript)) found.push({ scope, name });
  };
  add(value.mcpServers || value.mcp_servers);
  add(value.managedMcpServers, true);
}

async function readOptional(path, scope) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 1024 * 1024) throw failure(`Managed-run isolation could not inspect the ${scope} MCP configuration.`);
    return await readFile(path, 'utf8');
  }
  catch (error) {
    if (error?.code === code) throw error;
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw failure(`Managed-run isolation could not inspect the ${scope} MCP configuration.`);
  }
}

async function scanJson(path, scope, bridgeScript, found) {
  const value = await readJsonConfig(path, scope);
  if (value === null) return;
  const disabled = new Set([
    ...(Array.isArray(value.disabledMcpServers) ? value.disabledMcpServers : []),
    ...(Array.isArray(value.disabledMcpjsonServers) ? value.disabledMcpjsonServers : []),
  ].filter(item => typeof item === 'string'));
  addJsonServers(value, scope, bridgeScript, found, disabled);
}

async function readJsonConfig(path, scope) {
  const text = await readOptional(path, scope);
  if (text === null) return null;
  let value;
  try { value = JSON.parse(text); }
  catch { throw failure(`Managed-run isolation could not parse the ${scope} MCP configuration.`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure(`Managed-run isolation could not resolve the ${scope} MCP configuration.`);
  return value;
}

function parseTomlString(raw) {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try { return JSON.parse(value.split(/\s+#/, 1)[0].trim()); } catch { return null; }
  }
  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1);
    return end > 0 ? value.slice(1, end) : null;
  }
  return null;
}

function parseTomlStringArray(raw) {
  const value = raw.trim();
  if (!value.startsWith('[')) return [];
  const strings = value.match(/"(?:\\.|[^"\\])*"|'[^']*'/g) || [];
  return strings.map(item => item.startsWith('"') ? parseTomlString(item) : item.slice(1, -1)).filter(item => item !== null);
}

function codexBridgeServers(text, scope, bridgeScript, found) {
  let current = null;
  const finish = () => {
    if (current && current.enabled !== false && serverIsBridge({ command: current.command, args: current.args }, bridgeScript)) found.push({ scope, name: current.name });
  };
  for (const line of text.split(/\r?\n/)) {
    const table = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (table) {
      finish();
      const section = table[1].trim();
      const match = section.match(/^mcp_servers\.(?:"((?:\\.|[^"\\])+)"|'([^']+)'|([A-Za-z0-9_-]+))$/);
      current = match ? { name: match[1] || match[2] || match[3], args: [] } : null;
      continue;
    }
    if (!current) continue;
    const command = line.match(/^\s*command\s*=\s*(.+?)\s*(?:#.*)?$/);
    if (command) current.command = parseTomlString(command[1]);
    const args = line.match(/^\s*args\s*=\s*(.+?)\s*(?:#.*)?$/);
    if (args) current.args = parseTomlStringArray(args[1]);
    const enabled = line.match(/^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/);
    if (enabled) current.enabled = enabled[1] === 'true';
  }
  finish();
}

async function scanCodex(cwd, bridgeScript, found, scopes) {
  const home = process.env.CODEX_HOME || join(homedir(), '.codex');
  const userConfig = join(home, 'config.toml');
  scopes.push('user');
  const userText = await readOptional(userConfig, 'Codex user');
  if (userText !== null) codexBridgeServers(userText, 'user', bridgeScript, found);
  for (const directory of ancestors(cwd)) {
    const config = join(directory, '.codex', 'config.toml');
    const scope = `project:${normalizedPath(directory)}`;
    scopes.push('project');
    const text = await readOptional(config, 'Codex project');
    if (text !== null) codexBridgeServers(text, scope, bridgeScript, found);
  }
  if (process.platform !== 'win32') {
    scopes.push('system');
    const systemText = await readOptional('/etc/codex/config.toml', 'Codex system');
    if (systemText !== null) codexBridgeServers(systemText, 'system', bridgeScript, found);
  }
}

async function scanClaude(cwd, bridgeScript, found, scopes) {
  const home = homedir();
  const configDirectory = process.env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  const homeConfig = join(home, '.claude.json');
  scopes.push('user', 'local');
  const text = await readOptional(homeConfig, 'Claude user');
  if (text !== null) {
    let value;
    try { value = JSON.parse(text); }
    catch { throw failure('Managed-run isolation could not parse the Claude user MCP configuration.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('Managed-run isolation could not resolve the Claude user MCP configuration.');
    addJsonServers(value, 'user', bridgeScript, found);
    const cwdPaths = new Set(ancestors(cwd).map(normalizedPath));
    for (const [projectPath, project] of Object.entries(value.projects || {})) {
      if (!cwdPaths.has(normalizedPath(projectPath))) continue;
      const disabled = new Set([
        ...(Array.isArray(project.disabledMcpServers) ? project.disabledMcpServers : []),
        ...(Array.isArray(project.disabledMcpjsonServers) ? project.disabledMcpjsonServers : []),
      ]);
      addJsonServers(project, 'local', bridgeScript, found, disabled);
    }
  }
  for (const config of [join(configDirectory, 'settings.json'), join(configDirectory, 'settings.local.json')]) {
    await scanJson(config, 'Claude user settings', bridgeScript, found);
  }
  const managedDirectory = process.platform === 'win32'
    ? join(process.env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode')
    : process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode' : '/etc/claude-code';
  scopes.push('system');
  for (const filename of ['managed-settings.json', 'managed-mcp.json'])
    await scanJson(join(managedDirectory, filename), 'Claude managed', bridgeScript, found);
  for (const directory of ancestors(cwd)) {
    const settings = await Promise.all([
      readJsonConfig(join(directory, '.claude', 'settings.json'), 'Claude project settings'),
      readJsonConfig(join(directory, '.claude', 'settings.local.json'), 'Claude project settings'),
    ]);
    const disabled = new Set(settings.flatMap(value => [
      ...(Array.isArray(value?.disabledMcpServers) ? value.disabledMcpServers : []),
      ...(Array.isArray(value?.disabledMcpjsonServers) ? value.disabledMcpjsonServers : []),
    ]));
    const projectMcp = await readJsonConfig(join(directory, '.mcp.json'), 'Claude project');
    if (projectMcp) {
      for (const name of [...(projectMcp.disabledMcpServers || []), ...(projectMcp.disabledMcpjsonServers || [])]) disabled.add(name);
      addJsonServers(projectMcp, 'project', bridgeScript, found, disabled);
    }
    for (const value of settings) if (value) {
      const localDisabled = new Set([
        ...(Array.isArray(value.disabledMcpServers) ? value.disabledMcpServers : []),
        ...(Array.isArray(value.disabledMcpjsonServers) ? value.disabledMcpjsonServers : []),
      ]);
      addJsonServers(value, 'project-settings', bridgeScript, found, localDisabled);
    }
    scopes.push('project');
  }
}

// The dedicated authoring configuration is deliberately not scanned: its directory lies outside every workspace and copied Map
// directory, so a managed Antigravity run does not load it. Only the global and workspace-ancestor configurations can load.
async function scanAntigravity(cwd, bridgeScript, found, scopes) {
  const globalConfig = join(homedir(), '.gemini', 'config', 'mcp_config.json');
  scopes.push('user', 'project');
  await scanJson(globalConfig, 'Antigravity user', bridgeScript, found);
  for (const directory of ancestors(cwd)) await scanJson(join(directory, '.agents', 'mcp_config.json'), 'Antigravity project', bridgeScript, found);
}

function coveredScopes(neutralizer, configuredScopes) {
  return Array.isArray(neutralizer.scopes) && [...configuredScopes].every(scope => neutralizer.scopes.includes(scope));
}

function codexMarkerOverride(name, runtimeInstanceId) {
  if (!/^[A-Za-z0-9_-]+$/.test(name) || typeof runtimeInstanceId !== 'string' || !runtimeInstanceId)
    throw failure('The verified Codex MCP marker override requires a simple server name and a runtime identity.');
  return `mcp_servers.${name}.env.DESZO_MANAGED_INVOCATION=${JSON.stringify(runtimeInstanceId)}`;
}

function verifiedNeutralizer(provider, cliVersion, args, entries, configuredScopes, bridgeEntries, runtimeInstanceId) {
  const entry = entries.find(item => item.provider === provider && item.testedVersion === cliVersion);
  const neutralizer = entry?.neutralizer;
  if (entry?.status !== 'verified' || !neutralizer || typeof neutralizer !== 'object') return null;
  if (neutralizer.kind === 'marker-propagation' && coveredScopes(neutralizer, configuredScopes))
    return neutralizer.id || `marker-propagation:${cliVersion}`;
  if (provider === 'codex' && neutralizer.kind === 'codex-restricted-config-omission' && coveredScopes(neutralizer, configuredScopes)) {
    const command = args.indexOf('exec');
    if (command >= 0 && args.indexOf('--ignore-user-config') > command && !args.some(arg => arg.startsWith('mcp_servers.')))
      return neutralizer.id || `codex-restricted-config-omission:${cliVersion}`;
  }
  if (provider === 'codex' && neutralizer.kind === 'codex-explicit-mcp-marker' && coveredScopes(neutralizer, configuredScopes)) {
    const command = args.indexOf('exec');
    if (args.indexOf('--ignore-user-config') > command && command >= 0 && !args.some(arg => arg.startsWith('mcp_servers.')))
      return neutralizer.id || `codex-restricted-config-omission:${cliVersion}`;
    if (command >= 0 && bridgeEntries.every(({ name }) => {
      const expected = codexMarkerOverride(name, runtimeInstanceId);
      return args.some((arg, index) => index > command && arg === '-c' && args[index + 1] === expected);
    })) return neutralizer.id || `codex-explicit-mcp-marker:${cliVersion}`;
  }
  if (neutralizer.kind === 'launch-arguments') {
    const required = Array.isArray(neutralizer.requiredArgs) ? neutralizer.requiredArgs : [];
    const forbidden = Array.isArray(neutralizer.forbiddenArgs) ? neutralizer.forbiddenArgs : [];
    const coveredScopes = Array.isArray(neutralizer.scopes) ? neutralizer.scopes : [];
    if ([...configuredScopes].every(scope => coveredScopes.includes(scope)) && required.every(argument => args.includes(argument)) && forbidden.every(argument => !args.includes(argument)))
      return neutralizer.id || `launch-arguments:${cliVersion}`;
  }
  return null;
}

async function checkManagedToolIsolation({ provider, cliVersion, cwd, args = [], bridgeScript, runtimeInstanceId, registry = neutralizers } = {}, prepare = false) {
  if (!['codex', 'claude', 'antigravity'].includes(provider) || !cwd || !bridgeScript || !Array.isArray(args))
    throw failure('Managed-run isolation could not resolve the provider configuration scopes.');
  const found = [], scopes = [];
  try {
    if (provider === 'codex') await scanCodex(cwd, bridgeScript, found, scopes);
    if (provider === 'claude') await scanClaude(cwd, bridgeScript, found, scopes);
    if (provider === 'antigravity') await scanAntigravity(cwd, bridgeScript, found, scopes);
  } catch (error) {
    if (error?.code === code) throw error;
    throw failure('Managed-run isolation could not resolve the provider configuration scopes.');
  }
  const uniqueScopes = [...new Set(scopes)].sort();
  if (!found.length) return { mechanism: 'bridge-marker-refusal', checkedScopes: uniqueScopes, bridgeEntries: [] };
  const scopeKind = scope => scope.startsWith('project:') || ['Antigravity project', 'project-settings'].includes(scope) ? 'project'
    : ['Antigravity user', 'Claude user settings'].includes(scope) ? 'user' : scope === 'Claude managed' ? 'system' : scope;
  const configuredScopes = new Set(found.map(item => scopeKind(item.scope)));
  const selected = registry.entries?.find(item => item.provider === provider);
  if (prepare && provider === 'codex' && selected?.status === 'verified' && selected.testedVersion === cliVersion &&
      selected.neutralizer?.kind === 'codex-explicit-mcp-marker' && coveredScopes(selected.neutralizer, configuredScopes) && !args.includes('--ignore-user-config')) {
    // Restricted omits these config transports; env-only overrides would invent invalid transports.
    const overrides = [...new Set(found.map(item => item.name))].flatMap(name => ['-c', codexMarkerOverride(name, runtimeInstanceId)]);
    // exec consumes its own overrides; root-level flags did not establish the observed MCP child environment.
    args.splice(args.at(-1) === '-' ? args.length - 1 : args.length, 0, ...overrides);
  }
  const neutralizerId = verifiedNeutralizer(provider, cliVersion, args, registry.entries || [], configuredScopes, found, runtimeInstanceId);
  if (!neutralizerId) {
    const locations = [...new Set(found.map(item => item.scope))].join(', ');
    throw failure(`A Deszo MCP bridge entry may load from ${locations} in this managed ${provider} invocation, and no verified neutralizer covers CLI version "${cliVersion || 'unknown'}".`);
  }
  return {
    mechanism: 'verified-neutralizer', checkedScopes: uniqueScopes,
    bridgeEntries: found.map(({ scope, name }) => ({ scope, name })), neutralizerId,
  };
}

export const inspectManagedToolIsolation = input => checkManagedToolIsolation(input);
export const prepareManagedToolIsolation = input => checkManagedToolIsolation(input, true);
