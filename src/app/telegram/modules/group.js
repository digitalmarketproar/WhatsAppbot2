const GroupSettings = require('../../../models/GroupSettings');
const { adminOnly } = require('../util');

module.exports = function registerGroupCommands(ctx) {
  ctx.bot.on('text', adminOnly(ctx, async (msg) => {
    const parts = (msg.text || '').trim().split(/\s+/);
    const cmd = (parts.shift() || '').toLowerCase();

    if (cmd === '/g_enable' || cmd === '/g_disable') {
      const groupJid = parts[0];
      if (!groupJid || !/@g\.us$/.test(groupJid)) return ctx.bot.sendMessage(ctx.adminId, 'استخدم: /g_enable 1203...@g.us أو /g_disable 1203...@g.us');
      const enabled = cmd === '/g_enable';
      await GroupSettings.findOneAndUpdate({ groupId: groupJid }, { groupId: groupJid, enabled }, { upsert: true, new: true });
      return ctx.bot.sendMessage(ctx.adminId, `تم ${enabled ? 'التفعيل' : 'التعطيل'}: ${groupJid}`);
    }

    if (cmd === '/g_media') {
      const mode = (parts[0] || '').toLowerCase();
      const groupJid = parts[1];
      if (!['on','off'].includes(mode) || !groupJid || !/@g\.us$/.test(groupJid)) {
        return ctx.bot.sendMessage(ctx.adminId, 'استخدم: /g_media on|off 1203...@g.us');
      }
      await GroupSettings.findOneAndUpdate({ groupId: groupJid }, { groupId: groupJid, blockMedia: mode === 'on' }, { upsert: true, new: true });
      return ctx.bot.sendMessage(ctx.adminId, `حظر الوسائط: ${mode} لـ ${groupJid}`);
    }

    if (cmd === '/g_links') {
      const mode = (parts[0] || '').toLowerCase();
      const groupJid = parts[1];
      if (!['on','off'].includes(mode) || !groupJid || !/@g\.us$/.test(groupJid)) {
        return ctx.bot.sendMessage(ctx.adminId, 'استخدم: /g_links on|off 1203...@g.us');
      }
      await GroupSettings.findOneAndUpdate({ groupId: groupJid }, { groupId: groupJid, blockLinks: mode === 'on' }, { upsert: true, new: true });
      return ctx.bot.sendMessage(ctx.adminId, `حظر الروابط: ${mode} لـ ${groupJid}`);
    }
  }));
};
