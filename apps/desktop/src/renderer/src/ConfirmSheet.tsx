import { useEffect, useRef } from 'react';
import logo from '../../../resources/icon.png';

interface Props {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Hộp xác nhận kiểu cảnh báo macOS: biểu tượng app, tiêu đề, nội dung, hai nút. */
export function ConfirmSheet({ title, message, confirmLabel, onConfirm, onCancel }: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="sheet-backdrop" onClick={onCancel}>
      <div
        className="alert"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="alert-title"
        onClick={(e) => e.stopPropagation()}
      >
        <img src={logo} alt="" width={56} height={56} />
        <h2 id="alert-title">{title}</h2>
        <p>{message}</p>
        <div className="alert-buttons">
          <button type="button" className="alert-btn" onClick={onCancel}>
            Huỷ
          </button>
          <button type="button" className="alert-btn primary" onClick={onConfirm} ref={confirmRef}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
