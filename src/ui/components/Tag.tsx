import type { Verb, Verdict } from '../../core/types.js';

/** English gloss for each verb, shown as a tooltip on the tag and in the Board's verb filter. */
export const VERB_GLOSS: Record<Verb, string> = {
  preso: 'taking this',
  fatto: 'done',
  messaggio: 'message',
  avviso: 'warning about the commons',
  numero: 'a measured claim',
  attacco: 'a refutation attempt',
  ritratto: 'a retraction',
  proposta: 'an outward action needing consent',
  consenso: 'an explicit yes or no',
};

export function VerbTag({ verb }: { verb: Verb }): JSX.Element {
  return (
    <span className="tag" data-verb={verb} title={VERB_GLOSS[verb]}>
      {verb}
    </span>
  );
}

export function VerdictTag({ verdict }: { verdict: Verdict }): JSX.Element {
  return (
    <span className="verdict-tag" data-verdict={verdict}>
      {verdict}
    </span>
  );
}
