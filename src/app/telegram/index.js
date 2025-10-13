'use strict';

/**
 * Telegram Admin Bot — Webhook mode (no polling)
 * - Attaches to existing Express app if provided
 * - Or creates a tiny express server if none passed
 * - Sets webhook to PUBLIC_URL + route
 * - Exposes helpers (sendPhoto / sendQR) that use TELEGRAM_ADMIN_CHAT_ID
 */

const TelegramBot = require('node-telegram-bot-api');
const express     = require('express');
const bodyParser  = require('body-parser');
const logger      = require('../../lib/logger');

// ==== ENV ====
// 1) توكِن البوت من BotFather
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
// 2) عنوان موقعك العام على Render (RENDER_EXTERNAL_URL يُوفَّر تلقائياً)
const PUBLIC_URL = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '';
// 3) مسار الويبهوك (يمكن تغييره عبر TELEGRAM_WEBHOOK_PATH)
const WEBHOOK_PATH = process.env.TELEGRAM_WEBHOOK_PATH
  || (TOKEN ? `/tg/${Buffer.from(TOKEN).toString('hex').slice(0, 32)}` : '/tg/hook');
// 4) شات الأدمن لإرسال QR والتنبيهات
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || ''; // مثال: 123456789

// بورت السيرفر إن احتجنا ننشئ واحد جديد (عند عدم تمرير app من الخارج)
const PORT = process.env.PORT || process.env.RENDER_PORT || 10000;

if (!TOKEN) {
  logger.warn('TELEGRAM_BOT_TOKEN is missing. Telegram admin bot will NOT start.');
  module.exports = {
    startTelegramBot: () => null,
    WEBHOOK_PATH,
  };
  return;
}

// نشغّل البوت في وضع الويبهوك (بدون polling)
const bot = new TelegramBot(TOKEN, { webHook: { port: 0 } }); // port:0 => لن يفتح منفذ بنفسه

let _app   = null;
let _route = null;

// محاولة تحميل مجمّع الوحدات (أوامر الإدارة)
let handlers = {};
try {
  handlers = require('./modules'); // تأكّد من وجود src/app/telegram/modules/index.js
} catch (e) {
  logger.warn('Telegram modules aggregator missing; only /start & /help will work.');
  handlers = {};
}

/**
 * Helpers لإرسال تنبيهات/صور للأدمن (يستهلكها واتساب لإرسال الـ QR)
 */
async function notifyAdmin(text) {
  if (!ADMIN_CHAT_ID) {
    logger.warn('TELEGRAM_ADMIN_CHAT_ID is missing — cannot notify admin.');
    return;
  }
  try {
    await bot.sendMessage(ADMIN_CHAT_ID, text, { disable_web_page_preview: true });
  } catch (err) {
    logger.error({ err, stack: err?.stack }, 'telegram notifyAdmin error');
  }
}

async function sendPhotoToAdmin(buf, opts) {
  if (!ADMIN_CHAT_ID) {
    logger.warn('TELEGRAM_ADMIN_CHAT_ID is missing — cannot send photo to admin.');
    return;
  }
  try {
    await bot.sendPhoto(ADMIN_CHAT_ID, buf, opts || {});
  } catch (err) {
    logger.error({ err, stack: err?.stack }, 'telegram sendPhotoToAdmin error');
  }
}

/**
 * ربط المستمع للأوامر/الرسائل
 */
function wireRouter() {
  bot.on('message', async (msg) => {
    try {
      const chatId = msg.chat.id;
      const text   = (msg.text || '').trim();

      if (!text) return;

      if (/^\/start\b/.test(text)) {
        await bot.sendMessage(chatId, 'بوت الإدارة (Webhook) شغّال ✅\nاكتب /help لعرض الأوامر.');
        return;
      }

      if (/^\/help\b/.test(text)) {
        if (handlers.handleHelp) return handlers.handleHelp({ bot, msg });
        return bot.sendMessage(chatId, 'لا يوجد ملف help. أضف modules/help.js');
      }

      if (/^\/group\b/.test(text)) {
        if (handlers.handleGroupCommand) return handlers.handleGroupCommand({ bot, msg });
        return bot.sendMessage(chatId, 'لا يوجد ملف group. أضف modules/group.js');
      }

      if (/^\/ignore\b/.test(text)) {
        if (handlers.handleIgnore) return handlers.handleIgnore({ bot, msg });
        return bot.sendMessage(chatId, 'لا يوجد ملف ignore. أضف modules/ignore.js');
      }

      if (/^\/whitelist\b/.test(text)) {
        if (handlers.handleWhitelist) return handlers.handleWhitelist({ bot, msg });
        return bot.sendMessage(chatId, 'لا يوجد ملف whitelist. أضف modules/whitelist.js');
      }

      if (/^\/status\b/.test(text)) {
        if (handlers.handleStatus) return handlers.handleStatus({ bot, msg });
        return bot.sendMessage(chatId, 'لا يوجد ملف status. أضف modules/status.js');
      }

      if (/^\/rules\b/.test(text)) {
        if (handlers.handleRules) return handlers.handleRules({ bot, msg });
        return bot.sendMessage(chatId, 'لا يوجد ملف rules. أضف modules/rules.js');
      }

      if (/^\/toggles\b/.test(text)) {
        if (handlers.handleToggles) return handlers.handleToggles({ bot, msg });
        return bot.sendMessage(chatId, 'لا يوجد ملف toggles. أضف modules/toggles.js');
      }

      if (/^\/banwords\b/.test(text)) {
        if (handlers.handleBanwords) return handlers.handleBanwords({ bot, msg });
        return bot.sendMessage(chatId, 'لا يوجد ملف banwords. أضف modules/banwords.js');
      }
    } catch (err) {
      logger.error({ err, stack: err?.stack }, 'telegram message handler error');
    }
  });
}

/**
 * تعيين/إعادة تعيين الويبهوك
 */
async function setWebhook(baseUrl) {
  const url = `${baseUrl.replace(/\/+$/, '')}${WEBHOOK_PATH}`;
  try { await bot.deleteWebHook({ drop_pending_updates: true }); } catch {}
  await bot.setWebHook(url, { allowed_updates: ['message', 'callback_query'] });
  logger.info({ url }, '✅ Telegram webhook set');
}

/**
 * ربط الويبهوك على تطبيق Express موجود
 */
function attachToApp(app) {
  _app   = app;
  _route = WEBHOOK_PATH;

  // مهم: body parser
  _app.use(bodyParser.json());
  _app.post(_route, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });

  logger.info({ path: _route }, '🪝 Telegram webhook route attached to existing app');
}

/**
 * الدالة العامة لبدء بوت تيليجرام
 * ترجع كائنًا يحتوي على:
 *  - bot (إن احتجته)
 *  - sendPhoto(buf, opts)  لإرسال صورة للأدمن
 *  - sendQR(text)         لإرسال QR كنص
 * تُستخدم هذه الدوال من جانب واتساب (whatsapp.js)
 */
async function startTelegramBot({ app = null } = {}) {
  if (!PUBLIC_URL) {
    logger.warn('PUBLIC_URL / RENDER_EXTERNAL_URL is missing; webhook may not be set.');
  }

  wireRouter();

  if (app) {
    attachToApp(app);
    if (PUBLIC_URL) await setWebhook(PUBLIC_URL);
    logger.info('🤖 Telegram bot started in Webhook mode (attached).');

    // واجهة للأدمن يستهلكها واتساب
    return {
      bot,
      sendPhoto: sendPhotoToAdmin,
      sendQR   : (text) => notifyAdmin(`*WhatsApp QR*\n${text}`),
    };
  }

  // لا يوجد app موجود — ننشئ واحد صغير
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

  const shutdown = () => { try { server.close(); } catch {} };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  logger.info('🤖 Telegram bot started in Webhook mode (standalone).');

  // واجهة للأدمن يستهلكها واتساب
  return {
    bot,
    sendPhoto: sendPhotoToAdmin,
    sendQR   : (text) => notifyAdmin(`*WhatsApp QR*\n${text}`),
  };
}

module.exports = { startTelegramBot, WEBHOOK_PATH };
