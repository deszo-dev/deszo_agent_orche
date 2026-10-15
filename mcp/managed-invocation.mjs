export function managedInvocationDecision(marker, runtimeInstanceId) {
  if (typeof marker !== 'string' || marker.length === 0) return null;
  const matchesRuntime = marker === runtimeInstanceId;
  return {
    matchesRuntime,
    code: 'managed_invocation_denied',
    message: matchesRuntime
      ? 'The authoring bridge is unavailable inside a Deszo-managed provider invocation from this runtime.'
      : 'The authoring bridge is unavailable inside a Deszo-managed provider invocation; its runtime marker does not match the selected runtime.',
    details: [{ path: '/runtimeInstanceId', message: matchesRuntime ? 'The marker matches the selected runtime.' : 'The marker belongs to another or previous runtime instance.' }],
  };
}
