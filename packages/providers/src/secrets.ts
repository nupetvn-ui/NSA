/**
 * Kho khoá (ADR-0009). Lõi chỉ biết interface `SecretStore`; bản desktop cắm bộ mã hoá của
 * hệ điều hành (Electron `safeStorage` → Windows DPAPI / macOS Keychain / libsecret).
 *
 * Quy tắc:
 * - File trên đĩa chỉ chứa bản đã mã hoá; không có bộ mã hoá của hệ điều hành thì KHÔNG lưu.
 * - Key không bao giờ đi ra ngoài tiến trình main, trừ vào biến môi trường của tiến trình CLI
 *   cần nó (theo từng lượt) và vào header của lời gọi HTTP tới hãng.
 * - Giao diện chỉ thấy bốn ký tự cuối (`keyHint`).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Bộ mã hoá của hệ điều hành (Electron safeStorage có đúng hình dạng này). */
export interface OsCipher {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface SecretStore {
  /** Kho khoá của hệ điều hành có dùng được không (không thì không lưu được key). */
  available(): boolean;
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  delete(name: string): void;
  has(name: string): boolean;
  /** Bốn ký tự cuối để hiển thị — không bao giờ trả cả key cho giao diện. */
  hint(name: string): string | undefined;
  /** Mọi giá trị đang lưu — chỉ để che (redact) khỏi văn bản trước khi ghi ra đâu đó. */
  values(): string[];
}

export function keyHint(value: string): string {
  const tail = value.trim().slice(-4);
  return value.length > 8 ? `••••${tail}` : '••••';
}

/** Tên khoá trong kho cho key của một nhà cung cấp. */
export function providerSecretName(providerId: string): string {
  return `provider:${providerId}`;
}

const NAME = /^[\w:.-]{1,80}$/;

/**
 * Kho khoá lưu ra một file JSON; mỗi giá trị được mã hoá bằng `cipher` (base64 của bản mã).
 * Không có bộ mã hoá dùng được thì `set` báo lỗi thay vì lưu dạng thô.
 */
export function createEncryptedFileSecretStore(file: string, cipher: OsCipher): SecretStore {
  let cache: Map<string, string> | null = null;

  const load = (): Map<string, string> => {
    if (cache) return cache;
    cache = new Map();
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return cache;
    }
    const entries = (raw as { secrets?: Record<string, string> }).secrets ?? {};
    for (const [name, b64] of Object.entries(entries)) {
      try {
        cache.set(name, cipher.decryptString(Buffer.from(b64, 'base64')));
      } catch {
        // Không giải mã được (đổi máy / đổi tài khoản Windows): bỏ qua, người dùng dán lại key.
      }
    }
    return cache;
  };

  const save = (): void => {
    const secrets: Record<string, string> = {};
    for (const [name, value] of load()) {
      secrets[name] = cipher.encryptString(value).toString('base64');
    }
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, secrets }), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
  };

  return {
    available: () => cipher.isEncryptionAvailable(),
    get: (name) => load().get(name),
    has: (name) => load().has(name),
    set(name, value) {
      if (!NAME.test(name)) throw new Error('Tên khoá không hợp lệ');
      const trimmed = value.trim();
      if (!trimmed) throw new Error('Key trống');
      if (/\s/.test(trimmed)) throw new Error('Key không được chứa khoảng trắng');
      if (!cipher.isEncryptionAvailable()) {
        throw new Error(
          'Kho khoá của hệ điều hành không dùng được nên NSA không lưu key (không lưu dạng thô).',
        );
      }
      load().set(name, trimmed);
      save();
    },
    delete(name) {
      if (load().delete(name)) save();
    },
    hint(name) {
      const value = load().get(name);
      return value === undefined ? undefined : keyHint(value);
    },
    values: () => [...load().values()],
  };
}

/** Kho khoá trong bộ nhớ — cho test. */
export function memorySecretStore(initial: Record<string, string> = {}): SecretStore {
  const map = new Map(Object.entries(initial));
  return {
    available: () => true,
    get: (n) => map.get(n),
    has: (n) => map.has(n),
    set: (n, v) => void map.set(n, v.trim()),
    delete: (n) => void map.delete(n),
    hint: (n) => (map.has(n) ? keyHint(map.get(n) as string) : undefined),
    values: () => [...map.values()],
  };
}

/**
 * Che mọi key đã biết trong một chuỗi (thông báo lỗi của hãng có thể in lại key).
 * Che cả dạng base64 / URL-encoded, vì một số máy chủ trả lại header đã mã hoá.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 6) continue;
    for (const form of secretForms(secret)) {
      if (out.includes(form)) out = out.split(form).join(keyHint(secret));
    }
  }
  return out;
}

/** Các dạng một key có thể xuất hiện trong văn bản / file. */
export function secretForms(secret: string): string[] {
  return [
    secret,
    encodeURIComponent(secret),
    Buffer.from(secret).toString('base64'),
    JSON.stringify(secret).slice(1, -1),
  ].filter((v, i, a) => a.indexOf(v) === i);
}
