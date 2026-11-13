// Tách chữ từ HTML (trang web dán link, file .html) — không cần thư viện: bỏ script / style,
// giữ tiêu đề mục để đánh dấu vị trí, đổi khối thành đoạn văn.

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  copy: '©',
};

function safeChar(code) {
  try {
    return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
  } catch {
    return '';
  }
}

export function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

/** → { title, blocks: [{ text, loc, group }] } theo mục (heading). */
export function htmlToBlocks(html) {
  let s = String(html ?? '');
  const title = decodeEntities(
    (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1] ?? '').replace(/\s+/g, ' '),
  ).trim();
  s = s
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(
      /<(script|style|noscript|svg|template|iframe|head|nav|footer|form)\b[\s\S]*?<\/\1>/gi,
      ' ',
    );
  // Đánh dấu heading bằng ký tự riêng để tách mục.
  s = s.replace(
    /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_, level, inner) => `\n\n\uE001${level}\uE002${inner.replace(/<[^>]+>/g, ' ')}\uE003\n\n`,
  );
  s = s
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(
      /<\/(p|div|section|article|li|tr|table|ul|ol|blockquote|pre|dd|dt|figure|figcaption)>/gi,
      '\n\n',
    )
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s)
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n');

  const blocks = [];
  let path = [];
  let buf = [];
  const flush = () => {
    const text = buf.join('\n\n').trim();
    buf = [];
    if (!text) return;
    const loc = path.length ? `mục: ${path.map((p) => p.text).join(' › ')}` : 'đầu trang';
    blocks.push({ text, loc, group: loc });
  };
  for (const part of s.split(/\n{2,}/)) {
    const m = /^\uE001([1-6])\uE002([\s\S]*?)\uE003$/.exec(part.trim());
    if (m) {
      flush();
      const level = Number(m[1]);
      const text = m[2].replace(/\s+/g, ' ').trim();
      path = path.filter((p) => p.level < level);
      if (text) path.push({ level, text });
    } else if (part.trim()) buf.push(part.trim());
  }
  flush();
  return { title, blocks };
}
