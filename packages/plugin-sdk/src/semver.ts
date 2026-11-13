/**
 * Bản nhỏ của so sánh phiên bản (không thêm phụ thuộc): đủ cho trường `nsa` của manifest.
 * Hỗ trợ: `1.2.3`, `>=1.2.3`, `>1`, `<=`, `<`, `=`, `^1.2.3`, `~1.2.3`, `1.x`, `*`, và
 * nhiều điều kiện cách nhau bằng dấu cách (tất cả phải đúng). Phần `-beta` bị bỏ qua.
 */
export type Version = [number, number, number];

export function parseVersion(text: string): Version | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/.exec(text.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

type Check = (v: Version) => boolean;

function comparator(raw: string): Check | null {
  if (raw === '*' || raw === 'x') return () => true;
  const m = /^(>=|<=|>|<|=|\^|~)?v?(\d+|x|\*)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:[-+].*)?$/.exec(
    raw,
  );
  if (!m) return null;
  const op = m[1] ?? '';
  const wild = (s: string | undefined): boolean => s === undefined || s === 'x' || s === '*';
  const base: Version = [
    Number(m[2]),
    wild(m[3]) ? 0 : Number(m[3]),
    wild(m[4]) ? 0 : Number(m[4]),
  ];
  if (Number.isNaN(base[0])) return null;
  if (op === '' || op === '=') {
    if (wild(m[3])) return (v) => v[0] === base[0];
    if (wild(m[4])) return (v) => v[0] === base[0] && v[1] === base[1];
    return (v) => compareVersions(v, base) === 0;
  }
  if (op === '>=') return (v) => compareVersions(v, base) >= 0;
  if (op === '>') return (v) => compareVersions(v, base) > 0;
  if (op === '<=') return (v) => compareVersions(v, base) <= 0;
  if (op === '<') return (v) => compareVersions(v, base) < 0;
  if (op === '~') {
    return (v) => compareVersions(v, base) >= 0 && v[0] === base[0] && v[1] === base[1];
  }
  // ^: cho phép đổi mọi thứ bên phải số khác 0 đầu tiên.
  return (v) => {
    if (compareVersions(v, base) < 0) return false;
    if (base[0] > 0) return v[0] === base[0];
    if (base[1] > 0) return v[0] === 0 && v[1] === base[1];
    return v[0] === 0 && v[1] === 0 && v[2] === base[2];
  };
}

/** `true` nếu `range` là một dải phiên bản hợp lệ. */
export function isValidRange(range: string): boolean {
  return (
    range.trim() !== '' &&
    range
      .trim()
      .split(/\s+/)
      .every((c) => comparator(c) !== null)
  );
}

export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (!v) return false;
  const checks = range
    .trim()
    .split(/\s+/)
    .map((c) => comparator(c));
  return checks.length > 0 && checks.every((c) => c !== null && c(v));
}
