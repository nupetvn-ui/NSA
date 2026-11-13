import type { AgentInfo, CapabilityFlag, CliChange } from '@nsa/core';
import { VendorLogo, vendorOfAgent } from './VendorLogo';

interface Props {
  agents: AgentInfo[] | null;
  checking: boolean;
  onCheck: () => void;
  changes: CliChange[];
  onDismissChanges: () => void;
}

const CAPS: [CapabilityFlag, string][] = [
  ['editFiles', 'sửa file'],
  ['resume', 'tiếp phiên'],
  ['streaming', 'trả lời dần'],
  ['images', 'ảnh'],
  ['mcp', 'MCP'],
  ['subagents', 'agent con'],
  ['toolGate', 'chặn từng lệnh'],
];

const TIER: Record<string, string> = {
  protocol: 'giao thức',
  headless: 'JSON',
  pty: 'PTY',
};

/** Danh sách agent trên máy: đã cài chưa, phiên bản, trạng thái, năng lực. */
export function AgentsPanel({ agents, checking, onCheck, changes, onDismissChanges }: Props) {
  return (
    <div className="agents-panel">
      {changes.length > 0 && (
        <div className="update-banner cli-changes">
          <div className="update-title">CLI vừa thay đổi</div>
          {changes.map((c) => (
            <details key={c.agentId}>
              <summary className="hint">
                {c.name}:{' '}
                {c.kind === 'version'
                  ? `${c.before ?? '?'} → ${c.after ?? '?'}`
                  : c.kind === 'help'
                    ? 'đổi --help'
                    : c.kind === 'appeared'
                      ? 'vừa cài'
                      : 'không còn chạy'}
              </summary>
              {c.helpDiff.length > 0 && <pre className="code small">{c.helpDiff.join('\n')}</pre>}
            </details>
          ))}
          <div className="hint">NSA vẫn chạy; nếu agent hỏng sẽ tự lùi tầng hoặc đổi agent.</div>
          <button type="button" className="link-btn" onClick={onDismissChanges}>
            Đã hiểu
          </button>
        </div>
      )}

      <div className="agents-head">
        <span className="section-label flat">Agent trên máy</span>
        <button type="button" className="link-btn" onClick={onCheck} disabled={checking}>
          {checking ? 'Đang kiểm…' : 'Kiểm lại'}
        </button>
      </div>
      {!agents && <p className="hint">Đang dò tìm CLI…</p>}
      {agents?.map((a) => (
        <details key={a.id} className="agent-row">
          <summary>
            <span className={`status ${a.ready ? 'ok' : a.installed ? 'warn' : 'off'}`} />
            <VendorLogo vendor={vendorOfAgent(a.id)} name={a.name} />
            <span className={`agent-row-name ${a.installed ? '' : 'muted'}`}>{a.name}</span>
            <span className="hint">{a.installed ? (a.version ?? '') : 'chưa cài'}</span>
          </summary>
          <div className="agent-detail">
            {a.installed && (
              <div className="caps">
                <span className="cap tier">{TIER[a.capabilities.tier] ?? a.capabilities.tier}</span>
                {a.hasFallback && <span className="cap tier">+ PTY dự phòng</span>}
                {CAPS.filter(([flag]) => a.capabilities[flag]).map(([flag, label]) => (
                  <span key={flag} className="cap">
                    {label}
                  </span>
                ))}
              </div>
            )}
            {a.note && <div className="agent-note">{a.note}</div>}
          </div>
        </details>
      ))}
    </div>
  );
}
