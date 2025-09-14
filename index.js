const { startExpress } = require('./src/app/express');
const { createWhatsApp } = require('./src/app/whatsapp');
const { onMessageUpsert } = require('./src/handlers/messages');
const { registerGroupParticipantHandler } = require('./src/handlers/groups');
const { connectMongo } = require('./src/lib/db');
const { TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID, MONGODB_URI } = require('./src/config/settings');
const { startTelegram } = require('./src/app/telegram'); // ← index.js داخل مجلد telegram الجديد
const logger = require('./src/lib/logger');

(async () => {
  startExpress();
  await connectMongo(MONGODB_URI).catch(e => logger.warn('Mongo not connected: ' + e.message));
  const telegram = startTelegram(TELEGRAM_TOKEN, TELEGRAM_ADMIN_ID);
  const sock = await createWhatsApp({ telegram });

  // رسائل (خاص فقط للردود – والقروبات فقط للإدارة)
  sock.ev.on('messages.upsert', onMessageUpsert(sock));

  // مشاركون (ترحيب/وداع)
  registerGroupParticipantHandler(sock);

  logger.info('✅ Bot started (DM replies only; groups = moderation only).');
})();
