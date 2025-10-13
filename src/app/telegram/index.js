'use strict';

/**
 * Telegram Admin Bot — Webhook mode (no polling)
 * - Attaches to existing Express app if provided
 * - Or creates a tiny express server if none passed
 * - Sets webhook to PUBLIC_URL + route
 * - Exports startTelegram() for compatibility with root index.js
 */

const TelegramBot = require('node-telegram-bot-api');
const express     = require('express');
const bodyParser  = require('body-parser');
const logger      = require('../../lib/logger');

// ===== ENV VARS =====
const TOKEN       = process.env.TELEGRAM_BOT_TOKEN || '';       // من BotFather
const ADMIN_ID    = process.env.TELEGRAM_ADMIN_ID || '';        // chat id للمشرف (اختياري لكن مفيد لإرسال الـ QR)
const PUBLIC_URL  = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '';

// مسار الويبهوك (ثابت — يمكن تغييره من ENV)
const WEBHOOK_PATH = process.env.TELEGRAM_WEBHOOK_PATH || '/telegram/webhook';
// البورت لو احتجنا سيرفر مصغّر
const PORT = Number(process.env.PORT || process.env.RENDER_PORT || 10000);

if (!TOKEN) {
  logger.warn('TELEGRAM_BOT_TOKEN is missing. Telegram admin bot will NOT start.');
  // نُعيد واجهة "فارغة" لكي لا يتعطل واتساب عند محاولة إرسال QR
  module.exports = {
    startTelegram: () => ({
      // no-op helpers so WA code can call them safely
      sendPhoto: async () => {},
      sendQR:    async () => {},
      bot:       null,
      app:       null,
      WEBHOOK_PATH
    }),
    WEBHOOK_PATH
  };
  return;
}

// تشغيل البوت في وضع الـ webhook (بدون polling)
const bot = new TelegramBot(TOKEN, { webHook: { port: 0 } });

let _app   = null;
let _route = WEBHOOK_PATH;

// نحاول تحميل مجمّع الوحدات (Router لأوامر المشرف)
let handlers = {};
try {
  handlers = require('./modules'); // تأكّد من وجود src/app/telegram/modules/index.js
} catch (e) {
  logger.warn('Telegram modules aggregator missing; only /start & /help will work.');
  handlers = {};
}

// ربط الأوامر الأساسية
function wireRouter() {
  bot.on('message', async (msg) => {
    try {
      const chatId = msg.chat?.id;
      const text   = (msg.text || '').trim();
      if (!chatId || !text) return;

      if (/^\/start\b/i.test(text)) {
        await bot.sendMessage(chatId, 'بوت الإدارة (Webhook) شغّال ✅\nاكتب /help لعرض الأوامر.');
        return;
      }

      if (/^\/help\b/i.test(text)) {
        if (handlers.handleHelp) return handlers.handleHelp({ bot, msg });
        return bot.sendMessage(chatId, 'لا يوجد ملف help. أضف modules/help.js');
      }

      if (/^\/group\b/i.test(text)) {
        if (handlers.handleGroupCommand) return handlers.handleGroupCommand({ bot, msg });
        return bot.sendMessage(chatId, 'لا يوجد ملف group. أضف modules/group.js');
      }

      if (/^\/ignore\b/i.test(text)) {
        if (handlers.handleIgnore) return handlers.handleIgnore({ bot, msg });
        return bot.sendMessage(chatId, 'لا يوجد ملف ignore. أضف modules/ignore.js');
      }

      if (/^\/whitelist\b/i.test(text)) {
        if (handlers.handleWhitelist) return handlers.handleWhitelist({ bot, msg });
        return bot.sendMessage(chatId, 'لا يوجد ملف whitelist. أضف modules/whitelist.js');
      }

      if (/^\/status\b/i.test(text)) {
        if (handlers.handleStatus) return handlers.handleStatus({ bot, msg });
        return bot.sendMessage(chatId, 'لا يوجد ملف status. أضف modules/status.js');
      }

      if (/^\/rules\b/i.test(text)) {
        if (handlers.handleRules) return handlers.handleRules({ bot, msg });
        return bot.sendMessage(chatId, 'لا يوجد ملف rules. أضف modules/rules.js');
      }

      if (/^\/toggles\b/i.test(text)) {
        if (handlers.handleToggles) return handlers.handleToggles({ bot, msg });
        return bot.sendMessage(chatId, 'لا يوجد ملف toggles. أضف modules/toggles.js');
      }

      if (/^\/banwords\b/i.test(text)) {
        if (handlers.handleBanwords) return handlers.handleBanwords({ bot, msg });
        return bot.sendMessage(chatId, 'لا يوجد ملف banwords. أضف modules/banwords.js');
      }
    } catch (err) {
      logger.error({ err, stack: err?.stack }, 'telegram message handler error');
    }
  });
}

// تعيين الويبهوك (على PUBLIC_URL + WEBHOOK_PATH)
async function setWebhook(baseUrl) {
  const url = `${String(baseUrl).replace(/\/+$/,'')}${_route}`;
  await bot.deleteWebHook({ drop_pending_updates: true }).catch(() => {});
  await bot.setWebHook(url, { allowed_updates: ['message', 'callback_query'] });
  logger.info({ url }, '✅ Telegram webhook set');
}

// ربط المسار على Express موجود مسبقًا
function attachToApp(app) {
  _app = app;
  _route = WEBHOOK_PATH;
  _app.use(bodyParser.json());
  _app.post(_route, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
  logger.info({ path: _route }, '🪝 Telegram webhook attached to main Express app');
}

// مُرسل مريح للـ QR والصور إلى ADMIN_ID (إن وُضع)
function makeAdminHelpers() {
  const adminId = String(ADMIN_ID || '').trim();
  const hasAdmin = !!adminId;

  return {
    hasAdmin,
    // send raw QR text (fallback)
    sendQR: async (qrText) => {
      if (!hasAdmin) return;
      try {
        await bot.sendMessage(adminId, `🔐 WhatsApp QR:\n\`${qrText}\``, { parse_mode: 'Markdown' });
      } catch (e) {
        logger.warn({ e: e?.message }, 'Failed to send QR text to admin.');
      }
    },
    // send photo buffer (PNG) to admin
    sendPhoto: async (buffer, opts = {}) => {
      if (!hasAdmin) return;
      try {
        await bot.sendPhoto(adminId, buffer, opts);
      } catch (e) {
        logger.warn({ e: e?.message }, 'Failed to send photo to admin.');
      }
    }
  };
}

/**
 * يبدأ بوت التليجرام:
 * - إن تم تمرير app: يربط الويبهوك عليه
 * - وإلا ينشئ سيرفر مصغّر ويستمع على PORT
 * يعيد كائن فيه sendPhoto/sendQR لكي يستخدمه واتساب.
 */
async function startTelegram({ app = null } = {}) {
  wireRouter();

  const helpers = makeAdminHelpers();

  if (app) {
    attachToApp(app);
    if (PUBLIC_URL) { await setWebhook(PUBLIC_URL); }
    else { logger.warn('PUBLIC_URL is missing; set it so the Telegram webhook works on Render.'); }
    logger.info('🤖 Telegram bot is up (webhook attached).');
    return { bot, app, WEBHOOK_PATH, ...helpers };
  }

  // لا يوجد app خارجي — ننشئ واحد صغير
  _app = express();
  _app.use(bodyParser.json());
  _app.post(WEBHOOK_PATH, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });

  const server = _app.listen(PORT, '0.0.0.0', async () => {
    logger.info(`🌐 Telegram mini server listening on 0.0.0.0:${PORT}`);
    if (PUBLIC_URL) await setWebhook(PUBLIC_URL);
    else logger.warn('Webhook NOT set (PUBLIC_URL missing) — set it to enable Telegram.');
  });

  // إغلاق نظيف
  const shutdown = () => {
    try { server.close(); } catch {}
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  logger.info('🤖 Telegram bot is up (webhook standalone).');
  return { bot, app: _app, WEBHOOK_PATH, ...helpers };
}

module.exports = { startTelegram, WEBHOOK_PATH };
