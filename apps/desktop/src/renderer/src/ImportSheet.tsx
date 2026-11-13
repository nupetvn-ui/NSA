import { useEffect, useState } from 'react';
import type { ImportCandidate, ImportSource, ImportSourceStatus } from '@nsa/core';

/**
 * Nhập lịch sử chat: chọn nguồn → xem trước các phiên → chọn → bấm nhập.
 * Không có gì được đọc hay ghi trước khi người dùng bấm "Nhập".
 */
export function ImportSheet({ onClose }: { onClose: () => void }) {
  const [sources, setSources] = useState<ImportSourceStatus[] | null>(null);
  const [source, setSource] = useState<ImportSource>('nsa');
  const [candidates, setCandidates] = useState<ImportCandidate[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.nsa.invoke('mem:importSources').then(setSources);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    void window.nsa.invoke('mem:importList', source).then(setCandidates);
  }, [source]);

  function chooseSource(next: ImportSource) {
    if (next === source) return;
    setCandidates(null);
    setChosen(new Set());
    setSource(next);
  }

  const status = sources?.find((s) => s.source === source);

  async function startImport() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const proposals = await window.nsa.invoke('mem:import', source, [...chosen]);
      const accepted = proposals.filter((p) => p.status === 'accepted').length;
      const pending = proposals.filter((p) => p.status === 'pending').length;
      setResult(
        `Xong: ${proposals.length} đề xuất — ${accepted} tự nhận, ${pending} chờ bạn duyệt, ${
          proposals.length - accepted - pending
        } bị bỏ (trùng).`,
      );
      setChosen(new Set());
    } catch (err) {
      setError(String(err).replace(/^Error: Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={busy ? undefined : onClose}>
      <div
        className="sheet import-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="import-title">Nhập lịch sử chat vào bộ nhớ</h2>
        <p className="hint">
          Chọn các phiên để một agent đọc và rút ra điều đáng nhớ. Kết quả vào hộp duyệt như mọi đề
          xuất khác.
        </p>
        <div className="segmented" role="radiogroup" aria-label="Nguồn">
          {(sources ?? []).map((s) => (
            <button
              key={s.source}
              type="button"
              role="radio"
              aria-checked={s.source === source}
              className={s.source === source ? 'on' : ''}
              onClick={() => chooseSource(s.source)}
              title={s.note}
            >
              <span className={`status ${s.available ? 'ok' : 'off'}`} />
              {s.name}
            </button>
          ))}
        </div>
        {status && !status.available && <div className="notice-box">{status.note}</div>}

        <div className="import-list">
          {candidates === null && <p className="hint pad">Đang đọc…</p>}
          {candidates?.length === 0 && status?.available && (
            <p className="hint pad">Không có phiên nào.</p>
          )}
          {candidates?.map((c) => (
            <div key={c.id} className="import-item">
              <label className="import-row">
                <input
                  type="checkbox"
                  checked={chosen.has(c.id)}
                  onChange={(e) =>
                    setChosen((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(c.id);
                      else next.delete(c.id);
                      return next;
                    })
                  }
                />
                <span className="import-title">{c.title}</span>
                <span className="hint">
                  {c.messages} tin · {new Date(c.updatedAt).toLocaleDateString('vi-VN')}
                </span>
                <button
                  type="button"
                  className="link-btn"
                  onClick={(e) => {
                    e.preventDefault();
                    setOpen(open === c.id ? null : c.id);
                  }}
                >
                  {open === c.id ? 'Ẩn' : 'Xem trước'}
                </button>
              </label>
              {open === c.id && (
                <div className="import-preview">
                  {c.cwd && <div className="hint">{c.cwd}</div>}
                  {c.preview.map((m, i) => (
                    <div key={i}>
                      <strong>{m.role === 'user' ? 'Bạn' : 'Agent'}:</strong> {m.text}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        {result && <div className="notice-box ok">{result}</div>}
        {error && <div className="error-box">{error}</div>}
        <div className="editor-actions">
          <button type="button" className="push-btn" onClick={onClose} disabled={busy}>
            Đóng
          </button>
          <button
            type="button"
            className="push-btn primary"
            disabled={chosen.size === 0 || busy}
            onClick={() => void startImport()}
          >
            {busy ? 'Đang nhập…' : `Nhập ${chosen.size || ''} phiên đã chọn`}
          </button>
        </div>
      </div>
    </div>
  );
}
