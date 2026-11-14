import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { AdapterIndexEntry, AdapterSource } from './types.js';

const MAX_PACKAGE = 64 * 1024 * 1024;
const isUrl = (s: string): boolean => /^https?:\/\//i.test(s);

/** Chỉ cho http thường ở địa chỉ loopback (máy chủ thử); còn lại bắt buộc https. */
function checkTransport(url: string): void {
  const u = new URL(url);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
    throw new Error(`Chỉ nhận địa chỉ https (hoặc http trên máy này): ${u.origin}`);
  }
}

/** Mặc định: file chỉ mục trên GitHub Releases của repo (một release cố định tên `adapters`). */
export const DEFAULT_ADAPTER_INDEX_URL =
  'https://github.com/nupetvn-ui/NSA/releases/download/adapters/index.json';

/**
 * Nguồn từ một file chỉ mục JSON (URL https hoặc đường dẫn trên máy):
 *
 *   { "schema": 1, "packages": [ { "id", "kind", "version", "nsa", "package", "sha256"? } ] }
 *
 * Chỉ mục KHÔNG được tin: gói vẫn phải qua kiểm chữ ký, tương thích và phiên bản mới hơn.
 */
export class IndexAdapterSource implements AdapterSource {
  readonly #location: string;

  constructor(location: string) {
    this.#location = location;
  }

  async #fetchBytes(location: string, limit: number): Promise<Buffer> {
    if (isUrl(location)) {
      checkTransport(location);
      const res = await fetch(location, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`Tải ${location} lỗi (${res.status}).`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > limit) throw new Error('Gói lớn quá giới hạn.');
      return bytes;
    }
    return readFileSync(location);
  }

  #resolve(rel: string): string {
    if (isUrl(rel)) return rel;
    if (isUrl(this.#location)) return new URL(rel, this.#location).toString();
    return isAbsolute(rel) ? rel : resolve(dirname(this.#location), rel);
  }

  async list(): Promise<AdapterIndexEntry[]> {
    const raw = JSON.parse((await this.#fetchBytes(this.#location, 1024 * 1024)).toString('utf8'));
    const packages = (raw as { packages?: unknown })?.packages;
    if (!Array.isArray(packages)) throw new Error('Chỉ mục sai định dạng: thiếu "packages".');
    const out: AdapterIndexEntry[] = [];
    for (const item of packages as Record<string, unknown>[]) {
      const str = (k: string): string => (typeof item[k] === 'string' ? (item[k] as string) : '');
      const kind = str('kind');
      if (!str('id') || !str('version') || !str('package')) continue;
      if (kind !== 'adapter' && kind !== 'catalog') continue;
      out.push({
        id: str('id'),
        kind,
        version: str('version'),
        nsa: str('nsa') || '*',
        package: str('package'),
        ...(str('sha256') ? { sha256: str('sha256') } : {}),
      });
    }
    return out;
  }

  fetchPackage(entry: AdapterIndexEntry): Promise<Buffer> {
    return this.#fetchBytes(this.#resolve(entry.package), MAX_PACKAGE);
  }
}
