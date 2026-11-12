import type { ReactNode } from 'react';

/**
 * Hiển thị văn bản kiểu Markdown tối giản: khối ``` code, `code` trong dòng, **đậm**.
 * Dựng bằng phần tử React (không dùng innerHTML) nên nội dung agent không chèn được mã.
 */
export function Markdown({ text }: { text: string }) {
  const blocks = text.split(/```/);
  return (
    <div className="md">
      {blocks.map((block, i) => {
        if (i % 2 === 1) {
          const newline = block.indexOf('\n');
          const lang = newline > -1 ? block.slice(0, newline).trim() : '';
          const code = newline > -1 ? block.slice(newline + 1) : block;
          return (
            <pre key={i} className="code" data-lang={lang || undefined}>
              <code>{code.replace(/\n$/, '')}</code>
            </pre>
          );
        }
        return block.trim() ? (
          <p key={i} className="md-text">
            {inline(block.replace(/^\n+|\n+$/g, ''))}
          </p>
        ) : null;
      })}
    </div>
  );
}

function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    if (index > last) nodes.push(text.slice(last, index));
    const token = match[0];
    nodes.push(
      token.startsWith('`') ? (
        <code key={key++} className="inline-code">
          {token.slice(1, -1)}
        </code>
      ) : (
        <strong key={key++}>{token.slice(2, -2)}</strong>
      ),
    );
    last = index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
