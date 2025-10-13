'use strict';

/**
 * Bootstrap:
 * - يبدأ خادم Express الرئيسي (صحة + صفحة رئيسية)
 * - يربط بوت تيليجرام بوضع Webhook على نفس الـ Express (إن وُجد التوكن)
 * - يشغّل واتساب ويمرّر كائن تيليجرام لإرسال QR تلقائيًا
 */

const logger = require('./src/lib/logger');
const { startExpress } = require('./src/app/express');
const { startTelegramBot } = require('./src/app/telegram');    // ← مهم: نفس الاسم
const { startWhatsApp } = require('./src/app/whatsapp');

// لوج للأخطاء غير الممسوكة
process.on('unhandledRejection', (err) => {
  try { logger.error({ err, stack: err?.stack }, 'unhandledRejection'); } catch {}
});
process.on('uncaughtException', (err) => {
  try { logger.error({ err, stack: err?.stack }, 'uncaughtException'); } catch {}
});

(async () => {
  try {
    // 1) شغّل Express
    const app = startExpress();

    // 2) شغّل تيليجرام (Webhook) إن وُجد التوكن
    const hasTelegram = !!process.env.TELEGRAM_BOT_TOKEN;
    const telegram = await startTelegramBot({ app }); // ← دائمًا دالة، حتى بدون توكن تُرجع null
    if (hasTelegram) {
      logger.info('🤖 Telegram bot is up (webhook attached).');
    } else {
      logger.warn('TELEGRAM_BOT_TOKEN missing — Telegram admin bot will NOT start.');
    }

    // 3) شغّل واتساب ومرّر كائن تيليجرام
    await startWhatsApp({ telegram });

    logger.info('🚀 Both Telegram and WhatsApp initializers executed.');
  } catch (err) {
    logger.error({ err, stack: err?.stack }, 'Fatal error during bootstrap');
    process.exit(1);
  }
})();
