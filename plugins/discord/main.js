// Plugin Discord — bot chính thức, đọc kênh chữ bằng REST (không cần WebSocket Gateway). ADR-0011.
// Token chỉ ở header Authorization qua `{{secret:bot_token}}`; plugin không đọc được giá trị.
import { createChannelPlugin } from './kit.js';

const DEFAULT_BASE = 'https://discord.com/api/v10';
let base = DEFAULT_BASE;
let pauseUntil = 0;

const headers = (extra) => ({
  authorization: 'Bot {{secret:bot_token}}',
  'user-agent': 'DiscordBot (https://github.com/nupetvn-ui/NSA, 1.0)',
  ...extra,
});

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: headers(body ? { 'content-type': 'application/json' } : {}),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 429) {
    let wait = 5;
    try {
      wait = Number((await res.json()).retry_after) || 5;
    } catch {
      /* giữ mặc định */
    }
    pauseUntil = Date.now() + wait * 1000;
    throw new Error(`Discord giới hạn tốc độ, thử lại sau ${Math.ceil(wait)} giây.`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 200);
    try {
      msg = JSON.parse(text).message || msg;
    } catch {
      /* không phải JSON */
    }
    throw new Error(`Discord ${res.status}: ${msg}`);
  }
  return text ? JSON.parse(text) : null;
}

const adapter = {
  async me() {
    const me = await api('/users/@me');
    return { id: String(me.id), name: me.global_name || me.username };
  },

  // Liệt kê kênh chữ của mọi máy chủ bot đã vào (5 phút một lần).
  async discover() {
    const groups = [];
    for (const guild of await api('/users/@me/guilds')) {
      const channels = await api(`/guilds/${guild.id}/channels`);
      for (const c of channels) {
        if (c.type !== 0 && c.type !== 5) continue;
        groups.push({
          id: String(c.id),
          name: `${guild.name} #${c.name}`,
          kind: 'group',
          meta: { guildId: String(guild.id) },
        });
        if (groups.length >= 100) return groups;
      }
    }
    return groups;
  },

  async poll(_ctx, state) {
    if (Date.now() < pauseUntil) return { messages: [] };
    const cursor = { ...(state.cursor || {}) };
    const messages = [];
    for (const g of Object.values(state.groups)) {
      if (g.mode === 'off') continue;
      const after = cursor[g.id];
      const items = await api(
        `/channels/${g.id}/messages?limit=${after ? 50 : 1}${after ? `&after=${after}` : ''}`,
      );
      if (!items.length) continue;
      cursor[g.id] = items[0].id; // Discord trả mới nhất trước
      if (!after) continue; // lần đầu: chỉ đặt mốc, không đọc lại lịch sử
      for (const m of items.reverse()) {
        if (m.author?.bot || !m.content) continue; // cần "Message Content Intent" mới có nội dung
        messages.push({
          id: String(m.id),
          chatId: g.id,
          chatName: g.name,
          chatKind: 'group',
          fromId: String(m.author.id),
          fromName: m.member?.nick || m.author.global_name || m.author.username,
          text: m.content,
          at: m.timestamp,
          mentionsBot:
            (m.mentions || []).some((u) => String(u.id) === String(state.me?.id)) ||
            String(m.referenced_message?.author?.id) === String(state.me?.id),
        });
      }
    }
    return { messages, cursor };
  },

  async send(_ctx, group, text, opts) {
    await api(`/channels/${group.id}/messages`, {
      method: 'POST',
      body: {
        content: text,
        allowed_mentions: { parse: [] },
        ...(opts?.replyTo && /^\d+$/.test(opts.replyTo)
          ? { message_reference: { message_id: opts.replyTo, fail_if_not_exists: false } }
          : {}),
      },
    });
  },

  async deleteMessage(_ctx, group, messageId) {
    await api(`/channels/${group.id}/messages/${encodeURIComponent(messageId)}`, {
      method: 'DELETE',
    });
  },

  async removeMember(_ctx, group, userId) {
    const guild = group.meta?.guildId;
    if (!guild) throw new Error('Không biết máy chủ của kênh này.');
    await api(`/guilds/${guild}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' });
  },
};

const plugin = createChannelPlugin({
  platform: 'discord',
  label: 'Discord',
  maxSend: 1900,
  secrets: ['bot_token'],
  setup: [
    'Vào discord.com/developers/applications → New Application → Bot → Reset Token → sao chép token.',
    'Cùng trang Bot: bật "Message Content Intent" (nếu không bot không đọc được nội dung tin).',
    'OAuth2 → URL Generator: chọn scope "bot", quyền Read Messages, Send Messages (và Manage Messages / Kick Members nếu muốn dùng) → mở link để mời bot vào máy chủ.',
    'Vào App Store → Quản lý → Discord → mục "Bí mật" → dán token.',
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
