// Binds a Deszo runtime to the Local Control Host that launched or covers it (ADR-0006 bootstrap steps 4-5).
//
// The variables are read once and removed from this process's environment, so no workflow child, agent CLI or
// candidate inherits the registration proof, the attach secret or the host endpoint. A runtime launched by a host
// operation redeems its one-time launch proof; the controlling runtime at session start attaches with the generation
// and attach secret its controller obtained at registration. Neither path conveys consent or controller authority.
//
// A fixture-assurance host is refused unless a test harness sets DESZO_ALLOW_FIXTURE_HOST=1 and the runtime is not the
// packaged application, so a production runtime cannot be bound to fixture authority.
import { connectHost } from './ipc.mjs';
import { INSTALLED_HOST_PIPE } from './nativeClient.mjs';

export const HOST_ENV = ['DESZO_CONTROL_HOST_PIPE', 'DESZO_HOST_POLICY_ID', 'DESZO_HOST_RUNTIME_GENERATION', 'DESZO_HOST_ATTACH_SECRET',
  'DESZO_HOST_OPERATION_ID', 'DESZO_HOST_REGISTRATION_NONCE', 'DESZO_HOST_PROCESS_EVIDENCE', 'DESZO_HOST_PROFILE_ROOT', 'DESZO_HOST_NODE_PATH', 'DESZO_HOST_BUILD_ID', 'DESZO_HOST_PROTOCOL_VERSION'];

export async function hostFromEnvironment(env = process.env, { packaged = false } = {}) {
  const values = Object.fromEntries(HOST_ENV.map(key => [key, env[key]]));
  const allowFixture = env.DESZO_ALLOW_FIXTURE_HOST === '1' && !packaged;
  for (const key of HOST_ENV) delete env[key];
  const pipe = values.DESZO_CONTROL_HOST_PIPE;
  if (packaged && pipe && pipe !== INSTALLED_HOST_PIPE) throw new Error('This packaged runtime refuses a fixture Local Control Host or any non-installed host endpoint.');
  if (!pipe) {
    if (packaged && process.platform === 'win32') {
      const observer = connectHost(INSTALLED_HOST_PIPE, { timeoutMs: 2000 }); let context = null;
      try { context = await observer.call('runtime.context'); } catch { /* No service means no surviving service-owned domain; manual mode keeps its existing confirmation. */ }
      finally { observer.close(); }
      if (context?.requiresBinding) throw new Error('The native service owns this candidate process. Its scoped host bootstrap is required and cannot be removed.');
    }
    return null;
  }
  const policyId = values.DESZO_HOST_POLICY_ID;
  if (!policyId) throw new Error('DESZO_CONTROL_HOST_PIPE is set without DESZO_HOST_POLICY_ID.');
  const client = connectHost(pipe);
  try {
    let binding;
    if (values.DESZO_HOST_OPERATION_ID && values.DESZO_HOST_REGISTRATION_NONCE) {
      const processEvidence = JSON.parse(values.DESZO_HOST_PROCESS_EVIDENCE || 'null');
      binding = await client.call('runtime.register', {
        policyId, operationId: values.DESZO_HOST_OPERATION_ID, registrationNonce: values.DESZO_HOST_REGISTRATION_NONCE, processEvidence,
      });
    } else if (values.DESZO_HOST_RUNTIME_GENERATION && values.DESZO_HOST_ATTACH_SECRET) {
      binding = await client.call('runtime.attach', { policyId, runtimeGeneration: values.DESZO_HOST_RUNTIME_GENERATION, attachSecret: values.DESZO_HOST_ATTACH_SECRET });
      binding = { ...binding, runtimeGeneration: values.DESZO_HOST_RUNTIME_GENERATION };
    } else {
      if (!packaged || pipe !== INSTALLED_HOST_PIPE) throw new Error('A host-bound runtime needs a launch proof or a registered runtime generation with its attach secret.');
      // The installed service independently authenticates this replacement OS process. Identifiers alone cannot
      // recover a generation; the consumed bootstrap is neither inherited nor accepted again.
      binding = await client.call('runtime.reregister', { policyId });
    }
    const nativeVerification=packaged&&pipe===INSTALLED_HOST_PIPE&&binding.assurance==='bootstrap'&&binding.verificationOnly===true;
    if (binding.assurance !== 'production' && !allowFixture&&!nativeVerification) throw new Error(`This runtime refuses a ${binding.assurance} Local Control Host.`);
    return { client, adapter: client.engineAdapter(), runtimeGeneration: binding.runtimeGeneration, policyId, assurance: binding.assurance,
      buildId: values.DESZO_HOST_BUILD_ID ?? null, verificationOnly:binding.verificationOnly===true, protocolVersion: Number(values.DESZO_HOST_PROTOCOL_VERSION || 1), profileRoot: values.DESZO_HOST_PROFILE_ROOT ?? null };
  } catch (error) {
    client.close();
    throw error;
  }
}
