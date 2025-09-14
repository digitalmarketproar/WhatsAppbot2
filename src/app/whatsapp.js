const { default: makeWASocket, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const logger = require('../lib/logger');
const { mongoAuthState } = require('../lib/wa-mongo-auth');

async function createWhatsApp({ telegram } = {}) {
  const { state, saveCreds } = await mongoAuthState(logger);
  const { version } = await fetchLatestBaileysVersion();

  // عدّادات إعادة المحاولة للرسائل (مهم لتفادي تكرار غير منضبط)
  const msgRetryCounterMap = {};

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: !telegram,
    logger,
    emitOwnEvents: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false, // لازم تكون دالة
    markOnlineOnConnect: false,
    getMessage: async () => undefined,
    msgRetryCounterMap
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (u) => {
    try {
      if (u.qr && telegram?.sendQR) telegram.sendQR(u.qr);
      logger.info({ connection: u.connection, lastDisconnect: !!u.lastDisconnect }, 'connection.update');
    } catch (e) {
      logger.warn({ e }, 'connection.update warn');
    }
  });

  // لوج أخطاء فك التعمية (تشخيص فقط)
  sock.ev.on('messages.update', (updates) => {
    for (const u of updates) {
      if (u.update && u.update.status && u.update.status === 8) {
        // 8 = message decryption failure in بعض إصدارات Baileys
        logger.warn({ key: u.key }, 'decrypt fail (status=8)');
      }
    }
  });

  return sock;
}

module.exports = { createWhatsApp };
