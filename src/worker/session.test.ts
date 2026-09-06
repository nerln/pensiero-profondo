import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SessionStartSpec } from '../core/protocol.js';
import type { Member, Role, TranscriptItem, Usage } from '../core/types.js';

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return { ...actual, createSdkMcpServer: vi.fn(actual.createSdkMcpServer) };
});

// Imported after the mock so startSession picks up the wrapped createSdkMcpServer.
const { startSession } = await import('./session.js');
const { createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk');

function wait(ms = 15): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const role: Role = {
  id: 'lookout',
  name: 'lookout',
  label: 'Lookout',
  mandate: 'Attack the claim you are given.',
  model: 'claude-sonnet-5',
  effort: 'high',
  tools: ['Read', 'Grep'],
  permissionMode: 'dontAsk',
  canPropose: false,
};

const spec: SessionStartSpec = {
  memberId: 'm1',
  memberName: 'Lookout 1',
  role,
  cwd: '/tmp/studio',
  model: 'claude-sonnet-5',
  effort: 'high',
  permissionMode: 'dontAsk',
  firstPrompt: 'go attack claim v1',
  resume: null,
};

function scriptedMessages(): SDKMessage[] {
  const init = {
    type: 'system',
    subtype: 'init',
    apiKeySource: 'ANTHROPIC_API_KEY',
    claude_code_version: '2.1.0',
    cwd: '/tmp/studio',
    tools: [],
    mcp_servers: [],
    model: 'claude-sonnet-5',
    permissionMode: 'dontAsk',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    uuid: 'uuid-init',
    session_id: 'sess-123',
  };
  const assistant = {
    type: 'assistant',
    message: {
      id: 'msg-1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      stop_reason: null,
      stop_sequence: null,
      content: [
        { type: 'text', text: 'Looking into it.', citations: null },
        { type: 'thinking', thinking: 'let me check the file', signature: 'sig' },
        { type: 'tool_use', id: 'tool-1', name: 'lavagna_scrivi', input: { verb: 'attacco', text: 'refuted', to: 'all' } },
      ],
      usage: {},
    },
    parent_tool_use_id: null,
    uuid: 'uuid-assistant',
    session_id: 'sess-123',
  };
  const userToolResult = {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: [{ type: 'text', text: 'ok: voceId v1' }], is_error: false }],
    },
    parent_tool_use_id: null,
  };
  const result = {
    type: 'result',
    subtype: 'success',
    duration_ms: 1200,
    duration_api_ms: 900,
    is_error: false,
    num_turns: 1,
    result: 'done',
    stop_reason: 'end_turn',
    total_cost_usd: 0.0123,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
    modelUsage: {},
    permission_denials: [],
    uuid: 'uuid-result',
    session_id: 'sess-123',
  };
  return [init, assistant, userToolResult, result] as unknown as SDKMessage[];
}

/** A fake queryFn: ignores the pushed prompt content and replays a scripted message sequence. */
function fakeQueryFn(messages: SDKMessage[]) {
  const interrupt = vi.fn(async () => undefined);
  const setModel = vi.fn(async () => undefined);
  const calls: Array<{ prompt: AsyncIterable<SDKUserMessage>; options: Options }> = [];
  const queryFn = ((params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => {
    calls.push({ prompt: params.prompt as AsyncIterable<SDKUserMessage>, options: params.options as Options });
    async function* gen(): AsyncGenerator<SDKMessage, void> {
      for (const m of messages) yield m;
    }
    const g = gen() as unknown as Query & { interrupt: typeof interrupt; setModel: typeof setModel };
    g.interrupt = interrupt;
    g.setModel = setModel;
    return g;
  }) as unknown as typeof import('@anthropic-ai/claude-agent-sdk').query;
  return { queryFn, interrupt, setModel, calls };
}

function makeHandlers() {
  const items: TranscriptItem[] = [];
  const statuses: Array<{ status: Member['status']; extra?: { sessionId?: string | null; error?: string | null } }> = [];
  const usages: Usage[] = [];
  return {
    items,
    statuses,
    usages,
    onItem: (item: TranscriptItem) => items.push(item),
    onStatus: (status: Member['status'], extra?: { sessionId?: string | null; error?: string | null }) => statuses.push({ status, extra }),
    onUsage: (usage: Usage) => usages.push(usage),
    lavagnaScrivi: vi.fn(async () => ({ ok: true, voceId: 'v1' })),
    lavagnaLeggi: vi.fn(async () => 'nothing new'),
    onDelta: vi.fn(),
    permission: vi.fn(async () => ({ allow: true })),
  };
}

describe('startSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('normalizes the message stream into TranscriptItem, status and usage', async () => {
    const { queryFn, calls } = fakeQueryFn(scriptedMessages());
    const handlers = makeHandlers();
    const handle = startSession(spec, handlers, { queryFn });
    await wait();

    const kinds = handlers.items.map((i) => i.kind);
    expect(kinds).toEqual(['system', 'text', 'thinking', 'tool_use', 'tool_result', 'result']);

    const systemItem = handlers.items[0] as Extract<TranscriptItem, { kind: 'system' }>;
    expect(systemItem.text).toContain('claude-sonnet-5');
    expect(systemItem.text).toContain('2.1.0');

    const textItem = handlers.items[1] as Extract<TranscriptItem, { kind: 'text' }>;
    expect(textItem.text).toBe('Looking into it.');

    const thinkingItem = handlers.items[2] as Extract<TranscriptItem, { kind: 'thinking' }>;
    expect(thinkingItem.text).toBe('let me check the file');

    const toolUseItem = handlers.items[3] as Extract<TranscriptItem, { kind: 'tool_use' }>;
    expect(toolUseItem.name).toBe('lavagna_scrivi');
    expect(toolUseItem.toolUseId).toBe('tool-1');
    expect(toolUseItem.input).toEqual({ verb: 'attacco', text: 'refuted', to: 'all' });

    const toolResultItem = handlers.items[4] as Extract<TranscriptItem, { kind: 'tool_result' }>;
    expect(toolResultItem.toolUseId).toBe('tool-1');
    expect(toolResultItem.text).toBe('ok: voceId v1');
    expect(toolResultItem.isError).toBe(false);

    const resultItem = handlers.items[5] as Extract<TranscriptItem, { kind: 'result' }>;
    expect(resultItem.subtype).toBe('success');
    expect(resultItem.usage).toEqual({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5, costUsd: 0.0123, turns: 1 });

    expect(handlers.statuses.map((s) => s.status)).toEqual(['idle', 'working', 'idle', 'stopped']);
    expect(handlers.statuses[0].extra?.sessionId).toBe('sess-123');

    expect(handlers.usages).toEqual([{ inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5, costUsd: 0.0123, turns: 1 }]);

    expect(handle.sessionId).toBe('sess-123');

    // The first prompt was pushed before consumption started.
    const promptIter = calls[0].prompt[Symbol.asyncIterator]();
    const first = await promptIter.next();
    expect(first.done).toBe(false);
    expect(first.value).toEqual({ type: 'user', message: { role: 'user', content: 'go attack claim v1' }, parent_tool_use_id: null });

    // send() pushes another turn onto the same queue.
    handle.send('a follow-up turn');
    const second = await promptIter.next();
    expect(second.value?.message).toEqual({ role: 'user', content: 'a follow-up turn' });
  });

  it('passes the model, effort, permission mode, cwd, tools and mandate through to Options', async () => {
    const { queryFn, calls } = fakeQueryFn(scriptedMessages());
    const handlers = makeHandlers();
    startSession(spec, handlers, { queryFn });
    await wait();

    const options = calls[0].options;
    expect(options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: role.mandate });
    expect(options.model).toBe('claude-sonnet-5');
    expect(options.effort).toBe('high');
    expect(options.permissionMode).toBe('dontAsk');
    expect(options.cwd).toBe('/tmp/studio');
    expect(options.allowedTools).toEqual(['Read', 'Grep', 'mcp__ciurma__lavagna_scrivi', 'mcp__ciurma__lavagna_leggi']);
    expect(options.resume).toBeUndefined();
    expect(options.includePartialMessages).toBe(true);
    expect(options.tools).toEqual(['Read', 'Grep']);
    expect(options.mcpServers?.ciurma).toBeDefined();
  });

  it('sets allowDangerouslySkipPermissions only for bypassPermissions', async () => {
    const { queryFn: q1, calls: c1 } = fakeQueryFn(scriptedMessages());
    startSession({ ...spec, permissionMode: 'bypassPermissions' }, makeHandlers(), { queryFn: q1 });
    await wait();
    expect(c1[0].options.allowDangerouslySkipPermissions).toBe(true);

    const { queryFn: q2, calls: c2 } = fakeQueryFn(scriptedMessages());
    startSession(spec, makeHandlers(), { queryFn: q2 });
    await wait();
    expect(c2[0].options.allowDangerouslySkipPermissions).toBeUndefined();
  });

  it('canUseTool asks the owner through handlers.permission and honours the answer', async () => {
    const { queryFn, calls } = fakeQueryFn(scriptedMessages());
    const handlers = makeHandlers();
    handlers.permission = vi.fn(async (req: { toolName: string; summary: string }) => (req.toolName === 'Bash' ? { allow: true } : { allow: false, message: 'no' }));
    const statuses: string[] = [];
    handlers.onStatus = (st) => statuses.push(st);
    startSession(spec, handlers, { queryFn });
    await wait();
    const ctx = { signal: new AbortController().signal, toolUseID: 't1', requestId: 'r1' };
    expect(await calls[0].options.canUseTool?.('Bash', { command: 'ls -la' }, ctx)).toEqual({ behavior: 'allow', updatedInput: { command: 'ls -la' } });
    expect(handlers.permission).toHaveBeenCalledWith({ toolName: 'Bash', input: { command: 'ls -la' }, summary: 'ls -la' });
    expect(await calls[0].options.canUseTool?.('WebFetch', { url: 'https://x' }, ctx)).toEqual({ behavior: 'deny', message: 'no' });
    expect(statuses).toContain('waiting');
  });

  it('canUseTool remembers an allow-and-remember, and never asks under bypassPermissions', async () => {
    const { queryFn, calls } = fakeQueryFn(scriptedMessages());
    const handlers = makeHandlers();
    handlers.permission = vi.fn(async () => ({ allow: true, remember: true }));
    startSession(spec, handlers, { queryFn });
    await wait();
    const ctx = { signal: new AbortController().signal, toolUseID: 't1', requestId: 'r1' };
    await calls[0].options.canUseTool?.('Bash', { command: 'a' }, ctx);
    await calls[0].options.canUseTool?.('Bash', { command: 'b' }, ctx);
    expect(handlers.permission).toHaveBeenCalledTimes(1);

    const { queryFn: q2, calls: c2 } = fakeQueryFn(scriptedMessages());
    const h2 = makeHandlers();
    startSession({ ...spec, permissionMode: 'bypassPermissions' }, h2, { queryFn: q2 });
    await wait();
    await c2[0].options.canUseTool?.('Bash', { command: 'a' }, ctx);
    expect(h2.permission).not.toHaveBeenCalled();
  });

  it('registers exactly two MCP tools, lavagna_scrivi and lavagna_leggi, wired to the handlers', async () => {
    const { queryFn } = fakeQueryFn(scriptedMessages());
    const handlers = makeHandlers();
    startSession(spec, handlers, { queryFn });
    await wait();

    const mockCreate = createSdkMcpServer as unknown as Mock;
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const serverOptions = mockCreate.mock.calls[0][0] as { name: string; tools: Array<{ name: string; description: string; handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ type: string; text: string }> }> }> };
    expect(serverOptions.name).toBe('ciurma');
    expect(serverOptions.tools.map((t) => t.name)).toEqual(['lavagna_scrivi', 'lavagna_leggi']);
    for (const t of serverOptions.tools) expect(t.description.length).toBeGreaterThan(0);

    const scrivi = serverOptions.tools[0];
    const scriviResult = await scrivi.handler({ verb: 'numero', text: 'x=1', to: 'all' }, {});
    expect(handlers.lavagnaScrivi).toHaveBeenCalledWith({ verb: 'numero', text: 'x=1', to: 'all', replyTo: null, meta: {} });
    expect(scriviResult.content[0]).toEqual({ type: 'text', text: JSON.stringify({ ok: true, voceId: 'v1' }) });

    const leggi = serverOptions.tools[1];
    const leggiResult = await leggi.handler({}, {});
    expect(handlers.lavagnaLeggi).toHaveBeenCalledTimes(1);
    expect(leggiResult.content[0]).toEqual({ type: 'text', text: 'nothing new' });
  });

  it('interrupt() and setModel() call through to the underlying Query', async () => {
    const { queryFn, interrupt, setModel } = fakeQueryFn(scriptedMessages());
    const handle = startSession(spec, makeHandlers(), { queryFn });
    await wait();
    await handle.interrupt();
    expect(interrupt).toHaveBeenCalledTimes(1);
    await handle.setModel('claude-opus-4-8');
    expect(setModel).toHaveBeenCalledWith('claude-opus-4-8');
  });

  it('stop() ends the input stream and resolves once the loop finishes', async () => {
    const { queryFn } = fakeQueryFn(scriptedMessages());
    const handlers = makeHandlers();
    const handle = startSession(spec, handlers, { queryFn });
    await wait();
    await handle.stop();
    expect(handlers.statuses.at(-1)?.status).toBe('stopped');
  });

  it('reports status error when the generator throws', async () => {
    const boom = new Error('boom');
    const queryFn = (() => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        throw boom;
      }
      const g = gen() as unknown as Query & { interrupt: () => Promise<undefined>; setModel: () => Promise<undefined> };
      g.interrupt = async () => undefined;
      g.setModel = async () => undefined;
      return g;
    }) as unknown as typeof import('@anthropic-ai/claude-agent-sdk').query;
    const handlers = makeHandlers();
    startSession(spec, handlers, { queryFn });
    await wait();
    expect(handlers.statuses.at(-1)).toEqual({ status: 'error', extra: { error: String(boom) } });
  });
});
