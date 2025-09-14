const { loadCommands } = require('../../lib/commandLoader');
const IgnoreChat = require('../../models/IgnoreChat');
const keywords = require('../../config/keywords.json');
const logger = require('../../lib/logger');

const { isCommand, parseCommand } = require('./parse');

let cache = null;
function ensureCommands() {
  if (!cache) cache = loadCommands(require('path').join(__dirname, '../../commands'));
  return cache;
}

function onMessageUpsert(sock) {
  return async ({ messages }) => {
    const { commands, aliases } = ensureCommands();

    for (const m of messages || []) {
      try {
        const chatId = m.key.remoteJid;
        if (!chatId) continue;

        // تخطَّ المحادثات الموجودة في قائمة التجاهل
        const ignored = await IgnoreChat.findOne({ chatId }).lean().catch(()=>null);
        if (ignored) continue;

        const text = (m.message?.conversation || m.message?.extendedTextMessage?.text || '').trim();
        if (!text) continue;

        // تحليل الأوامر العربية
        const cmd = isCommand(text) ? parseCommand(text) : { name: '', args: [] };
        let handled = false;

        if (cmd.name) {
          const realName = commands.has(cmd.name) ? cmd.name : (aliases.get(cmd.name) || '');
          if (realName && commands.has(realName)) {
            const run = commands.get(realName);
            await run({ sock, msg: m, args: cmd.args });
            handled = true;
          }
        }

        if (!handled) {
          // الكلمات المفتاحية العربية (تطابق كامل)
          if (keywords[text]) {
            await sock.sendMessage(chatId, { text: String(keywords[text]) }, { quoted: m });
            handled = true;
          }
        }

        if (!handled) {
          // لا رد افتراضي في المجموعات أو الخاص — تقليل الضجيج
          // أرسل "مساعدة" يدويًا لعرض الأوامر
        }
      } catch (err) {
        logger.error({ err, stack: err?.stack }, 'messages.upsert handler error');
      }
    }
  };
}

module.exports = { onMessageUpsert };