// Sanitized markdown rendering for assistant text: marked turns the source into HTML, DOMPurify
// strips anything unsafe, and a small enhancement pass afterwards adds a copy button to every
// code block and keeps wide tables from blowing out the page width.

import { useEffect, useMemo, useRef } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { classNames } from '../utils.js';

// Every link a session's markdown can produce opens in a new tab, never navigates the app away.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

function enhance(container: HTMLElement): () => void {
  const cleanups: Array<() => void> = [];

  container.querySelectorAll('pre').forEach((pre) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'md-code-block';
    pre.replaceWith(wrapper);
    wrapper.appendChild(pre);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'md-copy-btn';
    button.textContent = 'Copy';
    const onClick = (): void => {
      const code = pre.textContent ?? '';
      const clipboard = navigator.clipboard;
      if (!clipboard) return;
      clipboard.writeText(code).then(
        () => {
          button.textContent = 'Copied';
          window.setTimeout(() => {
            button.textContent = 'Copy';
          }, 1200);
        },
        () => {
          /* clipboard denied or unavailable; leave the button as-is */
        },
      );
    };
    button.addEventListener('click', onClick);
    wrapper.appendChild(button);
    cleanups.push(() => button.removeEventListener('click', onClick));
  });

  container.querySelectorAll('table').forEach((table) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'md-table-wrap';
    table.replaceWith(wrapper);
    wrapper.appendChild(table);
  });

  return () => cleanups.forEach((fn) => fn());
}

export function Markdown({ text, className }: { text: string; className?: string }): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const html = useMemo(() => {
    const raw = marked.parse(text, { gfm: true, breaks: true, async: false });
    return DOMPurify.sanitize(raw);
  }, [text]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    return enhance(container);
  }, [html]);

  return <div ref={containerRef} className={classNames('markdown', className)} dangerouslySetInnerHTML={{ __html: html }} />;
}
