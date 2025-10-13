'use strict';

const { startExpress } = require('./src/app/express');
const { startTelegramBot } = require('./src/app/telegram');
const { startWhatsApp } = require('./src/app/whatsapp');
const logger = require('./src/lib/logger');

(async () => {
  try {
    // إنشاء السيرفر Express (صحي + Webhook لتليجرام)
    const app = startExpress();

    // بدء بوت التليجرام باستخدام Webhook على نفس السيرفر
    const telegram = await startTelegramBot({ app });

    // بدء بوت واتساب وتمرير تليجرام له (ليرسل QR مثلًا)
    await startWhatsApp({ telegram });

    logger.info('🚀 Both Telegram and WhatsApp bots are running successfully!');
  } catch (e) {
    logger.error({ err: e, stack: e?.stack }, '❌ Fatal bootstrap error');
    process.exit(1);
  }
})();
