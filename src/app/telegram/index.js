'use strict';

/**
 * Telegram Admin Bot — Webhook mode (no polling)
 * - Attaches to existing Express app if provided
 * - Or creates a tiny express server if none passed
 * - Sets webhook to PUBLIC_URL + route
 */

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const bodyParser = require('body-parser');
const logger = require('../../lib/logger');

// ==== ENV ====
// توكِن البوت من BotFather
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
// عنوان موقعك العام على Render (أضفه من الإعدادات، مثال: https://your-app.onrender.com)
const PUBLIC_URL = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '';
// مسار الويبهوك (ثابت وآمن نسبيًا). يمكنك تغييره من ENV: TELEGRAM_WEBHOOK_PATH
const WEBHOOK_PATH = process.env.TELEGRAM_WEBHOOK_PATH || `/tg/${Buffer.from(TOKEN).toString('hex').slice(0,32)}`;
// بورت السيرفر إن احتجنا ننشئ واحد جديد
const PORT = process.env.PORT || process.env.RENDER_PORT || 10000;

if (!TOKEN) {
  logger.warn('TELEGRAM_BOT_TOKEN is missing. Telegram admin bot will NOT start.');
  module.exports = {
    startTelegramBot: () => null,
  };
  return;
}

const bot = new TelegramBot(TOKEN, { webHook: { port: 0 } }); // لا polling
let _app = null;
let _route = null;

// نحاول تحميل مجمّع الوحدات (router للأوامر)
let handlers = {};
try {
  handlers = require('./modules'); // تأكّد من وجود src/app/telegram/modules/index.js
} catch (e) {
  logger.warn('Telegram modules aggregator missing; only /start & /help will work.');
  handlers = {};
}

function wireRouter() {
  // أوامر بسيطة — هنا فقط fallback لو حاب تستخدم onText
  bot.on('message', async (msg) => {
    try {
      const chatId = msg.chat.id;
      const text = (msg.text || '').trim();

      if (!text) return;

      if (/^\/start\b/.test(text)) {
        await bot.sendMessage(chatId, 'بوت الإدارة (Webhook) شغال ✅\nاكتب /help لعرض الأوامر.');
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

async function setWebhook(baseUrl) {
  const url = `${baseUrl.replace(/\/+$/,'')}${WEBHOOK_PATH}`;
  await bot.deleteWebHook({ drop_pending_updates: true }).catch(() => {});
  await bot.setWebHook(url, { allowed_updates: ['message', 'callback_query'] });
  logger.info({ url }, '✅ Telegram webhook set');
}

function attachToApp(app) {
  _app = app;
  _route = WEBHOOK_PATH;
  _app.use(bodyParser.json());
  _app.post(_route, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
  logger.info({ path: _route }, '🪝 Telegram webhook route attached to existing app');
}

async function startTelegramBot({ app = null } = {}) {
  if (!PUBLIC_URL) {
    logger.warn('PUBLIC_URL is missing; set it to your Render URL so webhook can be set.');
  }

  wireRouter();

  if (app) {
    attachToApp(app);
    if (PUBLIC_URL) await setWebhook(PUBLIC_URL);
    logger.info('🤖 Telegram bot started in Webhook mode (attached).');
    return bot;
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

  // اختياري: إغلاق نظيف
  const shutdown = () => {
    try { server.close(); } catch {}
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  logger.info('🤖 Telegram bot started in Webhook mode (standalone).');
  return bot;
}

module.exports = { startTelegramBot, WEBHOOK_PATH };
