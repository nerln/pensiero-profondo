// End-to-end: real hub, real embedded worker, one real (cheap) Claude Code session.
// Usage: node test/e2e.mjs   (needs `npm run build` first; costs one short Haiku turn)
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const CLI = join(ROOT, 'dist', 'cli.js');
const PORT = 4190 + Math.floor(Math.random() * 100);
const dir = mkdtempSync(join(tmpdir(), 'ciurma-e2e-'));
const log = (...a) => console.log('[e2e]', ...a);
const fail = (m) => { console.error('[e2e] FAIL:', m); cleanup(); process.exit(1); };
let hub;
function cleanup() { try { hub?.kill('SIGTERM'); } catch {} try { rmSync(dir, { recursive: true, force: true }); } catch {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (method, path, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(j)}`);
  return j;
};
async function until(desc, fn, timeoutMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { const v = await fn(); if (v) return v; await sleep(1000); }
  fail(`timeout waiting for ${desc}`);
}

try {
  const init = spawn('node', [CLI, 'init', dir, '--port', String(PORT)], { stdio: 'pipe' });
  await new Promise((r) => init.on('exit', r));
  const cfg = JSON.parse(readFileSync(join(dir, '.ciurma', 'config.json'), 'utf8'));
  if (!cfg.token) fail('init produced no token');
  log('init ok, port', PORT);

  hub = spawn('node', [CLI, 'hub', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  hub.stdout.on('data', (d) => process.stdout.write('[hub] ' + d));
  hub.stderr.on('data', (d) => process.stderr.write('[hub!] ' + d));
  await until('hub http', async () => { try { return await api('GET', '/api/snapshot'); } catch { return null; } }, 20000);
  const snap = await until('local worker online', async () => { const s = await api('GET', '/api/snapshot'); return s.machines.some((m) => m.status === 'online') ? s : null; }, 30000);
  if (snap.roles.length < 7) fail(`expected 7 roles, got ${snap.roles.length}`);
  const machine = snap.machines.find((m) => m.status === 'online');
  log('worker online:', machine.name, machine.claudeVersion);

  const member = await api('POST', '/api/members', { roleId: 'deckhand', machineId: machine.id, name: 'E2E Deckhand', model: 'claude-haiku-4-5', effort: 'low', cwd: dir, brief: 'Write exactly one entry on the board with lavagna_scrivi: verb "fatto", text "e2e ready", to "all". Then reply with the single word done and stop. Do not do anything else.' });
  log('member started:', member.id);

  const voce = await until('the member writes fatto on the board', async () => { const s = await api('GET', '/api/snapshot'); return s.voci.find((v) => v.verb === 'fatto' && v.author.kind === 'member' && v.author.memberId === member.id) ?? null; }, 120000);
  log('board entry from member:', JSON.stringify(voce.text), 'at', voce.createdAt);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(voce.createdAt)) fail('createdAt is not an ISO time from the hub');

  const items = await api('GET', `/api/members/${member.id}/transcript`);
  const kinds = new Set(items.map((i) => i.kind));
  if (!kinds.has('tool_use')) fail(`transcript has no tool_use item; kinds=${[...kinds]}`);
  if (!items.some((i) => i.kind === 'tool_use' && /lavagna_scrivi/.test(i.name))) fail('no lavagna_scrivi tool call in transcript');
  log('transcript ok:', items.length, 'items, kinds', [...kinds].join(','));

  const m2 = await until('member idle with usage', async () => { const s = await api('GET', '/api/snapshot'); const m = s.members.find((x) => x.id === member.id); return m && m.status === 'idle' && m.usage.turns > 0 ? m : null; }, 60000);
  log('usage:', JSON.stringify(m2.usage));

  await api('POST', '/api/voci', { verb: 'messaggio', text: 'owner says: reply with the single word acknowledged', to: member.id });
  const delivered = await until('framed delivery in transcript', async () => { const t = await api('GET', `/api/members/${member.id}/transcript`); return t.find((i) => i.kind === 'user' && i.framed) ?? null; }, 20000);
  if (!delivered.text.includes('| owner says')) fail('delivery is not framed with the margin');
  log('delivery framed ok');

  await api('POST', `/api/members/${member.id}/stop`);
  await until('member stopped', async () => { const s = await api('GET', '/api/snapshot'); const m = s.members.find((x) => x.id === member.id); return m && m.status === 'stopped' ? m : null; }, 20000);
  log('stopped ok');
  log('ALL OK');
  cleanup();
  process.exit(0);
} catch (e) { fail(e?.stack ?? String(e)); }
