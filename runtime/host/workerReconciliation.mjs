import { HostError } from './authority.mjs';

// Native Stop establishes interruption, never the success/non-execution of an unknown command or workflow.
// This fixed procedure accepts only a policy identity; caller-supplied outcomes/evidence cannot resolve an effect.
export async function reconcileStoppedPolicy({ host, native, policyId }) {
  host.policyRow(policyId);
  const termination = await native('stopDomain',{ domain: policyId });
  if (termination.terminationConfirmed !== true) throw new HostError(409,'termination_unconfirmed','Owned-domain termination is not confirmed.');
  const processes = [], seen = new Set(), effects = host.all("SELECT operation_id,phase FROM operations WHERE policy_id=? AND outcome='reconciling'",policyId);
  const stored = host.all('SELECT evidence_json FROM operations WHERE policy_id=?',policyId).map(row=>JSON.parse(row.evidence_json).launch);
  let admissions=null;
  if(effects.some(op=>['launch_requested','command_prepared'].includes(op.phase))) {
    admissions=await native('domainHistory',{domain:policyId});
    if(admissions.recorded!==true)throw new HostError(409,'native_launch_receipt_missing','An interrupted launch requires independently persisted native admission history.');
    stored.push(...admissions.records.map(record=>record.process));
  }
  for (const process of stored) {
    if (!process?.pid || !process.creationTime || seen.has(`${process.pid}:${process.creationTime}`)) continue;
    seen.add(`${process.pid}:${process.creationTime}`);
    const observed = await native('isRunning',{ process });
    if (observed.running !== false) throw new HostError(409,'termination_unconfirmed','A previously observed owned process is still alive.');
    processes.push({ process, running: false });
  }
  const evidence = { nativeObservation: { termination, processes, admissions }, outcome: 'interrupted', qualification: 'Native interruption only. Unknown work output and run creation remain unknown; no execution success or refund is inferred.' };
  for (const operation of effects) host.reconcileOperation(operation.operation_id,{ outcome:'interrupted', reason:'Native owned work confirmed stopped; no automatic effect replay.', evidence });
  for (const row of host.all("SELECT * FROM active_work WHERE policy_id=? AND state='active'",policyId)) {
    if (row.host_instance !== host.hostInstance) host.reconcileOrphanedWork(row.work_ref,{ evidence });
    else host.releaseWork(row.permit_id,row.work_ref,{ evidence:{ terminalState:'native_interrupted', ...evidence } });
  }
  host.transaction(() => {
    // Retain the entire charge. The historical permit effect remains 'unknown', not rewritten to successful execution.
    const count = host.run("UPDATE budget_ledger SET state='consumed' WHERE policy_id=? AND state='unresolved'",policyId).changes;
    host.audit('policy.native_reconciled',{ evidence, resolvedOperations:effects.map(op=>op.operation_id), retainedUnknownCharges:count },{ policyId });
  });
  host.refreshBlock(); return evidence;
}
