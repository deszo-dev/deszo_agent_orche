// ADR-0007 PoC runner. Runs the selected experiments against the installed Codex App Server in isolated homes, writes one
// sanitized JSON result per experiment and a summary. No experiment starts a Deszo runtime, touches the default Codex profile
// or copies credentials.
//   node run-poc.mjs                 # all experiments in order
//   node run-poc.mjs POC-02 POC-05   # selected experiments
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDirs, RESULTS_DIR, RUN_ROOT } from './lib/poc-common.mjs';
import { poc01, poc02 } from './lib/experiments-session.mjs';
import { poc05 } from './lib/experiments-writer.mjs';
import { poc03, poc04 } from './lib/experiments-turns.mjs';
import { poc06 } from './lib/experiments-takeover.mjs';
import { poc08 } from './lib/experiments-failures.mjs';
import { poc07 } from './lib/experiments-budget.mjs';

// POC-07 records the App Server's behaviour from POC-04 arm 1: turn A was admitted and started with no host reservation.
const turnAdmittedWithoutReservation = true;
const experiments = {
  'POC-01': poc01, 'POC-02': poc02, 'POC-05': poc05, 'POC-04': poc04, 'POC-03': poc03, 'POC-06': poc06, 'POC-07': () => poc07({ codexTurnAdmittedWithoutReservation: turnAdmittedWithoutReservation }), 'POC-08': poc08,
};
const selected = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(experiments);

ensureDirs();
const summary = [];
for (const id of selected) {
  const run = experiments[id];
  if (!run) { console.error(`unknown experiment ${id}`); process.exitCode = 2; continue; }
  const started = Date.now();
  try {
    const record = await run();
    const failed = record.checks?.filter(item => item.pass === false).map(item => item.name) ?? [];
    summary.push({ id, status: record.status, failedChecks: failed, elapsedMs: Date.now() - started, exitCode: 0 });
    console.log(`${id} ${record.status} (${failed.length} failed checks, ${Math.round((Date.now() - started) / 1000)} s)`);
  } catch (error) {
    summary.push({ id, status: 'INCONCLUSIVE', failedChecks: [], error: error.message, elapsedMs: Date.now() - started, exitCode: 1 });
    console.log(`${id} INCONCLUSIVE runner error: ${error.message}`);
    process.exitCode = 1;
  }
}
const path = join(RESULTS_DIR, `summary-${selected.join('-')}.json`);
writeFileSync(path, `${JSON.stringify({ runRoot: '<POC_ROOT>', generatedBy: 'run-poc.mjs', experiments: summary }, null, 2)}\n`);
console.log(`summary written to ${path}; homes under ${RUN_ROOT}`);
// Child-process streams from killed App Server instances can keep the event loop alive; exit explicitly after the summary.
process.exit(process.exitCode ?? 0);
