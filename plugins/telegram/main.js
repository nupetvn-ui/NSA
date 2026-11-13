// Plugin Telegram — bot chính thức (Bot API). ADR-0011.
// Token KHÔNG bao giờ vào đây: `{{secret:bot_token}}` được lõi NSA thay lúc gọi mạng.
import { createChannelPlugin } from './kit.js';

const DEFAULT_BASE = 'https://api.telegram.org';
let base = DEFAULT_BASE;

async function api(method, params, { post = false } = {}) {
  const url = `${base}/bot{{secret:bot_token}}/${method}`;
  const res = post
    ? await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params ?? {}),
      })
    : await fetch(params ? `${url}?${new URLSearchParams(params)}` : url);
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(`Telegram trả về HTTP ${res.status} không phải JSON.`);
  }
  if (!json.ok) throw new Error(`Telegram: ${json.description || res.status}`);
  return json.result;
}

let myUsername = '';

const adapter = {
  async me() {
    const me = await api('getMe');
    myUsername = me.username || '';
    return { id: String(me.id), name: me.first_name || me.username, username: me.username };
  },

  async poll(_ctx, state) {
    const params = { limit: '100', timeout: '0', allowed_updates: JSON.stringify(['message']) };
    if (state.cursor) params.offset = String(state.cursor);
    const updates = await api('getUpdates', params);
    const messages = [];
    let cursor = state.cursor;
    for (const u of updates) {
      cursor = u.update_id + 1;
      const m = u.message;
      const text = m && (m.text || m.caption);
      if (!m || !text || !m.from || m.from.is_bot) continue;
      const priv = m.chat.type === 'private';
      const mention =
        priv ||
        (myUsername && text.toLowerCase().includes('@' + myUsername.toLowerCase())) ||
        (m.reply_to_message?.from?.username &&
          m.reply_to_message.from.username.toLowerCase() === myUsername.toLowerCase());
      messages.push({
        id: String(m.message_id),
        chatId: String(m.chat.id),
        chatName: m.chat.title || m.chat.username || m.chat.first_name || String(m.chat.id),
        chatKind: priv ? 'private' : 'group',
        fromId: String(m.from.id),
        fromName: m.from.first_name || m.from.username || String(m.from.id),
        text,
        at: new Date(m.date * 1000).toISOString(),
        mentionsBot: !!mention,
      });
    }
    return { messages, cursor };
  },

  async send(_ctx, group, text, opts) {
    const body = { chat_id: Number(group.id), text };
    if (opts?.replyTo && /^\d+$/.test(opts.replyTo)) {
      body.reply_parameters = {
        message_id: Number(opts.replyTo),
        allow_sending_without_reply: true,
      };
    }
    await api('sendMessage', body, { post: true });
  },

  async deleteMessage(_ctx, group, messageId) {
    await api(
      'deleteMessage',
      { chat_id: Number(group.id), message_id: Number(messageId) },
      { post: true },
    );
  },

  // "Mời ra khỏi nhóm" = cấm rồi gỡ cấm (người đó vào lại được bằng link mời).
  async removeMember(_ctx, group, userId) {
    await api(
      'banChatMember',
      { chat_id: Number(group.id), user_id: Number(userId) },
      { post: true },
    );
    await api(
      'unbanChatMember',
      { chat_id: Number(group.id), user_id: Number(userId), only_if_is_banned: true },
      { post: true },
    );
  },
};

const plugin = createChannelPlugin({
  platform: 'telegram',
  label: 'Telegram',
  maxSend: 3500,
  secrets: ['bot_token'],
  setup: [
    'Trên Telegram mở @BotFather → gõ /newbot → đặt tên → sao chép token (dạng 123456:ABC…).',
    'Vào App Store → Quản lý → Telegram → mục "Bí mật" → dán token. NSA cất trong kho khoá của hệ điều hành.',
    'Muốn bot đọc được mọi tin trong nhóm: @BotFather → /setprivacy → chọn bot → Disable. Rồi thêm bot vào nhóm.',
    'Nếu bot từng đặt webhook ở nơi khác thì getUpdates sẽ báo xung đột — gỡ webhook trước.',
  ],
  adapter,
});

export default {
  ...plugin,
  async activate(ctx) {
    plugin.activate(ctx);
    base = (await ctx.config.get('apiBase', DEFAULT_BASE)) || DEFAULT_BASE;
  },
};
