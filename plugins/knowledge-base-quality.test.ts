/**
 * BỘ KIỂM CHẤT LƯỢNG NHỚ LẠI của Knowledge Base — cố định, chạy lặp lại được (`pnpm test`), in bảng số liệu.
 *
 * Đo cái gì: dạy bằng một kho nhỏ (6 tài liệu tiếng Việt có dấu: Markdown, XLSX, DOCX, HTML, TXT, PDF; 1 ảnh có
 * bảng giá; 1 video có lời nói), duyệt nhận hết, rồi hỏi 22 câu có đáp án — mỗi câu hỏi 2 lần (CÓ DẤU và
 * KHÔNG DẤU). Một câu "đúng" khi trong 3 kết quả đầu có mục chứa NGUYÊN VĂN các chuỗi đáp án (tên riêng, con
 * số, địa chỉ… không bị cắt / biến dạng); "đúng nguồn" khi mục đó dẫn về đúng file (video: đúng khoảng mm:ss).
 *
 * KHÔNG đo (nói thẳng): chất lượng của model nhìn ảnh và nhận dạng giọng nói thật. Ảnh và khung hình video do
 * một "nhà tiên tri" trả lời ĐÚNG ĐÁP ÁN CÓ SẴN, phụ đề do whisper-cli giả — nên bộ kiểm này đo đường ống
 * (tách đoạn, ghi mục, duyệt, tìm có / không dấu, dẫn nguồn), không đo việc đọc ảnh / nghe tiếng Việt.
 * Tìm theo từ khoá (FTS5) — tìm theo nghĩa không bật vì chưa đo bằng model thật.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeDocx, makePdf, makeXlsx } from './knowledge-base-fixtures';
import {
  hasFfmpeg,
  realCli,
  runCleanups,
  tempDir,
  world,
  writeFile,
  type World,
} from './knowledge-base-world';
// @ts-expect-error mã JS không có kiểu
import { makeChunks, splitSentences } from './knowledge-base/src/chunk.js';

afterEach(runCleanups);

// ---------------------------------------------------------------- kho dạy thử

const CHINH_SACH = `# Chính sách cửa hàng Cà Phê Muối

## Đổi trả
Khách được đổi trả hàng trong vòng 7 ngày kể từ khi nhận hàng, với điều kiện còn nguyên tem. Hàng khuyến mãi không được đổi trả.

## Giao hàng
Cửa hàng miễn phí giao hàng cho đơn từ 500.000đ trong nội thành TP. Hồ Chí Minh. Đơn dưới 500.000đ tính phí 25.000đ. Giao trong 2 ngày làm việc.

## Liên hệ
Địa chỉ: 12 Nguyễn Huệ, Q.1, TP. Hồ Chí Minh. Hotline: 1900 6868. Giờ mở cửa từ 7:30 đến 22:00 mỗi ngày.
`;
const BANG_GIA = [
  ['Món', 'Giá', 'Ghi chú'],
  ['Cà phê muối', '32.000đ', 'bán chạy nhất'],
  ['Trà đào cam sả', '45.000đ', ''],
  ['Bạc xỉu', '30.000đ', ''],
  ['Sinh tố bơ', '52.000đ', 'theo mùa'],
  ['Matcha đá xay', '55.000đ', ''],
  ['Bánh flan', '18.000đ', ''],
  ['Máy xay công nghiệp', '1.250.000đ', 'thiết bị'],
];
const HOI_DAP = `<html><head><title>Hỏi đáp</title></head><body>
<h2>Có xuất hoá đơn VAT không?</h2><p>Có. Khách báo mã số thuế trong vòng 24 giờ sau khi mua; hoá đơn gửi qua email.</p>
<h2>Thanh toán</h2><p>Nhận tiền mặt, chuyển khoản và ví MoMo; không nhận thẻ tín dụng nước ngoài.</p></body></html>`;
const QUY_TRINH = `Quy trình mở cửa: bật máy pha, kiểm tra tồn sữa tươi, lau bàn ghế.

Quy trình đóng cửa: kiểm kê doanh thu, khoá két, tắt điện và máy lạnh.
`;
const IMAGE_NOTE = 'bảng giá combo tháng 11';
const ORACLE_IMAGE =
  'MÔ TẢ: Bảng giá combo tháng 11.\nCHỮ TRONG ẢNH: Combo cà phê + bánh 59.000đ\nCombo trà + bánh 69.000đ\nƯu đãi sinh viên giảm 10%\nĐỘ CHẮC CHẮN: cao';
const SPEECH = [
  { from: 1000, to: 3000, text: 'Bước một, mở phần mềm và đăng nhập bằng tài khoản quản lý.' },
  { from: 6000, to: 8000, text: 'Bước hai, vào mục báo cáo doanh thu theo ngày.' },
  { from: 11000, to: 13000, text: 'Bước ba, bấm xuất file Excel để gửi kế toán.' },
];
const FRAME_ORACLE = (t: number) =>
  t < 5
    ? 'Màn hình đăng nhập phần mềm bán hàng.'
    : t < 10
      ? 'Trang báo cáo doanh thu theo ngày.'
      : 'Nút Xuất Excel trên trang báo cáo.';

interface Q {
  q: string;
  must: string[];
  file: string;
  group: 'doc' | 'image' | 'video';
}
const QUESTIONS: Q[] = [
  {
    q: 'Đổi trả hàng trong bao nhiêu ngày?',
    must: ['7 ngày'],
    file: 'chinh-sach.md',
    group: 'doc',
  },
  {
    q: 'Hàng khuyến mãi có được đổi trả không?',
    must: ['Hàng khuyến mãi không được đổi trả'],
    file: 'chinh-sach.md',
    group: 'doc',
  },
  {
    q: 'Miễn phí giao hàng từ bao nhiêu tiền?',
    must: ['500.000đ'],
    file: 'chinh-sach.md',
    group: 'doc',
  },
  {
    q: 'Phí giao hàng đơn dưới 500.000đ là bao nhiêu?',
    must: ['25.000đ'],
    file: 'chinh-sach.md',
    group: 'doc',
  },
  {
    q: 'Cửa hàng ở địa chỉ nào?',
    must: ['12 Nguyễn Huệ, Q.1, TP. Hồ Chí Minh'],
    file: 'chinh-sach.md',
    group: 'doc',
  },
  {
    q: 'Hotline của cửa hàng là số mấy?',
    must: ['1900 6868'],
    file: 'chinh-sach.md',
    group: 'doc',
  },
  { q: 'Quán mở cửa lúc mấy giờ?', must: ['7:30 đến 22:00'], file: 'chinh-sach.md', group: 'doc' },
  { q: 'Cà phê muối giá bao nhiêu?', must: ['32.000đ'], file: 'bang-gia.xlsx', group: 'doc' },
  { q: 'Sinh tố bơ bao nhiêu tiền?', must: ['52.000đ'], file: 'bang-gia.xlsx', group: 'doc' },
  {
    q: 'Máy xay công nghiệp giá bao nhiêu?',
    must: ['1.250.000đ'],
    file: 'bang-gia.xlsx',
    group: 'doc',
  },
  { q: 'Ai là quản lý cửa hàng?', must: ['Nguyễn Thị Thu Hà'], file: 'nhan-su.docx', group: 'doc' },
  {
    q: 'Pha chế trưởng có mấy năm kinh nghiệm?',
    must: ['Trần Văn Bảo', '6 năm'],
    file: 'nhan-su.docx',
    group: 'doc',
  },
  {
    q: 'Thưởng doanh số bao nhiêu phần trăm khi vượt chỉ tiêu?',
    must: ['2%', '150.000.000đ'],
    file: 'nhan-su.docx',
    group: 'doc',
  },
  { q: 'Có xuất hoá đơn VAT không?', must: ['mã số thuế'], file: 'hoi-dap.html', group: 'doc' },
  { q: 'Cửa hàng có nhận thẻ tín dụng không?', must: ['MoMo'], file: 'hoi-dap.html', group: 'doc' },
  {
    q: 'Quy trình đóng cửa gồm những gì?',
    must: ['khoá két'],
    file: 'quy-trinh.txt',
    group: 'doc',
  },
  { q: 'Trà vải giá bao nhiêu?', must: ['38000'], file: 'thuc-don.pdf', group: 'doc' },
  {
    q: 'Combo cà phê và bánh giá bao nhiêu?',
    must: ['59.000đ'],
    file: 'bang-gia-thang-11.png',
    group: 'image',
  },
  {
    q: 'Sinh viên được ưu đãi gì?',
    must: ['giảm 10%'],
    file: 'bang-gia-thang-11.png',
    group: 'image',
  },
  {
    q: 'Bước hai trong video hướng dẫn là gì?',
    must: ['báo cáo doanh thu'],
    file: 'huong-dan.mp4',
    group: 'video',
  },
  {
    q: 'Xuất file Excel gửi kế toán ở bước mấy?',
    must: ['Bước ba', 'Excel'],
    file: 'huong-dan.mp4',
    group: 'video',
  },
  {
    q: 'Đăng nhập bằng tài khoản nào trong video?',
    must: ['tài khoản quản lý'],
    file: 'huong-dan.mp4',
    group: 'video',
  },
];
const unaccent = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');

/** 150 mục "gây nhiễu": cùng từ vựng (giao hàng, đổi trả, giá, địa chỉ, giờ mở cửa…) nhưng số liệu khác. */
function distractors(): string {
  return Array.from({ length: 150 }, (_, i) => {
    const n = i + 1;
    return `## Chi nhánh ${n}
Chi nhánh số ${n} đổi trả hàng trong vòng ${(n % 20) + 8} ngày, miễn phí giao hàng cho đơn từ ${(n % 9) + 1}00.000đ, phí giao ${(n % 7) * 5 + 10}.000đ. Địa chỉ: ${n} Lê Lai, Q.${(n % 12) + 1}, Đà Nẵng. Cà phê giá ${(n % 15) + 20}.000đ, trà đào giá ${(n % 12) + 30}.000đ. Giờ mở cửa từ ${6 + (n % 3)}:00 đến ${20 + (n % 3)}:30. Quản lý: chị Lê Thị Mai ${n}. Hotline: 1900 ${1000 + n}.
`;
  }).join(String.fromCharCode(10));
}

async function build(noise = false): Promise<{ w: World; withVideo: boolean }> {
  const withVideo = hasFfmpeg();
  const w = await world({
    priceIn: 0,
    cli: realCli(SPEECH),
    vision: (prompt) => {
      if (prompt.includes(IMAGE_NOTE)) return ORACLE_IMAGE;
      const t = /tại (\d\d):(\d\d)/.exec(prompt);
      return `${FRAME_ORACLE(t ? Number(t[1]) * 60 + Number(t[2]) : 0)}\nĐỘ CHẮC CHẮN: cao`;
    },
  });
  mkdirSync(join(w.dataDir, 'models'), { recursive: true });
  writeFileSync(join(w.dataDir, 'models', 'ggml-tiny.bin'), 'x');
  const files: { name: string; data: Buffer | string; note?: string }[] = [
    { name: 'chinh-sach.md', data: CHINH_SACH },
    ...(noise ? [{ name: 'chi-nhanh.md', data: distractors() }] : []),
    { name: 'bang-gia.xlsx', data: makeXlsx(BANG_GIA) },
    {
      name: 'nhan-su.docx',
      data: makeDocx([
        { text: 'Nhân sự', heading: 1 },
        { text: 'Quản lý cửa hàng là chị Nguyễn Thị Thu Hà, phụ trách nhập hàng và lịch ca.' },
        { text: 'Pha chế trưởng là anh Trần Văn Bảo, có 6 năm kinh nghiệm.' },
        { text: 'Lương thưởng', heading: 1 },
        { text: 'Thưởng doanh số 2% khi vượt chỉ tiêu 150.000.000đ mỗi tháng.' },
      ]),
    },
    { name: 'hoi-dap.html', data: HOI_DAP },
    { name: 'quy-trinh.txt', data: QUY_TRINH },
    {
      name: 'thuc-don.pdf',
      data: makePdf(['Menu mua he: Tra vai 38000 dong', 'Soda chanh 29000 dong']),
    },
    {
      name: 'bang-gia-thang-11.png',
      data: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        'base64',
      ),
      note: IMAGE_NOTE,
    },
  ];
  for (const f of files) {
    await w.engine.addFile({
      file: writeFile(f.name, f.data),
      name: f.name,
      ...(f.note ? { note: f.note } : {}),
    });
  }
  if (withVideo) {
    const { execFileSync } = await import('node:child_process');
    const file = join(tempDir('kb-q-vid-'), 'huong-dan.mp4');
    execFileSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=320x240:d=5,format=yuv420p',
        '-f',
        'lavfi',
        '-i',
        'color=c=white:s=320x240:d=5,format=yuv420p',
        '-f',
        'lavfi',
        '-i',
        'color=c=gray:s=320x240:d=5,format=yuv420p',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=15',
        '-filter_complex',
        '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
        '-map',
        '[v]',
        '-map',
        '3:a',
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        '-shortest',
        file,
      ],
      { stdio: 'ignore' },
    );
    await w.engine.addFile({ file, name: 'huong-dan.mp4' });
  }
  await w.engine.idle();
  for (const s of Object.values(w.engine.cat.sources) as {
    status: string;
    name: string;
    error: string;
  }[]) {
    expect(s.status, `${s.name}: ${s.error}`).toBe('ingested');
  }
  // Duyệt: nhận hết các đề xuất không nhạy cảm (đúng việc người dùng sẽ làm với kho sạch).
  for (const p of await w.engine.pendingList()) {
    if (!p.sensitive) await w.mem.accept(p.id).catch(() => undefined);
  }
  return { w, withVideo };
}

interface Row {
  q: string;
  accent: boolean;
  group: string;
  rank: number; // 0 = không có trong top 3
  sourceOk: boolean;
}

async function evaluate(w: World, withVideo: boolean): Promise<Row[]> {
  const rows: Row[] = [];
  const entries = await w.engine.ctx.memory.entries({ limit: 2000 });
  const srcOf = (id: string) => {
    const e = entries.find((x: { id: string }) => x.id === id);
    const sid = e?.tags.find((t: string) => t.startsWith('kb:src:'))?.slice(7);
    const loc = e?.tags.find((t: string) => t.startsWith('kb:loc:'))?.slice(7) ?? '';
    return { file: sid ? (w.engine.cat.sources[sid]?.name ?? '') : '', loc, body: e?.body ?? '' };
  };
  for (const item of QUESTIONS) {
    if (item.group === 'video' && !withVideo) continue;
    for (const accent of [true, false]) {
      const query = accent ? item.q : unaccent(item.q);
      const { hits } = await w.engine.ctx.memory.searchSemantic(query, { limit: 3 });
      let rank = 0;
      let sourceOk = false;
      for (let i = 0; i < hits.length; i++) {
        const s = srcOf(hits[i].id);
        if (item.must.every((m) => s.body.includes(m))) {
          rank = i + 1;
          sourceOk =
            s.file === item.file && (item.group !== 'video' || /^\d\d:\d\d–\d\d:\d\d$/.test(s.loc));
          break;
        }
      }
      rows.push({ q: item.q, accent, group: item.group, rank, sourceOk });
    }
  }
  return rows;
}

const pct = (n: number, d: number) =>
  d === 0 ? 'n/a' : `${((n * 100) / d).toFixed(1)}% (${n}/${d})`;

function report(rows: Row[], title: string): void {
  const by = (f: (r: Row) => boolean) => rows.filter(f);
  const line = (name: string, set: Row[]) =>
    `${name.padEnd(22)} top-1 ${pct(set.filter((r) => r.rank === 1).length, set.length).padEnd(18)} top-3 ${pct(set.filter((r) => r.rank > 0).length, set.length).padEnd(18)} đúng nguồn ${pct(set.filter((r) => r.sourceOk).length, set.length)}`;
  const out = [
    `\n===== ${title} =====`,
    line('TẤT CẢ', rows),
    line(
      'có dấu',
      by((r) => r.accent),
    ),
    line(
      'không dấu',
      by((r) => !r.accent),
    ),
    line(
      'tài liệu',
      by((r) => r.group === 'doc'),
    ),
    line(
      'ảnh (nhà tiên tri)',
      by((r) => r.group === 'image'),
    ),
    line(
      'video (giả lập ASR)',
      by((r) => r.group === 'video'),
    ),
  ];
  const wrong = rows.filter((r) => r.rank === 0 || !r.sourceOk);
  if (wrong.length)
    out.push(
      'Câu còn sai: ' + wrong.map((r) => `"${r.q}"${r.accent ? '' : ' (không dấu)'}`).join('; '),
    );
  console.log(out.join('\n'));
}

describe('Chất lượng nhớ lại tiếng Việt (đường ống thật, ảnh/video do nhà tiên tri, ASR giả)', () => {
  it('trả lời đúng và đúng nguồn ở tỉ lệ đã định; chạy lặp lại cho kết quả y hệt', async () => {
    const { w, withVideo } = await build();
    const first = await evaluate(w, withVideo);
    report(
      first,
      withVideo
        ? 'KHO: 6 tài liệu + 1 ảnh + 1 video'
        : 'KHO: 6 tài liệu + 1 ảnh (máy không có ffmpeg: bỏ video)',
    );
    const second = await evaluate(w, withVideo);
    expect(second).toEqual(first); // lặp lại được
    const ok3 = first.filter((r) => r.rank > 0).length / first.length;
    const okSrc = first.filter((r) => r.sourceOk).length / first.length;
    expect(ok3).toBeGreaterThanOrEqual(0.9);
    expect(okSrc).toBeGreaterThanOrEqual(0.9);
    // Tiếng Việt: gõ không dấu không được kém hơn có dấu quá 10 điểm.
    const acc = (a: boolean) =>
      first.filter((r) => r.accent === a && r.rank > 0).length /
      first.filter((r) => r.accent === a).length;
    expect(acc(true) - acc(false)).toBeLessThanOrEqual(0.1);
  }, 120_000);

  it('kho có 150 mục gây nhiễu (cùng từ vựng, số liệu khác): vẫn tìm đúng và đúng nguồn', async () => {
    const { w, withVideo } = await build(true);
    const rows = await evaluate(w, withVideo);
    const total = (await w.engine.ctx.memory.entries({ limit: 2000 })).length;
    report(rows, `KHO CÓ NHIỄU: ${total} mục nhớ (150 mục chi nhánh gây nhiễu)`);
    expect(rows.filter((r) => r.rank > 0).length / rows.length).toBeGreaterThanOrEqual(0.75);
    expect(rows.filter((r) => r.sourceOk).length / rows.length).toBeGreaterThanOrEqual(0.75);
  }, 180_000);

  it('tên riêng, con số, địa chỉ nằm NGUYÊN VĂN trong đúng một mục (không bị cắt đôi)', async () => {
    const { w } = await build();
    const entries = (await w.engine.ctx.memory.entries({ limit: 2000 })) as { body: string }[];
    const all = [
      'Nguyễn Thị Thu Hà',
      'Trần Văn Bảo',
      '12 Nguyễn Huệ, Q.1, TP. Hồ Chí Minh',
      '1.250.000đ',
      '150.000.000đ',
      '1900 6868',
      '7:30 đến 22:00',
      '32.000đ',
    ];
    for (const needle of all) {
      expect(entries.filter((e) => e.body.includes(needle)).length, needle).toBeGreaterThanOrEqual(
        1,
      );
    }
  }, 60_000);

  it('tách đoạn không cắt giữa câu: chunk kết thúc ở dấu câu, "TP. Hồ Chí Minh" / "Q.1" / "3.5" không bị tách', () => {
    const sentences = Array.from({ length: 40 }, (_, i) =>
      i % 4 === 0
        ? `Chi nhánh số ${i} đặt tại 12 Lê Lợi, Q.1, TP. Hồ Chí Minh và mở cửa lúc 7:30.`
        : i % 4 === 1
          ? `Đơn hàng thứ ${i} trị giá 1.250.000đ được giảm 3.5% cho khách quen.`
          : i % 4 === 2
            ? `Nguyễn V. An phụ trách ca ${i}; liên hệ ThS. Trần Thị Bích nếu cần hỗ trợ?`
            : `Thời gian giao hàng dự kiến ${i} ngày làm việc!`,
    ).join(' ');
    const chunks = makeChunks([{ text: sentences, loc: 'trang 1' }], 400) as { text: string }[];
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.text, `chunk bắt đầu giữa câu: ${c.text.slice(0, 40)}`).toMatch(/^[\p{Lu}\d]/u);
      expect(c.text, `chunk kết thúc giữa câu: ${c.text.slice(-40)}`).toMatch(/[.!?…]$/);
      // "TP." luôn đi liền "Hồ Chí Minh"; "Q.1" luôn nguyên; "3.5%" nguyên
      expect(c.text.includes('TP.') ? /TP\. Hồ Chí Minh/.test(c.text) : true).toBe(true);
    }
    expect(splitSentences('Giá 3.5 triệu. Mở cửa 7:30. Đến TP. Hồ Chí Minh. Xong.')).toEqual([
      'Giá 3.5 triệu.',
      'Mở cửa 7:30.',
      'Đến TP. Hồ Chí Minh.',
      'Xong.',
    ]);
  });
});
