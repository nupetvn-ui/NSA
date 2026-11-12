import { describe, expect, it } from 'vitest';
import { localIdentity, personalPolicy, type PolicyAction } from './sockets.js';

const actor = localIdentity('tester').current();
const action = (cwd: string, permission: 'read-only' | 'edit'): PolicyAction => ({
  kind: 'agent.run',
  agentId: 'codex',
  cwd,
  permission,
  prompt: 'x',
});

describe('personalPolicy (bản Cá nhân)', () => {
  const policy = personalPolicy({ homeDir: 'C:\\Users\\tester' });

  it('chỉ đọc thì cho phép luôn', () => {
    const verdict = policy.check({
      actor,
      action: action('D:/proj', 'read-only'),
      confirmed: false,
    });
    expect(verdict).toEqual({ decision: 'allow' });
  });

  it('sửa file thì hỏi; đã xác nhận thì cho phép', () => {
    const edit = action('D:/proj', 'edit');
    expect(policy.check({ actor, action: edit, confirmed: false })).toMatchObject({
      decision: 'ask',
    });
    expect(policy.check({ actor, action: edit, confirmed: true })).toEqual({ decision: 'allow' });
  });

  it('sửa file ở gốc ổ đĩa hoặc thư mục người dùng: cảnh báo mạnh hơn', () => {
    for (const cwd of ['D:\\', 'c:/users/tester/']) {
      const verdict = policy.check({ actor, action: action(cwd, 'edit'), confirmed: false });
      expect(verdict).toMatchObject({ decision: 'ask' });
      expect('reason' in verdict && verdict.reason).toContain('cả ổ đĩa');
    }
  });
});

describe('localIdentity', () => {
  it('bản Cá nhân: một người dùng, vai trò owner', () => {
    expect(actor).toEqual({
      id: 'local:tester',
      displayName: 'tester',
      roles: ['owner'],
      edition: 'personal',
    });
  });
});
