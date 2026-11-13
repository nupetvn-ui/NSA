import { useEffect, useRef, useState } from 'react';
import type { PluginInfo } from '@nsa/core';

/**
 * Màn hình của một plugin, hiện trong khung cô lập (ADR-0010):
 * - `sandbox="allow-scripts"` và KHÔNG có `allow-same-origin`: trang có origin rỗng, không chạm
 *   được vào renderer chính, localStorage của app, hay API Electron (preload không nạp vào khung);
 * - nội dung đến từ `nsa-plugin://<id>/…` kèm CSP chặt (không mạng, không form, không khung lồng);
 * - nói chuyện với plugin của nó qua `window.nsa.call / on` (postMessage). Giao diện chỉ chuyển
 *   tiếp lời gọi của ĐÚNG khung này tới ĐÚNG plugin này.
 */
export function PluginScreen({
  plugin,
  screenId,
  onBack,
}: {
  plugin: PluginInfo;
  screenId: string;
  onBack: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState<string | null>(null);
  const screen =
    plugin.manifest.screens.find((s) => s.id === screenId) ?? plugin.manifest.screens[0];

  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      const target = frame.current?.contentWindow;
      if (!target || e.source !== target) return; // chỉ nghe đúng khung này
      const m = e.data as {
        __nsa?: number;
        type?: string;
        id?: number;
        method?: unknown;
        params?: unknown;
      };
      if (!m || m.__nsa !== 1 || m.type !== 'call' || typeof m.id !== 'number') return;
      const reply = (body: Record<string, unknown>): void =>
        target.postMessage({ __nsa: 1, type: 'result', id: m.id, ...body }, '*');
      if (typeof m.method !== 'string') return reply({ ok: false, error: 'Tên hàm không hợp lệ' });
      window.nsa.invoke('plugins:ui', plugin.id, m.method, m.params).then(
        (value) => reply({ ok: true, value }),
        (err: unknown) =>
          reply({
            ok: false,
            error: String(err).replace(
              /^Error: Error invoking remote method '[^']+': (Error: )?/,
              '',
            ),
          }),
      );
    };
    window.addEventListener('message', onMessage);
    const off = window.nsa.on('plugins:uiEvent', (ev) => {
      if (ev.pluginId !== plugin.id) return;
      frame.current?.contentWindow?.postMessage(
        { __nsa: 1, type: 'event', event: ev.event, data: ev.data },
        '*',
      );
    });
    return () => {
      window.removeEventListener('message', onMessage);
      off();
    };
  }, [plugin.id]);

  return (
    <main className="chat plugin-screen">
      <header className="chat-head drag">
        <h1 className="chat-title">{screen?.title ?? plugin.name}</h1>
        <button type="button" className="push-btn no-drag" onClick={onBack}>
          ‹ App Store
        </button>
      </header>
      {error && <div className="error-box plugin-error">{error}</div>}
      {screen && plugin.enabled ? (
        <iframe
          ref={frame}
          className="plugin-frame"
          title={plugin.name}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          src={`nsa-plugin://${plugin.id}/${screen.entry}`}
          onError={() => setError('Không tải được màn hình của plugin.')}
        />
      ) : (
        <p className="hint pad">Plugin này đang tắt hoặc không có màn hình.</p>
      )}
    </main>
  );
}
