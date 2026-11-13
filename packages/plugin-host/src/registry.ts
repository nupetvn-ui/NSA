/**
 * Nguồn kho plugin: một file chỉ mục JSON (đường dẫn trên máy hoặc URL https) đứng sau interface
 * `PluginSource`. Kho trực tuyến thật + thanh toán là giai đoạn 8; ở đây chỉ cần đọc chỉ mục
 * và lấy gói. Định dạng chỉ mục:
 *
 *   { "plugins": [ { "id", "name", "description", "version", "icon", "nsa", "package", "sha256"? } ] }
 *
 * `package` là đường dẫn (tương đối so với file chỉ mục) hoặc URL tới file `.nsapkg`. Có
 * `sha256` thì kiểm mã băm trước khi cài (chữ ký trong gói vẫn là lớp bảo vệ chính).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { RegistryEntry } from '@nsa/plugin-sdk';

const MAX_PACKAGE = 64 * 1024 * 1024;

export type RawRegistryEntry = Omit<RegistryEntry, 'compatible' | 'installed' | 'updateAvailable'>;

/** Nguồn kho — bản trực tuyến (giai đoạn 8) và kho riêng của doanh nghiệp (giai đoạn 9) cắm vào đây. */
export interface PluginSource {
  list(): Promise<RawRegistryEntry[]>;
  fetchPackage(entry: RawRegistryEntry): Promise<Buffer>;
}

const isUrl = (s: string): boolean => /^https?:\/\//i.test(s);

export class PluginRegistry implements PluginSource {
  readonly #location: string;

  constructor(location: string) {
    this.#location = location;
  }

  async #readIndex(): Promise<unknown> {
    if (isUrl(this.#location)) {
      const res = await fetch(this.#location, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`Không tải được chỉ mục kho (${res.status}).`);
      return res.json();
    }
    return JSON.parse(readFileSync(this.#location, 'utf8')) as unknown;
  }

  async list(): Promise<RawRegistryEntry[]> {
    let raw: unknown;
    try {
      raw = await this.#readIndex();
    } catch (err) {
      throw new Error(`Không đọc được kho plugin "${this.#location}": ${(err as Error).message}`, {
        cause: err,
      });
    }
    const plugins = (raw as { plugins?: unknown })?.plugins;
    if (!Array.isArray(plugins))
      throw new Error('Chỉ mục kho sai định dạng: thiếu danh sách "plugins".');
    const out: RawRegistryEntry[] = [];
    for (const item of plugins as Record<string, unknown>[]) {
      const str = (k: string): string => (typeof item[k] === 'string' ? (item[k] as string) : '');
      if (!str('id') || !str('version') || !str('package')) continue; // bỏ mục hỏng, không làm hỏng cả kho
      out.push({
        id: str('id'),
        name: str('name') || str('id'),
        description: str('description'),
        version: str('version'),
        icon: str('icon') || 'emoji:🧩',
        nsa: str('nsa') || '*',
        package: str('package'),
        ...(str('sha256') ? { sha256: str('sha256') } : {}),
      });
    }
    return out;
  }

  async fetchPackage(entry: RawRegistryEntry): Promise<Buffer> {
    let bytes: Buffer;
    if (isUrl(entry.package) || isUrl(this.#location)) {
      const url = isUrl(entry.package)
        ? entry.package
        : new URL(entry.package, this.#location).href;
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`Không tải được gói (${res.status}).`);
      bytes = Buffer.from(await res.arrayBuffer());
    } else {
      const path = isAbsolute(entry.package)
        ? entry.package
        : resolve(dirname(this.#location), entry.package);
      bytes = readFileSync(path);
    }
    if (bytes.length > MAX_PACKAGE) throw new Error('Gói lớn hơn 64 MB.');
    if (entry.sha256) {
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== entry.sha256.toLowerCase()) {
        throw new Error('Mã băm của gói không khớp với chỉ mục kho — gói đã bị thay đổi.');
      }
    }
    return bytes;
  }
}
