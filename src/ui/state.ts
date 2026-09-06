// Single reducer for everything the UI knows. Keyed collections are kept as arrays (the
// studio is small: a handful of roles, machines and members, and a few hundred voci at most)
// so components can map over them directly; lookups by id go through the small helpers below.

import type { HubToUi } from '../core/protocol.js';
import type { Machine, Member, PermissionRequest, Ritual, Role, Studio, TranscriptItem, Voce } from '../core/types.js';

/** One in-progress streamed block (text or thinking) for a member, keyed by its blockIndex. */
export interface LiveBlock {
  kind: 'text' | 'thinking';
  text: string;
}

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
  /** memberId -> pending tool permission requests, from the snapshot and the live stream. */
  permissions: PermissionRequest[];
  /** memberId -> blockIndex -> the streamed-but-not-yet-finalized text/thinking block. */
  liveBuffers: Record<string, Record<number, LiveBlock>>;
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
  permissions: [],
  liveBuffers: {},
  lastError: null,
};

/** Events from the hub, plus a couple of purely local UI actions. */
export type UiAction =
  | HubToUi
  | { t: 'ui.connected'; connected: boolean }
  | { t: 'ui.transcriptLoaded'; memberId: string; items: TranscriptItem[] }
  | { t: 'ui.clearLiveBuffer'; memberId: string };

function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const idx = list.findIndex((x) => x.id === item.id);
  if (idx === -1) return [...list, item];
  const next = list.slice();
  next[idx] = item;
  return next;
}

/** Drops every live block for a member, e.g. once its turn is known to be over. */
function clearLiveBuffer(buffers: AppState['liveBuffers'], memberId: string): AppState['liveBuffers'] {
  if (!(memberId in buffers)) return buffers;
  const next = { ...buffers };
  delete next[memberId];
  return next;
}

/** Drops only the live blocks of one kind for a member — used when the matching final item lands. */
function clearLiveBufferKind(buffers: AppState['liveBuffers'], memberId: string, kind: LiveBlock['kind']): AppState['liveBuffers'] {
  const existing = buffers[memberId];
  if (!existing) return buffers;
  const entries = Object.entries(existing).filter(([, block]) => block.kind !== kind);
  if (entries.length === Object.keys(existing).length) return buffers;
  const next = { ...buffers };
  if (entries.length === 0) {
    delete next[memberId];
  } else {
    next[memberId] = Object.fromEntries(entries);
  }
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
        permissions: action.permissions,
      };
    case 'member.updated': {
      const members = upsertById(state.members, action.member);
      // Working turns end without a clean 'result' item too (interrupts, stop, errors); a
      // status that leaves 'working' is the safety net that clears any leftover live buffer.
      const liveBuffers = action.member.status === 'working' ? state.liveBuffers : clearLiveBuffer(state.liveBuffers, action.member.id);
      return { ...state, members, liveBuffers };
    }
    case 'member.removed':
      return { ...state, members: state.members.filter((m) => m.id !== action.memberId) };
    case 'transcript.item': {
      const existing = state.transcripts[action.memberId] ?? [];
      let liveBuffers = state.liveBuffers;
      if (action.item.kind === 'result') {
        liveBuffers = clearLiveBuffer(liveBuffers, action.memberId);
      } else if (action.item.kind === 'text' || action.item.kind === 'thinking') {
        liveBuffers = clearLiveBufferKind(liveBuffers, action.memberId, action.item.kind);
      }
      return {
        ...state,
        transcripts: { ...state.transcripts, [action.memberId]: [...existing, action.item] },
        liveBuffers,
      };
    }
    case 'transcript.delta': {
      const memberBuf = state.liveBuffers[action.memberId] ?? {};
      const prevBlock = memberBuf[action.blockIndex];
      const nextBlock: LiveBlock = { kind: action.kind, text: (prevBlock?.text ?? '') + action.delta };
      return {
        ...state,
        liveBuffers: {
          ...state.liveBuffers,
          [action.memberId]: { ...memberBuf, [action.blockIndex]: nextBlock },
        },
      };
    }
    case 'permission.requested':
      return { ...state, permissions: [...state.permissions.filter((p) => p.reqId !== action.request.reqId), action.request] };
    case 'permission.resolved':
      return { ...state, permissions: state.permissions.filter((p) => p.reqId !== action.reqId) };
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
    case 'ui.clearLiveBuffer':
      return { ...state, liveBuffers: clearLiveBuffer(state.liveBuffers, action.memberId) };
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

/** The pending permission request for a member, if any — a member has at most one at a time. */
export function pendingPermissionFor(state: AppState, memberId: string): PermissionRequest | undefined {
  return state.permissions.find((p) => p.memberId === memberId);
}
