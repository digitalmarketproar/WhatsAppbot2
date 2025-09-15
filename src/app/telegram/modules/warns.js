const UserWarning = require('../../../models/UserWarning');
const { normalizeToJid, adminOnly } = require('../util');

module.exports = function registerWarnsCommands(ctx) {
  ctx.bot.on('text', adminOnly(ctx, async (msg) => {
    const parts = (msg.text || '').trim().split(/\s+/);
    const cmd = (parts.shift() || '').toLowerCase();

    if (cmd === '/g_warns_get') {
      const groupJid = parts[0];
      const userArg  = parts[1];
      if (!groupJid || !userArg) return ctx.bot.sendMessage(ctx.adminId, 'استخدم: /g_warns_get 1203...@g.us 9677XXXXXXXX');
      const userJid = normalizeToJid(userArg);
      const doc = await UserWarning.findOne({ groupId: groupJid, userId: userJid }).lean();
      return ctx.bot.sendMessage(ctx.adminId, `تحذيرات ${userJid} في ${groupJid}: ${doc?.count || 0}`);
    }

    if (cmd === '/g_warns_reset') {
      const groupJid = parts[0];
      const userArg  = parts[1];
      if (!groupJid || !userArg) return ctx.bot.sendMessage(ctx.adminId, 'استخدم: /g_warns_reset 1203...@g.us 9677XXXXXXXX');
      const userJid = normalizeToJid(userArg);
      const res = await UserWarning.deleteOne({ groupId: groupJid, userId: userJid });
      return ctx.bot.sendMessage(ctx.adminId, `تم تصفير التحذيرات (${res.deletedCount}) لـ ${userJid} في ${groupJid}.`);
    }
  }));
};
