// src/app/telegram/modules/whitelist.js
const GroupSettings = require('../../../models/GroupSettings');
const { adminOnly } = require('../util');

function cleanBare(num) {
  return String(num || '').replace(/\D/g, '');
}

module.exports = function registerWhitelistCommands(ctx) {
  ctx.bot.on('text', adminOnly(ctx, async (msg) => {
    const text = (msg.text || '').trim();
    const parts = text.split(/\s+/);
    const cmd = (parts.shift() || '').toLowerCase();

    async function getOrCreate(groupJid) {
      return await GroupSettings.findOneAndUpdate(
        { groupId: groupJid },
        { $setOnInsert: { groupId: groupJid } },
        { upsert: true, new: true }
      );
    }

    if (cmd === '/g_wl_add') {
      const groupJid = parts[0];
      const number   = cleanBare(parts[1]);
      if (!groupJid || !/@g\.us$/.test(groupJid) || !number) {
        return ctx.bot.sendMessage(ctx.adminId, 'استخدم: /g_wl_add 1203...@g.us 9677XXXXXXXX');
      }
      await getOrCreate(groupJid);
      await GroupSettings.updateOne(
        { groupId: groupJid },
        { $addToSet: { whitelistNumbers: number } }
      );
      return ctx.bot.sendMessage(ctx.adminId, `✅ أُضيف ${number} إلى whitelist لـ ${groupJid}`);
    }

    if (cmd === '/g_wl_del') {
      const groupJid = parts[0];
      const number   = cleanBare(parts[1]);
      if (!groupJid || !/@g\.us$/.test(groupJid) || !number) {
        return ctx.bot.sendMessage(ctx.adminId, 'استخدم: /g_wl_del 1203...@g.us 9677XXXXXXXX');
      }
      await GroupSettings.updateOne(
        { groupId: groupJid },
        { $pull: { whitelistNumbers: number } }
      );
      return ctx.bot.sendMessage(ctx.adminId, `🗑️ أُزيل ${number} من whitelist لـ ${groupJid}`);
    }

    if (cmd === '/g_wl_list') {
      const groupJid = parts[0];
      if (!groupJid || !/@g\.us$/.test(groupJid)) {
        return ctx.bot.sendMessage(ctx.adminId, 'استخدم: /g_wl_list 1203...@g.us');
      }
      const doc = await GroupSettings.findOne({ groupId: groupJid }).lean();
      const list = (doc?.whitelistNumbers || []);
      if (!list.length) return ctx.bot.sendMessage(ctx.adminId, `قائمة whitelist فارغة لـ ${groupJid}`);
      return ctx.bot.sendMessage(ctx.adminId, `Whitelist لـ ${groupJid}:\n- ${list.join('\n- ')}`);
    }
  }));
};
