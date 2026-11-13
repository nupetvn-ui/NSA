import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeApiServer, type FakeServer } from '@nsa/adapter-api';
import {
  ProviderHub,
  apiAgentId,
  buildPairingLaunch,
  bundledCatalog,
  createEncryptedFileSecretStore,
  memorySecretStore,
  memorySettingsStore,
  memoryUsageLedger,
  pairingAllowed,
  pickCatalog,
  providerSecretName,
  redactSecrets,
  resolveEndpoint,
  resolveTaskChain,
  defaultSettings,
  validateCatalog,
  type Catalog,
  type OsCipher,
} from './index.js';

const KEY = 'sk-live-ABCDEF0123456789xyzw';

/** Bộ mã hoá giả cho test (giống hình dạng Electron safeStorage). Bản mã không chứa bản rõ. */
export function fakeCipher(available = true): OsCipher {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from([...Buffer.from(s, 'utf8')].map((b) => b ^ 0x5a).reverse()),
    decryptString: (b) => Buffer.from([...b].reverse().map((x) => x ^ 0x5a)).toString('utf8'),
  };
}

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('file dữ liệu nhà cung cấp', () => {
  const catalog = bundledCatalog();

  it('hợp lệ, có đủ các hãng của plan, mỗi hãng ghi nguồn tài liệu', () => {
    expect(validateCatalog(catalog)).toEqual([]);
    const ids = catalog.providers.map((p) => p.id);
    for (const id of [
      'google',
      'openai',
      'anthropic',
      'xai',
      'deepseek',
      'qwen',
      'kimi',
      'glm',
      'minimax',
      'openrouter',
      'groq',
      'together',
      'fireworks',
      'ollama',
      'lmstudio',
    ]) {
      expect(ids).toContain(id);
    }
    for (const p of catalog.providers) {
      expect(p.data.sources.length, p.id).toBeGreaterThan(0);
      for (const s of p.data.sources) expect(s).toMatch(/^https:\/\//);
    }
  });

  it('chỉ máy cục bộ được dùng http', () => {
    const bad = structuredClone(catalog) as Catalog;
    (bad.providers[0] as Catalog['providers'][number]).endpoints.openai = 'http://evil.example/v1';
    expect(validateCatalog(bad).join()).toMatch(/http/);
  });

  it('dùng bản cập nhật mới hơn và hợp lệ; bỏ qua bản cũ / hỏng', () => {
    const newer = { ...structuredClone(catalog), version: '2099.1.1' };
    expect(pickCatalog(newer).catalog.version).toBe('2099.1.1');
    expect(pickCatalog({ ...newer, version: '2000.1.1' }).ignored).toMatch(/không mới hơn/);
    expect(pickCatalog({ schema: 9 }).ignored).toBeTruthy();
    expect(pickCatalog(undefined).catalog).toBe(catalog);
  });

  it('địa chỉ có tham số (Qwen cần Workspace ID)', () => {
    const qwen = catalog.providers.find((p) => p.id === 'qwen');
    if (!qwen) throw new Error('thiếu qwen');
    expect(resolveEndpoint(qwen, 'openai')).toBeNull();
    expect(resolveEndpoint(qwen, 'openai', { workspaceId: 'ws-1' })).toBe(
      'https://ws-1.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    );
    expect(resolveEndpoint(qwen, 'openai', { workspaceId: 'evil.com/x?' })).toBeNull();
  });
});

describe('kho khoá', () => {
  it('file trên đĩa chỉ chứa bản mã; đọc lại được; giao diện chỉ thấy 4 ký tự cuối', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'nsa-sec-')), 'secrets.json');
    const store = createEncryptedFileSecretStore(file, fakeCipher());
    store.set(providerSecretName('deepseek'), `  ${KEY}\n`);
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain(KEY);
    expect(raw).not.toContain(Buffer.from(KEY).toString('base64'));
    const again = createEncryptedFileSecretStore(file, fakeCipher());
    expect(again.get(providerSecretName('deepseek'))).toBe(KEY);
    expect(again.hint(providerSecretName('deepseek'))).toBe('••••xyzw');
    again.delete(providerSecretName('deepseek'));
    expect(createEncryptedFileSecretStore(file, fakeCipher()).has('provider:deepseek')).toBe(false);
  });

  it('không có kho khoá của hệ điều hành thì từ chối lưu (không lưu dạng thô)', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'nsa-sec-')), 'secrets.json');
    const store = createEncryptedFileSecretStore(file, fakeCipher(false));
    expect(() => store.set('provider:x', KEY)).toThrow(/kho khoá/i);
  });

  it('che key ở mọi dạng (thô, base64, URL-encoded)', () => {
    const text = `a ${KEY} b ${Buffer.from(KEY).toString('base64')} c ${encodeURIComponent(KEY)}`;
    const out = redactSecrets(text, [KEY]);
    expect(out).not.toContain(KEY);
    expect(out).not.toContain(Buffer.from(KEY).toString('base64'));
    expect(out).toContain('••••xyzw');
  });
});

describe('chọn model theo việc', () => {
  const providers = bundledCatalog().providers;
  const usable = (ids: string[]) => (id: string) => ids.includes(id);

  it('việc nền mặc định dùng model rẻ nhất của các hãng đã có key', () => {
    const chain = resolveTaskChain(
      'background',
      defaultSettings(),
      providers,
      usable(['deepseek', 'openai', 'anthropic']),
    );
    expect(chain.map((e) => e.ref).slice(0, 3)).toEqual([
      'openai/gpt-6-luna',
      'anthropic/claude-haiku-5-5',
      'deepseek/deepseek-flash',
    ]);
    expect(chain.every((e) => !e.chosen)).toBe(true);
  });

  it('model người dùng chọn đứng trước, rồi dự phòng, rồi phần NSA tự thêm', () => {
    const settings = defaultSettings();
    settings.tasks.background = {
      primary: 'deepseek/deepseek-flash',
      fallbacks: ['google/gemini-3.5-flash-lite'],
    };
    const chain = resolveTaskChain(
      'background',
      settings,
      providers,
      usable(['deepseek', 'google', 'openai']),
    );
    expect(chain.slice(0, 3).map((e) => [e.ref, e.chosen])).toEqual([
      ['deepseek/deepseek-flash', true],
      ['google/gemini-3.5-flash-lite', true],
      ['openai/gpt-6-luna', false],
    ]);
  });

  it('việc cần gọi tool chỉ nhận model đã đánh dấu gọi tool ổn định', () => {
    const chain = resolveTaskChain(
      'main',
      defaultSettings(),
      providers,
      usable(['deepseek', 'anthropic']),
      {
        needsTools: true,
      },
    );
    expect(chain.length).toBeGreaterThan(0);
    expect(chain.every((e) => e.provider.id === 'anthropic')).toBe(true);
  });

  it('nhìn ảnh chỉ nhận model nhìn được ảnh; embedding chỉ nhận model embedding', () => {
    const vision = resolveTaskChain('vision', defaultSettings(), providers, usable(['deepseek']));
    expect(vision.map((e) => e.ref)).toEqual(['deepseek/deepseek-flash']);
    const emb = resolveTaskChain(
      'embedding',
      defaultSettings(),
      providers,
      usable(['openai', 'deepseek']),
    );
    expect(emb.map((e) => e.ref)).toEqual(['openai/text-embedding-3-small']);
  });
});

describe('cấp key cho CLI sẵn có', () => {
  const providers = bundledCatalog().providers;
  const get = (id: string) => {
    const p = providers.find((x) => x.id === id);
    if (!p) throw new Error(id);
    return p;
  };

  it('Claude Code: thư mục cấu hình riêng (không dùng đăng nhập gói thuê bao), key qua biến môi trường', () => {
    const launch = buildPairingLaunch('claude', {
      provider: get('deepseek'),
      model: 'deepseek-flash',
      key: KEY,
      homeDir: 'C:\\nsa\\cli-homes',
    });
    expect(launch?.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: KEY,
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_MODEL: 'deepseek-flash',
    });
    expect(launch?.env['CLAUDE_CONFIG_DIR']).toMatch(/cli-homes.claude.deepseek$/);
    // Anthropic: key gốc qua ANTHROPIC_API_KEY, không đổi địa chỉ.
    const native = buildPairingLaunch('claude', {
      provider: get('anthropic'),
      model: 'claude-sonnet-5-5',
      key: KEY,
      homeDir: 'h',
    });
    expect(native?.env['ANTHROPIC_API_KEY']).toBe(KEY);
    expect(native?.env['ANTHROPIC_BASE_URL']).toBeUndefined();
    expect(native?.env['CLAUDE_CONFIG_DIR']).toBeTruthy();
  });

  it('OpenCode: cấu hình không chứa key, chỉ tham chiếu {env:…}; gộp với cấu hình sẵn có', () => {
    const launch = buildPairingLaunch('opencode', {
      provider: get('deepseek'),
      model: 'deepseek-flash',
      key: KEY,
      homeDir: 'h',
      existingOpenCodeConfig: '{"provider":{"mine":{"npm":"x"}},"theme":"dark"}',
    });
    const config = launch?.env['OPENCODE_CONFIG_CONTENT'] ?? '';
    expect(config).not.toContain(KEY);
    expect(config).toContain('{env:NSA_PROVIDER_KEY}');
    expect(JSON.parse(config)).toMatchObject({ theme: 'dark', provider: { mine: { npm: 'x' } } });
    expect(launch?.env['NSA_PROVIDER_KEY']).toBe(KEY);
    expect(launch?.cliModel).toBe('nsa-deepseek/deepseek-flash');
  });

  it('chỉ ghép cặp tài liệu xác nhận hoặc đã chạy thật', () => {
    expect(pairingAllowed(get('deepseek'), 'claude')).toBe(true);
    expect(pairingAllowed(get('google'), 'claude')).toBe(false);
    expect(pairingAllowed(get('google'), 'opencode')).toBe(true);
    expect(pairingAllowed(get('openai'), 'codex')).toBe(true);
    expect(pairingAllowed(get('deepseek'), 'codex')).toBe(false);
    expect(
      buildPairingLaunch('codex', {
        provider: get('deepseek'),
        model: 'm',
        key: KEY,
        homeDir: 'h',
      }),
    ).toBeNull();
  });
});

describe('ProviderHub', () => {
  function hub(fetchUrl?: string) {
    const catalog = structuredClone(bundledCatalog());
    if (fetchUrl) {
      for (const p of catalog.providers) if (p.id === 'deepseek') p.endpoints.openai = fetchUrl;
    }
    return new ProviderHub({
      catalog,
      settings: memorySettingsStore(),
      secrets: memorySecretStore(),
      ledger: memoryUsageLedger(),
      dataDir: mkdtempSync(join(tmpdir(), 'nsa-hub-')),
    });
  }

  it('dán key DeepSeek → model API xuất hiện trong danh sách agent; xoá key → biến mất', () => {
    const h = hub();
    expect(h.agents()).toEqual([]);
    h.setKey('deepseek', KEY);
    expect(h.agents().map((a) => a.id)).toContain(apiAgentId('deepseek/deepseek-flash'));
    expect(JSON.stringify(h.view())).not.toContain(KEY);
    expect(h.view().providers.find((p) => p.id === 'deepseek')?.keyHint).toBe('••••xyzw');
    h.deleteKey('deepseek');
    expect(h.agents()).toEqual([]);
  });

  it('nút Kiểm tra: gọi /models; key sai thì báo lỗi đã che key', async () => {
    server = await startFakeApiServer({
      expectKey: 'right-key-000000',
      models: ['deepseek-flash'],
    });
    const h = hub(server.openaiUrl);
    h.setKey('deepseek', 'right-key-000000');
    expect(await h.check('deepseek')).toMatchObject({ ok: true });
    h.setKey('deepseek', KEY);
    const bad = await h.check('deepseek');
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/401/);
    expect(JSON.stringify(h.view())).not.toContain(KEY);
  });

  it('chi phí: ước tính theo bảng giá, cảnh báo gần hạn mức, báo vượt', () => {
    const h = hub();
    h.update({ kind: 'budget', monthlyUsd: 1 });
    // deepseek-flash: 0.3 / 1.2 USD mỗi triệu token
    const first = h.recordUsage('deepseek/deepseek-flash', {
      inputTokens: 1_000_000,
      outputTokens: 400_000,
    });
    expect(first.costUsd).toBeCloseTo(0.78);
    expect(first.after.level).toBe('ok');
    const second = h.recordUsage('deepseek/deepseek-flash', {
      inputTokens: 100_000,
      outputTokens: 0,
    });
    expect(second.after.level).toBe('warn');
    const third = h.recordUsage('deepseek/deepseek-flash', {
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(third.after.level).toBe('over');
    expect(h.view().usage[0]).toMatchObject({ ref: 'deepseek/deepseek-flash', calls: 3 });
  });

  it('cặp CLI chưa được xác nhận thì không bật được', () => {
    const h = hub();
    h.setKey('google', KEY);
    expect(() =>
      h.update({ kind: 'pairing', cli: 'claude', model: 'google/gemini-3.8-flash', on: true }),
    ).toThrow();
    h.update({ kind: 'pairing', cli: 'opencode', model: 'google/gemini-3.8-flash', on: true });
    const paired = h.agents().find((a) => a.id === 'opencode+google/gemini-3.8-flash');
    expect(paired).toBeTruthy();
    // Model chưa gọi tool ổn định: CLI được cấp key không được giao việc sửa file.
    expect(paired?.capabilities().editFiles).toBe(false);
  });

  it('nhà cung cấp tự khai báo: chỉ cho https (trừ máy này)', () => {
    const h = hub();
    expect(() =>
      h.update({
        kind: 'custom',
        provider: {
          id: '',
          name: 'Hãng mới',
          standard: 'openai',
          baseUrl: 'http://example.com/v1',
          models: ['m'],
        },
      }),
    ).toThrow(/https/);
    h.update({
      kind: 'custom',
      provider: {
        id: '',
        name: 'Hãng mới',
        standard: 'openai',
        baseUrl: 'https://api.moi.example/v1',
        models: ['m-1'],
      },
    });
    expect(h.agents().map((a) => a.id)).toContain('api:custom-hang-moi/m-1');
  });
});
