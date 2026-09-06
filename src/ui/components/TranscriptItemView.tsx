import { memo, useState } from 'react';
import type { TranscriptItem } from '../../core/types.js';
import { classNames, deriveToolSummary, firstLine, formatCostUsd, formatTokens, safeStringify, totalTokens } from '../utils.js';
import { Markdown } from './Markdown.js';
import type { TranscriptRow } from './transcriptRows.js';

type ToolUseItem = Extract<TranscriptItem, { kind: 'tool_use' }>;
type ToolResultItem = Extract<TranscriptItem, { kind: 'tool_result' }>;

function formatInput(input: unknown): string {
  return safeStringify(input, 2);
}

function ToolResultBody({ result, standalone }: { result: ToolResultItem; standalone: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className={classNames('t-tool-result', result.isError && 'is-error', standalone && 't-item')}>
      <button type="button" className="t-tool-result-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {result.isError && <span className="t-error-label">error</span>}
        <span className="t-tool-result-firstline">{firstLine(result.text) || '(empty result)'}</span>
        <span className="t-tool-result-expand">{open ? 'collapse' : 'expand'}</span>
      </button>
      {open && <pre className="t-tool-result-pre">{result.text}</pre>}
    </div>
  );
}

function ToolCallRow({ use, result }: { use: ToolUseItem; result: ToolResultItem | null }): JSX.Element {
  const [inputOpen, setInputOpen] = useState(false);
  const summary = deriveToolSummary(use.name, use.input);

  return (
    <div className="t-item t-tool">
      <button type="button" className="t-tool-head" onClick={() => setInputOpen((o) => !o)} aria-expanded={inputOpen}>
        <span className="tool-name-tag">{use.name}</span>
        <span className="t-tool-summary-text" title={summary}>
          {summary}
        </span>
        <span className="t-tool-chevron">{inputOpen ? '▾' : '▸'}</span>
      </button>
      {inputOpen && <pre className="t-tool-input-pre">{formatInput(use.input)}</pre>}
      {result && <ToolResultBody result={result} standalone={false} />}
    </div>
  );
}

function TranscriptRowViewImpl({ row }: { row: TranscriptRow }): JSX.Element | null {
  switch (row.type) {
    case 'user':
      if (row.item.framed) {
        return (
          <div className="t-item t-user framed">
            <span className="t-framed-label">from the board</span>
            <pre className="t-framed-body">{row.item.text}</pre>
          </div>
        );
      }
      return <div className="t-item t-user">{row.item.text}</div>;
    case 'text':
      return (
        <div className="t-item t-text">
          <Markdown text={row.item.text} />
        </div>
      );
    case 'thinking': {
      const text = row.item.text.trim();
      if (!text) return null;
      return (
        <details className="t-item t-thinking">
          <summary>thinking</summary>
          <div className="t-thinking-body">{row.item.text}</div>
        </details>
      );
    }
    case 'tool':
      return <ToolCallRow use={row.use} result={row.result} />;
    case 'orphan_result':
      return <ToolResultBody result={row.item} standalone />;
    case 'result':
      return (
        <div className="t-item t-final">
          {row.item.subtype} · {formatCostUsd(row.item.usage.costUsd)} · {formatTokens(totalTokens(row.item.usage))} tokens · {row.item.usage.turns} turn
          {row.item.usage.turns === 1 ? '' : 's'}
        </div>
      );
    case 'system':
      return <div className="t-item t-system">{row.item.text}</div>;
    case 'live': {
      if (row.text.trim().length === 0) return null;
      if (row.kind === 'thinking') {
        return (
          <div className="t-item t-thinking t-thinking-live">
            <div className="t-thinking-live-label">
              thinking <span className="stream-cursor" aria-hidden="true" />
            </div>
            <div className="t-thinking-body">{row.text}</div>
          </div>
        );
      }
      return (
        <div className="t-item t-text t-text-live">
          <Markdown text={row.text} />
          <span className="stream-cursor" aria-hidden="true" />
        </div>
      );
    }
    default:
      return null;
  }
}

export const TranscriptRowView = memo(TranscriptRowViewImpl);
