/**
 * Plugin Knowledge Base (giai đoạn 5, ADR-0014). Hai lớp kiểm:
 * 1. Mô-đun thuần + Engine với NSA Mem THẬT (MemoryService + cầu nối plugin → hộp duyệt, tự duyệt,
 *    xoá / hoàn tác) và model GIẢ (không có key nhìn ảnh thật — xem ADR-0014 mục "Chưa chạy thật").
 * 2. Plugin đã đóng gói (main.js) chạy trong PluginHost thật: tiến trình riêng, `node --permission`,
 *    cổng MCP — trong plugins/knowledge-base-host.test.ts.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeDocx, makePdf, makeXlsx } from './knowledge-base-fixtures';
import { afterEach, describe, expect, it } from 'vitest';
import { localIdentity, memoryAuditLog, personalPolicy } from '@nsa/core';
import { MemoryService } from '@nsa/memory';
import { createMemoryBridge } from '@nsa/plugin-host';
// @ts-expect-error mã JS không có kiểu
import { makeChunks, splitText } from './knowledge-base/src/chunk.js';
// @ts-expect-error mã JS không có kiểu
import { Engine, parseImageReply } from './knowledge-base/src/engine.js';
// @ts-expect-error mã JS không có kiểu
import { extractDocument, kindOf, parseCsv } from './knowledge-base/src/extract.js';
// @ts-expect-error mã JS không có kiểu
import { buildWindows, parseShowinfo, parseWhisperJson } from './knowledge-base/src/media.js';
// @ts-expect-error mã JS không có kiểu
import { detectSensitive, maskSensitive } from './knowledge-base/src/sensitive.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------- tài liệu mẫu

describe('tách tài liệu (cục bộ)', () => {
  it('nhận đuôi file và loại nguồn', () => {
    expect(kindOf('a.PDF')).toBe('doc');
    expect(kindOf('x.png')).toBe('image');
    expect(kindOf('v.mp4')).toBe('video');
    expect(kindOf('s.mp3')).toBe('audio');
    expect(kindOf('lạ.exe')).toBeNull();
  });

  it('PDF: mỗi trang một khối có vị trí "trang N"', async () => {
    const { blocks } = await extractDocument(
      makePdf(['Trang mot noi ve gia ca phe', 'Trang hai noi ve giao hang']),
      'a.pdf',
    );
    expect(blocks.map((b: { loc: string }) => b.loc)).toEqual(['trang 1', 'trang 2']);
    expect(blocks[0].text).toContain('gia ca phe');
    expect(blocks[1].text).toContain('giao hang');
  });

  it('DOCX: tiêu đề thành vị trí "mục: A › B"', async () => {
    const { blocks } = await extractDocument(
      makeDocx([
        { text: 'Chính sách', heading: 1 },
        { text: 'Đổi trả', heading: 2 },
        { text: 'Đổi trả trong 7 ngày kể từ khi nhận hàng.' },
      ]),
      'cs.docx',
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].loc).toBe('mục: Chính sách › Đổi trả');
    expect(blocks[0].text).toContain('7 ngày');
  });

  it('XLSX: ô tính có tên cột và vị trí Sheet!A2:B3', async () => {
    const { blocks } = await extractDocument(
      makeXlsx([
        ['Món', 'Giá'],
        ['Cà phê sữa', '25000'],
        ['Bạc xỉu', '30000'],
      ]),
      'gia.xlsx',
    );
    expect(blocks[0].loc).toBe('Giá!A2:B3');
    expect(blocks[0].text).toContain('Món: Cà phê sữa; Giá: 25000');
  });

  it('CSV có ngoặc kép và dấu phẩy trong ô; HTML bỏ script, giữ mục; Markdown theo tiêu đề', async () => {
    expect(parseCsv('a,b\n"x, y",2\n', ',')).toEqual([
      ['a', 'b'],
      ['x, y', '2'],
    ]);
    const csv = await extractDocument(Buffer.from('Món,Giá\nTrà đào,35000\n'), 'm.csv');
    expect(csv.blocks[0].text).toBe('Món: Trà đào; Giá: 35000');
    const html = await extractDocument(
      Buffer.from(
        '<html><head><title>T</title><script>evil()</script></head><body><h1>Giao hàng</h1><p>Miễn phí trên 500k.</p></body></html>',
      ),
      'p.html',
    );
    expect(html.blocks[0].loc).toBe('mục: Giao hàng');
    expect(html.blocks[0].text).toBe('Miễn phí trên 500k.');
    expect(JSON.stringify(html.blocks)).not.toContain('evil');
    const md = await extractDocument(Buffer.from('# A\nmột\n## B\nhai\n'), 'n.md');
    expect(md.blocks.map((b: { loc: string }) => b.loc)).toEqual(['mục: A', 'mục: A › B']);
  });

  it('PDF không có chữ → cảnh báo (chưa có OCR), không lỗi', async () => {
    const r = await extractDocument(makePdf(['']), 'scan.pdf');
    expect(r.blocks).toHaveLength(0);
    expect(r.warnings[0]).toContain('bản quét');
  });

  it('chia đoạn: đoạn dài bị cắt, vị trí ghi "(phần 2/3)"', () => {
    const long = Array.from({ length: 40 }, (_, i) => `Câu số ${i} nói về cà phê.`).join(' ');
    expect(splitText(long, 300).every((p: string) => p.length <= 300)).toBe(true);
    const chunks = makeChunks([{ text: long, loc: 'trang 1' }], 300);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[1].loc).toMatch(/^trang 1 \(phần 2\//);
  });
});

describe('thông tin nhạy cảm', () => {
  it('thấy số thẻ hợp lệ (Luhn), CCCD, mật khẩu, khoá API; số thường thì không', () => {
    expect(detectSensitive('Thẻ 4111 1111 1111 1111 hết hạn 12/29')).toContain('số thẻ thanh toán');
    expect(detectSensitive('CCCD: 079123456789')).toContain('số CCCD / CMND');
    expect(detectSensitive('mật khẩu là hunter2')).toContain('mật khẩu');
    expect(detectSensitive('key sk-abcdefghijklmnopqrstuv')).toContain('khoá API / token');
    expect(detectSensitive('Giá 25000, mã đơn 1234567890123456')).toEqual([]);
  });
  it('che: giữ 4 ký tự cuối', () => {
    const masked = maskSensitive('Thẻ 4111 1111 1111 1111 nhé');
    expect(masked).not.toContain('4111 1111');
    expect(masked).toContain('●●●●1111');
  });
});

describe('video: gộp phụ đề + khung hình', () => {
  it('đọc mốc thời gian từ showinfo và JSON của whisper', () => {
    expect(parseShowinfo('n: 0 pts: 0 pts_time:0 ... n: 1 pts_time:12.5 x')).toEqual([0, 12.5]);
    const segs = parseWhisperJson(
      JSON.stringify({
        transcription: [
          { offsets: { from: 0, to: 4000 }, text: ' Xin chào các bạn ' },
          { offsets: { from: 4000, to: 6000 }, text: '[Music]' },
        ],
      }),
    );
    expect(segs).toEqual([{ start: 0, end: 4, text: 'Xin chào các bạn' }]);
  });
  it('cửa sổ cắt ở khung hình đổi cảnh, mỗi cửa sổ có phụ đề + mô tả', () => {
    const windows = buildWindows(
      130,
      [
        { start: 2, end: 8, text: 'Mở đầu' },
        { start: 70, end: 75, text: 'Phần hai' },
      ],
      [
        { time: 0, file: 'f1.jpg', description: 'Màn hình đăng nhập' },
        { time: 66, file: 'f2.jpg', description: 'Bảng giá' },
      ],
    );
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({ start: 0, end: 66, speech: 'Mở đầu' });
    expect(windows[1].visuals[0].text).toBe('Bảng giá');
  });
});

describe('trả lời của model nhìn ảnh', () => {
  it('tách MÔ TẢ và CHỮ TRONG ẢNH', () => {
    const r = parseImageReply('MÔ TẢ: Bảng giá.\nCHỮ TRONG ẢNH: Cà phê 25k\nBạc xỉu 30k');
    expect(r.describe).toBe('Bảng giá.');
    expect(r.ocr).toBe('Cà phê 25k\nBạc xỉu 30k');
    expect(parseImageReply('MÔ TẢ: Ảnh mèo.\nCHỮ TRONG ẢNH: không có').ocr).toBe('');
  });
});

// ---------------------------------------------------------------- Engine + NSA Mem thật

const ROOT_BRANCH = 'plugin/knowledge-base/kien-thuc';

interface World {
  engine: InstanceType<typeof Engine>;
  mem: MemoryService;
  dataDir: string;
  visionCalls: { prompt: string; images: number }[];
  cliCalls: { id: string; args: string[] }[];
  emitted: string[];
}

/** Dựng `ctx` giống điều plugin host cấp, nhưng nối thẳng vào MemoryService thật qua chính cầu nối của app. */
async function world(
  options: {
    vision?: (prompt: string) => string;
    visionAvailable?: boolean;
    cli?: (
      id: string,
      args: string[],
    ) => Promise<{ code: number | null; stdout: string; stderr: string; error?: string }>;
    memRoot?: string;
    dataDir?: string;
    level?: 'ok' | 'warn' | 'over';
    priceIn?: number | null;
  } = {},
): Promise<World> {
  const memRoot = options.memRoot ?? tempDir('kb-mem-');
  const dataDir = options.dataDir ?? tempDir('kb-data-');
  const mem = await MemoryService.open({
    root: memRoot,
    identity: localIdentity('tester'),
    policy: personalPolicy(),
    audit: memoryAuditLog(),
  });
  cleanups.push(() => mem.close());
  const bridge = createMemoryBridge(mem);
  const branchFor = (sub?: string) => (sub ? `${ROOT_BRANCH}/${sub}` : ROOT_BRANCH);
  await bridge.ensureBranch(ROOT_BRANCH, 'Knowledge Base');
  const visionCalls: World['visionCalls'] = [];
  const cliCalls: World['cliCalls'] = [];
  const emitted: string[] = [];
  const ctx = {
    pluginId: 'knowledge-base',
    dataDir,
    folder: (id: string) => {
      throw new Error(`Thư mục "${id}" chưa được cấp.`);
    },
    emit: (e: string) => void emitted.push(e),
    log: () => undefined,
    notify: async () => undefined,
    fetch: async () => {
      throw new Error('không có mạng trong test');
    },
    memory: {
      searchSemantic: async (q: string, o: { limit?: number; subBranch?: string } = {}) =>
        bridge.searchSemantic(branchFor(o.subBranch), q, o.limit ?? 8),
      entries: async (o: { subBranch?: string; limit?: number } = {}) =>
        bridge.entries(branchFor(o.subBranch), o.limit ?? 500),
      pending: async (o: { subBranch?: string } = {}) => bridge.pending(branchFor(o.subBranch)),
      read: async (id: string) => bridge.read(ROOT_BRANCH, id),
      propose: async (input: { subBranch?: string; [k: string]: unknown }) => {
        const branch = branchFor(input.subBranch);
        if (input.subBranch) await bridge.ensureBranch(branch, input.subBranch);
        return bridge.propose(branch, 'knowledge-base', input as never);
      },
      accept: (id: string, edits: { title?: string; body?: string } = {}) =>
        bridge.accept(ROOT_BRANCH, id, edits),
      reject: (id: string) => bridge.reject(ROOT_BRANCH, id),
      remove: (ids: string[]) => bridge.remove(ROOT_BRANCH, ids),
      restore: (undo: string[]) => bridge.restore(ROOT_BRANCH, undo),
      setAutoApprove: async (sub: string, auto: boolean, min?: number) => {
        await bridge.ensureBranch(branchFor(sub), sub);
        return bridge.setAutoApprove(branchFor(sub), auto, min);
      },
    },
    model: {
      status: async () => ({
        available: options.visionAvailable !== false,
        label: 'Model giả',
        inputUsdPer1M: options.priceIn === undefined ? 0.1 : options.priceIn,
        outputUsdPer1M: options.priceIn === undefined ? 0.4 : options.priceIn,
        budget: { limitUsd: null, spentUsd: 0, level: options.level ?? 'ok' },
      }),
      vision: async (prompt: string, images: unknown[]) => {
        visionCalls.push({ prompt, images: images.length });
        return (options.vision ?? (() => 'MÔ TẢ: Một ảnh.\nCHỮ TRONG ẢNH: không có'))(prompt);
      },
    },
    cli: {
      run: async (id: string, args: string[]) => {
        cliCalls.push({ id, args });
        if (!options.cli)
          return { code: null, stdout: '', stderr: '', error: `Máy chưa có "${id}".` };
        return options.cli(id, args);
      },
    },
  };
  return { engine: new Engine(ctx), mem, dataDir, visionCalls, cliCalls, emitted };
}

function writeFile(name: string, data: Buffer | string): string {
  const file = join(tempDir('kb-in-'), name);
  writeFileSync(file, data);
  return file;
}

describe('Engine — tài liệu', () => {
  it('nạp PDF → đề xuất vào hộp duyệt kèm nguồn (trang); duyệt xong tìm lại được', async () => {
    const w = await world();
    const file = writeFile(
      'bang-gia.pdf',
      makePdf(['Ca phe sua 25000 dong', 'Giao hang mien phi tren 500000']),
    );
    const r = await w.engine.addFile({ file, name: 'bang-gia.pdf', collection: 'Bảng giá' });
    expect(r.status).toBe('created');
    await w.engine.idle();
    const ov = await w.engine.overview();
    expect(ov.sources[0]).toMatchObject({
      kind: 'doc',
      status: 'ingested',
      pending: 2,
      accepted: 0,
    });
    expect(ov.sources[0].collection).toBe('bang-gia');
    // Mặc định mọi thứ chờ người duyệt (tự nhận tắt) — không có gì tự vào kho.
    expect(w.mem.listEntries(ROOT_BRANCH)).toHaveLength(0);
    const pending = await w.engine.pendingList();
    expect(pending.map((p: { loc: string }) => p.loc).sort()).toEqual(['trang 1', 'trang 2']);
    expect(pending[0].body).toContain('— Nguồn: bang-gia.pdf · trang');
    expect(pending[0].sourceName).toBe('bang-gia.pdf');

    for (const p of pending) await w.mem.accept(p.id);
    const { hits, mode } = await w.engine.ctx.memory.searchSemantic('giao hang mien phi');
    expect(mode).toBe('keyword'); // chưa có model embedding → lùi về FTS5
    expect(hits[0].title).toContain('trang 2');
  });

  it('nạp lại cùng file: không đổi → bỏ qua; đổi → sửa mục cũ, không nhân đôi, gỡ đoạn mất', async () => {
    const w = await world();
    const v1 = writeFile('gia.md', '# Giá\nCà phê 25000\n# Ship\nMiễn phí trên 500k\n');
    await w.engine.addFile({ file: v1, name: 'gia.md', relPath: 'gia.md' });
    await w.engine.idle();
    for (const p of await w.engine.pendingList()) await w.mem.accept(p.id);
    expect(w.mem.listEntries(ROOT_BRANCH)).toHaveLength(2);

    const same = writeFile('gia.md', '# Giá\nCà phê 25000\n# Ship\nMiễn phí trên 500k\n');
    expect((await w.engine.addFile({ file: same, name: 'gia.md', relPath: 'gia.md' })).status).toBe(
      'unchanged',
    );

    const v2 = writeFile('gia.md', '# Giá\nCà phê 30000\n');
    expect((await w.engine.addFile({ file: v2, name: 'gia.md', relPath: 'gia.md' })).status).toBe(
      'updated',
    );
    await w.engine.idle();
    expect(Object.keys(w.engine.cat.sources)).toHaveLength(1);
    const pending = await w.engine.pendingList();
    expect(pending).toHaveLength(1);
    expect(pending[0].previous).toContain('25000'); // hiện bản cũ để đối chiếu
    await w.mem.accept(pending[0].id);
    const entries = w.mem.listEntries(ROOT_BRANCH);
    expect(entries).toHaveLength(1); // mục "Ship" đã gỡ, "Giá" được sửa tại chỗ
    expect(entries[0].body).toContain('30000');
    // Hoàn tác việc gỡ
    expect(
      (await w.engine.undoStale(Object.keys(w.engine.cat.sources)[0] as string)).restored,
    ).toBe(1);
    expect(w.mem.listEntries(ROOT_BRANCH)).toHaveLength(2);
  });

  it('tài liệu có số thẻ giả: mục đó KHÔNG tự nhận dù bật tự nhận, có cảnh báo', async () => {
    const w = await world();
    w.engine.saveSettings({ autoApprove: true, minConfidence: 0.5 });
    const file = writeFile(
      'don.txt',
      `${'Khách thích cà phê sữa, hay đặt buổi sáng. '.repeat(40)}\n\nThanh toán bằng thẻ 4111 1111 1111 1111 hết hạn 12/29.\n`,
    );
    await w.engine.addFile({ file, name: 'don.txt' });
    await w.engine.idle();
    const entries = w.mem.listEntries(ROOT_BRANCH);
    expect(entries.map((e) => e.body).join('\n')).not.toContain('4111'); // không vào kho
    const pending = await w.engine.pendingList();
    const card = pending.find((p: { body: string }) => p.body.includes('4111'));
    expect(card?.sensitive).toBe(true);
    expect(card?.sensitiveWhat).toContain('số thẻ thanh toán');
    const ov = await w.engine.overview();
    expect(ov.sources[0].warnings.join(' ')).toContain('nhạy cảm');
    // Đoạn bình thường thì tự nhận như quy tắc của nhánh.
    expect(entries.some((e) => e.body.includes('cà phê sữa'))).toBe(true);
  });

  it('xoá nguồn gỡ luôn mục nhớ của nó và hoàn tác được', async () => {
    const w = await world();
    const file = writeFile(
      'a.txt',
      'Quy định đổi trả trong 7 ngày.\n\nHoàn tiền trong 3 ngày làm việc.\n',
    );
    const { id } = await w.engine.addFile({ file, name: 'a.txt' });
    await w.engine.idle();
    const pending = await w.engine.pendingList();
    await w.mem.accept(pending[0].id); // 1 mục đã nhận, 1 còn chờ
    expect(w.mem.listEntries(ROOT_BRANCH)).toHaveLength(1);
    const r = await w.engine.removeSource(id);
    expect(r.removed).toBe(1);
    expect(w.mem.listEntries(ROOT_BRANCH)).toHaveLength(0);
    expect((await w.engine.pendingList()).length).toBe(0);
    expect(Object.keys(w.engine.cat.sources)).toHaveLength(0);
    const back = await w.engine.undoRemove();
    expect(back.restored).toBe(1);
    expect(w.mem.listEntries(ROOT_BRANCH)).toHaveLength(1);
    expect(existsSync(w.engine.original(w.engine.src(id)))).toBe(true);
  });

  it('định dạng không hỗ trợ bị từ chối rõ ràng', async () => {
    const w = await world();
    await expect(
      w.engine.addFile({ file: writeFile('x.exe', 'MZ'), name: 'x.exe' }),
    ).rejects.toThrow('Chưa hỗ trợ');
  });
});

describe('Engine — ảnh (model nhìn ảnh GIẢ)', () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );

  it('ước tính chi phí trước, hỏi người dùng khi có giá; lời dặn đi cùng ảnh; giữ file gốc', async () => {
    const w = await world({
      vision: (prompt) => {
        expect(prompt).toContain('bảng giá tháng 11');
        return 'MÔ TẢ: Bảng giá đồ uống.\nCHỮ TRONG ẢNH: Cà phê 25k';
      },
      priceIn: 1, // $1 / triệu token → ~ $0.0007 < ngưỡng hỏi 0.02
    });
    const r = await w.engine.addFile({
      file: writeFile('gia.png', png),
      name: 'gia.png',
      note: 'đây là bảng giá tháng 11',
    });
    expect(r.status).toBe('created');
    await w.engine.idle();
    const src = w.engine.src(r.id);
    expect(src.estimate.calls).toBe(1);
    expect(src.status).toBe('ingested');
    expect(existsSync(w.engine.original(src))).toBe(true);
    expect(w.visionCalls).toHaveLength(1);
    const pending = await w.engine.pendingList();
    expect(pending[0].body).toContain('Lời dặn của người dùng: đây là bảng giá tháng 11');
    expect(pending[0].body).toContain('Chữ trong ảnh:\nCà phê 25k');
    expect(
      w.engine.context(r.id, 'ảnh').images[0].dataUrl.startsWith('data:image/png;base64,'),
    ).toBe(true);
  });

  it('ước tính vượt ngưỡng (hoặc chưa biết giá) → chờ người dùng duyệt chạy, chưa gọi model', async () => {
    const w = await world({ priceIn: null });
    const r = await w.engine.addFile({ file: writeFile('a.png', png), name: 'a.png' });
    await w.engine.idle();
    expect(w.engine.src(r.id).status).toBe('awaiting');
    expect(w.visionCalls).toHaveLength(0);
    w.engine.approve([r.id]);
    await w.engine.idle();
    expect(w.engine.src(r.id).status).toBe('ingested');
    expect(w.visionCalls).toHaveLength(1);
  });

  it('chưa có model nhìn ảnh → báo rõ cách khắc phục; vượt hạn mức tháng → dừng, tiếp tục được', async () => {
    const none = await world({ visionAvailable: false });
    const r1 = await none.engine.addFile({ file: writeFile('a.png', png), name: 'a.png' });
    await none.engine.idle();
    expect(none.engine.src(r1.id).status).toBe('failed');
    expect(none.engine.src(r1.id).error).toContain('Nhà cung cấp');

    const over = await world({ level: 'over', priceIn: 0 });
    const r2 = await over.engine.addFile({ file: writeFile('b.png', png), name: 'b.png' });
    await over.engine.idle();
    expect(over.engine.src(r2.id).status).toBe('failed');
    expect(over.engine.src(r2.id).error).toContain('hạn mức');
    expect(over.visionCalls).toHaveLength(0);
  });

  it('tạm dừng / huỷ / tiếp tục', async () => {
    const w = await world({ priceIn: 0 });
    w.engine.pauseAll();
    const a = await w.engine.addFile({ file: writeFile('a.png', png), name: 'a.png' });
    await w.engine.idle();
    expect(w.engine.src(a.id).status).toBe('queued'); // hàng đợi đang tạm dừng
    expect(w.visionCalls).toHaveLength(0);
    w.engine.resumeAll();
    await w.engine.idle();
    expect(w.engine.src(a.id).status).toBe('ingested');
    const b = await w.engine.addFile({
      file: writeFile('b.png', png.subarray(0, png.length)),
      name: 'b.png',
    });
    w.engine.cancel(b.id);
    await w.engine.idle();
    expect(w.engine.src(b.id).status).toBe('cancelled');
  });
});

describe('Engine — chạy tiếp sau khi đóng mở app', () => {
  it('ảnh đang chạy dở: mở lại (Engine mới, cùng thư mục) thì chạy tiếp, không gọi model lại phần đã xong', async () => {
    const memRoot = tempDir('kb-mem-');
    const dataDir = tempDir('kb-data-');
    const a = await world({ memRoot, dataDir, priceIn: 0 });
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
    a.engine.pauseAll();
    const { id } = await a.engine.addFile({ file: writeFile('a.png', png), name: 'a.png' });
    // Giả lập app bị tắt khi đang "running": trạng thái ghi trên đĩa là running, đã có kết quả model.
    a.engine.cat.queuePaused = false;
    a.engine.src(id).status = 'running';
    a.engine.saveDerived(id, { vision: { describe: 'Đã mô tả', ocr: 'Chữ cũ' } });
    a.engine.save();

    const b = await world({ memRoot, dataDir, priceIn: 0 });
    b.engine.kick(); // plugin.activate()
    await b.engine.idle();
    expect(b.engine.src(id).status).toBe('ingested');
    expect(b.visionCalls).toHaveLength(0); // dùng kết quả đã lưu
    expect((await b.engine.pendingList())[0].body).toContain('Chữ cũ');
  });
});

// ---------------------------------------------------------------- Video (ffmpeg THẬT nếu máy có)

function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Chạy ffmpeg / ffprobe thật như lõi sẽ chạy hộ; whisper-cli là bản giả ghi JSON mẫu. */
function realCli(whisperSegments: { from: number; to: number; text: string }[]) {
  return async (id: string, args: string[]) => {
    if (id === 'whisper') {
      if (args[0] === '-h') return { code: 0, stdout: 'usage', stderr: '' };
      const base = args[args.indexOf('-of') + 1] as string;
      writeFileSync(
        `${base}.json`,
        JSON.stringify({
          transcription: whisperSegments.map((s) => ({
            offsets: { from: s.from, to: s.to },
            text: ` ${s.text}`,
          })),
        }),
      );
      return { code: 0, stdout: '', stderr: '' };
    }
    const r = spawnSync(id, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.error) return { code: null, stdout: '', stderr: '', error: String(r.error.message) };
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
}

describe.runIf(hasFfmpeg())('Engine — video (ffmpeg thật, whisper và model nhìn ảnh giả)', () => {
  function makeVideo(): string {
    const file = join(tempDir('kb-vid-'), 'dao-tao.mp4');
    // 12 giây: 3 màn hình màu khác nhau (đổi cảnh) + tiếng sin.
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
        'color=c=black:s=320x240:d=4,format=yuv420p',
        '-f',
        'lavfi',
        '-i',
        'color=c=white:s=320x240:d=4,format=yuv420p',
        '-f',
        'lavfi',
        '-i',
        'color=c=gray:s=320x240:d=4,format=yuv420p',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=12',
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
    return file;
  }

  it('tách khung theo cảnh + phụ đề → mục nhớ dẫn về đúng phút-giây; khung hình đối chiếu được', async () => {
    const w = await world({
      priceIn: 0,
      cli: realCli([
        { from: 1000, to: 3000, text: 'Đầu tiên bấm nút Đăng nhập' },
        { from: 5000, to: 7000, text: 'Sau đó mở màn hình báo cáo' },
        { from: 9000, to: 11000, text: 'Cuối cùng xuất file Excel' },
      ]),
      vision: (prompt) =>
        `Khung ${prompt.match(/tại (\S+)/)?.[1] ?? '?'}: màn hình phần mềm bán hàng`,
    });
    // model whisper giả
    mkdirSync(join(w.dataDir, 'models'), { recursive: true });
    writeFileSync(join(w.dataDir, 'models', 'ggml-tiny.bin'), 'x');
    const r = await w.engine.addFile({
      file: makeVideo(),
      name: 'dao-tao.mp4',
      note: 'video hướng dẫn phần mềm',
    });
    expect(w.engine.src(r.id).duration).toBeGreaterThan(11);
    await w.engine.idle();
    const src = w.engine.src(r.id);
    expect(src.status, src.error).toBe('ingested');
    expect(w.visionCalls.length).toBeGreaterThanOrEqual(3); // ít nhất mỗi cảnh một khung
    const pending = await w.engine.pendingList();
    const bodies = pending.map((p: { body: string }) => p.body).join('\n');
    expect(bodies).toContain('Lời nói: Đầu tiên bấm nút Đăng nhập');
    expect(bodies).toContain('Hình ảnh (');
    // vị trí là khoảng phút:giây
    expect(pending.every((p: { loc: string }) => /^\d\d:\d\d–\d\d:\d\d$/.test(p.loc))).toBe(true);
    const ctx = w.engine.context(r.id, pending[0].loc);
    expect(ctx.kind).toBe('media');
    expect(ctx.images.length).toBeGreaterThan(0);
    expect(ctx.images[0].dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
    // ffmpeg chạy với đường dẫn tuyệt đối trong thư mục dữ liệu của plugin
    const ff = w.cliCalls.filter((c) => c.id === 'ffmpeg');
    expect(ff.length).toBeGreaterThanOrEqual(2);
    expect(ff.every((c) => c.args[0] === '-hide_banner')).toBe(true);
  }, 60_000);

  it('đóng app giữa lúc mô tả khung: mở lại chạy tiếp, không mô tả lại khung đã xong', async () => {
    const memRoot = tempDir('kb-mem-');
    const dataDir = tempDir('kb-data-');
    let calls = 0;
    const boom = (): string => {
      calls++;
      if (calls === 3) throw new Error('mất mạng');
      return 'màn hình';
    };
    const a = await world({ memRoot, dataDir, priceIn: 0, cli: realCli([]), vision: boom });
    const r = await a.engine.addFile({ file: makeVideo(), name: 'v.mp4' });
    await a.engine.idle();
    expect(a.engine.src(r.id).status).toBe('failed'); // lỗi giữa chừng, đã lưu từng khung
    const done = (a.engine.derived(r.id).frames as { description?: string }[]).filter(
      (f) => f.description !== undefined,
    ).length;
    expect(done).toBeGreaterThanOrEqual(2);
    const before = calls;

    const b = await world({
      memRoot,
      dataDir,
      priceIn: 0,
      cli: realCli([]),
      vision: () => {
        calls++;
        return 'màn hình';
      },
    });
    b.engine.resume(r.id);
    await b.engine.idle();
    expect(b.engine.src(r.id).status, b.engine.src(r.id).error).toBe('ingested');
    const total = (b.engine.derived(r.id).frames as unknown[]).length;
    expect(calls - before).toBe(total - done); // chỉ mô tả phần còn thiếu
  }, 60_000);

  it('thiếu whisper và thiếu model nhìn ảnh → báo lỗi rõ, không nạp nửa vời', async () => {
    const w = await world({
      priceIn: 0,
      cli: async (id, args) =>
        id === 'whisper'
          ? { code: null, stdout: '', stderr: '', error: 'Máy chưa có whisper-cli' }
          : realCli([])(id, args),
      visionAvailable: false,
    });
    const r = await w.engine.addFile({ file: makeVideo(), name: 'v.mp4' });
    await w.engine.idle();
    const s = w.engine.src(r.id);
    expect(s.status).toBe('failed');
    expect(s.error).toContain('model nhìn ảnh');
  }, 60_000);
});

describe('tiện ích', () => {
  it('đọc file test dùng chung', () => {
    expect(
      readFileSync(join(import.meta.dirname, 'knowledge-base', 'nsa-plugin.json'), 'utf8'),
    ).toContain('"knowledge-base"');
  });
});
