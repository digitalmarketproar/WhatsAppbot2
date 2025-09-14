// src/app/telegram/modules/warns.js
const GroupSettings = require('../../../models/GroupSettings');
const UserWarning   = require('../../../models/UserWarning');
const logger        = require('../../../lib/logger');

// طبع الرقم/JID إلى s.whatsapp.net
function normalizeToJid(input) {
  if (!input) return '';
  let s = String(input).trim();
  if (/@s\.whatsapp\.net$/.test(s) || /@g\.us$/.test(s)) return s;
  s = s.replace(/[^\d\-]/g, '');
  if (/^\d{6,20}$/.test(s)) return `${s}@s.whatsapp.net`;
  return '';
}
function bareNumberFrom(anyJidOrNumber) {
  const s = String(anyJidOrNumber).trim();
  return (s.includes('@') ? s.split('@')[0] : s).split(':')[0].replace(/[^\d]/g,'');
}

module.exports = function registerWarnsCommands(bot, adminId) {
  // /g_warns_get 1203...@g.us 9677XXXXXXXX
  bot.onText(/^\/g_warns_get\b/i, async (msg) => {
    if (String(msg.chat.id) !== String(adminId)) return;
    try {
      const [, ...rest] = (msg.text || '').trim().split(/\s+/);
      const groupJid = rest[0];
      const userArg  = rest[1];
      if (!groupJid || !/@g\.us$/.test(groupJid) || !userArg) {
        return bot.sendMessage(adminId, 'استخدم: `/g_warns_get 1203...@g.us 9677XXXXXXXX`', { parse_mode: 'Markdown' });
      }
      const userJid = normalizeToJid(userArg);
      const doc = await UserWarning.findOne({ groupId: groupJid, userId: userJid }).lean();
      return bot.sendMessage(adminId, `تحذيرات ${userJid} في ${groupJid}: ${doc?.count || 0}`);
    } catch (e) {
      logger.error({ e }, 'warns_get failed');
      bot.sendMessage(adminId, '❌ خطأ أثناء جلب التحذيرات.');
    }
  });

  // /g_warns_reset 1203...@g.us 9677XXXXXXXX
  bot.onText(/^\/g_warns_reset\b/i, async (msg) => {
    if (String(msg.chat.id) !== String(adminId)) return;
    try {
      const [, ...rest] = (msg.text || '').trim().split(/\s+/);
      const groupJid = rest[0];
      const userArg  = rest[1];
      if (!groupJid || !/@g\.us$/.test(groupJid) || !userArg) {
        return bot.sendMessage(adminId, 'استخدم: `/g_warns_reset 1203...@g.us 9677XXXXXXXX`', { parse_mode: 'Markdown' });
      }
      const jidS   = normalizeToJid(userArg);                  // 9677...@s.whatsapp.net
      const bare   = bareNumberFrom(jidS);                     // 9677...
      const jidLid = `${bare}@lid`;                            // احتمال وثائق قديمة

      const res = await UserWarning.deleteMany({
        groupId: groupJid,
        userId: { $in: [jidS, jidLid] }
      });

      // تنظيف احترازي لأي وثائق شاذة على نفس الرقم (نادرًا)
      await UserWarning.deleteMany({ groupId: groupJid, userId: bare }).catch(()=>{});

      return bot.sendMessage(adminId, `تم تصفير التحذيرات لـ \`${jidS}\` في ${groupJid} (حُذف ${res.deletedCount})`, { parse_mode: 'Markdown' });
    } catch (e) {
      logger.error({ e }, 'warns_reset failed');
      bot.sendMessage(adminId, '❌ خطأ أثناء تصفير التحذيرات.');
    }
  });
};
