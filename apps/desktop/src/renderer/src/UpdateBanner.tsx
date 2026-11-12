import { useEffect, useState } from 'react';
import type { UpdateStatus } from '@nsa/core';

/** Báo bản cập nhật ở thanh bên: đang tải, hoặc đã tải xong và chờ khởi động lại. */
export function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' });

  useEffect(() => {
    void window.nsa.invoke('app:updateStatus').then(setStatus);
    return window.nsa.on('app:update', setStatus);
  }, []);

  if (status.state === 'downloading') {
    return (
      <div className="update-banner">
        <div className="update-title">Đang tải bản {status.version}…</div>
        <div className="progress">
          <div style={{ width: `${status.percent}%` }} />
        </div>
      </div>
    );
  }

  if (status.state === 'downloaded') {
    return (
      <div className="update-banner ready">
        <div className="update-title">Đã có bản {status.version}</div>
        <div className="hint">Khởi động lại để cập nhật.</div>
        <button
          type="button"
          className="push-btn primary"
          onClick={() => void window.nsa.invoke('app:installUpdate')}
        >
          Khởi động lại
        </button>
      </div>
    );
  }

  return null;
}
