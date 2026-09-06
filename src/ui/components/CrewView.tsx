import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type { EffortLevel } from '../../core/types.js';
import type { AppState } from '../state.js';
import { api } from '../api.js';
import { formatCostUsd, formatRelativeTime, formatTokens, totalTokens } from '../utils.js';
import { StatusPill } from './StatusPill.js';

const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function CrewView({ state, onOpenMember }: { state: AppState; onOpenMember: (id: string) => void }): JSX.Element {
  const spent = useMemo(() => state.members.reduce((sum, m) => sum + m.usage.costUsd, 0), [state.members]);
  const budget = state.studio?.budgetUsd ?? null;
  const pct = budget && budget > 0 ? Math.min(100, (spent / budget) * 100) : 0;
  const over = budget !== null && spent > budget;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">{state.studio?.name ?? 'Studio'}</h1>
          <div className="page-sub">{state.members.length} member{state.members.length === 1 ? '' : 's'} · {state.machines.length} machine{state.machines.length === 1 ? '' : 's'}</div>
        </div>
      </div>

      {state.studio && <StudioPanel studio={state.studio} spent={spent} pct={pct} over={over} />}

      <div className="section">
        <div className="section-title">Members</div>
        {state.members.length === 0 ? (
          <div className="empty">No one has signed on yet.</div>
        ) : (
          <div className="member-grid">
            {state.members.map((m) => {
              const role = state.roles.find((r) => r.id === m.roleId);
              const machine = state.machines.find((x) => x.id === m.machineId);
              return (
                <button key={m.id} type="button" className="card member-card" onClick={() => onOpenMember(m.id)}>
                  <div className="member-card-head">
                    <span className="member-card-name">{m.name}</span>
                    <StatusPill status={m.status} />
                  </div>
                  <div className="member-card-meta">
                    {role?.label ?? m.roleId} · {machine?.name ?? m.machineId}
                  </div>
                  <div className="member-card-meta">{m.model}</div>
                  {m.error && <div className="member-card-error">{m.error}</div>}
                  <div className="member-card-stats">
                    <span>{formatCostUsd(m.usage.costUsd)}</span>
                    <span>{formatTokens(totalTokens(m.usage))} tok</span>
                    <span>{formatRelativeTime(m.lastActivityAt)}</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="section">
        <div className="section-title">Sign on</div>
        <SignOnForm state={state} onCreated={onOpenMember} />
      </div>
    </div>
  );
}

function StudioPanel({
  studio,
  spent,
  pct,
  over,
}: {
  studio: NonNullable<AppState['studio']>;
  spent: number;
  pct: number;
  over: boolean;
}): JSX.Element {
  const [goal, setGoal] = useState(studio.goal);
  const [budget, setBudget] = useState(studio.budgetUsd !== null ? String(studio.budgetUsd) : '');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  async function save(): Promise<void> {
    setSaving(true);
    try {
      const budgetUsd = budget.trim() === '' ? undefined : Number(budget);
      await api.patchStudio({ goal, budgetUsd });
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card section" style={{ padding: '14px 16px' }}>
      <div className="goal-box">
        <div className="field" style={{ flex: 1, marginBottom: 0 }}>
          <label htmlFor="goal">Goal</label>
          <textarea
            id="goal"
            value={goal}
            onChange={(e) => {
              setGoal(e.target.value);
              setDirty(true);
            }}
          />
        </div>
        <div className="field" style={{ width: 140, marginBottom: 0 }}>
          <label htmlFor="budget">Budget (USD)</label>
          <input
            id="budget"
            type="number"
            min={0}
            step="0.5"
            value={budget}
            onChange={(e) => {
              setBudget(e.target.value);
              setDirty(true);
            }}
          />
        </div>
        <button type="button" className="btn btn-primary" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      <div className="budget-bar">
        <div className={`budget-bar-fill${over ? ' over' : ''}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="budget-row">
        <span>{formatCostUsd(spent)} spent</span>
        <span>{studio.budgetUsd !== null ? `${formatCostUsd(studio.budgetUsd)} cap` : 'no cap set'}</span>
      </div>
    </div>
  );
}

function SignOnForm({ state, onCreated }: { state: AppState; onCreated: (id: string) => void }): JSX.Element {
  const onlineMachines = state.machines.filter((m) => m.status === 'online');
  const [roleId, setRoleId] = useState(state.roles[0]?.id ?? '');
  const [machineId, setMachineId] = useState(onlineMachines[0]?.id ?? '');
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<EffortLevel | ''>('');
  const [brief, setBrief] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const role = state.roles.find((r) => r.id === roleId);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!roleId || !machineId || !brief.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const member = await api.createMember({
        roleId,
        machineId,
        name: name.trim() || undefined,
        cwd: cwd.trim() || undefined,
        model: model.trim() || undefined,
        effort: effort || undefined,
        brief: brief.trim(),
      });
      setName('');
      setCwd('');
      setModel('');
      setEffort('');
      setBrief('');
      onCreated(member.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card signon-form" style={{ padding: '14px 16px' }} onSubmit={(e) => void submit(e)}>
      {error && <div className="error-banner">{error}</div>}
      <div className="field-row">
        <div className="field">
          <label htmlFor="so-role">Role</label>
          <select id="so-role" value={roleId} onChange={(e) => setRoleId(e.target.value)} required>
            {state.roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="so-machine">Machine</label>
          <select id="so-machine" value={machineId} onChange={(e) => setMachineId(e.target.value)} required>
            {onlineMachines.length === 0 && <option value="">no online machine</option>}
            {onlineMachines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="so-name">Name (optional)</label>
          <input id="so-name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={role ? `${role.label} ${state.members.filter((m) => m.roleId === role.id).length + 1}` : ''} />
        </div>
        <div className="field">
          <label htmlFor="so-cwd">Working directory (optional)</label>
          <input id="so-cwd" type="text" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder={state.studio?.roots[0] ?? '/'} />
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="so-model">Model</label>
          <input id="so-model" type="text" value={model} onChange={(e) => setModel(e.target.value)} placeholder={role?.model ?? ''} />
        </div>
        <div className="field">
          <label htmlFor="so-effort">Effort</label>
          <select id="so-effort" value={effort} onChange={(e) => setEffort(e.target.value as EffortLevel)}>
            <option value="">{role?.effort ?? 'default'}</option>
            {EFFORT_LEVELS.map((lvl) => (
              <option key={lvl} value={lvl}>
                {lvl}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="so-brief">Brief</label>
        <textarea id="so-brief" value={brief} onChange={(e) => setBrief(e.target.value)} required placeholder="What this member should do." />
      </div>
      <button type="submit" className="btn btn-primary" disabled={submitting || !roleId || !machineId}>
        {submitting ? 'Signing on…' : 'Sign on'}
      </button>
    </form>
  );
}
