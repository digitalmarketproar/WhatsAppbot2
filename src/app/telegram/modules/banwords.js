const GroupSettings = require('../../../models/GroupSettings');
const { adminOnly } = require('../util');

module.exports = function registerBanwordCommands(ctx) {
  ctx.bot.on('text', adminOnly(ctx, async (msg) => {
    const parts = (msg.text || '').trim().split(/\s+/);
    const cmd = (parts.shift() || '').toLowerCase();

    if (cmd === '/g_banword_add') {
      const groupJid = parts.shift();
      const word = (parts.join(' ') || '').trim();
      if (!groupJid || !/@g\.us$/.test(groupJid) || !word) return ctx.bot.sendMessage(ctx.adminId, 'استخدم: /g_banword_add 1203...@g.us كلمة');
      const s = await GroupSettings.findOneAndUpdate({ groupId: groupJid }, { groupId: groupJid }, { upsert: true, new: true });
      s.bannedWords = Array.from(new Set([...(s.bannedWords || []), word]));
      await s.save();
      return ctx.bot.sendMessage(ctx.adminId, `أُضيفت كلمة محظورة لـ ${groupJid}.`);
    }

    if (cmd === '/g_banword_remove') {
      const groupJid = parts.shift();
      const word = (parts.join(' ') || '').trim();
      if (!groupJid || !/@g\.us$/.test(groupJid) || !word) return ctx.bot.sendMessage(ctx.adminId, 'استخدم: /g_banword_remove 1203...@g.us كلمة');
      const s = await GroupSettings.findOne({ groupId: groupJid });
      if (!s) return ctx.bot.sendMessage(ctx.adminId, 'لا توجد إعدادات لهذا القروب.');
      s.bannedWords = (s.bannedWords || []).filter(w => w !== word);
      await s.save();
      return ctx.bot.sendMessage(ctx.adminId, `أُزيلت الكلمة من ${groupJid}.`);
    }

    if (cmd === '/g_banword_list') {
      const groupJid = parts[0];
      if (!groupJid || !/@g\.us$/.test(groupJid)) return ctx.bot.sendMessage(ctx.adminId, 'استخدم: /g_banword_list 1203...@g.us');
      const s = await GroupSettings.findOne({ groupId: groupJid }).lean();
      const list = (s?.bannedWords || []).map((w,i)=>`${i+1}. ${w}`).join('\n') || '— (فارغة)';
      return ctx.bot.sendMessage(ctx.adminId, `قائمة الكلمات المحظورة لـ ${groupJid}:\n${list}`, { disable_web_page_preview: true });
    }
  }));
};
