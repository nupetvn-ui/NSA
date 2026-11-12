/**
 * Cấp key cho CLI sẵn có (PLAN.md, "Key được dùng theo hai đường", đường 1).
 * NSA đặt biến môi trường cho TỪNG LƯỢT chạy; không sửa file cấu hình toàn cục của CLI.
 *
 * Đã chạy thật với máy chủ giả (ADR-0008):
 * - OpenCode 1.19.5: nhà cung cấp tương thích OpenAI khai báo qua `OPENCODE_CONFIG_CONTENT`,
 *   key qua `{env:NSA_PROVIDER_KEY}` → OpenCode gửi đúng key, không ghi key ra thư mục dữ liệu.
 * - Claude Code 2.1.322: chỉ đặt ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN (hoặc ANTHROPIC_API_KEY)
 *   thì Claude Code VẪN gửi token đăng nhập gói thuê bao của người dùng tới địa chỉ mới (lộ token
 *   cho hãng khác). Vì vậy NSA luôn chạy với `CLAUDE_CONFIG_DIR` riêng (không có đăng nhập của
 *   người dùng) — khi đó Claude Code dùng đúng key NSA cấp.
 */
import { join } from 'node:path';
import type { CliId, CliPairStatus, ProviderInfo } from './catalog.js';
import { resolveEndpoint } from './catalog.js';

export interface PairingLaunch {
  /** Biến môi trường cho lượt chạy (có chứa key — chỉ truyền cho tiến trình CLI). */
  env: Record<string, string>;
  /** Model truyền cho adapter CLI (OpenCode: `nsa-<hãng>/<model>`; Codex: tên model). */
  cliModel?: string;
}

export const PAIRING_KEY_ENV = 'NSA_PROVIDER_KEY';

const RANK: Record<CliPairStatus, number> = {
  unsupported: 0,
  unverified: 1,
  documented: 2,
  'tested-fake': 3,
  tested: 4,
};

/**
 * Mức xác minh của cặp CLI + hãng mà NSA áp dụng.
 * - OpenCode: cách ghép chung (nhà cung cấp tương thích OpenAI) đã chạy thật với máy chủ giả,
 *   nên mọi hãng có địa chỉ chuẩn OpenAI đạt ít nhất `tested-fake`.
 * - Claude Code: cần địa chỉ chuẩn Anthropic VÀ tài liệu của hãng hướng dẫn ghép.
 * - Codex: chỉ OpenAI (Codex chỉ nhận Responses API; các hãng khác chưa xác minh).
 */
export function pairingStatus(provider: ProviderInfo, cli: CliId): CliPairStatus {
  const declared = provider.cli[cli]?.status ?? 'unverified';
  if (cli === 'opencode') {
    if (!provider.endpoints.openai) return 'unsupported';
    return RANK[declared] >= RANK['tested-fake'] ? declared : 'tested-fake';
  }
  if (cli === 'claude') {
    if (!provider.endpoints.anthropic) return 'unsupported';
    return declared;
  }
  return provider.id === 'openai'
    ? declared
    : RANK[declared] >= RANK.documented
      ? declared
      : 'unverified';
}

/** NSA chỉ ghép khi tài liệu chính thức xác nhận hoặc đã chạy thật. */
export function pairingAllowed(provider: ProviderInfo, cli: CliId): boolean {
  return RANK[pairingStatus(provider, cli)] >= RANK.documented;
}

export interface PairingInput {
  provider: ProviderInfo;
  model: string;
  /** null với hãng chạy trên máy (Ollama, LM Studio) — khi đó dùng chuỗi giả theo tài liệu. */
  key: string | undefined;
  fields?: Record<string, string>;
  /** Thư mục riêng của NSA cho CLI (Claude Code: CLAUDE_CONFIG_DIR; Codex: CODEX_HOME). */
  homeDir: string;
  /** OPENCODE_CONFIG_CONTENT sẵn có của người dùng (gộp, không ghi đè). */
  existingOpenCodeConfig?: string;
}

export function buildPairingLaunch(cli: CliId, input: PairingInput): PairingLaunch | null {
  const { provider, model } = input;
  const key = input.key ?? (provider.keyRequired ? undefined : provider.id);
  if (!key) return null;

  if (cli === 'claude') {
    const native = provider.id === 'anthropic';
    const base = native ? null : resolveEndpoint(provider, 'anthropic', input.fields);
    if (!native && !base) return null;
    const haiku = provider.cli.claude?.models?.haiku ?? model;
    return {
      env: {
        // Thư mục cấu hình riêng: không có đăng nhập gói thuê bao → không lộ token của người dùng.
        CLAUDE_CONFIG_DIR: join(input.homeDir, 'claude', provider.id),
        ...(native
          ? { ANTHROPIC_API_KEY: key, ANTHROPIC_AUTH_TOKEN: '' }
          : {
              ANTHROPIC_BASE_URL: base as string,
              ANTHROPIC_AUTH_TOKEN: key,
              ANTHROPIC_API_KEY: '',
            }),
        ANTHROPIC_MODEL: model,
        ANTHROPIC_DEFAULT_OPUS_MODEL: model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: haiku,
        CLAUDE_CODE_SUBAGENT_MODEL: model,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    };
  }

  if (cli === 'opencode') {
    const base = resolveEndpoint(provider, 'openai', input.fields);
    if (!base) return null;
    const providerKey = `nsa-${provider.id}`;
    let config: Record<string, unknown> = {};
    try {
      if (input.existingOpenCodeConfig) {
        config = JSON.parse(input.existingOpenCodeConfig) as Record<string, unknown>;
      }
    } catch {
      config = {};
    }
    const providers =
      config['provider'] && typeof config['provider'] === 'object'
        ? (config['provider'] as Record<string, unknown>)
        : {};
    config = {
      ...config,
      provider: {
        ...providers,
        [providerKey]: {
          name: `${provider.name} (NSA)`,
          npm: '@ai-sdk/openai-compatible',
          // Key không nằm trong cấu hình: OpenCode đọc từ biến môi trường của tiến trình.
          options: { baseURL: base, apiKey: `{env:${PAIRING_KEY_ENV}}` },
          models: { [model]: { name: model } },
        },
      },
    };
    return {
      env: { [PAIRING_KEY_ENV]: key, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
      cliModel: `${providerKey}/${model}`,
    };
  }

  // Codex: chỉ OpenAI — key qua CODEX_API_KEY cho một lần `codex exec` (theo tài liệu Codex).
  if (provider.id !== 'openai') return null;
  return {
    env: { CODEX_API_KEY: key, CODEX_HOME: join(input.homeDir, 'codex', provider.id) },
    cliModel: model,
  };
}
