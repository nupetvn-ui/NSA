// Plugin Lark Suite — ứng dụng tự xây (Custom App) chính thức của Lark Open Platform. ADR-0011.
// CHƯA CHẠY THẬT: viết theo tài liệu chính thức (open.larksuite.com), chưa thử với một ứng dụng Lark thật.
// App Secret và tenant_access_token chỉ đi qua `{{secret:...}}`, plugin không đọc được giá trị:
// lõi NSA lưu tenant_access_token từ phản hồi vào kho khoá (header x-nsa-capture) và thay vào lúc gọi.
import { createChannelPlugin } from './kit.js';

const DEFAULT_BASE = 'https://open.larksuite.com';
let base = DEFAULT_BASE;
let appId = '';

/** Mã lỗi "tenant_access_token thiếu / sai / hết hạn" của Lark. */
const TOKEN_ERRORS = new Set([99991661, 99991663, 99991668, 99991677]);

/** Lấy tenant_access_token mới (hiệu lực ≤ 2 giờ): giá trị đi thẳng vào kho khoá, plugin chỉ thấy dấu che. */
async function refresh() {
  if (!appId) throw new Error('Chưa nhập App ID của ứng dụng Lark (tab Cài đặt).');
  const res = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-nsa-capture': 'tenant_token=tenant_access_token',
    },
    body: `{"app_id":${JSON.stringify(appId)},"app_secret":"{{secret:app_secret}}"}`,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json.code !== undefined && json.code !== 0)) {
    throw new Error(
      `Lấy token Lark thất bại: ${json.msg || res.status} (mã ${json.code ?? res.status})`,
    );
  }
}

/** Gọi Open API; chưa có token hoặc token hết hạn thì lấy mới (một lần) rồi gọi lại. */
async function call(ctx, path, { method = 'GET', body, raw = false } = {}, retry = true) {
  if (!(await ctx.secrets.has('tenant_token'))) await refresh();
  const res = await fetch(`${base}/open-apis${path}`, {
    method,
    headers: {
      authorization: 'Bearer {{secret:tenant_token}}',
      ...(body ? { 'content-type': 'application/json; charset=utf-8' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (TOKEN_ERRORS.has(Number(json.code)) && retry) {
    await refresh();
    return call(ctx, path, { method, body, raw }, false);
  }
  if (!res.ok || (json.code !== undefined && json.code !== 0)) {
    throw new Error(`Lark lỗi ${json.code ?? res.status}: ${json.msg || ''}`);
  }
  return raw ? json : (json.data ?? {});
}

const q = (params) => new URLSearchParams(params).toString();

/** Nội dung tin text của Lark là chuỗi JSON `{"text":"…"}`; thay @_user_1 bằng tên người được nhắc. */
function textOf(m) {
  if (m.msg_type !== 'text') return '';
  let text;
  try {
    text = String(JSON.parse(m.body?.content ?? '{}').text ?? '');
  } catch {
    return '';
  }
  for (const mention of m.mentions ?? []) text = text.replaceAll(mention.key, `@${mention.name}`);
  return text;
}

const adapter = {
  async me(ctx) {
    await call(ctx, '/im/v1/chats?page_size=1'); // kiểm App Secret + quyền; lỗi thì báo ra màn hình
    try {
      const r = await call(ctx, '/bot/v3/info', { raw: true });
      if (r.bot?.open_id) return { id: String(r.bot.open_id), name: r.bot.app_name || 'Lark bot' };
    } catch {
      /* chưa lấy được thông tin bot: dùng App ID */
    }
    return { id: appId || 'lark-bot', name: 'Lark bot' };
  },

  // Danh sách nhóm bot đang ở trong đó (5 phút một lần).
  async discover(ctx) {
    const groups = [];
    let page = '';
    for (let i = 0; i < 4; i++) {
      const data = await call(
        ctx,
        `/im/v1/chats?${q({ page_size: '50', ...(page ? { page_token: page } : {}) })}`,
      );
      for (const c of data.items ?? []) {
        groups.push({ id: String(c.chat_id), name: c.name || String(c.chat_id), kind: 'group' });
      }
      if (!data.has_more || !data.page_token) break;
      page = data.page_token;
    }
    return groups;
  },

  // Đọc lịch sử từng nhóm đang bật. Cần quyền "Lấy tin nhắn lịch sử" và, với tin của cả nhóm,
  // quyền "Lấy tất cả tin nhắn trong nhóm" (nếu thiếu quyền này chỉ thấy tin nhắc tên bot).
  async poll(ctx, state) {
    const cursor = { ...(state.cursor || {}) };
    const messages = [];
    const nowSec = Math.floor(Date.now() / 1000);
    for (const g of Object.values(state.groups)) {
      if (g.mode === 'off') continue;
      if (cursor[g.id] === undefined) {
        cursor[g.id] = Date.now(); // lần đầu: chỉ đặt mốc, không đọc lại lịch sử
        continue;
      }
      const data = await call(
        ctx,
        `/im/v1/messages?${q({
          container_id_type: 'chat',
          container_id: g.id,
          start_time: String(Math.floor(cursor[g.id] / 1000)),
          end_time: String(nowSec + 1),
          sort_type: 'ByCreateTimeAsc',
          page_size: '50',
        })}`,
      );
      for (const m of data.items ?? []) {
        const at = Number(m.create_time);
        if (!(at > cursor[g.id])) continue; // start_time tính theo giây: bỏ tin đã đọc
        cursor[g.id] = Math.max(cursor[g.id], at);
        if (m.deleted || m.sender?.sender_type !== 'user') continue;
        const text = textOf(m);
        if (!text) continue;
        messages.push({
          id: String(m.message_id),
          chatId: g.id,
          chatName: g.name,
          chatKind: 'group',
          fromId: String(m.sender.id),
          fromName: String(m.sender.id).slice(-8),
          text,
          at: new Date(at).toISOString(),
          mentionsBot: (m.mentions ?? []).some(
            (x) => String(x.id) === String(state.me?.id) || x.name === state.me?.name,
          ),
        });
      }
    }
    return { messages, cursor };
  },

  async send(ctx, group, text, opts) {
    const content = JSON.stringify({ text });
    if (opts?.replyTo && /^om_/.test(opts.replyTo)) {
      await call(ctx, `/im/v1/messages/${encodeURIComponent(opts.replyTo)}/reply`, {
        method: 'POST',
        body: { msg_type: 'text', content },
      });
      return;
    }
    await call(ctx, '/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST',
      body: { receive_id: group.id, msg_type: 'text', content },
    });
  },

  async deleteMessage(ctx, _group, messageId) {
    await call(ctx, `/im/v1/messages/${encodeURIComponent(messageId)}`, { method: 'DELETE' });
  },

  async removeMember(ctx, group, userId) {
    await call(ctx, `/im/v1/chats/${encodeURIComponent(group.id)}/members?member_id_type=open_id`, {
      method: 'DELETE',
      body: { id_list: [userId] },
    });
  },
};

const plugin = createChannelPlugin({
  platform: 'lark',
  icon: 'icon.png',
  label: 'Lark Suite',
  maxSend: 3500,
  secrets: ['app_secret'],
  config: [
    {
      id: 'app_id',
      label: 'App ID của ứng dụng Lark',
      help: 'Lấy ở open.larksuite.com → Developer Console → ứng dụng của bạn → Credentials. Không phải bí mật.',
      placeholder: 'cli_xxxxxxxxxxxxxxxx',
    },
  ],
  setup: [
    'Vào open.larksuite.com → Developer Console → Create Custom App → bật "Bot" (Add features).',
    'Permissions & Scopes: bật gửi tin (im:message), đọc lịch sử (im:message.history:readonly) và, nếu muốn bot thấy mọi tin trong nhóm, "Lấy tất cả tin nhắn trong nhóm" (im:message.group_msg). Phát hành (Create version) cho ứng dụng.',
    'Thêm bot vào nhóm chat. Vào App Store → Quản lý → Lark Suite → mục "Bí mật" → dán App Secret. Rồi nhập App ID ở tab Cài đặt của màn hình này.',
    'Plugin CHƯA chạy thử với ứng dụng Lark thật: hãy thử ở chế độ "Canh" trước. Chỉ dùng Lark quốc tế (open.larksuite.com), chưa hỗ trợ Feishu (open.feishu.cn).',
  ],
  warning:
    'Plugin Lark Suite dùng API chính thức nhưng CHƯA được thử với ứng dụng Lark thật. Bot đọc tin nhóm bằng cách hỏi lịch sử theo lịch (không dùng webhook / WebSocket), nên chậm hơn bot dùng sự kiện.',
  adapter,
});

export default {
  ...plugin,
  async activate(ctx) {
    plugin.activate(ctx);
    base = ((await ctx.config.get('apiBase', DEFAULT_BASE)) || DEFAULT_BASE).replace(/\/+$/, '');
    appId = (await ctx.config.get('cfg_app_id', '')) || '';
  },
  ui: {
    ...plugin.ui,
    saveConfig: async (p, ctx) => {
      const r = await plugin.ui.saveConfig(p, ctx);
      if (p.id === 'app_id') appId = String(p.value ?? '').trim();
      return r;
    },
  },
};
