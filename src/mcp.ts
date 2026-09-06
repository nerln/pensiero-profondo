// A stdio MCP server that lets a Claude Code session act as the owner's console for a crew:
// read and write the board, sign members on, talk to them, stage an attack. It talks to the hub
// over REST with the studio token, so it works from any terminal on the hub's machine.

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { VERBS, type Member, type Voce, type Role, type Machine } from './core/types.js';
import { cornice } from './core/lavagna.js';

interface Snapshot { studio: { name: string; goal: string; budgetUsd: number | null }; roles: Role[]; machines: Machine[]; members: Member[]; voci: Voce[] }

export async function runMcp(dir: string): Promise<void> {
  const root = resolve(dir);
  const cfgPath = join(root, '.ciurma', 'config.json');
  if (!existsSync(cfgPath)) throw new Error(`no studio in ${root}: run ciurma init there first`);
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { token: string; port: number; host: string };
  const base = `http://${cfg.host}:${cfg.port}`;
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-ciurma-token': cfg.token }, body: body ? JSON.stringify(body) : undefined });
    const j = (await r.json()) as T & { error?: string };
    if (!r.ok) throw new Error(j.error ?? `${method} ${path} failed with ${r.status}`);
    return j;
  };
  const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
  let lastRead = '';

  const server = new McpServer({ name: 'ciurma', version: '0.1.0' });

  server.tool('crew_status', 'Who is on the crew right now: members with role, machine, status, cost; machines online; the studio goal.', {}, async () => {
    const s = await api<Snapshot>('GET', '/api/snapshot');
    const roleOf = (id: string) => s.roles.find((r) => r.id === id)?.label ?? id;
    const machineOf = (id: string) => s.machines.find((m) => m.id === id)?.name ?? id;
    const lines = [
      `Studio "${s.studio.name}". Goal: ${s.studio.goal || '(not set)'}. Budget: ${s.studio.budgetUsd === null ? 'no cap' : '$' + s.studio.budgetUsd}.`,
      `Machines: ${s.machines.map((m) => `${m.name} (${m.status})`).join(', ') || 'none'}.`,
      ...s.members.map((m) => `- ${m.name} [${m.id}] ${roleOf(m.roleId)} on ${machineOf(m.machineId)}: ${m.status}, $${m.usage.costUsd.toFixed(2)}, ${m.usage.turns} turns, model ${m.model}`),
    ];
    return text(lines.join('\n'));
  });

  server.tool('lavagna_leggi', 'Read the board entries you have not seen yet, inside the board frame.', {}, async () => {
    const s = await api<Snapshot>('GET', '/api/snapshot');
    const fresh = s.voci.filter((v) => v.createdAt > lastRead && v.author.kind !== 'owner');
    if (fresh.length) lastRead = fresh[fresh.length - 1].createdAt;
    return text(cornice(fresh, { forMemberName: 'the owner', forRole: 'Owner' }));
  });

  server.tool('lavagna_scrivi', `Write an entry on the crew board as the owner. Verbs: ${VERBS.join(', ')}.`, {
    verb: z.enum(VERBS), text: z.string(), to: z.string().optional().describe("member id, role name, or 'all' (default)"), replyTo: z.string().optional(), meta: z.string().optional().describe('optional JSON object as a string'),
  }, async (a) => {
    let meta: unknown;
    if (a.meta) { try { meta = JSON.parse(a.meta); } catch { return text('meta is not valid JSON'); } }
    const v = await api<Voce>('POST', '/api/voci', { verb: a.verb, text: a.text, to: a.to ?? 'all', replyTo: a.replyTo ?? null, meta });
    return text(`posted ${v.verb} ${v.id} at ${v.createdAt}`);
  });

  server.tool('crew_signon', 'Sign a new member on: start a real Claude Code session with a role and a brief.', {
    role: z.string().describe('role id: captain, deckhand, lookout, cartographer, boatswain, scribe, watch'),
    brief: z.string(), name: z.string().optional(), machine: z.string().optional().describe('machine name; default: first online'), cwd: z.string().optional(), model: z.string().optional(),
  }, async (a) => {
    const s = await api<Snapshot>('GET', '/api/snapshot');
    const machine = a.machine ? s.machines.find((m) => m.name === a.machine) : s.machines.find((m) => m.status === 'online');
    if (!machine) return text('no such machine online');
    const m = await api<Member>('POST', '/api/members', { roleId: a.role, machineId: machine.id, name: a.name, cwd: a.cwd, model: a.model, brief: a.brief });
    return text(`${m.name} [${m.id}] signed on as ${a.role} on ${machine.name}`);
  });

  server.tool('crew_send', 'Send a message into one member\'s session, as the owner (not through the board).', { memberId: z.string(), text: z.string() }, async (a) => {
    await api('POST', `/api/members/${a.memberId}/send`, { text: a.text });
    return text('sent');
  });

  server.tool('crew_stop', 'Stop one member\'s session.', { memberId: z.string() }, async (a) => {
    await api('POST', `/api/members/${a.memberId}/stop`);
    return text('stopped');
  });

  server.tool('crew_attack', 'Stage an attack ritual on a numero entry: N lookouts try to refute it.', { voceId: z.string(), n: z.number().int().min(1).max(7).optional() }, async (a) => {
    const r = await api<{ id: string; memberIds: string[] }>('POST', '/api/rituals/attack', { voceId: a.voceId, n: a.n ?? 3 });
    return text(`attack ${r.id} started with ${r.memberIds.length} lookouts`);
  });

  server.tool('crew_transcript', 'The last lines of one member\'s transcript.', { memberId: z.string(), lines: z.number().int().min(1).max(200).optional() }, async (a) => {
    const items = await api<Array<{ kind: string; text?: string; name?: string; input?: unknown; isError?: boolean }>>('GET', `/api/members/${a.memberId}/transcript`);
    const tail = items.slice(-(a.lines ?? 40)).map((i) => {
      if (i.kind === 'tool_use') return `[tool ${i.name}] ${JSON.stringify(i.input).slice(0, 200)}`;
      if (i.kind === 'tool_result') return `[result${i.isError ? ' ERROR' : ''}] ${(i.text ?? '').slice(0, 300)}`;
      return `[${i.kind}] ${(i.text ?? '').slice(0, 600)}`;
    });
    return text(tail.join('\n') || '(empty)');
  });

  await server.connect(new StdioServerTransport());
}
