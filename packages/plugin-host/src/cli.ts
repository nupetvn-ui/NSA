#!/usr/bin/env node
/**
 * Công cụ dòng lệnh cho người viết plugin:
 *   nsa-plugin validate <thư-mục>
 *   nsa-plugin keygen <tên-file-khoá>
 *   nsa-plugin pack <thư-mục> [--out file.nsapkg] [--key file-khoá --publisher "Tên"]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  PACKAGE_EXTENSION,
  collectDirectory,
  generateSigningKey,
  keyIdOf,
  packDirectory,
  readManifestFromFiles,
  type SigningKey,
} from './pack.js';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function main(argv: string[]): number {
  const [command, target, ...rest] = argv;
  try {
    switch (command) {
      case 'validate': {
        if (!target) throw new Error('Thiếu thư mục plugin.');
        const manifest = readManifestFromFiles(collectDirectory(target));
        console.log(`OK: ${manifest.name} (${manifest.id}) ${manifest.version}`);
        return 0;
      }
      case 'keygen': {
        if (!target) throw new Error('Thiếu tên file khoá.');
        const key = generateSigningKey();
        writeFileSync(resolve(target), JSON.stringify(key, null, 2), { mode: 0o600 });
        console.log(`Đã tạo khoá ${key.keyId} → ${target}`);
        console.log('GIỮ BÍ MẬT file này (chứa khoá riêng). Khoá công khai để người dùng tin cậy:');
        console.log(key.publicKey);
        return 0;
      }
      case 'pack': {
        if (!target) throw new Error('Thiếu thư mục plugin.');
        const keyFile = flag(rest, '--key');
        const publisher = flag(rest, '--publisher');
        let key: SigningKey | undefined;
        if (keyFile) {
          key = JSON.parse(readFileSync(keyFile, 'utf8')) as SigningKey;
          if (keyIdOf(key.publicKey) !== key.keyId) throw new Error('File khoá hỏng.');
        }
        const manifest = readManifestFromFiles(collectDirectory(target));
        const out =
          flag(rest, '--out') ??
          `${basename(resolve(target))}-${manifest.version}${PACKAGE_EXTENSION}`;
        const bytes = packDirectory(target, {
          ...(key ? { key } : {}),
          ...(publisher ? { publisher } : {}),
        });
        writeFileSync(out, bytes);
        console.log(
          `Đã tạo ${out} (${bytes.length} byte, ${key ? `đã ký ${key.keyId}` : 'CHƯA KÝ'})`,
        );
        return 0;
      }
      default:
        console.log(
          'Dùng: nsa-plugin validate <thư mục> | keygen <file> | pack <thư mục> [--out f] [--key f --publisher "Tên"]',
        );
        return command ? 1 : 0;
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
