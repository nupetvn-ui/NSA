/**
 * Phía phát hành: đóng gói adapter / file dữ liệu thành `.nsapkg` ký bằng khoá của NSA và viết file
 * chỉ mục. Chỉ làm việc với dữ liệu đã có (mã đã biên dịch thành một file CommonJS) — bước biên dịch
 * nằm ở `apps/desktop/scripts/adapter-packs.mjs`.
 */
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { keyIdOf, packFiles, type SigningKey } from '@nsa/plugin-host';
import {
  ADAPTER_CONTRACT,
  ADAPTER_MANIFEST_FILE,
  type AdapterIndexEntry,
  type AdapterPackageKind,
  type AdapterPackageManifest,
} from './types.js';

export interface PackInput {
  kind: AdapterPackageKind;
  id: string;
  version: string;
  /** Khoảng phiên bản NSA chạy được, ví dụ `>=0.1.0`. */
  nsa: string;
  /** Nội dung file vào: mã CommonJS (adapter) hoặc JSON (catalog). */
  entryContent: string | Buffer;
}

export interface BuiltPack {
  entry: AdapterIndexEntry;
  fileName: string;
  bytes: Buffer;
}

export function buildPack(
  input: PackInput,
  signing?: { key: SigningKey; publisher: string },
): BuiltPack {
  const entryName = input.kind === 'adapter' ? 'index.cjs' : 'catalog.json';
  const manifest: AdapterPackageManifest = {
    schema: 1,
    kind: input.kind,
    id: input.id,
    version: input.version,
    nsa: input.nsa,
    entry: entryName,
    ...(input.kind === 'adapter' ? { contract: ADAPTER_CONTRACT } : {}),
  };
  const files: Record<string, string> = {
    [ADAPTER_MANIFEST_FILE]: Buffer.from(JSON.stringify(manifest, null, 2)).toString('base64'),
    [entryName]: Buffer.from(input.entryContent).toString('base64'),
  };
  const bytes = packFiles(files, signing ? { key: signing.key, publisher: signing.publisher } : {});
  const fileName = `${input.id}-${input.version}.nsapkg`;
  return {
    fileName,
    bytes,
    entry: {
      id: input.id,
      kind: input.kind,
      version: input.version,
      nsa: input.nsa,
      package: fileName,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  };
}

/** Ghi các gói và `index.json` vào một thư mục (để đăng lên GitHub Releases hoặc máy chủ thử). */
export function writeRelease(outDir: string, packs: BuiltPack[]): string {
  mkdirSync(outDir, { recursive: true });
  for (const p of packs) writeFileSync(join(outDir, p.fileName), p.bytes);
  const indexFile = join(outDir, 'index.json');
  writeFileSync(
    indexFile,
    JSON.stringify(
      { schema: 1, updatedAt: new Date().toISOString(), packages: packs.map((p) => p.entry) },
      null,
      2,
    ),
  );
  return indexFile;
}

/** Dựng khoá ký từ khoá riêng PEM (PKCS8) — ví dụ lấy từ secret của CI. */
export function signingKeyFromPem(privateKeyPem: string): SigningKey {
  const publicKey = createPublicKey(createPrivateKey(privateKeyPem))
    .export({ type: 'spki', format: 'der' })
    .toString('base64');
  return { privateKeyPem, publicKey, keyId: keyIdOf(publicKey) };
}
