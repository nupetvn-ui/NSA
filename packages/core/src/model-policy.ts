/**
 * Ghép ổ cắm chính sách cho model qua API key (ADR-0009):
 * - lượt chat với agent dùng hãng (adapter `api` hoặc CLI được cấp key) hỏi thêm `model.use`;
 * - nhiều chính sách ghép lại thì lấy quyết định chặt nhất (deny > ask > allow).
 */
import type { Policy, PolicyDecision, PolicyRequest } from './sockets.js';

export interface ModelLookup {
  (agentId: string): { providerId: string; model: string; paid: boolean } | undefined;
}

const RANK: Record<PolicyDecision['decision'], number> = { allow: 0, ask: 1, deny: 2 };

function stricter(a: PolicyDecision, b: PolicyDecision): PolicyDecision {
  return RANK[b.decision] > RANK[a.decision] ? b : a;
}

/** Ghép nhiều chính sách: hỏi lần lượt, `deny` dừng ngay, còn lại lấy kết quả chặt nhất. */
export function composePolicies(...policies: Policy[]): Policy {
  return {
    async check(request) {
      let result: PolicyDecision = { decision: 'allow' };
      for (const policy of policies) {
        const verdict = await policy.check(request);
        result = stricter(result, verdict);
        if (result.decision === 'deny') break;
      }
      return result;
    },
  };
}

/**
 * Bọc chính sách: khi agent của lượt chạy dùng một hãng qua API key, hỏi thêm `model.use`
 * (loại việc `main`) để chính sách có thể chặn theo hãng.
 */
export function withModelPolicy(base: Policy, lookup: ModelLookup): Policy {
  return {
    async check(request: PolicyRequest) {
      const first = await base.check(request);
      if (first.decision === 'deny' || request.action.kind !== 'agent.run') return first;
      const info = lookup(request.action.agentId);
      if (!info) return first;
      const second = await base.check({
        ...request,
        action: {
          kind: 'model.use',
          agentId: request.action.agentId,
          providerId: info.providerId,
          model: info.model,
          task: 'main',
          paid: info.paid,
        },
      });
      return stricter(first, second);
    },
  };
}
