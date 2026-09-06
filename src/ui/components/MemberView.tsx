import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Dispatch, KeyboardEvent } from 'react';
import type { AppState, UiAction } from '../state.js';
import { api } from '../api.js';
import { formatCostUsd, formatTokens } from '../utils.js';
import { StatusPill } from './StatusPill.js';
import { TranscriptItemView } from './TranscriptItemView.js';

const MODEL_OPTIONS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-5'];
const SCROLL_BOTTOM_THRESHOLD = 48;

export function MemberView({
  state,
  dispatch,
  memberId,
  onBack,
}: {
  state: AppState;
  dispatch: Dispatch<UiAction>;
  memberId: string;
  onBack: () => void;
}): JSX.Element {
  const member = state.members.find((m) => m.id === memberId);
  const role = member ? state.roles.find((r) => r.id === member.roleId) : undefined;
  const machine = member ? state.machines.find((mc) => mc.id === member.machineId) : undefined;
  const items = state.transcripts[memberId] ?? [];

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    let cancelled = false;
    api
      .getTranscript(memberId)
      .then((loaded) => {
        if (!cancelled) dispatch({ t: 'ui.transcriptLoaded', memberId, items: loaded });
      })
      .catch((err: unknown) => {
        if (!cancelled) dispatch({ t: 'error', message: `Failed to load transcript: ${err instanceof Error ? err.message : String(err)}` });
      });
    return () => {
      cancelled = true;
    };
    // dispatch is stable; memberId is the real dependency
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberId]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [items.length]);

  function onScroll(): void {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom.current = distanceFromBottom < SCROLL_BOTTOM_THRESHOLD;
  }

  async function send(): Promise<void> {
    const text = draft.trim();
    if (!text || !member) return;
    setSending(true);
    setDraft('');
    stickToBottom.current = true;
    try {
      await api.sendToMember(member.id, text);
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  if (!member) {
    return (
      <div>
        <button type="button" className="back-link" onClick={onBack}>
          ← Back to crew
        </button>
        <div className="empty">This member is no longer around.</div>
      </div>
    );
  }

  const u = member.usage;

  return (
    <div>
      <button type="button" className="back-link" onClick={onBack}>
        ← Back to crew
      </button>
      <div className="member-header">
        <div>
          <h1 className="page-title">{member.name}</h1>
          <div className="page-sub">
            {role?.label ?? member.roleId} · {machine?.name ?? member.machineId} · {member.cwd}
          </div>
          <div className="member-usage-row">
            <StatusPill status={member.status} />
            <span>{formatCostUsd(u.costUsd)}</span>
            <span>{formatTokens(u.inputTokens)} in / {formatTokens(u.outputTokens)} out</span>
            <span>{formatTokens(u.cacheReadTokens)} cache read / {formatTokens(u.cacheWriteTokens)} cache write</span>
            <span>{u.turns} turn{u.turns === 1 ? '' : 's'}</span>
          </div>
          {member.error && <div className="member-card-error" style={{ marginTop: 6 }}>{member.error}</div>}
        </div>
        <div className="member-header-controls">
          <select value={member.model} onChange={(e) => void api.setMemberModel(member.id, e.target.value)}>
            {(MODEL_OPTIONS.includes(member.model) ? MODEL_OPTIONS : [member.model, ...MODEL_OPTIONS]).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <button type="button" className="btn" onClick={() => void api.interruptMember(member.id)} disabled={member.status === 'stopped'}>
            Interrupt
          </button>
          <button type="button" className="btn btn-danger" onClick={() => void api.stopMember(member.id)} disabled={member.status === 'stopped'}>
            Stop
          </button>
        </div>
      </div>

      <div className="transcript" ref={scrollRef} onScroll={onScroll} style={{ maxHeight: 'calc(100vh - 320px)', overflowY: 'auto', paddingRight: 4 }}>
        {items.length === 0 ? (
          <div className="empty">No transcript yet.</div>
        ) : (
          items.map((item, i) => <TranscriptItemView key={`${item.kind}-${item.ts}-${i}`} item={item} />)
        )}
      </div>

      <div className="send-box">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Send a message. Enter to send, Shift+Enter for a new line."
          disabled={member.status === 'stopped' || sending}
        />
        <button type="button" className="btn btn-primary" onClick={() => void send()} disabled={!draft.trim() || sending || member.status === 'stopped'}>
          Send
        </button>
      </div>
    </div>
  );
}
