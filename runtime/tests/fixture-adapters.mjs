import { resolve } from 'node:path';
import { classifyFailure, createParser } from '../core/adapters.mjs';
import { canonicalHash } from '../core/canonical.mjs';

export const fixture = resolve(import.meta.dirname, 'fixture-cli.mjs');

export function fixtureAdapters(stateDir, { unavailable = [], managedMcpPreflight = false } = {}) {
  return {
    detect: async provider => ({
      provider, available: !unavailable.includes(provider), cliPath: process.execPath, cliVersion: 'fixture-1', fixture: !managedMcpPreflight, accountIdentity: canonicalHash({ provider, account: 'fixture' }),
      supportsNew: true, supportsResume: true, supportsJson: true, supportsInheritedConfiguration: provider !== 'antigravity',
      reason: unavailable.includes(provider) ? 'Run "codex login" with a ChatGPT account.' : null,
    }),
    buildInvocation: ({ provider, model, prompt, cwd, nativeSessionId, schemaPath }) => ({
      command: process.execPath, args: [fixture, model.replace(/^fixture-/, ''), nativeSessionId || '', stateDir, provider, schemaPath || ''], stdin: prompt, cwd, env: process.env,
    }),
    createParser: () => createParser('codex'),
    classifyFailure,
  };
}
