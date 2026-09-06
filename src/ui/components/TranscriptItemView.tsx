import { memo } from 'react';
import type { TranscriptItem } from '../../core/types.js';
import { formatCostUsd, formatTokens, totalTokens } from '../utils.js';

function formatInput(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    return String(input);
  }
}

function TranscriptItemViewImpl({ item }: { item: TranscriptItem }): JSX.Element {
  switch (item.kind) {
    case 'user':
      return (
        <div className={`t-item t-user${item.framed ? ' framed' : ''}`}>
          {item.framed && <span className="t-framed-label">from the board</span>}
          {item.text}
        </div>
      );
    case 'text':
      return <div className="t-item t-text">{item.text}</div>;
    case 'thinking':
      return (
        <details className="t-item t-thinking">
          <summary>thinking</summary>
          <div>{item.text}</div>
        </details>
      );
    case 'tool_use':
      return (
        <details className="t-item t-tool">
          <summary>
            <span className="t-tool-name">{item.name}</span>
            <span style={{ color: 'var(--text-faint)' }}>tool call</span>
          </summary>
          <pre>{formatInput(item.input)}</pre>
        </details>
      );
    case 'tool_result':
      return (
        <details className={`t-item t-result${item.isError ? ' is-error' : ''}`}>
          <summary>
            <span className="t-tool-name">{item.isError ? 'error' : 'result'}</span>
          </summary>
          <pre>{item.text}</pre>
        </details>
      );
    case 'result':
      return (
        <div className="t-item t-final">
          {item.subtype} · {formatCostUsd(item.usage.costUsd)} · {formatTokens(totalTokens(item.usage))} tokens · {item.usage.turns} turn{item.usage.turns === 1 ? '' : 's'}
        </div>
      );
    case 'system':
      return <div className="t-item t-system">{item.text}</div>;
    default:
      return <div className="t-item t-system">unknown item</div>;
  }
}

export const TranscriptItemView = memo(TranscriptItemViewImpl);
