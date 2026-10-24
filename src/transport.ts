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
  private token: string;
  readonly hasFirstParty: boolean;
  constructor(public connection: Connection) {
    this.hasFirstParty = Boolean(connection.firstPartyToken);
    this.token = connection.firstPartyToken || connection.token;
  }
  private url(path: string) {
    return `http://127.0.0.1:${this.connection.port}${path.startsWith('/api/v3/') || path.startsWith('/api/v4/') ? path : `/api/v2${path}`}`;
  }
  private headers(extra: Record<string, string> = {}) { return { Authorization: `Bearer ${this.token}`, ...extra }; }

  async request<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    const send = () => fetch(this.url(path), {
      method, headers: this.headers({ ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let response = await send();
    if (response.status === 401) {
      const refreshed = await getConnection().catch(() => null);
      const refreshedToken = refreshed?.firstPartyToken || refreshed?.token;
      if (refreshed && refreshed.port === this.connection.port && refreshed.runtimeInstanceId === this.connection.runtimeInstanceId &&
          refreshed.storeId === this.connection.storeId && refreshedToken && refreshedToken !== this.token) {
        this.connection = refreshed;
        this.token = refreshedToken;
        response = await send();
      }
    }
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) throw new ApiProblem(response.status, data?.code || 'internal_error', data?.message || `HTTP ${response.status}`, data?.details || []);
    return data as T;
  }
  async rotateOwnerToken(): Promise<{ rotated: boolean }> {
    const result = await this.request<{ rotated: boolean; token: string }>('POST', '/owner-token/rotate', {});
    this.token = result.token;
    this.connection.token = result.token;
    this.connection.firstPartyToken = result.token;
    return { rotated: result.rotated };
  }
  get<T>(path: string) { return this.request<T>('GET', path); }
  put<T>(path: string, body: unknown) { return this.request<T>('PUT', path, body); }
  post<T>(path: string, body: unknown) { return this.request<T>('POST', path, body); }
  getV3<T>(path: string) { return this.get<T>(`/api/v3${path}`); }
  postV3<T>(path: string, body: unknown) { return this.post<T>(`/api/v3${path}`, body); }
  getV4<T>(path: string) { return this.get<T>(`/api/v4${path}`); }
  postV4<T>(path: string, body: unknown, headers: Record<string, string> = {}) { return this.request<T>('POST', `/api/v4${path}`, body, headers); }
  async saveWorkflow<T>(workflowId: string, requestId: string, expectedEtag: string | null, workflow: unknown): Promise<T> {
    const conditional: Record<string, string> = expectedEtag === null ? { 'If-None-Match': '*' } : { 'If-Match': expectedEtag };
    return this.request<T>('PUT', `/api/v4/workflows/${encodeURIComponent(workflowId)}/draft`, { requestId, workflow }, conditional);
  }
  async deriveDraft<T>(workflowId: string, version: number, requestId: string, expectedEtag: string | null): Promise<T> {
    const conditional: Record<string, string> = expectedEtag === null ? { 'If-None-Match': '*' } : { 'If-Match': expectedEtag };
    return this.postV4<T>(`/workflows/${encodeURIComponent(workflowId)}/draft/from/${version}`, { requestId }, conditional);
  }
  validateDraft<T>(workflowId: string, etag: string): Promise<T> {
    return this.postV4<T>(`/workflows/${encodeURIComponent(workflowId)}/draft/validate`, {}, { 'If-Match': etag });
  }
  publishDraft<T>(workflowId: string, requestId: string, etag: string): Promise<T> {
    return this.postV4<T>(`/workflows/${encodeURIComponent(workflowId)}/publish`, { requestId }, { 'If-Match': etag });
  }
  async listPublishedVersions<T>(workflowId: string): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ limit: '200' });
      if (cursor) query.set('cursor', cursor);
      const page = await this.getV4<{ items: T[]; nextCursor: string | null }>(
        `/workflows/${encodeURIComponent(workflowId)}/versions?${query}`,
      );
      items.push(...page.items);
      if (page.nextCursor && page.nextCursor === cursor) throw new Error('Published Version pagination did not advance.');
      cursor = page.nextCursor;
    } while (cursor);
    return items;
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
