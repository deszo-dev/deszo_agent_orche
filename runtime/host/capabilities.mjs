// Enablement gates for the Local Control Host (ADR-0006 section 7 and acceptance matrix). Production autonomy is
// enforced in code: a production host refuses to start, and therefore cannot grant or enforce authority, unless every
// capability below is recorded as verified with a reference to independent evidence. A documentation statement that
// autonomy is disabled is not a gate; nothing in this file is marked verified by documentation or by fixtures.
//
// `fixture` assurance runs the same logic against injected, non-Windows components for tests. Fixture hosts are
// refused by the runtime unless a test harness sets DESZO_ALLOW_FIXTURE_HOST=1.

export const CAPABILITIES = Object.freeze([
  { id: 'protectedService', requirement: 'SCM-managed LocalService host with a dedicated service SID, protected binaries, state and pipe ACLs' },
  { id: 'peerIdentity', requirement: 'Named-pipe peer process, token and session verified against the protected installation for every connection' },
  { id: 'consentBroker', requirement: 'Protected consent surface with fresh user verification, protected display and trusted credential enrollment' },
  { id: 'launcherTask', requirement: 'Protected interactive Scheduled Task launcher that accepts only authenticated, bounded lifecycle commands' },
  { id: 'nativeJobFailStop', requirement: 'Service-owned kill-on-close Jobs with service-only outer handles and pending-launch cleanup' },
  { id: 'immutableBuildIdentity', requirement: 'Write-protected build outputs so the verified artifact is the launched artifact' },
  { id: 'routeCredentialMatrix', requirement: 'Published ADR-0001 route/credential matrix with no legacy route able to bypass host limits' },
  { id: 'persistentWorker', requirement: 'Restricted controller worker with a durable queue and processed-observation acknowledgements' },
  { id: 'compatibleRollback', requirement: 'Profile-specific compatible restore plan that preserves newer data' },
  { id: 'nativeUiEvidence', requirement: 'Native desktop evidence bound to the OS-observed process and runtime generation' },
]);

// Verified capabilities. Empty: no capability has independent evidence yet (see docs/adr/0006-implementation-status.md).
export const VERIFIED_CAPABILITIES = Object.freeze({});

export function missingProductionCapabilities(verified = VERIFIED_CAPABILITIES) {
  return CAPABILITIES.filter(capability => !verified[capability.id]).map(capability => capability.id);
}

export const ASSURANCE_LEVELS = Object.freeze(['fixture', 'production']);
