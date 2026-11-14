// Dựng thế giới thử cho plugin Knowledge Base: Engine thật + NSA Mem thật (MemoryService + cầu nối plugin)
// + model GIẢ. Dùng chung cho knowledge-base.test.ts và knowledge-base-quality.test.ts.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localIdentity, memoryAuditLog, personalPolicy } from '@nsa/core';
import { MemoryService } from '@nsa/memory';
import { createMemoryBridge } from '@nsa/plugin-host';
// @ts-expect-error mã JS không có kiểu
import { Engine } from './knowledge-base/src/engine.js';

export const cleanups: (() => void | Promise<void>)[] = [];
export async function runCleanups(): Promise<void> {
  for (const c of cleanups.splice(0).reverse()) await c();
}
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------- Engine + NSA Mem thật

export const ROOT_BRANCH = 'plugin/knowledge-base/kien-thuc';

export interface World {
  engine: InstanceType<typeof Engine>;
  mem: MemoryService;
  dataDir: string;
  visionCalls: { prompt: string; images: number }[];
  cliCalls: { id: string; args: string[] }[];
  emitted: string[];
}

/** Dựng `ctx` giống điều plugin host cấp, nhưng nối thẳng vào MemoryService thật qua chính cầu nối của app. */
export async function world(
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
    fetch?: (url: string) => Promise<Response>;
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
    fetch:
      options.fetch ??
      (async () => {
        throw new Error('không có mạng trong test');
      }),
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

export function writeFile(name: string, data: Buffer | string): string {
  const file = join(tempDir('kb-in-'), name);
  writeFileSync(file, data);
  return file;
}

// ---------------------------------------------------------------- Video (ffmpeg THẬT nếu máy có)

export function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Chạy ffmpeg / ffprobe thật như lõi sẽ chạy hộ; whisper-cli là bản giả ghi JSON mẫu. */
export function realCli(whisperSegments: { from: number; to: number; text: string }[]) {
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
