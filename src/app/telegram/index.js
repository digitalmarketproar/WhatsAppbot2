'use strict';

/**
 * Telegram Admin Bot — Webhook mode
 * - يربط البوت على Express الموجود (إن توفر) وإلا ينشئ سيرفر صغير
 * - يضبط الويبهوك على PUBLIC_URL + TELEGRAM_WEBHOOK_PATH
 * - يصدّر كائن فيه:
 *   - bot: كائن البوت نفسه
 *   - adminId: آي دي المشرف
 *   - sendPhoto(buffer | stream | path, options)
 *   - sendQR(qrString)
 *   - start() لإعادة التهيئة عند الحاجة
 */

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const bodyParser = require('body-parser');
const logger = require('../../lib/logger');

const TOKEN       = process.env.TELEGRAM_BOT_TOKEN || '';
const ADMIN_ID    = process.env.TELEGRAM_ADMIN_ID   || ''; // لازم يكون عددي/سترنق صالح
const PUBLIC_URL  = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '';
const HOOK_PATH   = process.env.TELEGRAM_WEBHOOK_PATH || '/telegram/webhook';
const PORT        = Number(process.env.PORT || process.env.RENDER_PORT || 10000);

let bot = null;
let _app = null;

// تحميل مجمّع الوحدات (أوامر المشرف)
let handlers = {};
try {
  handlers = require('./modules'); // تأكد وجود src/app/telegram/modules/index.js
} catch (e) {
  logger.warn('Telegram modules aggregator missing; only /start & /help will work.');
  handlers = {};
}

function attachWebhookRoute(app) {
  app.use(bodyParser.json());
  app.post(HOOK_PATH, (req, res) => {
    try { bot.processUpdate(req.body); } catch {}
    res.sendStatus(200);
  });
  logger.info({ path: HOOK_PATH }, '🪝 Telegram webhook attached to main Express app');
}

async function setWebhook(baseUrl) {
  const url = `${String(baseUrl).replace(/\/+$/,'')}${HOOK_PATH}`;
  await bot.deleteWebHook({ drop_pending_updates: true }).catch(() => {});
  await bot.setWebHook(url, { allowed_updates: ['message', 'callback_query'] });
  logger.info({ url }, '✅ Telegram webhook set');
}

function wireBasicRouter() {
  // فلتر بسيط: فقط رسائل النص
  bot.on('message', async (msg) => {
    try {
      const chatId = msg.chat?.id;
      const text   = (msg.text || '').trim();
      if (!chatId || !text) return;

      // /start
      if (/^\/start\b/i.test(text)) {
        await bot.sendMessage(chatId, 'بوت الإدارة (Webhook) شغال ✅\nاكتب /help لعرض الأوامر.');
        return;
      }

      // /help
      if (/^\/help\b/i.test(text)) {
        if (handlers.handleHelp) return handlers.handleHelp({ bot, msg });
        return bot.sendMessage(chatId, 'لا يوجد ملف help. أضف modules/help.js');
      }

      // باقي أوامر المشرف حسب ملفاتك الموجودة:
      if (/^\/ignore\b/i.test(text)) {
        if (handlers.handleIgnore) return handlers.handleIgnore({ bot, msg });
        return bot.sendMessage(chatId, 'لا يوجد ملف ignore. أضف modules/ignore.js');
      }

      if (/^\/allow\b/i.test(text)) {
        // عادة allow هو عكس ignore — لو عندك modules/allow.js استبدله
        if (handlers.handleAllow) return handlers.handleAllow({ bot, msg });
        // أو استعمل نفس ignore لكن بوضع إزالة
        return bot.sendMessage(chatId, 'لا يوجد ملف allow. أضف modules/allow.js');
      }

      if (/^\/ignores\b/i.test(text)) {
        if (handlers.handleIgnores) return handlers.handleIgnores({ bot, msg });
        return bot.sendMessage(chatId, 'لا يوجد ملف ignores. أضف modules/ignores.js');
      }

      // إدارة القروبات: enable/disable/status/rules/media/links/welcome/farewell/banword/wl...
      if (/^\/g_enable\b/i.test(text) && handlers.handleGroupEnable)  return handlers.handleGroupEnable({ bot, msg });
      if (/^\/g_disable\b/i.test(text) && handlers.handleGroupDisable) return handlers.handleGroupDisable({ bot, msg });
      if (/^\/g_status\b/i.test(text) && handlers.handleStatus)       return handlers.handleStatus({ bot, msg });

      if (/^\/g_rules_set\b/i.test(text) && handlers.handleRulesSet)  return handlers.handleRulesSet({ bot, msg });
      if (/^\/g_rules_get\b/i.test(text) && handlers.handleRulesGet)  return handlers.handleRulesGet({ bot, msg });

      if (/^\/g_media\b/i.test(text) && handlers.handleMediaToggle)   return handlers.handleMediaToggle({ bot, msg });
      if (/^\/g_links\b/i.test(text) && handlers.handleLinksToggle)   return handlers.handleLinksToggle({ bot, msg });
      if (/^\/g_welcome\b/i.test(text) && handlers.handleWelcomeToggle) return handlers.handleWelcomeToggle({ bot, msg });
      if (/^\/g_farewell\b/i.test(text) && handlers.handleFarewellToggle) return handlers.handleFarewellToggle({ bot, msg });

      if (/^\/g_banword_add\b/i.test(text) && handlers.handleBanwordAdd)     return handlers.handleBanwordAdd({ bot, msg });
      if (/^\/g_banword_remove\b/i.test(text) && handlers.handleBanwordRemove) return handlers.handleBanwordRemove({ bot, msg });
      if (/^\/g_banword_list\b/i.test(text) && handlers.handleBanwordList)   return handlers.handleBanwordList({ bot, msg });

      if (/^\/g_wl_add\b/i.test(text) && handlers.handleWhitelistAdd)  return handlers.handleWhitelistAdd({ bot, msg });
      if (/^\/g_wl_del\b/i.test(text) && handlers.handleWhitelistDel)  return handlers.handleWhitelistDel({ bot, msg });
      if (/^\/g_wl_list\b/i.test(text) && handlers.handleWhitelistList) return handlers.handleWhitelistList({ bot, msg });

      // لو أمر غير معروف لا نرد
    } catch (err) {
      logger.error({ err, stack: err?.stack }, 'telegram message handler error');
    }
  });
}

function makeHelpers() {
  const adminId = ADMIN_ID ? Number(ADMIN_ID) : null;

  async function sendPhoto(photo, options = {}) {
    if (!bot || !adminId) {
      logger.warn('sendPhoto skipped — bot or adminId missing');
      return;
    }
    // photo يمكن أن يكون Buffer أو stream أو مسار ملف
    return bot.sendPhoto(adminId, photo, options).catch(err => {
      logger.warn({ err: err?.message }, 'sendPhoto failed');
      throw err;
    });
  }

  async function sendQR(qrString) {
    if (!bot || !adminId) {
      logger.warn('sendQR skipped — bot or adminId missing');
      return;
    }
    const msg =
      '📲 *امسح هذا الكود خلال دقيقة لضبط واتساب:*\n' +
      '```\n' + qrString + '\n```';
    return bot.sendMessage(adminId, msg, { parse_mode: 'Markdown', disable_web_page_preview: true })
      .catch(err => {
        logger.warn({ err: err?.message }, 'sendQR failed');
        throw err;
      });
  }

  return { adminId, sendPhoto, sendQR };
}

async function startTelegramBot({ app = null } = {}) {
  if (!TOKEN) {
    logger.warn('TELEGRAM_BOT_TOKEN is missing. Telegram admin bot will NOT start.');
    return { bot: null, adminId: null, sendPhoto: async()=>{}, sendQR: async()=>{} };
  }
  if (!ADMIN_ID) {
    logger.warn('TELEGRAM_ADMIN_ID is missing — QR and alerts will have nowhere to go.');
  }

  bot = new TelegramBot(TOKEN, { webHook: { port: 0 } }); // no polling
  const helpers = makeHelpers();

  if (app) {
    attachWebhookRoute(app);
    if (PUBLIC_URL) await setWebhook(PUBLIC_URL);
    logger.info({
      hasToken: !!TOKEN, hasAdmin: !!ADMIN_ID,
      publicUrl: PUBLIC_URL || null, hook: HOOK_PATH
    }, 'telegram config summary');
    logger.info('🤖 Telegram bot is up (webhook attached).');
  } else {
    // fallback mini server
    _app = express();
    _app.use(bodyParser.json());
    _app.post(HOOK_PATH, (req, res) => {
      try { bot.processUpdate(req.body); } catch {}
      res.sendStatus(200);
    });
    _app.listen(PORT, '0.0.0.0', async () => {
      logger.info(`🌐 Telegram mini server listening on 0.0.0.0:${PORT}`);
      if (PUBLIC_URL) await setWebhook(PUBLIC_URL);
    });
    logger.info('🤖 Telegram bot is up (standalone webhook).');
  }

  wireBasicRouter();

  // أعِد كائنًا يستخدمه واتساب لإرسال الـQR
  return { bot, ...helpers };
}

module.exports = { startTelegramBot };
