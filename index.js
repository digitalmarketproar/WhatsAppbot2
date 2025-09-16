// index.js
const { startExpress } = require('./src/app/express');
const { startWhatsApp } = require('./src/app/whatsapp');   // ⬅️ بدّل createWhatsApp بـ startWhatsApp
const { onMessageUpsert } = require('./src/handlers/messages');
const { registerGroupParticipantHandler } = require('./src/handlers/groups');
const { connectMongo } = require('./src/lib/db');
const { TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID, MONGODB_URI } = require('./src/config/settings');
const { startTelegram } = require('./src/app/telegram');
const logger = require('./src/lib/logger');

(async () => {
  startExpress();
  await connectMongo(MONGODB_URI).catch(e =>
    logger.warn('Mongo not connected: ' + e.message)
  );

  const telegram = startTelegram(TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID);

  // ⬅️ استعمل startWhatsApp بدل createWhatsApp
  const sock = await startWhatsApp({ telegram });

  // handlers
  sock.ev.on('messages.upsert', onMessageUpsert(sock));
  registerGroupParticipantHandler(sock);

  logger.info('✅ Bot started (groups: moderation only; DMs: replies).');
})();
