import { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { Client } from './transport';
import type { SavedWorkflow, Workspace } from './types';

type Policy = { policyId: string; state: string; valid: boolean; remainingMs: number; expiresAt: string; used: Record<string, number> };
type HostStatus = {
  available: boolean; autonomyEnabled: boolean; enrolled: boolean; reason?: string; missingCapabilities?: string[];
  options?: { buildRoot: string; desktop: { user: string; sessionId: number }; profiles: { profileId: string; path: string }[] };
  controller?: { controllerId: string; publicKey: string }; activePolicies?: Policy[];
  worker?: { lastObserved: { at: string } | null; error: string | null };
};
const initialLimits = { attempts: 5, providerInvocations: 40, workerModelCalls: 0, operations: 200, restarts: 8, repairs: 4, builds: 8 };

export function AutonomyModal({ client, workspace, saved, onClose, report }: {
  client: Client; workspace?: Workspace; saved: SavedWorkflow | null; onClose: () => void; report: (error: unknown) => void;
}) {
  const [status, setStatus] = useState<HostStatus | null>(null), [selected, setSelected] = useState('');
  const [requested, setRequested] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [limits, setLimits] = useState(initialLimits), [commands, setCommands] = useState('[]');
  const [applicationMode,setApplicationMode]=useState<'separate_preview'|'controlling_switch'>('separate_preview');
  const refresh = useCallback(async () => {
    const next = await client.get<HostStatus>('/autonomy'); setStatus(next);
    setSelected(current => current || next.options?.profiles[0]?.profileId || '');
  }, [client]);
  useEffect(() => { void refresh().catch(report); const timer = setInterval(() => void refresh().catch(report), 5000); return () => clearInterval(timer); }, [refresh, report]);
  const perform = async (action: () => Promise<void>) => { setBusy(true); try { await action(); await refresh(); } catch (error) { report(error); } finally { setBusy(false); } };
  const propose = () => perform(async () => {
    if (!status?.options || !status.controller || !workspace || !saved || !selected) return;
    const allowedCommands = JSON.parse(commands);
    const result = await client.post<{ decision: { expiresAt: string } }>('/autonomy/proposals', {
      controller: { controllerId: status.controller.controllerId, publicKey: status.controller.publicKey }, durationMs: 12 * 60 * 60 * 1000, limits,
      scope: { dataProfile: selected, desktop: status.options.desktop, applicationMode, buildRoot: status.options.buildRoot, deliveryBoundary: 'verified_branch',
        workspaces: [{ workspaceId: workspace.workspaceId, cwdIdentity: workspace.cwdIdentity }],
        workflows: [{ workflowId: saved.workflow.workflowId, baselineSha256: saved.snapshotSha256, permittedRevisions: [] }],
        operations: ['run.approve','supervision.approve','provider.invoke','run.stop_and_report','check.run','build.run','app.restart','app.rollback','runtime.reregister','delivery.local','repair.run'], commands: allowedCommands },
    });
    setNotice(`Request prepared. Original expiry: ${new Date(result.decision.expiresAt).toLocaleString()}. Review the exact decision in the trusted Windows Hello window.`);
    await client.post('/autonomy/open-consent', {});
  });
  return <div className="modal-backdrop"><section className="modal autonomy-modal" role="dialog" aria-modal="true" aria-labelledby="autonomy-title">
    <header><h2 id="autonomy-title">Development autonomy</h2><button className="icon-button" aria-label="Close autonomy" onClick={onClose}><X size={18} /></button></header>
    {!status ? <p>Checking the control host…</p> : <>
      <p>{status.autonomyEnabled ? 'Trusted control host is ready.' : status.available ? 'Setup verification is incomplete. Automatic execution is blocked.' : `Control host unavailable. ${status.reason || ''}`}</p>
      {status.activePolicies?.map(policy => <div className="autonomy-policy" key={policy.policyId}>
        <strong>{policy.valid ? 'Active' : policy.state}</strong><span>Expires {new Date(policy.expiresAt).toLocaleString()} · {Math.max(0,Math.ceil(policy.remainingMs/60000))} minutes remaining</span>
        <small>{policy.policyId}</small><span>Attempts: {policy.used.attempts} · Provider calls: {policy.used.providerInvocations} · Restarts: {policy.used.restarts}</span>
        <button disabled={busy} onClick={() => void perform(async () => { await client.post('/autonomy/revoke', { policyId: policy.policyId }); setNotice('Revocation committed. Owned-work termination is being verified.'); })}>Revoke and stop</button>
      </div>)}
      <label className="autonomy-toggle"><input type="checkbox" checked={requested} onChange={event => setRequested(event.target.checked)} />Request automatic approval of eligible operations for 12 hours</label>
      <p className="muted">The original expiry and spent limits survive application and service restarts. Workflow reviews and acceptance remain required. Windows Hello confirms the exact scope.</p>
      {requested && <div className="autonomy-form">
        <label>Application mode<select value={applicationMode} onChange={event=>setApplicationMode(event.target.value as 'separate_preview'|'controlling_switch')}><option value="separate_preview">Separate preview</option><option value="controlling_switch">Replace the controlling application</option></select></label>
        <label>Data profile<select value={selected} onChange={event => setSelected(event.target.value)}><option value="">Select a registered profile</option>{status.options?.profiles.map(profile => <option key={profile.profileId} value={profile.profileId}>{profile.profileId}</option>)}</select></label>
        <p>Workspace: {workspace?.workspaceId || 'Select a workspace'} · Workflow: {saved?.workflow.workflowId || 'Save a workflow'}</p>
        <div className="autonomy-limits">{Object.entries(limits).filter(([key]) => key !== 'workerModelCalls').map(([key,value]) => <label key={key}>{key}<input type="number" min="0" max="100000" value={value} onChange={event => setLimits(current => ({ ...current, [key]: Math.max(0,Math.floor(Number(event.target.value))) }))} /></label>)}</div>
        <details><summary>Exact commands permitted for checks and builds</summary><textarea aria-label="Permitted commands JSON" rows={5} value={commands} onChange={event => setCommands(event.target.value)} /><p className="muted">An empty list authorizes no commands. Command, arguments, working directory and timeout are included in the Windows Hello decision.</p></details>
        <button className="primary" disabled={busy || !status.autonomyEnabled || !status.enrolled || !selected || !workspace || !saved} onClick={() => void propose()}>Prepare request and verify with Windows Hello</button>
      </div>}
      <button disabled={busy || !status.available} onClick={() => void perform(async () => { await client.post('/autonomy/open-consent', {}); })}>Open trusted consent and revocation</button>
      {notice && <p role="status">{notice}</p>}
      <details><summary>Control host status</summary><pre>{JSON.stringify({ enabled: status.autonomyEnabled, enrolled: status.enrolled, pendingChecks: status.missingCapabilities, worker: status.worker }, null, 2)}</pre></details>
    </>}
  </section></div>;
}
