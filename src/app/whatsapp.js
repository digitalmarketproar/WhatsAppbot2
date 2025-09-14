// src/app/whatsapp.js
const { default: makeWASocket, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const logger = require('../lib/logger');
const { mongoAuthState } = require('../lib/wa-mongo-auth');
const { registerSelfHeal } = require('../lib/selfheal');

async function createWhatsApp({ telegram } = {}) {
  const { state, saveCreds } = await mongoAuthState(logger);
  const { version } = await fetchLatestBaileysVersion();

  const msgRetryCounterMap = {};

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: !telegram,
    logger,
    emitOwnEvents: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
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

  // تعافٍ تلقائي من أعطال التشفير
  registerSelfHeal(sock);

  return sock;
}

module.exports = { createWhatsApp };
