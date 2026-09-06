// The WebSocket client a remote (or the embedded local) worker runs: connects to the hub,
// starts/drives Claude Code sessions via startSession, and relays their events back over the
// socket. Reconnects with backoff when the socket drops; sessions keep running through a drop
// and their events are buffered until the socket comes back.

import { WebSocket } from 'ws';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { HubToWorker, WorkerToHub } from '../core/protocol.js';
import type { Verb } from '../core/types.js';
import { startSession, type QueryFn, type SessionHandle } from './session.js';

const MAX_BUFFERED = 1000;
const LAVAGNA_TIMEOUT_MS = 30000;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

export function runWorker(opts: {
  hubUrl: string;
  token: string;
  machineName: string;
  queryFn?: QueryFn;
  log?: (s: string) => void;
}): { close(): Promise<void> } {
  const log = opts.log ?? (() => {});
  const sessions = new Map<string, SessionHandle>();
  const buffer: WorkerToHub[] = [];
  const pending = new Map<string, { resolve: (msg: HubToWorker) => void; timer: NodeJS.Timeout }>();

  let ws: WebSocket | null = null;
  let connected = false;
  let closing = false;
  let backoff = INITIAL_BACKOFF_MS;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let claudeVersion: string | null = null;

  function send(msg: WorkerToHub): void {
    if (connected && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return;
    }
    buffer.push(msg);
    if (buffer.length > MAX_BUFFERED) buffer.shift();
  }

  function flushBuffer(): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    for (const msg of buffer.splice(0)) ws.send(JSON.stringify(msg));
  }

  function waitForResult<T extends HubToWorker>(reqId: string, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(reqId);
        reject(new Error('timed out waiting for hub response'));
      }, timeoutMs);
      pending.set(reqId, { resolve: (msg) => resolve(msg as T), timer });
    });
  }

  async function callLavagnaScrivi(
    memberId: string,
    args: { verb: string; text: string; to: string; replyTo: string | null; meta: Record<string, unknown> },
  ): Promise<{ ok: boolean; voceId?: string; error?: string }> {
    const reqId = randomUUID();
    send({ t: 'lavagna.scrivi', memberId, verb: args.verb as Verb, text: args.text, to: args.to, replyTo: args.replyTo, meta: args.meta, reqId });
    try {
      const result = await waitForResult<Extract<HubToWorker, { t: 'lavagna.scrivi.result' }>>(reqId, LAVAGNA_TIMEOUT_MS);
      return { ok: result.ok, voceId: result.voceId, error: result.error };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  async function callLavagnaLeggi(memberId: string, since?: string): Promise<string> {
    const reqId = randomUUID();
    send({ t: 'lavagna.leggi', memberId, reqId, since });
    try {
      const result = await waitForResult<Extract<HubToWorker, { t: 'lavagna.leggi.result' }>>(reqId, LAVAGNA_TIMEOUT_MS);
      return result.text;
    } catch (e) {
      return `(could not read the blackboard: ${String(e)})`;
    }
  }

  function startMemberSession(spec: Extract<HubToWorker, { t: 'session.start' }>['spec']): void {
    const handle = startSession(
      spec,
      {
        onItem: (item) => send({ t: 'session.item', memberId: spec.memberId, item }),
        onStatus: (status, extra) => send({ t: 'session.status', memberId: spec.memberId, status, sessionId: extra?.sessionId, error: extra?.error }),
        onUsage: (usage) => send({ t: 'session.usage', memberId: spec.memberId, usage }),
        lavagnaScrivi: (args) => callLavagnaScrivi(spec.memberId, args),
        lavagnaLeggi: (since) => callLavagnaLeggi(spec.memberId, since),
      },
      { queryFn: opts.queryFn },
    );
    sessions.set(spec.memberId, handle);
  }

  function handleMessage(msg: HubToWorker): void {
    switch (msg.t) {
      case 'hello.ok':
        connected = true;
        backoff = INITIAL_BACKOFF_MS;
        log(`connected to hub as machine ${msg.machineId}`);
        flushBuffer();
        return;
      case 'hello.rejected':
        log(`hub rejected hello: ${msg.reason}`);
        closing = true;
        ws?.close();
        return;
      case 'session.start':
        startMemberSession(msg.spec);
        return;
      case 'session.send':
        // `framed` only tells us the text is already wrapped in the blackboard frame; either
        // way there is nothing left for the worker to do but hand it to the session as a turn.
        sessions.get(msg.memberId)?.send(msg.text);
        return;
      case 'session.interrupt':
        sessions.get(msg.memberId)?.interrupt().catch((e) => log(`interrupt failed: ${String(e)}`));
        return;
      case 'session.stop': {
        const handle = sessions.get(msg.memberId);
        sessions.delete(msg.memberId);
        handle?.stop().catch((e) => log(`stop failed: ${String(e)}`));
        return;
      }
      case 'session.setModel':
        sessions.get(msg.memberId)?.setModel(msg.model).catch((e) => log(`setModel failed: ${String(e)}`));
        return;
      case 'lavagna.scrivi.result':
      case 'lavagna.leggi.result': {
        const waiter = pending.get(msg.reqId);
        if (!waiter) return;
        pending.delete(msg.reqId);
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
        return;
      }
      case 'ping':
        send({ t: 'pong' });
        return;
    }
  }

  function scheduleReconnect(): void {
    if (closing || reconnectTimer) return;
    const delay = backoff;
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect(): void {
    if (closing) return;
    const socket = new WebSocket(opts.hubUrl);
    ws = socket;
    socket.on('open', () => {
      const hello: WorkerToHub = { t: 'hello', token: opts.token, machineName: opts.machineName, claudeVersion };
      socket.send(JSON.stringify(hello));
    });
    socket.on('message', (data) => {
      let msg: HubToWorker;
      try {
        msg = JSON.parse(String(data)) as HubToWorker;
      } catch (e) {
        log(`bad message from hub: ${String(e)}`);
        return;
      }
      handleMessage(msg);
    });
    socket.on('close', () => {
      connected = false;
      if (!closing) {
        log('disconnected from hub, reconnecting');
        scheduleReconnect();
      }
    });
    socket.on('error', (e) => {
      log(`worker socket error: ${String(e)}`);
    });
  }

  function getClaudeVersion(): Promise<string | null> {
    return new Promise((resolve) => {
      execFile('claude', ['--version'], { timeout: 5000 }, (err, stdout) => {
        resolve(err ? null : stdout.trim() || null);
      });
    });
  }

  void (async () => {
    claudeVersion = await getClaudeVersion();
    connect();
  })();

  return {
    async close(): Promise<void> {
      closing = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      for (const waiter of pending.values()) clearTimeout(waiter.timer);
      pending.clear();
      await Promise.all([...sessions.values()].map((h) => h.stop()));
      sessions.clear();
      const socket = ws;
      if (socket && socket.readyState !== WebSocket.CLOSED) {
        await new Promise<void>((resolve) => {
          socket.once('close', () => resolve());
          socket.close();
        });
      }
    },
  };
}
