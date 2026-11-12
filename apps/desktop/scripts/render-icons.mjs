// Xuất các file PNG của icon từ build/icon.svg.
//   build/icon.png      1024px — electron-builder tự chuyển thành .ico cho bộ cài và NSA.exe
//   resources/icon.png   256px — icon cửa sổ và logo trong giao diện
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = await readFile(join(root, 'build/icon.svg'));

const outputs = [
  { file: 'build/icon.png', size: 1024 },
  { file: 'resources/icon.png', size: 256 },
];

for (const { file, size } of outputs) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  await writeFile(join(root, file), png);
  console.log(`${file} (${size}px, ${png.length} byte)`);
}
