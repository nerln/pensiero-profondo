// The prompt Claude Code would show in the terminal before running a not-yet-approved tool,
// reproduced in the Member view: what it wants to do, the full input on request, and the three
// answers the owner can give. `y`/`n` work while the panel has focus, same as the CLI.

import { useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import type { PermissionRequest } from '../../core/types.js';
import { api } from '../api.js';
import { safeStringify } from '../utils.js';

export function PermissionPanel({ request }: { request: PermissionRequest }): JSX.Element {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    panelRef.current?.focus();
  }, [request.reqId]);

  async function resolve(allow: boolean, remember: boolean): Promise<void> {
    await api.resolvePermission(request.memberId, request.reqId, { allow, remember }).catch(() => {
      /* the panel disappears once permission.resolved arrives; a failed request just leaves it up */
    });
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'y' || e.key === 'Y') {
      e.preventDefault();
      void resolve(true, false);
    } else if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      void resolve(false, false);
    }
  }

  return (
    <div className="permission-panel" ref={panelRef} tabIndex={-1} onKeyDown={onKeyDown} role="alertdialog" aria-label={`Permission requested: ${request.toolName}`}>
      <div className="permission-panel-head">
        <span className="tool-name-tag">{request.toolName}</span>
        <span className="permission-panel-title">wants your permission to run</span>
      </div>
      <div className="permission-panel-summary">{request.summary}</div>
      <details className="permission-panel-input">
        <summary>full input</summary>
        <pre>{safeStringify(request.input, 2)}</pre>
      </details>
      <div className="permission-panel-actions">
        <button type="button" className="btn btn-primary" onClick={() => void resolve(true, false)}>
          Allow <kbd>y</kbd>
        </button>
        <button type="button" className="btn" onClick={() => void resolve(true, true)}>
          Allow and remember for this session
        </button>
        <button type="button" className="btn btn-danger" onClick={() => void resolve(false, false)}>
          Deny <kbd>n</kbd>
        </button>
      </div>
    </div>
  );
}
