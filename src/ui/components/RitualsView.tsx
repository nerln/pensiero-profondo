import type { AppState } from '../state.js';
import { AbsoluteTime } from './Time.js';

function MemberList({ ids, members }: { ids: string[]; members: AppState['members'] }): JSX.Element {
  if (ids.length === 0) return <span>none</span>;
  return (
    <>
      {ids.map((id, i) => {
        const m = members.find((mm) => mm.id === id);
        return (
          <span key={id}>
            {i > 0 && ', '}
            {m ? m.name : <span className="missing" title="member no longer present">{id}</span>}
          </span>
        );
      })}
    </>
  );
}

export function RitualsView({ state }: { state: AppState }): JSX.Element {
  const rituals = state.rituals.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Rituals</h1>
          <div className="page-sub">{rituals.length} ritual{rituals.length === 1 ? '' : 's'}</div>
        </div>
      </div>

      {rituals.length === 0 ? (
        <div className="empty">No rituals have run yet.</div>
      ) : (
        <div className="ritual-list">
          {rituals.map((r) => {
            const target = r.targetVoceId ? state.voci.find((v) => v.id === r.targetVoceId) : undefined;
            return (
              <div key={r.id} className="card ritual-card">
                <div className="ritual-head">
                  <span className="ritual-kind">{r.kind}</span>
                  <span className="ritual-status" data-status={r.status}>
                    {r.status}
                  </span>
                </div>
                {r.targetVoceId && (
                  <div className="ritual-target">{target ? target.text : `(entry ${r.targetVoceId} no longer on the board)`}</div>
                )}
                <div className="ritual-members">
                  members: <MemberList ids={r.memberIds} members={state.members} />
                </div>
                <pre className="ritual-outcome">{Object.keys(r.outcome).length > 0 ? JSON.stringify(r.outcome, null, 2) : '{}'}</pre>
                <div className="ritual-times">
                  <span>created <AbsoluteTime iso={r.createdAt} /></span>
                  <span>{r.finishedAt ? <>finished <AbsoluteTime iso={r.finishedAt} /></> : 'still running'}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
