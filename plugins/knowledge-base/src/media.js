// Video / âm thanh: ffmpeg tách khung hình theo cảnh và tiếng, whisper.cpp nhận dạng giọng nói
// thành phụ đề có mốc thời gian, rồi gộp phụ đề + mô tả khung hình thành các cửa sổ thời gian.
// Mọi chương trình ngoài chạy qua `ctx.cli` (quyền `cli` của lõi, ADR-0012): plugin không tự sinh tiến trình.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { clock } from './util.js';

const FF = ['-hide_banner', '-nostdin', '-y'];

function tail(text, n = 400) {
  const s = String(text ?? '').trim();
  return s.length > n ? `…${s.slice(-n)}` : s;
}

/** Chạy một chương trình; ném lỗi đọc được nếu thất bại. */
async function run(cli, id, args, timeoutMs, what) {
  if (!cli) throw new Error('Plugin chưa được cấp quyền chạy chương trình ngoài (ffmpeg).');
  const r = await cli.run(id, args, { timeoutMs });
  if (r.error) throw new Error(r.error);
  if (r.code !== 0) throw new Error(`${what} lỗi (mã ${r.code}): ${tail(r.stderr)}`);
  return r;
}

/** Thời lượng + có hình / tiếng không. */
export async function probe(cli, file) {
  const r = await run(
    cli,
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file],
    60_000,
    'ffprobe',
  );
  let json;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    throw new Error('Không đọc được thông tin file (ffprobe trả dữ liệu lạ). File có thể hỏng.');
  }
  const types = (json.streams ?? []).map((s) => s.codec_type);
  const duration = Number(json.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(
      'Không xác định được thời lượng file (file hỏng hoặc không phải video / âm thanh).',
    );
  }
  return { duration, hasVideo: types.includes('video'), hasAudio: types.includes('audio') };
}

/** Tách tiếng: WAV mono 16 kHz (định dạng whisper.cpp cần). */
export async function extractAudio(cli, input, outWav) {
  await run(
    cli,
    'ffmpeg',
    [...FF, '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outWav],
    900_000,
    'ffmpeg (tách tiếng)',
  );
}

/** Thời điểm (giây) của từng khung do bộ lọc `showinfo` in ra, theo thứ tự. */
export function parseShowinfo(stderr) {
  return [...String(stderr ?? '').matchAll(/pts_time:\s*(-?[0-9.]+)/g)].map((m) => Number(m[1]));
}

/**
 * Lấy khung hình: đổi cảnh (`scene`) + khung đầu, tối đa `maxFrames`; video dài mà ít cảnh đổi thì
 * bổ sung khung cách đều để không bỏ sót. Trả [{ time, file }] theo thời gian.
 */
export async function extractFrames(cli, input, outDir, duration, options = {}) {
  const maxFrames = options.maxFrames ?? 40;
  const threshold = options.scene ?? 0.3;
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const scale = "scale='min(1024,iw)':-2";
  const sceneArgs = (mode) => [
    ...FF,
    '-i',
    input,
    '-an',
    '-vf',
    `select='gt(scene,${threshold})+isnan(prev_selected_t)',${scale},showinfo`,
    mode,
    'vfr',
    '-q:v',
    '4',
    '-frames:v',
    String(maxFrames * 2),
    join(outDir, 's%04d.jpg'),
  ];
  let result;
  try {
    result = await run(cli, 'ffmpeg', sceneArgs('-fps_mode'), 900_000, 'ffmpeg (tách khung)');
  } catch (err) {
    // ffmpeg cũ (< 5.1) chưa có -fps_mode
    if (!/fps_mode|Unrecognized option/i.test(String(err.message))) throw err;
    result = await run(cli, 'ffmpeg', sceneArgs('-vsync'), 900_000, 'ffmpeg (tách khung)');
  }
  const files = readdirSync(outDir)
    .filter((f) => /^s\d+\.jpg$/.test(f))
    .sort();
  let times = parseShowinfo(result.stderr);
  // Không đọc được mốc thời gian (ffmpeg đổi định dạng log): rải đều theo thứ tự thay vì dồn về 0 giây.
  if (times.length !== files.length) times = files.map((_, i) => (i * duration) / files.length);
  let frames = files.map((f, i) => ({ time: Math.max(0, times[i] ?? 0), file: join(outDir, f) }));

  // Video dài, ít đổi cảnh: thêm khung cách đều.
  const wanted = Math.min(maxFrames, Math.ceil(duration / 60));
  if (frames.length < wanted) {
    const step = Math.max(10, duration / Math.min(maxFrames, Math.max(wanted, 6)));
    await run(
      cli,
      'ffmpeg',
      [
        ...FF,
        '-i',
        input,
        '-an',
        '-vf',
        `fps=1/${step.toFixed(2)},${scale}`,
        '-q:v',
        '4',
        join(outDir, 'i%04d.jpg'),
      ],
      900_000,
      'ffmpeg (khung cách đều)',
    );
    const extra = readdirSync(outDir)
      .filter((f) => /^i\d+\.jpg$/.test(f))
      .sort()
      .map((f, i) => ({ time: Math.min(duration, step * (i + 0.5)), file: join(outDir, f) }));
    frames = frames.concat(extra);
  }
  frames.sort((a, b) => a.time - b.time);
  // Bỏ khung quá sát nhau (< 3 giây), rồi cắt xuống tối đa maxFrames đều nhau.
  const spaced = [];
  for (const f of frames) {
    if (spaced.length && f.time - spaced[spaced.length - 1].time < 3) continue;
    spaced.push(f);
  }
  let kept = spaced;
  if (kept.length > maxFrames) {
    kept = Array.from(
      { length: maxFrames },
      (_, i) => spaced[Math.floor((i * spaced.length) / maxFrames)],
    );
  }
  // Đặt lại tên theo thứ tự thời gian; xoá khung thừa.
  const keepSet = new Set(kept.map((f) => f.file));
  for (const f of frames) if (!keepSet.has(f.file)) rmSync(f.file, { force: true });
  return kept.map((f, i) => {
    const name = join(outDir, `f${String(i + 1).padStart(4, '0')}.jpg`);
    renameSync(f.file, name);
    return { time: f.time, file: name };
  });
}

// ---------------------------------------------------------------- Nhận dạng giọng nói

/** JSON của `whisper-cli -oj` → [{ start, end, text }] (giây). */
export function parseWhisperJson(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('Không đọc được kết quả nhận dạng giọng nói (JSON hỏng).');
  }
  return (json.transcription ?? [])
    .map((s) => ({
      start: Number(s.offsets?.from ?? 0) / 1000,
      end: Number(s.offsets?.to ?? 0) / 1000,
      text: String(s.text ?? '')
        .replace(/\s+/g, ' ')
        .trim(),
    }))
    .filter((s) => s.text && !/^\[.*\]$|^\(.*\)$/.test(s.text));
}

/** Nhận dạng giọng nói bằng whisper.cpp (`whisper-cli`) với model đã tải về `modelFile`. */
export async function transcribe(cli, wavFile, modelFile, workDir, language = 'auto') {
  mkdirSync(workDir, { recursive: true });
  const base = join(workDir, 'whisper');
  rmSync(`${base}.json`, { force: true });
  await run(
    cli,
    'whisper',
    ['-m', modelFile, '-f', wavFile, '-l', language, '-oj', '-of', base, '-np'],
    900_000,
    'whisper-cli (nhận dạng giọng nói)',
  );
  if (!existsSync(`${base}.json`))
    throw new Error('whisper-cli chạy xong nhưng không tạo kết quả.');
  return parseWhisperJson(readFileSync(`${base}.json`, 'utf8'));
}

// ---------------------------------------------------------------- Gộp phụ đề + khung hình

/**
 * Chia dòng thời gian thành các cửa sổ ~`target` giây (cắt ở khung hình đổi cảnh), mỗi cửa sổ gom
 * phụ đề và mô tả khung hình trong đó. Cửa sổ có chữ quá dài bị chia tiếp theo ranh giới câu.
 * `frames`: [{ time, file, description? }]. Trả [{ start, end, speech, visuals[], frames[] }].
 */
export function buildWindows(duration, segments, frames, options = {}) {
  const target = options.target ?? 45;
  const maxChars = options.maxChars ?? 1100;
  const cuts = [];
  let start = 0;
  const sorted = [...frames].sort((a, b) => a.time - b.time);
  for (const f of sorted) {
    if (f.time - start >= target) {
      cuts.push([start, f.time]);
      start = f.time;
    }
  }
  cuts.push([start, Math.max(duration, start + 1)]);

  const windows = [];
  for (const [from, to] of cuts) {
    const segs = segments.filter((s) => s.start >= from && s.start < to);
    const fr = sorted.filter((f) => f.time >= from && f.time < to);
    // Chia nhỏ nếu phụ đề quá dài.
    const groups = [];
    let cur = [];
    let len = 0;
    for (const s of segs) {
      if (cur.length && len + s.text.length > maxChars) {
        groups.push(cur);
        cur = [];
        len = 0;
      }
      cur.push(s);
      len += s.text.length + 1;
    }
    if (cur.length || groups.length === 0) groups.push(cur);
    groups.forEach((g, i) => {
      const gStart = i === 0 ? from : (g[0]?.start ?? from);
      const gEnd = i === groups.length - 1 ? to : (groups[i + 1][0]?.start ?? to);
      windows.push({
        start: gStart,
        end: gEnd,
        speech: g.map((s) => s.text).join(' '),
        lines: g.map((s) => ({ start: s.start, text: s.text })),
        visuals:
          i === 0
            ? fr.filter((f) => f.description).map((f) => ({ time: f.time, text: f.description }))
            : [],
        frames: i === 0 ? fr.map((f) => f.file) : [],
      });
    });
  }
  return windows.filter((w) => w.speech || w.visuals.length);
}

export const windowLoc = (w) => `${clock(w.start)}–${clock(w.end)}`;

/** Nội dung mục nhớ của một cửa sổ video. */
export function windowText(w) {
  const lines = [];
  for (const v of w.visuals) lines.push(`Hình ảnh (${clock(v.time)}): ${v.text}`);
  if (w.speech) {
    lines.push('Lời nói (phụ đề tự động, có thể sai, nhất là tên riêng và con số):');
    for (const l of w.lines ?? [{ start: w.start, text: w.speech }])
      lines.push(`[${clock(l.start)}] ${l.text}`);
  }
  return lines.join('\n');
}
