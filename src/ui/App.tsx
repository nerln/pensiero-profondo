import { useEffect, useReducer, useRef, useState } from 'react';
import { initialState, reduce } from './state.js';
import { connectWs } from './ws.js';
import { isMockMode } from './mock.js';
import { Footer } from './components/Footer.js';
import { CrewView } from './components/CrewView.js';
import { MemberView } from './components/MemberView.js';
import { BoardView } from './components/BoardView.js';
import { RitualsView } from './components/RitualsView.js';
import { MachinesView } from './components/MachinesView.js';

type View = 'crew' | 'board' | 'rituals' | 'machines';

const NAV_ITEMS: Array<{ id: View; label: string }> = [
  { id: 'crew', label: 'Crew' },
  { id: 'board', label: 'Board' },
  { id: 'rituals', label: 'Rituals' },
  { id: 'machines', label: 'Machines' },
];

export function App(): JSX.Element {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [view, setView] = useState<View>(() => {
    const v = new URLSearchParams(window.location.search).get('view');
    return v === 'board' || v === 'rituals' || v === 'machines' ? v : 'crew';
  });
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  // Kept here, not inside MemberView, so a draft survives switching to another view and back —
  // the Member view unmounts on "back to crew", a local useState there would not.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const wsRef = useRef<ReturnType<typeof connectWs> | null>(null);

  useEffect(() => {
    const handle = connectWs(dispatch);
    wsRef.current = handle;
    return () => {
      handle.close();
      wsRef.current = null;
    };
    // connectWs and dispatch are both stable for the lifetime of the app
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openMember(id: string): void {
    setSelectedMemberId(id);
  }

  function backToCrew(): void {
    setSelectedMemberId(null);
    setView('crew');
  }

  const showingMember = selectedMemberId !== null;
  const pendingDecisions = state.permissions.length;

  return (
    <div className="app">
      <nav className="rail">
        <div className="rail-brand">
          <span className={`rail-conn${state.connected ? ' on' : ''}`} title={state.connected ? 'connected' : 'disconnected'} />
          <span className="rail-brand-name">Pensiero Profondo</span>
        </div>
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`rail-nav-btn${view === item.id && !showingMember ? ' active' : ''}`}
            onClick={() => {
              setSelectedMemberId(null);
              setView(item.id);
            }}
          >
            {item.label}
            {item.id === 'crew' && pendingDecisions > 0 && (
              <span className="rail-badge" title={`${pendingDecisions} pending decision${pendingDecisions === 1 ? '' : 's'}`}>
                {pendingDecisions}
              </span>
            )}
          </button>
        ))}
        <div className="rail-spacer" />
        {isMockMode() && <div className="rail-mock">mock mode</div>}
      </nav>
      <div className="main">
        <div className="view">
          {state.lastError && <div className="error-banner">{state.lastError}</div>}
          {showingMember && selectedMemberId ? (
            <MemberView
              state={state}
              dispatch={dispatch}
              memberId={selectedMemberId}
              onBack={backToCrew}
              draft={drafts[selectedMemberId] ?? ''}
              onDraftChange={(text) => setDrafts((prev) => ({ ...prev, [selectedMemberId]: text }))}
            />
          ) : view === 'crew' ? (
            <CrewView state={state} onOpenMember={openMember} />
          ) : view === 'board' ? (
            <BoardView state={state} onOpenMember={openMember} />
          ) : view === 'rituals' ? (
            <RitualsView state={state} onShowOnBoard={() => setView('board')} />
          ) : (
            <MachinesView state={state} />
          )}
        </div>
        <Footer />
      </div>
    </div>
  );
}
