// Rituals are situations the hub can stage. v0.1 ships the attack: N lookouts try to refute a claim.

import type { Db } from './db.js';
import type { Ritual, Voce, Verdict } from '../core/types.js';

export function attackBrief(claim: Voce, ritualId: string): string {
  const meta = Object.keys(claim.meta).length ? `\nStructured payload: ${JSON.stringify(claim.meta)}` : '';
  const who = claim.author.kind === 'member' ? `${claim.author.memberName} (${claim.author.role})` : claim.author.kind;
  return [
    `You are taking part in an attack ritual (${ritualId}). One claim is on the board and your job is to refute it.`,
    '',
    `Claim ${claim.id}, written by ${who}:`,
    ...claim.text.split('\n').map((l) => `| ${l}`),
    meta,
    '',
    'Go to the source. Do not evaluate the summary above; open the files and run the commands yourself.',
    `When you are done, post exactly one entry with the lavagna_scrivi tool: verb "attacco", replyTo "${claim.id}", to "all",`,
    'meta {"verdict": "refuted" | "holds" | "undecidable"}, and a text that gives the evidence with file and line and the one check the claimant should run next.',
    'If you cannot decide, the verdict is "refuted". Then stop.',
  ].join('\n');
}

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
  tally.pending = ritual.memberIds.length - seen.size;
  return tally;
}

/** Called when an `attacco` lands. Closes any running attack ritual whose lookouts have all answered. */
export function settleAttacks(db: Db, attacco: Voce): Ritual[] {
  const settled: Ritual[] = [];
  for (const r of db.rituals.list()) {
    if (r.kind !== 'attack' || r.status !== 'running' || r.targetVoceId !== attacco.replyTo) continue;
    const tally = tallyVerdicts(db, r);
    if (tally.pending > 0) {
      settled.push(db.rituals.update(r.id, { outcome: tally }));
      continue;
    }
    const survives = tally.holds > tally.refuted + tally.undecidable;
    settled.push(db.rituals.update(r.id, {
      status: 'done',
      finishedAt: new Date().toISOString(),
      outcome: { ...tally, survives },
    }));
  }
  return settled;
}
