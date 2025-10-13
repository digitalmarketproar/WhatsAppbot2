// src/app/telegram/index.js
const TelegramBot = require('node-telegram-bot-api');
const logger = require('../../lib/logger');
const {
  handleGroupCommand,
  handleHelp,
  handleIgnore,
  handleWhitelist,
  handleStatus,
  handleRules,
  handleToggles,
  handleBanwords
} = require('./modules'); // ملف جامع بسيط للموديولات (انظر الملاحظة أدناه)

/**
 * نرجّع كائن فيه دوال يستعملها واتساب لإرسال QR (sendPhoto/sendQR)
 * وكذلك نبدأ بولينغ البوت ونربط أوامر الأدمن.
 *
 * ENV المطلوب:
 * - TELEGRAM_BOT_TOKEN (إجباري)
 * - TELEGRAM_ADMIN_ID  (اختياري - للتنبيه/إرسال QR لنفس الأدمن)
 * - TELEGRAM_QR_CHAT_ID (اختياري - لو حاب ترسل QR لقناة/جروب معيّن)
 */
function startTelegram() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.warn('TELEGRAM_BOT_TOKEN missing — Telegram admin bot will NOT start.');
    // واجهة صورية حتى لا تتعطل whatsapp.js
    return {
      sendPhoto: async () => {},
      sendQR: async () => {}
    };
  }

  const bot = new TelegramBot(token, { polling: true });
  logger.info('🤖 Telegram bot started (admin commands ready).');

  const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID;
  const QR_CHAT  = process.env.TELEGRAM_QR_CHAT_ID || ADMIN_ID;

  // أوامر بسيطة
  bot.onText(/^\/start$/i, (msg) => bot.sendMessage(msg.chat.id, 'مرحبا! بوت الإدارة شغّال ✅'));
  bot.onText(/^\/ping$/i,  (msg) => bot.sendMessage(msg.chat.id, 'pong ✅'));

  // ربط موديولات الأدمن (إن وجدت)
  bot.on('message', async (msg) => {
    try {
      if (!msg.text) return;
      const text = msg.text.trim();

      if (/^\/help\b/i.test(text))   return handleHelp(bot, msg);
      if (/^\/status\b/i.test(text)) return handleStatus(bot, msg);
      if (/^\/rules\b/i.test(text))  return handleRules(bot, msg);

      if (/^\/group\b/i.test(text))     return handleGroupCommand(bot, msg);
      if (/^\/ignore\b/i.test(text))    return handleIgnore(bot, msg);
      if (/^\/whitelist\b/i.test(text)) return handleWhitelist(bot, msg);
      if (/^\/toggles\b/i.test(text))   return handleToggles(bot, msg);
      if (/^\/banwords\b/i.test(text))  return handleBanwords(bot, msg);
    } catch (err) {
      logger.error({ err, stack: err?.stack }, 'telegram message error');
    }
  });

  // واجهة يستخدمها whatsapp.js لإرسال الـ QR
  const api = {
    async sendPhoto(bufOrPath, opts = {}) {
      if (!QR_CHAT) return;
      try {
        await bot.sendPhoto(QR_CHAT, bufOrPath, { caption: opts.caption || '' });
      } catch (e) {
        logger.warn({ e: e?.message }, 'failed to sendPhoto to Telegram');
      }
    },
    async sendQR(qrText) {
      if (!QR_CHAT) return;
      try {
        await bot.sendMessage(QR_CHAT, 'WhatsApp QR (text fallback):\n' + '```' + qrText + '```', { parse_mode: 'Markdown' });
      } catch (e) {
        logger.warn({ e: e?.message }, 'failed to sendQR text to Telegram');
      }
    }
  };

  return api;
}

module.exports = { startTelegram };
