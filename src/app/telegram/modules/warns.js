// src/app/telegram/modules/warns.js
// متين ضد الاختلافات: يقبل إما TelegramBot مباشرة أو كائن فيه { bot, sendMessage, notify }.
// يسجّل مستمع "text" إن وُجدت .on أو .onText، ويستخدم sendMessage المتاح.

const UserWarning = require('../../../models/UserWarning');
const logger = require('../../../lib/logger');

// تطبيع إلى @s.whatsapp.net
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

module.exports = function registerWarnsCommands(tgMaybe, adminId) {
  // 🔧 استخرج الـ TelegramBot الحقيقي وموحّد الإرسال
  const tgbot =
    (tgMaybe && tgMaybe.bot) ? tgMaybe.bot :
    tgMaybe;

  const send = async (chatId, text, opts = {}) => {
    // إن وُجد sendMessage على الغلاف استعمله، وإلا جرّب على tgbot
    if (tgMaybe && typeof tgMaybe.sendMessage === 'function') {
      return tgMaybe.sendMessage(chatId, text, opts);
    }
    if (tgbot && typeof tgbot.sendMessage === 'function') {
      return tgbot.sendMessage(chatId, text, opts);
    }
    throw new Error('No sendMessage available for Telegram');
  };

  // 🧭 مبدّل لاستقبال النصوص بغض النظر عن الـ API المتوفر
  const registerTextHandler = (handler) => {
    if (tgbot && typeof tgbot.on === 'function') {
      // الأسلوب الشائع: node-telegram-bot-api
      return tgbot.on('text', handler);
    }
    if (tgbot && typeof tgbot.onText === 'function') {
      // بعض المشاريع تعتمد onText مباشرة بنمط RegExp؛ نلتقط الكل ونمرّر msg
      return tgbot.onText(/[\s\S]*/, (msg) => handler(msg));
    }
    // لو الغلاف يوفّر addTextListener مثلاً
    if (tgMaybe && typeof tgMaybe.onText === 'function') {
      return tgMaybe.onText(/[\s\S]*/, (msg) => handler(msg));
    }
    throw new Error('No Telegram text-listener method (on / onText) found');
  };

  // 🧠 المساعدات
  const usageGet   = 'استخدم: `/g_warns_get 1203...@g.us 9677XXXXXXXX`';
  const usageReset = 'استخدم: `/g_warns_reset 1203...@g.us 9677XXXXXXXX`';

  // 📝 مسجّل الأوامر
  registerTextHandler(async (msg) => {
    try {
      if (!msg || !msg.text) return;
      if (String(msg.chat?.id) !== String(adminId)) return; // أوامر للمشرف فقط

      const text = String(msg.text).trim();
      if (!text.startsWith('/')) return; // ليس أمرًا

      const parts = text.split(/\s+/);
      const cmd   = (parts[0] || '').toLowerCase();

      // /g_warns_get 1203...@g.us 9677XXXXXXXX
      if (cmd === '/g_warns_get') {
        const groupJid = parts[1] || '';
        const userArg  = parts[2] || '';
        if (!groupJid || !/@g\.us$/.test(groupJid) || !userArg) {
          return send(adminId, usageGet, { parse_mode: 'Markdown' });
        }

        const jidS   = normalizeToJid(userArg);  // 9677...@s.whatsapp.net
        const bare   = bareNumberFrom(jidS);     // 9677...
        const jidLid = `${bare}@lid`;            // صيغة قديمة محتملة

        const docs = await UserWarning.find({
          groupId: groupJid,
          userId: { $in: [jidS, jidLid, bare] }
        }).lean();

        const total = (docs || []).reduce((acc, d) => acc + (d?.count || 0), 0);
        return send(
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
          return send(adminId, usageReset, { parse_mode: 'Markdown' });
        }

        const jidS   = normalizeToJid(userArg);  // 9677...@s.whatsapp.net
        const bare   = bareNumberFrom(jidS);     // 9677...
        const jidLid = `${bare}@lid`;            // صيغة قديمة محتملة

        const res = await UserWarning.deleteMany({
          groupId: groupJid,
          userId: { $in: [jidS, jidLid, bare] }
        });

        return send(
          adminId,
          `تم تصفير التحذيرات لـ \`${jidS}\` في ${groupJid} (حُذف ${res.deletedCount})`,
          { parse_mode: 'Markdown' }
        );
      }

      // تجاهُل بقية الأوامر: وحدات أخرى تتكفّل بها
    } catch (e) {
      logger.error({ e }, 'telegram warns module error');
      try { await send(adminId, '❌ خطأ أثناء معالجة أمر التحذيرات.'); } catch {}
    }
  });
};
