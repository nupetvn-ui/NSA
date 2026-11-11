import { useEffect, useState } from 'react';
import type { AppInfo, PingResult } from '@nsa/core';
import logo from '../../../resources/icon.png';

type PingState =
  | { status: 'waiting' }
  | { status: 'ok'; result: PingResult; ms: number }
  | { status: 'error'; message: string };

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [ping, setPing] = useState<PingState>({ status: 'waiting' });

  useEffect(() => {
    void window.nsa.invoke('app:info').then(setInfo);
    const started = performance.now();
    window.nsa
      .invoke('core:ping', 'renderer')
      .then((result) => setPing({ status: 'ok', result, ms: performance.now() - started }))
      .catch((err: unknown) => setPing({ status: 'error', message: String(err) }));
  }, []);

  return (
    <main className="shell">
      <img className="logo" src={logo} alt="" width={112} height={112} />
      <h1>NSA</h1>
      <p className="muted" data-testid="version">
        {info ? `Phiên bản ${info.version}` : '…'}
      </p>
      <p className="muted" data-testid="ping">
        {ping.status === 'waiting' && 'Đang gọi lõi…'}
        {ping.status === 'ok' &&
          `Lõi trả lời: ${ping.result.reply} (lõi ${ping.result.coreVersion}, ${ping.ms.toFixed(1)} ms)`}
        {ping.status === 'error' && `Không gọi được lõi: ${ping.message}`}
      </p>
    </main>
  );
}
