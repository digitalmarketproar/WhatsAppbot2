const GroupSettings = require('../../../models/GroupSettings');
const { adminOnly } = require('../util');

module.exports = function registerStatusCommands(ctx) {
  ctx.bot.on('text', adminOnly(ctx, async (msg) => {
    const parts = (msg.text || '').trim().split(/\s+/);
    const cmd = (parts.shift() || '').toLowerCase();

    if (cmd === '/g_status') {
      const groupJid = parts[0];
      if (!groupJid || !/@g\.us$/.test(groupJid)) return ctx.bot.sendMessage(ctx.adminId, 'استخدم: /g_status 1203...@g.us');
      const s = await GroupSettings.findOne({ groupId: groupJid }).lean();
      if (!s) return ctx.bot.sendMessage(ctx.adminId, `لا إعدادات لـ ${groupJid}.`);
      const info = [
        `groupId: ${s.groupId}`,
        `enabled: ${s.enabled}`,
        `welcome: ${s.welcomeEnabled} | farewell: ${s.farewellEnabled}`,
        `blockMedia: ${s.blockMedia} | blockLinks: ${s.blockLinks}`,
        `maxWarnings: ${s.maxWarnings}`,
        `bannedWords: ${(s.bannedWords || []).length}`,
        'rules:',
        (s.rules || '').slice(0, 400)
      ].join('\n');
      return ctx.bot.sendMessage(ctx.adminId, info, { disable_web_page_preview: true });
    }
  }));
};
