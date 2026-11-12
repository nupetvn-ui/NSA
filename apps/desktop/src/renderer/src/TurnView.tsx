import type { Turn } from '@nsa/core';
import { Markdown } from './Markdown';

interface Props {
  turn: Turn;
  agentName: string;
  onCancel: () => void;
  onAnswer: (permissionId: string, allowed: boolean) => void;
}

export function TurnView({ turn, agentName, onCancel, onAnswer }: Props) {
  const running = turn.status === 'running';
  return (
    <section className="turn">
      <div className="user-msg">
        <div className="bubble">{turn.prompt}</div>
      </div>

      <div className="agent-msg">
        <header className="agent-head">
          <span className={`agent-badge agent-${turn.agentId}`}>{agentName}</span>
          {turn.handoff && (
            <span
              className="hint"
              title="Agent này nhận tóm tắt các lượt do agent khác làm trước đó"
            >
              đã nhận ngữ cảnh chuyển giao
            </span>
          )}
          {running && (
            <>
              <span className="dots" aria-label="đang trả lời">
                <i />
                <i />
                <i />
              </span>
              <button type="button" className="link-btn" onClick={onCancel}>
                Dừng
              </button>
            </>
          )}
          {turn.memory && turn.memory.length > 0 && (
            <span
              className="hint mem-used"
              title={[
                'Bộ nhớ NSA đã chèn vào đầu lượt:',
                ...turn.memory.map((m) => `• ${m.title}`),
              ].join(String.fromCharCode(10))}
            >
              dùng {turn.memory.length} mục nhớ
            </span>
          )}
          {turn.status === 'cancelled' && <span className="hint">đã dừng</span>}
        </header>

        {turn.parts.map((part) =>
          part.kind === 'text' ? (
            <Markdown key={part.id} text={part.text} />
          ) : part.kind === 'notice' ? (
            <div key={part.id} className="notice-box">
              {part.text}
            </div>
          ) : part.kind === 'permission' ? (
            <div key={part.id} className={`permission-box ${part.state}`}>
              <div className="permission-text">{part.description}</div>
              {part.state === 'pending' ? (
                <div className="permission-actions">
                  <button
                    type="button"
                    className="push-btn"
                    onClick={() => onAnswer(part.id, false)}
                  >
                    Từ chối
                  </button>
                  <button
                    type="button"
                    className="push-btn primary"
                    onClick={() => onAnswer(part.id, true)}
                  >
                    Cho phép
                  </button>
                </div>
              ) : (
                <span className="hint">
                  {part.state === 'allowed' ? 'đã cho phép' : 'đã từ chối'}
                </span>
              )}
            </div>
          ) : (
            <details key={part.id} className={`tool ${part.isError ? 'tool-error' : ''}`}>
              <summary>
                <span className="tool-name">{part.name}</span>
                <span className="tool-input">{part.input.split('\n')[0]}</span>
                {part.output === undefined && running && <span className="hint">đang chạy…</span>}
                {part.isError && <span className="hint err">lỗi</span>}
              </summary>
              {part.input.includes('\n') && <pre className="code">{part.input}</pre>}
              {part.output ? <pre className="code">{part.output}</pre> : null}
            </details>
          ),
        )}

        {turn.errors.map((error, i) => (
          <div key={i} className="error-box">
            {error}
          </div>
        ))}

        {!running &&
          turn.parts.length === 0 &&
          turn.errors.length === 0 &&
          turn.status === 'done' && <p className="hint">(agent không trả lời gì)</p>}

        {turn.usage && !running && (
          <footer className="usage">
            {formatTokens(turn.usage.inputTokens)} vào · {formatTokens(turn.usage.outputTokens)} ra
            {turn.usage.costUsd !== undefined && ` · ~$${turn.usage.costUsd.toFixed(4)}`}
          </footer>
        )}
      </div>
    </section>
  );
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k token` : `${n} token`;
}
