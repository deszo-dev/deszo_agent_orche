// Files a prepared incident request in the installed host's protected outbox under one policy. Filing records evidence only:
// delivery to the original profile still needs a registered runtime of that same policy at a properly authorized launch, so
// filing starts no runtime and grants no authority. Run it only after the policy that will be current for that launch exists;
// outbox rows are keyed by policy, and a later extension issues a new policy identity.
//   node scripts/file-incident-spool.mjs --policy <policyId> --request <incident-request.json>
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { connectHost } from '../runtime/host/ipc.mjs';
import { INSTALLED_HOST_PIPE } from '../runtime/host/nativeClient.mjs';

const argv = process.argv.slice(2);
const option = name => { const index = argv.indexOf(`--${name}`); return index < 0 ? null : argv[index + 1]; };
const policyId = option('policy');
const requestPath = option('request');
if (!policyId || !requestPath) {
  process.stderr.write('usage: node scripts/file-incident-spool.mjs --policy <policyId> --request <incident-request.json>\n');
  process.exit(2);
}
const { requestId, observation } = JSON.parse(readFileSync(resolve(requestPath), 'utf8'));
const client = connectHost(INSTALLED_HOST_PIPE, { timeoutMs: 30000 });
try {
  await client.ready;
  const result = await client.call('incidents.spool', { policyId, requestId, observation });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally { client.close(); }
