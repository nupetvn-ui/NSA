/**
 * Quy tắc tự duyệt của hộp duyệt (PLAN.md, mục NSA Mem): tự nhận khi độ tin cậy cao và không
 * mâu thuẫn; mâu thuẫn, nhạy cảm hoặc là quy tắc hành vi thì chờ người duyệt.
 * Hàm thuần — test được không cần đĩa.
 */
import type { MemoryBranch, MemoryDraft, MemoryEntry } from '@nsa/core';
import { slugify } from './markdown.js';
import { tokenize } from './search-index.js';

const SENSITIVE: { pattern: RegExp; what: string }[] = [
  {
    pattern: /\b(mật khẩu|mat khau|password|passwd|pwd|passcode|mã pin|ma pin|otp)\b/i,
    what: 'mật khẩu / mã PIN',
  },
  {
    pattern:
      /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_\w{20,}|AKIA[0-9A-Z]{16}|xox[abp]-[\w-]{10,}|AIza[\w-]{30,})/,
    what: 'khoá API / token',
  },
  { pattern: /\b(api[ _-]?key|secret|token|bearer)\b\s*[:=]/i, what: 'khoá bí mật' },
  { pattern: /\b(?:\d[ -]?){13,19}\b/, what: 'số thẻ / số tài khoản' },
  { pattern: /\b\d{9}\b|\b\d{12}\b/, what: 'số CMND / CCCD' },
  { pattern: /(?:\+?84|\b0)(?:[ .-]?\d){9}\b/, what: 'số điện thoại' },
  {
    pattern: /\b(stk|số tài khoản|so tai khoan|cccd|cmnd|hộ chiếu|ho chieu|passport)\b/i,
    what: 'giấy tờ / tài khoản',
  },
];

/** Lý do nội dung có thể nhạy cảm, hoặc `null`. */
export function detectSensitive(text: string): string | null {
  return SENSITIVE.find((r) => r.pattern.test(text))?.what ?? null;
}

function normalizeBody(text: string): string {
  return tokenize(text).join(' ');
}

function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export interface ConflictReport {
  /** Mục nói gần như y hệt — đề xuất là trùng lặp. */
  duplicate?: MemoryEntry;
  /** Mục cùng chủ đề / rất giống mà nội dung khác — có thể mâu thuẫn. */
  conflicts: MemoryEntry[];
}

/** Ngưỡng giống nhau (Jaccard trên từ đã bỏ dấu) để coi hai mục là cùng một ý. */
const SIMILAR = 0.5;

/**
 * Tìm mục trùng / mâu thuẫn với đề xuất:
 * - cùng `subject` (khoá chủ đề) mà nội dung khác → mâu thuẫn;
 * - nội dung giống ≥ 50% từ mà không y hệt → có thể mâu thuẫn (chờ người xem);
 * - nội dung y hệt (sau khi bỏ dấu, bỏ từ phổ biến) → trùng lặp.
 * `targetId` (đề xuất sửa một mục) thì không so với chính mục đó.
 */
export function findConflicts(
  draft: Pick<MemoryDraft, 'title' | 'body' | 'subject'>,
  entries: MemoryEntry[],
  targetId?: string,
): ConflictReport {
  const body = normalizeBody(draft.body);
  const tokens = tokenize(`${draft.title} ${draft.body}`);
  const subject = draft.subject ? slugify(draft.subject) : '';
  const conflicts: MemoryEntry[] = [];
  let duplicate: MemoryEntry | undefined;
  for (const entry of entries) {
    if (entry.id === targetId) continue;
    const sameBody = normalizeBody(entry.body) === body && body !== '';
    if (sameBody) {
      duplicate ??= entry;
      continue;
    }
    const sameSubject = subject !== '' && entry.subject && slugify(entry.subject) === subject;
    if (sameSubject || jaccard(tokens, tokenize(`${entry.title} ${entry.body}`)) >= SIMILAR) {
      conflicts.push(entry);
    }
  }
  return { ...(duplicate ? { duplicate } : {}), conflicts };
}

export type Judgement =
  | { verdict: 'accept' }
  | { verdict: 'review'; reasons: string[] }
  | { verdict: 'reject'; reasons: string[] };

/** Quyết định tự duyệt cho một đề xuất. */
export function judgeProposal(
  draft: MemoryDraft,
  branch: MemoryBranch | undefined,
  report: ConflictReport,
  options: { targetId?: string } = {},
): Judgement {
  if (report.duplicate && report.conflicts.length === 0 && !options.targetId) {
    return {
      verdict: 'reject',
      reasons: [`Trùng với mục đã có: "${report.duplicate.title}"`],
    };
  }
  const reasons: string[] = [];
  if (!branch) reasons.push(`Nhánh "${draft.branch}" chưa có — người dùng chọn nhánh khi duyệt`);
  else {
    if (!branch.autoApprove) reasons.push(`Nhánh "${branch.title}" luôn cần người duyệt`);
    if (draft.confidence < branch.minConfidence) {
      reasons.push(
        `Độ tin cậy ${Math.round(draft.confidence * 100)}% thấp hơn ngưỡng tự nhận ${Math.round(branch.minConfidence * 100)}%`,
      );
    }
  }
  if (draft.kind === 'rule') reasons.push('Là quy tắc hành vi — luôn cần người duyệt');
  const sensitive = draft.sensitive
    ? 'được đánh dấu nhạy cảm'
    : detectSensitive(`${draft.title}\n${draft.body}`);
  if (sensitive) reasons.push(`Có thể chứa thông tin nhạy cảm (${sensitive})`);
  if (options.targetId) reasons.push('Sửa một mục đã có');
  if (report.conflicts.length) {
    reasons.push(
      `Mâu thuẫn với mục đã có: ${report.conflicts.map((c) => `"${c.title}"`).join(', ')}`,
    );
  }
  return reasons.length ? { verdict: 'review', reasons } : { verdict: 'accept' };
}
