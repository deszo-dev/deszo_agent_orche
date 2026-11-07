#!/usr/bin/env node
// Local Control Host entry point (ADR-0006). The protected Windows service runs `serve`; the separately authorized
// installation runs `enroll`; the user's host surface runs `status` and `revoke`, which work while Deszo is closed.
//
//   node host.mjs serve   --state <protected dir> [--pipe <name>] [--assurance production|fixture]
//   node host.mjs enroll  --state <dir> --credential-id <id> --public-key <base64 SPKI> --label <text> --installer <who>
//   node host.mjs status  --state <dir> --policy <policyId> [--pipe <name>]
//   node host.mjs revoke  --state <dir> --policy <policyId> [--actor <who>] [--pipe <name>]
//
// `status` asks the live owner when one answers; otherwise it reads the store read-only and says so. It never recovers,
// migrates or writes. `revoke` needs the live owner, because only the owner can stop processes; with no owner it refuses.
// `serve` in production assurance refuses to start while enablement capabilities are unverified (capabilities.mjs).
//
// Running this file does not install a service, set ACLs or create a Scheduled Task; those remain installation gates.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlHost } from './authority.mjs';
import { connectHost, hostPipeName, startHostServer } from './ipc.mjs';

const EXPIRY_CHECK_MS = 1000;

function options(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) throw new Error(`Unexpected argument ${argv[i]}.`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

// A writable host that owns its state: ownership is taken before any recovery or migration side effect.
function openOwned(root, { assurance }) {
  const host = new ControlHost({ root, assurance, recover: false });
  try {
    host.acquireOwnership();
    host.recover();
    return host;
  } catch (error) {
    host.close();
    throw error;
  }
}

// The live owner's answer, or null when no owner accepts connections on the pipe.
async function askLive(pipeName, method, params) {
  const client = connectHost(pipeName, { timeoutMs: 5000 });
  try {
    await client.ready;
  } catch {
    client.close();
    return null;
  }
  try { return await client.call(method, params); }
  finally { client.close(); }
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const args = options(rest);
  if (!args.state) throw new Error('--state <protected directory> is required.');
  const root = resolve(args.state);
  const pipeName = args.pipe || hostPipeName();
  const print = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

  if (command === 'serve') {
    const host = openOwned(root, { assurance: args.assurance || 'production' });
    host.issueUserSurfaceToken();
    const server = await startHostServer({ host, pipeName });
    const expiry = setInterval(() => host.enforceExpiry(), EXPIRY_CHECK_MS);
    print({ serving: pipeName, hostInstance: host.hostInstance, assurance: host.assurance, dispatchBlocked: host.dispatchBlocked, userSurfaceTokenFile: join(root, 'user-surface.token') });
    const stop = () => { clearInterval(expiry); server.close(); host.close(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }

  if (command === 'status') {
    const live = await askLive(pipeName, 'status', { policyId: args.policy });
    if (live) return print({ source: 'live_host', ...live });
    const host = new ControlHost({ root, readOnly: true });
    try { return print({ source: 'offline_snapshot', note: 'No live host answered; this is a read-only view and changes nothing.', ...host.status(args.policy) }); }
    finally { host.close(); }
  }

  if (command === 'revoke') {
    const token = readFileSync(join(root, 'user-surface.token'), 'utf8').trim();
    const live = await askLive(pipeName, 'revoke', { policyId: args.policy, actor: args.actor || 'user via host surface', userSurfaceToken: token });
    if (!live) throw new Error('No live Local Control Host owns this state. Revocation must reach the owner that stops processes; start the host and revoke again.');
    return print(live);
  }

  if (command === 'enroll') {
    if (!args.assurance) throw new Error('enroll needs --assurance production|fixture, matching the store it enrolls into.');
    const host = openOwned(root, { assurance: args.assurance });
    try { return print(host.enrollCredential({ credentialId: args['credential-id'], publicKey: args['public-key'], label: args.label || 'authenticator' }, { enrolledBy: args.installer })); }
    finally { host.close(); }
  }

  throw new Error(`Unknown command ${command}. Use serve, enroll, status or revoke.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exit(1); });
}
