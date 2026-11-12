import type { Capabilities, CapabilityFlag, DetectResult } from '@nsa/adapter-sdk';

/** Thông tin bộ định tuyến cần về một agent. */
export interface RouteCandidate {
  id: string;
  capabilities: Capabilities;
  /** Kết quả dò gần nhất; chưa dò thì coi như có thể dùng (lượt chạy sẽ tự báo nếu hỏng). */
  status?: DetectResult;
}

export interface RouteRequest {
  /** Agent người dùng chọn; bỏ trống hoặc 'auto' để NSA tự chọn. */
  preferred?: string;
  /** Năng lực việc này bắt buộc phải có. */
  needs?: CapabilityFlag[];
  /** Agent đã thử và hỏng trong lượt này. */
  exclude?: string[];
  /** Thứ tự ưu tiên khi tự chọn (agent đứng trước được ưu tiên). */
  order?: string[];
}

export interface RoutePlan {
  /** Agent theo thứ tự nên thử. */
  candidates: string[];
  /** Vì sao từng agent bị loại — để báo cho người dùng. */
  rejected: { id: string; reason: string }[];
}

/** Năng lực cần cho một lượt, suy ra từ quyền người dùng cấp. */
export function needsFor(permission: 'read-only' | 'edit'): CapabilityFlag[] {
  return permission === 'edit' ? ['tools', 'editFiles'] : [];
}

const LABELS: Record<CapabilityFlag, string> = {
  streaming: 'trả lời từng phần',
  resume: 'tiếp tục phiên',
  tools: 'chạy lệnh',
  editFiles: 'sửa file',
  images: 'nhận ảnh',
  mcp: 'MCP',
  subagents: 'agent con',
  toolGate: 'chặn từng lệnh',
};

export function capabilityLabel(flag: CapabilityFlag): string {
  return LABELS[flag];
}

/**
 * Chọn agent theo năng lực và lựa chọn của người dùng (nguyên tắc 7 của PLAN.md).
 * Thứ tự: agent người dùng chọn (nếu đủ năng lực) → agent đã sẵn sàng → agent đã cài
 * nhưng chưa xác nhận sẵn sàng. Agent chưa cài, thiếu năng lực hoặc đã hỏng thì bị loại.
 * Trong cùng nhóm: ưu tiên agent có cổng chặn từng lệnh, rồi theo `order`.
 */
export function planRoute(agents: RouteCandidate[], request: RouteRequest = {}): RoutePlan {
  const rejected: RoutePlan['rejected'] = [];
  const exclude = new Set(request.exclude ?? []);
  const needs = request.needs ?? [];
  const order = request.order ?? agents.map((a) => a.id);
  const preferred = request.preferred && request.preferred !== 'auto' ? request.preferred : null;

  const usable = agents.filter((agent) => {
    if (exclude.has(agent.id)) {
      rejected.push({ id: agent.id, reason: 'đã hỏng trong lượt này' });
      return false;
    }
    if (agent.status && !agent.status.installed) {
      rejected.push({ id: agent.id, reason: agent.status.note ?? 'chưa cài' });
      return false;
    }
    const missing = needs.filter((n) => !agent.capabilities[n]);
    if (missing.length) {
      rejected.push({
        id: agent.id,
        reason: `thiếu năng lực: ${missing.map(capabilityLabel).join(', ')}`,
      });
      return false;
    }
    return true;
  });

  const rank = (agent: RouteCandidate): number[] => [
    agent.id === preferred ? 0 : 1,
    agent.status === undefined || agent.status.ready ? 0 : 1,
    agent.capabilities.toolGate ? 0 : 1,
    order.indexOf(agent.id) === -1 ? order.length : order.indexOf(agent.id),
  ];
  const sorted = [...usable].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) {
      const d = (ra[i] as number) - (rb[i] as number);
      if (d !== 0) return d;
    }
    return 0;
  });
  return { candidates: sorted.map((a) => a.id), rejected };
}
