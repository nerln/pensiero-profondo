import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const CLI = join(ROOT, 'dist', 'cli.js');
const PORT = 4290 + Math.floor(Math.random() * 100);
const dir = mkdtempSync(join(tmpdir(), 'ciurma-dbg-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let TOKEN = '';
const api = async (m, p, b) => { const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method: m, headers: { 'content-type': 'application/json', 'x-ciurma-token': TOKEN }, body: b ? JSON.stringify(b) : undefined }); return r.json(); };
await new Promise((r) => spawn('node', [CLI, 'init', dir, '--port', String(PORT)]).on('exit', r));
TOKEN = JSON.parse((await import('node:fs')).readFileSync(join(dir, '.ciurma', 'config.json'), 'utf8')).token;
const hub = spawn('node', [CLI, 'hub', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
hub.stdout.on('data', (d) => process.stdout.write('[hub] ' + d));
hub.stderr.on('data', (d) => process.stdout.write('[hub!] ' + d));
let snap; for (let i = 0; i < 30; i++) { await sleep(1000); try { snap = await api('GET', '/api/snapshot'); if (snap.machines.some((m) => m.status === 'online')) break; } catch {} }
const machine = snap.machines.find((m) => m.status === 'online');
const member = await api('POST', '/api/members', { roleId: 'deckhand', machineId: machine.id, name: 'Dbg', model: process.env.CIURMA_MODEL || 'claude-sonnet-5', effort: 'low', cwd: dir, brief: 'Write exactly one entry on the board with lavagna_scrivi: verb "fatto", text "e2e ready", to "all". Then reply with the single word done and stop.' });
console.log('member', member.id, member.status);
for (let i = 0; i < 20; i++) {
  await sleep(5000);
  const s = await api('GET', '/api/snapshot');
  const m = s.members.find((x) => x.id === member.id);
  const t = await api('GET', `/api/members/${member.id}/transcript`);
  console.log(`t+${(i + 1) * 5}s status=${m.status} error=${m.error} turns=${m.usage.turns} items=${t.length} voci=${s.voci.length}`);
  if (t.length) for (const it of t.slice(-6)) console.log('   ', it.kind, JSON.stringify(it).slice(0, 220));
  if (s.voci.length || m.status === 'error' || (m.status === 'idle' && m.usage.turns > 0)) break;
}
hub.kill('SIGTERM'); rmSync(dir, { recursive: true, force: true });
