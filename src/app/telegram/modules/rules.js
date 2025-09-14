const GroupSettings = require('../../../models/GroupSettings');
const { adminOnly } = require('../util');

module.exports = function registerRulesCommands(ctx) {
  ctx.bot.on('text', adminOnly(ctx, async (msg) => {
    const parts = (msg.text || '').trim().split(/\s+/);
    const cmd = (parts.shift() || '').toLowerCase();

    if (cmd === '/g_rules_set') {
      const groupJid = parts.shift();
      const rules = parts.join(' ').trim();
      if (!groupJid || !/@g\.us$/.test(groupJid) || !rules) return ctx.bot.sendMessage(ctx.adminId, 'استخدم: /g_rules_set 1203...@g.us نص القوانين...');
      await GroupSettings.findOneAndUpdate({ groupId: groupJid }, { groupId: groupJid, rules }, { upsert: true, new: true });
      return ctx.bot.sendMessage(ctx.adminId, `تم تحديث القوانين لـ ${groupJid}.`);
    }

    if (cmd === '/g_rules_get') {
      const groupJid = parts[0];
      if (!groupJid || !/@g\.us$/.test(groupJid)) return ctx.bot.sendMessage(ctx.adminId, 'استخدم: /g_rules_get 1203...@g.us');
      const s = await GroupSettings.findOne({ groupId: groupJid }).lean();
      return ctx.bot.sendMessage(ctx.adminId, s?.rules ? `قوانين ${groupJid}:\n${s.rules}` : `لا قوانين مضبوطة لـ ${groupJid}.`, { disable_web_page_preview: true });
    }
  }));
};
