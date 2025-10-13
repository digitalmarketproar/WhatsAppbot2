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
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const PUBLIC_URL = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '';
const WEBHOOK_PATH = process.env.TELEGRAM_WEBHOOK_PATH || '/telegram/webhook';
const PORT = process.env.PORT || process.env.RENDER_PORT || 10000;

// نحاول تحميل مجمّع الوحدات
let handlers = {};
try {
  handlers = require('./modules'); // تأكّد من وجود src/app/telegram/modules/index.js
} catch (e) {
  logger.warn('Telegram modules aggregator missing; only /start & /help will work.');
  handlers = {};
}

function wireRouter(bot) {
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

async function setWebhook(bot, baseUrl) {
  const url = `${baseUrl.replace(/\/+$/,'')}${WEBHOOK_PATH}`;
  await bot.deleteWebHook({ drop_pending_updates: true }).catch(() => {});
  await bot.setWebHook(url, { allowed_updates: ['message', 'callback_query'] });
  logger.info({ url }, '✅ Telegram webhook set');
}

async function startTelegram({ app = null } = {}) {
  if (!TOKEN) {
    logger.warn('TELEGRAM_BOT_TOKEN is missing. Telegram admin bot will NOT start.');
    return null; // مهم: لا نرمي خطأ — نعيد null ليتعامل index.js مع الحالة
  }

  const bot = new TelegramBot(TOKEN, { webHook: { port: 0 } }); // no polling
  wireRouter(bot);

  if (app) {
    app.use(bodyParser.json());
    app.post(WEBHOOK_PATH, (req, res) => {
      bot.processUpdate(req.body);
      res.sendStatus(200);
    });
    logger.info({ path: WEBHOOK_PATH }, '🪝 Telegram webhook attached to main Express app');
    if (PUBLIC_URL) await setWebhook(bot, PUBLIC_URL);
    else logger.warn('PUBLIC_URL missing — webhook not set for Telegram.');
    return bot;
  }

  // لو ما في app، نسوي سيرفر صغير
  const _app = express();
  _app.use(bodyParser.json());
  _app.post(WEBHOOK_PATH, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
  const server = _app.listen(PORT, '0.0.0.0', async () => {
    logger.info(`🌐 Telegram mini server listening on 0.0.0.0:${PORT}`);
    if (PUBLIC_URL) await setWebhook(bot, PUBLIC_URL);
    else logger.warn('PUBLIC_URL missing — webhook not set for Telegram.');
  });

  const shutdown = () => { try { server.close(); } catch {} };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return bot;
}

module.exports = { startTelegram, WEBHOOK_PATH };
