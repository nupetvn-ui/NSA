/**
 * Tìm theo nghĩa (vector) — CHƯA CÓ ở giai đoạn 2. Chỉ có interface để cắm sau mà không phải
 * sửa nơi gọi (xem ADR-0008 mục "Tìm theo vector").
 */
import type { MemoryEntry } from '@nsa/core';

export interface VectorIndex {
  /** `false` khi chưa có bộ cắm nào — nơi gọi chỉ dùng FTS5. */
  readonly available: boolean;
  upsert(entry: MemoryEntry): Promise<void>;
  remove(id: string): Promise<void>;
  rebuild(entries: MemoryEntry[]): Promise<void>;
  /** Mã mục nhớ gần nghĩa nhất, kèm điểm 0–1. */
  query(text: string, limit: number): Promise<{ id: string; score: number }[]>;
}

/** Bộ cắm rỗng mặc định. */
export const noVectorIndex: VectorIndex = {
  available: false,
  upsert: async () => undefined,
  remove: async () => undefined,
  rebuild: async () => undefined,
  query: async () => [],
};
