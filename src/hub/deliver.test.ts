import { describe, it, expect, vi } from 'vitest';
import { openDb } from './db.js';
import { Deliverer, pendingFor, takeDelivery } from './deliver.js';
import { EMPTY_USAGE, type Member, type Voce } from '../core/types.js';

function seed() {
  const db = openDb(':memory:');
  const studio = db.studio.create({ name: 's', goal: 'g', roots: ['/tmp'], budgetUsd: null });
  db.roles.upsert({ id: 'deckhand', name: 'deckhand', label: 'Deckhand', mandate: 'm', model: 'claude-sonnet-5', effort: 'high', permissionMode: 'acceptEdits', canPropose: false });
  db.roles.upsert({ id: 'lookout', name: 'lookout', label: 'Lookout', mandate: 'm', model: 'claude-sonnet-5', effort: 'high', permissionMode: 'dontAsk', canPropose: false });
  const machine = db.machines.upsert({ name: 'local', kind: 'local', status: 'online', claudeVersion: null });
  const mk = (name: string, roleId: string, status: Member['status'] = 'idle') => db.members.create({ studioId: studio.id, roleId, machineId: machine.id, name, cwd: '/tmp', model: 'claude-sonnet-5', effort: 'high', status, usage: EMPTY_USAGE });
  const post = (author: Voce['author'], to: string, text = 't') => db.voci.append({ studioId: studio.id, verb: 'messaggio', text, author, to, replyTo: null, meta: {} });
  return { db, mk, post };
}

describe('delivery', () => {
  it('reaches by id, by role name, by member name and all, never the author', () => {
    const { db, mk, post } = seed();
    const d = mk('Deckhand 1', 'deckhand');
    const l = mk('Lookout 1', 'lookout');
    const role = db.roles.get('deckhand')!;
    post({ kind: 'owner' }, 'all');
    post({ kind: 'owner' }, d.id);
    post({ kind: 'owner' }, 'deckhand');
    post({ kind: 'owner' }, 'Deckhand 1');
    post({ kind: 'owner' }, 'lookout');
    post({ kind: 'member', memberId: d.id, memberName: d.name, role: 'deckhand', machine: 'local' }, 'all');
    expect(pendingFor(db, d, role)).toHaveLength(4);
    expect(pendingFor(db, l, db.roles.get('lookout')!)).toHaveLength(3);
  });

  it('takeDelivery frames, moves the bookmark, and returns null when nothing is new', () => {
    const { db, mk, post } = seed();
    const d = mk('Deckhand 1', 'deckhand');
    const role = db.roles.get('deckhand')!;
    post({ kind: 'owner' }, 'all', 'first line\nsecond line');
    const text = takeDelivery(db, d, role);
    expect(text).toContain('| first line');
    expect(text).toContain('| second line');
    expect(takeDelivery(db, d, role)).toBeNull();
    post({ kind: 'owner' }, 'all', 'later');
    expect(takeDelivery(db, d, role)).toContain('| later');
  });

  it('Deliverer debounces per member and skips stopped members', async () => {
    vi.useFakeTimers();
    const { db, mk, post } = seed();
    const d = mk('Deckhand 1', 'deckhand');
    mk('Deckhand 2', 'deckhand', 'stopped');
    const sent: Array<[string, string]> = [];
    const del = new Deliverer(db, (m, text) => sent.push([m.name, text]), 100);
    del.onVoce(post({ kind: 'owner' }, 'all', 'one'));
    del.onVoce(post({ kind: 'owner' }, 'all', 'two'));
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(150);
    expect(sent).toHaveLength(1);
    expect(sent[0][0]).toBe('Deckhand 1');
    expect(sent[0][1]).toContain('| one');
    expect(sent[0][1]).toContain('| two');
    expect(db.bookmarks.get(d.id)).not.toBeNull();
    del.close();
    vi.useRealTimers();
  });
});

describe('delivery, after review', () => {
  it('does not deliver a lookout verdict to the other lookouts of the same running ritual', async () => {
    vi.useFakeTimers();
    const { db, mk, post } = seed();
    const l1 = mk('Lookout 1', 'lookout');
    const l2 = mk('Lookout 2', 'lookout');
    const d = mk('Deckhand 1', 'deckhand');
    const studio = db.studio.get()!;
    db.rituals.create({ studioId: studio.id, kind: 'attack', targetVoceId: null, memberIds: [l1.id, l2.id] });
    const sent: string[] = [];
    const del = new Deliverer(db, (m) => sent.push(m.name), 50);
    del.onVoce(post({ kind: 'member', memberId: l1.id, memberName: l1.name, role: 'lookout', machine: 'local' }, 'all', 'my verdict'));
    await vi.advanceTimersByTimeAsync(100);
    expect(sent.sort()).toEqual(['Deckhand 1']);
    expect(pendingFor(db, l2, db.roles.get('lookout')!)).toHaveLength(0);
    expect(pendingFor(db, d, db.roles.get('deckhand')!)).toHaveLength(0); // already taken by the deliverer
    del.close();
    vi.useRealTimers();
  });
});
