import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AuditLog } from '@nsa/core';

/**
 * Nhật ký bản Cá nhân: lịch sử cục bộ, mỗi tháng một file JSON Lines
 * trong thư mục dữ liệu của app. Người dùng xoá file là xoá lịch sử.
 */
export function createFileAuditLog(dir: string): AuditLog {
  let ready = false;
  return {
    record(entry) {
      if (!ready) {
        mkdirSync(dir, { recursive: true });
        ready = true;
      }
      const file = join(dir, `${entry.at.slice(0, 7)}.jsonl`);
      appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    },
  };
}
