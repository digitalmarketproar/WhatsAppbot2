'use strict';

/**
 * نقطة التشغيل:
 * - يشغّل Express (healthz, root)
 * - يشغّل بوت تيليجرام (Webhook أو Polling حسب داخل الموديول)
 * - يشغّل واتساب
 */

const logger = require('./src/lib/logger');
const { startExpress }  = require('./src/app/express');
const { startWhatsApp } = require('./src/app/whatsapp');

// نحاول دعم الاسمين معًا: startTelegramBot و/أو startTelegram
let tgModule = {};
try { tgModule = require('./src/app/telegram'); } catch {}
const startTelegramBot =
  tgModule?.startTelegramBot || tgModule?.startTelegram || (async () => null);

// مسك الأخطاء العامة
process.on('unhandledRejection', (err) => logger.error({ err, stack: err?.stack }, 'unhandledRejection'));
process.on('uncaughtException', (err) => logger.error({ err, stack: err?.stack }, 'uncaughtException'));

(async () => {
  try {
    // 1) شغّل الويب سيرفر (Express) على PORT/0.0.0.0
    const app = startExpress();

    // 2) شغّل تيليجرام (إن وُجد الموديول/التوكن)
    let telegram = null;
    try {
      telegram = await startTelegramBot({ app }); // لو Webhook، سجّل المسار هنا؛ لو Polling تجاهل app
      if (!telegram && !process.env.TELEGRAM_BOT_TOKEN) {
        logger.warn('TELEGRAM_BOT_TOKEN مفقود — بوت تيليجرام لن يبدأ (لا مشكلة، سنُكمل واتساب).');
      }
    } catch (tgErr) {
      logger.error({ err: tgErr, stack: tgErr?.stack }, 'فشل بدء بوت تيليجرام — سنتابع تشغيل واتساب فقط');
    }

    // 3) شغّل واتساب
    await startWhatsApp({ telegram });
  } catch (e) {
    logger.error({ err: e, stack: e?.stack }, 'Fatal error in bootstrap');
    process.exit(1);
  }
})();
