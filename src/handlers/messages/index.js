const path = require('path');
const { loadCommands } = require('../../lib/commandLoader');
const IgnoreChat = require('../../models/IgnoreChat');
const keywords = require('../../config/keywords.json');
const logger = require('../../lib/logger');

// تحميل الأوامر مرة واحدة
let registry = null;
function ensureRegistry() {
  if (!registry) registry = loadCommands(path.join(__dirname, '../../commands'));
  return registry;
}

// تطبيع بسيط للنص العربي (للمطابقة الحرفية المحسنة)
function normalizeArabic(input) {
  let s = String(input || '').trim();
  s = s.replace(/[\u064B-\u065F\u0610-\u061A\u06D6-\u06ED]/g, ''); // التشكيل
  s = s.replace(/\u0640/g, ''); // التطويل
  s = s.replace(/[إأآا]/g, 'ا'); // الألف
  s = s.replace(/[يى]/g, 'ي');   // الياء/المقصورة
  s = s.replace(/ة/g, 'ه');      // التاء المربوطة
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// إيجاد الأمر بدون بادئة: أول كلمة = اسم/مرادف
function resolveCommandName(firstToken, reg) {
  if (!firstToken) return '';
  const t = firstToken;
  const tl = String(firstToken).toLowerCase();

  if (reg.commands.has(t)) return t;
  if (reg.aliases.has(t)) return reg.aliases.get(t);

  for (const name of reg.commands.keys()) {
    if (String(name).toLowerCase() === tl) return name;
  }
  for (const [alias, name] of reg.aliases.entries()) {
    if (String(alias).toLowerCase() === tl && reg.commands.has(name)) return name;
  }
  return '';
}

function onMessageUpsert(sock) {
  return async ({ messages }) => {
    const reg = ensureRegistry();
    const selfBare = (sock.user?.id || '').split(':')[0]; // 9677...:xx → 9677...

    for (const m of (messages || [])) {
      try {
        const chatId = m.key?.remoteJid;
        if (!chatId) continue;

        // 0) تجاهل رسائل البوت نفسه وأي بث للحالة
        if (m.key?.fromMe) continue;
        if (chatId === 'status@broadcast') continue;

        // قد تأتي رسائل المجموعات مع participant؛ نقارن مع JID الخاص بنا
        const sender = m.key?.participant || m.participant || m.pushName || '';
        if (selfBare && String(sender).startsWith(selfBare)) continue;

        // 1) قائمة التجاهل (Mongo)
        const ignored = await IgnoreChat.findOne({ chatId }).lean().catch(() => null);
        if (ignored) continue;

        // 2) استخراج نص
        const rawText =
          (m.message?.conversation ||
           m.message?.extendedTextMessage?.text ||
           m.message?.imageMessage?.caption ||
           m.message?.videoMessage?.caption ||
           '').trim();
        if (!rawText) continue;

        const textNorm = normalizeArabic(rawText);
        const tokens = textNorm.split(' ');
        const firstToken = tokens[0] || '';
        let handled = false;

        // 3) تنفيذ أمر (بدون بادئة)
        const cmdName = resolveCommandName(firstToken, reg);
        if (cmdName) {
          const args = rawText.split(/\s+/).slice(1); // الأرجومنتس من النص الأصلي
          const run = reg.commands.get(cmdName);
          await run({ sock, msg: m, args });
          handled = true;
        }

        // 4) أمر "مساعدة" ككلمة كاملة (بدون بادئة)
        if (!handled && (textNorm === 'مساعده' || textNorm === 'help')) {
          const help = require('../../commands/help.js');
          await help.run({ sock, msg: m, args: [] });
          handled = true;
        }

        // 5) القاموس (تطابق كامل بعد التطبيع)
        if (!handled) {
          // ابنِ كاش مفاتيح مطبّعة مرة واحدة
          if (!onMessageUpsert._normMap) {
            const c = {};
            for (const k of Object.keys(keywords)) c[normalizeArabic(k)] = keywords[k];
            onMessageUpsert._normMap = c;
          }
          const reply = onMessageUpsert._normMap[textNorm];
          if (reply) {
            await sock.sendMessage(chatId, { text: reply }, { quoted: m });
            handled = true;
          }
        }

        // 6) لا رد افتراضي
      } catch (err) {
        logger.error({ err, stack: err?.stack }, 'message handler error');
      }
    }
  };
}

module.exports = { onMessageUpsert };
