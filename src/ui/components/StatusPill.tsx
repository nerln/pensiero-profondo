import type { MemberStatus } from '../../core/types.js';

export function StatusPill({ status }: { status: MemberStatus }): JSX.Element {
  return (
    <span className="status-pill" data-status={status}>
      {status}
    </span>
  );
}
