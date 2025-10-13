'use strict';

/**
 * Telegram Admin Bot — Webhook mode (no polling)
 * Loader يسجل كل ملفات modules/*.js تلقائيًا (كل ملف يصدّر دالة (ctx) => void)
 */

const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const logger = require('../../lib/logger');

const TOKEN  = process.env.TELEGRAM_BOT_TOKEN || '';
const ADMIN  = process.env.TELEGRAM_ADMIN_ID || ''; // اختياري — إن تُرك فارغًا، سيسمح adminOnly للجميع
const PUBLIC = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '';
const HOOK   = process.env.TELEGRAM_WEBHOOK_PATH || '/telegram/webhook';

let bot = null;

/** حمّل كل ملفات modules/*.js وسجلها */
function registerAllModules(ctx) {
  const dir = path.join(__dirname, 'modules');
  if (!fs.existsSync(dir)) {
    logger.warn('telegram/modules folder not found — no admin commands will be registered.');
    return;
  }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
  if (!files.length) logger.warn('No modules found in telegram/modules');
  for (const f of files) {
    const full = path.join(dir, f);
    try {
      // تخلّص من الكاش في كل تشغيل
      delete require.cache[require.resolve(full)];
      const mod = require(full);
      if (typeof mod === 'function') {
        mod(ctx); // ← هذا أسلوبك (مثل help.js)
        logger.info({ file: f }, 'registered telegram module');
      } else {
        logger.warn({ file: f }, 'telegram module does not export a function — skipped');
      }
    } catch (e) {
      logger.error({ file: f, err: e?.message, stack: e?.stack }, 'failed to register telegram module');
    }
  }
}

async function setWebhook(url) {
  try { await bot.deleteWebHook({ drop_pending_updates: true }); } catch {}
  await bot.setWebHook(url, { allowed_updates: ['message', 'callback_query'] });
  logger.info({ url }, '✅ Telegram webhook set');
}

function attachWebhookToApp(app) {
  app.use(bodyParser.json());
  app.post(HOOK, (req, res) => {
    try {
      bot.processUpdate(req.body);
      res.sendStatus(200);
    } catch (e) {
      logger.error({ err: e?.message }, 'bot.processUpdate failed');
      res.sendStatus(500);
    }
  });
  logger.info({ path: HOOK }, '🪝 Telegram webhook attached to main Express app');
}

/**
 * استدعِ هذه من index.js الرئيسي:
 *    const { startTelegramBot } = require('./src/app/telegram');
 *    const app = startExpress(); // أو عندك Express رئيسي
 *    const bot = await startTelegramBot({ app });
 */
async function startTelegramBot({ app = null } = {}) {
  if (!TOKEN) {
    logger.warn('TELEGRAM_BOT_TOKEN is missing. Telegram admin bot will NOT start.');
    return null;
  }

  // لا Polling — نستخدم Webhook
  bot = new TelegramBot(TOKEN, { webHook: { port: 0 } });

  const ctx = {
    bot,
    adminId: ADMIN,
    app
  };

  if (app) attachWebhookToApp(app);
  registerAllModules(ctx);

  if (PUBLIC) {
    const url = `${PUBLIC.replace(/\/+$/, '')}${HOOK}`;
    await setWebhook(url);
    logger.info('🤖 Telegram bot is up (webhook attached).');
  } else {
    logger.warn('PUBLIC_URL is missing — webhook NOT set. Telegram bot will not receive updates.');
  }

  // Log عام لتشخيص
  logger.info({
    hasToken: !!TOKEN,
    hasAdmin: !!ADMIN,
    publicUrl: PUBLIC || null,
    hook: HOOK
  }, 'telegram config summary');

  return bot;
}

module.exports = { startTelegramBot };
