// Turns a member's flat transcript items plus its live streaming buffer into the rows the
// Member view actually renders: a tool_use with its matching tool_result attached (Claude Code
// shows a call and its outcome as one thing, not two), and any still-streaming block appended
// at the end. Pure and framework-free so it is easy to reason about and test.

import type { TranscriptItem } from '../../core/types.js';
import type { LiveBlock } from '../state.js';

type UserItem = Extract<TranscriptItem, { kind: 'user' }>;
type TextItem = Extract<TranscriptItem, { kind: 'text' }>;
type ThinkingItem = Extract<TranscriptItem, { kind: 'thinking' }>;
type ToolUseItem = Extract<TranscriptItem, { kind: 'tool_use' }>;
type ToolResultItem = Extract<TranscriptItem, { kind: 'tool_result' }>;
type ResultItem = Extract<TranscriptItem, { kind: 'result' }>;
type SystemItem = Extract<TranscriptItem, { kind: 'system' }>;

export type TranscriptRow =
  | { key: string; type: 'user'; item: UserItem }
  | { key: string; type: 'text'; item: TextItem }
  | { key: string; type: 'thinking'; item: ThinkingItem }
  | { key: string; type: 'tool'; use: ToolUseItem; result: ToolResultItem | null }
  | { key: string; type: 'orphan_result'; item: ToolResultItem }
  | { key: string; type: 'result'; item: ResultItem }
  | { key: string; type: 'system'; item: SystemItem }
  | { key: string; type: 'live'; blockIndex: number; kind: LiveBlock['kind']; text: string };

export function buildTranscriptRows(items: TranscriptItem[], liveBuffer: Record<number, LiveBlock> | undefined): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  const toolRowIndexByUseId = new Map<string, number>();

  items.forEach((item, i) => {
    const key = `${item.kind}-${item.ts}-${i}`;
    switch (item.kind) {
      case 'tool_use':
        toolRowIndexByUseId.set(item.toolUseId, rows.length);
        rows.push({ key, type: 'tool', use: item, result: null });
        break;
      case 'tool_result': {
        const idx = toolRowIndexByUseId.get(item.toolUseId);
        const row = idx !== undefined ? rows[idx] : undefined;
        if (row && row.type === 'tool') {
          rows[idx as number] = { ...row, result: item };
        } else {
          rows.push({ key, type: 'orphan_result', item });
        }
        break;
      }
      case 'user':
        rows.push({ key, type: 'user', item });
        break;
      case 'text':
        rows.push({ key, type: 'text', item });
        break;
      case 'thinking':
        rows.push({ key, type: 'thinking', item });
        break;
      case 'result':
        rows.push({ key, type: 'result', item });
        break;
      case 'system':
        rows.push({ key, type: 'system', item });
        break;
    }
  });

  if (liveBuffer) {
    const blockIndexes = Object.keys(liveBuffer)
      .map(Number)
      .sort((a, b) => a - b);
    for (const blockIndex of blockIndexes) {
      const block = liveBuffer[blockIndex];
      if (!block || block.text.length === 0) continue;
      rows.push({ key: `live-${blockIndex}`, type: 'live', blockIndex, kind: block.kind, text: block.text });
    }
  }

  return rows;
}
