/**
 * Sơ đồ phụ thuộc cho phép giữa các gói @nsa/* (ADR-0015, G3). Một nguồn duy nhất cho:
 * - luật lint `no-restricted-imports` (eslint.config.js): import vượt sơ đồ thì lint đỏ;
 * - `package-boundaries.test.ts`: `dependencies` trong package.json cũng không được vượt sơ đồ.
 *
 * Tầng: hợp đồng (sdk) ← lõi (core) ← hiện thực (adapter, providers, memory, mcp-gateway,
 * plugin-host) ← lắp ghép (apps/desktop, được import mọi thứ). Mũi tên chỉ đi một chiều.
 * Thêm gói mới: thêm một dòng ở đây, nếu không test sẽ đỏ.
 */

/** Thư mục gói → tên gói. */
export const PACKAGE_DIRS = {
  'packages/adapter-sdk': '@nsa/adapter-sdk',
  'packages/plugin-sdk': '@nsa/plugin-sdk',
  'packages/core': '@nsa/core',
  'packages/adapters/pty': '@nsa/adapter-pty',
  'packages/adapters/claude': '@nsa/adapter-claude',
  'packages/adapters/codex': '@nsa/adapter-codex',
  'packages/adapters/opencode': '@nsa/adapter-opencode',
  'packages/adapters/gemini': '@nsa/adapter-gemini',
  'packages/adapters/antigravity': '@nsa/adapter-antigravity',
  'packages/adapters/api': '@nsa/adapter-api',
  'packages/adapters/contract-live': '@nsa/contract-live',
  'packages/providers': '@nsa/providers',
  'packages/mcp-gateway': '@nsa/mcp-gateway',
  'packages/memory': '@nsa/memory',
  'packages/plugin-host': '@nsa/plugin-host',
};

/** Gói nào được import gói nào (chỉ tính @nsa/*). `apps/desktop` không bị giới hạn. */
export const ALLOWED = {
  // Tầng hợp đồng: không phụ thuộc gói nào.
  '@nsa/adapter-sdk': [],
  '@nsa/plugin-sdk': [],
  // Lõi: chỉ interface + điều phối; chỉ được biết hai gói hợp đồng.
  '@nsa/core': ['@nsa/adapter-sdk', '@nsa/plugin-sdk'],
  // Hiện thực cụ thể.
  '@nsa/adapter-pty': ['@nsa/adapter-sdk'],
  '@nsa/adapter-claude': ['@nsa/adapter-sdk', '@nsa/adapter-pty'],
  '@nsa/adapter-codex': ['@nsa/adapter-sdk', '@nsa/adapter-pty'],
  '@nsa/adapter-opencode': ['@nsa/adapter-sdk', '@nsa/adapter-pty'],
  '@nsa/adapter-gemini': ['@nsa/adapter-sdk', '@nsa/adapter-pty'],
  '@nsa/adapter-antigravity': ['@nsa/adapter-sdk', '@nsa/adapter-pty'],
  '@nsa/adapter-api': ['@nsa/adapter-sdk'],
  // providers nhận adapter của từng CLI qua `CliAdapterFactories`, không import chúng.
  '@nsa/providers': ['@nsa/core', '@nsa/adapter-sdk', '@nsa/adapter-api'],
  '@nsa/mcp-gateway': ['@nsa/core', '@nsa/adapter-sdk'],
  '@nsa/memory': ['@nsa/core', '@nsa/adapter-sdk', '@nsa/mcp-gateway'],
  '@nsa/plugin-host': ['@nsa/core', '@nsa/mcp-gateway', '@nsa/plugin-sdk'],
  // Gói test với CLI thật: ghép mọi thứ như apps/desktop.
  '@nsa/contract-live': [
    '@nsa/core',
    '@nsa/adapter-sdk',
    '@nsa/adapter-pty',
    '@nsa/adapter-claude',
    '@nsa/adapter-codex',
    '@nsa/adapter-opencode',
    '@nsa/adapter-gemini',
    '@nsa/adapter-antigravity',
    '@nsa/adapter-api',
    '@nsa/providers',
    '@nsa/mcp-gateway',
    '@nsa/memory',
  ],
};

/**
 * Cấu hình ESLint `no-restricted-imports` cho từng gói: cấm mọi `@nsa/*` trừ các gói được phép
 * (và chính nó). Trả về mảng "flat config" để rải vào eslint.config.js.
 */
export function boundaryLintConfigs() {
  return Object.entries(PACKAGE_DIRS).map(([dir, name]) => {
    const allowed = ALLOWED[name] ?? [];
    return {
      files: [`${dir}/**/*.{ts,tsx,js,mjs}`],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['@nsa/*', ...[...allowed, name].map((n) => `!${n}`)],
                message: `Gói ${name} không được import gói này — xem sơ đồ phụ thuộc trong docs/adr/0015-ranh-gioi-goi.md và package-boundaries.js.`,
              },
            ],
          },
        ],
      },
    };
  });
}
