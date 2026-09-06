import { memo, useMemo, useState } from 'react';
import type { Author, Verb, Verdict, Voce } from '../../core/types.js';
import { VERBS } from '../../core/types.js';
import type { AppState } from '../state.js';
import { api } from '../api.js';
import { AbsoluteTime } from './Time.js';
import { VerbTag, VerdictTag } from './Tag.js';

const OWNER_VERBS: Verb[] = ['messaggio', 'avviso', 'consenso', 'proposta'];

function authorKey(a: Author): string {
  return a.kind === 'member' ? `member:${a.memberId}` : a.kind;
}

function authorLabel(a: Author): string {
  if (a.kind === 'owner') return 'Owner';
  if (a.kind === 'hub') return 'Hub';
  return a.memberName;
}

interface ClaimStageInfo {
  label: string;
}

function claimStage(voce: Voce, all: Voce[]): ClaimStageInfo {
  const replies = all.filter((v) => v.replyTo === voce.id);
  if (replies.some((v) => v.verb === 'ritratto')) return { label: 'retracted' };
  const attacks = replies.filter((v) => v.verb === 'attacco');
  if (attacks.length === 0) return { label: 'declared' };
  const count = (verdict: Verdict) => attacks.filter((v) => v.meta.verdict === verdict).length;
  const refuted = count('refuted');
  const holds = count('holds');
  const undecidable = count('undecidable');
  const parts = [`${refuted} refuted`, `${holds} holds`];
  if (undecidable > 0) parts.push(`${undecidable} undecidable`);
  return { label: `attacked: ${parts.join(', ')}` };
}

interface VoceTreeNode {
  voce: Voce;
  children: VoceTreeNode[];
}

function buildTree(list: Voce[]): VoceTreeNode[] {
  const ids = new Set(list.map((v) => v.id));
  const byParent = new Map<string, Voce[]>();
  const roots: Voce[] = [];
  for (const v of list) {
    if (v.replyTo && ids.has(v.replyTo)) {
      const arr = byParent.get(v.replyTo) ?? [];
      arr.push(v);
      byParent.set(v.replyTo, arr);
    } else {
      roots.push(v);
    }
  }
  const byId = new Map(list.map((v) => [v.id, v] as const));
  function toNode(v: Voce): VoceTreeNode {
    const kids = (byParent.get(v.id) ?? [])
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((c) => toNode(byId.get(c.id) ?? c));
    return { voce: v, children: kids };
  }
  return roots
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(toNode);
}

export function BoardView({ state, onOpenMember }: { state: AppState; onOpenMember: (id: string) => void }): JSX.Element {
  const [verbFilter, setVerbFilter] = useState<Verb | 'all'>('all');
  const [authorFilter, setAuthorFilter] = useState<string>('all');
  const [toMeOnly, setToMeOnly] = useState(false);
  const [replyTo, setReplyTo] = useState<Voce | null>(null);

  const authors = useMemo(() => {
    const map = new Map<string, string>();
    for (const v of state.voci) map.set(authorKey(v.author), authorLabel(v.author));
    return Array.from(map.entries());
  }, [state.voci]);

  const filtered = useMemo(() => {
    return state.voci.filter((v) => {
      if (verbFilter !== 'all' && v.verb !== verbFilter) return false;
      if (authorFilter !== 'all' && authorKey(v.author) !== authorFilter) return false;
      if (toMeOnly && v.to !== 'owner') return false;
      return true;
    });
  }, [state.voci, verbFilter, authorFilter, toMeOnly]);

  const tree = useMemo(() => buildTree(filtered), [filtered]);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Board</h1>
          <div className="page-sub">{state.voci.length} entries</div>
        </div>
      </div>

      <div className="board-filters">
        <select value={verbFilter} onChange={(e) => setVerbFilter(e.target.value as Verb | 'all')}>
          <option value="all">all verbs</option>
          {VERBS.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <select value={authorFilter} onChange={(e) => setAuthorFilter(e.target.value)}>
          <option value="all">all authors</option>
          {authors.map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <label className="checkbox-field">
          <input type="checkbox" checked={toMeOnly} onChange={(e) => setToMeOnly(e.target.checked)} />
          addressed to me (owner)
        </label>
      </div>

      <ComposeBox replyTo={replyTo} onClearReply={() => setReplyTo(null)} />

      <div className="voce-feed">
        {tree.length === 0 ? (
          <div className="empty">No entries match this filter.</div>
        ) : (
          tree.map((node) => (
            <VoceNode
              key={node.voce.id}
              node={node}
              depth={0}
              allVoci={state.voci}
              members={state.members}
              onOpenMember={onOpenMember}
              onReply={setReplyTo}
            />
          ))
        )}
      </div>
    </div>
  );
}

function VoceNode({
  node,
  depth,
  allVoci,
  members,
  onOpenMember,
  onReply,
}: {
  node: VoceTreeNode;
  depth: number;
  allVoci: Voce[];
  members: AppState['members'];
  onOpenMember: (id: string) => void;
  onReply: (voce: Voce) => void;
}): JSX.Element {
  return (
    <>
      <VoceItem voce={node.voce} depth={depth} allVoci={allVoci} members={members} onOpenMember={onOpenMember} onReply={onReply} />
      {node.children.map((child) => (
        <VoceNode key={child.voce.id} node={child} depth={depth + 1} allVoci={allVoci} members={members} onOpenMember={onOpenMember} onReply={onReply} />
      ))}
    </>
  );
}

const VoceItem = memo(function VoceItem({
  voce,
  depth,
  allVoci,
  members,
  onOpenMember,
  onReply,
}: {
  voce: Voce;
  depth: number;
  allVoci: Voce[];
  members: AppState['members'];
  onOpenMember: (id: string) => void;
  onReply: (voce: Voce) => void;
}): JSX.Element {
  const isMember = voce.author.kind === 'member';
  const memberExists = isMember && members.some((m) => m.id === (voce.author as Extract<Author, { kind: 'member' }>).memberId);
  const stage = voce.verb === 'numero' ? claimStage(voce, allVoci) : null;
  const [ritualRunning, setRitualRunning] = useState(false);

  async function attack(): Promise<void> {
    setRitualRunning(true);
    try {
      await api.attackRitual({ voceId: voce.id, n: 3 });
    } finally {
      setRitualRunning(false);
    }
  }

  return (
    <div className={`card voce${depth > 0 ? ' is-reply' : ''}`} style={depth > 0 ? { marginLeft: depth * 26 } : undefined}>
      <div className="voce-head">
        <VerbTag verb={voce.verb} />
        {memberExists ? (
          <button
            type="button"
            className="voce-author"
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text)' }}
            onClick={() => onOpenMember((voce.author as Extract<Author, { kind: 'member' }>).memberId)}
          >
            {authorLabel(voce.author)}
          </button>
        ) : (
          <span className="voce-author">{authorLabel(voce.author)}</span>
        )}
        {voce.author.kind === 'member' && <span className="voce-author-role">{voce.author.role} · {voce.author.machine}</span>}
        <span className="voce-spacer" />
        <span className="voce-to">to {voce.to}</span>
        <AbsoluteTime iso={voce.createdAt} />
      </div>
      <div className="voce-text">{voce.text}</div>
      {voce.verb === 'numero' && (
        <div className="voce-meta">
          {typeof voce.meta.value !== 'undefined' && <span className="value">{String(voce.meta.value)}</span>}
          {typeof voce.meta.unit === 'string' && <span>{voce.meta.unit}</span>}
          {typeof voce.meta.source === 'string' && <span>· {voce.meta.source}</span>}
          {stage && <span className="claim-stage">{stage.label}</span>}
        </div>
      )}
      {voce.verb === 'attacco' && typeof voce.meta.verdict === 'string' && (
        <div className="voce-meta">
          <VerdictTag verdict={voce.meta.verdict as Verdict} />
        </div>
      )}
      <div className="voce-actions">
        <button type="button" className="btn btn-small" onClick={() => onReply(voce)}>
          Reply
        </button>
        {voce.verb === 'numero' && (
          <button type="button" className="btn btn-small" onClick={() => void attack()} disabled={ritualRunning}>
            {ritualRunning ? 'Attacking…' : 'Attack'}
          </button>
        )}
      </div>
    </div>
  );
});

function ComposeBox({ replyTo, onClearReply }: { replyTo: Voce | null; onClearReply: () => void }): JSX.Element {
  const [verb, setVerb] = useState<Verb>('messaggio');
  const [text, setText] = useState('');
  const [to, setTo] = useState('all');
  const [posting, setPosting] = useState(false);

  async function submit(): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    setPosting(true);
    try {
      await api.postVoce({ verb, text: trimmed, to: to.trim() || 'all', replyTo: replyTo?.id ?? null });
      setText('');
      onClearReply();
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className="card compose-box">
      {replyTo && (
        <div className="page-sub" style={{ marginBottom: 8 }}>
          Replying to <strong>{authorLabel(replyTo.author)}</strong>: "{replyTo.text.slice(0, 80)}
          {replyTo.text.length > 80 ? '…' : ''}"{' '}
          <button type="button" className="btn btn-small" onClick={onClearReply}>
            clear
          </button>
        </div>
      )}
      <div className="field-row">
        <div className="field" style={{ maxWidth: 160 }}>
          <label htmlFor="cx-verb">Verb</label>
          <select id="cx-verb" value={verb} onChange={(e) => setVerb(e.target.value as Verb)}>
            {OWNER_VERBS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ maxWidth: 200 }}>
          <label htmlFor="cx-to">To</label>
          <input id="cx-to" type="text" value={to} onChange={(e) => setTo(e.target.value)} placeholder="all" />
        </div>
      </div>
      <div className="field">
        <label htmlFor="cx-text">Text</label>
        <textarea id="cx-text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Write on the board." />
      </div>
      <button type="button" className="btn btn-primary" disabled={!text.trim() || posting} onClick={() => void submit()}>
        {posting ? 'Posting…' : 'Post'}
      </button>
    </div>
  );
}
