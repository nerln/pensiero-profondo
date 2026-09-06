import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Dispatch, KeyboardEvent } from 'react';
import type { Member } from '../../core/types.js';
import type { AppState, UiAction } from '../state.js';
import { pendingPermissionFor } from '../state.js';
import { api } from '../api.js';
import { formatCostUsd, formatTokens } from '../utils.js';
import { StatusPill } from './StatusPill.js';
import { TranscriptRowView } from './TranscriptItemView.js';
import { buildTranscriptRows } from './transcriptRows.js';
import { PermissionPanel } from './PermissionPanel.js';

const MODEL_OPTIONS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-5'];
const SCROLL_BOTTOM_THRESHOLD = 48;

/** Seconds since the member's last transition into 'working', ticking once a second. */
function useWorkingElapsed(status: Member['status']): number {
  const startRef = useRef<number | null>(null);
  const prevRef = useRef<Member['status'] | undefined>(undefined);
  const [, tick] = useState(0);

  useEffect(() => {
    if (status === 'working' && prevRef.current !== 'working') {
      startRef.current = Date.now();
    }
    if (status !== 'working') {
      startRef.current = null;
    }
    prevRef.current = status;
  }, [status]);

  useEffect(() => {
    if (status !== 'working') return;
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [status]);

  if (status !== 'working' || startRef.current === null) return 0;
  return Math.max(0, Math.round((Date.now() - startRef.current) / 1000));
}

export function MemberView({
  state,
  dispatch,
  memberId,
  onBack,
  draft,
  onDraftChange,
}: {
  state: AppState;
  dispatch: Dispatch<UiAction>;
  memberId: string;
  onBack: () => void;
  draft: string;
  onDraftChange: (text: string) => void;
}): JSX.Element {
  const member = state.members.find((m) => m.id === memberId);
  const role = member ? state.roles.find((r) => r.id === member.roleId) : undefined;
  const machine = member ? state.machines.find((mc) => mc.id === member.machineId) : undefined;
  const items = state.transcripts[memberId] ?? [];
  const liveBuffer = state.liveBuffers[memberId];
  const pendingPermission = pendingPermissionFor(state, memberId);
  const rows = buildTranscriptRows(items, liveBuffer);

  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const workingElapsed = useWorkingElapsed(member?.status ?? 'stopped');

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

  // Leaving this member's view (back to crew, or another member) drops its live buffer: the
  // finalized transcript already has everything that landed, and a fresh view should not open
  // on a stale partial block from before.
  useEffect(() => {
    return () => {
      dispatch({ t: 'ui.clearLiveBuffer', memberId });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberId]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [rows.length, liveBuffer]);

  // Autofocus the composer whenever a member is opened.
  useEffect(() => {
    textareaRef.current?.focus();
  }, [memberId]);

  // Cmd/Ctrl+K focuses the composer from anywhere in this view.
  useEffect(() => {
    function onWindowKeyDown(e: globalThis.KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        textareaRef.current?.focus();
      }
    }
    window.addEventListener('keydown', onWindowKeyDown);
    return () => window.removeEventListener('keydown', onWindowKeyDown);
  }, []);

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
    onDraftChange('');
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
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (member && member.status !== 'stopped') void api.interruptMember(member.id);
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
        {rows.length === 0 ? (
          <div className="empty">No transcript yet.</div>
        ) : (
          rows.map((row) => <TranscriptRowView key={row.key} row={row} />)
        )}
      </div>

      {member.status === 'working' && (
        <div className="member-status-line status-working">
          <span className="status-line-dot" aria-hidden="true" /> working · {workingElapsed}s
        </div>
      )}
      {member.status === 'waiting' && (
        <div className="member-status-line status-waiting">
          <span className="status-line-dot" aria-hidden="true" /> waiting for your decision
        </div>
      )}

      {pendingPermission && <PermissionPanel request={pendingPermission} />}

      <div className="send-box">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Send a message. Enter to send, Shift+Enter for a new line, Esc to interrupt."
          disabled={member.status === 'stopped' || sending}
        />
        <button type="button" className="btn btn-primary" onClick={() => void send()} disabled={!draft.trim() || sending || member.status === 'stopped'}>
          Send
        </button>
      </div>
    </div>
  );
}
