/**
 * Đóng gói adapter và file dữ liệu hãng/model thành gói `.nsapkg` ký bằng khoá của NSA (G1, ADR-0016).
 *
 *   node scripts/adapter-packs.mjs keygen --out-private khoa-rieng.pem     # tạo cặp khoá (một lần)
 *   node scripts/adapter-packs.mjs pack --out ../../adapter-release [--only claude,codex]
 *        [--nsa ">=0.1.0"] [--no-catalog] [--publisher NSA]
 *
 * `pack` đọc khoá riêng từ biến môi trường NSA_ADAPTER_SIGNING_KEY (nội dung PEM) hoặc
 * --key-file; không có khoá thì dừng (không bao giờ phát hành gói chưa ký), trừ khi đặt
 * --unsigned (chỉ để thử trên máy phát triển). Không tạo tag hay release; chỉ ghi file vào --out.
 *
 * Phiên bản gói adapter = `version` trong package.json của adapter; gói dữ liệu = `version` của
 * packages/providers/src/catalog.json.
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, createServer } from 'vite';
import { workspaceAliases } from '../../../workspace-aliases.ts';

const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

/** Mã adapter → [thư mục gói, tên hàm tạo]. */
export const ADAPTERS = {
  claude: ['packages/adapters/claude', 'createClaudeAdapter', '@nsa/adapter-claude'],
  codex: ['packages/adapters/codex', 'createCodexAdapter', '@nsa/adapter-codex'],
  opencode: ['packages/adapters/opencode', 'createOpenCodeAdapter', '@nsa/adapter-opencode'],
  gemini: ['packages/adapters/gemini', 'createGeminiAdapter', '@nsa/adapter-gemini'],
  antigravity: [
    'packages/adapters/antigravity',
    'createAntigravityAdapter',
    '@nsa/adapter-antigravity',
  ],
};

export function adapterVersion(id) {
  const [dir] = ADAPTERS[id];
  return JSON.parse(readFileSync(join(repo, dir, 'package.json'), 'utf8')).version;
}

/** Biên dịch một adapter (và mọi thứ nó import) thành một file CommonJS tự đủ. */
export async function bundleAdapterSource(id) {
  const [, factory, pkg] = ADAPTERS[id];
  const work = mkdtempSync(join(tmpdir(), `nsa-bundle-${id}-`));
  try {
    const entry = join(work, 'entry.ts');
    writeFileSync(
      entry,
      `export { ${factory} as createAdapter } from '${pkg}';\nexport const contract = 1;\n`,
    );
    const out = join(work, 'out');
    await build({
      configFile: false,
      root: repo,
      logLevel: 'warn',
      resolve: { alias: workspaceAliases(repo) },
      ssr: { noExternal: true, target: 'node' },
      build: {
        ssr: entry,
        outDir: out,
        minify: false,
        emptyOutDir: true,
        target: 'node24',
        rollupOptions: {
          // Module native nạp từ chính app (globalThis.nsaHostRequire), không đóng vào gói.
          external: ['@lydell/node-pty'],
          output: { format: 'cjs', entryFileNames: 'index.cjs', exports: 'named' },
        },
      },
    });
    return readFileSync(join(out, 'index.cjs'), 'utf8');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Nạp mô-đun TypeScript của repo (release.ts…) mà không cần build trước. */
async function loadLib() {
  const server = await createServer({
    configFile: false,
    root: repo,
    appType: 'custom',
    logLevel: 'silent',
    resolve: { alias: workspaceAliases(repo) },
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const lib = await server.ssrLoadModule('/packages/adapter-host/src/release.ts');
  return { lib, close: () => server.close() };
}

/**
 * `overrides[id]` = { version?, nsa?, patch?(code) } — chỉ để thử: phát hành một bản "giả" của
 * adapter thật (ví dụ đổi tên hiển thị) mà không sửa mã nguồn.
 */
export async function buildPacks({
  out,
  only,
  nsa = '>=0.1.0',
  catalog = true,
  signing,
  unsigned,
  overrides = {},
}) {
  const { lib, close } = await loadLib();
  try {
    let signingKey;
    if (signing)
      signingKey = { key: lib.signingKeyFromPem(signing.pem), publisher: signing.publisher };
    else if (!unsigned) throw new Error('Thiếu khoá ký (NSA_ADAPTER_SIGNING_KEY hoặc --key-file).');
    const packs = [];
    for (const id of only ?? Object.keys(ADAPTERS)) {
      if (!ADAPTERS[id]) throw new Error(`Không có adapter "${id}"`);
      packs.push(
        lib.buildPack(
          {
            kind: 'adapter',
            id,
            version: overrides[id]?.version ?? adapterVersion(id),
            nsa: overrides[id]?.nsa ?? nsa,
            entryContent: (overrides[id]?.patch ?? ((c) => c))(await bundleAdapterSource(id)),
          },
          signingKey,
        ),
      );
    }
    if (catalog) {
      const file = join(repo, 'packages/providers/src/catalog.json');
      const text = readFileSync(file, 'utf8');
      packs.push(
        lib.buildPack(
          {
            kind: 'catalog',
            id: 'provider-catalog',
            version: JSON.parse(text).version,
            nsa,
            entryContent: text,
          },
          signingKey,
        ),
      );
    }
    return { indexFile: lib.writeRelease(out, packs), packs };
  } finally {
    await close();
  }
}

function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) o[a.slice(2)] = true;
      else o[a.slice(2)] = argv[++i];
    } else o._.push(a);
  }
  return o;
}

async function main() {
  const o = args(process.argv.slice(2));
  const cmd = o._[0];
  if (cmd === 'keygen') {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const { createHash } = await import('node:crypto');
    const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const keyId = createHash('sha256')
      .update(Buffer.from(spki, 'base64'))
      .digest('hex')
      .slice(0, 16);
    const file = o['out-private'];
    if (!file || file === true) throw new Error('Cần --out-private <file> để lưu khoá riêng.');
    writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    console.log(
      `Đã ghi khoá RIÊNG vào ${file} — giữ bí mật, đưa vào secret NSA_ADAPTER_SIGNING_KEY, rồi xoá file.`,
    );
    console.log('Dán khối này vào apps/desktop/resources/adapter-trust.json (mục "keys"):');
    console.log(JSON.stringify({ keyId, name: 'NSA', publicKey: spki }, null, 2));
    return;
  }
  if (cmd === 'pack') {
    const pem =
      process.env.NSA_ADAPTER_SIGNING_KEY ||
      (o['key-file'] ? readFileSync(o['key-file'], 'utf8') : '');
    const { indexFile, packs } = await buildPacks({
      out: resolve(o.out || 'adapter-release'),
      ...(o.only ? { only: String(o.only).split(',') } : {}),
      ...(o.nsa ? { nsa: String(o.nsa) } : {}),
      catalog: !o['no-catalog'],
      unsigned: o.unsigned === true,
      ...(pem ? { signing: { pem, publisher: String(o.publisher || 'NSA') } } : {}),
    });
    for (const p of packs)
      console.log(
        `${p.fileName}  ${p.entry.sha256.slice(0, 12)}…  ${(p.bytes.length / 1024).toFixed(0)} KB`,
      );
    console.log(`Chỉ mục: ${indexFile}`);
    return;
  }
  console.error(
    'Dùng: adapter-packs.mjs keygen --out-private <file> | pack --out <dir> [--only a,b] [--nsa ">=0.1.0"] [--no-catalog] [--unsigned]',
  );
  process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
