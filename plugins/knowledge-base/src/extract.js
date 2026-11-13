// Tách tài liệu thành các khối có vị trí gốc (`loc`): trang, mục, dòng, ô tính.
// Mọi thư viện chạy cục bộ trong tiến trình plugin (không gửi tài liệu đi đâu để tách chữ).
import { unzipSync, strFromU8 } from 'fflate';
import { htmlToBlocks, decodeEntities } from './html.js';
import { extOf } from './util.js';

export const DOC_EXTENSIONS = [
  'txt',
  'md',
  'markdown',
  'log',
  'csv',
  'tsv',
  'json',
  'html',
  'htm',
  'pdf',
  'docx',
  'xlsx',
];
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'];
export const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac'];
export const IMAGE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** Loại nguồn theo đuôi file: doc | image | video | audio | null (không hỗ trợ). */
export function kindOf(name) {
  const e = extOf(name);
  if (DOC_EXTENSIONS.includes(e)) return 'doc';
  if (IMAGE_EXTENSIONS.includes(e)) return 'image';
  if (VIDEO_EXTENSIONS.includes(e)) return 'video';
  if (AUDIO_EXTENSIONS.includes(e)) return 'audio';
  return null;
}

function decodeText(bytes) {
  const buf = Buffer.from(bytes);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  const text = buf.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// ---------------------------------------------------------------- văn bản, Markdown

function plainBlocks(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let start = 0;
  let buf = [];
  const flush = (end) => {
    const t = buf.join('\n').trim();
    buf = [];
    if (t) {
      blocks.push({
        text: t,
        loc: start + 1 === end ? `dòng ${end}` : `dòng ${start + 1}–${end}`,
        group: 'plain',
      });
    }
  };
  lines.forEach((line, i) => {
    if (!line.trim()) {
      flush(i);
      start = i + 1;
    } else {
      if (buf.length === 0) start = i;
      buf.push(line);
    }
  });
  flush(lines.length);
  return blocks;
}

function markdownBlocks(text) {
  const blocks = [];
  let path = [];
  let buf = [];
  let inCode = false;
  const flush = () => {
    const t = buf.join('\n').trim();
    buf = [];
    if (!t) return;
    const loc = path.length ? `mục: ${path.map((p) => p.text).join(' › ')}` : 'đầu tài liệu';
    blocks.push({ text: t, loc, group: loc });
  };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*```/.test(line)) inCode = !inCode;
    const h = !inCode && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      const level = h[1].length;
      path = path.filter((p) => p.level < level);
      path.push({ level, text: h[2].trim() });
    } else buf.push(line);
  }
  flush();
  return blocks;
}

// ---------------------------------------------------------------- CSV

export function parseCsv(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/\r\n?/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

/** Bảng → khối: mỗi khối là một nhóm dòng kèm tên cột, ghi lại dòng nào trong file gốc. */
function tableBlocks(rows, perBlock = 12) {
  if (rows.length === 0) return [];
  const header = rows[0].map((c) => c.trim());
  const blocks = [];
  for (let i = 1; i < rows.length; i += perBlock) {
    const slice = rows.slice(i, i + perBlock);
    const lines = slice.map((r) =>
      header
        .map((h, j) => `${h || `cột ${j + 1}`}: ${(r[j] ?? '').trim()}`)
        .filter((x) => !x.endsWith(': '))
        .join('; '),
    );
    blocks.push({
      text: lines.join('\n'),
      loc: `dòng ${i + 1}–${i + slice.length}`,
      group: null,
    });
  }
  if (rows.length === 1) blocks.push({ text: header.join('; '), loc: 'dòng 1', group: null });
  return blocks;
}

// ---------------------------------------------------------------- DOCX

function xmlText(xml) {
  return decodeEntities(
    xml
      .replace(/<w:tab\b[^>]*\/>/g, '\t')
      .replace(/<w:br\b[^>]*\/>/g, '\n')
      .replace(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g, '$1\u0000')
      .replace(/<[^>]+>/g, '')
      .replace(/\u0000/g, ''),
  );
}

function docxBlocks(bytes) {
  const files = unzipSync(new Uint8Array(bytes), { filter: (f) => f.name === 'word/document.xml' });
  const doc = files['word/document.xml'];
  if (!doc) throw new Error('File DOCX không có nội dung (word/document.xml).');
  const xml = strFromU8(doc);
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml;
  const blocks = [];
  let path = [];
  let buf = [];
  const flush = () => {
    const t = buf.join('\n').trim();
    buf = [];
    if (!t) return;
    const loc = path.length ? `mục: ${path.map((p) => p.text).join(' › ')}` : 'đầu tài liệu';
    blocks.push({ text: t, loc, group: loc });
  };
  // Duyệt tuần tự đoạn <w:p> và bảng <w:tbl> để giữ đúng thứ tự.
  const re = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g;
  for (const m of body.matchAll(re)) {
    const part = m[0];
    if (part.startsWith('<w:tbl>')) {
      const rows = [...part.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((r) =>
        [...r[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((c) =>
          xmlText(c[0]).replace(/\s+/g, ' ').trim(),
        ),
      );
      if (rows.length) buf.push(rows.map((r) => r.join(' | ')).join('\n'));
      continue;
    }
    const text = xmlText(part).trim();
    if (!text) continue;
    const style = /<w:pStyle w:val="([^"]+)"/.exec(part)?.[1] ?? '';
    const heading = /^(?:Heading|Tiêu ?đề)\s*(\d)$/i.exec(style);
    const level = heading ? heading[1] : /^Title$/i.test(style) ? '1' : null;
    if (level !== null && text.length < 200) {
      flush();
      const lv = Number(level);
      path = path.filter((p) => p.level < lv);
      path.push({ level: lv, text });
    } else buf.push(text);
  }
  flush();
  return blocks;
}

// ---------------------------------------------------------------- XLSX

function colName(index) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
const colIndex = (ref) =>
  [...ref.replace(/\d+/g, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

function xlsxBlocks(bytes) {
  const files = unzipSync(new Uint8Array(bytes), {
    filter: (f) =>
      /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(
        f.name,
      ),
  });
  const get = (name) => (files[name] ? strFromU8(files[name]) : '');
  const shared = [...get('xl/sharedStrings.xml').matchAll(/<si\b[\s\S]*?<\/si>/g)].map((m) =>
    decodeEntities([...m[0].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')),
  );
  const rels = Object.fromEntries(
    [...get('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)].map((m) => [
      /Id="([^"]+)"/.exec(m[0])?.[1],
      /Target="([^"]+)"/.exec(m[0])?.[1],
    ]),
  );
  const blocks = [];
  const sheets = [...get('xl/workbook.xml').matchAll(/<sheet\b[^>]*>/g)];
  sheets.forEach((tag, si) => {
    const name = decodeEntities(/name="([^"]*)"/.exec(tag[0])?.[1] ?? `Sheet${si + 1}`);
    const rid = /r:id="([^"]+)"/.exec(tag[0])?.[1];
    const target = (rid && rels[rid]) || `worksheets/sheet${si + 1}.xml`;
    const xml = get(`xl/${target.replace(/^\/?(xl\/)?/, '')}`);
    if (!xml) return;
    const rows = [];
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = /r="([A-Z]+\d+)"/.exec(c[1])?.[1];
        if (!ref) continue;
        const type = /t="([^"]+)"/.exec(c[1])?.[1];
        const inner = c[2] ?? '';
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        let value = '';
        if (type === 's' && v !== undefined) value = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') {
          value = decodeEntities(
            [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''),
          );
        } else if (v !== undefined) value = decodeEntities(v);
        cells[colIndex(ref)] = value;
      }
      const rowNo = Number(/\br="(\d+)"/.exec(r[0])?.[1] ?? rows.length + 1);
      if (cells.some((x) => x !== undefined && String(x).trim())) rows.push({ rowNo, cells });
    }
    if (rows.length === 0) return;
    const width = Math.max(...rows.map((r) => r.cells.length));
    const header = rows[0].cells;
    const body = rows.slice(1);
    const per = 12;
    for (let i = 0; i < body.length; i += per) {
      const slice = body.slice(i, i + per);
      const lines = slice.map((row) =>
        Array.from({ length: width }, (_, j) => {
          const h = String(header[j] ?? '').trim() || colName(j);
          const val = String(row.cells[j] ?? '').trim();
          return val ? `${h}: ${val}` : '';
        })
          .filter(Boolean)
          .join('; '),
      );
      const first = slice[0].rowNo;
      const last = slice[slice.length - 1].rowNo;
      blocks.push({
        text: lines.join('\n'),
        loc: `${name}!A${first}:${colName(width - 1)}${last}`,
        group: null,
      });
    }
    if (body.length === 0) {
      blocks.push({ text: header.filter(Boolean).join('; '), loc: `${name}!A1`, group: null });
    }
  });
  return blocks;
}

// ---------------------------------------------------------------- PDF

async function pdfBlocks(bytes) {
  const { getDocumentProxy, extractText } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text, totalPages } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [String(text)];
  const blocks = pages.map((t, i) => ({
    text: String(t)
      .replace(/[ \t]+/g, ' ')
      .trim(),
    loc: `trang ${i + 1}`,
    group: null,
  }));
  return { blocks: blocks.filter((b) => b.text), totalPages };
}

// ---------------------------------------------------------------- Cửa vào

/**
 * Tách một tài liệu. `bytes`: Buffer. Trả `{ blocks, warnings, title? }`.
 * Ném lỗi đọc được nếu file hỏng hoặc định dạng không hỗ trợ.
 */
export async function extractDocument(bytes, name) {
  const ext = extOf(name);
  const warnings = [];
  switch (ext) {
    case 'pdf': {
      const { blocks, totalPages } = await pdfBlocks(bytes);
      if (blocks.length === 0) {
        warnings.push(
          'PDF này không có chữ để đọc (có thể là bản quét / ảnh chụp). NSA chưa nhận dạng chữ trong PDF quét: hãy xuất từng trang thành ảnh rồi nạp ảnh để model nhìn ảnh đọc.',
        );
      } else if (blocks.length < totalPages / 2) {
        warnings.push(
          `Chỉ ${blocks.length}/${totalPages} trang có chữ; các trang còn lại có thể là ảnh quét và bị bỏ qua.`,
        );
      }
      return { blocks, warnings };
    }
    case 'docx':
      return { blocks: docxBlocks(bytes), warnings };
    case 'xlsx':
      return { blocks: xlsxBlocks(bytes), warnings };
    case 'csv':
    case 'tsv':
      return {
        blocks: tableBlocks(parseCsv(decodeText(bytes), ext === 'tsv' ? '\t' : ',')),
        warnings,
      };
    case 'html':
    case 'htm': {
      const { title, blocks } = htmlToBlocks(decodeText(bytes));
      return { blocks, warnings, ...(title ? { title } : {}) };
    }
    case 'md':
    case 'markdown':
      return { blocks: markdownBlocks(decodeText(bytes)), warnings };
    case 'txt':
    case 'log':
    case 'json':
      return { blocks: plainBlocks(decodeText(bytes)), warnings };
    default:
      throw new Error(
        `Chưa hỗ trợ định dạng .${ext || '?'} (hỗ trợ: ${DOC_EXTENSIONS.join(', ')}).`,
      );
  }
}
