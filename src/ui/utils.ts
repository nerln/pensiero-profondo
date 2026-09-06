// Small formatting helpers shared across views. No dependencies.

export function classNames(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffMs = now - then;
  const future = diffMs < 0;
  const abs = Math.abs(diffMs);
  const sec = Math.round(abs / 1000);
  if (sec < 5) return 'just now';
  if (sec < 60) return future ? `in ${sec}s` : `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return future ? `in ${min}m` : `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return future ? `in ${hr}h` : `${hr}h ago`;
  const day = Math.round(hr / 24);
  return future ? `in ${day}d` : `${day}d ago`;
}

export function formatAbsoluteLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace('T', ' ').replace('Z', ' UTC');
}

export function formatCostUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function totalTokens(u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
}

let idCounter = 0;
export function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

/** Resolves a member id to its display name; falls back to the id's first 8 characters
 *  when the member is unknown (e.g. removed since the reference was written). */
export function memberNameOrId(id: string, members: Array<{ id: string; name: string }>): string {
  const m = members.find((x) => x.id === id);
  return m ? m.name : id.slice(0, 8);
}

/** Resolves a Voce's `to` field (a member id, a role name, or 'all') for display: 'all' and
 *  role names pass through unchanged, anything else is treated as a member id. */
export function resolveAddressee(to: string, members: Array<{ id: string; name: string }>, roleNames: readonly string[]): string {
  if (to === 'all' || roleNames.includes(to)) return to;
  return memberNameOrId(to, members);
}

/** JSON.stringify that never throws (circular input, BigInt, ...) and always returns text. */
export function safeStringify(value: unknown, space?: number): string {
  try {
    return JSON.stringify(value, null, space) ?? String(value);
  } catch {
    return String(value);
  }
}

/** First `max` characters of the input as JSON, with an ellipsis when it was cut. Used as the
 *  fallback tool-call summary for tools we have no dedicated rendering for. */
export function truncateJson(input: unknown, max = 120): string {
  const s = safeStringify(input);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** One line the UI can show for a tool call, the same way Claude Code summarizes it in the
 *  terminal: the command for Bash, the path for a file tool, the pattern for a search, and so
 *  on. Falls back to the first 120 characters of the input as JSON. */
export function deriveToolSummary(name: string, input: unknown): string {
  const obj: Record<string, unknown> = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const str = (key: string): string | undefined => (typeof obj[key] === 'string' ? (obj[key] as string) : undefined);
  switch (name) {
    case 'Bash':
      return str('command') ?? truncateJson(input);
    case 'Read':
    case 'Write':
    case 'Edit':
      return str('file_path') ?? truncateJson(input);
    case 'Grep':
    case 'Glob':
      return str('pattern') ?? truncateJson(input);
    case 'WebFetch':
      return str('url') ?? truncateJson(input);
    case 'mcp__pensiero__lavagna_scrivi':
      return `board: ${str('verb') ?? '?'} → ${str('to') ?? '?'}`;
    default:
      return truncateJson(input);
  }
}

/** The first line of a possibly multi-line string, for a collapsed preview. */
export function firstLine(text: string): string {
  const idx = text.indexOf('\n');
  return idx === -1 ? text : text.slice(0, idx);
}
