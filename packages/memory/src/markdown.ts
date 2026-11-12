/**
 * Đọc / ghi file Markdown có phần đầu (frontmatter). Mỗi dòng phần đầu là `khoá: <JSON>` —
 * đó vẫn là YAML hợp lệ, nên mở bằng trình soạn thảo bất kỳ cũng đọc được, mà không cần
 * thư viện YAML.
 */
import type {
  MemoryBranch,
  MemoryEntry,
  MemoryKind,
  MemoryScope,
  MemorySource,
  MemorySourceKind,
} from '@nsa/core';

export function serializeFrontmatter(fields: Record<string, unknown>, body: string): string {
  const lines = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return `---\n${lines.join('\n')}\n---\n\n${body.trim()}\n`;
}

export function parseFrontmatter(text: string): { fields: Record<string, unknown>; body: string } {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!match) return { fields: {}, body: normalized.trim() };
  const fields: Record<string, unknown> = {};
  for (const line of (match[1] ?? '').split('\n')) {
    const m = /^([A-Za-z][\w-]*):\s?(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1] as string;
    const raw = (m[2] ?? '').trim();
    try {
      fields[key] = JSON.parse(raw);
    } catch {
      // Người dùng tự sửa file và viết kiểu YAML trần (không có ngoặc kép).
      fields[key] = raw === 'true' ? true : raw === 'false' ? false : raw;
    }
  }
  return { fields, body: (match[2] ?? '').trim() };
}

const KINDS: MemoryKind[] = ['fact', 'preference', 'rule'];
const SOURCES: MemorySourceKind[] = ['manual', 'chat', 'distill', 'import', 'agent'];

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function entryToMarkdown(entry: MemoryEntry): string {
  return serializeFrontmatter(
    {
      id: entry.id,
      title: entry.title,
      kind: entry.kind,
      subject: entry.subject,
      confidence: entry.confidence,
      sensitive: entry.sensitive,
      source: entry.source,
      owner: entry.owner,
      scope: entry.scope,
      team: entry.team,
      tags: entry.tags,
      created: entry.created,
      updated: entry.updated,
    },
    entry.body,
  );
}

/** Đọc một mục nhớ; thiếu trường thì lấy giá trị an toàn (người dùng có thể sửa file tay). */
export function entryFromMarkdown(text: string, branch: string, fileId: string): MemoryEntry {
  const { fields, body } = parseFrontmatter(text);
  const kind = KINDS.includes(fields['kind'] as MemoryKind)
    ? (fields['kind'] as MemoryKind)
    : 'fact';
  const rawSource = (fields['source'] ?? {}) as Partial<MemorySource>;
  const source: MemorySource = {
    kind: SOURCES.includes(rawSource.kind as MemorySourceKind)
      ? (rawSource.kind as MemorySourceKind)
      : 'manual',
    ...(typeof rawSource.ref === 'string' ? { ref: rawSource.ref } : {}),
    ...(typeof rawSource.agentId === 'string' ? { agentId: rawSource.agentId } : {}),
  };
  const confidence = Number(fields['confidence']);
  const scope: MemoryScope = fields['scope'] === 'team' ? 'team' : 'personal';
  const created = str(fields['created'], new Date(0).toISOString());
  const title = str(fields['title']) || body.split('\n')[0]?.slice(0, 80) || fileId;
  return {
    id: str(fields['id'], fileId) || fileId,
    branch,
    title,
    body,
    kind,
    ...(typeof fields['subject'] === 'string' && fields['subject']
      ? { subject: fields['subject'] }
      : {}),
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
    sensitive: fields['sensitive'] === true,
    source,
    owner: str(fields['owner'], 'unknown'),
    scope,
    ...(typeof fields['team'] === 'string' ? { team: fields['team'] } : {}),
    tags: Array.isArray(fields['tags']) ? fields['tags'].map(String) : [],
    created,
    updated: str(fields['updated'], created),
  };
}

export type BranchMeta = Omit<MemoryBranch, 'path' | 'count'>;

export function branchToMarkdown(meta: BranchMeta): string {
  return serializeFrontmatter(
    {
      title: meta.title,
      autoApprove: meta.autoApprove,
      minConfidence: meta.minConfidence,
      hidden: meta.hidden,
    },
    meta.description,
  );
}

export function branchFromMarkdown(text: string, path: string): BranchMeta {
  const { fields, body } = parseFrontmatter(text);
  const min = Number(fields['minConfidence']);
  return {
    title: str(fields['title']) || path.split('/').pop() || path,
    description: body,
    autoApprove: fields['autoApprove'] !== false,
    minConfidence: Number.isFinite(min) ? min : 0.8,
    hidden: fields['hidden'] === true,
  };
}

/** Chuỗi không dấu, chữ thường, gạch nối — dùng cho tên thư mục nhánh và khoá chủ đề. */
export function slugify(text: string): string {
  return foldText(text)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** Bỏ dấu tiếng Việt, chữ thường. */
export function foldText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}
