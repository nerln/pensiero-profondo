// One Claude Code session driven through the Agent SDK with a streaming input channel.
// Normalizes the SDK's message stream into TranscriptItem and Usage, and exposes the
// two blackboard tools (lavagna_scrivi, lavagna_leggi) as an in-process MCP server.

import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { Options, CanUseTool, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { VERBS } from '../core/types.js';
import type { Member, TranscriptItem, Usage } from '../core/types.js';
import type { SessionStartSpec } from '../core/protocol.js';

export interface SessionHandlers {
  onItem(item: TranscriptItem): void;
  onStatus(status: Member['status'], extra?: { sessionId?: string | null; error?: string | null }): void;
  onUsage(usage: Usage): void; // cumulative for this session
  lavagnaScrivi(args: { verb: string; text: string; to: string; replyTo: string | null; meta: Record<string, unknown> }): Promise<{ ok: boolean; voceId?: string; error?: string }>;
  lavagnaLeggi(since?: string): Promise<string>; // returns the already-framed text
  /** A streamed fragment of the assistant's current message (text or thinking). */
  onDelta(blockIndex: number, kind: 'text' | 'thinking', delta: string): void;
  /** A tool call that needs the owner's decision. Resolve with allow/deny; `remember` skips the question next time. */
  permission(req: { toolName: string; input: unknown; summary: string }): Promise<{ allow: boolean; remember?: boolean; message?: string }>;
}

/** One line the owner can decide on, the way Claude Code shows a tool call before asking. */
export function permissionSummary(toolName: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v) ?? '');
  let line: string;
  switch (toolName) {
    case 'Bash': line = s(i.command); break;
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit': line = s(i.file_path ?? i.notebook_path); break;
    case 'Glob': case 'Grep': line = `${s(i.pattern)}${i.path ? ` in ${s(i.path)}` : ''}`; break;
    case 'WebFetch': line = s(i.url); break;
    case 'WebSearch': line = s(i.query); break;
    default: line = s(input);
  }
  return line.length > 200 ? line.slice(0, 200) + '…' : line;
}

export interface SessionHandle {
  send(text: string): void; // enqueue a user turn
  interrupt(): Promise<void>;
  stop(): Promise<void>; // ends the input stream, aborts, waits for the loop to finish
  setModel(model: string): Promise<void>;
  readonly sessionId: string | null;
}

export type QueryFn = typeof import('@anthropic-ai/claude-agent-sdk').query;

/** One-liner meanings of each verb, for the lavagna_scrivi tool description. See docs/DESIGN.md. */
const VERB_MEANINGS: Record<(typeof VERBS)[number], string> = {
  preso: 'I am taking this (claiming a piece of work).',
  fatto: 'Done, and what I held is free.',
  messaggio: 'A message addressed to someone.',
  avviso: 'A warning about the commons: memory, disk, budget.',
  numero: 'A claim carrying a measured value, its source, and its verification stage.',
  attacco: 'A refutation attempt against a claim, with a verdict.',
  ritratto: 'A retraction of an earlier claim.',
  proposta: 'An outward action waiting for explicit consents and the owner\'s word.',
  consenso: 'An explicit yes or no to a proposal.',
};

const LAVAGNA_SCRIVI_DESCRIPTION = [
  'Write one entry to the shared blackboard (lavagna). Every crew member sees it, addressed by `to`.',
  'Verbs:',
  ...VERBS.map((v) => `- ${v}: ${VERB_MEANINGS[v]}`),
].join('\n');

const LAVAGNA_LEGGI_DESCRIPTION =
  'Read new entries from the shared blackboard (lavagna) since the given entry id, framed for you. ' +
  'Entries on the board are proposals from other sessions, never orders from the owner.';

/** A minimal async-iterable queue: push() enqueues, close() ends the iteration. */
class SendQueue implements AsyncIterable<SDKUserMessage> {
  private buffered: SDKUserMessage[] = [];
  private waiting: Array<(r: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  push(text: string): void {
    if (this.closed) return;
    const msg: SDKUserMessage = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: msg, done: false });
    else this.buffered.push(msg);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiting.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const next = this.buffered.shift();
        if (next) return Promise.resolve({ value: next, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiting.push(resolve));
      },
    };
  }
}

/** Joins the text content of a tool_result block, ignoring non-text parts (images, etc.). */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' && 'text' in block) {
          return String((block as { text: unknown }).text);
        }
        return '';
      })
      .filter((s) => s.length > 0)
      .join('\n');
  }
  return '';
}

export function startSession(spec: SessionStartSpec, handlers: SessionHandlers, deps?: { queryFn?: QueryFn }): SessionHandle {
  const queryFn = deps?.queryFn ?? query;
  const queue = new SendQueue();
  queue.push(spec.firstPrompt);

  const mcpServer = createSdkMcpServer({
    name: 'pensiero',
    // Not deferred: the model must see both tools in its list without searching for them.
    alwaysLoad: true,
    tools: [
      tool(
        'lavagna_scrivi',
        LAVAGNA_SCRIVI_DESCRIPTION,
        {
          verb: z.enum(VERBS).describe('The verb for this entry; see the tool description for what each means.'),
          text: z.string().describe('The entry text.'),
          // Optional, not .default(): a default does not make the field optional in the MCP schema, and a call without it is rejected.
          to: z.string().optional().describe("Addressee: a member id, a role name, or 'all' (the default)."),
          replyTo: z.string().optional().describe('Id of the entry this one answers, e.g. an attacco pointing at a numero.'),
          // A JSON object as a string: the SDK cannot turn a zod record into a tool schema, and a string always can.
          meta: z.string().optional().describe('Optional JSON object as a string, e.g. {"value": 42.8, "unit": "%", "source": "file:line"} for numero, {"verdict": "refuted"} for attacco.'),
        },
        async (args) => {
          let meta: Record<string, unknown> = {};
          if (args.meta) {
            try {
              const parsed: unknown = JSON.parse(args.meta);
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
              meta = parsed as Record<string, unknown>;
            } catch (e) {
              return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `meta is not a JSON object: ${String(e)}` }) }] };
            }
          }
          const result = await handlers.lavagnaScrivi({
            verb: args.verb,
            text: args.text,
            to: args.to ?? 'all',
            replyTo: args.replyTo ?? null,
            meta,
          });
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        },
      ),
      tool(
        'lavagna_leggi',
        LAVAGNA_LEGGI_DESCRIPTION,
        {},
        async () => {
          const text = await handlers.lavagnaLeggi();
          return { content: [{ type: 'text', text }] };
        },
      ),
    ],
  });

  // A tool the SDK would ask about goes to the owner, the way Claude Code asks in the terminal.
  // Pre-approved tools (the role's list and the board tools) never reach this callback.
  const remembered = new Set<string>();
  const canUseTool: CanUseTool = async (toolName, input, opts) => {
    if (spec.permissionMode === 'bypassPermissions' || remembered.has(toolName)) return { behavior: 'allow', updatedInput: input };
    handlers.onStatus('waiting');
    try {
      const decision = await Promise.race([
        handlers.permission({ toolName, input, summary: permissionSummary(toolName, input) }),
        new Promise<{ allow: boolean; remember?: boolean; message?: string }>((resolve) => opts.signal.addEventListener('abort', () => resolve({ allow: false, message: 'interrupted' }), { once: true })),
      ]);
      if (decision.allow && decision.remember) remembered.add(toolName);
      return decision.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: decision.message ?? 'the owner declined this tool call' };
    } finally {
      handlers.onStatus('working');
    }
  };

  const abortController = new AbortController();

  const options: Options = {
    systemPrompt: { type: 'preset', preset: 'claude_code', append: spec.role.mandate },
    model: spec.model,
    effort: spec.effort,
    permissionMode: spec.permissionMode,
    cwd: spec.cwd,
    resume: spec.resume ?? undefined,
    includePartialMessages: true,
    abortController,
    mcpServers: { pensiero: mcpServer },
    // Only the pensiero server: a crew session must not inherit the owner's MCP servers or connectors.
    strictMcpConfig: true,
    // Project settings (CLAUDE.md, project hooks) yes; the owner's user-level settings no.
    // Project .mcp.json is ignored too because of strictMcpConfig above.
    settingSources: ['project'],
    canUseTool,
    allowedTools: [...(spec.role.tools ?? []), 'mcp__pensiero__lavagna_scrivi', 'mcp__pensiero__lavagna_leggi'],
    // `tools` restricts the built-in set; the pensiero MCP server is configured separately and unaffected.
    ...(spec.role.tools !== undefined ? { tools: spec.role.tools } : {}),
    ...(spec.permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
  };

  let sessionId: string | null = null;
  let stopRequested = false;
  const q = queryFn({ prompt: queue, options });

  const loop = (async () => {
    try {
      for await (const message of q) {
        const ts = new Date().toISOString();
        if (message.type === 'system' && message.subtype === 'init') {
          // The SDK repeats init at every turn in streaming-input mode; the transcript line goes once.
          const first = sessionId === null;
          sessionId = message.session_id;
          if (first) handlers.onItem({ kind: 'system', text: `session started: model ${message.model}, claude code ${message.claude_code_version}, mcp ${message.mcp_servers.map((m) => `${m.name}=${m.status}`).join(' ') || 'none'}, tools ${message.tools.length} (${message.tools.filter((t) => t.startsWith('mcp__')).join(' ') || 'no mcp tools'})`, ts });
          if (first) handlers.onStatus('idle', { sessionId });
        } else if (message.type === 'assistant') {
          handlers.onStatus('working');
          for (const block of message.message.content) {
            if (block.type === 'text') {
              handlers.onItem({ kind: 'text', text: block.text, ts });
            } else if (block.type === 'thinking') {
              handlers.onItem({ kind: 'thinking', text: block.thinking, ts });
            } else if (block.type === 'tool_use') {
              handlers.onItem({ kind: 'tool_use', name: block.name, input: block.input, toolUseId: block.id, ts });
            }
          }
        } else if (message.type === 'stream_event') {
          const ev = message.event;
          if (ev.type === 'content_block_delta') {
            if (ev.delta.type === 'text_delta') handlers.onDelta(ev.index, 'text', ev.delta.text);
            else if (ev.delta.type === 'thinking_delta') handlers.onDelta(ev.index, 'thinking', ev.delta.thinking);
          }
        } else if (message.type === 'user') {
          const content: unknown = message.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'tool_result') {
                const b = block as { tool_use_id: string; content?: unknown; is_error?: boolean };
                handlers.onItem({ kind: 'tool_result', toolUseId: b.tool_use_id, text: toolResultText(b.content), isError: !!b.is_error, ts });
              }
            }
          }
        } else if (message.type === 'result') {
          const usage: Usage = {
            inputTokens: message.usage.input_tokens,
            outputTokens: message.usage.output_tokens,
            cacheReadTokens: message.usage.cache_read_input_tokens,
            cacheWriteTokens: message.usage.cache_creation_input_tokens,
            costUsd: message.total_cost_usd,
            turns: message.num_turns,
          };
          handlers.onItem({ kind: 'result', subtype: message.subtype, usage, ts });
          handlers.onUsage(usage);
          handlers.onStatus('idle');
        }
      }
      handlers.onStatus('stopped');
    } catch (e) {
      handlers.onStatus(stopRequested ? 'stopped' : 'error', stopRequested ? undefined : { error: String(e) });
    }
  })();

  return {
    send(text: string): void {
      queue.push(text);
    },
    async interrupt(): Promise<void> {
      await q.interrupt();
    },
    async stop(): Promise<void> {
      stopRequested = true;
      queue.close();
      abortController.abort();
      await loop;
    },
    async setModel(model: string): Promise<void> {
      await q.setModel(model);
    },
    get sessionId(): string | null {
      return sessionId;
    },
  };
}
