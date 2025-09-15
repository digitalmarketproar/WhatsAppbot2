// src/app/telegram/modules/warns.js
// إصلاح: استخدام bot.on('text') بدلاً من onText + توحيد صيغ JID عند get/reset

const UserWarning = require('../../../models/UserWarning');
const logger = require('../../../lib/logger');

// s.whatsapp تطبيع بسيط
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
  return (s.includes('@') ? s.split('@')[0] : s)
    .split(':')[0]
    .replace(/[^\d]/g, '');
}

module.exports = function registerWarnsCommands(bot, adminId) {
  // أسلوب موحّد: التقط كل النصوص وفسّر الأوامر يدويًا
  bot.on('text', async (msg) => {
    try {
      if (String(msg.chat.id) !== String(adminId)) return; // أوامر للمشرف فقط

      const text = (msg.text || '').trim();
      if (!text.startsWith('/')) return; // ليس أمرًا

      const parts = text.split(/\s+/);
      const cmd   = (parts[0] || '').toLowerCase();

      // /g_warns_get 1203...@g.us 9677XXXXXXXX
      if (cmd === '/g_warns_get') {
        const groupJid = parts[1] || '';
        const userArg  = parts[2] || '';
        if (!groupJid || !/@g\.us$/.test(groupJid) || !userArg) {
          return bot.sendMessage(
            adminId,
            'استخدم: `/g_warns_get 1203...@g.us 9677XXXXXXXX`',
            { parse_mode: 'Markdown' }
          );
        }

        const jidS   = normalizeToJid(userArg);       // 9677...@s.whatsapp.net
        const bare   = bareNumberFrom(jidS);          // 9677...
        const jidLid = `${bare}@lid`;                 // احتمال وجود وثائق قديمة بهذه الصيغة

        // قد تكون هناك وثائق متعددة بصيغ مختلفة لنفس العضو — اجمعها
        const docs = await UserWarning.find({
          groupId: groupJid,
          userId: { $in: [jidS, jidLid, bare] }
        }).lean();

        const total = (docs || []).reduce((acc, d) => acc + (d?.count || 0), 0);
        return bot.sendMessage(
          adminId,
          `تحذيرات \`${jidS}\` في ${groupJid}: ${total}`,
          { parse_mode: 'Markdown' }
        );
      }

      // /g_warns_reset 1203...@g.us 9677XXXXXXXX
      if (cmd === '/g_warns_reset') {
        const groupJid = parts[1] || '';
        const userArg  = parts[2] || '';
        if (!groupJid || !/@g\.us$/.test(groupJid) || !userArg) {
          return bot.sendMessage(
            adminId,
            'استخدم: `/g_warns_reset 1203...@g.us 9677XXXXXXXX`',
            { parse_mode: 'Markdown' }
          );
        }

        const jidS   = normalizeToJid(userArg);   // 9677...@s.whatsapp.net
        const bare   = bareNumberFrom(jidS);      // 9677...
        const jidLid = `${bare}@lid`;             // صيغة قديمة محتملة

        const res = await UserWarning.deleteMany({
          groupId: groupJid,
          userId: { $in: [jidS, jidLid, bare] }
        });

        return bot.sendMessage(
          adminId,
          `تم تصفير التحذيرات لـ \`${jidS}\` في ${groupJid} (حُذف ${res.deletedCount})`,
          { parse_mode: 'Markdown' }
        );
      }

      // تجاهل بقية الأوامر هنا؛ تُدار في وحدات أخرى
    } catch (e) {
      logger.error({ e }, 'telegram warns module error');
      try { await bot.sendMessage(adminId, '❌ خطأ أثناء معالجة أمر التحذيرات.'); } catch {}
    }
  });
};
