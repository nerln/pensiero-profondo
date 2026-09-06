// Which blackboard entries reach which member, and when.
// An entry reaches a member if it is addressed to the member's id, to its role name, or to 'all',
// and the member did not write it. Delivery is debounced per member so a burst arrives as one frame.

import type { Db } from './db.js';
import type { Member, Role, Voce } from '../core/types.js';
import { cornice } from '../core/lavagna.js';

export function pendingFor(db: Db, member: Member, role: Role): Voce[] {
  const mark = db.bookmarks.get(member.id);
  // `since` is exclusive on createdAt, and two entries can share a millisecond: start one
  // millisecond before the bookmark and drop everything up to and including the bookmarked id.
  const since = mark ? new Date(Date.parse(mark.createdAt) - 1).toISOString() : undefined;
  let all = db.voci.list({ since });
  if (mark) {
    const i = all.findIndex((v) => v.id === mark.voceId);
    if (i >= 0) all = all.slice(i + 1);
  }
  return all.filter((v) => addressedTo(v, member, role));
}

export function addressedTo(v: Voce, member: Member, role: Role): boolean {
  if (v.author.kind === 'member' && v.author.memberId === member.id) return false;
  return v.to === 'all' || v.to === member.id || v.to === role.name || v.to === member.name;
}

/** Renders the frame for everything pending and moves the bookmark. Returns null when nothing is pending. */
export function takeDelivery(db: Db, member: Member, role: Role): string | null {
  const pending = pendingFor(db, member, role);
  if (pending.length === 0) return null;
  const text = cornice(pending, { forMemberName: member.name, forRole: role.label });
  const last = pending[pending.length - 1];
  db.bookmarks.set(member.id, last.id, last.createdAt);
  return text;
}

export class Deliverer {
  private timers = new Map<string, NodeJS.Timeout>();
  constructor(
    private db: Db,
    private send: (member: Member, framedText: string) => void,
    private delayMs = 2000,
  ) {}

  /** Called after every new entry. Schedules a delivery for each member it reaches. */
  onVoce(v: Voce): void {
    for (const m of this.db.members.list()) {
      if (m.status === 'stopped' || m.status === 'error' || m.status === 'starting') continue;
      const role = this.db.roles.get(m.roleId);
      if (!role || !addressedTo(v, m, role)) continue;
      this.schedule(m.id);
    }
  }

  private schedule(memberId: string): void {
    if (this.timers.has(memberId)) return;
    this.timers.set(memberId, setTimeout(() => {
      this.timers.delete(memberId);
      const m = this.db.members.get(memberId);
      const role = m && this.db.roles.get(m.roleId);
      if (!m || !role) return;
      const text = takeDelivery(this.db, m, role);
      if (text) this.send(m, text);
    }, this.delayMs));
  }

  close(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
