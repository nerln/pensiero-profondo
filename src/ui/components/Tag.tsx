import type { Verb, Verdict } from '../../core/types.js';

export function VerbTag({ verb }: { verb: Verb }): JSX.Element {
  return (
    <span className="tag" data-verb={verb}>
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
