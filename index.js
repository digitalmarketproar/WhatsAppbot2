'use strict';

/**
 * نقطة تشغيل الخدمة:
 * - يشغّل خادم HTTP الصحي (Express)
 * - يشغّل بوت تيليجرام (Webhook) إن وُجد التوكن
 * - يشغّل واتساب ويمرّر له كائن telegram لإرسال QR
 */

const logger = require('./src/lib/logger');
const { startExpress } = require('./src/app/express');
const { startTelegram } = require('./src/app/telegram');
const { startWhatsApp } = require('./src/app/whatsapp');

(async () => {
  try {
    // 1) شغّل إكسبرس على PORT الخاص بـ Render
    const app = startExpress();

    // 2) شغّل تيليجرام (ويبهوك) - قد يرجع null لو مافي توكن
    const telegram = await startTelegram({ app });
    if (!telegram) {
      logger.warn('Telegram bot did NOT start (no TELEGRAM_BOT_TOKEN or PUBLIC_URL).');
    } else {
      logger.info('🤖 Telegram bot is up (webhook attached).');
    }

    // 3) شغّل واتساب ومرر له كائن تيليجرام (قد يكون null)
    await startWhatsApp({ telegram });

    logger.info('🚀 Service bootstrapped: WhatsApp started; Telegram ' + (telegram ? 'up' : 'not running'));
  } catch (e) {
    logger.error({ err: e, stack: e?.stack }, 'Fatal error in bootstrap');
    process.exit(1);
  }
})();
