import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pathsOutside } from './host.js';

describe('confinePaths — đường dẫn tuyệt đối phải nằm trong thư mục được phép', () => {
  const root = join(tmpdir(), 'nsa-data');
  it('chấp nhận tham số thường, bộ lọc ffmpeg và đường dẫn trong thư mục dữ liệu', () => {
    expect(
      pathsOutside(
        [
          '-hide_banner',
          '-i',
          join(root, 'files', 'a.mp4'),
          '-vf',
          'fps=1/30,scale=640:-2',
          join(root, 'f%04d.jpg'),
        ],
        [root],
      ),
    ).toBeNull();
    expect(pathsOutside([`--out=${join(root, 'x')}`], [root])).toBeNull();
  });

  it('chặn đường dẫn ngoài, "..", và địa chỉ mạng', () => {
    const outside = join(tmpdir(), 'khac', 'x.mp4');
    expect(pathsOutside(['-i', outside], [root])).toBe(outside);
    expect(pathsOutside([`--out=${outside}`], [root])).toBe(outside);
    expect(pathsOutside(['-i', `${root}\\..\\khac\\x.mp4`], [root])).not.toBeNull();
    expect(pathsOutside(['-f', 'flv', 'rtmp://may-la/live'], [root])).toBe('rtmp://may-la/live');
    expect(pathsOutside(['-i', 'http://nguoi-la/x.mp4'], [root])).toBe('http://nguoi-la/x.mp4');
    expect(pathsOutside(['-i', 'C:\\Windows\\System32\\config\\SAM'], [root])).not.toBeNull();
  });
});
