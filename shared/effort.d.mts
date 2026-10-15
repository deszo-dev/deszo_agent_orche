export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORT_LEVELS: readonly Effort[];
export const DEFAULT_EFFORT: 'medium';
export const EFFORT_POLICY_VERSION: number;
export function resolveEffort(effort?: Effort): Effort;
