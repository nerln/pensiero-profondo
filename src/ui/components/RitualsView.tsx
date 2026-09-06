import type { AppState } from '../state.js';
import { memberNameOrId } from '../utils.js';
import { AbsoluteTime } from './Time.js';

function MemberList({ ids, members }: { ids: string[]; members: AppState['members'] }): JSX.Element {
  if (ids.length === 0) return <span>none</span>;
  return (
    <>
      {ids.map((id, i) => {
        const known = members.some((mm) => mm.id === id);
        return (
          <span key={id}>
            {i > 0 && ', '}
            {known ? memberNameOrId(id, members) : (
              <span className="missing" title="member no longer present">{memberNameOrId(id, members)}</span>
            )}
          </span>
        );
      })}
    </>
  );
}

function num(outcome: Record<string, unknown>, key: string): number {
  const v = outcome[key];
  return typeof v === 'number' ? v : 0;
}

/** Words rendering of an attack ritual's outcome, plus a survives/refuted chip when the ritual
 *  has settled. Kept separate from the raw JSON, which stays available in a collapsed details. */
function AttackOutcome({ outcome }: { outcome: Record<string, unknown> }): JSX.Element {
  const refuted = num(outcome, 'refuted');
  const holds = num(outcome, 'holds');
  const undecidable = num(outcome, 'undecidable');
  const pending = num(outcome, 'pending');
  const survives = outcome.survives;
  return (
    <div className="ritual-outcome-words">
      <span>
        {refuted} refuted, {holds} hold, {undecidable} undecidable, {pending} pending
      </span>
      {typeof survives === 'boolean' && (
        <span className="outcome-chip" data-survives={survives}>
          {survives ? 'claim survives' : 'claim refuted'}
        </span>
      )}
    </div>
  );
}

export function RitualsView({ state, onShowOnBoard }: { state: AppState; onShowOnBoard: () => void }): JSX.Element {
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
                  <div className="ritual-target">
                    {target ? (
                      <>
                        {target.text.slice(0, 120)}
                        {target.text.length > 120 ? '…' : ''}{' '}
                        <button type="button" className="back-link" onClick={onShowOnBoard}>
                          show on board
                        </button>
                      </>
                    ) : (
                      `(entry ${r.targetVoceId} no longer on the board)`
                    )}
                  </div>
                )}
                <div className="ritual-members">
                  members: <MemberList ids={r.memberIds} members={state.members} />
                </div>
                {r.kind === 'attack' && <AttackOutcome outcome={r.outcome} />}
                <details className="ritual-outcome-raw">
                  <summary>raw outcome</summary>
                  <pre className="ritual-outcome">{Object.keys(r.outcome).length > 0 ? JSON.stringify(r.outcome, null, 2) : '{}'}</pre>
                </details>
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
