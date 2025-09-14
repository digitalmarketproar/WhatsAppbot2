const { startExpress } = require('./src/app/express');
const { createWhatsApp } = require('./src/app/whatsapp');
const { onMessageUpsert } = require('./src/handlers/messages');
const { connectMongo } = require('./src/lib/db');
const { TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID, MONGODB_URI } = require('./src/config/settings');
const { startTelegram } = require('./src/app/telegram');
const logger = require('./src/lib/logger');

(async () => {
  startExpress();
  await connectMongo(MONGODB_URI).catch(e=> logger.warn('Mongo not connected: '+e.message));
  const telegram = startTelegram(TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID);
  const sock = await createWhatsApp({ telegram });
  sock.ev.on('messages.upsert', onMessageUpsert(sock));
  logger.info('✅ Bot started (Arabic only, no group admin features).');
})();