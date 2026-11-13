import { resolve } from 'node:path';

/**
 * Trỏ các gói @nsa/* thẳng vào mã nguồn để Vitest và electron-vite dùng được
 * mà không cần build từng gói trước. Thêm gói mới vào đây.
 */
const PACKAGES: Record<string, string> = {
  '@nsa/core': 'packages/core',
  '@nsa/adapter-sdk': 'packages/adapter-sdk',
  '@nsa/adapter-claude': 'packages/adapters/claude',
  '@nsa/adapter-codex': 'packages/adapters/codex',
  '@nsa/adapter-opencode': 'packages/adapters/opencode',
  '@nsa/adapter-gemini': 'packages/adapters/gemini',
  '@nsa/adapter-antigravity': 'packages/adapters/antigravity',
  '@nsa/adapter-pty': 'packages/adapters/pty',
  '@nsa/adapter-api': 'packages/adapters/api',
  '@nsa/providers': 'packages/providers',
  '@nsa/mcp-gateway': 'packages/mcp-gateway',
  '@nsa/memory': 'packages/memory',
  '@nsa/plugin-sdk': 'packages/plugin-sdk',
  '@nsa/plugin-host': 'packages/plugin-host',
};

export function workspaceAliases(repoRoot: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(PACKAGES).map(([name, dir]) => [name, resolve(repoRoot, dir, 'src/index.ts')]),
  );
}
