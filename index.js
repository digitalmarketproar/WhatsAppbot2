'use strict';

/**
 * Bootstrap:
 * - يبدأ خادم Express الرئيسي (صحة + صفحة رئيسية)
 * - يربط بوت تيليجرام بوضع Webhook على نفس الـ Express (إن وُجد التوكن)
 * - يشغّل واتساب ويمرّر كائن تيليجرام لارسال QR تلقائيًا
 */

const logger = require('./src/lib/logger');
const { startExpress } = require('./src/app/express');
const { startTelegramBot } = require('./src/app/telegram');    // يصدر startTelegramBot({ app })
const { startWhatsApp } = require('./src/app/whatsapp');       // يصدر startWhatsApp({ telegram })

// سجّل الأخطاء غير الممسوكة
process.on('unhandledRejection', (err) => {
  try { logger.error({ err, stack: err?.stack }, 'unhandledRejection'); } catch {}
});
process.on('uncaughtException', (err) => {
  try { logger.error({ err, stack: err?.stack }, 'uncaughtException'); } catch {}
});

(async () => {
  try {
    // 1) شغّل Express (يستمع على process.env.PORT و 0.0.0.0)
    const app = startExpress();

    // 2) شغّل تيليجرام (Webhook) لو التوكن متوفر
    let telegram = null;
    if (process.env.TELEGRAM_BOT_TOKEN) {
      // يربط مسار الويبهوك على نفس app ويضبط الويبهوك إلى PUBLIC_URL
      telegram = await startTelegramBot({ app });
      logger.info('🤖 Telegram bot is up (webhook attached).');
    } else {
      logger.warn('TELEGRAM_BOT_TOKEN missing — Telegram admin bot will NOT start.');
    }

    // 3) شغّل واتساب ومرّر كائن تيليجرام (قد يكون null)
    await startWhatsApp({ telegram });

    logger.info('🚀 Both Telegram and WhatsApp initializers executed.');
  } catch (err) {
    logger.error({ err, stack: err?.stack }, 'Fatal error during bootstrap');
    process.exit(1);
  }
})();
