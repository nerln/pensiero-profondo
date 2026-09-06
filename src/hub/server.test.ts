import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { openDb } from './db.js';
import { startHub, type Hub } from './server.js';
import type { HubToUi, HubToWorker, WorkerToHub } from '../core/protocol.js';

const TOKEN = 'test-token';
let hub: Hub;
let port: number;
const db = openDb(':memory:');

// Messages can arrive before a test attaches its waiter (the snapshot is sent on open), so every
// socket buffers what it receives and `next` drains the buffer first.
const buffers = new WeakMap<WebSocket, unknown[]>();
function connect(path: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    const buf: unknown[] = [];
    buffers.set(ws, buf);
    ws.on('message', (d) => buf.push(JSON.parse(String(d))));
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}
function next<T>(ws: WebSocket, pred: (m: T) => boolean, label = '?', timeoutMs = 3000): Promise<T> {
  const buf = buffers.get(ws) ?? [];
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { clearInterval(poll); reject(new Error(`timeout waiting for ${label}`)); }, timeoutMs);
    const poll = setInterval(() => {
      const i = buf.findIndex((m) => pred(m as T));
      if (i >= 0) { const [m] = buf.splice(i, 1); clearTimeout(t); clearInterval(poll); resolve(m as T); }
    }, 10);
  });
}
const api = async (method: string, path: string, body?: unknown, token = TOKEN) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { 'x-pensiero-token': token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

beforeAll(async () => {
  db.studio.create({ name: 's', goal: 'g', roots: ['/tmp'], budgetUsd: null });
  db.roles.upsert({ id: 'deckhand', name: 'deckhand', label: 'Deckhand', mandate: 'm', model: 'claude-sonnet-5', effort: 'high', permissionMode: 'acceptEdits', canPropose: false });
  port = 4300 + Math.floor(Math.random() * 500);
  hub = await startHub({ db, port, host: '127.0.0.1', token: TOKEN, uiDir: null, log: () => {} });
});
afterAll(async () => { await hub.close(); db.close(); });

describe('hub', () => {
  it('requires the token on the API even on loopback', async () => {
    expect((await api('GET', '/api/snapshot', undefined, '')).status).toBe(401);
    expect((await api('GET', '/api/snapshot')).status).toBe(200);
  });

  it('refuses a UI socket from a foreign origin and a worker socket from a browser', async () => {
    await expect(connect(`/ws/ui?token=${TOKEN}`, { origin: 'http://evil.example' })).rejects.toBeTruthy();
    await expect(connect('/ws/worker', { origin: 'http://127.0.0.1:1' })).rejects.toBeTruthy();
  });

  it('runs a member through a fake worker and routes a permission request to the owner', async () => {
    const worker = await connect('/ws/worker');
    worker.send(JSON.stringify({ t: 'hello', token: TOKEN, machineName: 'fake', claudeVersion: '0' } satisfies WorkerToHub));
    const ok = await next<HubToWorker>(worker, (m) => m.t === 'hello.ok', 'hello.ok');
    expect(ok.t).toBe('hello.ok');
    const ui = await connect(`/ws/ui?token=${TOKEN}`, { origin: `http://127.0.0.1:${port}` });
    const snap = await next<HubToUi>(ui, (m) => m.t === 'snapshot', 'snapshot');
    if (snap.t !== 'snapshot') throw new Error('no snapshot');
    const machine = snap.machines.find((m) => m.status === 'online');
    expect(machine?.name).toBe('fake');

    const started = next<HubToWorker>(worker, (m) => m.t === 'session.start', 'session.start');
    const created = await api('POST', '/api/members', { roleId: 'deckhand', machineId: machine!.id, brief: 'do x' });
    expect(created.status).toBe(200);
    const memberId = created.body.id as string;
    const spec = await started;
    if (spec.t !== 'session.start') throw new Error('no start');
    expect(spec.spec.memberId).toBe(memberId);
    expect(spec.spec.firstPrompt).toContain('do x');

    // a streamed delta reaches the UI without touching the database
    worker.send(JSON.stringify({ t: 'session.delta', memberId, blockIndex: 0, kind: 'text', delta: 'hel' } satisfies WorkerToHub));
    const delta = await next<HubToUi>(ui, (m) => m.t === 'transcript.delta', 'transcript.delta');
    expect(delta).toMatchObject({ memberId, delta: 'hel' });
    expect(db.transcripts.list(memberId)).toHaveLength(0);

    // a permission request: member waits, UI is told, the owner answers, the worker gets the result
    worker.send(JSON.stringify({ t: 'session.status', memberId, status: 'waiting' } satisfies WorkerToHub));
    worker.send(JSON.stringify({ t: 'permission.request', memberId, reqId: 'p1', toolName: 'Bash', input: { command: 'rm -rf x' }, summary: 'rm -rf x' } satisfies WorkerToHub));
    const asked = await next<HubToUi>(ui, (m) => m.t === 'permission.requested', 'permission.requested');
    if (asked.t !== 'permission.requested') throw new Error('no request');
    expect(asked.request).toMatchObject({ reqId: 'p1', memberId, summary: 'rm -rf x' });
    expect(asked.request.createdAt).toMatch(/^\d{4}-/);
    expect((await api('GET', '/api/snapshot')).body.permissions).toHaveLength(1);
    const result = next<HubToWorker>(worker, (m) => m.t === 'permission.result', 'permission.result');
    expect((await api('POST', `/api/members/${memberId}/permissions/p1`, { allow: false })).status).toBe(200);
    expect(await result).toMatchObject({ t: 'permission.result', reqId: 'p1', allow: false });
    const resolved = await next<HubToUi>(ui, (m) => m.t === 'permission.resolved', 'permission.resolved');
    expect(resolved).toMatchObject({ reqId: 'p1', allow: false, by: 'owner' });
    expect((await api('POST', `/api/members/${memberId}/permissions/p1`, { allow: true })).status).toBe(404);

    // a worker cannot speak for a member of another machine
    const elsewhere = db.machines.upsert({ name: 'elsewhere', kind: 'remote', status: 'offline', claudeVersion: null });
    const other = db.members.create({ studioId: db.studio.get()!.id, roleId: 'deckhand', machineId: elsewhere.id, name: 'X', cwd: '/tmp', model: 'm', effort: 'high' });
    worker.send(JSON.stringify({ t: 'session.item', memberId: other.id, item: { kind: 'text', text: 'forged', ts: 'x' } } satisfies WorkerToHub));
    await new Promise((r) => setTimeout(r, 200));
    expect(db.transcripts.list(other.id)).toHaveLength(0);

    // transcript time is stamped by the hub, not the worker
    worker.send(JSON.stringify({ t: 'session.item', memberId, item: { kind: 'text', text: 'hi', ts: '1999-01-01T00:00:00.000Z' } } satisfies WorkerToHub));
    const item = await next<HubToUi>(ui, (m) => m.t === 'transcript.item', 'transcript.item');
    if (item.t !== 'transcript.item') throw new Error('no item');
    expect(item.item.ts).not.toBe('1999-01-01T00:00:00.000Z');

    worker.close(); ui.close();
  });
});
