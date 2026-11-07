// Test-only Engine probe (P6-G0-FINAL). A test-built Engine that a real Shell and Lifecycle Host launched runs one command at a
// time through its own production bridge and its own production Custody client. Production packages never start it: it needs the
// test fault policy and the DESZO_TEST_ENGINE_PROBE environment variable, which only a test harness sets. A command names the Engine
// build it is for, so a successor Engine that inherits the environment never acts on it.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { testFaultHooksEnabled } from './testFaultPolicy.mjs';

const TEST_FAULTS_ENABLED = testFaultHooksEnabled(import.meta.url);
const POLL_MS = 50;

// A complete legacy whole-release activation request. A P6 Host refuses it before it reads the request's contents.
function legacyActivationRequest(context) {
  return {
    operationId: randomUUID(), action: 'application.activate_candidate', installationId: context.installationId,
    profileRoot: context.profileRoot, runId: randomUUID(), nodeInstanceId: 'p6-probe-node', candidateId: '0.2.1-repair.1',
    candidateDigest: 'a'.repeat(64), expectedGeneration: context.generation,
    judgeEvidence: { kind: 'judge', workflowId: 'p6-probe-workflow', judgeNodeInstanceId: 'p6-probe-judge', attemptId: randomUUID(),
      checkpointId: randomUUID() },
    readiness: { applicationResponsive: true, engineReady: true, sameProfile: true, sameStore: true },
  };
}

function writeAtomic(path, value) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, path);
}

/**
 * Starts the probe for one Engine. Returns null unless this is a test-built Engine that a test asked to probe.
 * A command file is `cmd-<engineBuildId>-<n>.json` with an `action` and its arguments. Its result is `res-<engineBuildId>-<n>.json`.
 */
export function startTestEngineProbe({ engine, lifecycleHost, env = process.env }) {
  if (!TEST_FAULTS_ENABLED || !env.DESZO_TEST_ENGINE_PROBE || !lifecycleHost?.context) return null;
  const { buildId, profileRoot } = lifecycleHost.context;
  const directory = join(profileRoot, 'p6-probe');
  mkdirSync(directory, { recursive: true });

  async function perform(command) {
    switch (command.action) {
      case 'legacy_activation':
        return lifecycleHost.activateCandidate(legacyActivationRequest(lifecycleHost.context));
      case 'custody_reserve':
        return engine.custodyCall('custody.reserve', command.payload);
      case 'custody_launch': {
        const reserved = await engine.custodyCall('custody.reserve', command.payload);
        const launched = await engine.custodyCall('custody.launch', { custodyId: reserved.custodyId, permit: reserved.permit });
        return { custodyId: reserved.custodyId, state: launched.state, processId: launched.processId ?? null };
      }
      case 'quiescence_state':
        // Whether this Engine currently refuses new Runs for a switch (the admission barrier's flag, read-only).
        return { active: engine.switchQuiescence?.active === true, operationId: engine.switchQuiescence?.operationId ?? null };
      case 'custody_status':
        return engine.custodyCall('custody.status', { custodyId: command.custodyId });
      case 'custody_stop':
        return engine.custodyCall('custody.stop', { custodyId: command.custodyId });
      case 'custody_cancel':
        return engine.custodyCall('custody.cancel', { custodyId: command.custodyId });
      case 'p5_materialize_preparation': {
        // The Engine's own production P5 workspace preparation for a journaled intent, with its own Host readers and enrollment.
        const prepared = await engine.materializeProtectedSelfRepairPreparation(command.intentRef, { recovery: command.recovery === true });
        return { evidence: prepared.evidence, evidenceArtifact: prepared.evidenceArtifact, loadedEnrollment: engine.protectedSelfRepairEnrollmentArtifact };
      }
      default:
        throw Object.assign(new Error(`The probe does not know the action ${command.action}.`), { code: 'probe_unknown_action' });
    }
  }

  let sequence = 1;
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    const file = join(directory, `cmd-${buildId}-${sequence}.json`);
    if (!existsSync(file)) return;
    const id = sequence;
    sequence += 1;
    busy = true;
    const command = JSON.parse(readFileSync(file, 'utf8'));
    perform(command)
      .then(value => ({ ok: true, value: value ?? null }))
      .catch(error => ({ ok: false, code: error.code ?? error.refusal?.code ?? 'probe_error', message: String(error.message ?? error) }))
      .then(outcome => writeAtomic(join(directory, `res-${buildId}-${id}.json`), { ...outcome, buildId, applicationPid: process.pid }))
      .catch(error => process.stderr.write('The Engine probe could not write its result: ' + error.message + '\n'))
      .finally(() => { busy = false; });
  }, POLL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
