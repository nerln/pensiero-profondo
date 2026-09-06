import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from './db.js';
import { EMPTY_USAGE, type Role } from '../core/types.js';

function makeRole(overrides: Partial<Role> = {}): Role {
  return {
    id: 'role-1', name: 'deckhand', label: 'Deckhand', mandate: 'do the job',
    model: 'claude', effort: 'medium', tools: undefined, permissionMode: 'default', canPropose: false,
    ...overrides,
  };
}

describe('db', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  describe('studio', () => {
    it('is null before creation', () => {
      expect(db.studio.get()).toBeNull();
    });

    it('creates and reads back a studio', () => {
      const studio = db.studio.create({ name: 'pensiero', goal: 'ship it', roots: ['/a', '/b'], budgetUsd: 10 });
      expect(studio.id).toBeTruthy();
      expect(studio.createdAt).toBeTruthy();
      expect(db.studio.get()).toEqual(studio);
    });

    it('throws creating a second studio', () => {
      db.studio.create({ name: 'a', goal: 'g', roots: [], budgetUsd: null });
      expect(() => db.studio.create({ name: 'b', goal: 'g2', roots: [], budgetUsd: null })).toThrow();
    });

    it('updates fields and preserves the rest', () => {
      const studio = db.studio.create({ name: 'a', goal: 'g', roots: ['/x'], budgetUsd: null });
      const updated = db.studio.update({ goal: 'new goal', budgetUsd: 5 });
      expect(updated.id).toBe(studio.id);
      expect(updated.name).toBe('a');
      expect(updated.goal).toBe('new goal');
      expect(updated.budgetUsd).toBe(5);
      expect(updated.roots).toEqual(['/x']);
      expect(db.studio.get()).toEqual(updated);
    });

    it('throws updating with no studio', () => {
      expect(() => db.studio.update({ name: 'x' })).toThrow();
    });
  });

  describe('roles', () => {
    it('upsert twice keeps one row', () => {
      const role = makeRole();
      db.roles.upsert(role);
      db.roles.upsert({ ...role, label: 'Deckhand v2' });
      expect(db.roles.list()).toHaveLength(1);
      expect(db.roles.get(role.id)?.label).toBe('Deckhand v2');
    });

    it('get returns null for an unknown id', () => {
      expect(db.roles.get('nope')).toBeNull();
    });
  });

  describe('machines', () => {
    it('upsert generates an id when none given, and setStatus bumps lastSeenAt', () => {
      const machine = db.machines.upsert({ name: 'laptop', kind: 'local', status: 'online', claudeVersion: '1.0' });
      expect(machine.id).toBeTruthy();
      expect(db.machines.list()).toHaveLength(1);

      const before = machine.lastSeenAt;
      const updated = db.machines.setStatus(machine.id, 'offline');
      expect(updated.status).toBe('offline');
      expect(updated.lastSeenAt >= before).toBe(true);
      expect(db.machines.get(machine.id)?.status).toBe('offline');
    });

    it('upsert with an explicit id updates in place', () => {
      const m1 = db.machines.upsert({ id: 'fixed', name: 'laptop', kind: 'local', status: 'online', claudeVersion: null });
      const m2 = db.machines.upsert({ id: 'fixed', name: 'laptop renamed', kind: 'local', status: 'online', claudeVersion: null });
      expect(m2.id).toBe(m1.id);
      expect(db.machines.list()).toHaveLength(1);
      expect(db.machines.get('fixed')?.name).toBe('laptop renamed');
    });

    it('setStatus throws for an unknown id', () => {
      expect(() => db.machines.setStatus('nope', 'offline')).toThrow();
    });
  });

  describe('members', () => {
    function seed(dbi: Db) {
      dbi.studio.create({ name: 's', goal: 'g', roots: [], budgetUsd: null });
      const role = dbi.roles.upsert(makeRole());
      const machine = dbi.machines.upsert({ name: 'm', kind: 'local', status: 'online', claudeVersion: null });
      return { role, machine };
    }

    it('create sets defaults, update bumps lastActivityAt, remove deletes', () => {
      const { role, machine } = seed(db);
      const member = db.members.create({
        studioId: db.studio.get()!.id, roleId: role.id, machineId: machine.id,
        name: 'Deckhand 1', cwd: '/tmp', model: 'claude', effort: 'medium',
      });
      expect(member.status).toBe('starting');
      expect(member.usage).toEqual(EMPTY_USAGE);
      expect(member.sessionId).toBeNull();
      expect(member.error).toBeNull();
      expect(member.createdAt).toBe(member.lastActivityAt);

      const updated = db.members.update(member.id, { status: 'working', sessionId: 'sess-1' });
      expect(updated.status).toBe('working');
      expect(updated.sessionId).toBe('sess-1');
      expect(updated.lastActivityAt >= member.lastActivityAt).toBe(true);
      expect(db.members.get(member.id)).toEqual(updated);
      expect(db.members.list()).toHaveLength(1);

      db.members.remove(member.id);
      expect(db.members.get(member.id)).toBeNull();
      expect(db.members.list()).toHaveLength(0);
    });

    it('update throws for an unknown id', () => {
      expect(() => db.members.update('nope', { status: 'idle' })).toThrow();
    });

    it('create accepts an explicit status and usage', () => {
      const { role, machine } = seed(db);
      const usage = { ...EMPTY_USAGE, turns: 3 };
      const member = db.members.create({
        studioId: db.studio.get()!.id, roleId: role.id, machineId: machine.id,
        name: 'X', cwd: '/tmp', model: 'claude', effort: 'low', status: 'idle', usage,
      });
      expect(member.status).toBe('idle');
      expect(member.usage).toEqual(usage);
    });
  });

  describe('voci', () => {
    function seedStudio(dbi: Db) {
      return dbi.studio.create({ name: 's', goal: 'g', roots: [], budgetUsd: null });
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it('append sets id and createdAt from the clock', () => {
      const studio = seedStudio(db);
      const voce = db.voci.append({
        studioId: studio.id, verb: 'preso', text: 'taking X', author: { kind: 'owner' },
        to: 'all', replyTo: null, meta: {},
      });
      expect(voce.id).toBeTruthy();
      expect(voce.createdAt).toBeTruthy();
      expect(db.voci.get(voce.id)).toEqual(voce);
      expect(db.voci.count()).toBe(1);
    });

    it('lists in ascending createdAt/rowid order, filters, and limits', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const studio = seedStudio(db);

      const v1 = db.voci.append({
        studioId: studio.id, verb: 'preso', text: '1', author: { kind: 'owner' }, to: 'all', replyTo: null, meta: {},
      });
      vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
      const v2 = db.voci.append({
        studioId: studio.id, verb: 'numero', text: '2',
        author: { kind: 'member', memberId: 'm1', memberName: 'M', role: 'deckhand', machine: 'laptop' },
        to: 'm1', replyTo: null, meta: {},
      });
      vi.setSystemTime(new Date('2026-01-01T00:00:02.000Z'));
      const v3 = db.voci.append({
        studioId: studio.id, verb: 'fatto', text: '3', author: { kind: 'hub' }, to: 'all', replyTo: null, meta: {},
      });

      expect(db.voci.list().map((v) => v.id)).toEqual([v1.id, v2.id, v3.id]);

      // since is exclusive on createdAt
      expect(db.voci.list({ since: v1.createdAt }).map((v) => v.id)).toEqual([v2.id, v3.id]);

      // verb filter
      expect(db.voci.list({ verb: 'numero' }).map((v) => v.id)).toEqual([v2.id]);

      // to matches the direct addressee or 'all'
      expect(db.voci.list({ to: 'm1' }).map((v) => v.id)).toEqual([v1.id, v2.id, v3.id]);
      expect(db.voci.list({ to: 'someone-else' }).map((v) => v.id)).toEqual([v1.id, v3.id]);

      // author filter matches the member id inside the author payload
      expect(db.voci.list({ author: 'm1' }).map((v) => v.id)).toEqual([v2.id]);

      // limit
      expect(db.voci.list({ limit: 2 }).map((v) => v.id)).toEqual([v1.id, v2.id]);
    });
  });

  describe('bookmarks', () => {
    it('is null until set, then returns the last set value', () => {
      expect(db.bookmarks.get('m1')).toBeNull();
      db.bookmarks.set('m1', 'v1', '2026-01-01T00:00:00.000Z');
      expect(db.bookmarks.get('m1')).toEqual({ voceId: 'v1', createdAt: '2026-01-01T00:00:00.000Z' });
      db.bookmarks.set('m1', 'v2', '2026-01-02T00:00:00.000Z');
      expect(db.bookmarks.get('m1')).toEqual({ voceId: 'v2', createdAt: '2026-01-02T00:00:00.000Z' });
    });
  });

  describe('transcripts', () => {
    it('append/list/clear', () => {
      db.transcripts.append('m1', { kind: 'text', text: 'hello', ts: 't1' });
      db.transcripts.append('m1', { kind: 'text', text: 'world', ts: 't2' });

      expect(db.transcripts.list('m1')).toEqual([
        { kind: 'text', text: 'hello', ts: 't1' },
        { kind: 'text', text: 'world', ts: 't2' },
      ]);
      expect(db.transcripts.list('m1', { limit: 1 })).toEqual([{ kind: 'text', text: 'hello', ts: 't1' }]);

      db.transcripts.clear('m1');
      expect(db.transcripts.list('m1')).toEqual([]);
    });
  });

  describe('rituals', () => {
    it('lifecycle: create with defaults, update, list, get', () => {
      const studio = db.studio.create({ name: 's', goal: 'g', roots: [], budgetUsd: null });
      const ritual = db.rituals.create({ studioId: studio.id, kind: 'attack', targetVoceId: 'v1', memberIds: ['m1', 'm2'] });
      expect(ritual.status).toBe('running');
      expect(ritual.outcome).toEqual({});
      expect(ritual.finishedAt).toBeNull();

      const updated = db.rituals.update(ritual.id, {
        status: 'done', outcome: { verdict: 'holds' }, finishedAt: '2026-01-01T00:00:00.000Z',
      });
      expect(updated.status).toBe('done');
      expect(updated.outcome).toEqual({ verdict: 'holds' });
      expect(db.rituals.get(ritual.id)).toEqual(updated);
      expect(db.rituals.list()).toHaveLength(1);
    });

    it('update throws for an unknown id', () => {
      expect(() => db.rituals.update('nope', { status: 'done' })).toThrow();
    });

    it('create accepts an explicit status and outcome', () => {
      const studio = db.studio.create({ name: 's', goal: 'g', roots: [], budgetUsd: null });
      const ritual = db.rituals.create({
        studioId: studio.id, kind: 'council', targetVoceId: null, memberIds: [], status: 'aborted', outcome: { reason: 'x' },
      });
      expect(ritual.status).toBe('aborted');
      expect(ritual.outcome).toEqual({ reason: 'x' });
    });
  });
});

describe('db file persistence', () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the parent directory and survives close/reopen', () => {
    dir = mkdtempSync(join(tmpdir(), 'pensiero-db-test-'));
    const dbPath = join(dir, 'nested', 'studio.db');
    expect(existsSync(join(dir, 'nested'))).toBe(false);

    const db1 = openDb(dbPath);
    expect(existsSync(join(dir, 'nested'))).toBe(true);
    const studio = db1.studio.create({ name: 'persisted', goal: 'g', roots: ['/x'], budgetUsd: 42 });
    db1.close();

    const db2 = openDb(dbPath);
    expect(db2.studio.get()).toEqual(studio);
    db2.close();
  });
});
