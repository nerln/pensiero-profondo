// Messages on the two WebSocket channels: hub <-> worker, and hub <-> UI.
// Every message is one JSON object with a `t` discriminator. Nothing else goes on the wire.

import type { Machine, Member, Role, TranscriptItem, Voce, Usage, EffortLevel, PermissionMode, Ritual, Studio, PermissionRequest } from './types.js';

// ---------- worker -> hub ----------

export type WorkerToHub =
  | { t: 'hello'; token: string; machineName: string; claudeVersion: string | null }
  | { t: 'session.status'; memberId: string; status: Member['status']; sessionId?: string | null; error?: string | null }
  | { t: 'session.item'; memberId: string; item: TranscriptItem }
  | { t: 'session.usage'; memberId: string; usage: Usage }
  /** A streamed piece of the assistant's current message; not persisted, the final item follows. */
  | { t: 'session.delta'; memberId: string; blockIndex: number; kind: 'text' | 'thinking'; delta: string }
  /** A tool call that needs the owner's decision. The hub answers with `permission.result`. */
  | { t: 'permission.request'; memberId: string; reqId: string; toolName: string; input: unknown; summary: string }
  /** Proxy of the `lavagna_scrivi` MCP tool called inside a session. The hub stamps the time. */
  | { t: 'lavagna.scrivi'; memberId: string; verb: Voce['verb']; text: string; to: string; replyTo: string | null; meta: Record<string, unknown>; reqId: string }
  /** Proxy of the `lavagna_leggi` MCP tool. The hub answers with `lavagna.leggi.result`. */
  | { t: 'lavagna.leggi'; memberId: string; reqId: string; since?: string }
  | { t: 'pong' };

// ---------- hub -> worker ----------

export interface SessionStartSpec {
  memberId: string;
  memberName: string;
  role: Role;
  cwd: string;
  model: string;
  effort: EffortLevel;
  permissionMode: PermissionMode;
  /** Studio goal and the member's brief, already rendered into the first user message. */
  firstPrompt: string;
  /** Resume an existing Claude Code session instead of starting a new one. */
  resume: string | null;
}

export type HubToWorker =
  | { t: 'hello.ok'; machineId: string }
  | { t: 'hello.rejected'; reason: string }
  | { t: 'session.start'; spec: SessionStartSpec }
  /** A user turn. `framed` is true when the text is a blackboard delivery wrapped in the frame. */
  | { t: 'session.send'; memberId: string; text: string; framed: boolean }
  | { t: 'session.interrupt'; memberId: string }
  | { t: 'session.stop'; memberId: string }
  | { t: 'session.setModel'; memberId: string; model: string }
  | { t: 'lavagna.scrivi.result'; reqId: string; ok: boolean; voceId?: string; error?: string }
  | { t: 'lavagna.leggi.result'; reqId: string; text: string }
  /** `remember` means: do not ask again for this tool in this session. */
  | { t: 'permission.result'; reqId: string; allow: boolean; remember: boolean; message?: string }
  | { t: 'ping' };

// ---------- hub -> UI (event stream) ----------

export type HubToUi =
  | { t: 'snapshot'; studio: Studio; roles: Role[]; machines: Machine[]; members: Member[]; voci: Voce[]; rituals: Ritual[]; permissions: PermissionRequest[] }
  | { t: 'member.updated'; member: Member }
  | { t: 'member.removed'; memberId: string }
  | { t: 'transcript.item'; memberId: string; item: TranscriptItem }
  | { t: 'transcript.delta'; memberId: string; blockIndex: number; kind: 'text' | 'thinking'; delta: string }
  | { t: 'permission.requested'; request: PermissionRequest }
  | { t: 'permission.resolved'; memberId: string; reqId: string; allow: boolean; by: 'owner' | 'timeout' | 'policy' }
  | { t: 'voce.added'; voce: Voce }
  | { t: 'machine.updated'; machine: Machine }
  | { t: 'ritual.updated'; ritual: Ritual }
  | { t: 'studio.updated'; studio: Studio }
  | { t: 'transcript.result'; memberId: string; items: TranscriptItem[]; reqId: string }
  | { t: 'error'; message: string };

// ---------- UI -> hub ----------

export type UiToHub =
  | { t: 'auth'; token: string }
  | { t: 'transcript.get'; memberId: string; reqId: string };
