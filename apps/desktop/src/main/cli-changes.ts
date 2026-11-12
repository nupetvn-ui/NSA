import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FingerprintStore, StoredFingerprint } from '@nsa/core';

/** Lưu dấu vân tay CLI ra file JSON trong thư mục dữ liệu của app. */
export function createFingerprintStore(file: string): FingerprintStore {
  return {
    load() {
      try {
        return JSON.parse(readFileSync(file, 'utf8')) as Record<string, StoredFingerprint>;
      } catch {
        return {};
      }
    },
    save(data) {
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2), 'utf8');
        renameSync(`${file}.tmp`, file);
      } catch (err) {
        console.error('[cli-watch] không lưu được:', err);
      }
    },
  };
}
