// Chia văn bản thành đoạn vừa phải để mỗi mục nhớ nói về một ý và dẫn ngược về đúng chỗ gốc.
import { estimateTokens } from './util.js';

export const MAX_CHARS = 1400;
export const MIN_CHARS = 200;

/** Cắt một khối văn bản dài thành các đoạn ≤ max ký tự, ưu tiên ranh giới đoạn / câu. */
export function splitText(text, max = MAX_CHARS) {
  const clean = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!clean) return [];
  if (clean.length <= max) return [clean];
  const paragraphs = clean.split(/\n{2,}/);
  const out = [];
  let cur = '';
  const flush = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = '';
  };
  const pushLong = (para) => {
    // đoạn dài hơn max: cắt theo câu, rồi theo ký tự
    const sentences = para.split(/(?<=[.!?…。])\s+|\n/);
    for (const s of sentences) {
      if (s.length > max) {
        flush();
        for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max).trim());
      } else if ((cur + ' ' + s).length > max) {
        flush();
        cur = s;
      } else cur = cur ? `${cur} ${s}` : s;
    }
  };
  for (const para of paragraphs) {
    if (para.length > max) {
      flush();
      pushLong(para);
      flush();
    } else if ((cur + '\n\n' + para).length > max) {
      flush();
      cur = para;
    } else cur = cur ? `${cur}\n\n${para}` : para;
  }
  flush();
  return out.filter(Boolean);
}

/**
 * Từ các khối có vị trí (`{ text, loc }`) tạo các đoạn nhớ. Khối ngắn liền nhau CÙNG `group`
 * (ví dụ cùng mục) được gộp để khỏi vụn; khối dài bị cắt, vị trí ghi "(phần 2/3)".
 */
export function makeChunks(blocks, max = MAX_CHARS) {
  const chunks = [];
  let pending = null;
  const flush = () => {
    if (pending) chunks.push({ loc: pending.loc, text: pending.text.trim() });
    pending = null;
  };
  for (const block of blocks) {
    const text = String(block.text ?? '').trim();
    if (!text) continue;
    if (text.length >= max) {
      flush();
      const parts = splitText(text, max);
      parts.forEach((part, i) =>
        chunks.push({
          loc: parts.length > 1 ? `${block.loc} (phần ${i + 1}/${parts.length})` : block.loc,
          text: part,
        }),
      );
      continue;
    }
    if (
      pending &&
      pending.group === block.group &&
      block.group &&
      (pending.text + '\n\n' + text).length <= max
    ) {
      pending.text += `\n\n${text}`;
      pending.loc = block.groupLoc ?? pending.loc;
      continue;
    }
    flush();
    pending = { loc: block.loc, text, group: block.group };
  }
  flush();
  return chunks.filter((c) => c.text.length > 0);
}

export const chunkTokens = (chunks) => chunks.reduce((n, c) => n + estimateTokens(c.text), 0);
