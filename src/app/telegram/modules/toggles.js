const GroupSettings = require('../../../models/GroupSettings');
const { adminOnly } = require('../util');

module.exports = function registerToggleCommands(ctx) {
  ctx.bot.on('text', adminOnly(ctx, async (msg) => {
    const parts = (msg.text || '').trim().split(/\s+/);
    const cmd = (parts.shift() || '').toLowerCase();

    if (cmd === '/g_welcome') {
      const mode = (parts[0] || '').toLowerCase();
      const groupJid = parts[1];
      if (!['on','off'].includes(mode) || !groupJid || !/@g\.us$/.test(groupJid)) {
        return ctx.bot.sendMessage(ctx.adminId, 'استخدم: /g_welcome on|off 1203...@g.us');
      }
      await GroupSettings.findOneAndUpdate({ groupId: groupJid }, { groupId: groupJid, welcomeEnabled: mode === 'on' }, { upsert: true, new: true });
      return ctx.bot.sendMessage(ctx.adminId, `welcomeEnabled: ${mode} لـ ${groupJid}`);
    }

    if (cmd === '/g_farewell') {
      const mode = (parts[0] || '').toLowerCase();
      const groupJid = parts[1];
      if (!['on','off'].includes(mode) || !groupJid || !/@g\.us$/.test(groupJid)) {
        return ctx.bot.sendMessage(ctx.adminId, 'استخدم: /g_farewell on|off 1203...@g.us');
      }
      await GroupSettings.findOneAndUpdate({ groupId: groupJid }, { groupId: groupJid, farewellEnabled: mode === 'on' }, { upsert: true, new: true });
      return ctx.bot.sendMessage(ctx.adminId, `farewellEnabled: ${mode} لـ ${groupJid}`);
    }
  }));
};
