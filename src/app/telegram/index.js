const TelegramBot = require('node-telegram-bot-api');
const QRCode = require('qrcode');
const logger = require('../../lib/logger');

const registerIgnoreCommands   = require('./modules/ignore');
const registerGroupCommands    = require('./modules/group');
const registerRulesCommands    = require('./modules/rules');
const registerToggleCommands   = require('./modules/toggles');
const registerBanwordCommands  = require('./modules/banwords');
const registerStatusCommands   = require('./modules/status');
const registerHelpCommand      = require('./modules/help');

function startTelegram(token, adminId) {
  if (!token || !adminId) return null;

  const bot = new TelegramBot(token, { polling: false });

  // تنظيف أي WebHook قديم ثم ابدأ polling
  bot.deleteWebHook({ drop_pending_updates: true }).catch(() => {});
  bot.startPolling({ restart: true, interval: 300, timeout: 30 }).catch(() => {});

  async function notify(text) {
    try {
      await bot.sendMessage(adminId, text, { parse_mode: 'Markdown', disable_web_page_preview: true });
    } catch (e) {
      logger.warn({ e }, 'Telegram notify failed');
    }
  }

  async function sendQR(qrString) {
    try {
      const buf = await QRCode.toBuffer(qrString, { type: 'png', margin: 1, scale: 6 });
      await bot.sendPhoto(adminId, buf, { caption: '📱 QR لتسجيل الدخول إلى واتساب' });
    } catch (e) {
      logger.warn({ e }, 'Telegram sendQR failed');
      await notify('QR: ' + qrString);
    }
  }

  const ctx = { bot, adminId };

  // تسجيل الأوامر (مرتبة)
  registerHelpCommand(ctx);
  registerIgnoreCommands(ctx);
  registerGroupCommands(ctx);
  registerRulesCommands(ctx);
  registerToggleCommands(ctx);
  registerBanwordCommands(ctx);
  registerStatusCommands(ctx);

  bot.on('polling_error', (err) => {
    if (String(err?.message || '').includes('409')) return; // WebHook conflict
    logger.warn({ err }, 'Telegram polling error');
  });

  logger.info('🤖 Telegram bot started (admin commands ready).');
  notify('🤖 Telegram bot started (admin commands ready).').catch(() => {});
  return { bot, notify, sendQR };
}

module.exports = { startTelegram };
