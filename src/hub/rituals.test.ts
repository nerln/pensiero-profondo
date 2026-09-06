import { describe, it, expect } from 'vitest';
import { openDb } from './db.js';
import { attackBrief, settleAttacks, settleAll, tallyVerdicts, coMembers } from './rituals.js';
import { EMPTY_USAGE } from '../core/types.js';

function seed() {
  const db = openDb(':memory:');
  const studio = db.studio.create({ name: 's', goal: 'g', roots: ['/tmp'], budgetUsd: null });
  db.roles.upsert({ id: 'lookout', name: 'lookout', label: 'Lookout', mandate: 'm', model: 'claude-sonnet-5', effort: 'high', permissionMode: 'dontAsk', canPropose: false });
  const machine = db.machines.upsert({ name: 'local', kind: 'local', status: 'online', claudeVersion: null });
  const mk = (name: string) => db.members.create({ studioId: studio.id, roleId: 'lookout', machineId: machine.id, name, cwd: '/tmp', model: 'claude-sonnet-5', effort: 'high', status: 'idle', usage: EMPTY_USAGE });
  const claim = db.voci.append({ studioId: studio.id, verb: 'numero', text: 'coverage is 42.8%', author: { kind: 'owner' }, to: 'all', replyTo: null, meta: { value: 42.8, unit: '%' } });
  return { db, studio, machine, mk, claim };
}

describe('attack ritual', () => {
  it('brief quotes the claim with a margin and names the reply contract', () => {
    const { claim } = seed();
    const b = attackBrief(claim, 'r1');
    expect(b).toContain('| coverage is 42.8%');
    expect(b).toContain(`replyTo "${claim.id}"`);
    expect(b).toContain('"verdict"');
  });

  it('settles only when every lookout of the ritual has answered, majority rule', () => {
    const { db, studio, mk, claim } = seed();
    const a = mk('L1'), b = mk('L2'), c = mk('L3');
    const ritual = db.rituals.create({ studioId: studio.id, kind: 'attack', targetVoceId: claim.id, memberIds: [a.id, b.id, c.id] });
    const reply = (m: typeof a, verdict: string) => db.voci.append({ studioId: studio.id, verb: 'attacco', text: 'x', author: { kind: 'member', memberId: m.id, memberName: m.name, role: 'lookout', machine: 'local' }, to: 'all', replyTo: claim.id, meta: { verdict } });
    let r = settleAttacks(db, reply(a, 'holds'))[0];
    expect(r.status).toBe('running');
    expect(tallyVerdicts(db, r)).toMatchObject({ holds: 1, pending: 2 });
    settleAttacks(db, reply(b, 'refuted'));
    r = settleAttacks(db, reply(c, 'holds'))[0];
    expect(r.status).toBe('done');
    expect(r.outcome).toMatchObject({ holds: 2, refuted: 1, undecidable: 0, pending: 0, survives: true });
    expect(r.finishedAt).not.toBeNull();
  });

  it('a second answer from the same lookout does not count twice, and outsiders do not count', () => {
    const { db, studio, mk, claim } = seed();
    const a = mk('L1'), outsider = mk('X');
    db.rituals.create({ studioId: studio.id, kind: 'attack', targetVoceId: claim.id, memberIds: [a.id] });
    const reply = (m: typeof a, verdict: string) => db.voci.append({ studioId: studio.id, verb: 'attacco', text: 'x', author: { kind: 'member', memberId: m.id, memberName: m.name, role: 'lookout', machine: 'local' }, to: 'all', replyTo: claim.id, meta: { verdict } });
    settleAttacks(db, reply(outsider, 'holds'));
    expect(db.rituals.list()[0].status).toBe('running');
    const r = settleAttacks(db, reply(a, 'refuted'))[0];
    expect(r.status).toBe('done');
    expect(r.outcome).toMatchObject({ refuted: 1, holds: 0, survives: false });
    settleAttacks(db, reply(a, 'holds'));
    expect(db.rituals.get(r.id)?.outcome).toMatchObject({ refuted: 1, holds: 0 });
  });
});

describe('attack ritual, after review', () => {
  it('closes when the only pending lookout is stopped or removed', () => {
    const { db, studio, mk, claim } = seed();
    const a = mk('L1'), b = mk('L2');
    const ritual = db.rituals.create({ studioId: studio.id, kind: 'attack', targetVoceId: claim.id, memberIds: [a.id, b.id] });
    db.voci.append({ studioId: studio.id, verb: 'attacco', text: 'x', author: { kind: 'member', memberId: a.id, memberName: a.name, role: 'lookout', machine: 'local' }, to: 'all', replyTo: claim.id, meta: { verdict: 'refuted' } });
    expect(settleAll(db).find((r) => r.id === ritual.id)?.status).toBe('running');
    db.members.update(b.id, { status: 'error', error: 'crashed' });
    const done = settleAll(db).find((r) => r.id === ritual.id);
    expect(done?.status).toBe('done');
    expect(done?.outcome).toMatchObject({ refuted: 1, pending: 0, survives: false });
  });

  it('lookouts of a running ritual are co-members; nobody else is', () => {
    const { db, studio, mk, claim } = seed();
    const a = mk('L1'), b = mk('L2'), other = mk('X');
    db.rituals.create({ studioId: studio.id, kind: 'attack', targetVoceId: claim.id, memberIds: [a.id, b.id] });
    expect([...coMembers(db, a.id)]).toEqual([b.id]);
    expect(coMembers(db, other.id).size).toBe(0);
  });
});
