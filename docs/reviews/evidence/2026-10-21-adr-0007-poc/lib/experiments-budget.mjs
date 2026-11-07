// POC-07: budget and authority boundaries. Two parts with different owners. The Deszo side runs the existing managed-invocation,
// reservation, permit and authority tests. The Codex side records whether the App Server itself refuses a turn that carries no
// host reservation. The second part is a boundary observation: it decides where enforcement must live, not whether Deszo's code is correct.
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, verdict, RESULTS_DIR, ensureDirs, writeResult } from './poc-common.mjs';

const TEST_PATTERN = 'managed|reserve|budget|permit|invocation|authority|expired|revoked';

export async function poc07({ codexTurnAdmittedWithoutReservation }) {
  ensureDirs();
  const started = performance.now();
  const run = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', '--test-concurrency=1', `--test-name-pattern=${TEST_PATTERN}`, 'runtime/tests/*.test.mjs'], {
    cwd: join(import.meta.dirname, '../../../../..'), encoding: 'utf8', windowsHide: true, timeout: 590000, maxBuffer: 64 * 1024 * 1024,
  });
  const tap = `${run.stdout || ''}${run.stderr || ''}`;
  writeFileSync(join(RESULTS_DIR, 'POC-07-deszo-side.tap'), tap);
  const count = name => Number((tap.match(new RegExp(`^# ${name} (\\d+)`, 'm')) || [])[1] ?? NaN);
  const pass = count('pass'), fail = count('fail');
  const checks = [
    check('the existing Deszo managed-invocation, reservation, permit and authority tests pass', run.status === 0 && fail === 0 && pass > 0, `pass=${pass} fail=${fail} exit=${run.status}`),
    check('the App Server refuses a turn that carries no host-issued reservation', !codexTurnAdmittedWithoutReservation, codexTurnAdmittedWithoutReservation ? 'a turn with no reservation was admitted and emitted turn/started; enforcement must sit in the adapter and at the process boundary' : 'refused'),
  ];
  const record = {
    experiment: 'POC-07', title: 'Budget and authority boundaries', status: verdict(checks, { inconclusive: 'provider usage and live accounting are not observable without a sign-in' }), checks,
    measurements: { durationMs: Math.round(performance.now() - started), testPattern: TEST_PATTERN, deszoTestsPassed: pass, deszoTestsFailed: fail, deszoTestsExit: run.status },
    notes: [
      'The Codex client did not enforce a host reservation. This is a boundary fact about the App Server, not about Deszo. The ADR must place enforcement in the adapter (sole path to turn/start, holding the only credential) and in the process boundary.',
      'Deszo side: the test names matched are listed in the TAP file. Full suite evidence (578/578) is recorded separately.',
      'Not observed here: whether an exhausted budget or expired authority would be extended by a real Codex turn, and what a provider charges. Both need a signed-in session and provider usage telemetry (see the POC-03 blocker). The status is FAIL on the boundary check alone; the unobserved items are not counted as passes.',
    ],
  };
  writeResult('POC-07', record);
  return record;
}
