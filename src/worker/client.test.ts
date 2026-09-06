import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { HubToWorker, WorkerToHub, SessionStartSpec } from '../core/protocol.js';
import type { Role } from '../core/types.js';

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return { ...actual, createSdkMcpServer: vi.fn(actual.createSdkMcpServer) };
});

// Imported after the mock so session.ts (used transitively by client.ts) picks up the wrapped
// createSdkMcpServer, and client.ts itself so this file's mock module registry entry is used.
const { runWorker } = await import('./client.js');
const { createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk');

type FakeQueryFn = (params: { prompt: unknown; options: unknown }) => Query;

async function waitFor(predicate: () => boolean, timeoutMs = 2000, intervalMs = 15): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** A tiny stand-in hub: accepts worker connections, records every message, and lets a test push replies. */
class FakeHub {
  readonly wss: WebSocketServer;
  readonly port: number;
  readonly sockets: WebSocket[] = [];
  readonly received: Array<{ socket: WebSocket; msg: WorkerToHub }> = [];
  private handlers: Array<(socket: WebSocket, msg: WorkerToHub) => void> = [];

  constructor() {
    this.wss = new WebSocketServer({ port: 0 });
    this.port = (this.wss.address() as AddressInfo).port;
    this.wss.on('connection', (socket) => {
      this.sockets.push(socket);
      socket.on('message', (data) => {
        const msg = JSON.parse(String(data)) as WorkerToHub;
        this.received.push({ socket, msg });
        for (const h of this.handlers) h(socket, msg);
      });
    });
  }

  onMessage(handler: (socket: WebSocket, msg: WorkerToHub) => void): void {
    this.handlers.push(handler);
  }

  url(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

/** Auto-replies hello.ok to every hello, so tests only need to script the interesting messages. */
function autoHello(hub: FakeHub, machineId = 'machine-1'): void {
  hub.onMessage((socket, msg) => {
    if (msg.t === 'hello') socket.send(JSON.stringify({ t: 'hello.ok', machineId } satisfies HubToWorker));
  });
}

const role: Role = {
  id: 'deckhand',
  name: 'deckhand',
  label: 'Deckhand',
  mandate: 'Do one bounded, verifiable job.',
  model: 'claude-sonnet-5',
  effort: 'high',
  permissionMode: 'acceptEdits',
  canPropose: false,
};

function makeSpec(overrides: Partial<SessionStartSpec> = {}): SessionStartSpec {
  return {
    memberId: 'mem-1',
    memberName: 'Deckhand 1',
    role,
    cwd: '/tmp/studio',
    model: 'claude-sonnet-5',
    effort: 'high',
    permissionMode: 'acceptEdits',
    firstPrompt: 'go',
    resume: null,
    ...overrides,
  };
}

function fakeQuery(messages: SDKMessage[]): FakeQueryFn {
  return (() => {
    async function* gen(): AsyncGenerator<SDKMessage, void> {
      for (const m of messages) yield m;
    }
    const g = gen() as unknown as Query & { interrupt: () => Promise<undefined>; setModel: () => Promise<undefined> };
    g.interrupt = async () => undefined;
    g.setModel = async () => undefined;
    return g;
  }) as unknown as FakeQueryFn;
}

function scriptedMessages(): SDKMessage[] {
  const init = {
    type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY', claude_code_version: '2.1.0',
    cwd: '/tmp/studio', tools: [], mcp_servers: [], model: 'claude-sonnet-5', permissionMode: 'acceptEdits',
    slash_commands: [], output_style: 'default', skills: [], plugins: [], uuid: 'u1', session_id: 'sess-1',
  };
  const assistant = {
    type: 'assistant',
    message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', stop_reason: null, stop_sequence: null, content: [{ type: 'text', text: 'hi', citations: null }], usage: {} },
    parent_tool_use_id: null, uuid: 'u2', session_id: 'sess-1',
  };
  const result = {
    type: 'result', subtype: 'success', duration_ms: 10, duration_api_ms: 5, is_error: false, num_turns: 1,
    result: 'done', stop_reason: 'end_turn', total_cost_usd: 0.001,
    usage: { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: {}, permission_denials: [], uuid: 'u3', session_id: 'sess-1',
  };
  return [init, assistant, result] as unknown as SDKMessage[];
}

describe('runWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('completes the hello handshake', async () => {
    const hub = new FakeHub();
    autoHello(hub);
    const logs: string[] = [];
    const worker = runWorker({ hubUrl: hub.url(), token: 'tok', machineName: 'test-machine', log: (s) => logs.push(s) });

    await waitFor(() => hub.received.some((r) => r.msg.t === 'hello'));
    const hello = hub.received.find((r) => r.msg.t === 'hello')!.msg as Extract<WorkerToHub, { t: 'hello' }>;
    expect(hello.token).toBe('tok');
    expect(hello.machineName).toBe('test-machine');
    expect(hello.claudeVersion === null || typeof hello.claudeVersion === 'string').toBe(true);
    await waitFor(() => logs.some((l) => l.includes('connected to hub')));

    await worker.close();
    await hub.close();
  });

  it('logs and stops on hello.rejected, without reconnecting', async () => {
    const hub = new FakeHub();
    hub.onMessage((socket, msg) => {
      if (msg.t === 'hello') socket.send(JSON.stringify({ t: 'hello.rejected', reason: 'bad token' } satisfies HubToWorker));
    });
    const logs: string[] = [];
    const worker = runWorker({ hubUrl: hub.url(), token: 'wrong', machineName: 'm', log: (s) => logs.push(s) });

    await waitFor(() => logs.some((l) => l.includes('rejected')));
    const helloCountBefore = hub.received.filter((r) => r.msg.t === 'hello').length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(hub.received.filter((r) => r.msg.t === 'hello').length).toBe(helloCountBefore);

    await worker.close();
    await hub.close();
  });

  it('starts a session on session.start and relays items and status back to the hub', async () => {
    const hub = new FakeHub();
    autoHello(hub);
    const events: WorkerToHub[] = [];
    hub.onMessage((socket, msg) => {
      if (msg.t !== 'hello') events.push(msg);
    });

    const queryFn = fakeQuery(scriptedMessages());
    const worker = runWorker({ hubUrl: hub.url(), token: 'tok', machineName: 'm', queryFn: queryFn as never, log: () => {} });
    await waitFor(() => hub.sockets.length > 0 && hub.received.some((r) => r.msg.t === 'hello'));

    hub.sockets[0]!.send(JSON.stringify({ t: 'session.start', spec: makeSpec() } satisfies HubToWorker));
    await waitFor(() => events.some((e) => e.t === 'session.item' && e.item.kind === 'result'));

    const statuses = events.filter((e): e is Extract<WorkerToHub, { t: 'session.status' }> => e.t === 'session.status').map((e) => e.status);
    expect(statuses).toEqual(expect.arrayContaining(['idle', 'working']));

    const items = events.filter((e): e is Extract<WorkerToHub, { t: 'session.item' }> => e.t === 'session.item');
    expect(items.some((e) => e.item.kind === 'text' && (e.item as { text: string }).text === 'hi')).toBe(true);
    expect(items.every((e) => e.memberId === 'mem-1')).toBe(true);

    const usageMsg = events.find((e): e is Extract<WorkerToHub, { t: 'session.usage' }> => e.t === 'session.usage');
    expect(usageMsg?.usage).toEqual({ inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001, turns: 1 });

    await worker.close();
    await hub.close();
  });

  it('round-trips lavagna_scrivi through the hub with a fresh reqId', async () => {
    const hub = new FakeHub();
    autoHello(hub);
    hub.onMessage((socket, msg) => {
      if (msg.t === 'lavagna.scrivi') {
        socket.send(JSON.stringify({ t: 'lavagna.scrivi.result', reqId: msg.reqId, ok: true, voceId: 'v-42' } satisfies HubToWorker));
      }
    });

    // A session whose generator never yields: enough to register the MCP tools and their
    // handlers, which is all this test needs to reach into.
    const queryFn = fakeQuery([]);
    const worker = runWorker({ hubUrl: hub.url(), token: 'tok', machineName: 'm', queryFn: queryFn as never, log: () => {} });
    await waitFor(() => hub.sockets.length > 0 && hub.received.some((r) => r.msg.t === 'hello'));

    hub.sockets[0]!.send(JSON.stringify({ t: 'session.start', spec: makeSpec() } satisfies HubToWorker));
    await waitFor(() => (createSdkMcpServer as unknown as Mock).mock.calls.length > 0);

    const serverOptions = (createSdkMcpServer as unknown as Mock).mock.calls.at(-1)![0] as {
      tools: Array<{ name: string; handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ type: string; text: string }> }> }>;
    };
    const scrivi = serverOptions.tools.find((t) => t.name === 'lavagna_scrivi')!;
    const result = await scrivi.handler({ verb: 'numero', text: 'x=1', to: 'all' }, {});
    expect(JSON.parse(result.content[0]!.text)).toEqual({ ok: true, voceId: 'v-42' });

    const scriviMsg = hub.received.find((r) => r.msg.t === 'lavagna.scrivi')?.msg as Extract<WorkerToHub, { t: 'lavagna.scrivi' }> | undefined;
    expect(scriviMsg).toBeDefined();
    expect(scriviMsg).toMatchObject({ memberId: 'mem-1', verb: 'numero', text: 'x=1', to: 'all', replyTo: null, meta: {} });
    expect(typeof scriviMsg!.reqId).toBe('string');
    expect(scriviMsg!.reqId.length).toBeGreaterThan(0);

    await worker.close();
    await hub.close();
  });

  it('reconnects with backoff after the hub connection drops, buffering events started sessions still emit', async () => {
    const hub = new FakeHub();
    let helloCount = 0;
    hub.onMessage((socket, msg) => {
      if (msg.t === 'hello') {
        helloCount += 1;
        socket.send(JSON.stringify({ t: 'hello.ok', machineId: 'machine-1' } satisfies HubToWorker));
      }
    });
    const logs: string[] = [];
    const worker = runWorker({ hubUrl: hub.url(), token: 'tok', machineName: 'm', log: (s) => logs.push(s) });

    await waitFor(() => helloCount === 1);
    hub.sockets[0]!.close();
    await waitFor(() => logs.some((l) => l.includes('disconnected')));
    await waitFor(() => helloCount === 2, 3000);

    await worker.close();
    await hub.close();
  }, 8000);
});
