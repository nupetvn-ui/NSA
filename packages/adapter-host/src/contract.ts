import type { AgentAdapter } from '@nsa/adapter-sdk';

const TIERS = new Set(['protocol', 'headless', 'pty']);
const FLAGS = [
  'streaming',
  'resume',
  'tools',
  'editFiles',
  'images',
  'mcp',
  'subagents',
  'toolGate',
] as const;

/**
 * Test hợp đồng TỐI THIỂU cho một adapter vừa nạp (đồng bộ, không chạy CLI): đúng mã, có đủ hàm,
 * bảng năng lực đúng dạng. Trả về lỗi đầu tiên, hoặc null nếu qua.
 */
export function checkAdapterShape(adapter: unknown, expectedId: string): string | null {
  const a = adapter as Partial<AgentAdapter> | null;
  if (!a || typeof a !== 'object') return 'createAdapter không trả về đối tượng adapter';
  if (a.id !== expectedId) return `mã adapter "${String(a.id)}" khác mã gói "${expectedId}"`;
  if (typeof a.displayName !== 'string' || !a.displayName) return 'thiếu displayName';
  for (const fn of ['detect', 'capabilities', 'run'] as const) {
    if (typeof a[fn] !== 'function') return `thiếu hàm ${fn}()`;
  }
  let caps: unknown;
  try {
    caps = a.capabilities?.();
  } catch (err) {
    return `capabilities() ném lỗi: ${(err as Error).message}`;
  }
  const c = caps as Record<string, unknown> | null;
  if (!c || typeof c !== 'object') return 'capabilities() không trả về đối tượng';
  if (!TIERS.has(String(c['tier'])))
    return `capabilities().tier không hợp lệ: ${String(c['tier'])}`;
  for (const f of FLAGS) {
    if (typeof c[f] !== 'boolean') return `capabilities().${f} phải là true/false`;
  }
  return null;
}

/**
 * Phần có chạy: `detect()` phải trả về kết quả đúng dạng trong thời hạn (không cần CLI đã cài —
 * "chưa cài" cũng là kết quả hợp lệ). Gọi trước khi chọn bản mới làm bản chạy chính.
 */
export async function probeAdapter(
  adapter: AgentAdapter,
  timeoutMs = 20_000,
): Promise<string | null> {
  try {
    const result = await Promise.race([
      adapter.detect(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`detect() quá ${timeoutMs} ms`)), timeoutMs).unref(),
      ),
    ]);
    if (!result || typeof result.installed !== 'boolean' || typeof result.ready !== 'boolean') {
      return 'detect() không trả về { installed, ready }';
    }
    return null;
  } catch (err) {
    return `detect() lỗi: ${(err as Error).message}`;
  }
}
