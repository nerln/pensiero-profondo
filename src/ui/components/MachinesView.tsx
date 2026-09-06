import type { AppState } from '../state.js';
import { RelativeTime } from './Time.js';

export function MachinesView({ state }: { state: AppState }): JSX.Element {
  const machines = state.machines.slice().sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Machines</h1>
          <div className="page-sub">{machines.length} machine{machines.length === 1 ? '' : 's'}</div>
        </div>
      </div>

      {machines.length === 0 ? (
        <div className="empty">No machines registered.</div>
      ) : (
        <div className="machine-list">
          {machines.map((m) => (
            <div key={m.id} className="card machine-row">
              <span className="machine-name">{m.name}</span>
              <span className="machine-kind">{m.kind}</span>
              <span className="status-pill" data-status={m.status === 'online' ? 'working' : 'stopped'}>
                {m.status}
              </span>
              <span className="machine-lastseen">last seen <RelativeTime iso={m.lastSeenAt} /></span>
              <span className="machine-version">{m.claudeVersion ?? 'unknown version'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
