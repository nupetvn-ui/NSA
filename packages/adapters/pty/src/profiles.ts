import type { AgentAdapter } from '@nsa/adapter-sdk';
import { createPtyAdapter } from './adapter.js';

/** Cấu hình một CLI bất kỳ do người dùng tự thêm (chưa có adapter riêng). */
export interface CustomCliConfig {
  id: string;
  displayName: string;
  command: string;
  /** Tham số cố định (không chứa prompt). */
  args?: string[];
  /** `stdin`: CLI đọc prompt từ stdin rồi in câu trả lời; `type`: CLI tương tác, NSA gõ prompt vào. */
  input?: 'stdin' | 'type';
  /** Chế độ `type`: biểu thức chính quy (dạng chuỗi) nhận ra lúc CLI trả lời xong. */
  doneWhen?: string;
  idleMs?: number;
}

/** Adapter PTY cho một CLI tuỳ ý — lưới an toàn cho CLI ra đời sau này. */
export function createCustomCliAdapter(config: CustomCliConfig): AgentAdapter {
  return createPtyAdapter({
    id: config.id,
    displayName: config.displayName,
    command: config.command,
    args: () => config.args ?? [],
    input: config.input ?? 'stdin',
    ...(config.doneWhen ? { doneWhen: new RegExp(config.doneWhen) } : {}),
    ...(config.idleMs ? { idleMs: config.idleMs } : {}),
  });
}
