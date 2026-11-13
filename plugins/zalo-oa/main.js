// Plugin Zalo OA — Official Account CHÍNH THỨC của Zalo. ADR-0011.
// CHƯA CHẠY THẬT: viết theo tài liệu, chưa thử với một OA thật (xem docs/adr/0011). Endpoint làm mới
// token đã đối chiếu tài liệu; endpoint đọc / gửi tin cần kiểm lại với OA thật.
// Token (access_token, refresh_token, secret_key) chỉ đi qua `{{secret:...}}`, plugin không đọc được.
import { createChannelPlugin } from './kit.js';

const DEFAULT_API = 'https://openapi.zalo.me';
const DEFAULT_OAUTH = 'https://oauth.zaloapp.com';
let api0 = DEFAULT_API;
let oauth0 = DEFAULT_OAUTH;
let appId = '';

/** Làm mới access_token: giá trị mới đi thẳng vào kho khoá (header x-nsa-capture), plugin chỉ thấy dấu che. */
async function refresh() {
  if (!appId) throw new Error('Chưa nhập App ID của ứng dụng Zalo (tab Cài đặt).');
  const res = await fetch(`${oauth0}/v4/oa/access_token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      secret_key: '{{secret:secret_key}}',
      'x-nsa-capture': 'access_token=access_token,refresh_token=refresh_token',
    },
    body: `app_id=${encodeURIComponent(appId)}&grant_type=refresh_token&refresh_token={{secret:refresh_token}}`,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error)
    throw new Error(
      `Làm mới token Zalo thất bại: ${json.error_name || json.error_description || json.message || res.status}`,
    );
}

const EXPIRED = new Set([-216, -124, 216, 124]);

/** Gọi OpenAPI; token hết hạn thì làm mới một lần rồi gọi lại. */
async function call(path, { method = 'GET', body } = {}, retry = true) {
  const res = await fetch(api0 + path, {
    method,
    headers: {
      access_token: '{{secret:access_token}}',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (EXPIRED.has(Number(json.error)) && retry) {
    await refresh();
    return call(path, { method, body }, false);
  }
  if (!res.ok || (json.error !== undefined && Number(json.error) !== 0)) {
    throw new Error(`Zalo OA lỗi ${json.error ?? res.status}: ${json.message || ''}`);
  }
  return json;
}

const q = (obj) => encodeURIComponent(JSON.stringify(obj));

const adapter = {
  async me() {
    const r = await call('/v2.0/oa/getoa');
    return { id: String(r.data?.oa_id ?? 'oa'), name: r.data?.name || 'Zalo OA' };
  },

  // Mỗi khách nhắn tới OA là một hội thoại riêng (kind "private"). Webhook cần địa chỉ công khai
  // nên bản máy bàn đọc theo lịch bằng danh sách tin gần đây.
  async poll(_ctx, state) {
    const r = await call(`/v2.0/oa/listrecentchat?data=${q({ offset: 0, count: 20 })}`);
    const first = !state.cursor; // lần đầu: chỉ đặt mốc, không trả lời tin cũ
    const cursor = state.cursor || { time: 0, ids: [] };
    const seen = new Set(cursor.ids);
    const messages = [];
    let newest = cursor.time;
    const ids = [...cursor.ids];
    for (const m of (r.data || []).slice().sort((a, b) => a.time - b.time)) {
      newest = Math.max(newest, m.time);
      if (seen.has(m.message_id)) continue;
      ids.push(m.message_id);
      if (first || m.src !== 1 || m.type !== 'text' || !m.message) continue; // chỉ tin khách gửi tới
      messages.push({
        id: String(m.message_id),
        chatId: String(m.from_id),
        chatName: m.from_display_name || String(m.from_id),
        chatKind: 'private',
        fromId: String(m.from_id),
        fromName: m.from_display_name || String(m.from_id),
        text: m.message,
        at: new Date(m.time).toISOString(),
        mentionsBot: true,
      });
    }
    return { messages, cursor: { time: newest, ids: ids.slice(-100) } };
  },

  async send(_ctx, group, text) {
    await call('/v3.0/oa/message/cs', {
      method: 'POST',
      body: { recipient: { user_id: group.id }, message: { text } },
    });
  },
};

const plugin = createChannelPlugin({
  platform: 'zalo-oa',
  label: 'Zalo OA',
  maxSend: 1900,
  secrets: ['access_token', 'refresh_token', 'secret_key'],
  config: [
    {
      id: 'app_id',
      label: 'App ID của ứng dụng Zalo',
      help: 'Lấy ở developers.zalo.me → ứng dụng của bạn. Không phải bí mật.',
      placeholder: '1234567890123456789',
    },
  ],
  setup: [
    'Tạo ứng dụng ở developers.zalo.me, liên kết với Official Account của bạn và xin quyền "Gửi tin tư vấn".',
    'Lấy access_token, refresh_token (ở Công cụ → API Explorer / OAuth) và Khoá bí mật ứng dụng.',
    'Vào App Store → Quản lý → Zalo OA → mục "Bí mật" → dán cả ba. Rồi nhập App ID ở tab Cài đặt của màn hình này.',
    'Plugin CHƯA chạy thử với OA thật: hãy thử ở chế độ "Canh" trước.',
  ],
  warning:
    'Zalo OA là kênh chính thức nhưng plugin này CHƯA được thử với tài khoản OA thật. OA chỉ trả lời được khách đã nhắn trong 48 giờ gần nhất theo chính sách Zalo.',
  adapter,
});

export default {
  ...plugin,
  async activate(ctx) {
    plugin.activate(ctx);
    api0 = (await ctx.config.get('apiBase', DEFAULT_API)) || DEFAULT_API;
    oauth0 = (await ctx.config.get('oauthBase', DEFAULT_OAUTH)) || DEFAULT_OAUTH;
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
