// Model selection is always explicit. The editor leaves new bindings incomplete until the user fills them.
export const TASK_ROLES = ['analyst', 'codeReviewer', 'testReviewer', 'testAuthor', 'developer', 'juniorAnalyst'];
export function emptyTaskConfig() {
  return {
    roles: Object.fromEntries(TASK_ROLES.map(role => [role, { role, provider: role === 'analyst' || role === 'juniorAnalyst' ? 'codex' : 'claude', model: '', effort: 'medium', timeoutSeconds: 600 }])),
    scope: { production: ['src/**'], tests: ['tests/**'], documentation: ['docs/**'], excludedOutputs: ['node_modules/**', 'dist/**'] },
    projectPolicy: { criticalAreas: [], publicContracts: [], requireIndependentAcceptance: false },
    bounds: { maxAttempts: 60, maxElapsedSeconds: 3600, maxContextTurns: 3, maxRepairIterations: 3, maxDiscoveryTurns: 2 },
    checks: [],
    delivery: { boundary: 'candidate' },
  };
}
