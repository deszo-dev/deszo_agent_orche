import type { ArtifactRef, JournalEvent } from '../src/types';

export interface ReplayInstance {
  id: string; nodeId?: string; nodeType?: string; state: string; reason?: string; attemptId: string | null; ordinal: number;
  inputs: ArtifactRef | null; prompt?: ArtifactRef | null; outputs: ArtifactRef | null; invocation: ArtifactRef | null;
  error: { code: string; message: string } | null; logs: { stream: string; chunk: ArtifactRef; index: number }[];
  reusedFrom?: string; routeCase?: string | null; carried?: { slot: string; priorSubjectId: string; recordId: string }[]; gate?: { mode: string; status: string | null; subjectId: string; recordId: string | null };
}
export interface ReplayIteration { iteration: number; value: any; feedback: any; candidate: any; decision: any; continue: boolean | null; reason: string | null; restart: boolean; outcome: string | null }
export interface ReplayLoop { state: string; iteration: number; pauseReason: string | null; message?: string | null; maxIterations: number; maxActiveMinutes: number; iterations: ReplayIteration[]; result?: any }
export interface ReplayMap {
  mapExecutionId: string; mapInstanceId: string; generation: number; specificationId: string; state: string; pauseReason: string | null;
  failedVerificationCycles: number; maxFailedVerificationCycles: number | null; carried: string[];
  tasks: Map<string, { state: string; reason: string }>; records: { taskId: string; kind: string; recordId: string }[];
}
export interface ReplayView { run: string | null; instances: Map<string, ReplayInstance>; loops: Map<string, ReplayLoop>; bindings: Map<string, string>; maps: Map<string, ReplayMap>; current: JournalEvent | null }

export function replaySteps(events: JournalEvent[], options?: { includeLogs?: boolean }): number[];
export function project(events: JournalEvent[], upToIndex: number): ReplayView;
export function describeEvent(event: JournalEvent): string;
