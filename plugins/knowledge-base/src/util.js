// Tiện ích nhỏ dùng chung. Chạy trong tiến trình plugin (Node), không phụ thuộc gì ngoài node:*.
import { createHash, randomBytes } from 'node:crypto';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export const sha1 = (data) => createHash('sha1').update(data).digest('hex');
export const newId = (prefix) => `${prefix}-${randomBytes(4).toString('hex')}`;

/** Bỏ dấu tiếng Việt, chữ thường, chỉ còn a-z0-9 và gạch ngang (tên nhánh nhớ). */
export function slug(text, fallback = 'chung') {
  const s = String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || fallback;
}

/** Giây → `mm:ss` hoặc `h:mm:ss`. */
export function clock(seconds) {
  const t = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Ước lượng token (tiếng Việt có dấu ~3 ký tự / token; cố ý nghiêng về phía cao). */
export const estimateTokens = (text) => Math.ceil(String(text ?? '').length / 3);

export function extOf(name) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name ?? ''));
  return m ? m[1].toLowerCase() : '';
}

/** Tên file an toàn để lưu trong thư mục dữ liệu (không đường dẫn, không ký tự lạ). */
export function safeName(name) {
  const base = String(name ?? 'file').split(/[\/]/).pop() || 'file';
  return base.replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120) || 'file';
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
