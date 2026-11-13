/**
 * Một tiến trình plugin. Chạy `node --permission …` (hoặc `NSA.exe` ở chế độ `ELECTRON_RUN_AS_NODE`):
 *
 * - **Hệ thống file**: mô hình quyền của Node chỉ cho đọc thư mục cài của chính plugin, đọc /
 *   ghi thư mục dữ liệu của nó và các thư mục người dùng đã cấp. Không đọc được kho khoá,
 *   cấu hình app, dữ liệu plugin khác. Cũng cấm sinh tiến trình con, luồng worker và addon native.
 * - **Mạng**: Node 24 chưa có quyền mạng, nên `runner` chặn bằng mã (xem `runner-source.ts`) và
 *   cho `fetch` đi qua tiến trình chủ. Đây là lớp chặn ở tầng ứng dụng, không phải ở hệ điều hành.
 * - **Môi trường**: tiến trình con KHÔNG thừa kế biến môi trường của app (không có khoá, token…).
 * - **Treo / sập**: mỗi lời gọi có hạn; hết hạn thì giết tiến trình; sập thì báo cho `PluginHost`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname } from 'node:path';

export interface ProcessSpec {
  pluginId: string;
  version: string;
  /** Tệp `main` đã ghép đường dẫn tuyệt đối. */
  entry: string;
  installDir: string;
  dataDir: string;
  /** Đường dẫn runner.mjs đã ghi ra đĩa. */
  runnerPath: string;
  /** Thư mục người dùng đã cấp: đường dẫn + quyền ghi. */
  folders: { path: string; write: boolean }[];
  grants: { folders: Record<string, string>; memory: boolean; model: boolean; cli: string[] };
  execPath: string;
  /** Chạy bằng Electron (cần `ELECTRON_RUN_AS_NODE=1`). */
  electron: boolean;
  /** Trần bộ nhớ vùng heap, MB. */
  maxMemoryMb: number;
  startTimeoutMs: number;
}

export interface ProcessHandlers {
  /** Plugin hỏi tiến trình chủ (fetch, bộ nhớ, cấu hình, thông báo…). */
  request(method: string, params: unknown): Promise<unknown>;
  log(level: string, message: string): void;
  emit(event: string, data: unknown): void;
  /** Tiến trình kết thúc không do `stop()` gọi. */
  exited(reason: string): void;
}

export interface ReadyInfo {
  tools: string[];
  jobs: string[];
  ui: string[];
}

interface Waiter {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class PluginProcess {
  readonly #spec: ProcessSpec;
  readonly #handlers: ProcessHandlers;
  #child: ChildProcess | null = null;
  readonly #waiters = new Map<string, Waiter>();
  #seq = 0;
  #stopping = false;
  #recentOutput: string[] = [];

  constructor(spec: ProcessSpec, handlers: ProcessHandlers) {
    this.#spec = spec;
    this.#handlers = handlers;
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  get alive(): boolean {
    return this.#child !== null && this.#child.exitCode === null && !this.#child.killed;
  }

  /** Những dòng cuối plugin in ra (stdout / stderr) — để báo lỗi dễ hiểu. */
  get output(): string {
    return this.#recentOutput.join('\n');
  }

  async start(): Promise<ReadyInfo> {
    const spec = this.#spec;
    const args = [
      '--permission',
      `--allow-fs-read=${spec.installDir}`,
      `--allow-fs-read=${dirname(spec.runnerPath)}`,
      `--allow-fs-read=${spec.dataDir}`,
      `--allow-fs-write=${spec.dataDir}`,
      ...spec.folders.map((f) => `--allow-fs-read=${f.path}`),
      ...spec.folders.filter((f) => f.write).map((f) => `--allow-fs-write=${f.path}`),
      `--max-old-space-size=${spec.maxMemoryMb}`,
      spec.runnerPath,
    ];
    for (const path of [spec.installDir, spec.dataDir, ...spec.folders.map((f) => f.path)]) {
      if (path.includes(','))
        throw new Error(`Đường dẫn có dấu phẩy, không cấp quyền được: ${path}`);
    }
    // Môi trường tối thiểu: không thừa kế gì từ app (khoá, token, đường dẫn dữ liệu…).
    const env: NodeJS.ProcessEnv = { NSA_PLUGIN_ENTRY: spec.entry };
    if (spec.electron) env['ELECTRON_RUN_AS_NODE'] = '1';
    for (const key of ['SystemRoot', 'windir']) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
    const child = spawn(spec.execPath, args, {
      cwd: spec.dataDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    this.#child = child;
    const onOutput = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.#recentOutput.push(line.slice(0, 500));
        if (this.#recentOutput.length > 30) this.#recentOutput.shift();
        this.#handlers.log('info', line.slice(0, 500));
      }
    };
    child.stdout?.on('data', onOutput);
    child.stderr?.on('data', onOutput);
    child.on('message', (message) => void this.#onMessage(message as Record<string, unknown>));
    child.on('error', (err) => this.#onExit(`không chạy được: ${err.message}`));
    child.on('exit', (code, signal) =>
      this.#onExit(signal ? `bị dừng (${signal})` : `thoát với mã ${String(code)}`),
    );

    try {
      return (await this.#send(
        'init',
        {
          pluginId: spec.pluginId,
          version: spec.version,
          dataDir: spec.dataDir,
          grants: spec.grants,
        },
        spec.startTimeoutMs,
      )) as ReadyInfo;
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  /** Gọi tool / việc nền / hàm màn hình trong plugin. Hết hạn → ném lỗi và giết tiến trình (coi như treo). */
  async call(
    kind: 'tool' | 'job' | 'ui',
    payload: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    try {
      return await this.#send(`call.${kind}`, payload, timeoutMs);
    } catch (err) {
      if (err instanceof PluginTimeoutError) this.kill();
      throw err;
    }
  }

  ping(timeoutMs: number): Promise<unknown> {
    return this.#send('ping', {}, timeoutMs);
  }

  /** Dừng êm (cho `deactivate` ~3 giây) rồi giết nếu chưa thoát. */
  async stop(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    this.#stopping = true;
    if (child.exitCode === null && child.connected) {
      await this.#send('shutdown', {}, 3500).catch(() => undefined);
    }
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => {
        this.kill();
        setTimeout(resolve, 200);
      }, 1500);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.#failAll(new Error('Plugin đã dừng'));
    this.#child = null;
  }

  /** Giết ngay (plugin treo). Tiến trình chủ coi như sập và xử lý theo vòng đời. */
  kill(): void {
    try {
      this.#child?.kill('SIGKILL');
    } catch {
      /* đã thoát */
    }
  }

  #send(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const child = this.#child;
    if (!child || !child.connected) return Promise.reject(new Error('Plugin không chạy'));
    return new Promise((resolve, reject) => {
      const id = `h${++this.#seq}`;
      const timer = setTimeout(() => {
        this.#waiters.delete(id);
        reject(
          new PluginTimeoutError(`Plugin không trả lời sau ${Math.round(timeoutMs / 1000)} giây`),
        );
      }, timeoutMs);
      this.#waiters.set(id, { resolve, reject, timer });
      child.send({ t: 'req', id, method, params }, (err) => {
        if (!err) return;
        clearTimeout(timer);
        this.#waiters.delete(id);
        reject(new Error(`Không gửi được lệnh cho plugin: ${err.message}`));
      });
    });
  }

  async #onMessage(message: Record<string, unknown>): Promise<void> {
    const child = this.#child;
    switch (message['t']) {
      case 'res': {
        const waiter = this.#waiters.get(String(message['id']));
        if (!waiter) return;
        clearTimeout(waiter.timer);
        this.#waiters.delete(String(message['id']));
        if (message['ok']) waiter.resolve(message['value']);
        else waiter.reject(new Error(String(message['error'])));
        return;
      }
      case 'req': {
        const id = message['id'];
        let answer: Record<string, unknown>;
        try {
          const value = await this.#handlers.request(String(message['method']), message['params']);
          answer = { t: 'res', id, ok: true, value: value === undefined ? null : value };
        } catch (err) {
          answer = {
            t: 'res',
            id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
        if (child?.connected) child.send(answer);
        return;
      }
      case 'log':
        this.#handlers.log(String(message['level'] ?? 'info'), String(message['message'] ?? ''));
        return;
      case 'emit':
        this.#handlers.emit(String(message['event'] ?? ''), message['data']);
        return;
      default:
    }
  }

  #onExit(reason: string): void {
    this.#failAll(new Error(`Plugin ${reason}`));
    if (this.#stopping) return;
    const output = this.output;
    this.#handlers.exited(output ? `${reason}\n${output}` : reason);
  }

  #failAll(error: Error): void {
    for (const [id, waiter] of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
      this.#waiters.delete(id);
    }
  }
}

export class PluginTimeoutError extends Error {}
