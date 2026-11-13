/**
 * Định dạng gói plugin `.nsapkg` và chữ ký.
 *
 * Gói = JSON nén gzip: `{ format, files: { "đường/dẫn": <base64> }, signature? }`. Cố ý không
 * dùng zip để khỏi thêm phụ thuộc (và khỏi dính lỗ hổng "zip slip"): mọi đường dẫn đều được
 * kiểm trước khi ghi ra đĩa. Chữ ký Ed25519 (node:crypto) ký lên một bản mô tả chuẩn hoá gồm
 * tên nhà phát hành và mã băm SHA-256 của TỪNG file — sửa / thêm / xoá một byte nào sau khi
 * ký thì chữ ký không còn khớp và gói bị từ chối (`tampered`).
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  MANIFEST_FILE,
  formatManifestErrors,
  validateManifest,
  type PluginManifest,
  type SignatureStatus,
} from '@nsa/plugin-sdk';

export const PACKAGE_FORMAT = 'nsa-plugin-package@1';
export const PACKAGE_EXTENSION = '.nsapkg';

const MAX_FILES = 2000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git']);

export interface PackageSignature {
  algorithm: 'ed25519';
  /** Khoá công khai (DER spki, base64). */
  publicKey: string;
  /** Mã khoá = 16 ký tự đầu của SHA-256(khoá công khai). */
  keyId: string;
  publisher: string;
  signature: string;
}

export interface PluginPackage {
  format: typeof PACKAGE_FORMAT;
  /** Đường dẫn tương đối (dấu `/`) → nội dung base64. */
  files: Record<string, string>;
  signature?: PackageSignature;
}

export interface TrustedPublisher {
  keyId: string;
  name: string;
  /** Khoá công khai (DER spki, base64). */
  publicKey: string;
}

export interface SigningKey {
  /** Khoá riêng PEM (PKCS8). Giữ bí mật. */
  privateKeyPem: string;
  publicKey: string;
  keyId: string;
}

export function keyIdOf(publicKey: string): string {
  return createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex').slice(0, 16);
}

export function generateSigningKey(): SigningKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: spki,
    keyId: keyIdOf(spki),
  };
}

/** Bản mô tả chuẩn hoá được ký: tên nhà phát hành + SHA-256 từng file, theo thứ tự tên. */
function signedPayload(files: Record<string, string>, publisher: string): Buffer {
  const hashes: Record<string, string> = {};
  for (const path of Object.keys(files).sort()) {
    hashes[path] = createHash('sha256')
      .update(Buffer.from(files[path] ?? '', 'base64'))
      .digest('hex');
  }
  return Buffer.from(JSON.stringify({ format: PACKAGE_FORMAT, publisher, files: hashes }), 'utf8');
}

// ---------------------------------------------------------------- Đường dẫn an toàn

/** Chuẩn hoá một đường dẫn trong gói; ném lỗi nếu có thể thoát ra ngoài thư mục đích. */
export function safeRelativePath(path: string): string {
  const p = path.replace(/\\/g, '/');
  if (
    p === '' ||
    p.startsWith('/') ||
    /^[a-zA-Z]:/.test(p) ||
    p.split('/').some((seg) => seg === '..' || seg === '.' || seg === '') ||
    p.includes('\0')
  ) {
    throw new Error(`Đường dẫn không hợp lệ trong gói: "${path}"`);
  }
  return p;
}

// ---------------------------------------------------------------- Đóng gói

/** Đọc một thư mục thành bảng file (bỏ node_modules, .git, file .nsapkg). */
export function collectDirectory(dir: string): Record<string, string> {
  const root = resolve(dir);
  const files: Record<string, string> = {};
  let total = 0;
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(full);
        continue;
      }
      if (!stat.isFile() || name.endsWith(PACKAGE_EXTENSION)) continue;
      const rel = relative(root, full).split(sep).join('/');
      const data = readFileSync(full);
      total += data.length;
      if (Object.keys(files).length >= MAX_FILES)
        throw new Error(`Quá ${MAX_FILES} file trong plugin`);
      if (total > MAX_TOTAL_BYTES) throw new Error('Plugin lớn quá 64 MB');
      files[safeRelativePath(rel)] = data.toString('base64');
    }
  };
  walk(root);
  return files;
}

export function readManifestFromFiles(files: Record<string, string>): PluginManifest {
  const raw = files[MANIFEST_FILE];
  if (raw === undefined) throw new Error(`Thiếu file ${MANIFEST_FILE} ở gốc plugin.`);
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch (err) {
    throw new Error(`${MANIFEST_FILE} không phải JSON hợp lệ: ${(err as Error).message}`, {
      cause: err,
    });
  }
  const result = validateManifest(json);
  if (!result.ok) {
    throw new Error(`${MANIFEST_FILE} có lỗi:\n${formatManifestErrors(result.errors)}`);
  }
  const missing: string[] = [];
  const m = result.manifest;
  const need = (path: string | null, what: string): void => {
    if (path && files[path] === undefined) missing.push(`${what} "${path}"`);
  };
  need(m.main, '"main"');
  for (const s of m.screens) need(s.entry, `màn hình "${s.id}"`);
  if (m.icon.startsWith('emoji:') === false) need(m.icon, '"icon"');
  if (missing.length > 0) throw new Error(`Gói thiếu file: ${missing.join(', ')}.`);
  return m;
}

/** Đóng gói một thư mục plugin thành nội dung file `.nsapkg`, ký nếu có khoá. */
export function packDirectory(
  dir: string,
  options: { key?: SigningKey; publisher?: string } = {},
): Buffer {
  const files = collectDirectory(dir);
  readManifestFromFiles(files); // báo lỗi manifest sớm, trước khi đóng gói
  const pkg: PluginPackage = { format: PACKAGE_FORMAT, files };
  if (options.key) {
    const publisher = options.publisher?.trim();
    if (!publisher) throw new Error('Cần tên nhà phát hành để ký gói.');
    pkg.signature = {
      algorithm: 'ed25519',
      publicKey: options.key.publicKey,
      keyId: options.key.keyId,
      publisher,
      signature: sign(
        null,
        signedPayload(files, publisher),
        createPrivateKey(options.key.privateKeyPem),
      ).toString('base64'),
    };
  }
  return gzipSync(Buffer.from(JSON.stringify(pkg), 'utf8'));
}

export function readPackage(bytes: Buffer): PluginPackage {
  let json: unknown;
  try {
    json = JSON.parse(gunzipSync(bytes, { maxOutputLength: 200 * 1024 * 1024 }).toString('utf8'));
  } catch {
    throw new Error('File không phải gói plugin NSA (.nsapkg) hợp lệ.');
  }
  const pkg = json as Partial<PluginPackage> | null;
  if (
    !pkg ||
    pkg.format !== PACKAGE_FORMAT ||
    typeof pkg.files !== 'object' ||
    pkg.files === null
  ) {
    throw new Error('File không phải gói plugin NSA (.nsapkg) hợp lệ.');
  }
  const files: Record<string, string> = {};
  for (const [path, data] of Object.entries(pkg.files)) {
    if (typeof data !== 'string') throw new Error('Gói plugin hỏng: nội dung file sai kiểu.');
    files[safeRelativePath(path)] = data;
  }
  if (Object.keys(files).length > MAX_FILES) throw new Error(`Quá ${MAX_FILES} file trong gói`);
  return { format: PACKAGE_FORMAT, files, ...(pkg.signature ? { signature: pkg.signature } : {}) };
}

// ---------------------------------------------------------------- Kiểm chữ ký

export interface Verification {
  status: SignatureStatus;
  publisher?: string;
  keyId?: string;
}

export function verifyPackage(pkg: PluginPackage, trusted: TrustedPublisher[]): Verification {
  const sig = pkg.signature;
  if (!sig) return { status: 'unsigned' };
  try {
    if (sig.algorithm !== 'ed25519' || keyIdOf(sig.publicKey) !== sig.keyId) {
      return { status: 'tampered' };
    }
    const ok = verify(
      null,
      signedPayload(pkg.files, sig.publisher),
      createPublicKey({ key: Buffer.from(sig.publicKey, 'base64'), format: 'der', type: 'spki' }),
      Buffer.from(sig.signature, 'base64'),
    );
    if (!ok) return { status: 'tampered' };
  } catch {
    return { status: 'tampered' };
  }
  const known = trusted.find((t) => t.keyId === sig.keyId && t.publicKey === sig.publicKey);
  return known
    ? { status: 'trusted', publisher: known.name, keyId: sig.keyId }
    : { status: 'untrusted', publisher: sig.publisher, keyId: sig.keyId };
}

/** Ghi các file của gói ra thư mục (đã kiểm đường dẫn; không ghi đè ngoài thư mục đích). */
export function extractFiles(files: Record<string, string>, dest: string): void {
  const root = resolve(dest);
  for (const [path, data] of Object.entries(files)) {
    const target = resolve(root, safeRelativePath(path));
    if (!target.startsWith(root + sep))
      throw new Error(`Đường dẫn thoát khỏi thư mục cài: ${path}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(data, 'base64'));
  }
}
