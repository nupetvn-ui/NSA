import { describe, expect, it } from 'vitest';
import { CORE_VERSION, IPC_CHANNELS, NsaCore, isIpcChannel } from './index.js';

describe('NsaCore.ping', () => {
  it('trả về pong kèm chuỗi gửi đi, phiên bản và thời điểm', () => {
    const core = new NsaCore({ now: () => new Date('2026-01-02T03:04:05.000Z') });
    expect(core.ping('xin chào')).toEqual({
      reply: 'pong',
      echo: 'xin chào',
      coreVersion: CORE_VERSION,
      at: '2026-01-02T03:04:05.000Z',
    });
  });

  it('từ chối tham số không phải chuỗi', () => {
    const core = new NsaCore();
    expect(() => core.ping(42 as unknown as string)).toThrow(TypeError);
  });
});

describe('isIpcChannel', () => {
  it('chỉ nhận các kênh đã khai báo', () => {
    for (const channel of IPC_CHANNELS) expect(isIpcChannel(channel)).toBe(true);
    expect(isIpcChannel('fs:readFile')).toBe(false);
    expect(isIpcChannel(undefined)).toBe(false);
  });
});
