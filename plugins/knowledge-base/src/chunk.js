// Chia văn bản thành đoạn vừa phải để mỗi mục nhớ nói về một ý và dẫn ngược về đúng chỗ gốc.
import { estimateTokens } from './util.js';

export const MAX_CHARS = 1400;
export const MIN_CHARS = 200;

/** Từ viết tắt tiếng Việt / Anh kết thúc bằng dấu chấm nhưng KHÔNG hết câu: "TP. Hồ Chí Minh", "Q.1"… */
const ABBREVIATION =
  /(?:^|[\s("'])(?:TP|TX|TT|Tp|Q|P|H|X|Dr|Mr|Mrs|Ms|Prof|ThS|Ths|TS|PGS|GS|BS|KS|CN|vd|VD|tr|St|No|Th|v|vs|etc|ĐT|ĐC|SĐT|Đ\/c)\.$/;
/** Số thứ tự "1." hoặc chữ cái đầu tên "Nguyễn V. An" — dấu chấm không hết câu. */
const ORDINAL_OR_INITIAL = /(?:^|[\s("'])(?:\d{1,3}|\p{Lu})\.$/u;

/**
 * Tách câu mà không cắt giữa "TP. Hồ Chí Minh", "1.250.000đ", "Q.1", "Nguyễn V. An", "3.5".
 * Ranh giới câu = . ! ? … theo sau là khoảng trắng và (chữ hoa / số / ngoặc / gạch đầu dòng), hoặc xuống dòng.
 */
export function splitSentences(text) {
  const out = [];
  let start = 0;
  const re = /([.!?…。])(\s+)|\n/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const end = m.index + (m[1] ? 1 : 0);
    const head = text.slice(start, end);
    if (m[1] === '.' && (ABBREVIATION.test(head) || ORDINAL_OR_INITIAL.test(head))) continue;
    const next = text.slice(m.index + m[0].length, m.index + m[0].length + 1);
    // câu mới thường bắt đầu bằng chữ hoa, số, ngoặc hoặc gạch đầu dòng; chữ thường → chưa hết câu
    if (m[1] && next && /\p{Ll}/u.test(next)) continue;
    if (head.trim()) out.push(head.trim());
    start = m.index + m[0].length;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

/** Cắt chuỗi quá dài thành các phần ≤ max, ưu tiên cắt ở khoảng trắng (không cắt giữa từ / con số). */
export function cutAtSpaces(text, max) {
  const out = [];
  let rest = text.trim();
  while (rest.length > max) {
    let at = rest.lastIndexOf(' ', max);
    if (at < max * 0.5) at = max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

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
    const sentences = splitSentences(para);
    for (const s of sentences) {
      if (s.length > max) {
        flush();
        for (const piece of cutAtSpaces(s, max)) out.push(piece);
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
