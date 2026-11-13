import { describe, expect, it } from 'vitest';
import { customToProvider, guessLocalModel, resolveTaskChain } from './index.js';
import { defaultSettings } from './settings.js';

describe('đoán năng lực model cục bộ / tự khai báo theo tên', () => {
  it('nhận ra model nhìn ảnh và embedding', () => {
    expect(guessLocalModel('llava:7b')).toMatchObject({ vision: true, kind: 'chat' });
    expect(guessLocalModel('llama3.2-vision').tasks).toContain('vision');
    expect(guessLocalModel('qwen2.5vl:7b').vision).toBe(true);
    expect(guessLocalModel('nomic-embed-text')).toMatchObject({
      kind: 'embedding',
      tasks: ['embedding'],
    });
    expect(guessLocalModel('llama3.1:8b').vision).toBeNull();
    expect(guessLocalModel('llama3.1:8b').tasks).not.toContain('vision');
  });

  it('model tự khai báo tên llava / embed vào đúng chuỗi "nhìn ảnh" và "embedding"', () => {
    const provider = customToProvider({
      id: 'custom-may-nha',
      name: 'Máy nhà',
      standard: 'openai',
      baseUrl: 'http://127.0.0.1:11434/v1',
      models: ['llama3.1:8b', 'llava:7b', 'nomic-embed-text'],
    });
    const settings = defaultSettings();
    const vision = resolveTaskChain('vision', settings, [provider], () => true);
    expect(vision.map((e) => e.model.id)).toEqual(['llava:7b']);
    const embed = resolveTaskChain('embedding', settings, [provider], () => true);
    expect(embed.map((e) => e.model.id)).toEqual(['nomic-embed-text']);
  });
});
