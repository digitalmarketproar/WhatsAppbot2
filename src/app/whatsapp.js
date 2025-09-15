// src/app/whatsapp.js
const { default: makeWASocket, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const NodeCache = require('node-cache');
const logger = require('../lib/logger');
const { mongoAuthState } = require('../lib/wa-mongo-auth');
const { registerSelfHeal } = require('../lib/selfheal');

// مخزن بسيط للرسائل لدعم getMessage أثناء إعادة المحاولة
const messageStore = new Map(); // key: message.key.id -> value: proto message

async function createWhatsApp({ telegram } = {}) {
  const { state, saveCreds } = await mongoAuthState(logger);
  const { version } = await fetchLatestBaileysVersion();

  // استخدم Cache حقيقي بدل كائن عادي
  const msgRetryCounterCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 });

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: !telegram,
    logger,
    emitOwnEvents: false,
    // لا نحتاج مزامنة تاريخ قديم
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    markOnlineOnConnect: false,

    // مهم جداً: لإرجاع الرسالة الأصلية عند إعادة المحاولة
    getMessage: async (key) => {
      if (!key?.id) return undefined;
      return messageStore.get(key.id);
    },

    // مهم جداً: تتبّع محاولات إعادة فك التشفير
    msgRetryCounterCache
  });

  // احفظ الاعتمادات دائماً
  sock.ev.on('creds.update', saveCreds);

  // خزّن الرسائل الواردة كي تعمل getMessage في أي إعادة محاولة
  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const m of messages || []) {
      if (m?.key?.id) {
        // يمكنك لاحقًا تطبيق LRU/حد أقصى، لكن هذا يكفي الآن
        messageStore.set(m.key.id, m);
      }
    }
  });

  // لو حصلت تحديثات تشير لإعادة محاولة/فشل تشفير — اعمل resync خفيفة
  sock.ev.on('messages.update', async (updates) => {
    for (const u of updates || []) {
      try {
        const needsResync =
          u.update?.retry ||
          u.update?.status === 409 ||
          u.update?.status === 410;
        if (needsResync) {
          try {
            await sock.resyncAppState?.(['critical_unblock_low']);
          } catch (e) {
            logger.warn({ e }, 'resyncAppState failed');
          }
        }
      } catch (e) {
        logger.warn({ e, u }, 'messages.update handler error');
      }
    }
  });

  // التعافي الذاتي بحذر (لا يمس مفاتيح مزامنة الحالة)
  registerSelfHeal(sock, { messageStore });

  return sock;
}

module.exports = { createWhatsApp };
