/**
 * Ranh giới gói (G3, ADR-0015). Chứng minh luật lint BẮT được vi phạm và `package.json` của mọi gói
 * không khai báo phụ thuộc vượt sơ đồ trong `package-boundaries.js`.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { ALLOWED, PACKAGE_DIRS } from '../package-boundaries.js';

const repo = resolve(__dirname, '..');

function packageDirs(): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(repo, rel), { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === 'node_modules') continue;
      const sub = `${rel}/${e.name}`;
      if (existsSync(join(repo, sub, 'package.json'))) out.push(sub);
      else walk(sub);
    }
  };
  walk('packages');
  return out.sort();
}

describe('sơ đồ phụ thuộc giữa các gói', () => {
  it('mọi gói trong packages/ đều có tên trong sơ đồ (thêm gói mới phải khai báo)', () => {
    expect(packageDirs()).toEqual(Object.keys(PACKAGE_DIRS).sort());
  });

  it.each(Object.entries(PACKAGE_DIRS))('%s: dependencies không vượt sơ đồ', (dir, name) => {
    const pkg = JSON.parse(readFileSync(join(repo, dir, 'package.json'), 'utf8')) as {
      name: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.name).toBe(name);
    const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) =>
      d.startsWith('@nsa/'),
    );
    const extra = declared.filter((d) => !(ALLOWED[name] ?? []).includes(d));
    expect(extra, `${name} khai báo phụ thuộc không được phép`).toEqual([]);
  });

  it('lõi (core) chỉ được biết adapter-sdk và plugin-sdk', () => {
    expect(ALLOWED['@nsa/core']).toEqual(['@nsa/adapter-sdk', '@nsa/plugin-sdk']);
  });
});

describe('luật lint chặn import vượt ranh giới', { timeout: 60_000 }, () => {
  const eslint = new ESLint({ cwd: repo });
  async function violations(file: string, code: string): Promise<string[]> {
    const [result] = await eslint.lintText(code, { filePath: join(repo, file) });
    return (result?.messages ?? [])
      .filter((m) => m.ruleId === 'no-restricted-imports')
      .map((m) => m.message);
  }

  it.each([
    ['packages/core/src/x.ts', "import { createProviders } from '@nsa/providers';"],
    ['packages/core/src/x.ts', "import type { Foo } from '@nsa/adapter-api';"],
    ['packages/core/src/x.ts', "export * from '@nsa/memory';"],
    ['packages/providers/src/x.ts', "import { createClaudeAdapter } from '@nsa/adapter-claude';"],
    ['packages/memory/src/x.ts', "import { ProviderHub } from '@nsa/providers';"],
    ['packages/adapters/claude/src/x.ts', "import { ChatService } from '@nsa/core';"],
    ['packages/plugin-host/src/x.ts', "import { x } from '@nsa/memory';"],
  ])('%s bị chặn: %s', async (file, code) => {
    expect((await violations(file, code)).length).toBeGreaterThan(0);
  });

  it.each([
    ['packages/core/src/x.ts', "import type { AgentAdapter } from '@nsa/adapter-sdk';"],
    ['packages/core/src/x.ts', "import type { PluginInfo } from '@nsa/plugin-sdk';"],
    ['packages/providers/src/x.ts', "import { ChatService } from '@nsa/core';"],
    ['packages/memory/src/x.ts', "import { McpGateway } from '@nsa/mcp-gateway';"],
    ['packages/adapters/claude/src/x.ts', "import { x } from '@nsa/adapter-pty';"],
  ])('%s được phép: %s', async (file, code) => {
    expect(await violations(file, code)).toEqual([]);
  });

  it('apps/desktop lắp ghép được mọi gói', async () => {
    expect(
      await violations(
        'apps/desktop/src/main/x.ts',
        "import { ProviderHub } from '@nsa/providers';\nimport { createClaudeAdapter } from '@nsa/adapter-claude';",
      ),
    ).toEqual([]);
  });
});
