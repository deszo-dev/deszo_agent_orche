import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { openBridge, CONTROLLER_TRANSPORT } from './stdio-client.mjs';

export { CONTROLLER_TRANSPORT };
export const CONTROL_TOOLS = Object.freeze(['get_controller_state', 'get_control_grant', 'await_run_start',
  'observe_run', 'read_observation_detail', 'acknowledge_run_observation', 'prepare_emergency_stop', 'stop_and_report']);
export function unwrap(reply) {
  const envelope = reply.structuredContent ?? JSON.parse(reply.content.find(item => item.type === 'text').text);
  if (envelope.status !== 'ok') throw Object.assign(new Error(envelope.error?.message ?? 'Deszo refused the request.'), envelope.error);
  return envelope.data;
}

// A fresh bridge holds fresh session credentials in memory. It cannot resume another bridge's authority.
export async function connectDeszo({ connectionFile, expectedStoreId, expectedBridge, allowExecution = false }) {
  if (!expectedStoreId || !expectedBridge) throw new Error('Pin expectedStoreId and expectedBridge from the reviewed preflight.');
  const descriptor = JSON.parse(await readFile(connectionFile, 'utf8'));
  if (!isAbsolute(descriptor.nodeExecutable ?? '') || !isAbsolute(descriptor.bridgeScript ?? '') ||
    descriptor.storeId !== expectedStoreId || resolve(descriptor.bridgeScript).toLowerCase() !== resolve(expectedBridge).toLowerCase())
    throw new Error('The selected descriptor does not match the reviewed store and bridge. Run doctor --live.');
  const bridge = await openBridge({ command: descriptor.nodeExecutable, script: descriptor.bridgeScript,
    // Node REPL exposes no process global. null lets child_process inherit the environment internally.
    env: null,
    args: ['--connection-file', resolve(connectionFile), '--client-provider', 'codex', ...(allowExecution ? ['--allow-execution'] : [])] });
  try {
    const contract = unwrap(await bridge.call('get_authoring_contract'));
    if (contract.storeId !== expectedStoreId || contract.runtimeInstanceId !== descriptor.runtimeInstanceId)
      throw new Error('The runtime changed during connection. Reconcile before creating a session.');
    const names = (await bridge.request('tools/list')).tools.map(item => item.name);
    if (allowExecution && CONTROL_TOOLS.some(name => !names.includes(name))) throw new Error('The selected bridge lacks complete supervised control tools.');
    return { ...bridge, contract, tools: names, clientVersion: CONTROLLER_TRANSPORT.clientVersion };
  } catch (error) { await bridge.close(); throw error; }
}
