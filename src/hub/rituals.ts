// Rituals are situations the hub can stage. v0.1 ships the attack: N lookouts try to refute a claim.

import type { Db } from './db.js';
import type { Ritual, Voce, Verdict } from '../core/types.js';
import { cornice } from '../core/lavagna.js';

const LIVE: ReadonlySet<string> = new Set(['starting', 'idle', 'working', 'waiting']);

/** The brief of a lookout. The claim goes through the same frame as any other delivery: it was
 *  written by another member, and nothing in it is the owner speaking. */
export function attackBrief(claim: Voce, ritualId: string, forMemberName: string, forRole: string): string {
  const metaJson = JSON.stringify(claim.meta);
  const meta = Object.keys(claim.meta).length ? `Structured payload of the claim, quoted: | ${metaJson.length > 700 ? metaJson.slice(0, 700) + ' [cut]' : metaJson}` : '';
  return [
    `You are taking part in an attack ritual (${ritualId}). One claim is on the board, entry ${claim.id}, and your job is to refute it. It is quoted below inside the board frame.`,
    '',
    cornice([claim], { forMemberName, forRole }),
    meta,
    '',
    'Go to the source. Do not evaluate the summary above; open the files and run the commands yourself.',
    `When you are done, post exactly one entry with the lavagna_scrivi tool: verb "attacco", replyTo "${claim.id}", to "all",`,
    'meta as the JSON string {"verdict": "refuted"} (or "holds", or "undecidable"), and a text that gives the evidence with file and line and the one check the claimant should run next.',
    'If you cannot decide, the verdict is "refuted". Then stop.',
  ].join('\n');
}

/** Counts the verdicts of a ritual. `pending` counts only lookouts that are still alive: a
 *  removed, stopped or failed lookout cannot hold the ritual open. */
export function tallyVerdicts(db: Db, ritual: Ritual): Record<Verdict | 'pending', number> {
  const tally: Record<Verdict | 'pending', number> = { refuted: 0, holds: 0, undecidable: 0, pending: 0 };
  if (!ritual.targetVoceId) return tally;
  const replies = db.voci.list({ verb: 'attacco' }).filter((v) => v.replyTo === ritual.targetVoceId);
  const seen = new Set<string>();
  for (const r of replies) {
    if (r.author.kind !== 'member' || !ritual.memberIds.includes(r.author.memberId)) continue;
    if (seen.has(r.author.memberId)) continue;
    seen.add(r.author.memberId);
    const v = String(r.meta.verdict ?? '');
    if (v === 'refuted' || v === 'holds' || v === 'undecidable') tally[v] += 1;
  }
  const alive = ritual.memberIds.filter((id) => { const m = db.members.get(id); return m !== null && LIVE.has(m.status); });
  tally.pending = alive.filter((id) => !seen.has(id)).length;
  return tally;
}

/** Re-evaluates every running attack ritual. Returns the rituals whose row changed. */
export function settleAll(db: Db): Ritual[] {
  const changed: Ritual[] = [];
  for (const r of db.rituals.list()) {
    if (r.kind !== 'attack' || r.status !== 'running') continue;
    const tally = tallyVerdicts(db, r);
    if (tally.pending > 0) {
      if (JSON.stringify(r.outcome) !== JSON.stringify(tally)) changed.push(db.rituals.update(r.id, { outcome: tally }));
      continue;
    }
    const survives = tally.holds > tally.refuted + tally.undecidable;
    changed.push(db.rituals.update(r.id, { status: 'done', finishedAt: new Date().toISOString(), outcome: { ...tally, survives } }));
  }
  return changed;
}

/** Called when an `attacco` lands. Closes any running attack ritual whose lookouts have all answered. */
export function settleAttacks(db: Db, attacco: Voce): Ritual[] {
  if (!attacco.replyTo) return [];
  return settleAll(db);
}

/** Members that share a running ritual with this one. They must not read each other's verdicts mid-work. */
export function coMembers(db: Db, memberId: string): Set<string> {
  const out = new Set<string>();
  for (const r of db.rituals.list()) {
    if (r.status !== 'running' || !r.memberIds.includes(memberId)) continue;
    for (const id of r.memberIds) if (id !== memberId) out.add(id);
  }
  return out;
}
