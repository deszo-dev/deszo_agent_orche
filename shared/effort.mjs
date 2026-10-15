export const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const DEFAULT_EFFORT = 'medium';
export const EFFORT_POLICY_VERSION = 1;

// Older workflows omit this field. Still pass a deterministic value to every CLI.
export function resolveEffort(effort = DEFAULT_EFFORT) {
  if (!EFFORT_LEVELS.includes(effort)) throw new Error(`Unsupported reasoning effort: ${String(effort)}.`);
  return effort;
}
