import type { PingResult } from './ipc.js';

export const CORE_VERSION = '0.0.0';

export interface CoreOptions {
  /** Đồng hồ thay thế được để test. */
  now?: () => Date;
}

/** Lõi NSA. Hiện mới có `ping` để chứng minh đường nối giao diện ↔ lõi. */
export class NsaCore {
  readonly version = CORE_VERSION;
  readonly #now: () => Date;

  constructor(options: CoreOptions = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  ping(message: string): PingResult {
    if (typeof message !== 'string') {
      throw new TypeError('ping: message phải là chuỗi');
    }
    return {
      reply: 'pong',
      echo: message,
      coreVersion: this.version,
      at: this.#now().toISOString(),
    };
  }
}
