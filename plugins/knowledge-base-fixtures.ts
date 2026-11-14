// Tài liệu mẫu tạo bằng mã cho test của plugin Knowledge Base (không cần file nhị phân trong repo).
import { strToU8, zipSync } from 'fflate';

/** PDF tối thiểu, mỗi chuỗi là một trang (chỉ ASCII để khỏi phụ thuộc font). */
export function makePdf(pages: string[]): Buffer {
  const objects: string[] = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  pages.forEach((text, i) => {
    const stream = `BT /F1 14 Tf 40 700 Td (${text.replace(/[()\\]/g, '')}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
    );
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

export function makeDocx(paragraphs: { text: string; heading?: number }[]): Buffer {
  const body = paragraphs
    .map((p) =>
      p.heading
        ? `<w:p><w:pPr><w:pStyle w:val="Heading${p.heading}"/></w:pPr><w:r><w:t>${p.text}</w:t></w:r></w:p>`
        : `<w:p><w:r><w:t>${p.text}</w:t></w:r></w:p>`,
    )
    .join('');
  const xml = `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`;
  return Buffer.from(zipSync({ 'word/document.xml': strToU8(xml) }));
}

export function makeXlsx(rows: string[][]): Buffer {
  const strings: string[] = [];
  const idx = (s: string) => {
    const i = strings.indexOf(s);
    if (i >= 0) return i;
    strings.push(s);
    return strings.length - 1;
  };
  const colName = (i: number) => String.fromCharCode(65 + i);
  const sheet = rows
    .map(
      (r, ri) =>
        `<row r="${ri + 1}">${r.map((c, ci) => `<c r="${colName(ci)}${ri + 1}" t="s"><v>${idx(c)}</v></c>`).join('')}</row>`,
    )
    .join('');
  return Buffer.from(
    zipSync({
      'xl/workbook.xml': strToU8(
        '<workbook><sheets><sheet name="Giá" sheetId="1" r:id="rId1"/></sheets></workbook>',
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
      'xl/sharedStrings.xml': strToU8(
        `<sst>${strings.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`,
      ),
      'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${sheet}</sheetData></worksheet>`),
    }),
  );
}
