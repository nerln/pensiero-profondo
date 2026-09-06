// Single reducer for everything the UI knows. Keyed collections are kept as arrays (the
// studio is small: a handful of roles, machines and members, and a few hundred voci at most)
// so components can map over them directly; lookups by id go through the small helpers below.

import type { HubToUi } from '../core/protocol.js';
import type { Machine, Member, Ritual, Role, Studio, TranscriptItem, Voce } from '../core/types.js';

export interface AppState {
  connected: boolean;
  studio: Studio | null;
  roles: Role[];
  machines: Machine[];
  members: Member[];
  voci: Voce[];
  rituals: Ritual[];
  /** memberId -> transcript items, loaded once via REST then appended to from the WS stream. */
  transcripts: Record<string, TranscriptItem[]>;
  lastError: string | null;
}

export const initialState: AppState = {
  connected: false,
  studio: null,
  roles: [],
  machines: [],
  members: [],
  voci: [],
  rituals: [],
  transcripts: {},
  lastError: null,
};

/** Events from the hub, plus a couple of purely local UI actions. */
export type UiAction =
  | HubToUi
  | { t: 'ui.connected'; connected: boolean }
  | { t: 'ui.transcriptLoaded'; memberId: string; items: TranscriptItem[] };

function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const idx = list.findIndex((x) => x.id === item.id);
  if (idx === -1) return [...list, item];
  const next = list.slice();
  next[idx] = item;
  return next;
}

export function reduce(state: AppState, action: UiAction): AppState {
  switch (action.t) {
    case 'snapshot':
      return {
        ...state,
        studio: action.studio,
        roles: action.roles,
        machines: action.machines,
        members: action.members,
        voci: action.voci,
        rituals: action.rituals,
      };
    case 'member.updated':
      return { ...state, members: upsertById(state.members, action.member) };
    case 'member.removed':
      return { ...state, members: state.members.filter((m) => m.id !== action.memberId) };
    case 'transcript.item': {
      const existing = state.transcripts[action.memberId] ?? [];
      return {
        ...state,
        transcripts: { ...state.transcripts, [action.memberId]: [...existing, action.item] },
      };
    }
    case 'voce.added':
      return { ...state, voci: [...state.voci, action.voce] };
    case 'machine.updated':
      return { ...state, machines: upsertById(state.machines, action.machine) };
    case 'ritual.updated':
      return { ...state, rituals: upsertById(state.rituals, action.ritual) };
    case 'studio.updated':
      return { ...state, studio: action.studio };
    case 'error':
      return { ...state, lastError: action.message };
    case 'ui.connected':
      return { ...state, connected: action.connected };
    case 'ui.transcriptLoaded':
      return { ...state, transcripts: { ...state.transcripts, [action.memberId]: action.items } };
    default:
      return state;
  }
}

export function memberById(state: AppState, id: string): Member | undefined {
  return state.members.find((m) => m.id === id);
}

export function roleById(state: AppState, id: string): Role | undefined {
  return state.roles.find((r) => r.id === id);
}

export function machineById(state: AppState, id: string): Machine | undefined {
  return state.machines.find((m) => m.id === id);
}
