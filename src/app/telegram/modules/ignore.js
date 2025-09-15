const IgnoreChat = require('../../../models/IgnoreChat');
const { normalizeToJid, adminOnly } = require('../util');

module.exports = function registerIgnoreCommands(ctx) {
  ctx.bot.on('text', adminOnly(ctx, async (msg) => {
    const parts = (msg.text || '').trim().split(/\s+/);
    const cmd = (parts.shift() || '').toLowerCase();

    if (cmd === '/ignore') {
      const jid = normalizeToJid(parts.join(' ').trim());
      if (!jid) return ctx.bot.sendMessage(ctx.adminId, 'استخدم: /ignore 9677XXXXXXXX');
      const bare = jid.replace(/@.+$/, '');
      await IgnoreChat.findOneAndUpdate(
        { $or: [{ chatId: jid }, { chatId: bare }, { bare: bare }] },
        { chatId: jid, bare, addedBy: 'admin' },
        { upsert: true, new: true }
      );
      return ctx.bot.sendMessage(ctx.adminId, `🚫 تم التجاهل: ${jid}`);
    }

    if (cmd === '/allow' || cmd === '/unignore') {
      const jid = normalizeToJid(parts.join(' ').trim());
      if (!jid) return ctx.bot.sendMessage(ctx.adminId, 'استخدم: /allow 9677XXXXXXXX');
      const bare = jid.replace(/@.+$/, '');
      const res = await IgnoreChat.deleteMany({ $or: [{ chatId: jid }, { chatId: bare }, { bare: bare }] });
      return ctx.bot.sendMessage(ctx.adminId, `✅ تمت الإزالة من التجاهل: ${jid} (حُذف ${res.deletedCount})`);
    }

    if (cmd === '/ignores') {
      const list = await IgnoreChat.find({}).sort({ createdAt: -1 }).lean();
      const lines = list.map((x, i) => `${i + 1}. ${x.chatId}${x.bare ? ` (bare:${x.bare})` : ''}`).join('\n') || '— (قائمة فارغة)';
      return ctx.bot.sendMessage(ctx.adminId, `قائمة التجاهل:\n${lines}`, { disable_web_page_preview: true });
    }
  }));
};
