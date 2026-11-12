import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Conversation, ConversationStore } from '@nsa/core';

/** Lưu cuộc trò chuyện ra một file JSON (ghi file tạm rồi đổi tên để không hỏng khi tắt đột ngột). */
export function createFileStore(file: string): ConversationStore {
  return {
    load() {
      try {
        const data = JSON.parse(readFileSync(file, 'utf8')) as { conversations?: Conversation[] };
        return Array.isArray(data.conversations) ? data.conversations : [];
      } catch {
        return [];
      }
    },
    save(conversations) {
      try {
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, JSON.stringify({ version: 1, conversations }, null, 2), 'utf8');
        renameSync(tmp, file);
      } catch (err) {
        console.error('[store] không lưu được cuộc trò chuyện:', err);
      }
    },
  };
}
