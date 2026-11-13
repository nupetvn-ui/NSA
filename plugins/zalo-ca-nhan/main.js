// Plugin Zalo CÁ NHÂN — KHÔNG CHÍNH THỨC, chỉ có ở bản Cá nhân. ADR-0011.
//
// Zalo không có API chính thức cho tài khoản cá nhân. Plugin này KHÔNG chứa mã đăng nhập hay giao
// thức Zalo: nó nói chuyện với một "cầu nối" chạy trên máy bạn (http://localhost:<cổng>) theo hợp
// đồng ghi ở BRIDGE.md. NSA không đi kèm cầu nối nào. Chưa có cầu nối thật nào được kiểm, nên
// plugin này CHƯA CHẠY THẬT với Zalo — chỉ chạy được với cầu nối giả trong test.
import { createChannelPlugin } from './kit.js';

let bridge = 'http://localhost:3910';

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(bridge + path, {
    method,
    headers: {
      authorization: 'Bearer {{secret:bridge_token}}',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(`Cầu nối Zalo: ${json.error || res.status}`);
  return json;
}

const adapter = {
  async me() {
    const r = await call('/me');
    return { id: String(r.id), name: r.name || String(r.id) };
  },
  async poll(_ctx, state) {
    const r = await call(`/messages?after=${encodeURIComponent(state.cursor ?? '')}`);
    return {
      messages: (r.messages || []).map((m) => ({
        id: String(m.id),
        chatId: String(m.chatId),
        chatName: m.chatName || String(m.chatId),
        chatKind: m.chatKind === 'private' ? 'private' : 'group',
        fromId: String(m.fromId),
        fromName: m.fromName || String(m.fromId),
        text: String(m.text ?? ''),
        at: m.at,
        mentionsBot: m.mentionsMe === true,
      })),
      cursor: r.cursor ?? state.cursor,
    };
  },
  async send(_ctx, group, text) {
    await call('/send', { method: 'POST', body: { chatId: group.id, text } });
  },
  async deleteMessage(_ctx, group, messageId) {
    await call('/delete', { method: 'POST', body: { chatId: group.id, messageId } });
  },
  async removeMember(_ctx, group, userId) {
    await call('/remove-member', { method: 'POST', body: { chatId: group.id, userId } });
  },
  async changeOwner(_ctx, group, userId) {
    await call('/change-owner', { method: 'POST', body: { chatId: group.id, userId } });
  },
};

const plugin = createChannelPlugin({
  platform: 'zalo-ca-nhan',
  label: 'Zalo cá nhân',
  maxSend: 1900,
  secrets: ['bridge_token'],
  config: [
    {
      id: 'bridge_url',
      label: 'Địa chỉ cầu nối trên máy bạn',
      help: 'Chỉ nhận localhost (ví dụ http://localhost:3910).',
      placeholder: 'http://localhost:3910',
    },
  ],
  warning:
    'Zalo cá nhân KHÔNG có API chính thức. Dùng bot trên tài khoản cá nhân vi phạm điều khoản sử dụng của Zalo và có thể khiến nick bị khoá hoặc cấm vĩnh viễn — NSA không chịu trách nhiệm. Đừng dùng nick chính hay nick quan trọng. Plugin này CHƯA được thử với Zalo thật (chưa có cầu nối đã kiểm). Doanh nghiệp nên dùng plugin "Zalo OA" (chính thức).',
  setup: [
    'Plugin cần một "cầu nối" chạy trên máy bạn nói chuyện với Zalo — NSA không đi kèm cầu nối nào (xem BRIDGE.md trong thư mục plugin).',
    'Chạy cầu nối, đặt một mã bí mật cho nó, rồi nhập địa chỉ ở tab Cài đặt.',
    'Vào App Store → Quản lý → Zalo cá nhân → mục "Bí mật" → dán mã bí mật của cầu nối.',
  ],
  adapter,
});

export default {
  ...plugin,
  async activate(ctx) {
    plugin.activate(ctx);
    const url = String((await ctx.config.get('cfg_bridge_url', '')) || 'http://localhost:3910');
    bridge = url.replace(/\/+$/, '');
  },
  ui: {
    ...plugin.ui,
    saveConfig: async (p, ctx) => {
      const r = await plugin.ui.saveConfig(p, ctx);
      if (p.id === 'bridge_url')
        bridge = String(p.value || 'http://localhost:3910').replace(/\/+$/, '');
      return r;
    },
  },
};
