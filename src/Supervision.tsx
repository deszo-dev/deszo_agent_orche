import {useCallback, useEffect, useState} from 'react';
import type {Client} from './transport';

export interface ControlGrant {
  grantId: string; state: string; runId: string | null; workflowId: string; workspaceId: string;
  workflowSnapshotSha256: string; clientLabel: string | null; clientProvider: string; clientVersion: string | null;
  requestedActions: string[]; observationDeadlineMs: number; escalationDeadlineMs: number;
}

interface RunControl {
  runId: string; controlMode: 'supervised' | 'unsupervised'; dispatchPaused: boolean; terminationOutcome: string | null; supervisor: boolean;
  controller: null | {grantId: string; state: string; ackCursor: number; lastAckAt: string | null; millisecondsSinceAcknowledgement: number | null; observationDeadlineMs: number; escalationDeadlineMs: number};
}

export function RunControlPanel({client, runId, report}: {client: Client; runId: string; report: (error: unknown, prefix?: string) => void}) {
  const [control, setControl] = useState<RunControl | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {setControl(await client.get<RunControl>(`/runs/${runId}/control`));}
    catch (error) {report(error, 'Run control: ');}
  }, [client, runId, report]);
  useEffect(() => {void refresh(); const timer = setInterval(() => void refresh(), 2500); return () => clearInterval(timer);}, [refresh]);
  const act = async (kind: 'extend' | 'revoke') => {
    if (!control?.controller) return;
    setBusy(true);
    try {
      if (kind === 'extend') await client.post(`/runs/${runId}/control-extension`, {requestId: crypto.randomUUID(), extensionMs: 60000, reason: 'Operator extended the native Stop deadline in Deszo.'});
      else await client.post(`/control-grants/${control.controller.grantId}/revoke`, {requestId: crypto.randomUUID(), reason: 'Operator revoked control and stopped the run in Deszo.'});
      await refresh();
    } catch (error) {report(error, 'Run control: ');}
    finally {setBusy(false);}
  };
  if (!control) return <p className="muted">Loading run control…</p>;
  return <>
    <dl className="approval-facts">
      <div><dt>Run</dt><dd><code>{runId}</code></dd></div>
      <div><dt>Control mode</dt><dd>{control.controlMode}</dd></div>
      <div><dt>Dispatch</dt><dd>{control.dispatchPaused ? 'Paused: observation is overdue' : 'Available within the workflow policy'}</dd></div>
      <div><dt>Last Stop result</dt><dd>{control.terminationOutcome || 'No Stop proof recorded'}</dd></div>
      {control.controller && <>
        <div><dt>Observed journal cursor</dt><dd>{control.controller.ackCursor}</dd></div>
        <div><dt>Last acknowledgement</dt><dd>{control.controller.lastAckAt ? new Date(control.controller.lastAckAt).toLocaleString() : 'Awaiting the controller'}</dd></div>
        <div><dt>Observation deadline</dt><dd>{control.controller.observationDeadlineMs / 1000}s</dd></div>
        <div><dt>Configured native Stop deadline</dt><dd>{control.controller.escalationDeadlineMs / 1000}s</dd></div>
      </>}
    </dl>
    {control.controlMode === 'supervised' && <p className="muted small">Deszo pauses new work when the controller stops acknowledging observations. The native supervisor enforces the Stop deadline.</p>}
    {client.hasFirstParty && control.controller && <div className="modal-actions">
      <button className="button secondary" disabled={busy} onClick={() => act('extend')}>Extend native Stop deadline by 60s</button>
      <button className="button danger" disabled={busy} onClick={() => act('revoke')}>Revoke control and stop</button>
    </div>}
  </>;
}
