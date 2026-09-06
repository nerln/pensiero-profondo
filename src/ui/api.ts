// REST helpers for the hub's JSON API. In mock mode every call is served by the in-memory
// mock hub instead (see mock.ts) so the whole UI works without a running server.

import type { EffortLevel, Machine, Member, Ritual, Role, Studio, TranscriptItem, Voce } from '../core/types.js';
import { isMockMode, mockHub } from './mock.js';
import type { AttackRitualInput, CreateMemberInput, PatchStudioInput, PostVoceInput } from './mock.js';

export interface Snapshot {
  studio: Studio;
  roles: Role[];
  machines: Machine[];
  members: Member[];
  voci: Voce[];
  rituals: Ritual[];
}

/** The hub writes the token into index.html when the page is served on loopback; a remote browser passes ?token=. */
export function hubToken(): string {
  const meta = document.querySelector('meta[name="pensiero-token"]')?.getAttribute('content');
  const fromUrl = new URLSearchParams(window.location.search).get('token');
  const token = meta || fromUrl || '';
  if (fromUrl) { try { sessionStorage.setItem('pensiero-token', fromUrl); } catch { /* ignore */ } }
  if (token) return token;
  try { return sessionStorage.getItem('pensiero-token') ?? ''; } catch { return ''; }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-pensiero-token': hubToken(), ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export { type CreateMemberInput, type PostVoceInput, type AttackRitualInput, type PatchStudioInput };

export const api = {
  async getSnapshot(): Promise<Snapshot> {
    if (isMockMode()) return mockHub.getSnapshot();
    return request<Snapshot>('/api/snapshot');
  },

  async createMember(input: CreateMemberInput): Promise<Member> {
    if (isMockMode()) return mockHub.createMember(input);
    return request<Member>('/api/members', { method: 'POST', body: JSON.stringify(input) });
  },

  async sendToMember(id: string, text: string): Promise<void> {
    if (isMockMode()) return mockHub.sendToMember(id, text);
    await request(`/api/members/${id}/send`, { method: 'POST', body: JSON.stringify({ text }) });
  },

  async interruptMember(id: string): Promise<void> {
    if (isMockMode()) return mockHub.interruptMember(id);
    await request(`/api/members/${id}/interrupt`, { method: 'POST' });
  },

  async stopMember(id: string): Promise<void> {
    if (isMockMode()) return mockHub.stopMember(id);
    await request(`/api/members/${id}/stop`, { method: 'POST' });
  },

  async setMemberModel(id: string, model: string): Promise<void> {
    if (isMockMode()) return mockHub.setMemberModel(id, model);
    await request(`/api/members/${id}/model`, { method: 'POST', body: JSON.stringify({ model }) });
  },

  async removeMember(id: string): Promise<void> {
    if (isMockMode()) return mockHub.removeMember(id);
    await request(`/api/members/${id}`, { method: 'DELETE' });
  },

  async getTranscript(id: string): Promise<TranscriptItem[]> {
    if (isMockMode()) return mockHub.getTranscript(id);
    return request<TranscriptItem[]>(`/api/members/${id}/transcript`);
  },

  async postVoce(input: PostVoceInput): Promise<Voce> {
    if (isMockMode()) return mockHub.postVoce(input);
    return request<Voce>('/api/voci', { method: 'POST', body: JSON.stringify(input) });
  },

  async attackRitual(input: AttackRitualInput): Promise<Ritual> {
    if (isMockMode()) return mockHub.attackRitual(input);
    return request<Ritual>('/api/rituals/attack', { method: 'POST', body: JSON.stringify(input) });
  },

  async patchStudio(input: PatchStudioInput): Promise<Studio> {
    if (isMockMode()) return mockHub.patchStudio(input);
    return request<Studio>('/api/studio', { method: 'PATCH', body: JSON.stringify(input) });
  },

  async resolvePermission(memberId: string, reqId: string, input: { allow: boolean; remember: boolean }): Promise<void> {
    if (isMockMode()) return mockHub.resolvePermission(memberId, reqId, input.allow, input.remember);
    await request(`/api/members/${memberId}/permissions/${reqId}`, { method: 'POST', body: JSON.stringify(input) });
  },
};

export type { EffortLevel };
