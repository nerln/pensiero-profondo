// Synchronous repository over better-sqlite3. One connection per open database,
// WAL mode, foreign keys on. Ids and clock times are stamped here, never by a caller
// (see docs/DESIGN.md, "Time comes from the clock").

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { EMPTY_USAGE } from '../core/types.js';
import type {
  Studio, Role, Machine, MachineKind, Member, MemberStatus, Voce, Author,
  TranscriptItem, Ritual, RitualKind, EffortLevel, PermissionMode, Usage,
} from '../core/types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS studio (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  goal TEXT NOT NULL,
  roots TEXT NOT NULL,
  budgetUsd REAL,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  label TEXT NOT NULL,
  mandate TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  tools TEXT,
  permissionMode TEXT NOT NULL,
  canPropose INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  lastSeenAt TEXT NOT NULL,
  claudeVersion TEXT
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  studioId TEXT NOT NULL REFERENCES studio(id),
  roleId TEXT NOT NULL REFERENCES roles(id),
  machineId TEXT NOT NULL REFERENCES machines(id),
  name TEXT NOT NULL,
  cwd TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  status TEXT NOT NULL,
  sessionId TEXT,
  usage TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  lastActivityAt TEXT NOT NULL,
  error TEXT
);

CREATE TABLE IF NOT EXISTS voci (
  id TEXT PRIMARY KEY,
  studioId TEXT NOT NULL REFERENCES studio(id),
  verb TEXT NOT NULL,
  text TEXT NOT NULL,
  author TEXT NOT NULL,
  authorMemberId TEXT,
  "to" TEXT NOT NULL,
  replyTo TEXT,
  meta TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_voci_createdAt ON voci(createdAt);
CREATE INDEX IF NOT EXISTS idx_voci_verb ON voci(verb);
CREATE INDEX IF NOT EXISTS idx_voci_to ON voci("to");

-- No FK to members here on purpose: a worker may deliver a transcript item or a
-- bookmark update in a message that races the member row's own commit, and both
-- tables are harmless to keep around after a member is removed.
CREATE TABLE IF NOT EXISTS bookmarks (
  memberId TEXT PRIMARY KEY,
  voceId TEXT NOT NULL,
  voceCreatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transcripts (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  memberId TEXT NOT NULL,
  item TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transcripts_memberId ON transcripts(memberId);

CREATE TABLE IF NOT EXISTS rituals (
  id TEXT PRIMARY KEY,
  studioId TEXT NOT NULL REFERENCES studio(id),
  kind TEXT NOT NULL,
  targetVoceId TEXT,
  memberIds TEXT NOT NULL,
  status TEXT NOT NULL,
  outcome TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  finishedAt TEXT
);
`;

// ---------- row shapes (what better-sqlite3 actually hands back) ----------

interface StudioRow {
  id: string; name: string; goal: string; roots: string; budgetUsd: number | null; createdAt: string;
}
interface RoleRow {
  id: string; name: string; label: string; mandate: string; model: string; effort: string;
  tools: string | null; permissionMode: string; canPropose: number;
}
interface MachineRow {
  id: string; name: string; kind: string; status: string; lastSeenAt: string; claudeVersion: string | null;
}
interface MemberRow {
  id: string; studioId: string; roleId: string; machineId: string; name: string; cwd: string;
  model: string; effort: string; status: string; sessionId: string | null; usage: string;
  createdAt: string; lastActivityAt: string; error: string | null;
}
interface VoceRow {
  id: string; studioId: string; verb: string; text: string; author: string; to: string;
  replyTo: string | null; meta: string; createdAt: string;
}
interface RitualRow {
  id: string; studioId: string; kind: string; targetVoceId: string | null; memberIds: string;
  status: string; outcome: string; createdAt: string; finishedAt: string | null;
}

function rowToStudio(row: StudioRow): Studio {
  return { id: row.id, name: row.name, goal: row.goal, roots: JSON.parse(row.roots) as string[], budgetUsd: row.budgetUsd, createdAt: row.createdAt };
}
function rowToRole(row: RoleRow): Role {
  return {
    id: row.id, name: row.name, label: row.label, mandate: row.mandate, model: row.model,
    effort: row.effort as EffortLevel, tools: row.tools ? (JSON.parse(row.tools) as string[]) : undefined,
    permissionMode: row.permissionMode as PermissionMode, canPropose: row.canPropose === 1,
  };
}
function rowToMachine(row: MachineRow): Machine {
  return { id: row.id, name: row.name, kind: row.kind as MachineKind, status: row.status as Machine['status'], lastSeenAt: row.lastSeenAt, claudeVersion: row.claudeVersion };
}
function rowToMember(row: MemberRow): Member {
  return {
    id: row.id, studioId: row.studioId, roleId: row.roleId, machineId: row.machineId, name: row.name,
    cwd: row.cwd, model: row.model, effort: row.effort as EffortLevel, status: row.status as MemberStatus,
    sessionId: row.sessionId, usage: JSON.parse(row.usage) as Usage, createdAt: row.createdAt,
    lastActivityAt: row.lastActivityAt, error: row.error,
  };
}
function rowToVoce(row: VoceRow): Voce {
  return {
    id: row.id, studioId: row.studioId, verb: row.verb as Voce['verb'], text: row.text,
    author: JSON.parse(row.author) as Author, to: row.to, replyTo: row.replyTo,
    meta: JSON.parse(row.meta) as Record<string, unknown>, createdAt: row.createdAt,
  };
}
function rowToRitual(row: RitualRow): Ritual {
  return {
    id: row.id, studioId: row.studioId, kind: row.kind as RitualKind, targetVoceId: row.targetVoceId,
    memberIds: JSON.parse(row.memberIds) as string[], status: row.status as Ritual['status'],
    outcome: JSON.parse(row.outcome) as Record<string, unknown>, createdAt: row.createdAt, finishedAt: row.finishedAt,
  };
}

const now = (): string => new Date().toISOString();

export interface Db {
  studio: {
    get(): Studio | null;
    create(input: { name: string; goal: string; roots: string[]; budgetUsd: number | null }): Studio;
    update(patch: Partial<Pick<Studio, 'name' | 'goal' | 'roots' | 'budgetUsd'>>): Studio;
  };
  roles: { list(): Role[]; get(id: string): Role | null; upsert(role: Role): Role };
  machines: {
    list(): Machine[];
    get(id: string): Machine | null;
    upsert(input: Omit<Machine, 'id' | 'lastSeenAt'> & { id?: string }): Machine;
    setStatus(id: string, status: Machine['status']): Machine;
  };
  members: {
    list(): Member[];
    get(id: string): Member | null;
    create(input: Omit<Member, 'id' | 'createdAt' | 'lastActivityAt' | 'usage' | 'status' | 'sessionId' | 'error'> & Partial<Pick<Member, 'status' | 'usage'>>): Member;
    update(id: string, patch: Partial<Omit<Member, 'id' | 'studioId' | 'createdAt'>>): Member;
    remove(id: string): void;
  };
  voci: {
    append(input: Omit<Voce, 'id' | 'createdAt'>): Voce;
    get(id: string): Voce | null;
    list(opts?: { since?: string; verb?: Voce['verb']; to?: string; author?: string; limit?: number }): Voce[];
    count(): number;
  };
  bookmarks: { get(memberId: string): { voceId: string; createdAt: string } | null; set(memberId: string, voceId: string, voceCreatedAt: string): void };
  transcripts: { append(memberId: string, item: TranscriptItem): void; list(memberId: string, opts?: { limit?: number }): TranscriptItem[]; clear(memberId: string): void };
  rituals: {
    create(input: Omit<Ritual, 'id' | 'createdAt' | 'finishedAt' | 'status' | 'outcome'> & Partial<Pick<Ritual, 'status' | 'outcome'>>): Ritual;
    update(id: string, patch: Partial<Omit<Ritual, 'id' | 'studioId' | 'createdAt'>>): Ritual;
    list(): Ritual[];
    get(id: string): Ritual | null;
  };
  close(): void;
}

export function openDb(path: string): Db {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const conn = new Database(path);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  conn.exec(SCHEMA);

  // ---------- studio ----------
  const studioGetStmt = conn.prepare('SELECT * FROM studio LIMIT 1');
  const studioInsertStmt = conn.prepare(
    'INSERT INTO studio (id, name, goal, roots, budgetUsd, createdAt) VALUES (@id, @name, @goal, @roots, @budgetUsd, @createdAt)',
  );
  const studioUpdateStmt = conn.prepare(
    'UPDATE studio SET name = @name, goal = @goal, roots = @roots, budgetUsd = @budgetUsd WHERE id = @id',
  );

  function getStudio(): Studio | null {
    const row = studioGetStmt.get() as StudioRow | undefined;
    return row ? rowToStudio(row) : null;
  }

  // ---------- roles ----------
  const rolesListStmt = conn.prepare('SELECT * FROM roles ORDER BY rowid');
  const rolesGetStmt = conn.prepare('SELECT * FROM roles WHERE id = ?');
  const rolesUpsertStmt = conn.prepare(`
    INSERT INTO roles (id, name, label, mandate, model, effort, tools, permissionMode, canPropose)
    VALUES (@id, @name, @label, @mandate, @model, @effort, @tools, @permissionMode, @canPropose)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, label = excluded.label, mandate = excluded.mandate, model = excluded.model,
      effort = excluded.effort, tools = excluded.tools, permissionMode = excluded.permissionMode,
      canPropose = excluded.canPropose
  `);

  function getRole(id: string): Role | null {
    const row = rolesGetStmt.get(id) as RoleRow | undefined;
    return row ? rowToRole(row) : null;
  }

  // ---------- machines ----------
  const machinesListStmt = conn.prepare('SELECT * FROM machines ORDER BY rowid');
  const machinesGetStmt = conn.prepare('SELECT * FROM machines WHERE id = ?');
  const machinesUpsertStmt = conn.prepare(`
    INSERT INTO machines (id, name, kind, status, lastSeenAt, claudeVersion)
    VALUES (@id, @name, @kind, @status, @lastSeenAt, @claudeVersion)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, kind = excluded.kind, status = excluded.status,
      lastSeenAt = excluded.lastSeenAt, claudeVersion = excluded.claudeVersion
  `);
  const machinesSetStatusStmt = conn.prepare('UPDATE machines SET status = @status, lastSeenAt = @lastSeenAt WHERE id = @id');

  function getMachine(id: string): Machine | null {
    const row = machinesGetStmt.get(id) as MachineRow | undefined;
    return row ? rowToMachine(row) : null;
  }

  // ---------- members ----------
  const membersListStmt = conn.prepare('SELECT * FROM members ORDER BY rowid');
  const membersGetStmt = conn.prepare('SELECT * FROM members WHERE id = ?');
  const membersInsertStmt = conn.prepare(`
    INSERT INTO members (id, studioId, roleId, machineId, name, cwd, model, effort, status, sessionId, usage, createdAt, lastActivityAt, error)
    VALUES (@id, @studioId, @roleId, @machineId, @name, @cwd, @model, @effort, @status, @sessionId, @usage, @createdAt, @lastActivityAt, @error)
  `);
  const membersUpdateStmt = conn.prepare(`
    UPDATE members SET
      roleId = @roleId, machineId = @machineId, name = @name, cwd = @cwd, model = @model, effort = @effort,
      status = @status, sessionId = @sessionId, usage = @usage, lastActivityAt = @lastActivityAt, error = @error
    WHERE id = @id
  `);
  const membersDeleteStmt = conn.prepare('DELETE FROM members WHERE id = ?');

  function getMember(id: string): Member | null {
    const row = membersGetStmt.get(id) as MemberRow | undefined;
    return row ? rowToMember(row) : null;
  }

  // ---------- voci ----------
  const vociInsertStmt = conn.prepare(`
    INSERT INTO voci (id, studioId, verb, text, author, authorMemberId, "to", replyTo, meta, createdAt)
    VALUES (@id, @studioId, @verb, @text, @author, @authorMemberId, @to, @replyTo, @meta, @createdAt)
  `);
  const vociGetStmt = conn.prepare('SELECT * FROM voci WHERE id = ?');
  const vociCountStmt = conn.prepare('SELECT COUNT(*) as c FROM voci');

  // ---------- bookmarks ----------
  const bookmarksGetStmt = conn.prepare('SELECT voceId, voceCreatedAt FROM bookmarks WHERE memberId = ?');
  const bookmarksSetStmt = conn.prepare(`
    INSERT INTO bookmarks (memberId, voceId, voceCreatedAt) VALUES (@memberId, @voceId, @voceCreatedAt)
    ON CONFLICT(memberId) DO UPDATE SET voceId = excluded.voceId, voceCreatedAt = excluded.voceCreatedAt
  `);

  // ---------- transcripts ----------
  const transcriptsInsertStmt = conn.prepare('INSERT INTO transcripts (memberId, item) VALUES (?, ?)');
  const transcriptsListStmt = conn.prepare('SELECT item FROM transcripts WHERE memberId = ? ORDER BY seq ASC');
  const transcriptsListLimitStmt = conn.prepare('SELECT item FROM transcripts WHERE memberId = ? ORDER BY seq ASC LIMIT ?');
  const transcriptsClearStmt = conn.prepare('DELETE FROM transcripts WHERE memberId = ?');

  // ---------- rituals ----------
  const ritualsListStmt = conn.prepare('SELECT * FROM rituals ORDER BY rowid');
  const ritualsGetStmt = conn.prepare('SELECT * FROM rituals WHERE id = ?');
  const ritualsInsertStmt = conn.prepare(`
    INSERT INTO rituals (id, studioId, kind, targetVoceId, memberIds, status, outcome, createdAt, finishedAt)
    VALUES (@id, @studioId, @kind, @targetVoceId, @memberIds, @status, @outcome, @createdAt, @finishedAt)
  `);
  const ritualsUpdateStmt = conn.prepare(`
    UPDATE rituals SET kind = @kind, targetVoceId = @targetVoceId, memberIds = @memberIds,
      status = @status, outcome = @outcome, finishedAt = @finishedAt
    WHERE id = @id
  `);

  function getRitual(id: string): Ritual | null {
    const row = ritualsGetStmt.get(id) as RitualRow | undefined;
    return row ? rowToRitual(row) : null;
  }

  return {
    studio: {
      get: getStudio,
      create(input) {
        if (getStudio()) throw new Error('a studio already exists in this database');
        const studio: Studio = { id: randomUUID(), name: input.name, goal: input.goal, roots: input.roots, budgetUsd: input.budgetUsd, createdAt: now() };
        studioInsertStmt.run({ id: studio.id, name: studio.name, goal: studio.goal, roots: JSON.stringify(studio.roots), budgetUsd: studio.budgetUsd, createdAt: studio.createdAt });
        return studio;
      },
      update(patch) {
        const existing = getStudio();
        if (!existing) throw new Error('no studio to update');
        const merged: Studio = { ...existing, ...patch };
        studioUpdateStmt.run({ id: merged.id, name: merged.name, goal: merged.goal, roots: JSON.stringify(merged.roots), budgetUsd: merged.budgetUsd });
        return merged;
      },
    },

    roles: {
      list: () => (rolesListStmt.all() as RoleRow[]).map(rowToRole),
      get: getRole,
      upsert(role) {
        rolesUpsertStmt.run({
          id: role.id, name: role.name, label: role.label, mandate: role.mandate, model: role.model,
          effort: role.effort, tools: role.tools ? JSON.stringify(role.tools) : null,
          permissionMode: role.permissionMode, canPropose: role.canPropose ? 1 : 0,
        });
        return getRole(role.id)!;
      },
    },

    machines: {
      list: () => (machinesListStmt.all() as MachineRow[]).map(rowToMachine),
      get: getMachine,
      upsert(input) {
        const id = input.id ?? randomUUID();
        machinesUpsertStmt.run({ id, name: input.name, kind: input.kind, status: input.status, lastSeenAt: now(), claudeVersion: input.claudeVersion });
        return getMachine(id)!;
      },
      setStatus(id, status) {
        if (!getMachine(id)) throw new Error(`machine not found: ${id}`);
        machinesSetStatusStmt.run({ id, status, lastSeenAt: now() });
        return getMachine(id)!;
      },
    },

    members: {
      list: () => (membersListStmt.all() as MemberRow[]).map(rowToMember),
      get: getMember,
      create(input) {
        const createdAt = now();
        const member: Member = {
          id: randomUUID(), studioId: input.studioId, roleId: input.roleId, machineId: input.machineId,
          name: input.name, cwd: input.cwd, model: input.model, effort: input.effort,
          status: input.status ?? 'starting', sessionId: null, usage: input.usage ?? EMPTY_USAGE,
          createdAt, lastActivityAt: createdAt, error: null,
        };
        membersInsertStmt.run({ ...member, usage: JSON.stringify(member.usage) });
        return member;
      },
      update(id, patch) {
        const existing = getMember(id);
        if (!existing) throw new Error(`member not found: ${id}`);
        const merged: Member = { ...existing, ...patch, lastActivityAt: now() };
        membersUpdateStmt.run({
          id, roleId: merged.roleId, machineId: merged.machineId, name: merged.name, cwd: merged.cwd,
          model: merged.model, effort: merged.effort, status: merged.status, sessionId: merged.sessionId,
          usage: JSON.stringify(merged.usage), lastActivityAt: merged.lastActivityAt, error: merged.error,
        });
        return merged;
      },
      remove(id) {
        membersDeleteStmt.run(id);
      },
    },

    voci: {
      append(input) {
        const id = randomUUID();
        const createdAt = now();
        const authorMemberId = input.author.kind === 'member' ? input.author.memberId : null;
        vociInsertStmt.run({
          id, studioId: input.studioId, verb: input.verb, text: input.text,
          author: JSON.stringify(input.author), authorMemberId, to: input.to, replyTo: input.replyTo,
          meta: JSON.stringify(input.meta), createdAt,
        });
        return { id, ...input, createdAt };
      },
      get(id) {
        const row = vociGetStmt.get(id) as VoceRow | undefined;
        return row ? rowToVoce(row) : null;
      },
      list(opts = {}) {
        const conditions: string[] = [];
        const params: Record<string, unknown> = {};
        if (opts.since !== undefined) { conditions.push('createdAt > @since'); params.since = opts.since; }
        if (opts.verb !== undefined) { conditions.push('verb = @verb'); params.verb = opts.verb; }
        if (opts.to !== undefined) { conditions.push('("to" = @to OR "to" = \'all\')'); params.to = opts.to; }
        if (opts.author !== undefined) { conditions.push('authorMemberId = @author'); params.author = opts.author; }
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const limit = opts.limit !== undefined ? 'LIMIT @limit' : '';
        if (opts.limit !== undefined) params.limit = opts.limit;
        const rows = conn.prepare(`SELECT * FROM voci ${where} ORDER BY createdAt ASC, rowid ASC ${limit}`).all(params) as VoceRow[];
        return rows.map(rowToVoce);
      },
      count: () => (vociCountStmt.get() as { c: number }).c,
    },

    bookmarks: {
      get(memberId) {
        const row = bookmarksGetStmt.get(memberId) as { voceId: string; voceCreatedAt: string } | undefined;
        return row ? { voceId: row.voceId, createdAt: row.voceCreatedAt } : null;
      },
      set(memberId, voceId, voceCreatedAt) {
        bookmarksSetStmt.run({ memberId, voceId, voceCreatedAt });
      },
    },

    transcripts: {
      append(memberId, item) {
        transcriptsInsertStmt.run(memberId, JSON.stringify(item));
      },
      list(memberId, opts) {
        // Ascending insertion order, oldest first; `limit` caps from the start (same convention as voci.list).
        const rows = (opts?.limit !== undefined
          ? transcriptsListLimitStmt.all(memberId, opts.limit)
          : transcriptsListStmt.all(memberId)) as { item: string }[];
        return rows.map((r) => JSON.parse(r.item) as TranscriptItem);
      },
      clear(memberId) {
        transcriptsClearStmt.run(memberId);
      },
    },

    rituals: {
      create(input) {
        const ritual: Ritual = {
          id: randomUUID(), studioId: input.studioId, kind: input.kind, targetVoceId: input.targetVoceId,
          memberIds: input.memberIds, status: input.status ?? 'running', outcome: input.outcome ?? {},
          createdAt: now(), finishedAt: null,
        };
        ritualsInsertStmt.run({
          ...ritual, memberIds: JSON.stringify(ritual.memberIds), outcome: JSON.stringify(ritual.outcome),
        });
        return ritual;
      },
      update(id, patch) {
        const existing = getRitual(id);
        if (!existing) throw new Error(`ritual not found: ${id}`);
        const merged: Ritual = { ...existing, ...patch };
        ritualsUpdateStmt.run({
          id, kind: merged.kind, targetVoceId: merged.targetVoceId, memberIds: JSON.stringify(merged.memberIds),
          status: merged.status, outcome: JSON.stringify(merged.outcome), finishedAt: merged.finishedAt,
        });
        return merged;
      },
      list: () => (ritualsListStmt.all() as RitualRow[]).map(rowToRitual),
      get: getRitual,
    },

    close() {
      conn.close();
    },
  };
}
