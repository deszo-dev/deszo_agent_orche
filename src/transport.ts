import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Connection, JournalEvent } from './types';

export class ApiProblem extends Error {
  constructor(public status: number, public code: string, message: string, public details: { path: string; message: string }[] = []) { super(message); }
}

export async function getConnection(): Promise<Connection> {
  if (isTauri()) return invoke<Connection>('get_runner_connection');
  const response = await fetch('/__runner/connection', { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}

export class Client {
  private readonly token: string;
  readonly hasFirstParty: boolean;
  constructor(public connection: Connection) {
    this.hasFirstParty = Boolean(connection.firstPartyToken);
    this.token = connection.firstPartyToken || connection.token;
  }
  private url(path: string) {
    return `http://127.0.0.1:${this.connection.port}${path.startsWith('/api/v3/') ? path : `/api/v2${path}`}`;
  }
  private headers(extra: Record<string, string> = {}) { return { Authorization: `Bearer ${this.token}`, ...extra }; }

  async request<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    const response = await fetch(this.url(path), {
      method, headers: this.headers({ ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) throw new ApiProblem(response.status, data?.code || 'internal_error', data?.message || `HTTP ${response.status}`, data?.details || []);
    return data as T;
  }
  get<T>(path: string) { return this.request<T>('GET', path); }
  put<T>(path: string, body: unknown) { return this.request<T>('PUT', path, body); }
  post<T>(path: string, body: unknown) { return this.request<T>('POST', path, body); }
  getV3<T>(path: string) { return this.get<T>(`/api/v3${path}`); }
  postV3<T>(path: string, body: unknown) { return this.post<T>(`/api/v3${path}`, body); }
  async saveWorkflow<T>(workflowId: string, requestId: string, expectedEtag: string | null, workflow: unknown): Promise<T> {
    const conditional: Record<string, string> = expectedEtag === null ? { 'If-None-Match': '*' } : { 'If-Match': expectedEtag };
    return this.request<T>('PUT', `/api/v3/workflows/${encodeURIComponent(workflowId)}`, { requestId, expectedEtag, workflow }, conditional);
  }

  async streamWorkflowChanges(after: number, signal: AbortSignal, onEvent: (event: any) => void, onOpen: () => void, onResync: () => void) {
    const response = await fetch(this.url(`/api/v3/authoring/events/stream?after=${after}`), { headers: this.headers(), signal });
    if (!response.ok || !response.body) {
      const data = await response.json().catch(() => ({}));
      throw new ApiProblem(response.status, data.code || 'conflict', data.message || 'The workflow-change stream is unavailable.', data.details || []);
    }
    onOpen();
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const kind = frame.split('\n').find(line => line.startsWith('event: '))?.slice(7);
        const data = frame.split('\n').find(line => line.startsWith('data: '));
        if (!data) continue;
        if (kind === 'resync') { onResync(); return; }
        if (kind === 'workflow-change') onEvent(JSON.parse(data.slice(6)));
      }
    }
  }

  async artifactText(id: string): Promise<string> {
    const response = await fetch(this.url(`/artifacts/${id}`), { headers: this.headers() });
    if (!response.ok) { const data = await response.json().catch(() => ({})); throw new ApiProblem(response.status, data.code || 'internal_error', data.message || 'Artifact unavailable'); }
    return response.text();
  }
  async artifactJson<T = any>(id: string): Promise<T> { return JSON.parse(await this.artifactText(id)); }

  // Durable journal stream; reconnects from the last delivered sequence.
  async stream(runId: string, after: number, signal: AbortSignal, onEvent: (event: JournalEvent) => void) {
    const response = await fetch(this.url(`/runs/${runId}/events?afterSequence=${after}`), { headers: this.headers(), signal });
    if (!response.ok || !response.body) throw new ApiProblem(response.status, 'conflict', 'The event stream is unavailable.');
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = frame.split('\n').find(line => line.startsWith('data: '));
        if (data) onEvent(JSON.parse(data.slice(6)));
      }
    }
  }
}
