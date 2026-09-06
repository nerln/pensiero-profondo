// Shared vocabulary of pensiero. Everything the hub, the worker and the UI agree on lives here.
// Times are ISO-8601 strings written by the hub's clock at the moment of the write, never by an agent.

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk';

/** Verbs a blackboard entry can carry. See docs/DESIGN.md, "Verbs on the blackboard". */
export const VERBS = [
  'preso', 'fatto', 'messaggio', 'avviso', 'numero', 'attacco', 'ritratto', 'proposta', 'consenso',
] as const;
export type Verb = (typeof VERBS)[number];

export interface Studio {
  id: string;
  name: string;
  /** What would satisfy the owner. Every captain's round starts from this. */
  goal: string;
  /** Directories the crew may work in. */
  roots: string[];
  /** Hard stop in USD across every member; the hub interrupts everything when reached. */
  budgetUsd: number | null;
  createdAt: string;
}

export interface Role {
  id: string;
  /** Short machine name: captain, deckhand, lookout, cartographer, boatswain, scribe, watch. */
  name: string;
  /** Display name, e.g. "Lookout". */
  label: string;
  /** The system prompt. The disciplines are part of it, not a separate field. */
  mandate: string;
  model: string;
  effort: EffortLevel;
  /** Tools pre-approved for the session. Undefined means the Claude Code default set, with prompts
   *  decided by permissionMode (allowed while there is no approval flow, denied under dontAsk). */
  tools?: string[];
  permissionMode: PermissionMode;
  /** Whether this role may post `proposta` entries (outward actions). */
  canPropose: boolean;
}

export type MemberStatus = 'starting' | 'idle' | 'working' | 'waiting' | 'stopped' | 'error';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  turns: number;
}

export const EMPTY_USAGE: Usage = {
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, turns: 0,
};

export interface Member {
  id: string;
  studioId: string;
  roleId: string;
  machineId: string;
  /** Human name for the board, e.g. "Lookout 2". */
  name: string;
  cwd: string;
  model: string;
  effort: EffortLevel;
  status: MemberStatus;
  /** Claude Code session id once the session has started; used for resume. */
  sessionId: string | null;
  usage: Usage;
  createdAt: string;
  lastActivityAt: string;
  /** Last error text if status is 'error'. */
  error: string | null;
}

export type MachineKind = 'local' | 'remote';

export interface Machine {
  id: string;
  name: string;
  kind: MachineKind;
  status: 'online' | 'offline';
  lastSeenAt: string;
  claudeVersion: string | null;
}

/** Who wrote a blackboard entry. The owner is the human at the UI; everything else is a session. */
export type Author =
  | { kind: 'owner' }
  | { kind: 'member'; memberId: string; memberName: string; role: string; machine: string }
  | { kind: 'hub' };

export interface Voce {
  id: string;
  studioId: string;
  verb: Verb;
  text: string;
  author: Author;
  /** Addressee: a member id, a role name, or 'all'. */
  to: string;
  /** Id of the entry this one answers, e.g. an `attacco` pointing at a `numero`. */
  replyTo: string | null;
  /** Free structured payload, e.g. for `numero`: { value, unit, source } or for `attacco`: { verdict }. */
  meta: Record<string, unknown>;
  createdAt: string;
}

/** Stages in the life of a claim. Advanced by rituals, never by the claimant. */
export type ClaimStage = 'declared' | 'attacked' | 'rederived' | 'measured' | 'retracted';

export type Verdict = 'refuted' | 'holds' | 'undecidable';

/** One line of a member's transcript, normalized from the SDK's message stream. */
export type TranscriptItem =
  | { kind: 'user'; text: string; ts: string; framed?: boolean }
  | { kind: 'text'; text: string; ts: string }
  | { kind: 'thinking'; text: string; ts: string }
  | { kind: 'tool_use'; name: string; input: unknown; toolUseId: string; ts: string }
  | { kind: 'tool_result'; toolUseId: string; text: string; isError: boolean; ts: string }
  | { kind: 'result'; subtype: string; usage: Usage; ts: string }
  | { kind: 'system'; text: string; ts: string };

/** A tool call waiting for the owner's decision, as Claude Code would ask in the terminal. */
export interface PermissionRequest {
  reqId: string;
  memberId: string;
  toolName: string;
  input: unknown;
  /** One line the UI can show, e.g. the Bash command or the file path. */
  summary: string;
  createdAt: string;
}

export type RitualKind = 'attack' | 'rederive' | 'arbitrate' | 'council' | 'consent' | 'round';

export interface Ritual {
  id: string;
  studioId: string;
  kind: RitualKind;
  /** The entry the ritual is about, e.g. the `numero` being attacked. */
  targetVoceId: string | null;
  memberIds: string[];
  status: 'running' | 'done' | 'aborted';
  outcome: Record<string, unknown>;
  createdAt: string;
  finishedAt: string | null;
}
