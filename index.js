'use strict';

/**
 * نقطة تشغيل الخدمة:
 * - تشغيل Express (سيرفر واحد)
 * - تشغيل بوت تيليجرام بالـ Webhook على نفس السيرفر
 * - تشغيل واتساب وتمرير واجهة تيليجرام (لإرسال QR للأدمن)
 */

const logger = require('./src/lib/logger');
const { startExpress } = require('./src/app/express');            // ✅ استخدم Express الموحد
const { startTelegramBot } = require('./src/app/telegram');        // ✅ الاسم الصحيح
const { startWhatsApp } = require('./src/app/whatsapp');           // ✅ كما هو

(async () => {
  try {
    // 1) سيرفر واحد
    const app = startExpress(); // يستمع على process.env.PORT و 0.0.0.0

    // 2) تيليجرام ويبهوك على نفس السيرفر
    const telegram = await startTelegramBot({ app }); // يرجّع كائن فيه sendPhoto/sendQR

    // 3) واتساب بواجهة تيليجرام لارسال QR
    await startWhatsApp({ telegram });
  } catch (e) {
    logger.error({ err: e, stack: e?.stack }, 'Fatal error in bootstrap');
    process.exit(1);
  }
})();
