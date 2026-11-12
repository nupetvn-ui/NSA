import type { AgentAdapter, CliFingerprint } from '@nsa/adapter-sdk';

/** Dấu vân tay đã lưu của một CLI. */
export interface StoredFingerprint {
  version: string | null;
  helpHash: string | null;
  /** Lưu cả nội dung `--help` để lần sau chỉ ra dòng nào thay đổi. */
  help: string | null;
  checkedAt: string;
}

export interface FingerprintStore {
  load(): Record<string, StoredFingerprint>;
  save(data: Record<string, StoredFingerprint>): void;
}

/** Một thay đổi phát hiện được ở CLI so với lần khởi động trước. */
export interface CliChange {
  agentId: string;
  name: string;
  kind: 'version' | 'help' | 'appeared' | 'disappeared';
  before: string | null;
  after: string | null;
  /** Các dòng `--help` mới thêm (+) hoặc bị bỏ (−), tối đa vài chục dòng. */
  helpDiff: string[];
}

/** Băm FNV-1a 32 bit — đủ để biết nội dung có đổi không; không dùng node:crypto vì giao diện cũng nhập gói này. */
function hash(text: string | null): string | null {
  if (text === null) return null;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${text.length.toString(16)}-${h.toString(16)}`;
}

/** So từng dòng (không cần thứ tự) — đủ để thấy cờ nào mới / bị bỏ. */
export function diffHelp(before: string | null, after: string | null, limit = 40): string[] {
  const a = new Set(
    (before ?? '')
      .split('\n')
      .map((l) => l.trimEnd())
      .filter(Boolean),
  );
  const b = new Set(
    (after ?? '')
      .split('\n')
      .map((l) => l.trimEnd())
      .filter(Boolean),
  );
  const out = [
    ...[...b].filter((l) => !a.has(l)).map((l) => `+ ${l.trim()}`),
    ...[...a].filter((l) => !b.has(l)).map((l) => `− ${l.trim()}`),
  ];
  return out.length > limit
    ? [...out.slice(0, limit), `… và ${out.length - limit} dòng khác`]
    : out;
}

/**
 * Lấy dấu vân tay của mọi CLI, so với lần trước, lưu lại và trả về danh sách thay đổi
 * (nguyên tắc 6 của PLAN.md). Lần đầu chạy chỉ ghi nhận, không báo gì.
 */
export async function detectCliChanges(
  adapters: AgentAdapter[],
  store: FingerprintStore,
  now: () => Date = () => new Date(),
): Promise<CliChange[]> {
  const previous = store.load();
  const next: Record<string, StoredFingerprint> = { ...previous };
  const changes: CliChange[] = [];

  await Promise.all(
    adapters.map(async (adapter) => {
      if (!adapter.fingerprint) return;
      let fp: CliFingerprint;
      try {
        fp = await adapter.fingerprint();
      } catch {
        fp = { version: null, help: null };
      }
      const before = previous[adapter.id];
      const stored: StoredFingerprint = {
        version: fp.version,
        helpHash: hash(fp.help),
        help: fp.help,
        checkedAt: now().toISOString(),
      };
      next[adapter.id] = stored;
      if (!before) return;
      const base = { agentId: adapter.id, name: adapter.displayName };
      if (before.version === null && fp.version !== null) {
        changes.push({ ...base, kind: 'appeared', before: null, after: fp.version, helpDiff: [] });
      } else if (before.version !== null && fp.version === null) {
        changes.push({
          ...base,
          kind: 'disappeared',
          before: before.version,
          after: null,
          helpDiff: [],
        });
      } else if (before.version !== fp.version) {
        changes.push({
          ...base,
          kind: 'version',
          before: before.version,
          after: fp.version,
          helpDiff: before.helpHash !== stored.helpHash ? diffHelp(before.help, fp.help) : [],
        });
      } else if (before.helpHash !== stored.helpHash && fp.help !== null) {
        changes.push({
          ...base,
          kind: 'help',
          before: before.version,
          after: fp.version,
          helpDiff: diffHelp(before.help, fp.help),
        });
      }
    }),
  );

  store.save(next);
  return changes.sort((a, b) => a.agentId.localeCompare(b.agentId));
}

/** Một dòng tóm tắt cho người dùng và nhật ký. */
export function describeChange(change: CliChange): string {
  switch (change.kind) {
    case 'appeared':
      return `${change.name} vừa được cài (${change.after ?? '?'}).`;
    case 'disappeared':
      return `${change.name} không còn chạy được (trước đây ${change.before ?? '?'}).`;
    case 'version':
      return `${change.name} đã cập nhật ${change.before ?? '?'} → ${change.after ?? '?'}${change.helpDiff.length ? `, ${change.helpDiff.length} dòng --help thay đổi` : ''}.`;
    case 'help':
      return `${change.name} đổi --help mà không đổi phiên bản (${change.helpDiff.length} dòng).`;
  }
}
