/**
 * Giao diện (renderer) chạy trong trình duyệt của Electron, không có Node. Chế độ dev (Vite)
 * nạp từng mô-đun nguyên vẹn, nên chỉ một `import { x } from 'node:os'` ở cấp đầu file của
 * bất kỳ mô-đun nào renderer kéo vào (kể cả qua `@nsa/core`) là màn hình trắng. Bản build
 * thì bỏ được mã không dùng nên KHÔNG lộ lỗi này — test này đi theo đồ thị import để bắt sớm.
 *
 * Quy tắc: từ `src/renderer/src/main.tsx`, đi theo mọi import / export có giá trị (bỏ qua
 * `import type` / `export type`), qua cả các gói `@nsa/*`; không mô-đun nào được import
 * mô-đun có sẵn của Node.
 */
import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { workspaceAliases } from '../../../../workspace-aliases';

const repo = resolve(__dirname, '../../../..');
const entry = resolve(__dirname, '../renderer/src/main.tsx');
const aliases = workspaceAliases(repo);
const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

/** Các import có giá trị trong một file (bỏ import / export chỉ có kiểu). */
export function valueImports(source: string): string[] {
  const out: string[] = [];
  // Bỏ chú thích để không bắt nhầm ví dụ trong comment.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const re =
    /(?:^|\n|;)\s*(import|export)\s+(type\s+)?([\s\S]*?)\s*from\s*['"]([^'"]+)['"]|(?:^|\n|;)\s*import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of code.matchAll(re)) {
    if (m[5] || m[6]) {
      out.push((m[5] ?? m[6]) as string);
      continue;
    }
    if (m[2]) continue; // import type / export type
    const clause = (m[3] ?? '').trim();
    // `import { type A, type B }` — chỉ toàn kiểu thì bỏ.
    const braces = /^\{([\s\S]*)\}$/.exec(clause);
    if (braces) {
      const names = (braces[1] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (names.length && names.every((n) => n.startsWith('type '))) continue;
    }
    out.push(m[4] as string);
  }
  return out;
}

function resolveFile(spec: string, from: string): string | null {
  let base: string;
  if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else if (aliases[spec]) return aliases[spec] as string;
  else return null; // gói npm (react…) — không đi vào
  const noExt = base.replace(/\.(js|mjs|cjs)$/, '');
  for (const candidate of [
    base,
    `${noExt}.ts`,
    `${noExt}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    if (/\.(tsx?|mts)$/.test(candidate) && existsSync(candidate)) return candidate;
  }
  return null; // ảnh, css, json…
}

describe('renderer không kéo mã Node vào trình duyệt', () => {
  it('đọc đúng import có giá trị', () => {
    expect(
      valueImports(
        [
          "import type { A } from 'x1';",
          "import { type B, type C } from 'x2';",
          "import { type D, e } from 'x3';",
          "export * from './x4.js';",
          "export type { F } from 'x5';",
          "import './x6.css';",
          '// import { g } from "x7";',
        ].join('\n'),
      ),
    ).toEqual(['x3', './x4.js', './x6.css']);
  });

  it('không mô-đun nào renderer nạp được import mô-đun có sẵn của Node', () => {
    const seen = new Set<string>();
    const offenders: string[] = [];
    const queue: { file: string; via: string[] }[] = [{ file: entry, via: [] }];
    while (queue.length) {
      const { file, via } = queue.shift() as { file: string; via: string[] };
      if (seen.has(file)) continue;
      seen.add(file);
      const rel = file.slice(repo.length + 1).replace(/\\/g, '/');
      for (const spec of valueImports(readFileSync(file, 'utf8'))) {
        if (builtins.has(spec)) {
          offenders.push(`${[...via, rel].join(' → ')} → ${spec}`);
          continue;
        }
        const next = resolveFile(spec, file);
        if (next) queue.push({ file: next, via: [...via, rel] });
      }
    }
    expect(seen.size).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });
});
