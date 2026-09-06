// Mock hub used when the page is opened with ?mock=1. It plays back a realistic fixture
// (roles, machines, members, a blackboard history, one finished ritual) and then keeps the
// studio "alive": a transcript item and a new voce roughly every three seconds, so every view
// can be exercised without a running hub. ws.ts and api.ts both delegate to the single
// instance below so REST calls and the WS stream stay consistent with each other.

import type { HubToUi } from '../core/protocol.js';
import type {
  Author,
  Machine,
  Member,
  PermissionRequest,
  Ritual,
  Role,
  Studio,
  TranscriptItem,
  Usage,
  Voce,
} from '../core/types.js';
import type { UiAction } from './state.js';
import { deriveToolSummary, nextId } from './utils.js';

export function isMockMode(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('mock') === '1';
}

export interface CreateMemberInput {
  roleId: string;
  machineId: string;
  name?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  brief: string;
}

export interface PostVoceInput {
  verb: Voce['verb'];
  text: string;
  to: string;
  replyTo?: string | null;
  meta?: Record<string, unknown>;
}

export interface AttackRitualInput {
  voceId: string;
  n?: number;
  machineId?: string;
}

export interface PatchStudioInput {
  goal?: string;
  budgetUsd?: number;
}

export interface WsHandle {
  send(): void;
  close(): void;
}

const NOW = Date.now();
function minutesAgo(m: number): string {
  return new Date(NOW - m * 60_000).toISOString();
}

const STUDIO_ID = 'studio-1';

/** toolUseId shared between Lookout 2's pending `tool_use` and the `tool_result` that lands
 *  once the owner answers the permission request — keeps the two rows grouped in the UI. */
const LOOKOUT2_PUSH_TOOL_USE_ID = 'tu-lookout2-push';
const LOOKOUT2_PUSH_COMMAND = 'git push origin decoder-patch --force-with-lease';

function buildLookout2Permission(memberId: string): PermissionRequest {
  const input = { command: LOOKOUT2_PUSH_COMMAND };
  return {
    reqId: 'perm-lookout2-1',
    memberId,
    toolName: 'Bash',
    input,
    summary: deriveToolSummary('Bash', input),
    createdAt: minutesAgo(1),
  };
}

/** Streamed as growing `transcript.delta` chunks, then finalized verbatim: exercises markdown
 *  (heading, list, code block, table, link) rendering both live and finalized. */
const STREAMING_MARKDOWN_DEMO = `## Cold-cache verdict

The patched decoder is **not** a throughput regression. Cold-cache numbers hold within noise of \`main\`:

- Patched: **94.2 req/s**
- Main: **92.7 req/s**
- Delta: +1.6% — inside the 5% gate

\`\`\`bash
$ python3 bench/run.py --cold --trials 5
patched: 94.2 req/s (mean of 5)
main:    92.7 req/s (mean of 5)
\`\`\`

| run | patched (req/s) | main (req/s) |
| --- | ---: | ---: |
| 1 | 94.0 | 92.5 |
| 2 | 93.9 | 92.9 |
| 3 | 94.4 | 92.6 |
| 4 | 94.1 | 92.8 |
| 5 | 94.0 | 92.7 |

Full output in \`bench/out/cold.json\`. Gate closed — [posting the corrected number to the board](https://github.com/nerln/reflip/issues/128).`;

function zeroUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, turns: 0 };
}

function memberAuthor(m: Member, role: Role, machines: Machine[]): Author {
  const machine = machines.find((x) => x.id === m.machineId);
  return { kind: 'member', memberId: m.id, memberName: m.name, role: role.label, machine: machine?.name ?? m.machineId };
}

class MockHub {
  private dispatch: ((action: UiAction) => void) | null = null;
  private tickTimer: number | undefined;
  private demoTimers: number[] = [];
  private tick = 0;

  private studio: Studio;
  private roles: Role[];
  private machines: Machine[];
  private members: Member[];
  private voci: Voce[];
  private rituals: Ritual[];
  private transcripts: Record<string, TranscriptItem[]>;
  private permissions: PermissionRequest[];

  constructor() {
    this.roles = buildRoles();
    this.machines = buildMachines();
    this.members = buildMembers(this.roles, this.machines);
    const { voci, rituals } = buildBoard(this.members, this.roles, this.machines);
    this.voci = voci;
    this.rituals = rituals;
    this.transcripts = buildTranscripts(this.members);
    const lookout2 = this.members.find((m) => m.name === 'Lookout 2');
    this.permissions = lookout2 ? [buildLookout2Permission(lookout2.id)] : [];
    this.studio = {
      id: STUDIO_ID,
      name: 'reflip-throughput',
      goal:
        'Verify the patched decoder is not a throughput regression before anyone claims it is faster. ' +
        'A number here needs the command that produced it and a lookout who tried to break it.',
      roots: ['/Users/eugenionerelli/dev/reflip'],
      budgetUsd: 10,
      createdAt: minutesAgo(140),
    };
  }

  private emit(msg: HubToUi): void {
    this.dispatch?.(msg);
  }

  private findMember(id: string): Member {
    const m = this.members.find((x) => x.id === id);
    if (!m) throw new Error(`unknown member ${id}`);
    return m;
  }

  private updateMember(id: string, patch: Partial<Member>): Member {
    const idx = this.members.findIndex((m) => m.id === id);
    if (idx === -1) throw new Error(`unknown member ${id}`);
    const updated = { ...this.members[idx], ...patch };
    this.members = this.members.slice();
    this.members[idx] = updated;
    this.emit({ t: 'member.updated', member: updated });
    return updated;
  }

  private appendTranscript(memberId: string, item: TranscriptItem): void {
    const existing = this.transcripts[memberId] ?? [];
    this.transcripts[memberId] = [...existing, item];
    this.emit({ t: 'transcript.item', memberId, item });
  }

  private pushVoce(voce: Voce): void {
    this.voci = [...this.voci, voce];
    this.emit({ t: 'voce.added', voce });
  }

  // ---------- connection ----------

  connect(dispatch: (action: UiAction) => void): WsHandle {
    this.dispatch = dispatch;
    const openTimer = window.setTimeout(() => {
      dispatch({ t: 'ui.connected', connected: true });
      dispatch({
        t: 'snapshot',
        studio: this.studio,
        roles: this.roles,
        machines: this.machines,
        members: this.members,
        voci: this.voci,
        rituals: this.rituals,
        permissions: this.permissions,
      });
    }, 120);
    const streamTimer = window.setTimeout(() => this.runStreamingDemo(), 900);
    this.demoTimers.push(streamTimer);
    this.tickTimer = window.setInterval(() => this.simulateTick(), 3000);
    return {
      send: () => {
        /* UiToHub messages have no effect in mock mode: REST covers everything the fixture needs */
      },
      close: () => {
        window.clearTimeout(openTimer);
        if (this.tickTimer !== undefined) window.clearInterval(this.tickTimer);
        for (const t of this.demoTimers) window.clearInterval(t);
        this.demoTimers = [];
        this.dispatch = null;
      },
    };
  }

  // ---------- REST-equivalent methods ----------

  async getSnapshot() {
    return {
      studio: this.studio,
      roles: this.roles,
      machines: this.machines,
      members: this.members,
      voci: this.voci,
      rituals: this.rituals,
    };
  }

  async createMember(input: CreateMemberInput): Promise<Member> {
    const role = this.roles.find((r) => r.id === input.roleId);
    if (!role) throw new Error(`unknown role ${input.roleId}`);
    const id = nextId('member');
    const now = new Date().toISOString();
    const member: Member = {
      id,
      studioId: STUDIO_ID,
      roleId: role.id,
      machineId: input.machineId,
      name: input.name?.trim() || `${role.label} ${this.members.filter((m) => m.roleId === role.id).length + 1}`,
      cwd: input.cwd?.trim() || this.studio.roots[0] || '/',
      model: input.model?.trim() || role.model,
      effort: (input.effort as Member['effort']) || role.effort,
      status: 'starting',
      sessionId: null,
      usage: zeroUsage(),
      createdAt: now,
      lastActivityAt: now,
      error: null,
    };
    this.members = [...this.members, member];
    this.transcripts[id] = [];
    this.emit({ t: 'member.updated', member });
    this.appendTranscript(id, { kind: 'system', text: `Starting session. Model: ${member.model}, effort: ${member.effort}.`, ts: now });
    window.setTimeout(() => {
      const started = this.updateMember(id, {
        status: 'idle',
        sessionId: nextId('sess'),
        lastActivityAt: new Date().toISOString(),
      });
      this.appendTranscript(id, { kind: 'system', text: 'Session started.', ts: started.lastActivityAt });
      this.appendTranscript(id, { kind: 'user', text: input.brief, ts: started.lastActivityAt, framed: false });
    }, 900);
    return member;
  }

  async sendToMember(id: string, text: string): Promise<void> {
    const now = new Date().toISOString();
    this.appendTranscript(id, { kind: 'user', text, ts: now, framed: false });
    this.updateMember(id, { status: 'working', lastActivityAt: now });
    window.setTimeout(() => {
      const ts = new Date().toISOString();
      this.appendTranscript(id, { kind: 'text', text: 'On it.', ts });
      const m = this.findMember(id);
      const usage: Usage = {
        ...m.usage,
        inputTokens: m.usage.inputTokens + 800,
        outputTokens: m.usage.outputTokens + 120,
        costUsd: Number((m.usage.costUsd + 0.02).toFixed(4)),
        turns: m.usage.turns + 1,
      };
      this.appendTranscript(id, { kind: 'result', subtype: 'success', usage, ts });
      this.updateMember(id, { status: 'idle', usage, lastActivityAt: ts });
    }, 1100);
  }

  async interruptMember(id: string): Promise<void> {
    const ts = new Date().toISOString();
    this.updateMember(id, { status: 'idle', lastActivityAt: ts });
    this.appendTranscript(id, { kind: 'system', text: 'Interrupted by the owner.', ts });
  }

  async stopMember(id: string): Promise<void> {
    const ts = new Date().toISOString();
    this.updateMember(id, { status: 'stopped', lastActivityAt: ts });
    this.appendTranscript(id, { kind: 'system', text: 'Session stopped.', ts });
  }

  async setMemberModel(id: string, model: string): Promise<void> {
    const ts = new Date().toISOString();
    this.updateMember(id, { model, lastActivityAt: ts });
    this.appendTranscript(id, { kind: 'system', text: `Model changed to ${model}.`, ts });
  }

  async removeMember(id: string): Promise<void> {
    this.members = this.members.filter((m) => m.id !== id);
    delete this.transcripts[id];
    this.emit({ t: 'member.removed', memberId: id });
  }

  async getTranscript(id: string): Promise<TranscriptItem[]> {
    return this.transcripts[id] ?? [];
  }

  async postVoce(input: PostVoceInput): Promise<Voce> {
    const voce: Voce = {
      id: nextId('voce'),
      studioId: STUDIO_ID,
      verb: input.verb,
      text: input.text,
      author: { kind: 'owner' },
      to: input.to,
      replyTo: input.replyTo ?? null,
      meta: input.meta ?? {},
      createdAt: new Date().toISOString(),
    };
    this.pushVoce(voce);
    return voce;
  }

  async attackRitual(input: AttackRitualInput): Promise<Ritual> {
    const n = input.n ?? 3;
    const target = this.voci.find((v) => v.id === input.voceId);
    const memberIds = Array.from({ length: n }, () => nextId('member-lookout'));
    const ritual: Ritual = {
      id: nextId('ritual'),
      studioId: STUDIO_ID,
      kind: 'attack',
      targetVoceId: input.voceId,
      memberIds,
      status: 'running',
      outcome: {},
      createdAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.rituals = [...this.rituals, ritual];
    this.emit({ t: 'ritual.updated', ritual });

    window.setTimeout(() => {
      const verdicts: Array<'refuted' | 'holds'> = [];
      memberIds.forEach((mid, i) => {
        const verdict = i === 0 ? 'holds' : 'refuted';
        verdicts.push(verdict);
        const voce: Voce = {
          id: nextId('voce'),
          studioId: STUDIO_ID,
          verb: 'attacco',
          text:
            verdict === 'refuted'
              ? 'Reran with the same command; the figure does not reproduce cold. Evidence attached below.'
              : 'Reproduced independently with the same command and inputs. The number holds.',
          author: { kind: 'member', memberId: mid, memberName: `Lookout R${i + 1}`, role: 'Lookout', machine: this.machines[0]?.name ?? 'laptop' },
          to: target?.author.kind === 'member' ? target.author.memberId : 'all',
          replyTo: input.voceId,
          meta: { verdict },
          createdAt: new Date().toISOString(),
        };
        this.pushVoce(voce);
      });
      const refuted = verdicts.filter((v) => v === 'refuted').length;
      const holds = verdicts.filter((v) => v === 'holds').length;
      const finished: Ritual = {
        ...ritual,
        status: 'done',
        outcome: { refuted, holds, undecidable: 0, pending: 0, survives: holds > refuted },
        finishedAt: new Date().toISOString(),
      };
      this.rituals = this.rituals.map((r) => (r.id === ritual.id ? finished : r));
      this.emit({ t: 'ritual.updated', ritual: finished });
    }, 1400);

    return ritual;
  }

  async patchStudio(input: PatchStudioInput): Promise<Studio> {
    this.studio = {
      ...this.studio,
      ...(input.goal !== undefined ? { goal: input.goal } : {}),
      ...(input.budgetUsd !== undefined ? { budgetUsd: input.budgetUsd } : {}),
    };
    this.emit({ t: 'studio.updated', studio: this.studio });
    return this.studio;
  }

  /** Mirrors POST /api/members/:id/permissions/:reqId: drop the request, tell the UI, and let
   *  the member act on the answer — resolved entirely client-side, same as the rest of the mock. */
  async resolvePermission(memberId: string, reqId: string, allow: boolean, remember: boolean): Promise<void> {
    const existed = this.permissions.some((p) => p.reqId === reqId);
    this.permissions = this.permissions.filter((p) => p.reqId !== reqId);
    if (existed) this.emit({ t: 'permission.resolved', memberId, reqId, allow, by: 'owner' });

    const ts = new Date().toISOString();
    if (!allow) {
      this.appendTranscript(memberId, { kind: 'tool_result', toolUseId: LOOKOUT2_PUSH_TOOL_USE_ID, text: 'Permission denied by the owner.', isError: true, ts });
      this.updateMember(memberId, { status: 'idle', lastActivityAt: ts });
      return;
    }
    this.updateMember(memberId, { status: 'working', lastActivityAt: ts });
    window.setTimeout(() => {
      const doneTs = new Date().toISOString();
      this.appendTranscript(memberId, {
        kind: 'tool_result',
        toolUseId: LOOKOUT2_PUSH_TOOL_USE_ID,
        text: 'To github.com:nerln/reflip.git\n   a1b2c3d..e4f5a6b  decoder-patch -> decoder-patch',
        isError: false,
        ts: doneTs,
      });
      this.appendTranscript(memberId, {
        kind: 'text',
        text: remember
          ? 'Pushed. Bash is pre-approved for the rest of this session, so the next command will not ask again.'
          : 'Pushed the corrected benchmark to the remote.',
        ts: doneTs,
      });
      this.updateMember(memberId, { status: 'idle', lastActivityAt: doneTs });
    }, 800);
  }

  /** Plays out one streamed markdown answer on the Captain: growing `transcript.delta` chunks
   *  followed by the finalized `text` item, exactly the shape a real session sends. */
  private runStreamingDemo(): void {
    const member = this.members.find((m) => m.name === 'Captain');
    if (!member) return;
    const askTs = new Date().toISOString();
    this.updateMember(member.id, { status: 'working', lastActivityAt: askTs });
    this.appendTranscript(member.id, {
      kind: 'user',
      text: 'Give me the verdict on the cold-cache rerun: the numbers, the command, and whether the gate holds.',
      ts: askTs,
      framed: false,
    });

    const text = STREAMING_MARKDOWN_DEMO;
    const chunkSize = 16;
    let i = 0;
    const timer = window.setInterval(() => {
      const delta = text.slice(i, i + chunkSize);
      i += chunkSize;
      this.emit({ t: 'transcript.delta', memberId: member.id, blockIndex: 0, kind: 'text', delta });
      if (i >= text.length) {
        window.clearInterval(timer);
        const ts = new Date().toISOString();
        this.appendTranscript(member.id, { kind: 'text', text, ts });
        const usage: Usage = {
          ...member.usage,
          inputTokens: member.usage.inputTokens + 1400,
          outputTokens: member.usage.outputTokens + 260,
          cacheReadTokens: member.usage.cacheReadTokens + 4000,
          costUsd: Number((member.usage.costUsd + 0.06).toFixed(4)),
          turns: member.usage.turns + 1,
        };
        this.appendTranscript(member.id, { kind: 'result', subtype: 'success', usage, ts });
        this.updateMember(member.id, { status: 'idle', usage, lastActivityAt: ts });
      }
    }, 80);
    this.demoTimers.push(timer);
  }

  // ---------- background simulation ----------

  private simulateTick(): void {
    this.tick += 1;
    const ts = new Date().toISOString();

    const worker = this.members.find((m) => m.name === 'Deckhand 1');
    if (worker) {
      const script: TranscriptItem[] = [
        { kind: 'tool_use', name: 'Bash', input: { command: 'hyperfine --warmup 3 --min-runs 10 "./decoder --input corpus/small"' }, toolUseId: nextId('tu'), ts },
        { kind: 'tool_result', toolUseId: 'x', text: 'Benchmark 1: 94.6 req/s ± 1.1 (10 runs)', isError: false, ts },
        { kind: 'thinking', text: 'Cold-cache numbers are stable across runs now; within noise of main.', ts },
        { kind: 'text', text: 'Cold-cache run holds at ~94 req/s, consistent with the retracted figure being a warm-cache artifact.', ts },
      ];
      const item = script[this.tick % script.length];
      this.appendTranscript(worker.id, item.kind === 'tool_result' ? { ...item, toolUseId: nextId('tu') } : item);
      if (item.kind === 'text') {
        const usage: Usage = {
          ...worker.usage,
          inputTokens: worker.usage.inputTokens + 640,
          outputTokens: worker.usage.outputTokens + 95,
          cacheReadTokens: worker.usage.cacheReadTokens + 2000,
          costUsd: Number((worker.usage.costUsd + 0.015).toFixed(4)),
          turns: worker.usage.turns + 1,
        };
        this.updateMember(worker.id, { usage, lastActivityAt: ts, status: 'working' });
      }
    }

    const lookout = this.members.find((m) => m.name === 'Lookout 1');
    if (lookout && this.tick % 4 === 0) {
      const recovering = lookout.status === 'error';
      this.updateMember(lookout.id, {
        status: recovering ? 'idle' : 'error',
        error: recovering ? null : 'Lost the connection to the machine mid tool-call (ECONNRESET). Retrying.',
        lastActivityAt: ts,
      });
    }

    if (this.tick % 1 === 0) {
      const templates = [
        { verb: 'messaggio' as const, text: 'Corpus cache cleared between runs; timings look stable now.' },
        { verb: 'avviso' as const, text: 'Disk on laptop at 78% — still well clear of the studio limit.' },
        { verb: 'messaggio' as const, text: 'Cold-cache benchmark round holding within 2% of the previous cold run.' },
      ];
      const tmpl = templates[this.tick % templates.length];
      const voce: Voce = {
        id: nextId('voce'),
        studioId: STUDIO_ID,
        verb: tmpl.verb,
        text: tmpl.text,
        author: worker ? memberAuthor(worker, this.roles.find((r) => r.id === worker.roleId)!, this.machines) : { kind: 'hub' },
        to: 'all',
        replyTo: null,
        meta: {},
        createdAt: ts,
      };
      this.pushVoce(voce);
    }
  }
}

export const mockHub = new MockHub();

// ---------- fixture builders ----------

function buildRoles(): Role[] {
  return [
    {
      id: 'role-captain',
      name: 'captain',
      label: 'Captain',
      mandate:
        'You are the captain of this crew. You set the direction; you never execute. Each round you receive ' +
        'the studio goal, the blackboard since the last round, and the owner\'s notes.',
      model: 'claude-opus-5',
      effort: 'xhigh',
      tools: ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch', 'WebSearch'],
      permissionMode: 'dontAsk',
      canPropose: false,
    },
    {
      id: 'role-lookout',
      name: 'lookout',
      label: 'Lookout',
      mandate:
        'You are the lookout. Your job is to refute the claim you are given. If you cannot decide, your ' +
        'verdict is "refuted": a claim that survives you has to have earned it.',
      model: 'claude-sonnet-5',
      effort: 'xhigh',
      tools: ['Read', 'Grep', 'Glob', 'Bash'],
      permissionMode: 'dontAsk',
      canPropose: false,
    },
    {
      id: 'role-deckhand',
      name: 'deckhand',
      label: 'Deckhand',
      mandate:
        'You are a deckhand. You do one bounded, verifiable job and report exactly what you found. ' +
        'Every number you state carries its source.',
      model: 'claude-sonnet-5',
      effort: 'high',
      permissionMode: 'acceptEdits',
      canPropose: false,
    },
  ];
}

function buildMachines(): Machine[] {
  return [
    { id: 'machine-laptop', name: 'laptop', kind: 'local', status: 'online', lastSeenAt: minutesAgo(0), claudeVersion: '2.1.3' },
    { id: 'machine-nuc', name: 'nuc', kind: 'remote', status: 'offline', lastSeenAt: minutesAgo(42), claudeVersion: '2.1.1' },
  ];
}

function buildMembers(roles: Role[], machines: Machine[]): Member[] {
  const laptop = machines[0].id;
  return [
    {
      id: 'member-captain-1',
      studioId: STUDIO_ID,
      roleId: roles[0].id,
      machineId: laptop,
      name: 'Captain',
      cwd: '/Users/eugenionerelli/dev/reflip',
      model: roles[0].model,
      effort: roles[0].effort,
      status: 'idle',
      sessionId: 'sess-captain-1',
      usage: { inputTokens: 42000, outputTokens: 3100, cacheReadTokens: 180000, cacheWriteTokens: 12000, costUsd: 2.85, turns: 6 },
      createdAt: minutesAgo(138),
      lastActivityAt: minutesAgo(35),
      error: null,
    },
    {
      id: 'member-lookout-1',
      studioId: STUDIO_ID,
      roleId: roles[1].id,
      machineId: laptop,
      name: 'Lookout 1',
      cwd: '/Users/eugenionerelli/dev/reflip',
      model: roles[1].model,
      effort: roles[1].effort,
      status: 'error',
      sessionId: 'sess-lookout-1',
      usage: { inputTokens: 9000, outputTokens: 800, cacheReadTokens: 12000, cacheWriteTokens: 0, costUsd: 0.31, turns: 2 },
      createdAt: minutesAgo(90),
      lastActivityAt: minutesAgo(6),
      error: 'Lost the connection to the machine mid tool-call (ECONNRESET). Retrying.',
    },
    {
      id: 'member-deckhand-1',
      studioId: STUDIO_ID,
      roleId: roles[2].id,
      machineId: laptop,
      name: 'Deckhand 1',
      cwd: '/Users/eugenionerelli/dev/reflip',
      model: roles[2].model,
      effort: roles[2].effort,
      status: 'working',
      sessionId: 'sess-deckhand-1',
      usage: { inputTokens: 21000, outputTokens: 5400, cacheReadTokens: 60000, cacheWriteTokens: 8000, costUsd: 1.42, turns: 9 },
      createdAt: minutesAgo(132),
      lastActivityAt: minutesAgo(1),
      error: null,
    },
    {
      id: 'member-lookout-2',
      studioId: STUDIO_ID,
      roleId: roles[1].id,
      machineId: laptop,
      name: 'Lookout 2',
      cwd: '/Users/eugenionerelli/dev/reflip',
      model: roles[1].model,
      effort: roles[1].effort,
      status: 'waiting',
      sessionId: 'sess-lookout-2',
      usage: { inputTokens: 14000, outputTokens: 1100, cacheReadTokens: 22000, cacheWriteTokens: 0, costUsd: 0.44, turns: 3 },
      createdAt: minutesAgo(30),
      lastActivityAt: minutesAgo(1),
      error: null,
    },
  ];
}

function buildBoard(members: Member[], roles: Role[], machines: Machine[]): { voci: Voce[]; rituals: Ritual[] } {
  const captain = members[0];
  const lookout1 = members[1];
  const deckhand = members[2];
  const roleOf = (m: Member): Role => roles.find((r) => r.id === m.roleId)!;

  const voci: Voce[] = [];
  const push = (v: Omit<Voce, 'id' | 'studioId'>) => {
    voci.push({ ...v, id: nextId('voce'), studioId: STUDIO_ID });
  };

  push({
    verb: 'messaggio',
    text: "Studio 'reflip-throughput' started. Goal: verify the patched decoder is not a throughput regression before anyone claims it is faster.",
    author: { kind: 'hub' },
    to: 'all',
    replyTo: null,
    meta: {},
    createdAt: minutesAgo(138),
  });
  push({
    verb: 'messaggio',
    text:
      'Direction for the next 24h: benchmark the patched decoder against main on corpus/small, five runs each, ' +
      'cold and warm cache. Gate: throughput regression under 5% fails the patch.',
    author: memberAuthor(captain, roleOf(captain), machines),
    to: 'all',
    replyTo: null,
    meta: {},
    createdAt: minutesAgo(135),
  });
  push({
    verb: 'preso',
    text: 'Taking: benchmark decoder throughput on corpus/small with hyperfine, patched vs main.',
    author: memberAuthor(deckhand, roleOf(deckhand), machines),
    to: 'all',
    replyTo: null,
    meta: {},
    createdAt: minutesAgo(120),
  });
  const numero1Id = nextId('voce');
  voci.push({
    id: numero1Id,
    studioId: STUDIO_ID,
    verb: 'numero',
    text: 'Patched decoder: 128.4 req/s on corpus/small (n=20), hyperfine --warmup 5 --min-runs 20.',
    author: memberAuthor(deckhand, roleOf(deckhand), machines),
    to: 'all',
    replyTo: null,
    meta: { value: 128.4, unit: 'req/s', source: 'bench/run.py:42' },
    createdAt: minutesAgo(112),
  });
  push({
    verb: 'fatto',
    text: 'Benchmark done. bench/run.py holds the script; raw hyperfine output in bench/out/patched.json.',
    author: memberAuthor(deckhand, roleOf(deckhand), machines),
    to: 'all',
    replyTo: null,
    meta: {},
    createdAt: minutesAgo(111),
  });
  push({
    verb: 'messaggio',
    text: "That's well above main. Let's get this checked before we say anything.",
    author: { kind: 'owner' },
    to: 'all',
    replyTo: null,
    meta: {},
    createdAt: minutesAgo(108),
  });
  push({
    verb: 'avviso',
    text: 'Budget at 40% of the studio cap ($10).',
    author: { kind: 'hub' },
    to: 'all',
    replyTo: null,
    meta: {},
    createdAt: minutesAgo(105),
  });

  const ritualMemberIds = [nextId('member-lookout'), nextId('member-lookout'), nextId('member-lookout')];
  const attackVerdicts: Array<{ verdict: 'refuted' | 'holds'; text: string }> = [
    { verdict: 'refuted', text: 'Cold cache: 94.1 req/s, nowhere near 128.4. The claimed run reused a warm page cache from an earlier pass — bench/out/patched.json:3 shows a 40ms first-request latency, too fast for cold I/O.' },
    { verdict: 'holds', text: 'Reran with the exact command in bench/run.py:42 and the same environment: 126.8 req/s. Reproduces if the cache is warm, which the claim did not disclose.' },
    { verdict: 'refuted', text: 'Same finding as R1 independently: dropping the page cache before the run gives 93.7 req/s. The 128.4 figure is a warm-cache number reported as if it were the steady state.' },
  ];
  const ritualCreated = minutesAgo(103);
  attackVerdicts.forEach((a, i) => {
    push({
      verb: 'attacco',
      text: a.text,
      author: { kind: 'member', memberId: ritualMemberIds[i], memberName: `Lookout R${i + 1}`, role: 'Lookout', machine: machines[0]?.name ?? 'laptop' },
      to: deckhand.id,
      replyTo: numero1Id,
      meta: { verdict: a.verdict },
      createdAt: minutesAgo(101 - i),
    });
  });
  const rituals: Ritual[] = [
    {
      id: nextId('ritual'),
      studioId: STUDIO_ID,
      kind: 'attack',
      targetVoceId: numero1Id,
      memberIds: ritualMemberIds,
      status: 'done',
      outcome: {
        refuted: 2,
        holds: 1,
        undecidable: 0,
        pending: 0,
        survives: false,
        detail: [
          { member: 'Lookout R1', verdict: 'refuted' },
          { member: 'Lookout R2', verdict: 'holds' },
          { member: 'Lookout R3', verdict: 'refuted' },
        ],
      },
      createdAt: ritualCreated,
      finishedAt: minutesAgo(99),
    },
  ];

  push({
    verb: 'ritratto',
    text:
      "Retracting the 128.4 figure. The lookouts caught it: the patched run's corpus was cached from a prior warm-up pass, " +
      'main was not. Rerunning both with a cold cache.',
    author: memberAuthor(deckhand, roleOf(deckhand), machines),
    to: 'all',
    replyTo: numero1Id,
    meta: {},
    createdAt: minutesAgo(97),
  });
  push({
    verb: 'preso',
    text: 'Taking: rerun both decoders with a cold cache, five trials each.',
    author: memberAuthor(deckhand, roleOf(deckhand), machines),
    to: 'all',
    replyTo: null,
    meta: {},
    createdAt: minutesAgo(95),
  });
  push({
    verb: 'numero',
    text: 'Patched decoder, cold cache: 94.2 req/s. Main, same conditions: 92.7 req/s. Within 2%, not a regression.',
    author: memberAuthor(deckhand, roleOf(deckhand), machines),
    to: 'all',
    replyTo: null,
    meta: { value: 94.2, unit: 'req/s', source: 'bench/run.py:58' },
    createdAt: minutesAgo(40),
  });
  push({
    verb: 'fatto',
    text: 'Cold-cache benchmark done. Scripts and raw output in bench/out/cold.json.',
    author: memberAuthor(deckhand, roleOf(deckhand), machines),
    to: 'all',
    replyTo: null,
    meta: {},
    createdAt: minutesAgo(38),
  });
  push({
    verb: 'messaggio',
    text: 'Good catch from the lookouts. Direction unchanged: no throughput regression, ship the patch. Gate closed.',
    author: memberAuthor(captain, roleOf(captain), machines),
    to: 'all',
    replyTo: null,
    meta: {},
    createdAt: minutesAgo(35),
  });
  const proposalId = nextId('voce');
  voci.push({
    id: proposalId,
    studioId: STUDIO_ID,
    verb: 'proposta',
    text:
      "Proposing to post on issue #128: 'Patched decoder is not a throughput regression (94.2 vs 92.7 req/s, cold cache, n=5). " +
      "An earlier warm-cache figure was retracted after attack.' Needs Deckhand 1 and Lookout 1 to sign off.",
    author: { kind: 'owner' },
    to: 'all',
    replyTo: null,
    meta: {},
    createdAt: minutesAgo(20),
  });
  push({
    verb: 'consenso',
    text: 'Yes — this matches what is on disk.',
    author: memberAuthor(deckhand, roleOf(deckhand), machines),
    to: 'owner',
    replyTo: proposalId,
    meta: { value: 'yes' },
    createdAt: minutesAgo(18),
  });
  push({
    verb: 'consenso',
    text: 'Yes. I re-ran the cold-cache numbers myself; they hold.',
    author: memberAuthor(lookout1, roleOf(lookout1), machines),
    to: 'owner',
    replyTo: proposalId,
    meta: { value: 'yes' },
    createdAt: minutesAgo(15),
  });

  voci.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { voci, rituals };
}

function buildTranscripts(members: Member[]): Record<string, TranscriptItem[]> {
  const [captain, lookout1, deckhand] = members;
  const t: Record<string, TranscriptItem[]> = {};

  t[captain.id] = [
    { kind: 'system', text: `Session started. Model: ${captain.model}, effort: ${captain.effort}.`, ts: minutesAgo(138) },
    {
      kind: 'user',
      text:
        'Studio goal: verify the patched decoder is not a throughput regression before anyone claims it is faster.\n\n' +
        'Set the direction for the next 24 hours.',
      ts: minutesAgo(138),
      framed: false,
    },
    {
      kind: 'thinking',
      text: 'No verified numbers yet. The direction should be a bounded benchmark with a gate, not a conclusion.',
      ts: minutesAgo(136),
    },
    {
      kind: 'text',
      text:
        'Direction for the next 24h: benchmark the patched decoder against main on corpus/small, five runs each, ' +
        'cold and warm cache. Gate: throughput regression under 5% fails the patch. Posted to the board.',
      ts: minutesAgo(135),
    },
    { kind: 'result', subtype: 'success', usage: { inputTokens: 18000, outputTokens: 1200, cacheReadTokens: 60000, cacheWriteTokens: 4000, costUsd: 1.1, turns: 2 }, ts: minutesAgo(135) },
    {
      kind: 'user',
      text: "[from the board] Deckhand 1 (Deckhand · laptop) — numero: Patched decoder: 128.4 req/s on corpus/small (n=20), hyperfine --warmup 5 --min-runs 20.",
      ts: minutesAgo(112),
      framed: true,
    },
    {
      kind: 'text',
      text: "That's a large jump. Worth attacking before it goes anywhere — asked the lookouts.",
      ts: minutesAgo(110),
    },
    { kind: 'result', subtype: 'success', usage: { inputTokens: 42000, outputTokens: 3100, cacheReadTokens: 180000, cacheWriteTokens: 12000, costUsd: 2.85, turns: 6 }, ts: minutesAgo(35) },
  ];

  t[lookout1.id] = [
    { kind: 'system', text: `Session started. Model: ${lookout1.model}, effort: ${lookout1.effort}.`, ts: minutesAgo(90) },
    {
      kind: 'user',
      text: "[from the board] Owner — proposta: Proposing to post on issue #128: patched decoder is not a throughput regression. Needs your consent.",
      ts: minutesAgo(20),
      framed: true,
    },
    { kind: 'tool_use', name: 'Bash', input: { command: 'python3 bench/run.py --cold --trials 5' }, toolUseId: 'tu-lk-1', ts: minutesAgo(17) },
    { kind: 'tool_result', toolUseId: 'tu-lk-1', text: '94.0 req/s, 93.9 req/s, 94.4 req/s, 94.1 req/s, 94.0 req/s', isError: false, ts: minutesAgo(16) },
    { kind: 'text', text: 'Reproduces. Consenting.', ts: minutesAgo(15) },
    { kind: 'result', subtype: 'success', usage: { inputTokens: 9000, outputTokens: 800, cacheReadTokens: 12000, cacheWriteTokens: 0, costUsd: 0.31, turns: 2 }, ts: minutesAgo(15) },
    { kind: 'tool_use', name: 'Bash', input: { command: 'ssh nuc uptime' }, toolUseId: 'tu-lk-2', ts: minutesAgo(6) },
    { kind: 'tool_result', toolUseId: 'tu-lk-2', text: 'ssh: connect to host nuc port 22: Connection reset by peer', isError: true, ts: minutesAgo(6) },
  ];

  t[deckhand.id] = [
    { kind: 'system', text: `Session started. Model: ${deckhand.model}, effort: ${deckhand.effort}.`, ts: minutesAgo(132) },
    { kind: 'user', text: 'Benchmark the patched decoder against main on corpus/small. Report numbers with the command that produced them.', ts: minutesAgo(132), framed: false },
    { kind: 'tool_use', name: 'Bash', input: { command: 'hyperfine --warmup 5 --min-runs 20 "./decoder --patched --input corpus/small"' }, toolUseId: 'tu-dh-1', ts: minutesAgo(113) },
    { kind: 'tool_result', toolUseId: 'tu-dh-1', text: 'Time (mean ± σ): 7.8ms ± 0.3ms, Range: 7.1 – 8.4ms, 20 runs\nThroughput: 128.4 req/s', isError: false, ts: minutesAgo(112) },
    { kind: 'text', text: 'Patched decoder: 128.4 req/s. Posting to the board.', ts: minutesAgo(112) },
    {
      kind: 'user',
      text: "[from the board] Lookout R1 (Lookout · laptop) — attacco: Cold cache: 94.1 req/s, nowhere near 128.4. The run reused a warm page cache.",
      ts: minutesAgo(101),
      framed: true,
    },
    { kind: 'thinking', text: "They're right — I never dropped the page cache between the main and patched runs.", ts: minutesAgo(98) },
    { kind: 'tool_use', name: 'Bash', input: { command: 'sync && echo 3 | sudo tee /proc/sys/vm/drop_caches' }, toolUseId: 'tu-dh-2', ts: minutesAgo(95) },
    { kind: 'tool_result', toolUseId: 'tu-dh-2', text: '3', isError: false, ts: minutesAgo(95) },
    { kind: 'tool_use', name: 'Bash', input: { command: 'python3 bench/run.py --cold --trials 5' }, toolUseId: 'tu-dh-3', ts: minutesAgo(41) },
    { kind: 'tool_result', toolUseId: 'tu-dh-3', text: 'patched: 94.2 req/s (mean of 5)\nmain:    92.7 req/s (mean of 5)', isError: false, ts: minutesAgo(40) },
    { kind: 'text', text: 'Cold cache: 94.2 vs 92.7 req/s. Not a regression. Posting the corrected number.', ts: minutesAgo(40) },
    {
      kind: 'tool_use',
      name: 'Bash',
      input: { command: 'hyperfine --warmup 3 --min-runs 50 -L bin patched,main "./decoder --{bin} --input corpus/large"' },
      toolUseId: 'tu-dh-4',
      ts: minutesAgo(3),
    },
    {
      kind: 'tool_result',
      toolUseId: 'tu-dh-4',
      text:
        "Benchmark 1: ./decoder --patched --input corpus/large\n" +
        '  Time (mean ± σ):     41.2 ms ±   1.8 ms    [User: 38.1 ms, System: 2.6 ms]\n' +
        '  Range (min … max):   38.9 ms …  46.7 ms    50 runs\n' +
        '\n' +
        "Benchmark 2: ./decoder --main --input corpus/large\n" +
        '  Time (mean ± σ):     42.0 ms ±   2.1 ms    [User: 38.9 ms, System: 2.7 ms]\n' +
        '  Range (min … max):   39.4 ms …  48.3 ms    50 runs\n' +
        '\n' +
        'Summary\n' +
        "  './decoder --patched --input corpus/large' ran\n" +
        "    1.02 ± 0.06 times faster than './decoder --main --input corpus/large'\n" +
        '\n' +
        'Throughput, patched: 128.7 req/s\n' +
        'Throughput, main:    126.1 req/s\n' +
        'Warm-cache figures only — the cold-cache rerun above is the number that matters for the gate.',
      isError: false,
      ts: minutesAgo(2),
    },
    { kind: 'text', text: 'Large-corpus warm-cache run confirms the same story: within noise, no regression.', ts: minutesAgo(2) },
    { kind: 'result', subtype: 'success', usage: { inputTokens: 21000, outputTokens: 5400, cacheReadTokens: 60000, cacheWriteTokens: 8000, costUsd: 1.42, turns: 9 }, ts: minutesAgo(1) },
  ];

  t[members[3].id] = [
    { kind: 'system', text: `Session started. Model: ${members[3].model}, effort: ${members[3].effort}.`, ts: minutesAgo(30) },
    {
      kind: 'user',
      text: 'Once the cold-cache rerun confirms the number, push the decoder-patch branch so the corrected benchmark is on the remote.',
      ts: minutesAgo(30),
      framed: false,
    },
    { kind: 'thinking', text: 'The cold-cache number holds and the gate is closed. Pushing is an outward action — that needs the owner directly, not a proposta on the board.', ts: minutesAgo(2) },
    { kind: 'tool_use', name: 'Bash', input: { command: LOOKOUT2_PUSH_COMMAND }, toolUseId: LOOKOUT2_PUSH_TOOL_USE_ID, ts: minutesAgo(1) },
  ];

  return t;
}
