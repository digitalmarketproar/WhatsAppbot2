const path = require('path');
const { loadCommands } = require('../../lib/commandLoader');
const IgnoreChat = require('../../models/IgnoreChat');
const keywords = require('../../config/keywords.json');
const logger = require('../../lib/logger');

// حمّل الأوامر مرة واحدة
let registry = null;
function ensureRegistry() {
  if (!registry) registry = loadCommands(path.join(__dirname, '../../commands'));
  return registry;
}

// محاولـة العثور على الأمر بالاسم أو أحد المرادفات (بدون بادئة)
function resolveCommandName(token, reg) {
  if (!token) return '';
  // تطابق مباشر
  if (reg.commands.has(token)) return token;
  const mapped = reg.aliases.get(token);
  if (mapped && reg.commands.has(mapped)) return mapped;

  // تطابق غير حساس لحالة الأحرف (للإنجليزي)
  const tl = token.toLowerCase();

  // الأسماء
  for (const name of reg.commands.keys()) {
    if (name.toLowerCase && name.toLowerCase() === tl) return name;
  }
  // المرادفات
  for (const [alias, name] of reg.aliases.entries()) {
    if (alias.toLowerCase && alias.toLowerCase() === tl && reg.commands.has(name)) {
      return name;
    }
  }
  return '';
}

function onMessageUpsert(sock) {
  return async ({ messages }) => {
    const reg = ensureRegistry();

    for (const m of (messages || [])) {
      try {
        const chatId = m.key?.remoteJid;
        if (!chatId) continue;

        // تخطّي المحادثات الموجودة في قائمة التجاهل
        const ignored = await IgnoreChat.findOne({ chatId }).lean().catch(() => null);
        if (ignored) continue;

        const text =
          (m.message?.conversation ||
           m.message?.extendedTextMessage?.text ||
           '').trim();
        if (!text) continue;

        // صيغة الأوامر: أول كلمة = اسم/مرادف الأمر، والباقي = وسائط
        const parts = text.split(/\s+/);
        const token = parts[0];
        const args = parts.slice(1);

        let handled = false;

        // 1) جرّب تنفيذ الأمر (بدون بادئة)
        const realName = resolveCommandName(token, reg);
        if (realName) {
          const run = reg.commands.get(realName);
          await run({ sock, msg: m, args });
          handled = true;
        }

        // 2) أمر "مساعدة" ككلمة كاملة يشغّل أمر المساعدة دائمًا
        if (!handled && (text === 'مساعدة' || text.toLowerCase() === 'help')) {
          const help = require('../../commands/help.js');
          await help.run({ sock, msg: m, args: [] });
          handled = true;
        }

        // 3) القاموس العربي (تطابق كامل للرسالة كلها)
        if (!handled && keywords[text]) {
          await sock.sendMessage(chatId, { text: String(keywords[text]) }, { quoted: m });
          handled = true;
        }

        // 4) لا رد افتراضي لتقليل الضجيج

      } catch (err) {
        logger.error({ err, stack: err?.stack }, 'message handler error');
      }
    }
  };
}

module.exports = { onMessageUpsert };
